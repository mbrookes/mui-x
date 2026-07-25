'use client';
import * as React from 'react';
import {
  Autocomplete,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  makeSelectWidget,
  selectDataSources,
  selectExpressionFields,
  selectFilters,
  selectRelationships,
  useStudioLocaleText,
} from '../../context';
import { fieldHasCapability } from '../../utils/fieldCapabilities';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { getReachableSourceIds } from '../../internals/dataSourceGraph';
import { buildFieldCatalog } from '../../internals/fieldCatalog';
import type {
  StudioKpiAggregation,
  StudioDateRangePreset,
  StudioWidgetConfigForKind,
  StudioWidgetConfig,
} from '../../models';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';
import { CrossFilterModeSection } from './CrossFilterModeSection';
import { CollapsibleFeatureSection } from './CollapsibleFeatureSection';
import { KpiSparklineOptions } from './KpiSparklineOptions';
import { collectStaleWidgetFilterIds } from './collectStaleWidgetFilterIds';

function getKpiAggregations(localeText: ReturnType<typeof useStudioLocaleText>) {
  // `count_distinct` (like `count`) is meaningful for every field type — it operates on
  // the raw cell value regardless of type (`computeAggregate`'s `count_distinct` branch
  // routes through `countDistinct` unconditionally, never the numeric coercion used by
  // sum/avg/min/max) — so it's offered everywhere `count` is, mirroring `gridSummary.ts`'s
  // "count_distinct is meaningful for any field type" policy and `GridSetupPanel`'s own
  // NUMERIC_AGGREGATIONS/STRING_AGGREGATIONS, which both include it. Omitting it here was
  // the root cause of finding 1: a stored `kpiAggregation: 'count_distinct'` had nowhere
  // it counted as valid, so the render-time repair effect below silently rewrote it away.
  return {
    number: [
      { value: 'sum', label: localeText.aggFnSum },
      { value: 'avg', label: localeText.aggFnAverage },
      { value: 'count', label: localeText.aggFnCount },
      { value: 'count_distinct', label: localeText.widgetAggPrefixCountDistinct },
      { value: 'min', label: localeText.aggFnMin },
      { value: 'max', label: localeText.aggFnMax },
    ],
    string: [
      { value: 'count', label: localeText.aggFnCount },
      { value: 'count_distinct', label: localeText.widgetAggPrefixCountDistinct },
    ],
    boolean: [
      { value: 'count', label: localeText.aggFnCount },
      { value: 'count_distinct', label: localeText.widgetAggPrefixCountDistinct },
    ],
    date: [
      { value: 'count', label: localeText.aggFnCount },
      { value: 'count_distinct', label: localeText.widgetAggPrefixCountDistinct },
      { value: 'min', label: localeText.kpiSetupDateAggEarliest },
      { value: 'max', label: localeText.kpiSetupDateAggLatest },
    ],
    datetime: [
      { value: 'count', label: localeText.aggFnCount },
      { value: 'count_distinct', label: localeText.widgetAggPrefixCountDistinct },
      { value: 'min', label: localeText.kpiSetupDateAggEarliest },
      { value: 'max', label: localeText.kpiSetupDateAggLatest },
    ],
  } satisfies Record<string, { value: StudioKpiAggregation; label: string }[]>;
}

type KpiAggregationOption = { value: StudioKpiAggregation; label: string };

/**
 * Valid aggregation options for the current KPI value field. Shared by the render
 * path and the value-field `onChange` so the two can't drift (finding 2.6): with no
 * field, only the fieldless row "count" applies; otherwise the field type selects
 * the option set (falling back to `count` for unknown types, `number` when the type
 * isn't resolved yet).
 */
function deriveKpiAggregationOptions(
  aggregations: ReturnType<typeof getKpiAggregations>,
  hasField: boolean,
  fieldType: string | null,
  countOnly: KpiAggregationOption[],
): KpiAggregationOption[] {
  if (!hasField) {
    return countOnly;
  }
  // `fieldType` is doc-authored (derived from an expression field's `type`, with no runtime
  // enum validation on this path): guard the record index against inherited keys
  // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function off
  // `Object.prototype` instead of "not found" (prototype-chain key lookup fix).
  if (fieldType) {
    return Object.hasOwn(aggregations, fieldType)
      ? aggregations[fieldType as keyof typeof aggregations]
      : countOnly;
  }
  return aggregations.number;
}

