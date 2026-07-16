import type { XAxis, YAxis } from '@mui/x-charts/models';
import { VEGA_TABLEAU10 } from './vegaDefaults';
import type { DatasetRow, VegaEncoding, VegaLiteSpec, VegaMarkDef } from '../types';
import { createGapCollector } from '../gaps';
import type { TranslationGap } from '../gaps';
import { normalizeSpec } from '../normalize';
import { applyTransforms, applyEncodingTransforms } from '../transforms';
import { markRegistry, UNSUPPORTED_MARK_HINTS } from '../marks';
import { forcesDiscreteBarCategory, resolveAxes } from './scales';
import { resolveParams } from './params';
import type { CompiledParamInput } from './params';
import type {
  AxisResolution,
  CompiledGeo,
  CompiledGradient,
  CompiledOverlay,
  CompiledReferenceLine,
  CompiledSeries,
  CompiledZAxis,
  OverlayLegendItem,
  PlotKind,
  SizeLegend,
  UnitContext,
} from './context';
import { applyAlpha } from './colorUtils';
import { categoryIndex, categoryKey } from './context';

export interface CompileOptions {
  data?: readonly DatasetRow[];
  datasets?: Record<string, readonly DatasetRow[]>;
  /** Categorical palette; defaults to Vega-Lite's `tableau10` scheme. */
  palette?: readonly string[];
  /** Resolved param/signal values, keyed by param name (threaded to expressions). */
  params?: Readonly<Record<string, unknown>>;
}

export interface CompiledChart {
  /** 'polar' for pie/arc rendering, 'geo' for geoshape/map rendering. */
  chartKind: 'cartesian' | 'polar' | 'geo';
  series: CompiledSeries[];
  xAxis?: AxisResolution<XAxis>;
  yAxis?: AxisResolution<YAxis>;
  /** z (color) axes (heatmap cell coloring). */
  zAxis?: CompiledZAxis[];
  /** Geo provider config, set when chartKind is 'geo'. */
  geo?: CompiledGeo;
  /** Chart background color from `spec.background`, applied by the shell. */
  background?: string;
  plots: PlotKind[];
  referenceLines: CompiledReferenceLine[];
  /** Custom-drawn output for marks with no x-charts series equivalent. */
  overlays: CompiledOverlay[];
  /** Custom legend swatches for color-split overlays (dodged box plots). */
  overlayLegend: OverlayLegendItem[];
  /** Bubble-size legend for a scatter layer with a quantitative `size` field. */
  sizeLegend?: SizeLegend;
  grid: { vertical?: boolean; horizontal?: boolean };
  hasLegend: boolean;
  colors: readonly string[];
  /**
   * Scatter series ids that render with hollow (stroke-only) markers — the
   * `point` mark's Vega-Lite default (and any `filled: false` mark). The shell
   * feeds these to a custom scatter marker slot.
   */
  hollowSeriesIds?: string[];
  /** SVG linear-gradient fills (from gradient area marks); rendered as `<defs>`. */
  gradients?: CompiledGradient[];
  /** Title drawn above a heatmap's continuous color legend. */
  colorLegendTitle?: string;
  title?: string;
  width?: number;
  height?: number;
  /** Chart-wide bar corner radius (from a bar mark's `cornerRadius`). */
  barBorderRadius?: number;
  /** Per-axis zoom/pan enablement from scale-bound interval selections. */
  zoom?: { x: boolean; y: boolean };
  /** Input-widget descriptors for bound variable params, rendered by the shell. */
  inputs?: CompiledParamInput[];
  /** Resolved param/signal values, keyed by name (variable defaults + host overrides). */
  paramValues?: Readonly<Record<string, unknown>>;
  gaps: TranslationGap[];
}

/**
 * A layer's constant opacity, from `mark.opacity`/`fillOpacity` or a value-def
 * `opacity` encoding. Returns `undefined` when absent, fully opaque, or
 * field-driven (field-driven opacity has no per-point equivalent and keeps its
 * own `encoding:opacity-field-unsupported` gap in `compile/color.ts`).
 */
