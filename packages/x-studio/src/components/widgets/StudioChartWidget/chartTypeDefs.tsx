'use client';

import * as React from 'react';
import type { BarChartProps } from '@mui/x-charts/BarChart';
import type { LineChartProps } from '@mui/x-charts/LineChart';
import type { PieChartProps } from '@mui/x-charts/PieChart';
import type { ScatterChartProps } from '@mui/x-charts/ScatterChart';
import type { GaugeProps } from '@mui/x-charts/Gauge';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box, Typography } from '@mui/material';

import type {
  StudioChartConfig,
  StudioChartConfigOfType,
  StudioDataField,
  StudioDataSource,
  StudioExpressionField,
  StudioSharedWidgetConfig,
} from '../../../models';
import type { StudioChartType, StudioBarLayout } from '../../../models/baseTypes';
import type {
  AggregatedData,
  MultiSeriesData,
  MultiYSeriesData,
  ScatterDataPoint,
  ScatterSeriesData,
} from '../../../internals/chartAggregation';
import {
  aggregateFunnelReached,
  aggregateHeatmap,
  aggregateSankey,
  buildFunnelStages,
  buildGanttItems,
} from '../../../internals/chartAggregation';
import type { StudioLocaleText } from '../../../internals/StudioUIConfigContext';
import { cachedCompute } from '../../../internals/computedCache';
import { computeAggregate } from '../StudioKpiWidget/kpiUtils';
import { StudioFunnelChart } from './StudioFunnelChart';
import { StudioGanttChart } from './StudioGanttChart';
import { StudioSankeyChart } from './StudioSankeyChart';
import { StudioGaugeChart } from './StudioGaugeChart';
import { StudioScatterChart } from './StudioScatterChart';
import { StudioMixedChart } from './StudioMixedChart';
import { StudioHeatmapChart } from './StudioHeatmapChart';
import { StudioPieChart } from './StudioPieChart';
import { StudioLineAreaChart } from './StudioLineAreaChart';
import { StudioBarChart } from './StudioBarChart';
import { StudioNoDataOverlay } from '../../../internals/StudioNoDataOverlay';
import { makeValueFormatter, resolveFieldDef } from './chartWidgetHelpers';

type HoverHighlightItem = HighlightItemIdentifier<'bar' | 'line' | 'pie'>;

/**
 * Slot props this dispatcher forwards to each chart-specific renderer. Structurally
 * identical to (and assignable from) `StudioChartWidgetSlotProps` in `StudioChartWidget.tsx`
 * — defined separately here (rather than imported) to avoid a module cycle: this file is
 * imported BY `StudioChartWidget.tsx`, and that file's slot-prop type also carries
 * `noDataOverlay`, which no per-type `render` needs.
 */
export interface ChartDispatchSlotProps {
  barChart?: Partial<BarChartProps>;
  lineChart?: Partial<LineChartProps>;
  pieChart?: Partial<PieChartProps>;
  scatterChart?: Partial<ScatterChartProps>;
  gaugeChart?: Omit<
    Partial<GaugeProps>,
    'ref' | 'value' | 'valueMin' | 'valueMax' | 'width' | 'height'
  >;
}

/**
 * Everything a `ChartTypeDef.render` implementation needs to draw its chart type.
 * Fields are exactly what the pre-registry if-chain computed once in the orchestrator
 * and threaded into each branch — nothing is included "just in case".
 */
export interface ChartRenderContext<T extends StudioChartType = StudioChartType> {
  /**
   * Narrowed to the family config for `T`, so each `render*` reads only the keys its
   * chart family actually owns (no per-renderer `as` casts). The default `T`
   * (`StudioChartType`) resolves this to the full `StudioChartWidgetConfig` union —
   * the shape `StudioChartWidget` builds the single context with, before the one
   * documented dispatch cast narrows it to the looked-up type.
   */
  config: StudioSharedWidgetConfig & StudioChartConfigOfType<T>;
  dataSource?: StudioDataSource;
  /** All data sources, keyed by id — only the (cross-source) mixed chart needs this. */
  dataSources: Record<string, StudioDataSource>;
  /** The widget's own source id — only the (cross-source) mixed chart needs this. */
  widgetSourceId?: string;
  expressionFields: StudioExpressionField[];
  localeText: StudioLocaleText;
  slotProps?: ChartDispatchSlotProps;
  chartHeight: number;
  filteredRows: Record<string, unknown>[];
  xGroupBy: StudioChartConfig['xGroupBy'];
  /** Resolved bar orientation/stacking (`config.barLayout ?? 'grouped'`). */
  barLayout: StudioBarLayout;
  /** Whether the (mixed) chart blends independently-aggregated cross-source series. */
  isBlended: boolean;

