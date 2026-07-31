import type { XAxis, YAxis } from '@mui/x-charts/models';
import { scaleLinear, scaleLog, scalePow, scaleSqrt } from '@mui/x-charts-vendor/d3-scale';
import { VEGA_TABLEAU10 } from './vegaDefaults';
import type { DatasetRow, VegaEncoding, VegaLiteSpec, VegaMarkDef } from '../types';
import { isFieldDef } from '../types';
import { createGapCollector } from '../gaps';
import type { TranslationGap } from '../gaps';
import { normalizeSpec } from '../normalize';
import { applyTransforms, applyEncodingTransforms } from '../transforms';
import { staticSelectionTest } from '../transforms/filter';
import { markRegistry, UNSUPPORTED_MARK_HINTS } from '../marks';
import { forcesDiscreteBarCategory, resolveAxes } from './scales';
import { resolveParams } from './params';
import type { CompiledParamInput, SelectionStates } from './params';
import type {
  AxisResolution,
  CompiledGeo,
  CompiledGradient,
  CompiledOverlay,
  CompiledReferenceLine,
  CompiledSeries,
  CompiledUnit,
  CompiledZAxis,
  OverlayLegendItem,
  OverlayPosition,
  PlotKind,
  SizeLegend,
  UnitContext,
} from './context';
import { applyAlpha } from './colorUtils';
import { categoryIndex, categoryKey } from './context';

/**
 * Rounds a continuous [min, max] extent to "nice" round numbers the same way
 * Vega-Lite/d3 do (`d3.scaleLinear(domain).nice()`), so a compile-time domain
 * we compute ourselves (see `applyOverlayDomains`) reads like the reference
 * instead of stopping at an arbitrary padded float. symlog has no direct d3
 * scale export here, so it falls back to a linear approximation.
 */
const NICE_SCALE_BUILDERS: Record<string, typeof scaleLinear> = {
  log: scaleLog as typeof scaleLinear,
  pow: scalePow as typeof scaleLinear,
  sqrt: scaleSqrt as typeof scaleLinear,
};

function niceContinuousDomain(
  scaleType: string | undefined,
  min: number,
  max: number,
): [number, number] {
  const build = (scaleType && NICE_SCALE_BUILDERS[scaleType]) || scaleLinear;
  const [niceMin, niceMax] = build([min, max], [0, 1]).nice().domain();
  return [niceMin, niceMax];
}

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
  /** Custom-drawn output for marks with no x-charts series equivalent, drawn AFTER the native plots. */
  overlays: CompiledOverlay[];
  /**
   * Custom-drawn output produced entirely before any series-contributing
   * layer, drawn BEFORE the native plots — so an early background mark
   * (e.g. the ternary chart's filled wedges) doesn't paint over a later
   * layer's markers. The shell can only stack overlays as one group before
   * the plots and one after; see the split logic in `compileSpec`.
   */
  backgroundOverlays: CompiledOverlay[];
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
  /**
   * A stroke override (color + width) for solid-filled scatter markers, keyed
   * by series id — a `point`/`circle` mark with an explicit `mark.stroke`
   * alongside a fill. The shell feeds these to the same custom scatter
   * marker slot as `hollowSeriesIds`.
   */
  markerStroke?: Record<string, { color: string; width?: number }>;
  /**
   * Per-series line-path styling (`strokeWidth`/`strokeDasharray`/`stroke`),
   * keyed by series id — x-charts' line series has no such prop, so the shell
   * feeds these through `<LinePlot slotProps={{line: ...}}>`, which forwards
   * arbitrary SVG props to the underlying `<path>` per series.
   */
  lineStyle?: Record<string, { strokeWidth?: number; strokeDasharray?: string; stroke?: string }>;
  /** SVG linear-gradient fills (from gradient area marks); rendered as `<defs>`. */
  gradients?: CompiledGradient[];
  /** Title drawn above a heatmap's continuous color legend. */
  colorLegendTitle?: string;
  /** `encoding.color.legend.direction` — Vega-Lite defaults a continuous/piecewise color legend to a vertical gradient bar; an explicit `"horizontal"` renders it as a wide bar instead. */
  colorLegendDirection?: 'horizontal' | 'vertical';
  /** `encoding.color.legend.gradientLength` — the gradient bar's length (px) along its direction. */
  colorLegendLength?: number;
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
function staticMarkOpacity(
  unit: {
    mark: VegaMarkDef;
    encoding: VegaEncoding;
  },
  selections?: SelectionStates,
): number | undefined {
  const enc = unit.encoding.opacity;
  let encValue: number | undefined;
  if (enc && !Array.isArray(enc)) {
    // A `condition` bound to a point/interval selection is the interactive
    // "selected" appearance. Vega-Lite selections default to `empty: "all"`, so
    // with no interaction the selection matches everything and the *condition's*
    // value applies — not the `value` fallback (which is the "unselected" look).
    // So the condition value is the right default (e.g. interactive_legend:
    // opacity 1, not the 0.2 fallback that would wash the whole chart out).
    //
    // But when the test is bound to selections declaring `empty: false`, an
    // empty selection matches NOTHING and the base `value` applies instead —
    // that is settled by the spec, so resolve it rather than assume. It is what
    // keeps `interactive_global_development`'s country trails hidden (their
    // `value: 0`) until something is actually hovered, instead of painting
    // every trajectory over the chart at 0.8.
    const condition = (enc as { condition?: unknown }).condition;
    const conditionTest =
      condition && !Array.isArray(condition) ? (condition as { test?: unknown }).test : undefined;
    const testResult = staticSelectionTest(conditionTest, selections);
    const conditionValue =
      testResult !== false &&
      condition &&
      !Array.isArray(condition) &&
      typeof (condition as { value?: unknown }).value === 'number'
        ? (condition as { value: number }).value
        : undefined;
    encValue =
      conditionValue ??
      (typeof (enc as { value?: unknown }).value === 'number'
        ? (enc as { value: number }).value
        : undefined);
  }
  // Vega-Lite's default config gives `point`/`circle`/`square` marks a 0.7
  // opacity out of the box (so overlapping scatter/bubble points stay
  // visible) — an explicit `mark.opacity`/`fillOpacity`/`encoding.opacity`
  // still overrides it either way.
  const markTypeDefault =
    unit.mark.type === 'point' || unit.mark.type === 'circle' || unit.mark.type === 'square'
      ? 0.7
      : undefined;
  const raw = unit.mark.opacity ?? unit.mark.fillOpacity ?? encValue ?? markTypeDefault;
  return typeof raw === 'number' && raw >= 0 && raw < 1 ? raw : undefined;
}

