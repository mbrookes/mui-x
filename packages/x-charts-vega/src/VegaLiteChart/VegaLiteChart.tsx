'use client';
import * as React from 'react';
import { ChartsSurface } from '@mui/x-charts/ChartsSurface';
import { ChartsWrapper } from '@mui/x-charts/ChartsWrapper';
import {
  ChartsLegend,
  ContinuousColorLegend,
  PiecewiseColorLegend,
} from '@mui/x-charts/ChartsLegend';
import { ChartsTooltip } from '@mui/x-charts/ChartsTooltip';
import { ChartsXAxis } from '@mui/x-charts/ChartsXAxis';
import { ChartsYAxis } from '@mui/x-charts/ChartsYAxis';
import { ChartsGrid } from '@mui/x-charts/ChartsGrid';
import { ChartsAxisHighlight } from '@mui/x-charts/ChartsAxisHighlight';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import { BarPlot } from '@mui/x-charts/BarChart';
import { AreaPlot, LineHighlightPlot, LinePlot, MarkPlot } from '@mui/x-charts/LineChart';
import { ScatterPlot } from '@mui/x-charts/ScatterChart';
import { PiePlot } from '@mui/x-charts/PieChart';
import { HeatmapPlot } from '@mui/x-charts-pro/Heatmap';
import { heatmapSeriesConfig } from '@mui/x-charts-pro/Heatmap/seriesConfig';
import {
  ChartsDataProviderPremium,
  defaultSeriesConfigPremium,
} from '@mui/x-charts-premium/ChartsDataProviderPremium';
import { Unstable_ChartsGeoDataProviderPremium as ChartsGeoDataProviderPremium } from '@mui/x-charts-premium/ChartsGeoDataProviderPremium';
import { RangeBarPlot } from '@mui/x-charts-premium/BarChartPremium';
import { GeoDataPlot, MapShapePlot } from '@mui/x-charts-premium/Map';
import { ChartsClipPath } from '@mui/x-charts/ChartsClipPath';
import { useDrawingArea } from '@mui/x-charts/hooks';
import useId from '@mui/utils/useId';
import type { Position } from '@mui/x-charts/models';
import type { DatasetRow, VegaChannelDef, VegaFieldDef, VegaLiteSpec } from '../types';
import { isFieldDef } from '../types';
import type { TranslationGap } from '../gaps';
import { compileSpec } from '../compile';
import { collectBindInputs } from '../compile/params';
import { VegaOverlays, ArcLabelsPlot } from '../overlays';
import { FACET_CELL_MARGIN, MAX_FACET_DEPTH, planFacets, resolveGridSize } from '../facet';
import { ParamInputs } from './ParamInputs';
import { OverlayLegend } from './OverlayLegend';
import { SizeLegend } from './SizeLegend';
import { VegaTooltip, resolveTooltipFields } from './VegaTooltip';
import { createScatterMarkerOverrides } from './HollowScatterMarker';

type LegendLayout = { position: Position; direction: 'horizontal' | 'vertical' };

/**
 * Maps a Vega-Lite color-legend `orient` to the x-charts wrapper's legend
 * placement (`legendPosition` + `legendDirection`, the mechanism that actually
 * moves the composed HTML legend — `<ChartsLegend>` itself drops a `position`
 * prop). An unset / unsupported orient defaults to a right-side vertical legend,
 * matching Vega-Lite's default placement (x-charts would otherwise stack a
 * horizontal legend across the top, which wraps to several rows and squeezes the
 * plot for series-heavy charts).
 */
// Vega-Lite draws 10px legend labels; x-charts' default is 12px. Shrink the
// series-legend label text to match (applied via `sx` on every `ChartsLegend`).
//
// A vertical (side) legend gets extra rules to match Vega-Lite's compact,
// fixed-width symbol legend: x-charts' default row gap/mark size are tuned for
// a handful of horizontal items, so a color field with many categories (e.g.
// a `scheme` with 15-20 values) produces a legend column that both reads much
// taller than Vega's tightly-packed rows and, at its unconstrained natural
// width, can outgrow the demo's side-by-side comparison container and get
// clipped. Capping the column width and letting long single-word category
// names wrap (`minWidth: 0` + `overflowWrap`) keeps the legend inside its
// container instead of relying on the container to grow around it.
const LEGEND_SX = {
  '& .MuiChartsLegend-label': { fontSize: 10 },
  // `minWidth: 0` overrides the grid item's automatic minimum size (which
  // browsers compute from the *unbroken* longest word and enforce even with
  // `overflow-wrap: break-word` on descendants) — without it the legend's
  // grid track refuses to shrink below "Transportation" and the label wrap
  // below never gets a chance to apply.
  '&.MuiChartsLegend-vertical': { gap: '2px', maxWidth: 150, minWidth: 0 },
  '&.MuiChartsLegend-vertical .MuiChartsLegend-series': { gap: '4px', minWidth: 0 },
  '&.MuiChartsLegend-vertical .MuiChartsLegend-label': {
    minWidth: 0,
    overflowWrap: 'break-word',
  },
  '&.MuiChartsLegend-vertical .MuiChartsLabelMark-root': { width: 9, height: 9, flexShrink: 0 },
} as const;

function resolveLegendLayout(orient: string | undefined): LegendLayout {
  switch (orient) {
    case 'top':
      return { position: { vertical: 'top', horizontal: 'center' }, direction: 'horizontal' };
    case 'bottom':
      return { position: { vertical: 'bottom', horizontal: 'center' }, direction: 'horizontal' };
    case 'left':
      return { position: { vertical: 'top', horizontal: 'start' }, direction: 'vertical' };
    case 'right':
    default:
      // Vega-Lite anchors a right-side legend at the top of the plot, not its
      // vertical middle, so match that.
      return { position: { vertical: 'top', horizontal: 'end' }, direction: 'vertical' };
  }
}

/**
 * The bold title Vega-Lite draws above a series legend — the color/fill field's
 * explicit `title`, else its field name. `undefined` when there's no field-based
 * legend (a `datum`/value color has none, and `legend: null` suppresses it), so
 * datum-driven legends (e.g. a `repeat` over layers) stay untitled like Vega.
 */
function resolveLegendTitle(spec: VegaLiteSpec): string | undefined {
  const channelDef = spec.encoding?.color ?? spec.encoding?.fill;
  if (!isFieldDef(channelDef)) {
    return undefined;
  }
  if ((channelDef as { legend?: unknown }).legend === null) {
    return undefined;
  }
  const title = (channelDef as { title?: unknown }).title;
  if (title === null) {
    return undefined;
  }
  if (typeof title === 'string') {
    return title;
  }
  return channelDef.field;
}

// The premium provider's default series config registers every premium
// series EXCEPT heatmap (only the dedicated <Heatmap> chart wires that one
// in), so it must be merged in explicitly for heatmap series to process.
const SERIES_CONFIG = {
  ...defaultSeriesConfigPremium,
  heatmap: heatmapSeriesConfig,
};

/**
 * Nesting depth of the current chart inside a facet/concat grid. The top-level
 * chart is depth 0; each grid level increments it. Beyond `MAX_FACET_DEPTH` the
 * shell stops expanding compositions and reports a gap (a guard against
 * pathological / cyclic specs — normal faceting is naturally shallow because
 * leaf sub-specs have no facet channels left).
 */
const FacetDepthContext = React.createContext(0);

/**
 * The axis title Vega-Lite would show for a channel def — an explicit
 * `axis.title`/`title` (or `null` to suppress), else an aggregate-prefixed field
 * name ("SUM of revenue", "Count of Records"), else the field name. Used to draw
 * one shared trellis axis title (mirrors `axisTitle` in `compile/scales.ts`).
 */
