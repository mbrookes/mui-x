'use client';

import * as React from 'react';
import type { BarChartProps } from '@mui/x-charts/BarChart';
import type { LineChartProps } from '@mui/x-charts/LineChart';
import type { PieChartProps } from '@mui/x-charts/PieChart';
import type { ScatterChartProps } from '@mui/x-charts/ScatterChart';
import type { GaugeProps } from '@mui/x-charts/Gauge';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box, Typography } from '@mui/material';

import type { StudioChartType, StudioBarLayout } from '@mui/x-studio-core/models';
import type {
  AggregatedData,
  MultiSeriesData,
  MultiYSeriesData,
  ScatterDataPoint,
  ScatterSeriesData,
  StudioLocaleText,
} from '@mui/x-studio-core/engine';
import {
  aggregateFunnelReached,
  aggregateHeatmap,
  aggregateSankey,
  buildFunnelStages,
  buildGanttItems,
  cachedCompute,
  findMeasureExpressionField,
  resolveMeasureAggregate,
  computeAggregate,
  sanitizeFiniteNumber,
} from '@mui/x-studio-core/engine';
import { lookup } from '@mui/x-studio-core/utils';
import type {
  StudioChartConfig,
  StudioChartConfigOfType,
  StudioDataField,
  StudioDataSource,
  StudioExpressionField,
  StudioSharedWidgetConfig,
} from '../../../models';
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
  /**
   * Accessible name for the rendered chart — the widget's own (or inferred) title, e.g. "Revenue by
   * Region". Forwarded to each family's `title` prop (or, for the families whose underlying
   * x-charts component does not thread `title` through, to an `aria-label` on a wrapper), so the
   * chart is not an unnamed graphic (WCAG 1.1.1 / 4.1.2).
   */
  chartAriaTitle: string;
  /**
   * Whether the widget's adapter-backed source has a fetch in flight whose rows have not
   * arrived yet.
   *
   * The orchestrator uses this to suppress the shared no-data guard (an in-flight query is
   * not "no data"), but it never used to reach the renderers — so every render
   * function that owns its OWN empty-result branch had to interpret an empty aggregation as a
   * settled result. That produced two distinct wrong states during a cold fetch: `renderMixed`
   * blamed the author ("configure your fields") for a query that simply had not answered yet,
   * and `renderFunnel`/`renderGantt`/`renderSankey` asserted "No data" about a dataset nobody
   * had looked at. Renderers must treat an empty result as *unmeasured* while this is true —
   * the same "null means not measured" rule the aggregation layer follows.
   */
  isLoading: boolean;
}

/** Descriptor for a single `StudioChartType`'s guard-order behavior and rendering. */
export interface ChartTypeDef<T extends StudioChartType = StudioChartType> {
  /** Whether the shared "chart not configured" guard requires `config.xField`. */
  needsXField: boolean;
  /** Whether the shared chart-support (`analyzeChartSupport`) guard applies to this type. */
  runsSupportGuard: boolean;
  /** Whether the shared "no rows after filtering" guard applies to this type. */
  runsNoDataGuard: boolean;
  /**
   * Whether this type's renderer forwards `ctx.onItemClick`, i.e. whether clicking the chart can
   * EMIT a cross-filter to its sibling widgets.
   *
   * Only `renderBar`, `renderPieDonut` and `renderLineArea` do. The remaining seven families
   * (scatter, mixed, heatmap, funnel, sankey, gantt, gauge) receive `onItemClick` in their render
   * context and drop it, so no click of theirs ever reaches `applyCrossFilter`. Declared here so
   * a new chart type has to answer the question, and so the assertion is testable against the
   * registry rather than re-derived by reading nine render functions.
   */
  emitsCrossFilter: boolean;
  /**
   * Whether this type can render the cross-highlight GHOST — the dimmed un-cross-filtered
   * baseline behind the highlighted set — i.e. whether it reads `ctx.shouldShowGhost` /
   * `ctx.all*` at all.
   *
   * This is what makes `'cross-highlight'` mean something different from `'cross-filter'`. Bar,
   * pie/donut, line/area and scatter honour it. Mixed, heatmap, funnel, sankey, gantt and gauge
   * do NOT: they aggregate `ctx.enrichedRows`, which in `'cross-highlight'` mode already IS the
   * cross-filtered row set, so they silently re-aggregate to the filtered subset — behaviour
   * identical to `'cross-filter'`, except the colour scale/axis rebases too. Setting a heatmap to
   * "Highlight" and clicking a sibling bar produced exactly the same picture as "Filter", with
   * two buttons claiming to do different things.
   *
   * `ChartSetupPanel` derives the Interactions control's offered modes from this flag, so a
   * family that cannot highlight no longer advertises that it can (HIGH 5).
   */
  supportsGhost: boolean;
  // Declared as a METHOD (not an arrow property) so its `ctx` parameter is checked
  // bivariantly: this lets a family-narrow renderer (e.g. `renderBar`, typed for
  // `ChartRenderContext<'bar' | …>`) satisfy `Record<StudioChartType, ChartTypeDef>`
  // in `CHART_TYPE_DEFS` below, which a contravariant arrow property would reject.
  render(ctx: ChartRenderContext<T>): React.ReactElement;
}