  // ── useChartWidgetData() outputs ──────────────────────────────────────────
  activeYFields: string[];
  chartData: AggregatedData | null;
  allChartData: AggregatedData | null;
  seriesFieldData: MultiSeriesData | null;
  allSeriesFieldData: MultiSeriesData | null;
  multiYData: MultiYSeriesData | null;
  allMultiYData: MultiYSeriesData | null;
  enrichedRows: Record<string, unknown>[];
  allEnrichedRows: Record<string, unknown>[];
  scatterData: ScatterDataPoint[] | null;
  scatterSeries: ScatterSeriesData[] | null;
  allScatterData: ScatterDataPoint[] | null;
  allScatterSeries: ScatterSeriesData[] | null;
  shouldShowGhost: boolean;

  // ── derived / memoized helpers ─────────────────────────────────────────────
  formatLabel: (label: string | number) => string;
  chartColors?: string[];
  resolvedChartColors: string[];
  getSeriesColor: (name: string | number) => string | undefined;
  preserveXFieldBaseline: boolean;
  preserveSplitByBaseline: boolean;
  skipAnimation: boolean;
  getSelectedDataIndices: (labels: Array<string | number | Date>) => number[];
  hoveredItem: HoverHighlightItem | null;
  hoveredAxis: AxisItemIdentifier[] | null;
  hasActiveXFilter: boolean;
  hasIncomingCrossFilters: boolean;
  onHoverChange: (item: HoverHighlightItem | null) => void;
  onAxisHoverChange: (axis: AxisItemIdentifier[] | null) => void;
  onItemClick: (label: string | number | Date, shiftKey: boolean) => void;
  annotationChildren: React.ReactNode;
}

/** Descriptor for a single `StudioChartType`'s guard-order behavior and rendering. */
export interface ChartTypeDef<T extends StudioChartType = StudioChartType> {
  /** Whether the shared "chart not configured" guard requires `config.xField`. */
  needsXField: boolean;
  /** Whether the shared chart-support (`analyzeChartSupport`) guard applies to this type. */
  runsSupportGuard: boolean;
  /** Whether the shared "no rows after filtering" guard applies to this type. */
  runsNoDataGuard: boolean;
  // Declared as a METHOD (not an arrow property) so its `ctx` parameter is checked
  // bivariantly: this lets a family-narrow renderer (e.g. `renderBar`, typed for
  // `ChartRenderContext<'bar' | …>`) satisfy `Record<StudioChartType, ChartTypeDef>`
  // in `CHART_TYPE_DEFS` below, which a contravariant arrow property would reject.
  render(ctx: ChartRenderContext<T>): React.ReactElement;
}

/** A centered hint message shown in place of the chart (unconfigured / unsupported state). */
function ChartHintBox({ height, children }: { height: number; children: React.ReactNode }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height,
        color: 'text.disabled',
      }}
    >
      <Typography variant="body2">{children}</Typography>
    </Box>
  );
}

/** An empty placeholder drawn in place of the chart when there's no aggregated data yet. */
function EmptyChartBox({ height }: { height: number }) {
  return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height }} />;
}

// ── bar / bar-stacked / bar-100 ───────────────────────────────────────────────

