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
import useId from '@mui/utils/useId';
import type { Position } from '@mui/x-charts/models';
import type { DatasetRow, VegaChannelDef, VegaFieldDef, VegaLiteSpec } from '../types';
import { isFieldDef } from '../types';
import type { TranslationGap } from '../gaps';
import { compileSpec } from '../compile';
import { collectBindInputs } from '../compile/params';
import { VegaOverlays, ArcLabelsPlot } from '../overlays';
import { MAX_FACET_DEPTH, planFacets, resolveGridSize } from '../facet';
import { ParamInputs } from './ParamInputs';
import { OverlayLegend } from './OverlayLegend';
import { SizeLegend } from './SizeLegend';
import { VegaTooltip, resolveTooltipFields } from './VegaTooltip';
import { createHollowScatterMarker } from './HollowScatterMarker';

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

// A uniform drawing-area margin for every trellis cell so their plot areas line
// up even though only the edge cells draw axis labels (matching Vega-Lite, where
// faceted cells share one x/y axis). The left/bottom reserve room for the shared
// axis labels; inner cells keep the space empty.
const FACET_CELL_MARGIN = { top: 6, right: 8, bottom: 34, left: 52 };

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
const Y_AXIS_BASE_ALLOWANCE = 72;
// x-axis: title + tick marks + one horizontal label row. x-charts' `height:'auto'`
// axis reserves a generous bottom band (plus a small top pad), so this is sized
// to let the plot survive it rather than the tighter space a label row implies.
const X_AXIS_BASE_ALLOWANCE = 88;
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
    xAxis?: { config: { scaleType?: string; data?: readonly unknown[] } };
    yAxis?: { config: { scaleType?: string; data?: readonly unknown[] } };
  },
  fallbackWidth: number | undefined,
  fallbackHeight: number | undefined,
): { width: number | undefined; height: number | undefined } {
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
    const units = Array.isArray(spec.layer) ? spec.layer : [spec];
    return units.some((unit) => (unit as { encoding?: Record<string, unknown> }).encoding?.[channel] != null);
  };
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
      (scaleType === 'band' || scaleType === 'point') && !isBinned(channel) && channelEncoded(channel);
    const count = axis?.config.data?.length ?? 0;
    if (isDiscrete && count > 0) {
      const step =
        size && typeof size === 'object' && typeof (size as { step?: unknown }).step === 'number'
          ? (size as { step: number }).step
          : VEGA_DEFAULT_STEP;
      return step * count;
    }
    return fallback;
  };
  const width = plotSize(spec.width, compiled.xAxis, fallbackWidth, 'x');
  const height = plotSize(spec.height as VegaLiteSpec['width'], compiled.yAxis, fallbackHeight, 'y');
  return {
    // Only pad when there's an axis to reserve space for (skip pie/arc/geo).
    width:
      width !== undefined && compiled.yAxis ? width + yAxisAllowance(compiled.yAxis.config) : width,
    height: height !== undefined && compiled.xAxis ? height + X_AXIS_BASE_ALLOWANCE : height,
  };
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
    const innerLeftMargin = FACET_CELL_MARGIN.right;
    const innerBottomMargin = FACET_CELL_MARGIN.top;
    const leftReduction = FACET_CELL_MARGIN.left - innerLeftMargin;
    const bottomReduction = FACET_CELL_MARGIN.bottom - innerBottomMargin;
    const leftTrackWidth = plan.cells[0]?.width;
    const innerTrackWidth =
      leftTrackWidth !== undefined ? leftTrackWidth - leftReduction : undefined;
    const gridTemplateColumns =
      shared && leftTrackWidth !== undefined && innerTrackWidth !== undefined
        ? plan.columns > 1
          ? `${leftTrackWidth}px repeat(${plan.columns - 1}, ${innerTrackWidth}px)`
          : `${leftTrackWidth}px`
        : leftTrackWidth !== undefined
          ? `repeat(${plan.columns}, ${leftTrackWidth}px)`
          : `repeat(${plan.columns}, minmax(0, 1fr))`;
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
                  ...FACET_CELL_MARGIN,
                  left: isLeftColumn ? FACET_CELL_MARGIN.left : innerLeftMargin,
                  bottom: hasCellBelow ? innerBottomMargin : FACET_CELL_MARGIN.bottom,
                },
              }
            : undefined;
          // Shrink inner cells by exactly the margin they dropped so their plot
          // area matches the labeled edge cells' plots.
          const cellWidth =
            shared && !isLeftColumn ? cell.width - leftReduction : cell.width;
          const cellHeight =
            shared && hasCellBelow ? cell.height - bottomReduction : cell.height;
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

  // A custom scatter marker slot that draws hollow (stroke-only) circles for the
  // `point`-mark / `filled: false` series the compiler flagged, matching
  // Vega-Lite's default point style. Kept stable across renders so x-charts does
  // not remount every marker; unset when no series need it.
  const scatterSlots = React.useMemo(() => {
    if (!compiled.hollowSeriesIds || compiled.hollowSeriesIds.length === 0) {
      return undefined;
    }
    return { marker: createHollowScatterMarker(new Set(compiled.hollowSeriesIds)) };
  }, [compiled.hollowSeriesIds]);

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

  if (compiled.chartKind === 'geo') {
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
    const geoColorTitle = isFieldDef(spec.encoding?.color)
      ? spec.encoding?.color.field
      : undefined;
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
    if (geoColorMap?.type === 'piecewise') {
      geoLegend = withGeoLegendTitle(<PiecewiseColorLegend axisDirection="z" direction="vertical" />);
    } else if (geoColorMap) {
      geoLegend = withGeoLegendTitle(
        <ContinuousColorLegend
          axisDirection="z"
          direction="vertical"
          {...(geoColorLabel ? { minLabel: geoColorLabel, maxLabel: geoColorLabel } : {})}
        />,
      );
    } else {
      geoLegend = compiled.hasLegend && <ChartsLegend />;
    }
    return (
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
          {geoLegend}
          <ChartsSurface title={compiled.title}>
            {compiled.plots.includes('geoBase') && <GeoDataPlot />}
            {compiled.plots.includes('mapShape') && <MapShapePlot />}
            {children}
          </ChartsSurface>
          <ChartsTooltip trigger="item" />
        </ChartsWrapper>
      </ChartsGeoDataProviderPremium>
    );
  }

  // Inside a trellis cell the fixed per-cell margin (FACET_CELL_MARGIN) governs
  // layout so every cell's plot area lines up; the axes' `width/height: 'auto'`
  // (which fits labels in a standalone chart) would fight that fixed margin and
  // collapse the drawing area, so it is stripped when rendering as a cell.
  const dropAutoSize = <T extends Record<string, unknown>>(config: T): T => {
    if (!cell) {
      return config;
    }
    const stripped: Record<string, unknown> = { ...config };
    delete stripped.width;
    delete stripped.height;
    // A trellis draws one shared axis title beside/below the grid, so each cell
    // keeps its ticks but drops the per-cell title (which would otherwise repeat
    // once per column/row).
    if (cell.hideAxisTitles) {
      stripped.label = undefined;
    }
    return stripped as T;
  };
  const xAxis = compiled.xAxis ? [dropAutoSize(compiled.xAxis.config)] : undefined;
  const yAxis = compiled.yAxis ? [dropAutoSize(compiled.yAxis.config)] : undefined;

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
      {compiled.plots.includes('heatmap') && <HeatmapPlot />}
      {compiled.plots.includes('bar') && <BarPlot borderRadius={compiled.barBorderRadius} />}
      {compiled.plots.includes('rangeBar') && (
        <RangeBarPlot borderRadius={compiled.barBorderRadius} />
      )}
      {compiled.plots.includes('area') && <AreaPlot />}
      {compiled.plots.includes('line') && <LinePlot />}
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
  if (cell?.legendOnly) {
    return (
      <ChartsDataProviderPremium
        series={compiled.series}
        seriesConfig={SERIES_CONFIG as never}
        xAxis={xAxis}
        yAxis={yAxis}
        zAxis={compiled.zAxis}
        colors={compiled.colors.slice()}
        width={1}
        height={resolvedHeight ?? 1}
      >
        <ChartsWrapper>
          {compiled.hasLegend && <ChartsLegend direction="vertical" />}
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

  const chart = (
    <ChartsDataProviderPremium
      series={compiled.series}
      seriesConfig={SERIES_CONFIG as never}
      xAxis={xAxis}
      yAxis={yAxis}
      zAxis={compiled.zAxis}
      colors={compiled.colors.slice()}
      width={resolvedWidth}
      height={resolvedHeight}
      margin={cell?.margin}
    >
      <ChartsWrapper
        legendPosition={legendLayout?.position}
        legendDirection={legendLayout?.direction}
      >
        {!cell?.hideLegend && compiled.hasLegend && (
          <ChartsLegend direction={legendLayout?.direction} />
        )}
        {/* A heatmap's cell value is encoded by a continuous/piecewise color
            scale (the zAxis colorMap), so it needs a gradient color legend
            rather than a categorical series legend (Vega-Lite's default). */}
        {!cell?.hideLegend && heatmapColorMap && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            {compiled.colorLegendTitle && (
              <span style={{ fontSize: 12, fontWeight: 600 }}>{compiled.colorLegendTitle}</span>
            )}
            {heatmapColorMap.type === 'piecewise' ? (
              <PiecewiseColorLegend axisDirection="z" direction="vertical" />
            ) : (
              <ContinuousColorLegend axisDirection="z" direction="vertical" />
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
  if (compiled.sizeLegend && !cell) {
    return (
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {chart}
        <SizeLegend legend={compiled.sizeLegend} color={compiled.colors[0]} />
      </div>
    );
  }
  return chart;
}