export function KpiSetupPanel(props: { widgetId: string }) {
  const selectWidgetFn = React.useMemo(() => makeSelectWidget(props.widgetId), [props.widgetId]);
  const widget = useStudioSelector(selectWidgetFn);
  const controller = useStudioController();
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const relationships = useStudioSelector(selectRelationships);
  const config = (widget?.config ?? {}) as StudioWidgetConfigForKind<'kpi'>;
  const aggregations = getKpiAggregations(localeText);
  // MUI's `Select` only emits `aria-labelledby` when handed an explicit `labelId`, and
  // `InputLabel` does not derive an `id`/`htmlFor` from `FormControl` context (its `label`
  // prop only sizes the outline notch), so an unpaired combobox has no accessible name
  // (`combobox` is not a name-from-content role — it announced its own display text, e.g.
  // "Sum", with nothing saying which setting that value belongs to). Unique per mount so two
  // mounted `<Studio>` instances never emit duplicate DOM ids.
  const aggregationLabelId = React.useId();
  const fixedWindowLabelId = React.useId();
  const compPeriodLabelId = React.useId();
  const datePresetLabelId = React.useId();

  // Source picker options. The value-field select also anchors the source as a side
  // effect, but a count KPI has no value field — without this explicit picker such a
  // widget could never get its source from scratch (mirrors the grid panel's picker).
  const availableSources = React.useMemo(
    () => Object.values(dataSources).filter((s) => !s.hidden),
    [dataSources],
  );

  // Gather fields from all data sources (used for the value field anchor picker)
  const allFields = React.useMemo(
    () => buildFieldCatalog(dataSources, expressionFields),
    [dataSources, expressionFields],
  );

  // Once the value field anchors a source, restrict subsequent pickers to reachable sources.
  const reachableFields = React.useMemo(() => {
    if (!widget?.sourceId) {
      return allFields;
    }
    const reachableIds = getReachableSourceIds(widget.sourceId, relationships);
    return allFields.filter((f) => reachableIds.has(f.sourceId));
  }, [allFields, widget?.sourceId, relationships]);

  // Resolve the configured value field scoped to the widget's OWN source first (finding
  // 1.7). `buildFieldCatalog` sorts by source label, so a bare-id lookup across the
  // multi-source catalog can match a reachable related source that shares the field id and
  // sorts earlier — feeding the wrong field's `type` into the aggregation-options derivation,
  // whose render-time self-repair effect below would then non-undoably rewrite a valid
  // `kpiAggregation` in the doc. The KPI value field always belongs to the widget's own
  // source (a cross-source pick adopts that source), so scope to `widget.sourceId`; fall back
  // to the unscoped lookup only when the widget has no source yet.
  const selectedField = widget?.sourceId
    ? reachableFields.find((f) => f.id === config.kpiValueField && f.sourceId === widget.sourceId)
    : allFields.find((f) => f.id === config.kpiValueField);
  const selectedFieldType = selectedField?.type ?? null;

  // With no value field, "Count" (a row tally) is the only meaningful aggregation —
  // it needs no field to operate on. Restricting the options to Count here makes
  // "no field + count" an explicit, reproducible state rather than a misconfigured
  // one (and gives a fresh KPI a sensible default instead of an inoperative Sum).
  const hasValueField = !!config.kpiValueField;
  const countOnly = [{ value: 'count' as StudioKpiAggregation, label: localeText.aggFnCount }];
  const aggregationOptions = deriveKpiAggregationOptions(
    aggregations,
    hasValueField,
    selectedFieldType,
    countOnly,
  );
  const onlyOneAgg = aggregationOptions.length === 1;
  const storedAggIsValid = aggregationOptions.some((a) => a.value === config.kpiAggregation);
  const selectedAgg = storedAggIsValid ? config.kpiAggregation : aggregationOptions[0].value;

  const { widgetId } = props;

  // Finding 3.6: when the stored `kpiAggregation` is invalid for the current field
  // type, the Select above merely displays a valid fallback (`selectedAgg`) while the
  // doc keeps the invalid value — so the panel and the widget renderer (which reads
  // the doc) disagree until the user touches the field. Repair the doc on detect.
  // (The renderer, `StudioKpiWidget`, is outside this fix's scope; write-back is the
  // in-scope option and self-terminates once the value is valid.)
  //
  // Finding 2.4: this write-back fires from merely RENDERING the panel, not from a
  // user gesture, so it must not enter the undo timeline. Left undoable, opening the
  // panel could push an unauthored undo entry, and undoing past the repair would
  // re-trigger this effect and commit again — clearing the redo stack every time,
  // so undo could never get past that point while the panel stayed mounted.
  // `StudioDateRangeBar.tsx`'s coverage-expansion effect documents and uses the same
  // `{ undoable: false }` pattern for exactly this hazard.
  React.useEffect(() => {
    if (config.kpiAggregation !== undefined && !storedAggIsValid) {
      controller.updateWidgetConfig(widgetId, { kpiAggregation: selectedAgg }, { undoable: false });
    }
  }, [config.kpiAggregation, storedAggIsValid, selectedAgg, controller, widgetId]);

  // `widget.sourceId` is doc-authored: guard the record index against inherited prototype keys
  // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function off
  // `Object.prototype` instead of "not found" (prototype-chain key lookup fix).
  const widgetSource =
    widget?.sourceId && Object.hasOwn(dataSources, widget.sourceId)
      ? dataSources[widget.sourceId]
      : undefined;
  // BL-179/180: pass calculated-field context to the value picker only when the
  // feature is enabled for KPIs and a primary source is established. The reachable
  // source set scopes operands offered in the expression dialog (BL-180).
  const calculatedFieldContext = React.useMemo(() => {
    if (
      !widgetSource ||
      features.calculatedFields === false ||
      features.kpiCalculatedFields === false
    ) {
      return undefined;
    }
    return {
      dataSource: widgetSource,
      expressionFields,
      reachableSourceIds: getReachableSourceIds(widgetSource.id, relationships),
    };
  }, [
    widgetSource,
    features.calculatedFields,
    features.kpiCalculatedFields,
    expressionFields,
    relationships,
  ]);

  const sourcePickerValue = widgetSource
    ? { id: widgetSource.id, label: widgetSource.label }
    : null;

  // Date/datetime fields from the primary source for the date range picker.
  const allFilters = useStudioSelector(selectFilters);
  const dateFields = React.useMemo(() => {
    if (!widgetSource) {
      return [];
    }
    return widgetSource.fields.flatMap((f) =>
      !f.hidden && fieldHasCapability(f, 'temporal')
        ? [
            {
              id: f.id,
              label: f.label,
              type: f.type,
              sourceId: widgetSource.id,
              sourceLabel: widgetSource.label,
            },
          ]
        : [],
    );
  }, [widgetSource]);

  const widgetDateRangeFilter = React.useMemo(
    () =>
      allFilters.find(
        (f) =>
          f.scope.kind === 'widget' &&
          f.scope.widgetId === widgetId &&
          f.dateRangePreset !== undefined,
      ),
    [allFilters, widgetId],
  );
  const activeDatePreset: StudioDateRangePreset | 'all_time' =
    widgetDateRangeFilter?.dateRangePreset ?? 'all_time';
  const activeDateFieldId = widgetDateRangeFilter?.field ?? dateFields[0]?.id ?? '';
  const activeDateFieldSourceId = widgetDateRangeFilter?.filterSourceId ?? widgetSource?.id ?? '';
  const activeDateFieldType =
    widgetDateRangeFilter?.fieldType ??
    dateFields.find((f) => f.id === activeDateFieldId)?.type ??
    null;

  const dateRangePresets = React.useMemo(
    () => [
      { value: 'all_time' as const, label: localeText.dateRangePresetAllTime },
      { value: 'ytd' as const, label: localeText.dateRangePresetYTD },
      { value: 'this_month' as const, label: localeText.dateRangePresetThisMonth },
      { value: 'last_3_months' as const, label: localeText.dateRangePresetLast3Months },
      { value: 'last_12_months' as const, label: localeText.dateRangePresetLast12Months },
    ],
    [localeText],
  );

  return (
    <Stack spacing={2}>
      <Autocomplete
        size="small"
        options={availableSources.map((s) => ({ id: s.id, label: s.label }))}
        getOptionLabel={(opt) => opt.label}
        isOptionEqualToValue={(opt, val) => opt.id === val.id}
        value={sourcePickerValue}
        onChange={(_e, selected) => {
          const nextSourceId = selected?.id;
          if (nextSourceId === widget?.sourceId) {
            return;
          }
          // Switching source invalidates any value field anchored to the old source,
          // so clear it. With no field the only valid aggregation is a row "count" —
          // set it explicitly so the KPI renders a count immediately (the freshly
          // created widget seeds `kpiAggregation: 'sum'`, which would otherwise leave
          // it inoperative until a numeric field is chosen). Picking a value field
          // afterwards re-derives a field-appropriate aggregation in the select below.
          // Fold the source switch and the field/aggregation reset into ONE
          // `updateWidget` commit so the whole gesture is a single undo step (finding
          // 2.2) — a lone Ctrl+Z otherwise lands on a torn state (new source, stale
          // field) the UI never actually rendered.
          //
          // The managed date-range filter (and any other widget-scoped filter) still
          // references the OLD source's field; left in place it would silently exclude
          // every row of the new source (finding 1.5). Fold the removal of those now-
          // unresolvable filters into the SAME commit via `removeFilterIds`.
          // The sparkline field is just as source-specific as the value field (finding
          // 3, iteration 20) — left stale after a cross-source switch, `kpiSparklineField`/
          // `kpiSparklineSourceId` keep pointing at a field the new source can't resolve,
          // silently blanking the sparkline with no warning. Reset them the same way
          // `kpiValueField`/`kpiAggregation` already are.
          controller.updateWidget(
            widgetId,
            {
              sourceId: nextSourceId,
              config: {
                ...config,
                kpiValueField: '',
                kpiAggregation: 'count',
                kpiSparklineField: undefined,
                kpiSparklineSourceId: undefined,
              },
            },
            {
              removeFilterIds: collectStaleWidgetFilterIds(
                allFilters,
                widgetId,
                nextSourceId,
                allFields,
                relationships,
              ),
            },
          );
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={localeText.gridSetupDataSourceLabel}
            placeholder={localeText.gridSetupDataSourcePlaceholder}
            helperText={!widgetSource ? localeText.gridSetupChooseSourceHelper : undefined}
            slotProps={{
              ...params.slotProps,
              htmlInput: {
                ...params.slotProps.htmlInput,
                title: sourcePickerValue?.label,
              },
            }}
          />
        )}
      />

      <DataSourceFieldSelect
        value={config.kpiValueField ?? ''}
        // Finding 5: the KPI value field always belongs to the widget's OWN source (a
        // cross-source pick adopts that source — see the `selectedField` comment above),
        // so `widget?.sourceId` is the natural, always-available disambiguator. Passing it
        // means a same-id field from a different (merely reachable) source can never be
        // silently displayed in its place.
        valueSourceId={widget?.sourceId}
        onChange={(fieldId, fSourceId) => {
          const newField = allFields.find((f) => f.id === fieldId && f.sourceId === fSourceId);
          const newFieldType = newField?.type ?? null;
          // Clearing the field (fieldId === '') leaves only the fieldless "count"
          // aggregation valid, so force it — otherwise a previously chosen sum/avg
          // would leave the KPI inoperative (the renderer only tallies rows for count).
          const newAggOptions = deriveKpiAggregationOptions(
            aggregations,
            !!fieldId,
            newFieldType,
            countOnly,
          );
          const currentAggValid = newAggOptions.some((a) => a.value === config.kpiAggregation);
          const configUpdate: Partial<import('../../models').StudioWidgetConfig> = {
            kpiValueField: fieldId,
            // Reset aggregation when the current one isn't valid for the new field type
            ...(!currentAggValid && { kpiAggregation: newAggOptions[0].value }),
          };
          // When the picked field belongs to a different source, adopt that source AND
          // write the field/aggregation in ONE `updateWidget` commit so the source-switch
          // gesture collapses to a single undo step (finding 2.2); without a source switch
          // a plain config patch is already one commit. Also fold in the removal of any
          // widget-scoped filter that no longer resolves against the new source (finding
          // 1.5) so a stale date-range filter can't silently blank the KPI.
          if (fSourceId && fSourceId !== widget?.sourceId) {
            // Same cross-source reset as the source Autocomplete above (finding 3,
            // iteration 20): picking a value field from a different source also adopts
            // that source, so the old source's sparkline field/source is just as stale
            // here as it is there.
            controller.updateWidget(
              widgetId,
              {
                sourceId: fSourceId,
                config: {
                  ...config,
                  ...configUpdate,
                  kpiSparklineField: undefined,
                  kpiSparklineSourceId: undefined,
                },
              },
              {
                removeFilterIds: collectStaleWidgetFilterIds(
                  allFilters,
                  widgetId,
                  fSourceId,
                  allFields,
                  relationships,
                ),
              },
            );
          } else {
            controller.updateWidgetConfig(widgetId, configUpdate);
          }
        }}
        fields={allFields}
        label={localeText.kpiSetupValueFieldLabel}
        helperText={localeText.kpiSetupValueFieldHelperText}
        calculatedField={calculatedFieldContext}
      />

      <FormControl size="small" fullWidth disabled={onlyOneAgg}>
        <InputLabel id={aggregationLabelId}>{localeText.chartSetupAggregationLabel}</InputLabel>
        <Select
          labelId={aggregationLabelId}
          label={localeText.chartSetupAggregationLabel}
          value={selectedAgg}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              kpiAggregation: event.target.value as StudioKpiAggregation,
            })
          }
        >
          {aggregationOptions.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              {opt.label}
            </MenuItem>
          ))}
        </Select>
        {!hasValueField && (
          <FormHelperText>{localeText.aggregationLockedHelperText}</FormHelperText>
        )}
      </FormControl>

      {features.kpiSparkline !== false && (
        <CollapsibleFeatureSection
          label={localeText.kpiSetupSparklineLabel}
          enabled={config.kpiSparkline ?? false}
          onToggle={(next) => controller.updateWidgetConfig(widgetId, { kpiSparkline: next })}
        >
          <KpiSparklineOptions widgetId={widgetId} config={config} />
        </CollapsibleFeatureSection>
      )}

      {features.kpiTrend !== false && (
        <CollapsibleFeatureSection
          label={localeText.kpiSetupTrendLabel}
          enabled={config.kpiTrend ?? false}
          onToggle={(next) => controller.updateWidgetConfig(widgetId, { kpiTrend: next })}
        >
          <FormControl size="small" fullWidth>
            <InputLabel id={fixedWindowLabelId}>{localeText.kpiSetupFixedWindowLabel}</InputLabel>
            <Select
              labelId={fixedWindowLabelId}
              label={localeText.kpiSetupFixedWindowLabel}
              value={config.kpiTrendFixedPeriod ?? ''}
              onChange={(event) =>
                controller.updateWidgetConfig(widgetId, {
                  kpiTrendFixedPeriod: (event.target.value || undefined) as
                    | 'month'
                    | 'quarter'
                    | 'year'
                    | undefined,
                })
              }
            >
              <MenuItem value="">{localeText.kpiSetupFixedWindowNone}</MenuItem>
              <MenuItem value="month">{localeText.kpiSetupFixedWindowMonth}</MenuItem>
              <MenuItem value="quarter">{localeText.kpiSetupFixedWindowQuarter}</MenuItem>
              <MenuItem value="year">{localeText.kpiSetupFixedWindowYear}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id={compPeriodLabelId}>{localeText.kpiSetupCompPeriodLabel}</InputLabel>
            <Select
              labelId={compPeriodLabelId}
              label={localeText.kpiSetupCompPeriodLabel}
              value={config.kpiTrendComparison ?? 'previous-period'}
              onChange={(event) =>
                controller.updateWidgetConfig(widgetId, {
                  kpiTrendComparison: event.target.value as
                    | 'previous-period'
                    | 'previous-calendar-period'
                    | 'year-over-year',
                })
              }
            >
              <MenuItem value="previous-period">{localeText.kpiSetupCompPrevPeriod}</MenuItem>
              <MenuItem value="previous-calendar-period">
                {localeText.kpiSetupCompPrevCalendarPeriod}
              </MenuItem>
              <MenuItem value="year-over-year">{localeText.kpiSetupCompSameLastYear}</MenuItem>
            </Select>
          </FormControl>
          <FormControlLabel
            slotProps={{ typography: { variant: 'body2' } }}
            control={
              <Switch
                size="small"
                checked={config.kpiTrendInvert ?? false}
                onChange={(event) =>
                  controller.updateWidgetConfig(widgetId, {
                    kpiTrendInvert: event.target.checked,
                  })
                }
              />
            }
            label={localeText.kpiSetupInvertColours}
          />
        </CollapsibleFeatureSection>
      )}

      {dateFields.length > 0 && (
        <CollapsibleFeatureSection
          label={localeText.kpiSetupDateRangeLabel}
          enabled={activeDatePreset !== 'all_time'}
          onToggle={(next) => {
            if (!next) {
              controller.setWidgetDateRange(widgetId, null, null, null, null);
            } else {
              const field = dateFields[0];
              controller.setWidgetDateRange(
                widgetId,
                field.id,
                field.sourceId,
                field.type as import('../../models').StudioDataField['type'],
                'last_12_months',
              );
            }
          }}
        >
          <DataSourceFieldSelect
            value={activeDateFieldId}
            onChange={(fieldId, fSourceId) => {
              const field = dateFields.find((f) => f.id === fieldId && f.sourceId === fSourceId);
              controller.setWidgetDateRange(
                widgetId,
                fieldId || null,
                fSourceId || null,
                (field?.type as import('../../models').StudioDataField['type']) ?? null,
                activeDatePreset === 'all_time' ? null : activeDatePreset,
              );
            }}
            fields={dateFields}
            label={localeText.kpiSetupDateRangeFieldLabel}
          />
          <FormControl size="small" fullWidth>
            <InputLabel id={datePresetLabelId}>
              {localeText.kpiSetupDateRangePresetLabel}
            </InputLabel>
            <Select
              labelId={datePresetLabelId}
              label={localeText.kpiSetupDateRangePresetLabel}
              value={activeDatePreset}
              onChange={(event) => {
                const preset = event.target.value as StudioDateRangePreset | 'all_time';
                if (preset === 'all_time') {
                  controller.setWidgetDateRange(widgetId, null, null, null, null);
                } else {
                  controller.setWidgetDateRange(
                    widgetId,
                    activeDateFieldId,
                    activeDateFieldSourceId,
                    activeDateFieldType as import('../../models').StudioDataField['type'],
                    preset,
                  );
                }
              }}
            >
              {dateRangePresets.map((p) => (
                <MenuItem key={p.value} value={p.value}>
                  {p.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </CollapsibleFeatureSection>
      )}

      {/* Interactions — cross-filter mode. KPIs are summary metrics with no visual row
        representation, so "cross-highlight" (dim non-matching rows) does not apply.
        Only "Filter" (re-aggregate over the selection) and "None" (grand total) make sense.
        A legacy-persisted 'cross-highlight' value is displayed as 'Filter' selected —
        see CrossFilterModeSection's normalization doc. */}
      <CrossFilterModeSection
        widgetId={widgetId}
        title={localeText.kpiSetupInteractionsTitle}
        description={localeText.kpiSetupInteractionsDescription}
        modes={['cross-filter', 'none']}
        defaultMode="none"
        value={(config as StudioWidgetConfig).crossFilterMode}
      />
    </Stack>
  );
}