/**
 * A centered hint message shown in place of the chart (unconfigured / needs-fields state).
 *
 * `role="status"` (an implicit polite live region) matches `StudioNoDataOverlay` and
 * `StudioWidgetErrorOverlay`: these hints replace the chart in response to a config edit or a
 * cross-filter, so a screen-reader user who changes a field and lands on a hint instead of a
 * chart got no announcement at all, while a sighted user sees the message immediately.
 */
function ChartHintBox({ height, children }: { height: number; children: React.ReactNode }) {
  return (
    <Box
      role="status"
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

/**
 * The element every renderer returns when it has no aggregated data to draw. The single place
 * this file decides what "nothing to draw" looks like.
 *
 * `isLoading: false` → `StudioNoDataOverlay`, the labelled, announced overlay the
 * funnel/sankey/gantt branches already used. The bar/line/pie branches used to return an empty
 * `<Box>` here instead — a blank rectangle that explained nothing to anyone, sighted or not,
 * for the exact condition their siblings explained.
 *
 * `isLoading: true` → a deliberately blank box. An unanswered query is not "No data", and
 * asserting so mid-fetch is the same fabrication the gauge's `0` was. It carries an empty
 * polite live region so nothing is announced until the rows land and the chart (or the
 * overlay) takes its place.
 *
 * A plain function, not a component: it keeps `render()`'s returned element type equal to what
 * is actually shown (`StudioNoDataOverlay`), rather than an opaque wrapper, which is what both
 * the tests and a reader of a React tree want to see.
 */
function renderEmptyChart(height: number, isLoading: boolean): React.ReactElement {
  if (isLoading) {
    return (
      <Box
        role="status"
        aria-busy
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height }}
      />
    );
  }
  return <StudioNoDataOverlay height={height} />;
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
  // own un-cross-filtered `allChartData`) is available — bailing to `renderEmptyChart`
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
    return renderEmptyChart(chartHeight, ctx.isLoading);
  }

  return (
    <StudioBarChart
      chartType={chartType}
      height={chartHeight}
      ariaTitle={ctx.chartAriaTitle}
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
  // own un-cross-filtered `allChartData`) is available — bailing to `renderEmptyChart`
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
    return renderEmptyChart(chartHeight, ctx.isLoading);
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
      ariaTitle={ctx.chartAriaTitle}
      chartData={chartData}
      allChartData={ctx.allChartData}
      enrichedRows={ctx.enrichedRows}
      allEnrichedRows={ctx.allEnrichedRows}
      seriesField={config.seriesField}
      xField={config.xField}
      yField={config.yField}
      activeYFields={ctx.activeYFields}
      // Mirror `useChartWidgetData`'s single-ring precedence (per-series fn wins over the
      // yField-level default) so grouped rings honour the configured aggregation.
      // Read the fn from the SAME `ySeries` entry that supplied the ring's value field
      // (`activeYFields[0]`), not `ySeries[0]` unconditionally — `activeYFields` skips
      // fieldId-less/foreign entries, so an index-0 read can pair the wrong measure's fn with the
      // field. `find` misses (→ `config.yAggregation`) when the value came from `yField`.
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
  // that was dead code while this guard fell straight through to `renderEmptyChart`.
  const hasMultiY = !!multiYData && multiYData.labels.length > 0;
  // The cross-filtered `chartData` can be legitimately empty while a ghost (the widget's
  // own un-cross-filtered `allChartData`) is available — bailing to `renderEmptyChart`
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
    return renderEmptyChart(chartHeight, ctx.isLoading);
  }

  return (
    <StudioLineAreaChart
      chartType={chartType}
      height={chartHeight}
      ariaTitle={ctx.chartAriaTitle}
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
  // Mirror the `yField ?? ySeries[0].fieldId` fallback the scatter data memos use
  // so the y-axis label resolves for a chart authored via `ySeries` then switched to scatter.
  const scatterYField = config.yField ?? config.ySeries?.[0]?.fieldId;
  const xFieldDef = resolveFieldDef(config.xField, ctx.dataSource, ctx.expressionFields);
  const yFieldDef = resolveFieldDef(scatterYField, ctx.dataSource, ctx.expressionFields);
  const xAxisLabel = xFieldDef?.label ?? config.xField;
  const yAxisLabel = yFieldDef?.label ?? scatterYField;
  // Scatter was the ONE chart family that rendered its measures completely unformatted: every
  // sibling (bar, line/area, pie, heatmap, funnel, sankey, gauge, mixed) builds a
  // `makeValueFormatter` from the field's own `format`/`currencyCode`/`precision`, so a currency
  // measure read `€1,234.50` there and a bare `1234.5` on the scatter beside it — same field,
  // same dashboard, two renderings (MEDIUM 7). `noFormatFallback: 'undefined'` leaves an
  // unformatted field to the ScatterChart's own default rather than forcing a bare
  // `String(value)`, matching `renderGauge`'s use of the same option.
  const scatterXValueFormatter = makeValueFormatter(
    xFieldDef?.format,
    xFieldDef?.currencyCode,
    xFieldDef?.precision,
    { noFormatFallback: 'undefined' },
  );
  const scatterYValueFormatter = makeValueFormatter(
    yFieldDef?.format,
    yFieldDef?.currencyCode,
    yFieldDef?.precision,
    { noFormatFallback: 'undefined' },
  );

  return (
    <StudioScatterChart
      height={ctx.chartHeight}
      ariaTitle={ctx.chartAriaTitle}
      colorField={config.scatterColorField}
      sizeField={config.scatterSizeField}
      minRadius={config.scatterMinRadius}
      maxRadius={config.scatterMaxRadius}
      xValueFormatter={scatterXValueFormatter}
      yValueFormatter={scatterYValueFormatter}
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
    // An in-flight fetch is not a misconfiguration. This was the only empty-data branch in the
    // file that blamed the AUTHOR, so a correctly-configured mixed chart on a slow adapter
    // told the user its fields were missing until the rows landed.
    if (ctx.isLoading) {
      return renderEmptyChart(chartHeight, true);
    }
    return (
      <ChartHintBox height={chartHeight}>
        {ctx.localeText.chartMixedRequiresFieldsHint}
      </ChartHintBox>
    );
  }

  return (
    <StudioMixedChart
      multiYData={multiYData}
      ariaTitle={ctx.chartAriaTitle}
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

/**
 * Cache-key fragment covering the FORMULA of `fieldId` when it is a measure expression field
 * (`''` when it is not).
 *
 * A measure is never enriched onto a row, so editing its expression leaves `enrichedRows`
 * reference-identical while changing every number derived from it. `cachedCompute` keys on the
 * rows reference plus a string, so without this fragment a heatmap / funnel / sankey / gauge over
 * a measure would keep serving the pre-edit result forever. Mirrors `useChartWidgetData`'s
 * `measureFieldsKey`, scoped to the one field each of these renderers aggregates.
 */
function measureFormulaCacheKey(
  fieldId: string,
  expressionFields: StudioExpressionField[],
): string {
  const measure = findMeasureExpressionField(fieldId, expressionFields);
  return measure ? JSON.stringify(measure.expression) : '';
}

// ── heatmap ───────────────────────────────────────────────────────────────────

function renderHeatmap(ctx: ChartRenderContext<'heatmap'>): React.ReactElement {
  // Aggregate `enrichedRows` (resolved: a cross-source extra dimension like a many-to-one
  // `heatYField` is enriched onto each row, and cross-filter mode is honoured because
  // `enrichedRows` derives from `effectiveRows`) rather than raw, un-enriched `filteredRows`.
  //
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
  // gets its real label too — `orderedValues` is a native-field-only concept
  // (categorical sort override, not defined on `StudioExpressionField`), so it's still read
  // straight off `dataSource.fields`.
  const xFieldDef = resolveFieldDef(heatXField, dataSource, expressionFields);
  const yFieldDef = resolveFieldDef(heatYField, dataSource, expressionFields);
  const xOrderedValues = dataSource?.fields.find((f) => f.id === heatXField)?.orderedValues;
  const yOrderedValues = dataSource?.fields.find((f) => f.id === heatYField)?.orderedValues;
  const valueFieldDef = resolveFieldDef(heatValueField, dataSource, expressionFields);
  // Per-series aggregation wins over the yField-level default, mirroring the single-series/
  // multi-Y/split-by/blended/pie-ring precedence — the value field can survive
  // a chart-type switch via the `ySeries[0].fieldId` fallback above while its aggregation was
  // previously read only from `config.yAggregation`, silently dropping to 'sum'.
  // Tie the fn to the RESOLVED value field: when it came from `config.yField` use `config.yAggregation`;
  // only when it came from `ySeries[0].fieldId` use that entry's fn — otherwise a set `yField` (the
  // field) paired with a leftover `ySeries[0].yAggregation` (a DIFFERENT measure's fn) aggregates
  // `yField` with the wrong function.
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
      measureFormulaCacheKey(heatValueField, expressionFields),
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
        expressionFields,
      ),
  );
  // Empty post-aggregation result — every row dropped for an empty x (or an empty y) value, so
  // there is no grid to draw. Without this the heatmap rendered bare, labelless axes: a blank
  // rectangle that explains nothing, for exactly the condition `renderFunnel`/`renderSankey`/
  // `renderGantt` all surface through `renderEmptyChart`. It was the last post-aggregation
  // emptiness hole in this file (MEDIUM 7).
  if (heatData.xLabels.length === 0 || heatData.yLabels.length === 0) {
    return renderEmptyChart(chartHeight, ctx.isLoading);
  }

  const heatFormatDef = valueFieldDef?.type
    ? (valueFieldDef as Pick<StudioDataField, 'type' | 'format' | 'currencyCode' | 'precision'>)
    : undefined;

  return (
    <StudioHeatmapChart
      height={chartHeight}
      ariaTitle={ctx.chartAriaTitle}
      heatData={heatData}
      xFieldLabel={xFieldDef?.label}
      yFieldLabel={yFieldDef?.label}
      valueFieldDef={heatFormatDef}
      // The heatmap's x labels come out of `applyXGroupBy` as internal period keys, so they need
      // the same `formatLabel` pass the bar/line/mixed axes get — otherwise the same field with
      // the same grouping reads "2024-01" here and "Jan 2024" on the chart beside it.
      formatLabel={ctx.formatLabel}
      colorScheme={config.heatColorScheme ?? 'primary'}
      legendPosition={config.heatLegendPosition ?? 'bottom'}
      legendAlign={config.heatLegendAlign ?? 'center'}
    />
  );
}