function renderBar(ctx: ChartRenderContext<'bar' | 'bar-stacked' | 'bar-100'>): React.ReactElement {
  const { config, chartHeight, multiYData, chartData } = ctx;
  const chartType = config.chartType ?? 'bar';

  // `chartData` is null whenever `activeYFields.length > 1` (multi-Y bars use `multiYData`
  // instead), so a multi-Y bar must be reachable even when `chartData` is null/empty — this
  // check therefore runs BEFORE (and independently of) the chartData-emptiness check below.
  // This mirrors the pre-registry orchestrator's two separate bar dispatch call sites: one
  // above its shared empty-`chartData` guard (multi-Y), one below it (seriesField/single-series).
  const hasMultiY = !!multiYData && multiYData.labels.length > 0;

  if (!hasMultiY && (!chartData || chartData.labels.length === 0)) {
    return <EmptyChartBox height={chartHeight} />;
  }

  return (
    <StudioBarChart
      chartType={chartType}
      height={chartHeight}
      barLayout={ctx.barLayout}
      chartData={chartData}
      allChartData={ctx.allChartData}
      seriesFieldData={ctx.seriesFieldData}
      allSeriesFieldData={ctx.allSeriesFieldData}
      multiYData={multiYData}
      allMultiYData={ctx.allMultiYData}
      activeYFields={ctx.activeYFields}
      dataSource={ctx.dataSource}
      expressionFields={ctx.expressionFields}
      formatLabel={ctx.formatLabel}
      defaultSeriesLabel={ctx.localeText.chartDefaultSeriesLabel}
      barMinBandSize={config.barMinBandSize}
      barCategoryGapRatio={config.barCategoryGapRatio}
      axisTickFontSize={config.axisTickFontSize}
      barMaxCategories={config.barMaxCategories}
      barBandLabelWrap={config.barBandLabelWrap}
      wrapBandLabelMaxLines={config.wrapBandLabelMaxLines}
      chartColors={ctx.chartColors}
      getSeriesColor={ctx.getSeriesColor}
      shouldShowGhost={ctx.shouldShowGhost}
      preserveXFieldBaseline={ctx.preserveXFieldBaseline}
      preserveSplitByBaseline={ctx.preserveSplitByBaseline}
      skipAnimation={ctx.skipAnimation}
      getSelectedDataIndices={ctx.getSelectedDataIndices}
      hoveredItem={ctx.hoveredItem}
      hoveredAxis={ctx.hoveredAxis}
      hasActiveXFilter={ctx.hasActiveXFilter}
      hasIncomingCrossFilters={ctx.hasIncomingCrossFilters}
      onHoverChange={ctx.onHoverChange}
      onAxisHoverChange={ctx.onAxisHoverChange}
      onItemClick={ctx.onItemClick}
      slotProps={ctx.slotProps?.barChart}
    >
      {ctx.annotationChildren}
    </StudioBarChart>
  );
}

// ── pie / donut ────────────────────────────────────────────────────────────────

function renderPieDonut(ctx: ChartRenderContext<'pie' | 'donut'>): React.ReactElement {
  const { config, chartData, chartHeight } = ctx;
  const chartType = config.chartType;

  if (!chartData || chartData.labels.length === 0) {
    return <EmptyChartBox height={chartHeight} />;
  }

  const pieYFieldDef = resolveFieldDef(ctx.activeYFields[0], ctx.dataSource, ctx.expressionFields);
  const pieValueFormatter = makeValueFormatter(
    pieYFieldDef?.format,
    pieYFieldDef?.currencyCode,
    pieYFieldDef?.precision,
  );

  return (
    <StudioPieChart
      chartType={chartType}
      height={chartHeight}
      chartData={chartData}
      allChartData={ctx.allChartData}
      enrichedRows={ctx.enrichedRows}
      allEnrichedRows={ctx.allEnrichedRows}
      seriesField={config.seriesField}
      xField={config.xField}
      yField={config.yField}
      activeYFields={ctx.activeYFields}
      // Mirror `useChartWidgetData`'s single-ring precedence (per-series fn wins over the
      // yField-level default) so grouped rings honour the configured aggregation (finding 2.25).
      yAggregation={config.ySeries?.[0]?.yAggregation ?? config.yAggregation}
      xGroupBy={ctx.xGroupBy}
      pieLegendBelow={!!config.pieLegendBelow}
      pieArcLabel={config.pieArcLabel}
      pieArcLabelMinAngle={config.pieArcLabelMinAngle}
      pieMaxSlices={config.pieMaxSlices}
      chartColors={ctx.chartColors}
      resolvedChartColors={ctx.resolvedChartColors}
      shouldShowGhost={ctx.shouldShowGhost}
      preserveXFieldBaseline={ctx.preserveXFieldBaseline}
      skipAnimation={ctx.skipAnimation}
      valueFormatter={pieValueFormatter}
      fieldLabel={pieYFieldDef?.label}
      formatLabel={ctx.formatLabel}
      getSelectedDataIndices={ctx.getSelectedDataIndices}
      hoveredItem={ctx.hoveredItem}
      hasActiveXFilter={ctx.hasActiveXFilter}
      hasIncomingCrossFilters={ctx.hasIncomingCrossFilters}
      onHoverChange={ctx.onHoverChange}
      onItemClick={ctx.onItemClick}
      slotProps={ctx.slotProps?.pieChart}
    />
  );
}