/**
 * Fold a layer's constant opacity into the colors of the overlays it produced,
 * mutating them in place (they were just built by this layer's mark compiler
 * and are not shared).
 *
 * Overlays paint plain SVG with colors they resolved themselves, so they never
 * reach `compile/index.ts`'s series-palette pass where `seriesOpacity` is
 * applied — the alpha has to be folded in here instead. Colors live in a small
 * set of well-known places: a `style` object's `fill`/`stroke` (segments, text,
 * geo overlays), the same names directly on an item (rects, geoShapes), or a
 * `color` field (boxes, error bars). Anything else is left alone rather than
 * guessed at.
 */
function applyOverlayOpacity(overlays: CompiledOverlay[] | undefined, opacity: number): void {
  if (!overlays || overlays.length === 0) {
    return;
  }
  const COLOR_KEYS = ['fill', 'stroke', 'color'] as const;
  const tint = (holder: Record<string, unknown> | undefined) => {
    if (!holder) {
      return;
    }
    for (const key of COLOR_KEYS) {
      const value = holder[key];
      if (typeof value === 'string' && value !== 'none') {
        holder[key] = applyAlpha(value, opacity);
      }
    }
  };
  // A text overlay renders <text> with no explicit fill, so its color is SVG's
  // implicit black. There is nothing for `tint` to modify, and the opacity
  // would be dropped — `interactive_global_development`'s year watermark asks
  // for `mark.opacity: 0.06` and would otherwise paint solid black. Making that
  // implicit default explicit is exact, not a guess.
  const isText = (kind: unknown) => kind === 'text' || kind === 'geoText';
  for (const overlay of overlays) {
    tint(overlay as unknown as Record<string, unknown>);
    const items = (overlay as { items?: unknown }).items;
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const record = item as Record<string, unknown>;
      tint(record);
      const style = record.style as Record<string, unknown> | undefined;
      tint(style);
      if (isText((overlay as { kind?: unknown }).kind) && style?.fill === undefined) {
        record.style = { ...(style ?? {}), fill: applyAlpha('rgb(0, 0, 0)', opacity) };
      }
    }
  }
}

