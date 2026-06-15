'use client';
import * as React from 'react';
import {
  Autocomplete,
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectExpressionFields,
  selectFilters,
  selectRelationships,
  useStudioLocaleText,
} from '../../context';
import { fieldHasCapability } from '../../utils/fieldCapabilities';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { getReachableSourceIds } from '../../internals/chartUtils';
import type {
  StudioKpiAggregation,
  StudioCrossFilterMode,
  StudioDateRangePreset,
} from '../../models';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';
import { SetupSection } from './SetupSection';
import { CollapsibleFeatureSection } from './CollapsibleFeatureSection';
import { KpiSparklineOptions } from './KpiSparklineOptions';

function getKpiAggregations(localeText: ReturnType<typeof useStudioLocaleText>) {
  return {
    number: [
      { value: 'sum', label: localeText.aggFnSum },
      { value: 'avg', label: localeText.aggFnAverage },
      { value: 'count', label: localeText.aggFnCount },
      { value: 'min', label: localeText.aggFnMin },
      { value: 'max', label: localeText.aggFnMax },
    ],
    string: [{ value: 'count', label: localeText.aggFnCount }],
    boolean: [{ value: 'count', label: localeText.aggFnCount }],
    date: [
      { value: 'count', label: localeText.aggFnCount },
      { value: 'min', label: localeText.kpiSetupDateAggEarliest },
      { value: 'max', label: localeText.kpiSetupDateAggLatest },
    ],
    datetime: [
      { value: 'count', label: localeText.aggFnCount },
      { value: 'min', label: localeText.kpiSetupDateAggEarliest },
      { value: 'max', label: localeText.kpiSetupDateAggLatest },
    ],
  } satisfies Record<string, { value: StudioKpiAggregation; label: string }[]>;
}