// ── line / area / area-stacked / area-100 ────────────────────────────────────────

function renderLineArea(
  ctx: ChartRenderContext<'line' | 'area' | 'area-stacked' | 'area-100'>,
): React.ReactElement {
  const { config, chartData, chartHeight, multiYData } = ctx;
  const chartType = config.chartType;

  // `chartData` is null whenever `activeYFields.length > 1` (multi-Y line/area uses `multiYData`
  // instead), so a multi-measure line/area chart must be reachable even when `chartData` is
  // null/empty — this check therefore runs BEFORE (and independently of) the chartData-emptiness
  // check below, mirroring `renderBar`. `StudioLineAreaChart` has a complete multi-Y render path
  // that was dead code while this guard fell straight through to `EmptyChartBox` (finding 1.8).
  const hasMultiY = !!multiYData && multiYData.labels.length > 0;

  if (!hasMultiY && (!chartData || chartData.labels.length === 0)) {
    return <EmptyChartBox height={chartHeight} />;
  }

  return (
    <StudioLineAreaChart
      chartType={chartType}
      height={chartHeight}
      chartData={chartData}
      allChartData={ctx.allChartData}
      seriesFieldData={ctx.seriesFieldData}
      allSeriesFieldData={ctx.allSeriesFieldData}
      multiYData={ctx.multiYData}
      allMultiYData={ctx.allMultiYData}
      activeYFields={ctx.activeYFields}
      dataSource={ctx.dataSource}
      expressionFields={ctx.expressionFields}
      xGroupBy={ctx.xGroupBy}
      formatLabel={ctx.formatLabel}
      forecast={config.forecast}
      forecastSeriesLabel={ctx.localeText.chartForecastSeriesLabel}
      defaultSeriesLabel={ctx.localeText.chartDefaultSeriesLabel}
      chartColors={ctx.chartColors}
      resolvedChartColors={ctx.resolvedChartColors}
      getSeriesColor={ctx.getSeriesColor}
      shouldShowGhost={ctx.shouldShowGhost}
      preserveXFieldBaseline={ctx.preserveXFieldBaseline}
      preserveSplitByBaseline={ctx.preserveSplitByBaseline}
      skipAnimation={ctx.skipAnimation}
      getSelectedDataIndices={ctx.getSelectedDataIndices}
      hoveredItem={ctx.hoveredItem}
      hoveredAxis={ctx.hoveredAxis}
      hasActiveXFilter={ctx.hasActiveXFilter}
      hasIncomingCrossFilters={ctx.hasIncomingCrossFilters}
      onHoverChange={ctx.onHoverChange}
      onAxisHoverChange={ctx.onAxisHoverChange}
      onItemClick={ctx.onItemClick}
      slotProps={ctx.slotProps?.lineChart}
    >
      {ctx.annotationChildren}
    </StudioLineAreaChart>
  );
}

// ── scatter ───────────────────────────────────────────────────────────────────

function renderScatter(ctx: ChartRenderContext<'scatter'>): React.ReactElement {
  const { config } = ctx;
  const xAxisLabel =
    resolveFieldDef(config.xField, ctx.dataSource, ctx.expressionFields)?.label ?? config.xField;
  const yAxisLabel =
    resolveFieldDef(config.yField, ctx.dataSource, ctx.expressionFields)?.label ?? config.yField;

  return (
    <StudioScatterChart
      height={ctx.chartHeight}
      colorField={config.scatterColorField}
      sizeField={config.scatterSizeField}
      minRadius={config.scatterMinRadius}
      maxRadius={config.scatterMaxRadius}
      scatterData={ctx.scatterData}
      scatterSeries={ctx.scatterSeries}
      allScatterData={ctx.allScatterData}
      allScatterSeries={ctx.allScatterSeries}
      shouldShowGhost={ctx.shouldShowGhost}
      skipAnimation={ctx.skipAnimation}
      colors={ctx.chartColors}
      xAxisLabel={xAxisLabel}
      yAxisLabel={yAxisLabel}
      slotProps={ctx.slotProps?.scatterChart}
    >
      {ctx.annotationChildren}
    </StudioScatterChart>
  );
}