function facetAxisTitle(def: VegaChannelDef | undefined): string | undefined {
  if (!isFieldDef(def)) {
    return undefined;
  }
  const axis = (def as { axis?: unknown }).axis;
  if (axis === null) {
    return undefined;
  }
  if (axis && typeof axis === 'object' && 'title' in axis) {
    const title = (axis as { title?: unknown }).title;
    return title == null ? undefined : String(title);
  }
  if (def.title === null) {
    return undefined;
  }
  if (def.title) {
    return String(def.title);
  }
  const parts: string[] = [];
  if (typeof def.aggregate === 'string') {
    parts.push(def.aggregate.toUpperCase());
  }
  if (def.field) {
    parts.push(def.field);
  } else if (def.aggregate === 'count') {
    parts.push('Count of Records');
  }
  return parts.length > 0 ? parts.join(' of ') : undefined;
}

/** Vega-Lite's default band `step` (px per discrete category) when none is given. */
const VEGA_DEFAULT_STEP = 20;
// The continuous-axis plot size used when the spec gives no explicit size and
// the caller passes no `width`/`height`. The gallery hands these same values to
// the reference `vega-embed` view, so a chart with no spec size renders at the
// same size on both sides.
const VEGA_DEFAULT_VIEW_WIDTH = 440;
const VEGA_DEFAULT_VIEW_HEIGHT = 340;
// Vega-Lite's `width`/`height` size the *plot*, whereas x-charts' `width`/
// `height` size the whole surface (plot + axes). To make our plot match the
// reference's plot, add back the space x-charts reserves for the perpendicular
// axis: the left y-axis widens the surface, the bottom x-axis heightens it.
//
// The wrapper's axes use `width/height: 'auto'` (scales.ts) so x-charts sizes
// each axis to fit its tick labels — which for a long category ("Europe") or a
// wide number ("20,000") reserves far more than a fixed pad. If the surface is
// only plot + a small fixed pad, that auto-margin eats into the plot until it
// collapses (heatmap cells shrink to a few px). So the allowance is estimated
// from the axis's own labels: a base (rotated title + ticks + opposite-axis
// overhang) plus the longest tick label. The resulting surface is sometimes a
// little wider than the reference's, but the *plot* — the visual content —
// matches instead of collapsing.
const AXIS_LABEL_CHAR_PX = 7;
// y-axis: title(rotated) + tick marks + right overhang of the last x label.
// Measured, not estimated: with the allowance at 72/88 every standalone
// cartesian chart's drawing area came out exactly 9px wide and 3px tall MORE
// than the reference's — a constant, independent of the chart's size or its
// label widths (449x343 vs 440x340, 309x203 vs 300x200, 109x343 vs 100x340,
// 809x503 vs 800x500). The allowance has to equal what x-charts actually
// consumes; overshooting it by a constant inflates the plot by that constant.
// Trellis cells were already exact, which is why this only showed up here.
const Y_AXIS_BASE_ALLOWANCE = 63;
// x-axis: title + tick marks + one horizontal label row. x-charts' `height:'auto'`
// axis reserves a generous bottom band (plus a small top pad), so this is sized
// to let the plot survive it rather than the tighter space a label row implies.
const X_AXIS_BASE_ALLOWANCE = 85;
// Continuous axes carry no category array; assume ~6-char numeric labels ("20,000").
const CONTINUOUS_LABEL_CHARS = 6;

/** The longest tick-label length (chars) an axis will show, for margin estimation. */
function longestAxisLabelChars(config: { data?: readonly unknown[] } | undefined): number {
  const data = config?.data;
  if (Array.isArray(data) && data.length > 0) {
    return data.reduce<number>((max, value) => {
      const text = value instanceof Date ? value.toLocaleDateString() : String(value);
      return Math.max(max, text.length);
    }, 1);
  }
  return CONTINUOUS_LABEL_CHARS;
}

/** Horizontal space x-charts' `width:'auto'` y-axis reserves (label-aware). */
function yAxisAllowance(config: { data?: readonly unknown[] } | undefined): number {
  return Y_AXIS_BASE_ALLOWANCE + Math.min(longestAxisLabelChars(config), 22) * AXIS_LABEL_CHAR_PX;
}

/**
 * The surface size that renders this view at Vega-Lite's plot dimensions, so the
 * wrapper's chart matches the reference side by side. Each dimension is resolved
 * from its own axis: a numeric spec size is the plot size; a discrete band/point
 * axis — or an explicit `{step}` — uses Vega's step-based sizing (`step ×
 * categoryCount`); a continuous axis (or a non-cartesian chart) falls back to
 * the caller's size. The perpendicular axis allowance is then added so the plot
 * (surface minus axes), not the surface, equals the reference's plot.
 */
function resolveVegaViewSize(
  spec: VegaLiteSpec,
  compiled: {
    xAxis?: { config: { scaleType?: string; data?: readonly unknown[]; position?: string } };
    yAxis?: { config: { scaleType?: string; data?: readonly unknown[]; position?: string } };
    series?: readonly unknown[];
  },
  fallbackWidth: number | undefined,
  fallbackHeight: number | undefined,
): { width: number | undefined; height: number | undefined } {
  // Dodged (grouped) bars split each category band into one sub-band per
  // `xOffset`/`yOffset` group, so the discrete axis needs `subgroupCount ×` the
  // room a single series would take (Vega sizes each leaf bar to a step). The
  // subgroup count is the number of dodged series.
  const dodgeFactor = (channel: 'x' | 'y'): number => {
    const offsetKey = channel === 'x' ? 'xOffset' : 'yOffset';
    const units = Array.isArray(spec.layer) ? spec.layer : [spec];
    const hasOffset =
      (spec as { encoding?: Record<string, unknown> }).encoding?.[offsetKey] != null ||
      units.some(
        (unit) => (unit as { encoding?: Record<string, unknown> }).encoding?.[offsetKey] != null,
      );
    const seriesCount = compiled.series?.length ?? 1;
    return hasOffset && seriesCount > 1 ? seriesCount : 1;
  };
  // A binned channel is drawn on a continuous scale by Vega-Lite (the bins have
  // numeric positions), so it sizes like a continuous axis — even though the
  // wrapper renders it through a discrete band domain.
  const isBinned = (channel: 'x' | 'y'): boolean => {
    const units = Array.isArray(spec.layer) ? spec.layer : [spec];
    return units.some((unit) => {
      const enc = (unit as { encoding?: Record<string, unknown> }).encoding?.[channel];
      return Boolean(enc && typeof enc === 'object' && (enc as { bin?: unknown }).bin);
    });
  };
  // Whether the channel is genuinely encoded (vs. a synthetic single-category
  // axis the compiler adds so a 1-D strip's ticks have somewhere to sit). A
  // synthetic axis must not drive step-based sizing — otherwise a `tick` strip
  // with no `y` collapses to one 20px band instead of a full-height strip.
  const channelEncoded = (channel: 'x' | 'y'): boolean => {
    // Shared top-level encoding (a layered spec's common `y`, as the errorbar
    // example carries) counts too — not only the per-layer encodings.
    if ((spec as { encoding?: Record<string, unknown> }).encoding?.[channel] != null) {
      return true;
    }
    const units = Array.isArray(spec.layer) ? spec.layer : [];
    return units.some(
      (unit) => (unit as { encoding?: Record<string, unknown> }).encoding?.[channel] != null,
    );
  };
  const viewConfigStep = (spec as { config?: { view?: { step?: unknown } } }).config?.view?.step;
  const viewStep = typeof viewConfigStep === 'number' ? viewConfigStep : undefined;
  const plotSize = (
    size: VegaLiteSpec['width'],
    axis: { config: { scaleType?: string; data?: readonly unknown[] } } | undefined,
    fallback: number | undefined,
    channel: 'x' | 'y',
  ): number | undefined => {
    if (typeof size === 'number') {
      return size;
    }
    const scaleType = axis?.config.scaleType;
    const isDiscrete =
      (scaleType === 'band' || scaleType === 'point') &&
      !isBinned(channel) &&
      channelEncoded(channel);
    const count = axis?.config.data?.length ?? 0;
    if (isDiscrete && count > 0) {
      // `config.view.step` sets the default band step for every discrete scale
      // in the view; a channel's own `{step: N}` size still wins over it. Without
      // it a spec that shrinks its cells globally renders far too wide —
      // `rect_heatmap_weather` asks for a 13px step and got the 20px default,
      // making its 31-day heatmap ~620px instead of ~403px and pushing the last
      // day and the whole color legend outside the visible area.
      const step =
        size && typeof size === 'object' && typeof (size as { step?: unknown }).step === 'number'
          ? (size as { step: number }).step
          : (viewStep ?? VEGA_DEFAULT_STEP);
      return step * count * dodgeFactor(channel);
    }
    return fallback;
  };
  const width = plotSize(spec.width, compiled.xAxis, fallbackWidth, 'x');
  const height = plotSize(
    spec.height as VegaLiteSpec['width'],
    compiled.yAxis,
    fallbackHeight,
    'y',
  );
  // Only pad when the perpendicular axis is both present AND actually drawn —
  // `axis: null` (`position: 'none'`) still compiles a yAxis/xAxis config (for
  // its scale/domain), but draws no ticks/labels, so reserving label-width
  // margin for it would only widen/heighten the surface for nothing.
  const yAxisDrawn = compiled.yAxis && compiled.yAxis.config.position !== 'none';
  const xAxisDrawn = compiled.xAxis && compiled.xAxis.config.position !== 'none';
  return {
    width:
      width !== undefined && yAxisDrawn ? width + yAxisAllowance(compiled.yAxis!.config) : width,
    height: height !== undefined && xAxisDrawn ? height + X_AXIS_BASE_ALLOWANCE : height,
  };
}

