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
import { sanitizeFiniteNumber } from '../../../internals/cssValueValidation';
import { makeValueFormatter, resolveFieldDef } from './chartWidgetHelpers';

type HoverHighlightItem = HighlightItemIdentifier<'bar' | 'line' | 'pie'>;

// ── funnel presentation-enum allow-lists ───────────────────────────────────────
// `funnelCurve` / `funnelVariant` / `funnelLabelPlacement` are typed as literal unions but
// that type is NOT enforced at the load/AI-tool boundary. An unknown `curve`/`variant` string
// resolves to an undefined curve/shape factory deep in `@mui/x-charts-pro`'s FunnelChart, and a
// non-number `gap` produces NaN section geometry. Allow-list the enums (fall back to the chart's
// own default via `undefined`) and run `gap` through `sanitizeFiniteNumber`, mirroring the
// `SAFE_HEAT_SCHEMES` guard already used for the heatmap color scheme (finding).
type FunnelCurve = NonNullable<StudioChartConfigOfType<'funnel'>['funnelCurve']>;
type FunnelVariant = NonNullable<StudioChartConfigOfType<'funnel'>['funnelVariant']>;
type FunnelLabelPlacement = NonNullable<StudioChartConfigOfType<'funnel'>['funnelLabelPlacement']>;

const SAFE_FUNNEL_CURVES = new Set<FunnelCurve>(['linear', 'bump', 'step', 'pyramid']);
const SAFE_FUNNEL_VARIANTS = new Set<FunnelVariant>(['filled', 'outlined']);
const SAFE_FUNNEL_LABEL_PLACEMENTS = new Set<FunnelLabelPlacement>([
  'inside',
  'outside-start',
  'outside-end',
]);

// ── sankey presentation-enum allow-list ────────────────────────────────────────
// `sankeyLinkColor` is typed as this union but that type is NOT enforced at the
// load/AI-tool boundary either — same rationale as the funnel enums above. An
// unrecognized value would flow straight into `@mui/x-charts-pro`'s `SankeyChart`
// `series.linkOptions.color`, unlike every sibling chart family's doc-authored enum
// config value. Allow-list it (fall back to `StudioSankeyChart`'s own default via
// `undefined`), mirroring `SAFE_FUNNEL_*`/`SAFE_HEAT_SCHEMES`.
type SankeyLinkColor = NonNullable<StudioChartConfigOfType<'sankey'>['sankeyLinkColor']>;
const SAFE_SANKEY_LINK_COLORS = new Set<SankeyLinkColor>(['source', 'target']);