// ── mixed ─────────────────────────────────────────────────────────────────────

function renderMixed(ctx: ChartRenderContext<'mixed'>): React.ReactElement {
  const { multiYData, chartHeight, config } = ctx;

  if (!multiYData || multiYData.labels.length === 0) {
    return (
      <ChartHintBox height={chartHeight}>
        {ctx.localeText.chartMixedRequiresFieldsHint}
      </ChartHintBox>
    );
  }

  return (
    <StudioMixedChart
      multiYData={multiYData}
      ySeries={config.ySeries ?? []}
      dualYAxis={config.dualYAxis}
      isBlended={ctx.isBlended}
      resolvedChartColors={ctx.resolvedChartColors}
      widgetSourceId={ctx.widgetSourceId}
      dataSources={ctx.dataSources}
      dataSource={ctx.dataSource}
      height={chartHeight}
      skipAnimation={ctx.skipAnimation}
      formatLabel={ctx.formatLabel}
    >
      {ctx.annotationChildren}
    </StudioMixedChart>
  );
}

// ── heatmap ───────────────────────────────────────────────────────────────────

function renderHeatmap(ctx: ChartRenderContext<'heatmap'>): React.ReactElement {
  const { config, dataSource, expressionFields, filteredRows, xGroupBy, chartHeight } = ctx;
  const heatXField = config.xField ?? '';
  const heatYField = config.heatYField ?? '';
  const heatValueField = config.yField ?? config.ySeries?.[0]?.fieldId ?? '';

  if (!heatXField || !heatYField || !heatValueField) {
    return (
      <ChartHintBox height={chartHeight}>
        {ctx.localeText.chartHeatmapRequiresFieldsHint}
      </ChartHintBox>
    );
  }

  const xFieldDef = dataSource?.fields.find((f) => f.id === heatXField);
  const yFieldDef = dataSource?.fields.find((f) => f.id === heatYField);
  const valueFieldDef = resolveFieldDef(heatValueField, dataSource, expressionFields);
  const heatAggregation = config.yAggregation ?? 'sum';
  const heatData = cachedCompute(
    filteredRows,
    JSON.stringify([
      'heatmap',
      heatXField,
      heatYField,
      heatValueField,
      xGroupBy,
      heatAggregation,
      config.heatSortBy,
      config.heatSortDirection,
      xFieldDef?.orderedValues,
      yFieldDef?.orderedValues,
    ]),
    () =>
      aggregateHeatmap(
        filteredRows,
        heatXField,
        heatYField,
        heatValueField,
        xGroupBy,
        heatAggregation,
        xFieldDef?.orderedValues,
        yFieldDef?.orderedValues,
        config.heatSortBy,
        config.heatSortDirection,
      ),
  );
  const heatFormatDef = valueFieldDef?.type
    ? (valueFieldDef as Pick<StudioDataField, 'type' | 'format' | 'currencyCode' | 'precision'>)
    : undefined;

  return (
    <StudioHeatmapChart
      height={chartHeight}
      heatData={heatData}
      xFieldLabel={xFieldDef?.label}
      yFieldLabel={yFieldDef?.label}
      valueFieldDef={heatFormatDef}
      colorScheme={config.heatColorScheme ?? 'primary'}
      legendPosition={config.heatLegendPosition ?? 'bottom'}
      legendAlign={config.heatLegendAlign ?? 'center'}
    />
  );
}

// ── funnel ────────────────────────────────────────────────────────────────────