/**
 * Rotate a discrete x-axis's tick labels to vertical when they'd overlap at the
 * resolved plot width (mirroring Vega-Lite, which rotates rather than dropping
 * labels). Estimates the band width (plot width ÷ category count) and the widest
 * label; if the label is wider than its band, sets a −90° angle. Continuous axes
 * and comfortably-fitting labels are left untouched. Skipped when the spec
 * already set an explicit `labelAngle` (honored via tickLabelStyle.angle).
 */
function rotateXLabelsIfCramped<T extends Record<string, unknown>>(
  config: T,
  surfaceWidth: number | undefined,
  hasYAxis: boolean,
): T {
  const scaleType = (config as { scaleType?: string }).scaleType;
  const data = (config as { data?: readonly unknown[] }).data;
  const existing = (config as { tickLabelStyle?: { angle?: number } }).tickLabelStyle;
  if (
    (scaleType !== 'band' && scaleType !== 'point') ||
    !Array.isArray(data) ||
    data.length === 0 ||
    !surfaceWidth ||
    existing?.angle !== undefined
  ) {
    return config;
  }
  const plotWidth = surfaceWidth - (hasYAxis ? 70 : 20);
  const bandWidth = plotWidth / data.length;
  const longestLabelChars = data.reduce<number>((max, value) => {
    const text = value instanceof Date ? value.toLocaleDateString() : String(value);
    return Math.max(max, text.length);
  }, 0);
  // ~6px per character; leave a little slack before rotating.
  if (longestLabelChars * 6 <= bandWidth - 4) {
    return config;
  }
  return {
    ...config,
    tickLabelStyle: { ...existing, angle: -90, textAnchor: 'end', dominantBaseline: 'central' },
  };
}

/**
 * A thin frame around the plotting area, matching Vega-Lite's default view
 * border (`config.view.stroke`, light grey `#ddd`) — the top/right edges that
 * close the box the bottom/left axes start. Drawn behind the marks so bars/
 * lines sit on top. Suppressed when the spec sets `config.view.stroke` to a
 * falsy/transparent value.
 */
const VEGA_VIEW_STROKE = 'rgb(221, 221, 221)';
function PlotBorder({ stroke }: { stroke: string }) {
  const { left, top, width, height } = useDrawingArea();
  return (
    <rect
      x={left}
      y={top}
      width={width}
      height={height}
      fill="none"
      stroke={stroke}
      strokeWidth={1}
      shapeRendering="crispEdges"
      pointerEvents="none"
    />
  );
}

/** Resolve the view-border stroke: honor `config.view.stroke`, else Vega's default. */
function resolveViewStroke(spec: VegaLiteSpec): string | undefined {
  const viewStroke = (spec as { config?: { view?: { stroke?: unknown } } }).config?.view?.stroke;
  if (
    viewStroke === null ||
    viewStroke === false ||
    viewStroke === 'transparent' ||
    viewStroke === ''
  ) {
    return undefined;
  }
  return typeof viewStroke === 'string' ? viewStroke : VEGA_VIEW_STROKE;
}

/** Stable no-op for the trellis legend proxy, whose gaps the cells already report. */
const NO_GAPS = () => {};

/**
 * Shared bound-param signal values for a single chart tree. The root
 * `VegaLiteChart` owns the state and renders the input toolbar; nested
 * (facet/concat) instances read the same context so their compiled specs see
 * the live param values without each rendering their own controls.
 */
interface VegaParamsContextValue {
  values: Record<string, unknown>;
  setValue: (name: string, value: unknown) => void;
}
const VegaParamsContext = React.createContext<VegaParamsContextValue | null>(null);

export interface VegaLiteChartProps {
  /** The Vega-Lite specification to translate. */
  spec: VegaLiteSpec;
  /** Rows standing in for (or overriding) `spec.data.values`. */
  data?: readonly DatasetRow[];
  /** Named datasets referenced by `data: {name}` entries in the spec. */
  datasets?: Record<string, readonly DatasetRow[]>;
  /**
   * The chart's surface width in px. When omitted, the wrapper sizes the view
   * the way Vega-Lite would (the spec's `width`, `step × categoryCount` for a
   * discrete axis, else a default) so it matches the reference renderer.
   */
  width?: number;
  /** The chart's surface height in px; see `width` for the omitted behavior. */
  height?: number;
  /** Categorical palette override. */
  colors?: readonly string[];
  /**
   * Called (on mount and when the spec changes) with every Vega-Lite feature
   * of the spec that could not be fully translated to x-charts components. For
   * faceted / concatenated specs the gaps of every sub-chart are aggregated
   * (deduped by code+path) and reported once alongside any facet-level gaps.
   * @param {TranslationGap[]} gaps The features that were dropped, approximated, or ignored.
   */
  onGaps?: (gaps: TranslationGap[]) => void;
  /** Extra children rendered inside the chart surface (composition escape hatch). */
  children?: React.ReactNode;
  /**
   * @ignore
   * Internal (facet cell) rendering controls. A trellis shares one x/y axis and
   * one legend across the grid, so inner cells suppress their own axis labels
   * and legend while keeping a fixed margin so every cell's plot area lines up.
   */
  cell?: {
    hideXAxis?: boolean;
    hideYAxis?: boolean;
    /** Keep the axis ticks but drop its title — the trellis draws one shared title. */
    hideAxisTitles?: boolean;
    hideLegend?: boolean;
    /** Fixed drawing-area margin shared by every cell so plot areas align. */
    margin?: { top?: number; right?: number; bottom?: number; left?: number };
    /** Render only the shared legend (no plot), used for the single trellis legend. */
    legendOnly?: boolean;
  };
}