function staticMarkOpacity(unit: {
  mark: VegaMarkDef;
  encoding: VegaEncoding;
}): number | undefined {
  const enc = unit.encoding.opacity;
  let encValue: number | undefined;
  if (enc && !Array.isArray(enc)) {
    // A `condition` bound to a point/interval selection is the interactive
    // "selected" appearance. Vega-Lite selections default to `empty: "all"`, so
    // with no interaction the selection matches everything and the *condition's*
    // value applies — not the `value` fallback (which is the "unselected" look).
    // We can't drive the interaction, so mirror Vega's initial render by taking
    // the condition value when present (e.g. interactive_legend: opacity 1, not
    // the 0.2 fallback that would wash the whole chart out).
    const condition = (enc as { condition?: unknown }).condition;
    const conditionValue =
      condition && !Array.isArray(condition) && typeof (condition as { value?: unknown }).value === 'number'
        ? (condition as { value: number }).value
        : undefined;
    encValue =
      conditionValue ??
      (typeof (enc as { value?: unknown }).value === 'number'
        ? (enc as { value: number }).value
        : undefined);
  }
  const raw = unit.mark.opacity ?? unit.mark.fillOpacity ?? encValue;
  return typeof raw === 'number' && raw >= 0 && raw < 1 ? raw : undefined;
}

/** Numeric values an overlay contributes to a continuous axis. */
function overlayAxisValues(overlay: CompiledOverlay, axis: 'x' | 'y'): number[] {
  const numbers = (values: Array<number | string | Date | undefined>) =>
    values.filter((value): value is number => typeof value === 'number');
  switch (overlay.kind) {
    case 'boxes': {
      const valueAxis = overlay.orientation === 'horizontal' ? 'x' : 'y';
      if (axis !== valueAxis) {
        return [];
      }
      return overlay.items.flatMap((item) => [item.min, item.max, ...(item.outliers ?? [])]);
    }
    case 'errorBars': {
      const valueAxis = overlay.orientation === 'horizontal' ? 'x' : 'y';
      if (axis !== valueAxis) {
        return [];
      }
      return overlay.items.flatMap((item) =>
        item.center === undefined
          ? [item.lower, item.upper]
          : [item.lower, item.upper, item.center],
      );
    }
    case 'band': {
      const valueAxis = overlay.orientation === 'horizontal' ? 'x' : 'y';
      return axis === valueAxis
        ? overlay.points.flatMap((point) => [point.lower, point.upper])
        : numbers(overlay.points.map((point) => point.x));
    }
    case 'segments':
      return numbers(
        overlay.items.flatMap((item) => (axis === 'x' ? [item.x1, item.x2] : [item.y1, item.y2])),
      );
    case 'text':
    case 'image':
      return numbers(overlay.items.map((item) => (axis === 'x' ? item.x : item.y)));
    default:
      return [];
  }
}