function renderFunnel(ctx: ChartRenderContext<'funnel'>): React.ReactElement {
  const { config, dataSource, filteredRows, chartHeight } = ctx;
  const funnelXField = config.xField ?? '';
  const funnelValueField = config.yField ?? config.ySeries?.[0]?.fieldId ?? '';

  if (!funnelXField || !funnelValueField) {
    return (
      <ChartHintBox height={chartHeight}>
        {ctx.localeText.chartFunnelRequiresFieldsHint}
      </ChartHintBox>
    );
  }

  const valueFieldDef = dataSource?.fields.find((f) => f.id === funnelValueField);

  // Cumulative "reached stage" mode: count deals whose reached-depth is at or
  // beyond each stage → monotonically non-increasing by construction (never
  // > 100%). The terminal exit stage (e.g. Closed Lost) is excluded from the
  // sequential math and reported separately. Opt-in via `funnelReachedField`.
  if (config.funnelReachedField && config.funnelStageSequence) {
    const reached = cachedCompute(
      filteredRows,
      JSON.stringify([
        'funnelReached',
        funnelXField,
        config.funnelReachedField,
        config.funnelStageSequence,
      ]),
      () =>
        aggregateFunnelReached(
          filteredRows,
          funnelXField,
          config.funnelReachedField!,
          config.funnelStageSequence!,
        ),
    );

    return (
      <StudioFunnelChart
        stages={reached.stages.map((s) => ({ label: s.label, value: s.value }))}
        height={chartHeight}
        valueFormat="integer"
        labelFormat={config.funnelLabelFormat}
        labelPlacement={config.funnelLabelPlacement}
        gap={config.funnelGap}
        curve={config.funnelCurve}
        variant={config.funnelVariant}
      />
    );
  }

  const fieldOrderedValues = dataSource?.fields.find((f) => f.id === funnelXField)?.orderedValues;
  const { stages, sort } = cachedCompute(
    filteredRows,
    JSON.stringify([
      'funnelStages',
      funnelXField,
      funnelValueField,
      config.yAggregation,
      config.chartSortBy,
      config.funnelCategoryOrder,
      fieldOrderedValues,
    ]),
    () =>
      buildFunnelStages(
        filteredRows,
        funnelXField,
        funnelValueField,
        config.yAggregation,
        config.chartSortBy,
        config.funnelCategoryOrder,
        fieldOrderedValues,
      ),
  );

  // Auto-default label placement to outside-end when conversion format is chosen.
  const funnelLabelFormat = config.funnelLabelFormat ?? 'value';
  const funnelLabelPlacement =
    config.funnelLabelPlacement ?? (funnelLabelFormat === 'conversion' ? 'outside-end' : 'inside');

  return (
    <StudioFunnelChart
      stages={stages}
      height={chartHeight}
      valueFormat={valueFieldDef?.format}
      currencyCode={valueFieldDef?.currencyCode}
      labelFormat={funnelLabelFormat}
      labelPlacement={funnelLabelPlacement}
      gap={config.funnelGap}
      curve={config.funnelCurve}
      variant={config.funnelVariant}
      sort={sort}
    />
  );
}

// ── sankey ────────────────────────────────────────────────────────────────────

function renderSankey(ctx: ChartRenderContext<'sankey'>): React.ReactElement {
  const { config, dataSource, filteredRows, chartHeight } = ctx;
  const sankeySourceField = config.xField ?? '';
  const sankeyTargetField = config.sankeyTargetField ?? '';
  const sankeyValueField = config.yField ?? config.ySeries?.[0]?.fieldId ?? '';

  if (!sankeySourceField || !sankeyTargetField || !sankeyValueField) {
    return (
      <ChartHintBox height={chartHeight}>
        {ctx.localeText.chartSankeyRequiresFieldsHint}
      </ChartHintBox>
    );
  }

  const valueFieldDef = dataSource?.fields.find((f) => f.id === sankeyValueField);
  const sankeyData = cachedCompute(
    filteredRows,
    JSON.stringify(['sankey', sankeySourceField, sankeyTargetField, sankeyValueField]),
    () => aggregateSankey(filteredRows, sankeySourceField, sankeyTargetField, sankeyValueField),
  );
  if (sankeyData.links.length === 0) {
    return <StudioNoDataOverlay height={chartHeight} />;
  }

  return (
    <StudioSankeyChart
      data={sankeyData}
      height={chartHeight}
      linkColor={config.sankeyLinkColor}
      showValues={config.sankeyShowValues}
      valueFormat={valueFieldDef?.format}
      currencyCode={valueFieldDef?.currencyCode}
    />
  );
}