/**
 * Renders a Vega-Lite specification with `@mui/x-charts` subcomponents.
 *
 * This is a best-effort translator: the supported grammar subset renders
 * natively (bar/line/area/point/arc/rect/rule/geoshape marks, positional +
 * color encodings, aggregation, stacking, layering); everything else degrades
 * gracefully and is reported through `onGaps` (and a dev-mode console
 * warning) rather than throwing. Marks covered only by the commercial tiers
 * (rect heatmaps, ranged bars, geoshape maps) render through
 * `@mui/x-charts-premium` — without a license key they show a watermark.
 *
 * View compositions (`row`/`column` facet channels, the `facet` operator, and
 * `hconcat`/`vconcat`/`concat`) are expanded into a CSS grid of nested
 * `<VegaLiteChart />` instances. See GAPS.md for the full support matrix.
 */
export function VegaLiteChart(props: VegaLiteChartProps) {
  const { spec, data, datasets, width, height, colors, onGaps, children, cell } = props;
  const depth = React.useContext(FacetDepthContext);

  // Only the outermost instance (no inherited param context) owns the shared
  // param signal values and renders the input toolbar; nested facet/concat
  // cells inherit the same context.
  const inheritedParams = React.useContext(VegaParamsContext);
  const isRoot = inheritedParams == null;
  const widgetInputs = React.useMemo(() => (isRoot ? collectBindInputs(spec) : []), [isRoot, spec]);
  const [paramValues, setParamValues] = React.useState<Record<string, unknown>>({});
  // Reset param values when the spec identity changes (store-info-from-previous-
  // render pattern) so a new dashboard doesn't inherit stale control values.
  const prevSpecRef = React.useRef(spec);
  if (prevSpecRef.current !== spec) {
    prevSpecRef.current = spec;
    // Only the root owns this state; nested cells never read it, so skip the
    // extra render their reset would trigger.
    if (isRoot) {
      setParamValues({});
    }
  }
  const setValue = React.useCallback((name: string, value: unknown) => {
    setParamValues((prev) => ({ ...prev, [name]: value }));
  }, []);
  const paramsContextValue = React.useMemo<VegaParamsContextValue>(
    () => ({ values: paramValues, setValue }),
    [paramValues, setValue],
  );

  const gridSize = resolveGridSize(spec, width, height);
  const plan = React.useMemo(
    () => planFacets(spec, { data, datasets, width: gridSize.width, height: gridSize.height }),
    [spec, data, datasets, gridSize.width, gridSize.height],
  );
  const overDepth = plan != null && depth >= MAX_FACET_DEPTH;

  // Named datasets declared on the top-level spec are merged with the prop so
  // sub-charts can still resolve `data: {name}` references — the single-view
  // path merges `spec.datasets` inside `normalizeSpec`, so faceting must too.
  const mergedDatasets = React.useMemo<Record<string, readonly DatasetRow[]>>(
    () => ({
      ...(spec.datasets as Record<string, readonly DatasetRow[]> | undefined),
      ...datasets,
    }),
    [spec, datasets],
  );

  // Aggregate gaps reported by every sub-chart cell (plus facet-level gaps) and
  // flush them to `onGaps` ONCE, rather than once per cell. Child effects run
  // before this component's effect, so by flush time the ref is populated; a
  // version counter re-flushes if a cell reports late (e.g. async data).
  const cellGapsRef = React.useRef<Map<string, TranslationGap>>(new Map());
  const facetReportedRef = React.useRef<string | null>(null);
  const [gapVersion, setGapVersion] = React.useState(0);
  // Reset the collector whenever the plan identity changes (new spec/data) —
  // the "store info from previous render" pattern, run during render.
  const prevPlanRef = React.useRef<typeof plan>(plan);
  if (prevPlanRef.current !== plan) {
    prevPlanRef.current = plan;
    cellGapsRef.current = new Map();
    facetReportedRef.current = null;
  }

  const handleCellGaps = React.useCallback((gaps: TranslationGap[]) => {
    let changed = false;
    for (const gap of gaps) {
      const key = `${gap.code}|${gap.path ?? ''}`;
      if (!cellGapsRef.current.has(key)) {
        cellGapsRef.current.set(key, gap);
        changed = true;
      }
    }
    if (changed) {
      setGapVersion((value) => value + 1);
    }
  }, []);

  const planGaps = plan?.gaps;
  React.useEffect(() => {
    if (plan == null) {
      return;
    }
    const collected = new Map<string, TranslationGap>();
    const push = (gap: TranslationGap) => collected.set(`${gap.code}|${gap.path ?? ''}`, gap);
    if (overDepth) {
      push({
        code: 'composition:facet-depth',
        message:
          `View compositions nested deeper than ${MAX_FACET_DEPTH} levels are not expanded ` +
          '(guard against pathological specs); this sub-view was not rendered.',
        severity: 'unsupported',
        path: 'facet',
      });
    } else {
      planGaps?.forEach(push);
      cellGapsRef.current.forEach(push);
    }
    const list = [...collected.values()];
    const signature = list
      .map((gap) => `${gap.code}|${gap.path ?? ''}`)
      .sort()
      .join(';');
    if (facetReportedRef.current === signature) {
      return;
    }
    facetReportedRef.current = signature;
    onGaps?.(list);
    if (process.env.NODE_ENV !== 'production' && list.length > 0 && !onGaps) {
      console.warn(
        `MUI X Charts Vega: ${list.length} spec feature(s) could not be fully translated:\n${list
          .map((gap) => `- [${gap.severity}] ${gap.code}: ${gap.message}`)
          .join('\n')}`,
      );
    }
  }, [plan, planGaps, gapVersion, overDepth, onGaps]);

  if (overDepth) {
    return null;
  }

  let content: React.ReactNode;
  if (plan != null) {
    // Facet small multiples share one x/y scale and legend: draw axis labels
    // only on the left column / bottom row, keep a uniform per-cell margin so the
    // plot areas line up, and hoist a single legend beside the grid. Concat and
    // repeat cells stay independent (their own axes and legends).
    const shared = plan.sharedAxes === true;
    // The hoisted legend must list every color group, but a facet whose facet
    // field equals its color field (e.g. `row: gender` + `color: gender`) leaves
    // each cell holding only one group — so the legend proxy compiles against
    // the union of every cell's rows, not just the first cell's partition.
    const legendSpec = (() => {
      const first = shared ? plan.cells[0]?.spec : undefined;
      if (!first) {
        return undefined;
      }
      const unionRows = plan.cells.flatMap(
        (cell) => (cell.spec.data as { values?: readonly unknown[] } | undefined)?.values ?? [],
      );
      return unionRows.length > 0
        ? ({ ...first, data: { values: unionRows } } as VegaLiteSpec)
        : first;
    })();
    // A trellis shares one x/y axis, so its title belongs once beside/below the
    // whole grid rather than repeated in every column/row cell.
    const leafEncoding = shared ? (plan.cells[0]?.spec.encoding ?? {}) : {};
    const sharedXTitle = shared ? facetAxisTitle(leafEncoding.x) : undefined;
    const sharedYTitle = shared ? facetAxisTitle(leafEncoding.y) : undefined;
    // Only the leftmost column draws the y-axis and only the bottom row draws
    // the x-axis (a trellis shares one of each), so inner cells reserve no space
    // for the axis they don't draw. Keeping the full axis margin on every cell
    // would leave a wide empty gutter between columns/rows (and shrink the
    // plots); instead inner cells drop the absent axis's margin and their
    // width/height shrink by the same amount, so every cell's *plot* stays
    // identical while the cells sit flush against each other — matching Vega.
    // The left margin grows with the shared y-axis's longest category label
    // (`plan.yAxisMargin`, computed alongside the cell size in facet/index.ts)
    // instead of the fixed default, so a long name like "Wisconsin No. 38"
    // isn't truncated.
    const cellMargin = { ...FACET_CELL_MARGIN, left: plan.yAxisMargin ?? FACET_CELL_MARGIN.left };
    const innerLeftMargin = cellMargin.right;
    const innerBottomMargin = cellMargin.top;
    const leftReduction = cellMargin.left - innerLeftMargin;
    const bottomReduction = cellMargin.bottom - innerBottomMargin;
    const leftTrackWidth = plan.cells[0]?.width;
    const innerTrackWidth =
      leftTrackWidth !== undefined ? leftTrackWidth - leftReduction : undefined;
    // Concat views keep their own (differing) sizes, so each grid column is sized
    // to the widest cell in it rather than to a single uniform track. A shared
    // trellis keeps its uniform packed tracks.
    //
    // The track is `minmax(<natural width>, max-content)`, not a hard pixel
    // width: a cell's plot is exactly its natural width, but anything the chart
    // composes BESIDE that plot — a size legend, a right-side color legend — is
    // an HTML sibling of the fixed-width surface, so the cell's real content is
    // wider than the plot it was sized from. A hard `<w>px` track let that
    // surplus spill over the next column and paint on top of its axis labels
    // (`concat_bar_scales_discretize`'s three size legends, each landing on the
    // neighbouring panel's tick labels). Growing the track to `max-content`
    // instead reproduces Vega-Lite's own layout, where a view's legend occupies
    // real estate outside the plot and the composition widens to fit it.
    const concatColumnWidths = !shared
      ? Array.from({ length: plan.columns }, (_, col) => {
          let max = 0;
          for (let row = 0; row * plan.columns + col < plan.cells.length; row += 1) {
            max = Math.max(max, plan.cells[row * plan.columns + col]?.width ?? 0);
          }
          return max;
        })
      : undefined;
    const evenColumns = `repeat(${plan.columns}, minmax(0, 1fr))`;
    const gridTemplateColumns = (() => {
      if (shared) {
        // A trellis packs uniform tracks: only the leftmost column carries the
        // shared y axis, so the rest are narrower by exactly the margin they drop.
        if (leftTrackWidth === undefined || innerTrackWidth === undefined) {
          return evenColumns;
        }
        return plan.columns > 1
          ? `${leftTrackWidth}px repeat(${plan.columns - 1}, ${innerTrackWidth}px)`
          : `${leftTrackWidth}px`;
      }
      if (concatColumnWidths && concatColumnWidths.every((w) => w > 0)) {
        return concatColumnWidths.map((w) => `minmax(${w}px, max-content)`).join(' ');
      }
      return evenColumns;
    })();
    const grid = (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns,
          gap: shared ? 0 : 8,
          width: 'max-content',
          maxWidth: '100%',
        }}
      >
        {plan.cells.map((cell, index) => {
          const isLeftColumn = index % plan.columns === 0;
          const hasCellBelow = index + plan.columns < plan.cells.length;
          const cellProps = shared
            ? {
                hideYAxis: !isLeftColumn,
                hideXAxis: hasCellBelow,
                hideAxisTitles: true,
                hideLegend: true,
                margin: {
                  ...cellMargin,
                  left: isLeftColumn ? cellMargin.left : innerLeftMargin,
                  bottom: hasCellBelow ? innerBottomMargin : cellMargin.bottom,
                },
              }
            : undefined;
          // Shrink inner cells by exactly the margin they dropped so their plot
          // area matches the labeled edge cells' plots.
          const cellWidth = shared && !isLeftColumn ? cell.width - leftReduction : cell.width;
          const cellHeight = shared && hasCellBelow ? cell.height - bottomReduction : cell.height;
          return (
            <div key={cell.key} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              {cell.header != null && (
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    textAlign: 'center',
                    padding: '2px 0',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cell.header}
                </div>
              )}
              <VegaLiteChart
                spec={cell.spec}
                datasets={mergedDatasets}
                width={cellWidth}
                height={cellHeight}
                colors={colors}
                onGaps={handleCellGaps}
                cell={cellProps}
              />
            </div>
          );
        })}
      </div>
    );
    // The grid, with one shared x-axis title centered below it (the per-cell
    // titles were dropped via `hideAxisTitles`).
    const gridWithXTitle = (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {grid}
        {sharedXTitle && (
          <div style={{ textAlign: 'center', fontSize: 12, padding: '2px 0' }}>{sharedXTitle}</div>
        )}
      </div>
    );
    // A single shared y-axis title (rotated), vertically centered to the left of
    // the grid; then the grid; then the shared legend proxy.
    const gridBlock = (
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {sharedYTitle && (
          <div
            style={{
              display: 'flex',
              // `writing-mode: vertical-rl` rotates the flex axes: `row` now runs
              // top-to-bottom, so the vertical centering this title wants is
              // `justifyContent` (main axis), not `alignItems` (which centers it
              // horizontally in its own 22px-wide column). With `alignItems`
              // alone the text sat at the main-axis start — and the extra
              // `rotate(180deg)` flipped that start to the BOTTOM, stranding
              // "population" in the grid's bottom-left corner.
              justifyContent: 'center',
              alignItems: 'center',
              fontSize: 12,
              padding: '0 2px',
              writingMode: 'vertical-rl',
              transform: 'rotate(180deg)',
            }}
          >
            {sharedYTitle}
          </div>
        )}
        {gridWithXTitle}
      </div>
    );
    content = (
      <FacetDepthContext.Provider value={depth + 1}>
        {shared && legendSpec ? (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            {gridBlock}
            <VegaLiteChart
              spec={legendSpec}
              datasets={mergedDatasets}
              height={gridSize.height}
              colors={colors}
              onGaps={NO_GAPS}
              cell={{ legendOnly: true }}
            />
          </div>
        ) : (
          gridBlock
        )}
      </FacetDepthContext.Provider>
    );
  } else {
    content = (
      <SingleViewChart
        spec={spec}
        data={data}
        datasets={datasets}
        width={width}
        height={height}
        colors={colors}
        onGaps={onGaps}
        cell={cell}
      >
        {children}
      </SingleViewChart>
    );
  }

  // Nested instances inherit the root's param context and render no toolbar.
  if (!isRoot) {
    return content;
  }

  return (
    <VegaParamsContext.Provider value={paramsContextValue}>
      {widgetInputs.length > 0 && (
        <ParamInputs inputs={widgetInputs} values={paramValues} onChange={setValue} />
      )}
      {content}
    </VegaParamsContext.Provider>
  );
}