// ── funnel ────────────────────────────────────────────────────────────────────

function renderFunnel(ctx: ChartRenderContext<'funnel'>): React.ReactElement {
  // Aggregate `enrichedRows` (resolved cross-source `funnelReachedField` + cross-filter-mode aware)
  // rather than raw `filteredRows`.
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
  // currency/precision formatting instead of losing it to a native-only lookup.
  const valueFieldDef = resolveFieldDef(funnelValueField, dataSource, expressionFields);
  // Per-series aggregation wins over the yField-level default — same precedence
  // fix as the heatmap above, for the same config-key-retention-across-type-switch reason. Tie
  // the fn to the RESOLVED value field so a set `yField` doesn't inherit a leftover
  // `ySeries[0].yAggregation` from a different measure.
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

    if (reached.stages.length === 0) {
      return renderEmptyChart(chartHeight, ctx.isLoading);
    }

    return (
      <StudioFunnelChart
        stages={reached.stages.map((s) => ({ label: s.label, value: s.value }))}
        height={chartHeight}
        ariaTitle={ctx.chartAriaTitle}
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
      measureFormulaCacheKey(funnelValueField, expressionFields),
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
        expressionFields,
      ),
  );

  // Auto-default label placement to outside-end when conversion format is chosen.
  const funnelLabelFormat = config.funnelLabelFormat ?? 'value';
  const funnelLabelPlacement =
    funnelLabelPlacementSafe ?? (funnelLabelFormat === 'conversion' ? 'outside-end' : 'inside');

  // Empty post-aggregation result — surface the shared "no data" overlay, the same as
  // `renderSankey` below. `StudioFunnelChart` also bails on an empty stage list, but it
  // returns `null`, which renders a silently blank widget body with no explanation.
  if (stages.length === 0) {
    return renderEmptyChart(chartHeight, ctx.isLoading);
  }

  return (
    <StudioFunnelChart
      stages={stages}
      height={chartHeight}
      ariaTitle={ctx.chartAriaTitle}
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
  // Aggregate `enrichedRows` (resolved cross-source `sankeyTargetField` + cross-filter-mode aware)
  // rather than raw `filteredRows`.
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
  // formatting instead of losing it to a native-only lookup.
  const valueFieldDef = resolveFieldDef(sankeyValueField, dataSource, expressionFields);
  const sankeyData = cachedCompute(
    enrichedRows,
    JSON.stringify([
      'sankey',
      sankeySourceField,
      sankeyTargetField,
      sankeyValueField,
      measureFormulaCacheKey(sankeyValueField, expressionFields),
    ]),
    () =>
      aggregateSankey(
        enrichedRows,
        sankeySourceField,
        sankeyTargetField,
        sankeyValueField,
        expressionFields,
      ),
  );
  if (sankeyData.links.length === 0) {
    return renderEmptyChart(chartHeight, ctx.isLoading);
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
  // Aggregate `enrichedRows` (resolved cross-source `gantt*` fields + cross-filter-mode aware)
  // rather than raw `filteredRows`.
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

  // Empty post-aggregation result (e.g. every row has an unparseable start/end date) —
  // surface the shared "no data" overlay, the same as `renderSankey`/`renderFunnel`.
  // `StudioGanttChart` also bails on an empty item list, but it returns `null`, which
  // renders a silently blank widget body with no explanation.
  if (items.length === 0) {
    return renderEmptyChart(chartHeight, ctx.isLoading);
  }

  return <StudioGanttChart items={items} height={chartHeight} categories={categories} />;
}

// ── gauge ─────────────────────────────────────────────────────────────────────

function renderGauge(ctx: ChartRenderContext<'gauge'>): React.ReactElement {
  // Aggregate `enrichedRows` (cross-filter-mode aware via `effectiveRows`) rather than raw
  // `filteredRows`, so a `'none'`-mode gauge doesn't react to sibling cross-filters.
  const { config, dataSource, expressionFields, enrichedRows, chartHeight } = ctx;
  // Mirror the `yField ?? ySeries[0].fieldId` fallback + per-series aggregation precedence every
  // sibling family (heatmap/funnel/sankey) has, so a chart authored via `ySeries` then switched to
  // gauge still resolves its measure instead of showing "configure gauge". The fn is
  // tied to the resolved field: `config.yAggregation` when it came from `yField`, else the
  // `ySeries[0]` entry's fn. `ySeries` is retained at runtime across a chart-type
  // switch but isn't on the narrowed `StudioGaugeChartConfig`, so read it through the flat patch type.
  const gaugeYSeries = (config as StudioChartConfig).ySeries;
  const gaugeValueField = config.yField ?? gaugeYSeries?.[0]?.fieldId;

  if (!gaugeValueField) {
    return (
      <ChartHintBox height={chartHeight}>{ctx.localeText.widgetConfigureGaugeHint}</ChartHintBox>
    );
  }

  // A gauge over zero rows must not fabricate a reading. `computeAggregate` returns `0` — not
  // `null` — for `sum`/`count` over an empty set, so the `gaugeValue === null` bail below never
  // fired for those two: the needle sat at the minimum with a confidently formatted `0` in the
  // centre, a real and wrong number. This is the only chart type in this file that could do
  // that; every sibling family bails to `renderEmptyChart`, a hint, or the no-data overlay. It was
  // worst on an adapter-backed source, where the `0` was on screen through the entire cold
  // fetch while a bar chart in the identical state rendered blank.
  //
  // Guarded HERE rather than by flipping the registry's `runsNoDataGuard` to `true`, so the
  // "configure gauge" hint above still wins for an unconfigured gauge — the shared guard runs
  // before `render` and would otherwise claim "No data" about a gauge that has no measure to
  // measure. `renderEmptyChart` resolves the loading/settled distinction: an unanswered query is
  // not "No data" either.
  if (enrichedRows.length === 0) {
    return renderEmptyChart(chartHeight, ctx.isLoading);
  }

  const gaugeAggregation = config.yField
    ? (config.yAggregation ?? 'sum')
    : (gaugeYSeries?.[0]?.yAggregation ?? config.yAggregation ?? 'sum');
  // A MEASURE expression field (`isMeasure: true`) has no per-row value at all —
  // `enrichRowsWithExpressions` deliberately skips measures, so `row[measureId]` is `undefined`
  // on every row. Handing it to `computeAggregate` reduced a list of `undefined`s: `sum`/`count`
  // returned a confident `0` (or the row count), and `avg`/`min`/`max` returned `null`. So a
  // gauge on `avg_order = sum(total)/count()` pointed its needle at the bottom of the range with
  // a formatted `0` in the centre while the KPI card beside it, over the same measure and the
  // same rows, showed the right number. Route measures through the shared
  // `resolveMeasureAggregate` — the same entry point the KPI, the pivot and all three chart
  // aggregators use — so one measure has one value wherever it is placed. It returns `null`
  // (never `0`) when the measure cannot be evaluated, which the existing bail below renders as
  // "no data". A measure's own expression defines its aggregation, so `gaugeAggregation` does
  // not apply to it (matching `aggregateByField`, which likewise ignores the configured fn for a
  // measure y field).
  const gaugeMeasure = findMeasureExpressionField(gaugeValueField, expressionFields);
  const gaugeValue = cachedCompute(
    enrichedRows,
    JSON.stringify([
      'gauge',
      gaugeValueField,
      gaugeMeasure ? 'measure' : gaugeAggregation,
      // The measure's own formula is part of the result — see `measureFormulaCacheKey`.
      measureFormulaCacheKey(gaugeValueField, expressionFields),
    ]),
    () =>
      gaugeMeasure
        ? resolveMeasureAggregate(enrichedRows, gaugeValueField, expressionFields)
        : computeAggregate(enrichedRows, gaugeValueField, gaugeAggregation),
  );

  // `null` = the gauge's measure had no measurable data (all-null avg/min/max). Rendering
  // it as `0` would point the needle at the bottom of the range as if that were measured —
  // the same fabrication the aggregation layer was fixed to stop. Show "no data" instead.
  if (gaugeValue === null) {
    return renderEmptyChart(chartHeight, ctx.isLoading);
  }

  // The arc's centre number is the gauge's whole payload, so it must carry the measure's own
  // format — `resolveFieldDef` (native + expression fields) then the shared formatter, exactly
  // like the KPI card on the same measure. An unformatted field must still get a formatter:
  // omitting one hands the centre number to `GaugeValueText`'s `value.toLocaleString()`
  // default, which passes NO locale argument and so renders the BROWSER's locale rather than
  // `<Studio locale>`. `noFormatFallback: 'localized'` keeps the arc and the KPI card in
  // agreement on both the locale and the digit count.
  const gaugeFieldDef = resolveFieldDef(gaugeValueField, dataSource, expressionFields);
  const gaugeValueFormatter = makeValueFormatter(
    gaugeFieldDef?.format,
    gaugeFieldDef?.currencyCode,
    gaugeFieldDef?.precision,
    { noFormatFallback: 'localized' },
  );

  return (
    <StudioGaugeChart
      value={gaugeValue}
      valueMin={config.gaugeMin ?? 0}
      valueMax={config.gaugeMax ?? 100}
      height={chartHeight}
      // Every sibling family names its graphic; the gauge was the only one rendering an
      // unnamed one (WCAG 1.1.1 / 4.1.2).
      ariaTitle={ctx.chartAriaTitle}
      valueFormatter={gaugeValueFormatter}
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
 *  - `gauge` skips the xField-required and no-data guards (it handles its own
 *    unconfigured state — see `renderGauge`) but DOES run the shared chart-support
 *    guard, so an unresolvable measure surfaces the "unsupported field" overlay
 *    rather than rendering a confident `0` over zero rows.
 *  - `gantt` skips only the shared xField-required guard (it has its own
 *    label/start/end field guard inside `renderGantt`).
 *  - every other type requires xField and runs both shared guards. `mixed`'s
 *    exemption from the support guard is NOT encoded here — it is driven by the
 *    `isBlended` flag at the guard call site itself (`!isBlended && ...`), since
 *    `isBlended` can only be true for `mixed` but is a data-dependent condition,
 *    not a static per-type one.
 */
export const CHART_TYPE_DEFS = {
  bar: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: true,
    supportsGhost: true,
    render: renderBar,
  },
  'bar-stacked': {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: true,
    supportsGhost: true,
    render: renderBar,
  },
  'bar-100': {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: true,
    supportsGhost: true,
    render: renderBar,
  },
  line: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: true,
    supportsGhost: true,
    render: renderLineArea,
  },
  area: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: true,
    supportsGhost: true,
    render: renderLineArea,
  },
  'area-stacked': {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: true,
    supportsGhost: true,
    render: renderLineArea,
  },
  'area-100': {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: true,
    supportsGhost: true,
    render: renderLineArea,
  },
  pie: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: true,
    supportsGhost: true,
    render: renderPieDonut,
  },
  donut: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: true,
    supportsGhost: true,
    render: renderPieDonut,
  },
  scatter: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    // `renderScatter` drops `ctx.onItemClick` — a scatter point click emits nothing.
    emitsCrossFilter: false,
    // …but `StudioScatterChart` DOES honour `shouldShowGhost`, drawing the un-cross-filtered
    // points dimmed behind the highlighted set, so "Highlight" is a real, distinct mode here.
    supportsGhost: true,
    render: renderScatter,
  },
  mixed: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: false,
    // `renderMixed` reads only `multiYData` (derived from the cross-filtered `enrichedRows`) and
    // never `ctx.all*` / `ctx.shouldShowGhost`, so "Highlight" would behave as a hard filter.
    supportsGhost: false,
    render: renderMixed,
  },
  heatmap: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: false,
    // `renderHeatmap` aggregates `enrichedRows` — already the cross-filtered set — so a
    // "Highlight" heatmap re-aggregates AND rebases its colour scale, indistinguishable from
    // "Filter" (HIGH 5's worked example).
    supportsGhost: false,
    render: renderHeatmap,
  },
  funnel: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: false,
    supportsGhost: false,
    render: renderFunnel,
  },
  gantt: {
    needsXField: false,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: false,
    supportsGhost: false,
    render: renderGantt,
  },
  sankey: {
    needsXField: true,
    runsSupportGuard: true,
    runsNoDataGuard: true,
    emitsCrossFilter: false,
    supportsGhost: false,
    render: renderSankey,
  },
  gauge: {
    needsXField: false,
    // Runs the shared support guard like every other family. It used to skip it, which meant
    // an unresolvable measure (a field removed from the source, or one reachable only through
    // an unsupported multi-hop topology) produced no "unsupported field" overlay at all:
    // `useChartRows` short-circuits to `[]` for an unsupported configuration, the gauge
    // aggregated nothing, and it rendered a confident `0` — a real, wrong number — where a bar
    // chart with the identical misconfiguration explains the problem.
    // `analyzeChartSupport` short-circuits to `supported: true` when no fields are requested,
    // so a gauge with no measure at all still reaches `renderGauge`'s own "configure" hint.
    runsSupportGuard: true,
    // Still `false`, but no longer a hole: `renderGauge` runs its OWN zero-row guard after its
    // "configure gauge" hint (see there). Keeping the shared guard off preserves the ordering
    // — an unconfigured gauge is told to configure itself rather than being told "No data" —
    // while the renderer covers the emptiness case the shared guard would have covered.
    runsNoDataGuard: false,
    emitsCrossFilter: false,
    // A gauge is a single aggregate over `enrichedRows`; there is no per-category mark to dim.
    supportsGhost: false,
    render: renderGauge,
  },
} satisfies Record<StudioChartType, ChartTypeDef>;

/**
 * Look up a chart type's registry entry, defaulting to `bar` for an absent type and falling back
 * to `bar` for an UNKNOWN (doc/AI-authored) one.
 *
 * `StudioChartType` is not validated at the load/AI-tool boundary, so the record is indexed
 * through the prototype-chain-safe `lookup` — a value like `"constructor"`/`"toString"` would
 * otherwise resolve an inherited `Object.prototype` member (truthy, so `??` never fires) and every
 * caller would then read `undefined` flags off a function. Mirrors `StudioChartWidget.tsx`'s own
 * render-time `Object.hasOwn(CHART_TYPE_DEFS, chartType)` dispatch guard for the same bug class.
 */
export function getChartTypeDef(chartType: StudioChartType | undefined): ChartTypeDef {
  if (chartType === undefined) {
    return CHART_TYPE_DEFS.bar;
  }
  const defs: Record<string, ChartTypeDef> = CHART_TYPE_DEFS;
  return lookup(defs, chartType) ?? CHART_TYPE_DEFS.bar;
}
