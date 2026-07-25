'use client';
import * as React from 'react';
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
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
  selectActivePageId,
  selectGlobalCrossFilterMode,
  selectCrossFilterAllPages,
  useStudioLocaleText,
} from '../../context';
import { fieldHasCapability } from '../../utils/fieldCapabilities';
import { lookup } from '../../utils/safeLookup';
import { buildSourceFieldEntries } from '../../internals/fieldCatalog';
import { selectFiltersForWidget } from '../../internals/filterScoping';
import type { StudioDataSource, StudioWidgetConfig } from '../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';

function getKpiGranularities(localeText: ReturnType<typeof useStudioLocaleText>) {
  return [
    { value: 'day', label: localeText.timeGranDay },
    { value: 'week', label: localeText.timeGranWeek },
    { value: 'month', label: localeText.timeGranMonth },
    { value: 'quarter', label: localeText.timeGranQuarter },
    { value: 'year', label: localeText.timeGranYear },
  ] satisfies {
    value: NonNullable<StudioWidgetConfig['kpiSparklineGranularity']>;
    label: string;
  }[];
}

export function KpiSparklineOptions(props: { widgetId: string; config: StudioWidgetConfig }) {
  const { widgetId, config } = props;
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  const granularities = getKpiGranularities(localeText);
  // MUI's `Select` only emits `aria-labelledby` when handed an explicit `labelId`, and
  // `InputLabel` does not derive an `id`/`htmlFor` from `FormControl` context (its `label`
  // prop only sizes the outline notch), so an unpaired combobox has no accessible name
  // (`combobox` is not a name-from-content role). Unique per mount so two mounted
  // `<Studio>` instances never emit duplicate DOM ids.
  const granularityLabelId = React.useId();
  const plotTypeLabelId = React.useId();
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const filters = useStudioSelector(selectFilters);
  const widgets = useStudioSelector(selectWidgets);
  // Same doc-authored-key guard as `dataSources` below — a widget id is equally free-form.
  const widget = lookup(widgets, widgetId);

  // Auto-detected date filter field
  const sourceId = widget?.sourceId;
  // `widget.sourceId` is doc-authored, exactly like the `relatedId` guarded below — index the
  // record through the prototype-chain-safe `lookup` so a source id named after an
  // `Object.prototype` member ("constructor"/"toString"/…) resolves to "not found" rather than
  // an inherited function that passes the `!source` guard and then throws inside
  // `addSourceDateFields`'s `buildSourceFieldEntries(src, …)` → `source.fields.flatMap(...)`,
  // replacing this whole setup panel (source picker included) with the error fallback.
  const source = lookup(dataSources, sourceId);
  const relationships = useStudioSelector(selectRelationships);

  // Scoping inputs mirroring the KPI widget's own effective-date-filter resolution
  // (`useKpiSparkline` in `StudioKpiWidget.tsx`), so this setup-panel preview never
  // disagrees with what actually renders (finding 3). The compose drawer only ever
  // edits a widget that is selected on the currently active page, so `selectActivePageId`
  // is the same `pageId` `StudioKpiWidget` is mounted with.
  const activePageId = useStudioSelector(selectActivePageId);
  const globalCrossFilterMode = useStudioSelector(selectGlobalCrossFilterMode);
  const crossFilterAllPages = useStudioSelector(selectCrossFilterAllPages);
  const crossFilterModeRaw =
    globalCrossFilterMode ?? (widget?.config as StudioWidgetConfig | undefined)?.crossFilterMode;
  const crossFilterMode =
    crossFilterModeRaw === 'cross-highlight' ? 'cross-filter' : (crossFilterModeRaw ?? 'none');

  // Collect date fields from primary source + all directly related sources.
  // Built on the shared `buildSourceFieldEntries` catalog helper (architecture
  // review finding 2.8) instead of hand-rolling the id/label/type/sourceId/
  // sourceLabel shape per source, as `ChartSetupPanel`/`KpiSetupPanel` already do.
  const allDateFieldsWithJoined = React.useMemo<DataSourceFieldEntry[]>(() => {
    if (!source || !sourceId) {
      return [];
    }
    const result: DataSourceFieldEntry[] = [];
    const seen = new Set<string>();
    const addSourceDateFields = (src: StudioDataSource) => {
      for (const entry of buildSourceFieldEntries(src, expressionFields, { expression: 'none' })) {
        const key = `${entry.id}:${entry.sourceId}`;
        if (fieldHasCapability(entry, 'temporal') && !seen.has(key)) {
          seen.add(key);
          result.push(entry);
        }
      }
    };
    addSourceDateFields(source);
    for (const rel of relationships) {
      let relatedId: string | null = null;
      if (rel.sourceId === sourceId) {
        relatedId = rel.targetId;
      } else if (rel.targetId === sourceId) {
        relatedId = rel.sourceId;
      }
      if (!relatedId) {
        continue;
      }
      // `relatedId` comes from a doc-authored `StudioRelationship.sourceId`/`.targetId`
      // (persisted, also reachable via `loadSerializedState`/the AI tool loop), so guard the
      // record index against inherited keys ("toString"/"constructor"/…): a bare bracket lookup
      // would otherwise resolve a function off `Object.prototype` instead of "not found", which
      // passes the `!relSource` guard below and then throws inside `addSourceDateFields`'s
      // `buildSourceFieldEntries(src, ...)` → `source.fields.flatMap(...)` (prototype-chain-safe
      // lookup convention, matching `makeSelectWidgetSource` in `context/selectors.ts`).
      const relSource = lookup(dataSources, relatedId);
      if (!relSource) {
        continue;
      }
      addSourceDateFields(relSource);
    }
    return result;
  }, [source, sourceId, relationships, dataSources, expressionFields]);

  const autoDateFilter = React.useMemo(() => {
    if (!sourceId) {
      return null;
    }
    // Scope through the SAME authority the KPI widget itself uses to resolve its effective
    // date filter (`selectFiltersForWidget`, matching `useKpiSparkline`'s `scopedFilters`)
    // instead of a raw, unscoped `filters` scan. The previous page/dashboard-date-range/widget
    // scope-kind check had no `pageId`, `disabled`, or cross-filter-mode enforcement, so it
    // could match a date filter scoped to a DIFFERENT page or widget than the one actually in
    // effect for this KPI at render time — wrongly reporting an auto-detected date filter (and
    // hiding the manual Time-field picker) when the widget itself would show no such filter, or
    // vice versa (finding 3).
    const relevant = selectFiltersForWidget(filters, {
      widgetId,
      widgetSourceId: sourceId,
      activePageId,
      include: crossFilterMode === 'none' ? 'no-cross' : 'all',
      crossFilterAllPages,
    });
    return (
      relevant.find((f) => {
        return allDateFieldsWithJoined.some(
          (df) => df.id === f.field && (!f.filterSourceId || f.filterSourceId === df.sourceId),
        );
      }) ?? null
    );
  }, [
    filters,
    sourceId,
    widgetId,
    allDateFieldsWithJoined,
    activePageId,
    crossFilterMode,
    crossFilterAllPages,
  ]);

  const autoFieldLabel = autoDateFilter
    ? allDateFieldsWithJoined.find((f) => f.id === autoDateFilter.field)?.label
    : null;

  const plotType = config.kpiSparklinePlotType ?? 'line';
  const isGauge = plotType === 'gauge';

  const gaugeMax = config.kpiSparklineGaugeMax ?? 100;

  // Local text buffer for the gauge-max input (architecture review finding 1.14):
  // rejecting anything not `> 0` on every keystroke made the field impossible to
  // clear and retype. Buffer the displayed text locally and only parse/validate/
  // commit on blur, mirroring `FormatPanel.tsx`'s grid-height input.
  const [gaugeMaxText, setGaugeMaxText] = React.useState(String(gaugeMax));
  const [gaugeMaxDirty, setGaugeMaxDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed gaugeMax; resync on external change (widget switch, undo/redo)
  React.useEffect(() => {
    setGaugeMaxText(String(gaugeMax));
    setGaugeMaxDirty(false);
  }, [gaugeMax, widgetId]);

  const commitGaugeMax = () => {
    if (!gaugeMaxDirty) {
      return;
    }
    const parsed = Number(gaugeMaxText);
    const valid = Number.isFinite(parsed) && parsed > 0;
    if (valid && parsed !== gaugeMax) {
      controller.updateWidgetConfig(widgetId, { kpiSparklineGaugeMax: parsed });
    }
    setGaugeMaxText(String(valid ? parsed : gaugeMax));
    setGaugeMaxDirty(false);
  };

  return (
    <React.Fragment>
      {!isGauge &&
        (autoDateFilter ? (
          <Typography variant="caption" color="text.secondary">
            {localeText.kpiSetupAutoDateFilterPrefix} <strong>{autoFieldLabel}</strong>
          </Typography>
        ) : (
          <DataSourceFieldSelect
            value={config.kpiSparklineField ?? ''}
            // Finding 7: the picker's option list spans the primary source AND every
            // relationship neighbour in both directions, so a shared field id (e.g. two
            // sources with a `createdAt` date) is likely. `config.kpiSparklineSourceId` is
            // written right below and records which source the stored field belongs to —
            // pass it so the picker resolves strictly against that source instead of
            // displaying the first same-id match in `Object.values(dataSources)` order.
            valueSourceId={config.kpiSparklineSourceId ?? sourceId}
            onChange={(fieldId, fSourceId) => {
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineField: fieldId || undefined,
                kpiSparklineSourceId: fieldId && fSourceId !== sourceId ? fSourceId : undefined,
              });
            }}
            fields={allDateFieldsWithJoined}
            label={localeText.kpiSetupTimeFieldLabel}
          />
        ))}

      {!isGauge && (
        <FormControl size="small" fullWidth>
          <InputLabel id={granularityLabelId}>{localeText.kpiSetupGranularityLabel}</InputLabel>
          <Select
            labelId={granularityLabelId}
            label={localeText.kpiSetupGranularityLabel}
            value={config.kpiSparklineGranularity ?? ''}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineGranularity:
                  (event.target.value as StudioWidgetConfig['kpiSparklineGranularity']) ||
                  undefined,
              })
            }
          >
            <MenuItem value="">
              <em>{localeText.kpiGranularityAutoLabel}</em>
            </MenuItem>
            {granularities.map((g) => (
              <MenuItem key={g.value} value={g.value}>
                {g.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      <FormControl size="small" fullWidth>
        <InputLabel id={plotTypeLabelId}>{localeText.kpiSetupPlotTypeLabel}</InputLabel>
        <Select
          labelId={plotTypeLabelId}
          label={localeText.kpiSetupPlotTypeLabel}
          value={plotType}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              kpiSparklinePlotType: event.target.value as 'line' | 'bar' | 'gauge',
            })
          }
        >
          <MenuItem value="line">{localeText.kpiSetupChartLine}</MenuItem>
          <MenuItem value="bar">{localeText.kpiSetupChartBar}</MenuItem>
          <MenuItem value="gauge">{localeText.kpiSetupChartGauge}</MenuItem>
        </Select>
      </FormControl>

      {plotType === 'gauge' && (
        <TextField
          size="small"
          label={localeText.kpiSetupGaugeMaxLabel}
          type="number"
          value={gaugeMaxText}
          onChange={(event) => {
            setGaugeMaxText(event.target.value);
            setGaugeMaxDirty(true);
          }}
          onBlur={commitGaugeMax}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitGaugeMax();
            }
          }}
          fullWidth
        />
      )}

      {plotType === 'line' && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="body2">{localeText.kpiSetupFillAreaLabel}</Typography>
          <Switch
            size="small"
            checked={config.kpiSparklineArea ?? false}
            slotProps={{ input: { 'aria-label': localeText.kpiSetupFillAreaLabel } }}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineArea: event.target.checked,
              })
            }
          />
        </Box>
      )}

      {!isGauge && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="body2">{localeText.kpiSetupCumulativeLabel}</Typography>
          <Switch
            size="small"
            checked={config.kpiSparklineCumulative ?? false}
            slotProps={{ input: { 'aria-label': localeText.kpiSetupCumulativeLabel } }}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineCumulative: event.target.checked,
              })
            }
          />
        </Box>
      )}
    </React.Fragment>
  );
}