/** Numeric values a compiled series contributes to a continuous axis. */
function seriesAxisValues(entry: CompiledSeries, axis: 'x' | 'y'): number[] {
  const data = (entry as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const items = data as unknown[];
  if (entry.type === 'scatter') {
    return items
      .map((point) =>
        point && typeof point === 'object' ? (point as Record<string, unknown>)[axis] : undefined,
      )
      .filter((value): value is number => typeof value === 'number');
  }
  // line/area/bar carry a flat value array on the non-category axis: y for the
  // default vertical layout, x when the bar series is laid out horizontally.
  const valueAxis = (entry as { layout?: string }).layout === 'horizontal' ? 'x' : 'y';
  if (axis !== valueAxis) {
    return [];
  }
  return items.filter((value): value is number => typeof value === 'number');
}

/**
 * Sizes each continuous axis to cover BOTH the series data and any overlay
 * geometry (with 5% padding), so an overlay that extends past the series range
 * (e.g. an error band above the line it wraps) is not clipped at the plot edge.
 * Runs only for axes that carry overlay values; unioning the series data in
 * means the explicit min/max can only widen the domain, never clip a series.
 * Skips discrete axes and axes that already constrain their domain.
 */
function applyOverlayDomains(
  overlays: CompiledOverlay[],
  series: CompiledSeries[],
  x: AxisResolution<XAxis> | undefined,
  y: AxisResolution<YAxis> | undefined,
): void {
  const axisEntries: Array<['x' | 'y', AxisResolution<XAxis> | AxisResolution<YAxis> | undefined]> =
    [
      ['x', x],
      ['y', y],
    ];
  for (const [name, axis] of axisEntries) {
    if (!axis || axis.categories) {
      continue;
    }
    const config = axis.config as { min?: number | Date; max?: number | Date };
    // Skip only a genuinely explicit spec domain. A min/max pinned by the `zero`
    // default is not explicit, so overlay geometry may still extend the domain
    // (e.g. seed the `max` a boxplot/errorband/text overlay needs).
    if (axis.hasExplicitDomain) {
      continue;
    }
    const overlayValues = overlays.flatMap((overlay) => overlayAxisValues(overlay, name));
    if (overlayValues.length === 0) {
      continue;
    }
    const values = [...overlayValues, ...series.flatMap((entry) => seriesAxisValues(entry, name))];
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      continue;
    }
    const padding = (max - min) * 0.05;
    let domainMin = min - padding;
    let domainMax = max + padding;
    // A bar/area/line series on this axis carries Vega-Lite's `zero: true`
    // default (bars/areas also overflow below the axis without it), so the
    // domain must include 0 (and not pad past it). Point/boxplot/errorbar marks
    // default `zero: false` and fit their data, so they are deliberately
    // excluded — a layered line+errorband zeros its y (the line wins), while a
    // point+errorbar or a bare boxplot fits the data extent, matching Vega.
    // `line` covers `area` too (an area is a `type: 'line'` series with
    // `area: true`). Detect one whose value axis is this axis.
    const hasBaselineSeries = series.some((entry) => {
      const type = (entry as { type?: string }).type;
      if (type !== 'bar' && type !== 'line') {
        return false;
      }
      const valueAxis = (entry as { layout?: string }).layout === 'horizontal' ? 'x' : 'y';
      return valueAxis === name;
    });
    if (hasBaselineSeries) {
      domainMin = Math.min(domainMin, 0);
      domainMax = Math.max(domainMax, 0);
      if (min >= 0) {
        domainMin = 0;
      }
      if (max <= 0) {
        domainMax = 0;
      }
    }
    config.min = domainMin;
    config.max = domainMax;
  }
}

/**
 * Pure spec → x-charts-props compiler. Exported for tests and for hosts that
 * want to inspect the translation (including its gaps) without rendering.
 */