// ── gantt ─────────────────────────────────────────────────────────────────────

function renderGantt(ctx: ChartRenderContext<'gantt'>): React.ReactElement {
  const { config, filteredRows, chartHeight } = ctx;
  const labelField = config.ganttLabelField ?? '';
  const startField = config.ganttStartField ?? '';
  const endField = config.ganttEndField ?? '';
  const colorField = config.ganttColorField;

  if (!labelField || !startField || !endField) {
    return (
      <ChartHintBox height={chartHeight}>
        {ctx.localeText.chartGanttRequiresFieldsHint}
      </ChartHintBox>
    );
  }

  const { items, categories } = cachedCompute(
    filteredRows,
    JSON.stringify(['gantt', labelField, startField, endField, colorField]),
    () => buildGanttItems(filteredRows, labelField, startField, endField, colorField),
  );

  return <StudioGanttChart items={items} height={chartHeight} categories={categories} />;
}

// ── gauge ─────────────────────────────────────────────────────────────────────

function renderGauge(ctx: ChartRenderContext<'gauge'>): React.ReactElement {
  const { config, filteredRows, chartHeight } = ctx;
  const gaugeValueField = config.yField;

  if (!gaugeValueField) {
    return (
      <ChartHintBox height={chartHeight}>{ctx.localeText.widgetConfigureGaugeHint}</ChartHintBox>
    );
  }

  const gaugeAggregation = config.yAggregation ?? 'sum';
  const gaugeValue = cachedCompute(
    filteredRows,
    JSON.stringify(['gauge', gaugeValueField, gaugeAggregation]),
    () => computeAggregate(filteredRows, gaugeValueField, gaugeAggregation),
  );

  return (
    <StudioGaugeChart
      value={gaugeValue}
      valueMin={config.gaugeMin ?? 0}
      valueMax={config.gaugeMax ?? 100}
      height={chartHeight}
      slotProps={ctx.slotProps?.gaugeChart}
    />
  );
}

/**
 * Chart-type registry — one entry per `StudioChartType`, giving compile-time
 * exhaustiveness (`satisfies Record<StudioChartType, ChartTypeDef>`) the same way
 * `BUILTIN_WIDGET_DEFS` does for `BuiltinStudioWidgetKind` and `chartTypeRegistry`
 * does for query-descriptor dispatch: adding a chart type without an entry here is
 * a compile error, not a silent runtime gap.
 *
 * `needsXField` / `runsSupportGuard` / `runsNoDataGuard` encode each type's exact
 * guard-order behavior from the pre-registry if-chain:
 *  - `gauge` is the only type that skips ALL three guards (it handles its own
 *    unconfigured state — see `renderGauge` — and dispatches before the shared
 *    chart-support / no-data checks).
 *  - `gantt` skips only the shared xField-required guard (it has its own
 *    label/start/end field guard inside `renderGantt`).
 *  - every other type requires xField and runs both shared guards. `mixed`'s
 *    exemption from the support guard is NOT encoded here — it is driven by the
 *    `isBlended` flag at the guard call site itself (`!isBlended && ...`), since
 *    `isBlended` can only be true for `mixed` but is a data-dependent condition,
 *    not a static per-type one.
 */
export const CHART_TYPE_DEFS = {
  bar: { needsXField: true, runsSupportGuard: true, runsNoDataGuard: true, render: renderBar },
  'bar-stacked': {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderBar,
  },
  'bar-100': {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderBar,
  },
  line: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderLineArea,
  },
  area: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderLineArea,
  },
  'area-stacked': {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderLineArea,
  },
  'area-100': {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderLineArea,
  },
  pie: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderPieDonut,
  },
  donut: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderPieDonut,
  },
  scatter: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderScatter,
  },
  mixed: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderMixed,
  },
  heatmap: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderHeatmap,
  },
  funnel: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderFunnel,
  },
  gantt: {
    needsXField: false,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderGantt,
  },
  sankey: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    render: renderSankey,
  },
  gauge: {
    needsXField: false,
    runsSupportGuard: false,
    runsNoDataGuard: false,
    render: renderGauge,
  },
} satisfies Record<StudioChartType, ChartTypeDef>;
