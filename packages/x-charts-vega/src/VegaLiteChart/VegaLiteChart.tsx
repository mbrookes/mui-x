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
import type { DatasetRow, VegaFieldDef, VegaLiteSpec } from '../types';
import type { TranslationGap } from '../gaps';
import { compileSpec } from '../compile';
import { collectBindInputs } from '../compile/params';
import { VegaOverlays, ArcLabelsPlot } from '../overlays';
import { MAX_FACET_DEPTH, planFacets, resolveGridSize } from '../facet';
import { ParamInputs } from './ParamInputs';
import { OverlayLegend } from './OverlayLegend';
import { VegaTooltip, resolveTooltipFields } from './VegaTooltip';

type LegendLayout = { position: Position; direction: 'horizontal' | 'vertical' };

/**
 * Maps a Vega-Lite color-legend `orient` to the x-charts wrapper's legend
 * placement (`legendPosition` + `legendDirection`, the mechanism that actually
 * moves the composed HTML legend — `<ChartsLegend>` itself drops a `position`
 * prop). Returns `undefined` for unset / unsupported orients so the default
 * placement is preserved.
 */
function resolveLegendLayout(orient: string | undefined): LegendLayout | undefined {
  switch (orient) {
    case 'top':
      return { position: { vertical: 'top', horizontal: 'center' }, direction: 'horizontal' };
    case 'bottom':
      return { position: { vertical: 'bottom', horizontal: 'center' }, direction: 'horizontal' };
    case 'left':
      return { position: { vertical: 'middle', horizontal: 'start' }, direction: 'vertical' };
    case 'right':
      return { position: { vertical: 'middle', horizontal: 'end' }, direction: 'vertical' };
    default:
      return undefined;
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
  /** Overrides `spec.width`. Without either, the chart fills its container. */
  width?: number;
  /** Overrides `spec.height`. */
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
  const { spec, data, datasets, width, height, colors, onGaps, children } = props;
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
    content = (
      <FacetDepthContext.Provider value={depth + 1}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${plan.columns}, minmax(0, 1fr))`,
            gap: 8,
            width: gridSize.width,
          }}
        >
          {plan.cells.map((cell) => (
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
                width={cell.width}
                height={cell.height}
                colors={colors}
                onGaps={handleCellGaps}
              />
            </div>
          ))}
        </div>
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
  const { spec, data, datasets, width, height, colors, onGaps, children } = props;
  const paramCtx = React.useContext(VegaParamsContext);
  const paramValues = paramCtx?.values;

  const compiled = React.useMemo(
    () => compileSpec(spec, { data, datasets, palette: colors, params: paramValues }),
    [spec, data, datasets, colors, paramValues],
  );
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

  const resolvedWidth = width ?? compiled.width;
  const resolvedHeight = height ?? compiled.height;

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
    let geoLegend: React.ReactNode;
    if (geoColorMap?.type === 'piecewise') {
      geoLegend = <PiecewiseColorLegend axisDirection="z" />;
    } else if (geoColorMap) {
      geoLegend = <ContinuousColorLegend axisDirection="z" />;
    } else {
      geoLegend = compiled.hasLegend && <ChartsLegend />;
    }
    return (
      <ChartsGeoDataProviderPremium
        geoData={compiled.geo?.geoData as never}
        projection={compiled.geo?.projection as never}
        rotate={compiled.geo?.rotate as never}
        scale={compiled.geo?.scale as never}
        translate={compiled.geo?.translate as never}
        series={compiled.series as never}
        zAxis={compiled.zAxis as never}
        colors={compiled.colors.slice()}
        width={resolvedWidth}
        height={resolvedHeight}
      >
        <ChartsWrapper>
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

  const xAxis = compiled.xAxis ? [compiled.xAxis.config] : undefined;
  const yAxis = compiled.yAxis ? [compiled.yAxis.config] : undefined;

  // Scale-bound interval selections enable gesture zoom/pan (the axis configs
  // carry `zoom: true`, read by the Premium provider). Clip the plotting area
  // so zoomed/panned marks don't overflow the drawing area, mirroring the
  // built-in cartesian charts.
  const zoomEnabled = Boolean(compiled.zoom && (compiled.zoom.x || compiled.zoom.y) && clipId);
  const plotContent = (
    <React.Fragment>
      {compiled.plots.includes('heatmap') && <HeatmapPlot />}
      {compiled.plots.includes('bar') && <BarPlot borderRadius={compiled.barBorderRadius} />}
      {compiled.plots.includes('rangeBar') && (
        <RangeBarPlot borderRadius={compiled.barBorderRadius} />
      )}
      {compiled.plots.includes('area') && <AreaPlot />}
      {compiled.plots.includes('line') && <LinePlot />}
      {compiled.plots.includes('scatter') && <ScatterPlot />}
      {compiled.plots.includes('marks') && <MarkPlot />}
      {compiled.plots.includes('lineHighlight') && <LineHighlightPlot />}
      {compiled.plots.includes('pie') && <PiePlot />}
      {compiled.plots.includes('pieLabels') && <ArcLabelsPlot />}
      <VegaOverlays overlays={compiled.overlays} />
    </React.Fragment>
  );

  return (
    <ChartsDataProviderPremium
      series={compiled.series}
      seriesConfig={SERIES_CONFIG as never}
      xAxis={xAxis}
      yAxis={yAxis}
      zAxis={compiled.zAxis}
      colors={compiled.colors.slice()}
      width={resolvedWidth}
      height={resolvedHeight}
    >
      <ChartsWrapper
        legendPosition={legendLayout?.position}
        legendDirection={legendLayout?.direction}
      >
        {compiled.hasLegend && <ChartsLegend direction={legendLayout?.direction} />}
        {compiled.overlayLegend.length > 0 && <OverlayLegend items={compiled.overlayLegend} />}
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
          {compiled.chartKind === 'cartesian' && xAxis && <ChartsXAxis />}
          {compiled.chartKind === 'cartesian' && yAxis && <ChartsYAxis />}
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
}