/**
 * Renders a single (non-composite) Vega-Lite view: compiles the spec and draws
 * the resulting x-charts components. Split out from `VegaLiteChart` so the
 * facet path never runs `compileSpec` (which would otherwise report the
 * composition as an unsupported gap).
 */
function SingleViewChart(props: VegaLiteChartProps) {
  const { spec, data, datasets, width, height, colors, onGaps, children, cell } = props;
  const paramCtx = React.useContext(VegaParamsContext);
  const paramValues = paramCtx?.values;

  const compiled = React.useMemo(
    () => compileSpec(spec, { data, datasets, palette: colors, params: paramValues }),
    [spec, data, datasets, colors, paramValues],
  );

  // A custom scatter marker slot that draws hollow (stroke-only) circles for
  // the `point`-mark / `filled: false` series the compiler flagged (matching
  // Vega-Lite's default point style), and/or a distinct outline color for
  // solid-filled series with an explicit `mark.stroke`. Kept stable across
  // renders so x-charts does not remount every marker; unset when no series
  // need either override.
  const scatterSlots = React.useMemo(() => {
    const hollowIds = compiled.hollowSeriesIds;
    const strokeOverrides = compiled.markerStroke;
    if ((!hollowIds || hollowIds.length === 0) && !strokeOverrides) {
      return undefined;
    }
    return {
      marker: createScatterMarkerOverrides({
        hollowIds: hollowIds ? new Set(hollowIds) : undefined,
        strokeOverrides: strokeOverrides ? new Map(Object.entries(strokeOverrides)) : undefined,
      }),
    };
  }, [compiled.hollowSeriesIds, compiled.markerStroke]);

  // Per-series line-path styling (`mark.strokeWidth`/`strokeDash`, constant or
  // per-group from a field-based `strokeDash` split): x-charts' line series
  // has no such prop, so it's forwarded through `LinePlot`'s `slotProps.line`,
  // which resolves as a function of `ownerState` (including `seriesId`) and
  // passes the result straight through to the underlying `<path>`.
  const lineSlotProps = React.useMemo(() => {
    const lineStyle = compiled.lineStyle;
    if (!lineStyle) {
      return undefined;
    }
    return {
      line: (ownerState: { seriesId: string | number }) => lineStyle[String(ownerState.seriesId)],
    };
  }, [compiled.lineStyle]);

  const clipId = useId();

  const reportedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const signature = compiled.gaps.map((gap) => `${gap.code}|${gap.path}`).join(';');
    if (reportedRef.current === signature) {
      return;
    }
    reportedRef.current = signature;
    onGaps?.(compiled.gaps);
    if (process.env.NODE_ENV !== 'production' && compiled.gaps.length > 0 && !onGaps) {
      console.warn(
        `MUI X Charts Vega: ${compiled.gaps.length} spec feature(s) could not be fully translated:\n${compiled.gaps
          .map((gap) => `- [${gap.severity}] ${gap.code}: ${gap.message}`)
          .join('\n')}`,
      );
    }
  }, [compiled.gaps, onGaps]);

  // An explicit `width`/`height` prop is the authoritative surface size (the
  // facet planner and test/consumer callers rely on this). Otherwise size the
  // chart the way Vega-Lite sizes this view so it matches the reference: a
  // numeric spec size, `step × categoryCount` for a discrete/`{step}` axis, or
  // the default view size for a continuous axis (each plus the axis allowance).
  const vegaSize = resolveVegaViewSize(
    spec,
    compiled,
    VEGA_DEFAULT_VIEW_WIDTH,
    VEGA_DEFAULT_VIEW_HEIGHT,
  );
  const resolvedWidth = width ?? vegaSize.width;
  const resolvedHeight = height ?? vegaSize.height;

  // A pie/arc series with no explicit `outerRadius` (`mark.outerRadius` unset
  // in the spec) falls back to x-charts' own auto-fit, which reserves more
  // margin than Vega-Lite's default arc view — the donut/pie renders
  // noticeably smaller than the reference at the same surface size. Vega-Lite
  // fits the arc to the full surface (radius = half of the smaller
  // dimension, legend space is added beside it rather than carved out of it —
  // matching how this wrapper already sizes the surface), so default to that
  // when the spec leaves it unset.
  const seriesWithPieRadius =
    compiled.plots.includes('pie') && resolvedWidth !== undefined && resolvedHeight !== undefined
      ? compiled.series.map((entry) =>
          entry.type === 'pie' && (entry as { outerRadius?: number }).outerRadius === undefined
            ? { ...entry, outerRadius: Math.min(resolvedWidth, resolvedHeight) / 2 }
            : entry,
        )
      : compiled.series;

  // Color-legend placement from `encoding.color.legend.orient` (unset keeps the
  // default placement). Only field-based color channels carry a `legend`.
  const legendLayout = resolveLegendLayout(
    (spec.encoding?.color as VegaFieldDef | undefined)?.legend?.orient,
  );

  // A declared `tooltip` channel swaps the default tooltip for one that renders
  // the spec's field list; absent/null (or a channel with no resolvable fields)
  // keeps the built-in tooltip.
  const tooltipChannel = spec.encoding?.tooltip;
  const resolvedTooltipFields = tooltipChannel != null ? resolveTooltipFields(tooltipChannel) : [];
  const tooltipFields = resolvedTooltipFields.length > 0 ? resolvedTooltipFields : null;

  // `legendOnly` is deliberately excluded: that proxy renders the trellis's
  // single hoisted legend and is handled below, for every chart kind at once.
  // Claiming it here would render a 1px-wide map and no legend at all.
  if (compiled.chartKind === 'geo' && !cell?.legendOnly) {
    // A geoshape choropleth's color axis (set by the mark compiler for a
    // quantitative/temporal color field, see marks/geoshape.ts) picks the
    // legend variant that matches its `colorMap`, mirroring
    // docs/data/charts/map/ColorScaleMapShape.tsx. Nominal choropleths (and
    // outline maps) have no color axis and fall back to the series legend.
    const geoColorMap = (compiled.zAxis?.[0] as { colorMap?: { type?: string } } | undefined)
      ?.colorMap;
    // A `legend.format` on the color field (e.g. `.1%` for a rate) formats the
    // continuous legend's min/max labels. x-charts ignores a z-axis
    // valueFormatter for this legend, so apply it via `minLabel`/`maxLabel`.
    const geoColorFormat = compiled.geo?.colorLegendFormat;
    const geoColorLabel = geoColorFormat
      ? ({ value }: { value: number | Date }) => geoColorFormat(value)
      : undefined;
    // The color field name titles the legend (Vega-Lite's default), e.g. "rate".
    const geoColorTitle = isFieldDef(spec.encoding?.color) ? spec.encoding?.color.field : undefined;
    // Vega-Lite's default gradient length (config.legend.gradientLength) is
    // 200px; x-charts' own default legend is much shorter, which reads as a
    // squashed sliver next to a full-height choropleth. An explicit spec
    // `gradientLength` still wins.
    const geoColorLegend = isFieldDef(spec.encoding?.color)
      ? spec.encoding?.color.legend
      : undefined;
    const geoGradientLength =
      geoColorLegend && typeof geoColorLegend === 'object' && !Array.isArray(geoColorLegend)
        ? ((geoColorLegend as { gradientLength?: unknown }).gradientLength ?? 200)
        : 200;
    // Vega-Lite places a continuous color legend as a vertical gradient bar to
    // the top-right of the map; mirror that here.
    const withGeoLegendTitle = (legend: React.ReactNode): React.ReactNode =>
      geoColorTitle ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{geoColorTitle}</span>
          {legend}
        </div>
      ) : (
        legend
      );
    let geoLegend: React.ReactNode;
    let geoLegendInset = false;
    // A trellis hoists ONE legend beside the whole grid, so its cells must draw
    // none — the cartesian branch honors `cell.hideLegend` for exactly this, but
    // the geo branch never did. Every facet cell drew its own color legend and
    // took the width from its map: `interactive_geo_facet_species`' four US
    // county choropleths were squeezed to unreadable slivers.
    if (cell?.hideLegend) {
      geoLegend = undefined;
    } else if (geoColorMap?.type === 'piecewise') {
      geoLegend = withGeoLegendTitle(
        <PiecewiseColorLegend
          axisDirection="z"
          direction="vertical"
          sx={{ height: geoGradientLength }}
        />,
      );
    } else if (geoColorMap) {
      geoLegend = withGeoLegendTitle(
        <ContinuousColorLegend
          axisDirection="z"
          direction="vertical"
          sx={{ height: geoGradientLength }}
          {...(geoColorLabel ? { minLabel: geoColorLabel, maxLabel: geoColorLabel } : {})}
        />,
      );
    } else if (compiled.hasLegend) {
      geoLegend = <ChartsLegend sx={LEGEND_SX} />;
    } else if (compiled.overlayLegend.length > 0) {
      // A non-base geoshape layer draws through the `geoShapes` overlay rather
      // than an x-charts series, so it has no native legend entries — its color
      // key comes from `overlayLegend` instead (the twelve named tube lines of
      // `geo_layer_line_london`, which the reference renderer also lists).
      geoLegendInset = true;
      geoLegend = (
        <OverlayLegend items={compiled.overlayLegend} direction="vertical" inset={true} />
      );
    }
    // An inset legend paints over the plot, so it needs a positioned ancestor —
    // and must NOT sit in `ChartsWrapper`'s legend slot, which would give it a
    // layout column again (the very thing insetting avoids).
    const geoInsetLegend = geoLegendInset ? geoLegend : undefined;
    const chart = (
      <ChartsGeoDataProviderPremium
        geoData={compiled.geo?.geoData as never}
        projection={compiled.geo?.projection as never}
        initialView={compiled.geo?.initialView as never}
        series={compiled.series as never}
        zAxis={compiled.zAxis as never}
        colors={compiled.colors.slice()}
        width={resolvedWidth}
        height={resolvedHeight}
      >
        <ChartsWrapper
          legendPosition={{ vertical: 'top', horizontal: 'end' }}
          legendDirection="vertical"
        >
          {geoInsetLegend ? undefined : geoLegend}
          <ChartsSurface title={compiled.title}>
            {compiled.plots.includes('geoBase') && (
              <GeoDataPlot
                {...(compiled.geo?.outlineFill !== undefined
                  ? { fill: compiled.geo.outlineFill }
                  : {})}
                {...(compiled.geo?.outlineStroke !== undefined
                  ? { stroke: compiled.geo.outlineStroke }
                  : {})}
                {...(compiled.geo?.outlineStrokeWidth !== undefined
                  ? { strokeWidth: compiled.geo.outlineStrokeWidth }
                  : {})}
              />
            )}
            {compiled.plots.includes('mapShape') && <MapShapePlot />}
            <VegaOverlays overlays={compiled.overlays} />
            {children}
          </ChartsSurface>
          <ChartsTooltip trigger="item" />
        </ChartsWrapper>
      </ChartsGeoDataProviderPremium>
    );
    return geoInsetLegend ? (
      <div style={{ position: 'relative', display: 'inline-block' }}>
        {chart}
        {geoInsetLegend}
      </div>
    ) : (
      chart
    );
  }

  // Inside a trellis cell the fixed per-cell margin (FACET_CELL_MARGIN) governs
  // layout so every cell's plot area lines up; the axes' `width/height: 'auto'`
  // (which fits labels in a standalone chart) would fight that fixed margin and
  // collapse the drawing area, so it is replaced when rendering as a cell.
  // Dropping the key outright (rather than setting a fixed number) used to fall
  // back to x-charts' own default axis size (`DEFAULT_AXIS_SIZE_WIDTH` = 45px) —
  // far short of a wide formatted number's label ("150,000,000") and short
  // enough to make the label-fit logic ellipsize it regardless of how generous
  // `cell.margin` actually is (a chart-level margin reserves the *space*, but
  // doesn't inform the axis's own label-fit measurement). Passing the cell's
  // real fixed margin as the axis's width/height instead gives that measurement
  // genuine room to work with.
  const dropAutoSize = <T extends Record<string, unknown>>(config: T, fixedSize?: number): T => {
    if (!cell) {
      return config;
    }
    const stripped: Record<string, unknown> = { ...config };
    if ('width' in stripped) {
      stripped.width = fixedSize;
    }
    if ('height' in stripped) {
      stripped.height = fixedSize;
    }
    // A trellis draws one shared axis title beside/below the grid, so each cell
    // keeps its ticks but drops the per-cell title (which would otherwise repeat
    // once per column/row).
    if (cell.hideAxisTitles) {
      stripped.label = undefined;
    }
    return stripped as T;
  };
  const xAxis = compiled.xAxis
    ? [
        rotateXLabelsIfCramped(
          dropAutoSize(compiled.xAxis.config, cell?.margin?.bottom),
          resolvedWidth,
          Boolean(compiled.yAxis),
        ),
      ]
    : undefined;
  const yAxis = compiled.yAxis
    ? [dropAutoSize(compiled.yAxis.config, cell?.margin?.left)]
    : undefined;

  // x-charts subtracts the axis's own width/height from the drawing area ON TOP
  // OF the chart margin, so a cell that hands the same allowance to both (the
  // `dropAutoSize` calls above pass `margin.left`/`margin.bottom` as the axis
  // size, precisely so the axis's label-fit measurement has real room) spends it
  // twice and halves its own plot. Measured on `trellis_bar`: a 431px cell with
  // a 108px allowance put the plot's left edge at 217px, leaving 205px of plot
  // where Vega draws 468px. The axis size is the half that both reserves space
  // and informs label fitting, so it keeps the allowance and the margin drops to
  // zero on that side. A hidden axis (`hideYAxis`/`hideXAxis` on inner cells)
  // still contributes its width, so this holds for every cell in the grid and
  // the edge/inner difference stays exactly `cellMargin.left - innerLeftMargin`.
  const cellMarginProp = cell?.margin
    ? {
        ...cell.margin,
        ...(yAxis ? { left: 0 } : null),
        ...(xAxis ? { bottom: 0 } : null),
      }
    : cell?.margin;

  // Scale-bound interval selections enable gesture zoom/pan (the axis configs
  // carry `zoom: true`, read by the Premium provider). Clip the plotting area
  // so zoomed/panned marks don't overflow the drawing area, mirroring the
  // built-in cartesian charts.
  const zoomEnabled = Boolean(compiled.zoom && (compiled.zoom.x || compiled.zoom.y) && clipId);
  const plotContent = (
    <React.Fragment>
      {/* SVG gradient fills for gradient area marks; each area series references
          its gradient by `fill: url(#id)`. Rendered in objectBoundingBox units. */}
      {compiled.gradients && compiled.gradients.length > 0 && (
        <defs>
          {compiled.gradients.map((gradient) => (
            <linearGradient
              key={gradient.id}
              id={gradient.id}
              x1={gradient.x1}
              y1={gradient.y1}
              x2={gradient.x2}
              y2={gradient.y2}
            >
              {gradient.stops.map((stop, index) => (
                <stop key={index} offset={stop.offset} stopColor={stop.color} />
              ))}
            </linearGradient>
          ))}
        </defs>
      )}
      <VegaOverlays overlays={compiled.backgroundOverlays} />
      {compiled.plots.includes('heatmap') && <HeatmapPlot />}
      {compiled.plots.includes('bar') && <BarPlot borderRadius={compiled.barBorderRadius} />}
      {compiled.plots.includes('rangeBar') && (
        <RangeBarPlot borderRadius={compiled.barBorderRadius} />
      )}
      {compiled.plots.includes('area') && <AreaPlot />}
      {compiled.plots.includes('line') && <LinePlot slotProps={lineSlotProps} />}
      {compiled.plots.includes('scatter') && <ScatterPlot slots={scatterSlots} />}
      {compiled.plots.includes('marks') && <MarkPlot />}
      {compiled.plots.includes('lineHighlight') && <LineHighlightPlot />}
      {compiled.plots.includes('pie') && <PiePlot />}
      {compiled.plots.includes('pieLabels') && <ArcLabelsPlot />}
      <VegaOverlays overlays={compiled.overlays} />
    </React.Fragment>
  );

  // A trellis renders one shared legend outside the grid: this "legend only"
  // proxy mounts the provider for the color scale and draws just the legend,
  // with no plotting surface.
  // The trellis's single hoisted legend renders through this proxy. It must be
  // checked BEFORE the geo branch below, which returns a whole chart: a geo
  // trellis would otherwise render a 1px-wide map here and no legend at all.
  // A choropleth/heatmap carries its scale on the zAxis `colorMap` rather than
  // as series entries, so the matching gradient legend is drawn for it too.
  if (cell?.legendOnly) {
    const proxyColorMap = (compiled.zAxis?.[0] as { colorMap?: { type?: string } } | undefined)
      ?.colorMap;
    return (
      <ChartsDataProviderPremium
        // A geo chart's `mapShape` series can only be processed by the GEO
        // provider; handing it to this one throws. The legend it needs reads
        // the zAxis `colorMap`, not the series, so the series are dropped.
        series={compiled.chartKind === 'geo' ? [] : seriesWithPieRadius}
        seriesConfig={SERIES_CONFIG as never}
        xAxis={xAxis}
        yAxis={yAxis}
        zAxis={compiled.zAxis}
        colors={compiled.colors.slice()}
        width={1}
        height={resolvedHeight ?? 1}
      >
        <ChartsWrapper>
          {compiled.colorLegendTitle && (
            <span style={{ fontSize: 12, fontWeight: 600 }}>{compiled.colorLegendTitle}</span>
          )}
          {proxyColorMap?.type === 'piecewise' && (
            <PiecewiseColorLegend axisDirection="z" direction="vertical" />
          )}
          {proxyColorMap && proxyColorMap.type !== 'piecewise' && (
            <ContinuousColorLegend axisDirection="z" direction="vertical" />
          )}
          {compiled.hasLegend && <ChartsLegend direction="vertical" sx={LEGEND_SX} />}
          {compiled.overlayLegend.length > 0 && <OverlayLegend items={compiled.overlayLegend} />}
        </ChartsWrapper>
      </ChartsDataProviderPremium>
    );
  }

  // A heatmap encodes its cell value through a color scale carried on the
  // zAxis colorMap; surface it so the shell can draw a gradient color legend.
  const heatmapColorMap = compiled.plots.includes('heatmap')
    ? (compiled.zAxis?.[0] as { colorMap?: { type?: string } } | undefined)?.colorMap
    : undefined;
  const seriesLegendTitle = resolveLegendTitle(spec);
  const viewStroke = resolveViewStroke(spec);
  // `legend.gradientLength` sizes the color bar ALONG its own direction, so it
  // is a width for a horizontal legend and a height for a vertical one.
  let colorLegendLengthSx: { width?: number; height?: number } | undefined;
  if (compiled.colorLegendLength !== undefined) {
    colorLegendLengthSx =
      compiled.colorLegendDirection === 'horizontal'
        ? { width: compiled.colorLegendLength }
        : { height: compiled.colorLegendLength };
  }

  const chart = (
    <ChartsDataProviderPremium
      series={seriesWithPieRadius}
      seriesConfig={SERIES_CONFIG as never}
      xAxis={xAxis}
      yAxis={yAxis}
      zAxis={compiled.zAxis}
      colors={compiled.colors.slice()}
      width={resolvedWidth}
      height={resolvedHeight}
      margin={cellMarginProp}
    >
      <ChartsWrapper
        legendPosition={legendLayout?.position}
        legendDirection={legendLayout?.direction}
      >
        {!cell?.hideLegend && compiled.hasLegend && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 2,
            }}
          >
            {/* Vega-Lite titles a series legend with the color field's name. */}
            {seriesLegendTitle && (
              <span style={{ fontSize: 11, fontWeight: 700 }}>{seriesLegendTitle}</span>
            )}
            <ChartsLegend direction={legendLayout?.direction} sx={LEGEND_SX} />
          </div>
        )}
        {/* A heatmap's cell value is encoded by a continuous/piecewise color
            scale (the zAxis colorMap), so it needs a gradient color legend
            rather than a categorical series legend (Vega-Lite's default).
            `encoding.color.legend.direction`/`gradientLength` size and orient
            it — Vega-Lite defaults to a vertical bar unless the spec asks for
            "horizontal" explicitly. */}
        {!cell?.hideLegend && heatmapColorMap && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 2,
            }}
          >
            {compiled.colorLegendTitle && (
              <span style={{ fontSize: 12, fontWeight: 600 }}>{compiled.colorLegendTitle}</span>
            )}
            {heatmapColorMap.type === 'piecewise' ? (
              <PiecewiseColorLegend
                axisDirection="z"
                direction={compiled.colorLegendDirection ?? 'vertical'}
              />
            ) : (
              <ContinuousColorLegend
                axisDirection="z"
                direction={compiled.colorLegendDirection ?? 'vertical'}
                sx={colorLegendLengthSx}
              />
            )}
          </div>
        )}
        {!cell?.hideLegend && compiled.overlayLegend.length > 0 && (
          <OverlayLegend items={compiled.overlayLegend} />
        )}
        <ChartsSurface
          title={compiled.title}
          sx={compiled.background ? { backgroundColor: compiled.background } : undefined}
        >
          {compiled.chartKind === 'cartesian' && (
            <ChartsGrid
              vertical={compiled.grid.vertical ?? false}
              horizontal={compiled.grid.horizontal ?? false}
            />
          )}
          {compiled.chartKind === 'cartesian' && viewStroke && <PlotBorder stroke={viewStroke} />}
          {zoomEnabled && <ChartsClipPath id={clipId as string} />}
          {zoomEnabled ? <g clipPath={`url(#${clipId})`}>{plotContent}</g> : plotContent}
          {compiled.chartKind === 'cartesian' && xAxis && !cell?.hideXAxis && <ChartsXAxis />}
          {compiled.chartKind === 'cartesian' && yAxis && !cell?.hideYAxis && <ChartsYAxis />}
          {compiled.chartKind === 'cartesian' && <ChartsAxisHighlight />}
          {compiled.referenceLines.map((line, index) =>
            line.axis === 'x' ? (
              <ChartsReferenceLine
                key={`x-${index}`}
                x={line.value}
                label={line.label}
                lineStyle={line.lineStyle}
              />
            ) : (
              <ChartsReferenceLine
                key={`y-${index}`}
                y={line.value}
                label={line.label}
                lineStyle={line.lineStyle}
              />
            ),
          )}
          {children}
        </ChartsSurface>
        {/* Heatmap cells have no axis-tooltip payload — use the item trigger. */}
        {tooltipFields != null ? (
          <VegaTooltip
            fields={tooltipFields}
            // Marks with no axis-tooltip payload (heatmap cells, polar/pie
            // slices) resolve their highlighted item via the item trigger.
            trigger={
              compiled.plots.includes('heatmap') || compiled.chartKind === 'polar'
                ? 'item'
                : undefined
            }
          />
        ) : (
          <ChartsTooltip trigger={compiled.plots.includes('heatmap') ? 'item' : undefined} />
        )}
      </ChartsWrapper>
    </ChartsDataProviderPremium>
  );

  // A bubble-size legend has no x-charts equivalent, so draw it beside the chart
  // (Vega-Lite's default placement). Suppressed inside trellis cells, which
  // hoist a single shared legend outside the grid.
  const chartWithLegend =
    compiled.sizeLegend && !cell ? (
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {chart}
        <SizeLegend legend={compiled.sizeLegend} color={compiled.colors[0]} />
      </div>
    ) : (
      chart
    );

  // Vega-Lite draws the spec `title` as a bold heading centered above the view.
  // x-charts' `ChartsSurface` title is only an accessibility <title>, so render
  // a visible heading here. Skipped inside trellis/concat cells (the grid draws
  // their headers) — a cell never carries the top-level title anyway.
  if (compiled.title && !cell) {
    return (
      <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'rgb(0, 0, 0)',
            padding: '0 0 4px',
            whiteSpace: 'pre-line',
            textAlign: 'center',
          }}
        >
          {compiled.title}
        </div>
        {chartWithLegend}
      </div>
    );
  }
  return chartWithLegend;
}