export function compileSpec(spec: VegaLiteSpec, options: CompileOptions = {}): CompiledChart {
  const gaps = createGapCollector();
  const palette = options.palette ?? VEGA_TABLEAU10;
  const normalized = normalizeSpec(spec, { data: options.data, datasets: options.datasets }, gaps);

  // Resolve params before the transform pass so that named variable params
  // (and bound-input defaults) are visible as signals to `calculate`/`filter`
  // expressions; host-supplied `options.params` override the spec defaults.
  const paramsRes = resolveParams(spec, gaps);
  const signals: Readonly<Record<string, unknown>> = {
    ...paramsRes.initialValues,
    ...options.params,
  };

  // Run transforms per unit first so axis domains see post-transform rows.
  const prepared = normalized.units.map((unit) => {
    const afterTopLevel = applyTransforms(unit.rows, unit.transform, gaps, unit.path, signals);
    const { rows, encoding } = applyEncodingTransforms(
      afterTopLevel,
      unit.encoding,
      gaps,
      unit.path,
      signals,
    );
    return { unit: { ...unit, encoding }, rows };
  });

  // Detect the bar-with-quantitative-category case from the PRE-transform units:
  // the encoding aggregate pass above strips the `aggregate` marker off the
  // value channel, which is the signal `forcesDiscreteBarCategory` relies on to
  // tell the value axis from the category axis. So compute the flags against the
  // original encodings and hand them to `resolveAxes`.
  const preUnits = normalized.units.map((unit) => ({ unit, rows: unit.rows }));
  const axes = resolveAxes(prepared, gaps, normalized.resolve, {
    x: forcesDiscreteBarCategory('x', preUnits),
    y: forcesDiscreteBarCategory('y', preUnits),
  });

  const series: CompiledSeries[] = [];
  const plots = new Set<PlotKind>();
  const referenceLines: CompiledReferenceLine[] = [];
  const overlays: CompiledOverlay[] = [];
  const overlayLegend: OverlayLegendItem[] = [];
  const zAxis: CompiledZAxis[] = [];
  const hollowSeriesIds: string[] = [];
  const gradients: CompiledGradient[] = [];
  let colorLegendTitle: string | undefined;
  let sizeLegend: SizeLegend | undefined;
  let geo: CompiledGeo | undefined;
  let barBorderRadius: number | undefined;
  // Static opacity per series index (from the originating layer's mark), applied
  // as an alpha on the resolved color after palette assignment below.
  const seriesOpacity: Array<number | undefined> = [];

  for (const { unit, rows } of prepared) {
    const compiler = markRegistry[unit.mark.type];
    if (!compiler) {
      gaps.add({
        code: `mark:${unit.mark.type}`,
        message:
          UNSUPPORTED_MARK_HINTS[unit.mark.type] ??
          `Mark type "${unit.mark.type}" has no x-charts equivalent; the layer was dropped.`,
        severity: 'unsupported',
        path: unit.path,
      });
      continue;
    }
    const ctx: UnitContext = {
      unit,
      rows,
      encoding: unit.encoding,
      x: axes.x,
      y: axes.y,
      gaps,
      palette,
      signals,
      categoryIndex,
      categoryKey,
    };
    const before = series.length;
    const compiled = compiler(ctx);
    series.push(...compiled.series);
    // Record this layer's static opacity against the series it produced, so it
    // can be baked into the resolved color once palette colors are assigned.
    const opacity = staticMarkOpacity(unit);
    if (opacity !== undefined) {
      for (let i = before; i < series.length; i += 1) {
        seriesOpacity[i] = opacity;
      }
    }
    compiled.plots.forEach((plot) => plots.add(plot));
    referenceLines.push(...(compiled.referenceLines ?? []));
    overlays.push(...(compiled.overlays ?? []));
    overlayLegend.push(...(compiled.overlayLegend ?? []));
    // First layer with a bubble-size legend wins (one size scale per chart).
    if (compiled.sizeLegend && !sizeLegend) {
      sizeLegend = compiled.sizeLegend;
    }
    zAxis.push(...(compiled.zAxis ?? []));
    hollowSeriesIds.push(...(compiled.hollowSeriesIds ?? []));
    gradients.push(...(compiled.gradients ?? []));
    if (compiled.colorLegendTitle && colorLegendTitle === undefined) {
      colorLegendTitle = compiled.colorLegendTitle;
    }
    // Bar corner radius is a chart-wide BarPlot prop, so the first layer that
    // requests one wins; a conflicting later request is reported as a gap.
    if (compiled.barBorderRadius !== undefined) {
      if (barBorderRadius === undefined) {
        barBorderRadius = compiled.barBorderRadius;
      } else if (barBorderRadius !== compiled.barBorderRadius) {
        gaps.add({
          code: 'mark:bar-corner-radius-conflict',
          message:
            'Multiple bar layers request different corner radii, but borderRadius is ' +
            'chart-wide; the first requested value is used for all bars.',
          severity: 'partial',
          path: unit.path,
        });
      }
    }
    if (compiled.geo) {
      if (geo) {
        gaps.add({
          code: 'composition:multiple-geo-layers',
          message:
            "Multiple geoshape layers each carry their own geo data; only the first layer's geoData/projection is used for the map.",
          severity: 'partial',
          path: unit.path,
        });
      } else {
        geo = compiled.geo;
      }
    }
  }

  // Assign palette colors to series that didn't get an explicit color. Pie
  // slices color themselves per-datum; heatmap cells are colored by the
  // zAxis colorMap and have no series-level color at all.
  series.forEach((entry, index) => {
    if (entry.type === 'pie' || entry.type === 'heatmap') {
      return;
    }
    const colorable = entry as { color?: string };
    if (colorable.color === undefined) {
      colorable.color = palette[index % palette.length];
    }
    // Bake a static mark opacity into the (now-resolved) color — x-charts has
    // no per-series opacity prop, so alpha on the color is the equivalent.
    const opacity = seriesOpacity[index];
    if (opacity !== undefined && typeof colorable.color === 'string') {
      colorable.color = applyAlpha(colorable.color, opacity);
    }
  });

  const isGeo = geo !== undefined;
  const isPolar = !isGeo && plots.has('pie');
  const exclusiveKinds: PlotKind[] = ['geoBase', 'mapShape', 'pie', 'pieLabels'];
  if ((isPolar || isGeo) && plots.size > (isGeo ? 2 : 1)) {
    const kind = isGeo ? 'geo/map' : 'pie/arc';
    if (Array.from(plots).some((plot) => !exclusiveKinds.includes(plot))) {
      gaps.add({
        code: `composition:mixed-${isGeo ? 'geo' : 'polar'}-cartesian`,
        message: `${kind} layers cannot be combined with cartesian layers in one chart; only the ${kind} layers are rendered.`,
        severity: 'partial',
        path: '$',
      });
    }
  }

  // Size continuous axes to cover overlay geometry as well as series data:
  // an overlay-only chart (standalone boxplot/errorbar/segment) would otherwise
  // collapse to a degenerate domain, and an overlay layered over a series (an
  // error band above its line) would otherwise be clipped where it extends past
  // the series range. Unioning the series data in keeps series from clipping.
  if (overlays.length > 0) {
    applyOverlayDomains(overlays, series, axes.x, axes.y);
  }

  // Point-selection params map onto x-charts' controlled item highlighting;
  // apply the resolved scope to every series that doesn't set its own.
  if (paramsRes.highlightScope) {
    series.forEach((entry) => {
      const scoped = entry as { highlightScope?: unknown };
      if (scoped.highlightScope === undefined) {
        scoped.highlightScope = paramsRes.highlightScope;
      }
    });
  }

  // Pie series carry their labels per-slice (`data[i].label`) rather than on
  // the series object, so both locations must count toward showing a legend.
  const hasLegend = series.some((entry) => {
    if ((entry as { label?: unknown }).label !== undefined) {
      return true;
    }
    if (entry.type === 'pie') {
      const data = (entry as { data?: ReadonlyArray<{ label?: unknown }> }).data;
      return data?.some((item) => item.label !== undefined) ?? false;
    }
    return false;
  });

  let chartKind: CompiledChart['chartKind'] = 'cartesian';
  let outSeries = series;
  if (isGeo) {
    chartKind = 'geo';
    outSeries = series.filter((entry) => entry.type === 'mapShape');
  } else if (isPolar) {
    chartKind = 'polar';
    outSeries = series.filter((entry) => entry.type === 'pie');
  }
  const isCartesian = chartKind === 'cartesian';

  // Scale-bound interval selections map to gesture zoom/pan: flag the per-axis
  // `zoom` on the axis config (the Premium provider's zoom plugin reads it).
  // Zoom only applies to cartesian charts; a polar/geo request is a gap.
  if (paramsRes.zoom) {
    if (isCartesian) {
      if (paramsRes.zoom.x && axes.x) {
        (axes.x.config as XAxis & { zoom?: boolean }).zoom = true;
      }
      if (paramsRes.zoom.y && axes.y) {
        (axes.y.config as YAxis & { zoom?: boolean }).zoom = true;
      }
    } else {
      gaps.add({
        code: 'param:interval-scales-noncartesian',
        message:
          "A scale-bound interval selection (`bind: 'scales'`) requests zoom/pan, but this chart renders in a polar/geo coordinate system where x-charts' cartesian axis zoom does not apply; the binding was ignored.",
        severity: 'partial',
        path: '$',
      });
    }
  }

  return {
    chartKind,
    series: outSeries,
    xAxis: isCartesian ? axes.x : undefined,
    yAxis: isCartesian ? axes.y : undefined,
    zAxis: zAxis.length > 0 ? zAxis : undefined,
    geo,
    background: typeof spec.background === 'string' ? spec.background : undefined,
    plots: Array.from(plots),
    referenceLines,
    overlays,
    overlayLegend,
    sizeLegend,
    grid: axes.grid,
    hasLegend,
    colors: palette,
    hollowSeriesIds: hollowSeriesIds.length > 0 ? hollowSeriesIds : undefined,
    gradients: gradients.length > 0 ? gradients : undefined,
    colorLegendTitle,
    title: normalized.title,
    width: normalized.width,
    height: normalized.height,
    barBorderRadius,
    // Zoom is a cartesian-only capability; a scale binding on a polar/geo chart
    // was already reported as a gap above and must not reach the renderer.
    zoom: isCartesian ? paramsRes.zoom : undefined,
    inputs: paramsRes.inputs,
    paramValues: signals,
    gaps: gaps.list(),
  };
}
