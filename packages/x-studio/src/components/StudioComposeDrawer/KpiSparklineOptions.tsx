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
import { shouldApplyWidgetRankAtL3 } from '../../internals/StudioPipeline';
// THE date-field rule, owned by the KPI widget and exported for exactly this reason: the setup
// panel must answer "is a filter driving the time axis?" with the SAME implementation the rendered
// widget uses. Imported from `kpiUtils` (pure) rather than the widget's barrel, which would drag
// the whole chart-rendering import chain into the compose drawer.
import { resolveKpiDateField } from '../widgets/StudioKpiWidget/kpiUtils';
import type { StudioDataSource, StudioWidgetConfig } from '../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';
import { useBufferedInput } from './useBufferedInput';

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
  // disagrees with what actually renders. The compose drawer only ever
  // edits a widget that is selected on the currently active page, so `selectActivePageId`
  // is the same `pageId` `StudioKpiWidget` is mounted with.
  const activePageId = useStudioSelector(selectActivePageId);
  const globalCrossFilterMode = useStudioSelector(selectGlobalCrossFilterMode);
  const crossFilterAllPages = useStudioSelector(selectCrossFilterAllPages);
  const crossFilterModeRaw =
    globalCrossFilterMode ?? (widget?.config as StudioWidgetConfig | undefined)?.crossFilterMode;
  const crossFilterMode =
    crossFilterModeRaw === 'cross-highlight' ? 'cross-filter' : (crossFilterModeRaw ?? 'none');

  // Collect date fields from primary source + all directly related sources. Built on the shared
  // `buildSourceFieldEntries` catalog helper instead of hand-rolling the id/label/type/sourceId/
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

  // The SINGLE "which date field does this KPI use?" rule, shared verbatim with the
  // rendered widget (`resolveKpiDateField`, `kpiUtils.ts`). This panel used to answer the
  // question with its own third variant — it matched the first in-scope filter against own
  // AND joined date fields with no notion of the resolver's later tiers — so it could hide the
  // manual Time-field picker for a filter the widget then did not use, leaving the sparkline
  // blank with no control left to fix it. The picker is now hidden EXACTLY when the resolver
  // reports `origin === 'filter'`, i.e. when a filter really is driving the time axis.
  //
  // `scopedFilters` is the resolver's documented contract: pre-scoped through
  // `selectFiltersForWidget`, matching what the widget passes. A raw `filters` scan has no
  // `pageId`, `disabled` or cross-filter-mode enforcement, so it could match a date filter
  // scoped to a different page or widget than the one actually in effect.
  // `includeWidgetRank` mirrors the widget's own resolution of the same flag.
  const dateFieldResolution = React.useMemo(() => {
    const scopedFilters = selectFiltersForWidget(filters, {
      widgetId,
      widgetSourceId: sourceId,
      activePageId,
      include: crossFilterMode === 'none' ? 'no-cross' : 'all',
      crossFilterAllPages,
      includeWidgetRank: widget ? shouldApplyWidgetRankAtL3(widget) : false,
    });
    return resolveKpiDateField({
      config,
      widgetId,
      widgetSourceId: sourceId,
      dataSource: source,
      scopedFilters,
    });
  }, [
    filters,
    widget,
    config,
    sourceId,
    source,
    widgetId,
    activePageId,
    crossFilterMode,
    crossFilterAllPages,
  ]);

  const autoDateFilter = dateFieldResolution.origin === 'filter' ? dateFieldResolution : null;
  const autoFieldLabel = autoDateFilter
    ? (allDateFieldsWithJoined.find(
        (f) => f.id === autoDateFilter.field && f.sourceId === autoDateFilter.sourceId,
      )?.label ?? autoDateFilter.field)
    : null;

  const plotType = config.kpiSparklinePlotType ?? 'line';
  const isGauge = plotType === 'gauge';

  const gaugeMax = config.kpiSparklineGaugeMax ?? 100;

  // Local text buffer for the gauge-max input: rejecting anything not `> 0` on every keystroke made
  // the field impossible to clear and retype. Buffered through the shared dirty-aware
  // `useBufferedInput` and parsed/validated/committed on blur only.
  const gaugeMaxBuffer = useBufferedInput(String(gaugeMax), `${widgetId}:kpiSparklineGaugeMax`);

  const commitGaugeMax = () => {
    if (!gaugeMaxBuffer.dirty) {
      return;
    }
    const parsed = Number(gaugeMaxBuffer.value);
    const valid = Number.isFinite(parsed) && parsed > 0;
    if (valid && parsed !== gaugeMax) {
      controller.updateWidgetConfig(widgetId, { kpiSparklineGaugeMax: parsed });
    }
    gaugeMaxBuffer.settle(String(valid ? parsed : gaugeMax));
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
            // The picker's option list spans the primary source AND every
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
          value={gaugeMaxBuffer.value}
          onChange={(event) => {
            gaugeMaxBuffer.setValue(event.target.value);
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
