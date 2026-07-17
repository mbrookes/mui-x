'use client';
import * as React from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  Alert,
  Checkbox,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { normalizeChartSeries } from '@mui/x-studio-schema';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectExpressionFields,
  selectRelationships,
  selectFilters,
  useStudioLocaleText,
} from '../../../context';
import { useStudioFeatures } from '../../../internals/StudioUIConfigContext';
import { fieldsForCapability } from '../../../utils/fieldCapabilities';
import { analyzeChartSupport } from '../../../internals/chartAggregation';
import { getReachableSourceIds } from '../../../internals/dataSourceGraph';
import { buildFieldCatalog } from '../../../internals/fieldCatalog';
import type {
  StudioChartType,
  StudioBarLayout,
  StudioChartConfig,
  StudioChartWidgetConfig,
} from '../../../models';
import { ChartTypePicker } from '../ChartTypePicker';
import { DataSourceFieldSelect } from '../DataSourceFieldSelect';
import { CrossFilterModeSection } from '../CrossFilterModeSection';
import { collectStaleWidgetFilterIds } from '../collectStaleWidgetFilterIds';
import { GaugeConfigSection } from './GaugeConfigSection';
import { ScatterConfigSection } from './ScatterConfigSection';
import { FunnelConfigSection } from './FunnelConfigSection';
import { HeatmapAxesSection } from './HeatmapAxesSection';
import { SankeyConfigSection } from './SankeyConfigSection';
import { GanttFieldsSection } from './GanttFieldsSection';
import { AnnotationsEditorSection } from './AnnotationsEditorSection';
import { PieArcLabelsSection } from './PieArcLabelsSection';
import { SortDirectionToggle } from './SortDirectionToggle';

const sortBySourceLabel = (a: { sourceLabel: string }, b: { sourceLabel: string }) =>
  a.sourceLabel.localeCompare(b.sourceLabel);

/**
 * Orchestrator for the chart widget's setup panel: chart-type selector, fields
 * shared across (most) chart types (X field/group-by/sort, Y measure series,
 * split-by, interactions), and dispatch to the per-chart-type section
 * components for the fields that are specific to one chart type
 * (`GaugeConfigSection`, `ScatterConfigSection`, `FunnelConfigSection`,
 * `HeatmapAxesSection`, `SankeyConfigSection`, `GanttFieldsSection`,
 * `AnnotationsEditorSection`) — mirroring how `StudioChartWidget` delegates
 * per-type rendering to its own sibling files.
 */