/** Returns `value` if it is a member of `allowed`, otherwise `undefined`. */
function sanitizeEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === 'string' && (allowed as ReadonlySet<string>).has(value)
    ? (value as T)
    : undefined;
}

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
  // The cross-filtered `chartData` can be legitimately empty while a ghost (the widget's
  // own un-cross-filtered `allChartData`) is available — bailing to `EmptyChartBox`
  // unconditionally here defeats the orchestrator's ghost-rendering guard in
  // `StudioChartWidget`, which already threads `allChartData` down for exactly this case.
  // Mirrors `StudioBarChart`'s own single-series ghost gate (`shouldShowGhost &&
  // allChartData && preserveXFieldBaseline`) so this bypass is only taken when the chart
  // itself will actually find a non-null baseline to render from.
  const hasGhostData =
    ctx.shouldShowGhost &&
    !!ctx.allChartData &&
    ctx.allChartData.labels.length > 0 &&
    ctx.preserveXFieldBaseline;

  if (!hasMultiY && !hasGhostData && (!chartData || chartData.labels.length === 0)) {
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

  // The cross-filtered `chartData` can be legitimately empty while a ghost (the widget's
  // own un-cross-filtered `allChartData`) is available — bailing to `EmptyChartBox`
  // unconditionally here defeats the orchestrator's ghost-rendering guard in
  // `StudioChartWidget`, which already threads `allChartData` down for exactly this case.
  // Mirrors `StudioPieChart`'s own `isPieHighlightActive` gate (`shouldShowGhost &&
  // allChartData && preserveXFieldBaseline`) so this bypass is only taken when the chart
  // itself will actually find a non-null baseline to render from.
  const hasGhostData =
    ctx.shouldShowGhost &&
    !!ctx.allChartData &&
    ctx.allChartData.labels.length > 0 &&
    ctx.preserveXFieldBaseline;

  if (!hasGhostData && (!chartData || chartData.labels.length === 0)) {
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
      // Read the fn from the SAME `ySeries` entry that supplied the ring's value field
      // (`activeYFields[0]`), not `ySeries[0]` unconditionally — `activeYFields` skips
      // fieldId-less/foreign entries, so an index-0 read can pair the wrong measure's fn with the
      // field (finding 2.6). `find` misses (→ `config.yAggregation`) when the value came from `yField`.
      yAggregation={
        config.ySeries?.find((s) => s.fieldId === ctx.activeYFields[0])?.yAggregation ??
        config.yAggregation
      }
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
  // The cross-filtered `chartData` can be legitimately empty while a ghost (the widget's
  // own un-cross-filtered `allChartData`) is available — bailing to `EmptyChartBox`
  // unconditionally here defeats the orchestrator's ghost-rendering guard in
  // `StudioChartWidget`, which already threads `allChartData` down for exactly this case.
  // Mirrors `StudioLineAreaChart`'s own single-series `ghostLineValues` gate
  // (`shouldShowGhost && allChartData && preserveXFieldBaseline`) so this bypass is only
  // taken when the chart itself will actually find a non-null baseline to render from.
  const hasGhostData =
    ctx.shouldShowGhost &&
    !!ctx.allChartData &&
    ctx.allChartData.labels.length > 0 &&
    ctx.preserveXFieldBaseline;

  if (!hasMultiY && !hasGhostData && (!chartData || chartData.labels.length === 0)) {
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
  // Mirror the `yField ?? ySeries[0].fieldId` fallback the scatter data memos use (finding 2.7)
  // so the y-axis label resolves for a chart authored via `ySeries` then switched to scatter.
  const scatterYField = config.yField ?? config.ySeries?.[0]?.fieldId;
  const xAxisLabel =
    resolveFieldDef(config.xField, ctx.dataSource, ctx.expressionFields)?.label ?? config.xField;
  const yAxisLabel =
    resolveFieldDef(scatterYField, ctx.dataSource, ctx.expressionFields)?.label ?? scatterYField;

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
      preserveXFieldBaseline={ctx.preserveXFieldBaseline}
      preserveSplitByBaseline={ctx.preserveSplitByBaseline}
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
      resolvedChartColors={ctx.resolvedChartColors}
      widgetSourceId={ctx.widgetSourceId}
      dataSources={ctx.dataSources}
      dataSource={ctx.dataSource}
      expressionFields={ctx.expressionFields}
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
  // Aggregate `enrichedRows` (L4-resolved: a cross-source extra dimension like a many-to-one
  // `heatYField` is enriched onto each row, and cross-filter mode is honoured because
  // `enrichedRows` derives from `effectiveRows`) rather than raw, un-enriched `filteredRows`
  // (findings 1.9 / 2.5).
  const { config, dataSource, expressionFields, enrichedRows, xGroupBy, chartHeight } = ctx;
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

  // `resolveFieldDef` (native fields + expression fields) so a calculated x/y axis field
  // gets its real label too (finding 3.2) — `orderedValues` is a native-field-only concept
  // (categorical sort override, not defined on `StudioExpressionField`), so it's still read
  // straight off `dataSource.fields`.
  const xFieldDef = resolveFieldDef(heatXField, dataSource, expressionFields);
  const yFieldDef = resolveFieldDef(heatYField, dataSource, expressionFields);
  const xOrderedValues = dataSource?.fields.find((f) => f.id === heatXField)?.orderedValues;
  const yOrderedValues = dataSource?.fields.find((f) => f.id === heatYField)?.orderedValues;
  const valueFieldDef = resolveFieldDef(heatValueField, dataSource, expressionFields);
  // Per-series aggregation wins over the yField-level default, mirroring the single-series/
  // multi-Y/split-by/blended/pie-ring precedence (finding 2.2) — the value field can survive
  // a chart-type switch via the `ySeries[0].fieldId` fallback above while its aggregation was
  // previously read only from `config.yAggregation`, silently dropping to 'sum'.
  // Tie the fn to the RESOLVED value field: when it came from `config.yField` use `config.yAggregation`;
  // only when it came from `ySeries[0].fieldId` use that entry's fn — otherwise a set `yField` (the
  // field) paired with a leftover `ySeries[0].yAggregation` (a DIFFERENT measure's fn) aggregates
  // `yField` with the wrong function (finding 2.6).
  const heatAggregation = config.yField
    ? (config.yAggregation ?? 'sum')
    : (config.ySeries?.[0]?.yAggregation ?? config.yAggregation ?? 'sum');
  const heatData = cachedCompute(
    enrichedRows,
    JSON.stringify([
      'heatmap',
      heatXField,
      heatYField,
      heatValueField,
      xGroupBy,
      heatAggregation,
      config.heatSortBy,
      config.heatSortDirection,
      xOrderedValues,
      yOrderedValues,
    ]),
    () =>
      aggregateHeatmap(
        enrichedRows,
        heatXField,
        heatYField,
        heatValueField,
        xGroupBy,
        heatAggregation,
        xOrderedValues,
        yOrderedValues,
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
  // Aggregate `enrichedRows` (L4-resolved cross-source `funnelReachedField` + cross-filter-mode
  // aware) rather than raw `filteredRows` (findings 1.9 / 2.5).
  const { config, dataSource, expressionFields, enrichedRows, chartHeight } = ctx;
  const funnelXField = config.xField ?? '';
  const funnelValueField = config.yField ?? config.ySeries?.[0]?.fieldId ?? '';

  if (!funnelXField || !funnelValueField) {
    return (
      <ChartHintBox height={chartHeight}>
        {ctx.localeText.chartFunnelRequiresFieldsHint}
      </ChartHintBox>
    );
  }

  // `resolveFieldDef` so a calculated value field (offered by the panel) keeps its real
  // currency/precision formatting instead of losing it to a native-only lookup (finding 3.2).
  const valueFieldDef = resolveFieldDef(funnelValueField, dataSource, expressionFields);
  // Per-series aggregation wins over the yField-level default (finding 2.2) — same precedence
  // fix as the heatmap above, for the same config-key-retention-across-type-switch reason. Tie
  // the fn to the RESOLVED value field so a set `yField` doesn't inherit a leftover
  // `ySeries[0].yAggregation` from a different measure (finding 2.6).
  const funnelAggregation = config.yField
    ? (config.yAggregation ?? 'sum')
    : (config.ySeries?.[0]?.yAggregation ?? config.yAggregation ?? 'sum');

  // Sanitize the doc-authored presentation enums/number before forwarding — an unknown
  // curve/variant resolves an undefined factory in the underlying FunnelChart, and a non-number
  // gap produces NaN geometry. `undefined` falls back to `StudioFunnelChart`'s own defaults.
  const funnelGap = sanitizeFiniteNumber(config.funnelGap, 0);
  const funnelCurve = sanitizeEnum(config.funnelCurve, SAFE_FUNNEL_CURVES);
  const funnelVariant = sanitizeEnum(config.funnelVariant, SAFE_FUNNEL_VARIANTS);
  const funnelLabelPlacementSafe = sanitizeEnum(
    config.funnelLabelPlacement,
    SAFE_FUNNEL_LABEL_PLACEMENTS,
  );

  // Cumulative "reached stage" mode: count deals whose reached-depth is at or
  // beyond each stage → monotonically non-increasing by construction (never
  // > 100%). The terminal exit stage (e.g. Closed Lost) is excluded from the
  // sequential math and reported separately. Opt-in via `funnelReachedField`.
  if (config.funnelReachedField && config.funnelStageSequence) {
    const reached = cachedCompute(
      enrichedRows,
      JSON.stringify([
        'funnelReached',
        funnelXField,
        config.funnelReachedField,
        config.funnelStageSequence,
      ]),
      () =>
        aggregateFunnelReached(
          enrichedRows,
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
        labelPlacement={funnelLabelPlacementSafe}
        gap={funnelGap}
        curve={funnelCurve}
        variant={funnelVariant}
      />
    );
  }

  const fieldOrderedValues = dataSource?.fields.find((f) => f.id === funnelXField)?.orderedValues;
  const { stages, sort } = cachedCompute(
    enrichedRows,
    JSON.stringify([
      'funnelStages',
      funnelXField,
      funnelValueField,
      funnelAggregation,
      config.chartSortBy,
      config.funnelCategoryOrder,
      fieldOrderedValues,
    ]),
    () =>
      buildFunnelStages(
        enrichedRows,
        funnelXField,
        funnelValueField,
        funnelAggregation,
        config.chartSortBy,
        config.funnelCategoryOrder,
        fieldOrderedValues,
      ),
  );

  // Auto-default label placement to outside-end when conversion format is chosen.
  const funnelLabelFormat = config.funnelLabelFormat ?? 'value';
  const funnelLabelPlacement =
    funnelLabelPlacementSafe ?? (funnelLabelFormat === 'conversion' ? 'outside-end' : 'inside');

  return (
    <StudioFunnelChart
      stages={stages}
      height={chartHeight}
      valueFormat={valueFieldDef?.format}
      currencyCode={valueFieldDef?.currencyCode}
      labelFormat={funnelLabelFormat}
      labelPlacement={funnelLabelPlacement}
      gap={funnelGap}
      curve={funnelCurve}
      variant={funnelVariant}
      sort={sort}
    />
  );
}

// ── sankey ────────────────────────────────────────────────────────────────────

function renderSankey(ctx: ChartRenderContext<'sankey'>): React.ReactElement {
  // Aggregate `enrichedRows` (L4-resolved cross-source `sankeyTargetField` + cross-filter-mode
  // aware) rather than raw `filteredRows` (findings 1.9 / 2.5).
  const { config, dataSource, expressionFields, enrichedRows, chartHeight } = ctx;
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

  // `resolveFieldDef` so a calculated link-weight field keeps its real currency/precision
  // formatting instead of losing it to a native-only lookup (finding 3.2).
  const valueFieldDef = resolveFieldDef(sankeyValueField, dataSource, expressionFields);
  const sankeyData = cachedCompute(
    enrichedRows,
    JSON.stringify(['sankey', sankeySourceField, sankeyTargetField, sankeyValueField]),
    () => aggregateSankey(enrichedRows, sankeySourceField, sankeyTargetField, sankeyValueField),
  );
  if (sankeyData.links.length === 0) {
    return <StudioNoDataOverlay height={chartHeight} />;
  }

  return (
    <StudioSankeyChart
      data={sankeyData}
      height={chartHeight}
      linkColor={sanitizeEnum(config.sankeyLinkColor, SAFE_SANKEY_LINK_COLORS)}
      showValues={config.sankeyShowValues}
      valueFormat={valueFieldDef?.format}
      currencyCode={valueFieldDef?.currencyCode}
    />
  );
}

// ── gantt ─────────────────────────────────────────────────────────────────────

function renderGantt(ctx: ChartRenderContext<'gantt'>): React.ReactElement {
  // Aggregate `enrichedRows` (L4-resolved cross-source `gantt*` fields + cross-filter-mode
  // aware) rather than raw `filteredRows` (findings 1.9 / 2.5).
  const { config, enrichedRows, chartHeight } = ctx;
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
    enrichedRows,
    JSON.stringify(['gantt', labelField, startField, endField, colorField]),
    () => buildGanttItems(enrichedRows, labelField, startField, endField, colorField),
  );

  return <StudioGanttChart items={items} height={chartHeight} categories={categories} />;
}

// ── gauge ─────────────────────────────────────────────────────────────────────

function renderGauge(ctx: ChartRenderContext<'gauge'>): React.ReactElement {
  // Aggregate `enrichedRows` (cross-filter-mode aware via `effectiveRows`) rather than raw
  // `filteredRows`, so a `'none'`-mode gauge doesn't react to sibling cross-filters (finding 2.5).
  const { config, enrichedRows, chartHeight } = ctx;
  // Mirror the `yField ?? ySeries[0].fieldId` fallback + per-series aggregation precedence every
  // sibling family (heatmap/funnel/sankey) has, so a chart authored via `ySeries` then switched to
  // gauge still resolves its measure instead of showing "configure gauge" (finding 2.7). The fn is
  // tied to the resolved field: `config.yAggregation` when it came from `yField`, else the
  // `ySeries[0]` entry's fn (finding 2.6). `ySeries` is retained at runtime across a chart-type
  // switch but isn't on the narrowed `StudioGaugeChartConfig`, so read it through the flat patch type.
  const gaugeYSeries = (config as StudioChartConfig).ySeries;
  const gaugeValueField = config.yField ?? gaugeYSeries?.[0]?.fieldId;

  if (!gaugeValueField) {
    return (
      <ChartHintBox height={chartHeight}>{ctx.localeText.widgetConfigureGaugeHint}</ChartHintBox>
    );
  }

  const gaugeAggregation = config.yField
    ? (config.yAggregation ?? 'sum')
    : (gaugeYSeries?.[0]?.yAggregation ?? config.yAggregation ?? 'sum');
  const gaugeValue = cachedCompute(
    enrichedRows,
    JSON.stringify(['gauge', gaugeValueField, gaugeAggregation]),
    () => computeAggregate(enrichedRows, gaugeValueField, gaugeAggregation),
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