/** Numeric values an overlay contributes to a continuous axis. */
function overlayAxisValues(overlay: CompiledOverlay, axis: 'x' | 'y'): number[] {
  // A literal `OverlayPixelPosition` (`{pixel: N}`) is a plot-area pixel
  // offset, not a data value, so it's excluded here the same as a string/Date
  // — it must never widen a continuous axis' computed domain.
  const numbers = (values: Array<number | string | Date | OverlayPosition | undefined>) =>
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
    case 'rects':
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
 * geometry, then rounds that extent to nice round numbers (`niceContinuousDomain`),
 * so an overlay that extends past the series range (e.g. an error band above the
 * line it wraps) is not clipped at the plot edge AND the axis still ends on a
 * clean tick like Vega's own nice-scaled domain, rather than an arbitrary raw
 * float. Runs only for axes that carry overlay values; unioning the series data
 * in means the explicit min/max can only widen the domain, never clip a series.
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
    let domainMin = min;
    let domainMax = max;
    const scaleType = (axis.config as { scaleType?: string }).scaleType;
    // A bar/area/line series on this axis carries Vega-Lite's `zero: true`
    // default (bars/areas also overflow below the axis without it), so the
    // domain must include 0. Point/boxplot/errorbar marks default `zero: false`
    // and fit their data, so they are deliberately excluded — a layered
    // line+errorband zeros its y (the line wins), while a point+errorbar or a
    // bare boxplot fits the data extent, matching Vega. `line` covers `area`
    // too (an area is a `type: 'line'` series with `area: true`). Detect one
    // whose value axis is this axis. A log scale can never include 0 (log(0)
    // is undefined) — Vega-Lite itself requires `zero: false` there, so the
    // zero default never applies regardless of mark type (`layer_line_window`'s
    // log-scaled fps axis: pinning it to 0 fed `d3.scaleLog` an invalid
    // [0, max] domain, degenerating to a totally blank chart).
    const hasBaselineSeries =
      scaleType !== 'log' &&
      (series.some((entry) => {
        const type = (entry as { type?: string }).type;
        if (type !== 'bar' && type !== 'line') {
          return false;
        }
        const valueAxis = (entry as { layout?: string }).layout === 'horizontal' ? 'x' : 'y';
        return valueAxis === name;
      }) ||
        // A continuous-x `line`/`trail` mark carries the same zero:true default
        // but renders through a `segments` overlay (no index-aligned category
        // domain for a native x-charts line series) — its value axis is always
        // y (see `buildContinuousLineOverlay`).
        (name === 'y' &&
          overlays.some((overlay) => overlay.kind === 'segments' && overlay.lineMarkZeroBaseline)));
    if (hasBaselineSeries) {
      domainMin = Math.min(domainMin, 0);
      domainMax = Math.max(domainMax, 0);
    }
    [domainMin, domainMax] = niceContinuousDomain(scaleType, domainMin, domainMax);
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
    const afterTopLevel = applyTransforms(
      unit.rows,
      unit.transform,
      gaps,
      unit.path,
      signals,
      normalized.datasets,
      paramsRes.selections,
    );
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
  const configAxis = (spec.config as { axis?: { grid?: unknown; disable?: unknown } } | undefined)
    ?.axis;
  const configAxisGrid = typeof configAxis?.grid === 'boolean' ? configAxis.grid : undefined;
  const configAxisDisable = configAxis?.disable === true;
  const axes = resolveAxes(
    prepared,
    gaps,
    normalized.resolve,
    {
      x: forcesDiscreteBarCategory('x', preUnits),
      y: forcesDiscreteBarCategory('y', preUnits),
    },
    configAxisGrid,
    configAxisDisable,
  );

  // Union rows across sibling units that resolve `color`/`fill`/`stroke` to the
  // SAME field name (mirroring `resolveColor`'s own `color ?? fill ?? stroke`
  // precedence), so a mark compiler that bakes a color from that field's
  // auto-derived ascending domain can compute it from every layer's rows, not
  // just its own — see `UnitContext.sharedColorDomainRows`'s doc comment. Only
  // recorded when 2+ units actually share the name; a single unit's own
  // `rows` already IS its domain, so leaving it `undefined` there keeps every
  // existing single-layer color split (e.g. the CO2 chart's per-line scheme)
  // byte-for-byte unchanged.
  const rowsByColorField = new Map<string, DatasetRow[]>();
  const unitColorFieldCounts = new Map<string, number>();
  for (const { unit, rows } of prepared) {
    const def = unit.encoding.color ?? unit.encoding.fill ?? unit.encoding.stroke;
    const field = isFieldDef(def) ? def.field : undefined;
    if (!field) {
      continue;
    }
    unitColorFieldCounts.set(field, (unitColorFieldCounts.get(field) ?? 0) + 1);
    const bucket = rowsByColorField.get(field);
    if (bucket) {
      bucket.push(...rows);
    } else {
      rowsByColorField.set(field, [...rows]);
    }
  }

  // Whether ANY unit is a `geoshape` mark — a geo-projected point/circle layer
  // (longitude/latitude) uses this to decide whether it must resolve its own
  // projection/geoData (a standalone lon/lat spec with no base map) or defer
  // to a sibling geoshape's `geo` (see `UnitContext.hasGeoshapeLayer`'s doc).
  const hasGeoshapeLayer = prepared.some(({ unit }) => unit.mark.type === 'geoshape');

  const series: CompiledSeries[] = [];
  const plots = new Set<PlotKind>();
  const referenceLines: CompiledReferenceLine[] = [];
  // Overlays are custom SVG, not native x-charts plot components, so the
  // shell can only stack them as one group before the plots and one group
  // after (see `backgroundOverlays` below) — it cannot interleave per-layer
  // like a real z-order would. `overlays` holds every overlay produced by a
  // layer at or after the first layer that contributes a native series
  // (drawn AFTER the plots — the common case: value labels over bars, a
  // boxplot's decorations, …).
  const overlays: CompiledOverlay[] = [];
  // Overlays produced entirely before any series-contributing layer (drawn
  // BEFORE the plots) — e.g. the ternary chart's filled background wedges,
  // which must sit under its later point-mark layer's markers rather than
  // painting over them.
  const backgroundOverlays: CompiledOverlay[] = [];
  // Buffers overlays seen before the FIRST series-producing layer, since we
  // can't know in advance whether one exists later in the spec. Flushed into
  // `backgroundOverlays` the moment a series does appear; if the whole spec
  // never produces a series (a standalone text/boxplot/errorbar chart), it's
  // flushed into the ordinary `overlays` list instead — there's no later
  // series geometry to protect, so these keep behaving exactly as before.
  const pendingOverlays: CompiledOverlay[] = [];
  let seenSeries = false;
  const overlayLegend: OverlayLegendItem[] = [];
  const zAxis: CompiledZAxis[] = [];
  const hollowSeriesIds: string[] = [];
  const markerStroke: Record<string, { color: string; width?: number }> = {};
  const lineStyle: Record<
    string,
    { strokeWidth?: number; strokeDasharray?: string; stroke?: string }
  > = {};
  const gradients: CompiledGradient[] = [];
  let colorLegendTitle: string | undefined;
  let colorLegendDirection: 'horizontal' | 'vertical' | undefined;
  let colorLegendLength: number | undefined;
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
    const colorDef = unit.encoding.color ?? unit.encoding.fill ?? unit.encoding.stroke;
    const colorField = isFieldDef(colorDef) ? colorDef.field : undefined;
    const sharedColorDomainRows =
      colorField && (unitColorFieldCounts.get(colorField) ?? 0) > 1
        ? rowsByColorField.get(colorField)
        : undefined;
    const ctx: UnitContext = {
      unit,
      rows,
      encoding: unit.encoding,
      x: axes.x,
      y: axes.y,
      gaps,
      palette,
      signals,
      selections: paramsRes.selections,
      categoryIndex,
      categoryKey,
      sharedColorDomainRows,
      hasGeoshapeLayer,
    };
    const before = series.length;
    const rawCompiled = compiler(ctx);
    // A chart binds exactly one geoData, so only the layer that FIRST resolves
    // one becomes the map; any later geo layer swaps to its projected-path
    // overlay form (`geoFallback`) rather than being silently discarded, which
    // is how `geo_layer_line_london` lost its whole tube network. Deciding here
    // — not in the mark — is what lets `interactive_geo_earthquakes` promote
    // its SECOND layer to the map after the first (a `sphere` generator)
    // resolves nothing.
    const compiled: CompiledUnit =
      rawCompiled.geo && geo && rawCompiled.geoFallback
        ? {
            ...rawCompiled,
            series: [],
            plots: [],
            geo: undefined,
            zAxis: undefined,
            overlays: [...(rawCompiled.overlays ?? []), ...rawCompiled.geoFallback.overlays],
            overlayLegend: [
              ...(rawCompiled.overlayLegend ?? []),
              ...(rawCompiled.geoFallback.overlayLegend ?? []),
            ],
          }
        : rawCompiled;
    if (compiled !== rawCompiled) {
      rawCompiled.geoFallback?.gaps?.forEach((gap) => gaps.add(gap));
      gaps.add({
        code: 'mark:geoshape-layer-custom-overlay',
        message:
          'x-charts binds a single geo dataset to a chart, so only the first geoshape layer becomes a native map; this additional layer is drawn as projected SVG paths by a custom overlay (sharing the base map projection) instead of an x-charts series.',
        severity: 'ignored',
        path: unit.path,
      });
    }
    series.push(...compiled.series);
    // Record this layer's static opacity against the series it produced, so it
    // can be baked into the resolved color once palette colors are assigned.
    const opacity = staticMarkOpacity(unit, paramsRes.selections);
    if (opacity !== undefined) {
      for (let i = before; i < series.length; i += 1) {
        seriesOpacity[i] = opacity;
      }
      // A custom overlay carries its own colors and never passes through the
      // series-palette pass above, so the layer's opacity has to be folded into
      // those colors here or it is simply lost. `interactive_global_development`
      // draws its country trails as a continuous-x line overlay whose opacity
      // resolves to 0 (hidden until you hover) — without this they painted 681
      // opaque grey trajectories straight over the chart.
      applyOverlayOpacity(compiled.overlays, opacity);
    }
    compiled.plots.forEach((plot) => plots.add(plot));
    referenceLines.push(...(compiled.referenceLines ?? []));
    if (compiled.series.length > 0 && !seenSeries) {
      // First series-producing layer: everything buffered so far sits
      // strictly earlier in the spec and must render behind it.
      backgroundOverlays.push(...pendingOverlays);
      pendingOverlays.length = 0;
      seenSeries = true;
    }
    if (seenSeries) {
      overlays.push(...(compiled.overlays ?? []));
    } else {
      pendingOverlays.push(...(compiled.overlays ?? []));
    }
    overlayLegend.push(...(compiled.overlayLegend ?? []));
    // First layer with a bubble-size legend wins (one size scale per chart).
    if (compiled.sizeLegend && !sizeLegend) {
      sizeLegend = compiled.sizeLegend;
    }
    zAxis.push(...(compiled.zAxis ?? []));
    hollowSeriesIds.push(...(compiled.hollowSeriesIds ?? []));
    Object.assign(markerStroke, compiled.markerStroke);
    Object.assign(lineStyle, compiled.lineStyle);
    gradients.push(...(compiled.gradients ?? []));
    if (compiled.colorLegendTitle && colorLegendTitle === undefined) {
      colorLegendTitle = compiled.colorLegendTitle;
    }
    if (compiled.colorLegendDirection && colorLegendDirection === undefined) {
      colorLegendDirection = compiled.colorLegendDirection;
    }
    if (compiled.colorLegendLength !== undefined && colorLegendLength === undefined) {
      colorLegendLength = compiled.colorLegendLength;
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
  // No series ever appeared: there's no later series geometry to protect
  // these overlays from, so they behave exactly as before (one flat,
  // post-plot `overlays` list) rather than being misclassified as background.
  if (!seenSeries) {
    overlays.push(...pendingOverlays);
  }

  // Assign palette colors to series that didn't get an explicit color. Pie
  // slices color themselves per-datum; heatmap cells are colored by the
  // zAxis colorMap and have no series-level color at all.
  //
  // The palette slot is picked from a counter over only the series actually
  // needing one — NOT the raw array index — so an explicitly-colored series
  // interleaved among them (e.g. a `repeat.layer` halo line with a static
  // `mark.stroke: 'white'` alongside each symbol's auto-colored line) doesn't
  // consume/skip a slot. Using the raw index there would land every other
  // auto-colored series on the wrong (odd, skipped) palette entry instead of
  // the sequential one Vega-Lite's own default assignment would pick.
  let nextPaletteIndex = 0;
  series.forEach((entry, index) => {
    if (entry.type === 'pie' || entry.type === 'heatmap') {
      return;
    }
    const colorable = entry as { color?: string };
    if (colorable.color === undefined) {
      colorable.color = palette[nextPaletteIndex % palette.length];
      nextPaletteIndex += 1;
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
  if (overlays.length > 0 || backgroundOverlays.length > 0) {
    applyOverlayDomains([...overlays, ...backgroundOverlays], series, axes.x, axes.y);
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
    backgroundOverlays,
    overlayLegend,
    sizeLegend,
    grid: axes.grid,
    hasLegend,
    colors: palette,
    hollowSeriesIds: hollowSeriesIds.length > 0 ? hollowSeriesIds : undefined,
    markerStroke: Object.keys(markerStroke).length > 0 ? markerStroke : undefined,
    lineStyle: Object.keys(lineStyle).length > 0 ? lineStyle : undefined,
    gradients: gradients.length > 0 ? gradients : undefined,
    colorLegendTitle,
    colorLegendDirection,
    colorLegendLength,
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