export function ChartSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();
  const allWidgets = useStudioSelector(selectWidgets);
  const widget = allWidgets[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);

  const relationships = useStudioSelector(selectRelationships);
  const allFilters = useStudioSelector(selectFilters);

  const allFields = React.useMemo(
    () => buildFieldCatalog(dataSources, expressionFields),
    [dataSources, expressionFields],
  );

  // The shared top controls span several chart families (xField / xGroupBy / sort /
  // ySeries / seriesField / dualYAxis / annotations / crossFilterMode), so they read
  // through the flat `StudioChartConfig` patch type. `chartConfig` is the SAME object
  // viewed as the closed `StudioChartWidgetConfig` union — a bare
  // `chartConfig.chartType === 'x'` check narrows it natively to the matching family,
  // which is how each per-type section below is handed its precise family config with
  // no guard and no per-call cast. (`{}` is a valid bar-family config since that
  // family's discriminant is optional, so the `?? {}` fallback type-checks too.)
  const rawConfig = widget?.config ?? {};
  const config = rawConfig as StudioChartConfig;
  const chartConfig = rawConfig as StudioChartWidgetConfig;
  const widgetSourceId = widget?.sourceId;

  // selectedXField is used to conditionally show the Group By control below, and its
  // `sourceId` anchors `reachableFields` for every other picker. Resolve it scoped to the
  // widget's OWN source first (finding 2.12): `buildFieldCatalog` sorts by source label, so a
  // bare-id lookup across the multi-source catalog can match a related source that shares the
  // field id and sorts earlier — re-anchoring the whole panel on the wrong source and hiding
  // the widget's own valid fields. Fall back to the unscoped lookup only when the widget has
  // no source yet (the X pick will then adopt one).
  const selectedXField =
    (widgetSourceId
      ? allFields.find((f) => f.id === config.xField && f.sourceId === widgetSourceId)
      : undefined) ??
    allFields.find((f) => f.id === config.xField) ??
    null;
  const supportSourceId = selectedXField?.sourceId;

  // Once the X field anchors a source, restrict all other pickers to reachable sources.
  const reachableFields = React.useMemo(() => {
    if (!supportSourceId) {
      return allFields;
    }
    const reachableIds = getReachableSourceIds(supportSourceId, relationships);
    return allFields.filter((f) => reachableIds.has(f.sourceId));
  }, [allFields, relationships, supportSourceId]);

  const numericFields = React.useMemo(
    () => fieldsForCapability(reachableFields, 'numeric').sort(sortBySourceLabel),
    [reachableFields],
  );

  const categoryFields = React.useMemo(
    () => fieldsForCapability(reachableFields, 'categorical').sort(sortBySourceLabel),
    [reachableFields],
  );

  const dateFields = React.useMemo(
    () =>
      reachableFields
        .filter((f) => f.type === 'date' || f.type === 'datetime')
        .sort(sortBySourceLabel),
    [reachableFields],
  );

  // Heatmap Y axis: any field type, but restricted to the primary source so that
  // aggregateHeatmap() can resolve values directly from the row objects.
  const heatYFields = React.useMemo(
    () => allFields.filter((f) => f.sourceId === widgetSourceId).sort(sortBySourceLabel),
    [allFields, widgetSourceId],
  );

  const chartType: StudioChartType = config.chartType ?? 'bar';
  const isHorizontalBarChart =
    (chartType === 'bar' || chartType === 'bar-stacked' || chartType === 'bar-100') &&
    config.barLayout === 'horizontal';

  // Y series: prefer ySeries, else seed from yField
  const ySeries = React.useMemo(
    () => config.ySeries ?? (config.yField ? [{ fieldId: config.yField }] : []),
    [config.ySeries, config.yField],
  );

  // finding 2.9: blended mixed charts carry foreign-source series
  // (`StudioChartSeries.sourceId`). The renderer resolves those separately
  // (`useChartWidgetData.ts` `activeYFields`) and validates only native-source fields
  // against the widget's own source. The panel must validate the SAME field set —
  // feeding a foreign series id into `analyzeChartSupport` against the widget's own
  // source spuriously reports the chart "unsupported" (and disables valid options)
  // while the canvas renders fine.
  const nativeYFieldIds = React.useMemo(
    () =>
      ySeries.flatMap((series) =>
        series.fieldId && !(series.sourceId && series.sourceId !== widgetSourceId)
          ? [series.fieldId]
          : [],
      ),
    [ySeries, widgetSourceId],
  );

  const supportsMultipleSeries =
    chartType === 'bar' ||
    chartType === 'bar-stacked' ||
    chartType === 'bar-100' ||
    chartType === 'line' ||
    chartType === 'area' ||
    chartType === 'area-stacked' ||
    chartType === 'area-100' ||
    chartType === 'mixed';

  const supportsSeriesField =
    chartType === 'bar' ||
    chartType === 'bar-stacked' ||
    chartType === 'bar-100' ||
    chartType === 'line' ||
    chartType === 'area' ||
    chartType === 'area-stacked' ||
    chartType === 'area-100' ||
    chartType === 'pie' ||
    chartType === 'donut';

  // BL-186: a "count" aggregation tallies rows and needs no measure field, so a chart with
  // an X field but no Y field is valid — it renders a row count per category (e.g. "contacts
  // by department" over a source with no visible numeric field). When no Y field is chosen we
  // lock the aggregation to Count; picking a field re-derives the usual per-field aggregation.
  const hasYField = ySeries.some((s) => s.fieldId);
  const isFieldlessCount = !hasYField && config.yAggregation === 'count';

  // Split-by is mutually exclusive with multiple Y-series: keep the control
  // visible so users can see why it's unavailable, but disable it. It is also
  // unavailable for a fieldless count — aggregateByTwoFields sums the measure and
  // can't tally rows, so a split-by + no-field-count would render an empty chart.
  const seriesFieldDisabled = ySeries.length > 1 || isFieldlessCount;

  const isScatter = chartType === 'scatter';

  // Dimension-like fields that the non-xy chart families (heatmap / funnel / sankey / gantt)
  // actually read but that are not expressed via x / y / series. Mirrors
  // `useChartWidgetData.ts`'s `chartTypeExtraFields` exactly so the panel's support check
  // validates the same fields the canvas renderer does — otherwise picking an unresolvable
  // cross-source `heatYField` (or another extra field) shows no warning here while the
  // rendered widget falls back to the "unsupported chart configuration" overlay
  // (finding 2.13).
  const chartTypeExtraFields = React.useMemo((): (string | undefined)[] => {
    switch (chartType) {
      case 'heatmap':
        return [config.heatYField];
      case 'funnel':
        return [config.funnelReachedField];
      case 'sankey':
        return [config.sankeyTargetField];
      case 'gantt':
        return [
          config.ganttLabelField,
          config.ganttStartField,
          config.ganttEndField,
          config.ganttColorField,
        ];
      default:
        return [];
    }
  }, [
    chartType,
    config.heatYField,
    config.funnelReachedField,
    config.sankeyTargetField,
    config.ganttLabelField,
    config.ganttStartField,
    config.ganttEndField,
    config.ganttColorField,
  ]);

  const chartSupport = React.useMemo(
    () =>
      analyzeChartSupport(
        widgetSourceId ?? supportSourceId,
        config.xField,
        nativeYFieldIds,
        config.seriesField,
        chartType,
        dataSources,
        relationships,
        expressionFields,
        config.scatterColorField,
        config.scatterSizeField,
        chartTypeExtraFields,
      ),
    [
      widgetSourceId,
      supportSourceId,
      config.xField,
      nativeYFieldIds,
      config.seriesField,
      chartType,
      dataSources,
      relationships,
      expressionFields,
      config.scatterColorField,
      config.scatterSizeField,
      chartTypeExtraFields,
    ],
  );

  const analyzeCombination = React.useCallback(
    (overrides: {
      // Anchor the support check on a DIFFERENT source than the widget's current one. Used
      // by the X-field picker to validate an unrelated-source candidate against the source it
      // would ADOPT on selection, instead of the current (old) source (finding 2.9).
      sourceId?: string | undefined;
      xField?: string | undefined;
      yFields?: string[];
      seriesField?: string | undefined;
      scatterColorField?: string | undefined;
      scatterSizeField?: string | undefined;
      extraFields?: (string | undefined)[];
    }) =>
      analyzeChartSupport(
        overrides.sourceId ?? widgetSourceId ?? supportSourceId,
        overrides.xField ?? config.xField,
        overrides.yFields ?? nativeYFieldIds,
        overrides.seriesField ?? config.seriesField,
        chartType,
        dataSources,
        relationships,
        expressionFields,
        overrides.scatterColorField ?? config.scatterColorField,
        overrides.scatterSizeField ?? config.scatterSizeField,
        overrides.extraFields ?? chartTypeExtraFields,
      ),
    [
      widgetSourceId,
      supportSourceId,
      config.xField,
      config.seriesField,
      config.scatterColorField,
      config.scatterSizeField,
      nativeYFieldIds,
      chartType,
      dataSources,
      relationships,
      expressionFields,
      chartTypeExtraFields,
    ],
  );

  const handleChartTypeChange = (newType: StudioChartType, newBarLayout?: StudioBarLayout) => {
    controller.updateWidgetConfig(widgetId, {
      chartType: newType,
      barLayout: newBarLayout,
    });
  };

  const usedYFieldIds = ySeries.flatMap((s) => (s.fieldId ? [s.fieldId] : []));

  const handleAddSeries = () => {
    controller.updateWidgetConfig(widgetId, { ySeries: [...ySeries, { fieldId: '' }] });
  };

  // Shared "commit ySeries + derive yField/yAggregation" transition used by both
  // handlers below, so the BL-186 fieldless-count re-lock can't be missed by either
  // (finding 2.4). BL-186: when the resulting series list has no field, the only valid
  // aggregation is a row "count" — force it so the chart keeps rendering instead of
  // going blank. When a field remains, preserve the existing `yAggregation` (a chart may
  // carry a non-default sum/avg/min/max) rather than wiping it on every series change.
  const commitYSeries = (next: typeof ySeries) => {
    const nextHasField = next.some((s) => s.fieldId);
    controller.updateWidgetConfig(widgetId, {
      ySeries: next,
      yField: next[0]?.fieldId ?? '',
      ...(nextHasField ? {} : { yAggregation: 'count' }),
    });
  };

  const handleRemoveSeries = (index: number) => {
    commitYSeries(ySeries.filter((_, i) => i !== index));
  };

  const handleSeriesFieldChange = (index: number, fieldId: string, sourceId: string) => {
    // finding 2.9: set/clear the series' `sourceId` from the PICKED field's source rather
    // than preserving a stale foreign one. An own-source pick clears `sourceId` (native
    // series); a foreign-source pick stamps it (blended series). Preserving the previous
    // foreign `sourceId` after re-pointing at an own-source field made the renderer
    // aggregate the new field against the OLD source's rows → a silent all-zero series.
    const nextSourceId = sourceId && sourceId !== widgetSourceId ? sourceId : undefined;
    commitYSeries(
      ySeries.map((s, i) => (i === index ? { ...s, fieldId, sourceId: nextSourceId } : s)),
    );
  };

  const handleSeriesTypeChange = (index: number, seriesType: 'bar' | 'line') => {
    // Write the canonical `type` field (not the deprecated `seriesType` alias) so
    // `normalizeChartSeries`'s type-wins precedence reflects this change even if a
    // stale `seriesType` is still present on the series.
    const next = ySeries.map((s, i) => (i === index ? { ...s, type: seriesType } : s));
    controller.updateWidgetConfig(widgetId, { ySeries: next });
  };

  const isPieOrDonut = chartType === 'pie' || chartType === 'donut';
  let seriesFieldHelperText = localeText.chartSetupSplitByHelperText;
  if (isFieldlessCount) {
    seriesFieldHelperText = localeText.chartSetupSplitByFieldlessCountHelperText;
  } else if (seriesFieldDisabled) {
    seriesFieldHelperText = localeText.chartSetupSplitByDisabledHelperText;
  } else if (isPieOrDonut) {
    seriesFieldHelperText = localeText.chartSetupInnerRingHelperText;
  } else {
    seriesFieldHelperText = localeText.chartSetupSplitByHelperText;
  }
  let seriesFieldDisabledTooltip = '';
  if (isFieldlessCount) {
    seriesFieldDisabledTooltip = localeText.chartSetupFieldlessCountSplitByTooltip;
  } else if (seriesFieldDisabled) {
    seriesFieldDisabledTooltip = localeText.chartSetupRemoveSplitByTooltip;
  }
  const isGauge = chartType === 'gauge';
  const isMixed = chartType === 'mixed';
  const isHeatmap = chartType === 'heatmap';
  const isFunnel = chartType === 'funnel';
  const isGantt = chartType === 'gantt';
  const isSankey = chartType === 'sankey';

  const widgetSource = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  // BL-179/180: calculated-field context for the in-dropdown "Add calculated field…"
  // entry on the Y-measure pickers. Gated to chart types that take measure fields and
  // to the calculatedFields feature flags. reachableSourceIds scopes operands (BL-180).
  const calcFieldsEnabled =
    !isScatter &&
    !isPieOrDonut &&
    !isGauge &&
    !isHeatmap &&
    !isFunnel &&
    !isGantt &&
    !isSankey &&
    widgetSource !== undefined &&
    features.calculatedFields !== false &&
    features.chartCalculatedFields !== false;
  const calculatedFieldContext = React.useMemo(() => {
    if (!calcFieldsEnabled || !widgetSource) {
      return undefined;
    }
    return {
      dataSource: widgetSource,
      expressionFields,
      reachableSourceIds: getReachableSourceIds(widgetSource.id, relationships),
    };
  }, [calcFieldsEnabled, widgetSource, expressionFields, relationships]);

  if (allFields.length === 0) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        {localeText.chartSetupNoDataAlert}
      </Alert>
    );
  }

  // Computed labels to avoid nested ternaries in JSX
  let xFieldLabel: string;
  if (isSankey) {
    xFieldLabel = localeText.chartSetupSankeySourceLabel;
  } else if (isScatter) {
    xFieldLabel = localeText.chartSetupXFieldNumericLabel;
  } else if (isPieOrDonut) {
    xFieldLabel = localeText.chartSetupXFieldPieDonutLabel;
  } else if (isFunnel) {
    xFieldLabel = localeText.chartSetupXFieldFunnelLabel;
  } else if (isHorizontalBarChart) {
    xFieldLabel = localeText.chartSetupXFieldCategoryVertLabel;
  } else {
    xFieldLabel = localeText.chartSetupXFieldCategoryHorizLabel;
  }

  let xFieldHelperText: string;
  if (isSankey) {
    xFieldHelperText = localeText.chartSetupSankeySourceHelperText;
  } else if (isScatter) {
    xFieldHelperText = localeText.chartSetupXFieldHorizontalHelperText;
  } else if (isPieOrDonut) {
    xFieldHelperText = localeText.chartSetupXFieldPieDonutHelperText;
  } else if (isFunnel) {
    xFieldHelperText = localeText.chartSetupXFieldFunnelHelperText;
  } else if (isHorizontalBarChart) {
    xFieldHelperText = localeText.chartSetupXFieldGroupVertHelperText;
  } else {
    xFieldHelperText = localeText.chartSetupXFieldGroupHorizHelperText;
  }

  let yMeasureLabel: string;
  if (isPieOrDonut) {
    yMeasureLabel = localeText.chartSetupYMeasurePieDonutLabel;
  } else if (supportsMultipleSeries) {
    yMeasureLabel = isHorizontalBarChart
      ? localeText.chartSetupXMeasureFieldsLabel
      : localeText.chartSetupYMeasureFieldsLabel;
  } else {
    yMeasureLabel = isHorizontalBarChart
      ? localeText.chartSetupXMeasureFieldLabel
      : localeText.chartSetupYMeasureFieldLabel;
  }

  const ySeriesLabelBase = isHorizontalBarChart
    ? localeText.chartSetupXMeasureFieldLabel
    : localeText.chartSetupYMeasureFieldLabel;

  const firstYSeriesFieldId = ySeries[0]?.fieldId;

  return (
    <Stack spacing={2}>
      {!chartSupport.supported && chartSupport.reason ? (
        <Alert severity="warning">
          {(() => {
            // Mirror the canvas renderer's reason → locale-key mapping
            // (StudioChartWidget.tsx) instead of the raw English `getChartSupportMessage`.
            switch (chartSupport.reason) {
              case 'field_not_found_or_not_direct':
                return localeText.chartUnsupportedFieldNotFound;
              case 'mixed_cross_source_fields':
                return localeText.chartUnsupportedMixedCrossSource;
              case 'scatter_cross_source_not_supported':
                return localeText.chartUnsupportedScatterCrossSource;
              default:
                return localeText.chartUnsupportedDefault;
            }
          })()}
        </Alert>
      ) : null}

      {/* Chart type icon picker */}
      <ChartTypePicker
        chartType={chartType}
        barLayout={config.barLayout}
        onChange={handleChartTypeChange}
      />

      <Divider />

      {/* Gauge chart setup */}
      {chartConfig.chartType === 'gauge' && (
        <GaugeConfigSection
          widgetId={widgetId}
          config={chartConfig}
          allFields={allFields}
          widgetSourceId={widgetSourceId}
          allFilters={allFilters}
          relationships={relationships}
        />
      )}

      {/* Standard (non-gauge, non-gantt) fields */}
      {!isGauge && !isGantt && (
        <Stack spacing={2}>
          {/* X field */}
          <DataSourceFieldSelect
            value={config.xField ?? ''}
            onChange={(fieldId, sourceId) => {
              // BL-186: picking the X field anchors the source. For a standard category
              // chart with no measure field yet, seed a fieldless row "count" so the chart
              // renders immediately (mirrors the KPI source-picker side effect) — building a
              // count chart from scratch needs no numeric Y field. Selecting a Y field later
              // clears this back to the per-field aggregation. Scatter/funnel/heatmap/sankey
              // have their own measure pickers, so they're excluded (supportsMultipleSeries).
              const seedFieldlessCount =
                fieldId && (supportsMultipleSeries || isPieOrDonut) && !hasYField;
              const configUpdate = {
                xField: fieldId,
                ...(seedFieldlessCount && { yAggregation: 'count' as const }),
              };
              // Fold the X-field pick and the source adoption into ONE `updateWidget`
              // commit so the source-switch gesture is a single undo step (finding 2.2);
              // a lone Ctrl+Z otherwise lands on a torn state (new sourceId, old xField)
              // the UI never produced. Without a source switch it's already one commit.
              //
              // Also fold in the removal of any widget-scoped filter that no longer
              // resolves against the new source (finding 1.5) — left in place, a stale
              // filter's field would be absent from the new source's rows and the
              // `between`/`gte` date branches in `filterUtils.ts` would then exclude
              // every row, silently blanking the chart.
              if (sourceId && sourceId !== widget?.sourceId) {
                controller.updateWidget(
                  widgetId,
                  {
                    sourceId,
                    config: { ...config, ...configUpdate } as StudioChartWidgetConfig,
                  },
                  {
                    removeFilterIds: collectStaleWidgetFilterIds(
                      allFilters,
                      widgetId,
                      sourceId,
                      allFields,
                      relationships,
                    ),
                  },
                );
              } else {
                controller.updateWidgetConfig(widgetId, configUpdate);
              }
            }}
            fields={isScatter ? fieldsForCapability(allFields, 'numeric') : allFields}
            getOptionDisabled={(option) => {
              if (option.id === config.xField) {
                return false;
              }
              // A chart has no separate source picker — the X field IS how it adopts a
              // source. When the candidate belongs to an unrelated source, selecting it
              // adopts that source (see onChange), so validate the candidate against its OWN
              // source as anchor. Anchoring on the current (old) source reports every
              // unrelated-source field `field_not_found_or_not_direct` and would disable the
              // panel's own adoption path forever (finding 2.9). The candidate's X field is
              // validated alone; the post-adoption Y/split-by validity surfaces via the
              // panel's support warning, where the user re-points those fields.
              const currentAnchor = widgetSourceId ?? supportSourceId;
              if (option.sourceId !== currentAnchor) {
                return !analyzeCombination({
                  sourceId: option.sourceId,
                  xField: option.id,
                  yFields: [],
                  seriesField: undefined,
                  extraFields: [],
                }).supported;
              }
              return !analyzeCombination({ xField: option.id }).supported;
            }}
            label={xFieldLabel}
            helperText={xFieldHelperText}
            required
          />

          {/* Group by — shown only when x field is a date/datetime type */}
          {!isSankey &&
            (selectedXField?.type === 'date' || selectedXField?.type === 'datetime') && (
              <FormControl size="small" fullWidth>
                <InputLabel>{localeText.chartSetupGroupByLabel}</InputLabel>
                <Select
                  label={localeText.chartSetupGroupByLabel}
                  value={config.xGroupBy ?? ''}
                  onChange={(evt) => {
                    const val = evt.target.value as string;
                    controller.updateWidgetConfig(widgetId, {
                      xGroupBy: val
                        ? (val as 'day' | 'week' | 'month' | 'quarter' | 'year')
                        : undefined,
                    });
                  }}
                >
                  <MenuItem value="">{localeText.timeGranNone}</MenuItem>
                  <MenuItem value="day">{localeText.timeGranDay}</MenuItem>
                  <MenuItem value="week">{localeText.timeGranWeek}</MenuItem>
                  <MenuItem value="month">{localeText.timeGranMonth}</MenuItem>
                  <MenuItem value="quarter">{localeText.timeGranQuarter}</MenuItem>
                  <MenuItem value="year">{localeText.timeGranYear}</MenuItem>
                </Select>
              </FormControl>
            )}

          {/* Sort controls — shown when x-field is set on categorical charts (not scatter, not heatmap, not gauge, not gantt, not sankey) */}
          {config.xField && !isScatter && !isHeatmap && !isSankey && (
            <Stack direction="column" spacing={1}>
              <FormControl size="small" fullWidth>
                <InputLabel>{localeText.chartSetupSortByLabel}</InputLabel>
                <Select
                  label={localeText.chartSetupSortByLabel}
                  value={config.chartSortBy ?? 'category'}
                  onChange={(evt) => {
                    controller.updateWidgetConfig(widgetId, {
                      chartSortBy: evt.target.value as 'category' | 'value' | 'natural',
                    });
                  }}
                  SelectDisplayProps={{
                    title: (() => {
                      const sortBy = config.chartSortBy ?? 'category';
                      if (sortBy === 'category') {
                        return selectedXField?.label ?? localeText.chartSetupSortCategory;
                      }
                      if (sortBy === 'value') {
                        return localeText.chartSetupSortValue;
                      }
                      return localeText.chartSetupSortNatural;
                    })(),
                  }}
                >
                  <MenuItem value="category">
                    {selectedXField?.label ?? localeText.chartSetupSortCategory}
                  </MenuItem>
                  <MenuItem value="value">{localeText.chartSetupSortValue}</MenuItem>
                  <MenuItem value="natural">{localeText.chartSetupSortNatural}</MenuItem>
                </Select>
              </FormControl>
              {/* Sort direction — funnel has no sort DIRECTION concept (only chartSortBy);
                  StudioFunnelChartConfig deliberately omits chartSortDirection, so the
                  toggle is hidden for funnel rather than writing a key the funnel
                  aggregation never reads. */}
              {!isFunnel && (config.chartSortBy ?? 'category') !== 'natural' && (
                <SortDirectionToggle
                  value={config.chartSortDirection ?? 'asc'}
                  onChange={(val) =>
                    controller.updateWidgetConfig(widgetId, { chartSortDirection: val })
                  }
                />
              )}
            </Stack>
          )}

          {/* Scatter: single Y field + optional color-by */}
          {chartConfig.chartType === 'scatter' && (
            <ScatterConfigSection
              widgetId={widgetId}
              config={chartConfig}
              numericFields={numericFields}
              categoryFields={categoryFields}
              firstYSeriesFieldId={firstYSeriesFieldId}
            />
          )}

          {/* Funnel: single value/measure field + visual options */}
          {chartConfig.chartType === 'funnel' && (
            <FunnelConfigSection
              widgetId={widgetId}
              config={chartConfig}
              numericFields={numericFields}
              firstYSeriesFieldId={firstYSeriesFieldId}
            />
          )}

          {/* Heatmap: row axis field + colour-value measure */}
          {chartConfig.chartType === 'heatmap' && (
            <HeatmapAxesSection
              widgetId={widgetId}
              config={chartConfig}
              heatYFields={heatYFields}
              numericFields={numericFields}
              allFields={allFields}
              firstYSeriesFieldId={firstYSeriesFieldId}
            />
          )}

          {/* Sankey: target node field + value measure + link options */}
          {chartConfig.chartType === 'sankey' && (
            <SankeyConfigSection
              widgetId={widgetId}
              config={chartConfig}
              categoryFields={categoryFields}
              numericFields={numericFields}
              firstYSeriesFieldId={firstYSeriesFieldId}
            />
          )}

          {/* Y series — for non-scatter, non-gauge, non-heatmap, non-funnel, non-sankey charts */}
          {!isScatter && !isHeatmap && !isFunnel && !isSankey && (
            <div>
              <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
                  {yMeasureLabel}
                </Typography>
                {supportsMultipleSeries && (
                  <Tooltip
                    title={
                      usedYFieldIds.length >= numericFields.length
                        ? localeText.chartSetupNoMoreFields
                        : localeText.chartSetupAddSeries
                    }
                  >
                    <span>
                      <IconButton
                        size="small"
                        onClick={handleAddSeries}
                        disabled={usedYFieldIds.length >= numericFields.length}
                      >
                        <AddIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
              </Stack>
              <Stack spacing={1}>
                {ySeries.map((s, index) => (
                  <React.Fragment key={s.fieldId || `series-${index}`}>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                      <DataSourceFieldSelect
                        value={s.fieldId ?? ''}
                        onChange={(fieldId, sourceId) =>
                          handleSeriesFieldChange(index, fieldId, sourceId)
                        }
                        fields={numericFields}
                        getOptionDisabled={(option) =>
                          (option.id !== s.fieldId && usedYFieldIds.includes(option.id)) ||
                          (option.id !== s.fieldId &&
                            !analyzeCombination({
                              // Mirror the support memo: validate only native-source series
                              // (finding 2.9), with the candidate option taking this slot.
                              yFields: ySeries.flatMap((series, seriesIndex) => {
                                if (seriesIndex === index) {
                                  return option.id ? [option.id] : [];
                                }
                                if (series.sourceId && series.sourceId !== widgetSourceId) {
                                  return [];
                                }
                                return series.fieldId ? [series.fieldId] : [];
                              }),
                            }).supported)
                        }
                        label={
                          ySeries.length > 1
                            ? localeText.chartSetupSeriesLabel(index)
                            : ySeriesLabelBase
                        }
                        helperText={
                          isHorizontalBarChart
                            ? localeText.chartSetupSeriesNumericHorizHelperText
                            : localeText.chartSetupSeriesNumericSumHelperText
                        }
                        calculatedField={calculatedFieldContext}
                      />
                      {ySeries.length > 1 && (
                        <Tooltip title={localeText.chartSetupRemoveSeries}>
                          <IconButton
                            size="small"
                            aria-label={localeText.chartSetupRemoveSeries}
                            onClick={() => handleRemoveSeries(index)}
                            sx={{ mt: 1 }}
                          >
                            <CloseIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Stack>
                    {isMixed && s.fieldId && (
                      <ToggleButtonGroup
                        size="small"
                        exclusive
                        value={normalizeChartSeries(s).type ?? 'bar'}
                        onChange={(_, val) => {
                          if (val) {
                            handleSeriesTypeChange(index, val);
                          }
                        }}
                        sx={{ mt: 0.5, mb: 0.5 }}
                      >
                        <ToggleButton
                          value="bar"
                          sx={{ px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' }}
                        >
                          {localeText.chartSetupMixedSeriesBar}
                        </ToggleButton>
                        <ToggleButton
                          value="line"
                          sx={{ px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' }}
                        >
                          {localeText.chartSetupMixedSeriesLine}
                        </ToggleButton>
                      </ToggleButtonGroup>
                    )}
                  </React.Fragment>
                ))}
                {ySeries.length === 0 && (
                  <DataSourceFieldSelect
                    value=""
                    onChange={(fieldId) => {
                      // Picking a measure field re-derives the usual per-field aggregation
                      // (sum, or count for non-numeric fields — handled by aggregateByField),
                      // so drop the fieldless-count lock. See BL-186.
                      controller.updateWidgetConfig(widgetId, {
                        ySeries: [{ fieldId }],
                        yField: fieldId,
                        yAggregation: undefined,
                      });
                    }}
                    fields={numericFields}
                    getOptionDisabled={(option) =>
                      !analyzeCombination({ yFields: [option.id] }).supported
                    }
                    label={ySeriesLabelBase}
                    helperText={
                      isHorizontalBarChart
                        ? localeText.chartSetupSeriesNumericHorizHelperText
                        : localeText.chartSetupSeriesNumericSumHelperText
                    }
                    calculatedField={calculatedFieldContext}
                  />
                )}
                {/* BL-186: with no measure field, the only meaningful aggregation is a row
                    "count" — it needs no field. Offer it as an explicit, reproducible state
                    (a locked Count select) so a count chart can be built from scratch even on
                    a source with no visible numeric field. Single-series charts only; split-by
                    and multi-Y can't tally rows, so they aren't offered fieldless. */}
                {!hasYField && (supportsMultipleSeries || isPieOrDonut) && (
                  <FormControl size="small" fullWidth disabled>
                    <InputLabel>{localeText.chartSetupAggregationLabel}</InputLabel>
                    <Select label={localeText.chartSetupAggregationLabel} value="count">
                      <MenuItem value="count">{localeText.aggFnCount}</MenuItem>
                    </Select>
                    <FormHelperText>{localeText.aggregationLockedHelperText}</FormHelperText>
                  </FormControl>
                )}
              </Stack>
            </div>
          )}
          {/* Dual Y axis toggle — only for mixed chart with 2+ series */}
          {isMixed && ySeries.filter((s) => s.fieldId).length >= 2 && (
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={config.dualYAxis ?? false}
                  onChange={(event) =>
                    controller.updateWidgetConfig(widgetId, { dualYAxis: event.target.checked })
                  }
                />
              }
              label={<Typography variant="caption">{localeText.chartSetupDualYAxis}</Typography>}
              sx={{ ml: 0 }}
            />
          )}
          {/* Split by / series field */}
          {supportsSeriesField && (
            <div>
              <Tooltip title={seriesFieldDisabledTooltip} placement="top">
                <span>
                  <DataSourceFieldSelect
                    value={config.seriesField ?? ''}
                    onChange={(fieldId) =>
                      controller.updateWidgetConfig(widgetId, {
                        seriesField: fieldId || undefined,
                      })
                    }
                    fields={categoryFields}
                    getOptionDisabled={(option) => {
                      if (seriesFieldDisabled) {
                        return true;
                      }
                      if (option.id === config.seriesField) {
                        return false;
                      }
                      return !analyzeCombination({ seriesField: option.id }).supported;
                    }}
                    disabled={seriesFieldDisabled}
                    label={
                      isPieOrDonut
                        ? localeText.chartSetupInnerRingLabel
                        : localeText.chartSetupSplitByLabel
                    }
                    helperText={seriesFieldHelperText}
                  />
                </span>
              </Tooltip>
            </div>
          )}
          {/* Pie / donut: arc label options */}
          {(chartConfig.chartType === 'pie' || chartConfig.chartType === 'donut') && (
            <PieArcLabelsSection widgetId={widgetId} config={chartConfig} />
          )}
        </Stack>
      )}

      {/* Gantt / timeline chart fields */}
      {chartConfig.chartType === 'gantt' && (
        <GanttFieldsSection
          widgetId={widgetId}
          config={chartConfig}
          allFields={allFields}
          dateFields={dateFields}
          categoryFields={categoryFields}
          widgetSourceId={widgetSourceId}
          allFilters={allFilters}
          relationships={relationships}
        />
      )}

      {/* Annotations — reference lines (not for pie/donut/gauge/gantt/sankey/heatmap) */}
      {features.chartAnnotations !== false &&
        chartType !== 'pie' &&
        chartType !== 'donut' &&
        chartType !== 'gauge' &&
        chartType !== 'gantt' &&
        chartType !== 'sankey' &&
        chartType !== 'heatmap' && <AnnotationsEditorSection widgetId={widgetId} config={config} />}
      {/* Interactions — cross-filter mode */}
      <CrossFilterModeSection
        widgetId={widgetId}
        title={localeText.chartSetupInteractionsTitle}
        description={localeText.chartSetupInteractionsDescription}
        modes={['cross-highlight', 'cross-filter', 'none']}
        defaultMode="cross-highlight"
        value={config.crossFilterMode}
      />
    </Stack>
  );
}