export function KpiSetupPanel(props: { widgetId: string }) {
  const widget = useStudioSelector(selectWidgets)[props.widgetId];
  const controller = useStudioController();
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const relationships = useStudioSelector(selectRelationships);
  const config = widget?.config ?? {};
  const aggregations = getKpiAggregations(localeText);

  // Source picker options. The value-field select also anchors the source as a side
  // effect, but a count KPI has no value field — without this explicit picker such a
  // widget could never get its source from scratch (mirrors the grid panel's picker).
  const availableSources = React.useMemo(
    () => Object.values(dataSources).filter((s) => !s.hidden),
    [dataSources],
  );

  // Gather fields from all data sources (used for the value field anchor picker)
  const allFields = React.useMemo(() => {
    const physicalFields = Object.values(dataSources).flatMap((ds) => {
      if (ds.hidden) {
        return [];
      }
      return ds.fields.flatMap((f) =>
        f.hidden ? [] : [{ ...f, sourceId: ds.id, sourceLabel: ds.label }],
      );
    });
    const exprFields = expressionFields.flatMap((ef) => {
      if (ef.hidden) {
        return [];
      }
      const ds = dataSources[ef.sourceId];
      return [
        {
          id: ef.id,
          label: ef.label,
          description: ef.description,
          type: ef.type ?? ('number' as const),
          format: ef.format,
          precision: ef.precision,
          currencyCode: ef.currencyCode,
          generated: true,
          sourceId: ef.sourceId,
          sourceLabel: ds?.label ?? ef.sourceId,
        },
      ];
    });
    return [...physicalFields, ...exprFields].sort((a, b) =>
      a.sourceLabel.localeCompare(b.sourceLabel),
    );
  }, [dataSources, expressionFields]);

  // Once the value field anchors a source, restrict subsequent pickers to reachable sources.
  const reachableFields = React.useMemo(() => {
    if (!widget?.sourceId) {
      return allFields;
    }
    const reachableIds = getReachableSourceIds(widget.sourceId, relationships);
    return allFields.filter((f) => reachableIds.has(f.sourceId));
  }, [allFields, widget?.sourceId, relationships]);

  const selectedField =
    reachableFields.find((f) => f.id === config.kpiValueField) ??
    allFields.find((f) => f.id === config.kpiValueField);
  const selectedFieldType = selectedField?.type ?? null;

  // With no value field, "Count" (a row tally) is the only meaningful aggregation —
  // it needs no field to operate on. Restricting the options to Count here makes
  // "no field + count" an explicit, reproducible state rather than a misconfigured
  // one (and gives a fresh KPI a sensible default instead of an inoperative Sum).
  const hasValueField = !!config.kpiValueField;
  const countOnly = [{ value: 'count' as StudioKpiAggregation, label: localeText.aggFnCount }];
  const aggregationOptions = (() => {
    if (!hasValueField) {
      return countOnly;
    }
    if (selectedFieldType) {
      return aggregations[selectedFieldType] || countOnly;
    }
    return aggregations.number;
  })();
  const onlyOneAgg = aggregationOptions.length === 1;
  const selectedAgg = aggregationOptions.find((a) => a.value === config.kpiAggregation)
    ? config.kpiAggregation
    : aggregationOptions[0].value;

  const { widgetId } = props;

  const widgetSource = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
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
    return widgetSource.fields
      .filter((f) => !f.hidden && fieldHasCapability(f, 'temporal'))
      .map((f) => ({
        id: f.id,
        label: f.label,
        type: f.type,
        sourceId: widgetSource.id,
        sourceLabel: widgetSource.label,
      }));
  }, [widgetSource]);

  const widgetDateRangeFilter = React.useMemo(
    () =>
      allFilters.find(
        (f) => f.scope === 'widget' && f.widgetId === widgetId && f.isDashboardDateRange,
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
          controller.updateWidget(widgetId, { sourceId: nextSourceId });
          controller.updateWidgetConfig(widgetId, {
            kpiValueField: '',
            kpiAggregation: 'count',
          });
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={localeText.gridSetupDataSourceLabel}
            placeholder={localeText.gridSetupDataSourcePlaceholder}
            helperText={!widgetSource ? localeText.gridSetupChooseSourceHelper : undefined}
          />
        )}
      />

      <DataSourceFieldSelect
        value={config.kpiValueField ?? ''}
        onChange={(fieldId, fSourceId) => {
          const newField = allFields.find((f) => f.id === fieldId && f.sourceId === fSourceId);
          const newFieldType = newField?.type ?? null;
          // Clearing the field (fieldId === '') leaves only the fieldless "count"
          // aggregation valid, so force it — otherwise a previously chosen sum/avg
          // would leave the KPI inoperative (the renderer only tallies rows for count).
          const newAggOptions = (() => {
            if (!fieldId) {
              return countOnly;
            }
            if (newFieldType) {
              return aggregations[newFieldType] ?? countOnly;
            }
            return aggregations.number;
          })();
          const currentAggValid = newAggOptions.some((a) => a.value === config.kpiAggregation);
          const configUpdate: Partial<import('../../models').StudioWidgetConfig> = {
            kpiValueField: fieldId,
            // Reset aggregation when the current one isn't valid for the new field type
            ...(!currentAggValid && { kpiAggregation: newAggOptions[0].value }),
          };
          controller.updateWidgetConfig(widgetId, configUpdate);
          if (fSourceId && fSourceId !== widget?.sourceId) {
            controller.updateWidget(widgetId, { sourceId: fSourceId });
          }
        }}
        fields={allFields}
        label={localeText.kpiSetupValueFieldLabel}
        helperText={localeText.kpiSetupValueFieldHelperText}
        calculatedField={calculatedFieldContext}
      />

      <FormControl size="small" fullWidth disabled={onlyOneAgg}>
        <InputLabel>{localeText.chartSetupAggregationLabel}</InputLabel>
        <Select
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

      {features.kpiTarget !== false && (
        <CollapsibleFeatureSection
          label={localeText.kpiSetupTargetLabel}
          enabled={config.kpiTarget ?? false}
          onToggle={(next) => controller.updateWidgetConfig(widgetId, { kpiTarget: next })}
        >
          <Typography variant="caption" color="text.secondary">
            {localeText.kpiSetupTargetHelperText}
          </Typography>
          <TextField
            size="small"
            label={localeText.kpiSetupTargetLabel}
            type="number"
            value={config.kpiTargetValue ?? ''}
            onChange={(event) => {
              const n = Number(event.target.value);
              if (event.target.value !== '' && Number.isFinite(n)) {
                controller.updateWidgetConfig(widgetId, { kpiTargetValue: n });
              } else if (event.target.value === '') {
                controller.updateWidgetConfig(widgetId, { kpiTargetValue: undefined });
              }
            }}
            fullWidth
          />
        </CollapsibleFeatureSection>
      )}

      {features.kpiTrend !== false && (
        <CollapsibleFeatureSection
          label={localeText.kpiSetupTrendLabel}
          enabled={config.kpiTrend ?? false}
          onToggle={(next) => controller.updateWidgetConfig(widgetId, { kpiTrend: next })}
        >
          <FormControl size="small" fullWidth>
            <InputLabel>{localeText.kpiSetupCompPeriodLabel}</InputLabel>
            <Select
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
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="body2">{localeText.kpiSetupInvertColours}</Typography>
            <Switch
              size="small"
              checked={config.kpiTrendInvert ?? false}
              onChange={(event) =>
                controller.updateWidgetConfig(widgetId, { kpiTrendInvert: event.target.checked })
              }
            />
          </Box>
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
            <InputLabel>{localeText.kpiSetupDateRangeLabel}</InputLabel>
            <Select
              label={localeText.kpiSetupDateRangeLabel}
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
        Only "Filter" (re-aggregate over the selection) and "None" (grand total) make sense. */}
      <SetupSection
        title={localeText.kpiSetupInteractionsTitle}
        description={localeText.kpiSetupInteractionsDescription}
      >
        <ToggleButtonGroup
          value={
            ((config.crossFilterMode === 'cross-highlight'
              ? 'cross-filter'
              : config.crossFilterMode) ?? 'none') as StudioCrossFilterMode
          }
          exclusive
          onChange={(_e, value: StudioCrossFilterMode | null) => {
            controller.updateWidgetConfig(widgetId, {
              crossFilterMode: value ?? 'none',
            });
          }}
          size="small"
          fullWidth
        >
          <ToggleButton value="cross-filter" sx={{ fontSize: 11, textTransform: 'none' }}>
            {localeText.crossFilterModeFilter}
          </ToggleButton>
          <ToggleButton value="none" sx={{ fontSize: 11, textTransform: 'none' }}>
            {localeText.crossFilterModeNone}
          </ToggleButton>
        </ToggleButtonGroup>
      </SetupSection>
    </Stack>
  );
}
