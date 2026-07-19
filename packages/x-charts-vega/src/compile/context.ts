import type { ChartsContainerProps } from '@mui/x-charts/ChartsContainer';
import type { XAxis, YAxis } from '@mui/x-charts/models';
// Type-only barrel import: applies the Pro/Premium module augmentation so
// `CompiledSeries` includes heatmap/rangeBar/mapShape series types.
import type {} from '@mui/x-charts-premium';
import type { DatasetRow, VegaChannelDef, VegaEncoding, VegaFieldType } from '../types';
import type { GapCollector } from '../gaps';
import type { NormalizedUnit } from '../normalize';

/** A series object accepted by `ChartsContainer`'s `series` prop (incl. Premium types via augmentation). */
export type CompiledSeries = NonNullable<ChartsContainerProps['series']>[number];

/** A z (color) axis config accepted by the container's `zAxis` prop. */
export type CompiledZAxis = NonNullable<ChartsContainerProps['zAxis']>[number];

/** Plot subcomponents the shell knows how to render. */
export type PlotKind =
  | 'bar'
  | 'line'
  | 'area'
  | 'marks'
  | 'scatter'
  | 'pie'
  | 'pieLabels'
  | 'lineHighlight'
  | 'heatmap'
  | 'rangeBar'
  | 'geoBase'
  | 'mapShape';

/** A data-space position on a cartesian axis (band/point categories included). */
export type OverlayPosition = number | string | Date;

export interface OverlaySegment {
  x1: OverlayPosition;
  y1: OverlayPosition;
  x2: OverlayPosition;
  y2: OverlayPosition;
  style?: React.CSSProperties;
}

/** Two opposite corners of a rectangle, in data space. */
export interface OverlayRectItem {
  x1: OverlayPosition;
  y1: OverlayPosition;
  x2: OverlayPosition;
  y2: OverlayPosition;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
}

export interface OverlayBoxItem {
  /** The category-axis value the box is centered on. */
  category: OverlayPosition;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  /** Values beyond the whiskers, drawn as dots. */
  outliers?: number[];
  color?: string;
  /** Sub-group index within the category (for grouped/dodged box plots). */
  groupIndex?: number;
}

/** Styling for one sub-mark of a box plot (median line, box, whisker rule, ticks, outliers). */
export interface OverlayBoxSubMark {
  color?: string;
  opacity?: number;
}

export interface OverlayErrorBarItem {
  category: OverlayPosition;
  /** Optional center tick (mean/median). */
  center?: number;
  lower: number;
  upper: number;
  color?: string;
  /** Sub-group index within the category for a color-split (dodged) error bar. */
  groupIndex?: number;
  /** Number of dodged sub-groups sharing each category. */
  groupCount?: number;
}

export interface OverlayBandPoint {
  x: OverlayPosition;
  lower: number;
  upper: number;
}

export interface OverlayTextItem {
  x: OverlayPosition;
  y: OverlayPosition;
  text: string;
  dx?: number;
  dy?: number;
  style?: React.CSSProperties;
}

export interface OverlayImageItem {
  x: OverlayPosition;
  y: OverlayPosition;
  url: string;
  width?: number;
  height?: number;
  /** Aspect-ratio handling: `false` stretches to width/height; omitted/`true` preserves the ratio. */
  aspect?: boolean;
}

/**
 * Custom-drawn output for Vega-Lite marks with no x-charts series equivalent
 * (boxplot, errorbar/errorband, text, image, rule segments, tick shapes).
 * All positions are data-space values; the `VegaOverlays` component
 * (src/overlays) converts them to pixels via the public `useXScale`/
 * `useYScale` hooks and draws plain SVG inside `ChartsSurface` — the same
 * composition pattern as `ChartsReferenceLine` and the official
 * custom-component docs demos.
 */
export type CompiledOverlay =
  | {
      kind: 'segments';
      items: OverlaySegment[];
      /**
       * Set when these segments are a genuine `line`/`trail` mark drawn over
       * a continuous x (`marks/lineArea.ts` `buildContinuousLineOverlay`) —
       * Vega-Lite's `zero: true` default for line/area marks still applies
       * here, but since this overlay (not a native x-charts `line` series)
       * is what carries the geometry, `compile/index.ts`'s `applyOverlayDomains`
       * needs this flag to pin the y domain to include 0 the same way it
       * already does for a native `line`/`bar` series. Not set for the same
       * `kind` used by tick marks or `rule` spans, neither of which carries
       * Vega-Lite's zero-baseline default.
       */
      lineMarkZeroBaseline?: boolean;
    }
  | {
      /**
       * A `bar` mark whose positional channels are *both* continuous (e.g. a
       * log-scaled x with explicit `x`/`x2` bin edges) — x-charts'
       * `bar`/`rangeBar` series always need one categorical dimension, so
       * this can never become a native series (`marks/bar.ts`). Drawn as
       * plain `<rect>`s instead, positioned by `useXScale`/`useYScale`.
       */
      kind: 'rects';
      items: OverlayRectItem[];
    }
  | {
      /**
       * A single closed, filled polygon (a `line`/`trail` mark with
       * `interpolate: "linear-closed"` — Vega-Lite draws these as a filled
       * shape, not a plain polyline). Points are drawn in row order (NOT
       * sorted by x, unlike the continuous line/area overlays above) and the
       * path is always closed back to the first point.
       */
      kind: 'polygon';
      points: Array<{ x: number; y: number }>;
      fill?: string;
      fillOpacity?: number;
      stroke?: string;
      strokeWidth?: number;
    }
  | {
      kind: 'boxes';
      orientation: 'vertical' | 'horizontal';
      items: OverlayBoxItem[];
      /** Box thickness as a fraction of the band width (default ~0.5). */
      widthRatio?: number;
      /** Number of sub-groups sharing each category (for grouped/dodged boxes). */
      groupCount?: number;
      opacity?: number;
      /** Median line styling, or `false` to hide it. */
      median?: OverlayBoxSubMark | false;
      /** Box (IQR rectangle) styling. */
      box?: OverlayBoxSubMark;
      /** Whisker rule styling, or `false` to hide it. */
      rule?: OverlayBoxSubMark | false;
      /** Whisker end-tick styling, or `false` to hide it. */
      ticks?: OverlayBoxSubMark | false;
      /** Outlier dot styling, or `false` to hide them. */
      outliers?: OverlayBoxSubMark | false;
    }
  | { kind: 'errorBars'; orientation: 'vertical' | 'horizontal'; items: OverlayErrorBarItem[] }
  | {
      kind: 'band';
      points: OverlayBandPoint[];
      color?: string;
      opacity?: number;
      orientation?: 'vertical' | 'horizontal';
    }
  | { kind: 'text'; items: OverlayTextItem[] }
  | { kind: 'image'; items: OverlayImageItem[] }
  | {
      kind: 'radialArcs';
      items: OverlayRadialArcItem[];
      /** `mark.innerRadius`, already in px (constant across every slice). */
      innerRadius: number;
      /** The `radius` encoding's scale — resolved to px at render time against the drawing area (min(width,height)/2), since that isn't known at compile time. */
      radiusScaleType: 'linear' | 'sqrt' | 'pow';
      radiusDomain: [number, number];
      /** `scale.rangeMin`, in px (the innermost point of the radius scale's range). */
      radiusRangeMin: number;
    }
  | {
      kind: 'radialLabels';
      items: OverlayRadialLabelItem[];
      radiusScaleType: 'linear' | 'sqrt' | 'pow';
      radiusDomain: [number, number];
      radiusRangeMin: number;
      /** `mark.radiusOffset` — px beyond the item's own resolved radius. */
      radiusOffset: number;
    };

/**
 * One label of a `radius`-encoded text mark layered over a `radialArcs`
 * chart (arc.ts's `compileRadialArcMark`) — a separate mark/unit sharing the
 * same `theta`/`radius`/`color` encoding, so `textMark.ts`'s
 * `compilePolarTextLabels` recomputes the identical angle/order math
 * independently (same rows, same deterministic algorithm, so it lines up).
 */
export interface OverlayRadialLabelItem {
  /** Mid-angle of the slice this label sits beside (radians, 0 = 12 o'clock, clockwise). */
  angle: number;
  /** Raw `radius` field value — mapped to px by the overlay's radius scale, then offset outward by `radiusOffset`. */
  radiusValue: number;
  text: string;
  color?: string;
}

/**
 * One slice of a `radius`-encoded arc mark ("coxcomb"/polar-bar chart) — the
 * one case a single-inner/outer-radius x-charts pie series genuinely can't
 * express, since each slice needs its own outer radius. Angles are in
 * radians, 0 at 12 o'clock, sweeping clockwise (d3's arc-generator
 * convention) — the renderer builds the arc path directly with
 * `@mui/x-charts-vendor/d3-shape`'s `arc()` rather than going through
 * `<PiePlot />`.
 */
export interface OverlayRadialArcItem {
  startAngle: number;
  endAngle: number;
  /** Raw `radius` field value — mapped to px by the overlay's radius scale at render time. */
  radiusValue: number;
  color: string;
}

export interface CompiledReferenceLine {
  axis: 'x' | 'y';
  value: number | Date | string;
  label?: string;
  lineStyle?: React.CSSProperties;
}

/** Geo rendering request (geoshape marks) — switches the shell to the geo provider. */
export interface CompiledGeo {
  /** A GeoJSON FeatureCollection for the base map / shape lookup. */
  geoData: unknown;
  /**
   * A d3 named projection (e.g. 'naturalEarth1'), a projection config, or a
   * pre-built projection instance (used for `albersUsa`, which needs a `rotate`
   * shim — see `marks/geoshape.ts`).
   */
  projection?: string | Record<string, unknown> | ((...args: never[]) => unknown);
  /**
   * Initial map view derived from the spec's `projection.rotate`, forwarded to
   * `ChartsGeoDataProviderPremium`'s `initialView` (from `useGeoProjectionZoom`'s
   * `MapZoomView`). A d3 `rotate: [λ, φ, γ]` displays the point `[-λ, -φ]` at the
   * center with a `γ` roll, so it maps to `{ zoomLevel: 1, center: [-λ, -φ],
   * roll: γ }`. The provider positions maps with a relative zoom/pan model, so a
   * projection's absolute `scale`/`translate` (raw SVG pixels) have no equivalent
   * and are reported as gaps rather than forwarded.
   */
  initialView?: { zoomLevel: number; center: [number, number]; roll?: number };
  // Formats the choropleth color legend's min/max labels (from the color
  // channel's `legend.format`). x-charts ignores a z-axis `valueFormatter` for
  // the continuous color legend, so the shell applies this via the legend's
  // `minLabel`/`maxLabel` props instead.
  colorLegendFormat?: (value: unknown) => string;
}

/** What a mark compiler hands back for one normalized unit (layer). */
export interface CompiledUnit {
  series: CompiledSeries[];
  plots: PlotKind[];
  referenceLines?: CompiledReferenceLine[];
  /** z (color) axes contributed by the layer (heatmap cells). */
  zAxis?: CompiledZAxis[];
  /** Present when the layer requires geographic rendering ('geoshape'). */
  geo?: CompiledGeo;
  /** Custom-drawn output for marks with no x-charts series equivalent. */
  overlays?: CompiledOverlay[];
  /**
   * Legend swatches for an overlay that carries a color split but no series to
   * feed the x-charts legend (e.g. dodged box plots). The shell renders these
   * as a small custom legend.
   */
  overlayLegend?: OverlayLegendItem[];
  /**
   * A bubble-size legend for a scatter layer with a quantitative `size` field.
   * x-charts has no native size legend, so the shell draws representative
   * circles + value labels beside the chart (mirroring Vega-Lite's default).
   */
  sizeLegend?: SizeLegend;
  /** Chart-wide bar corner radius requested by this layer's bar mark. */
  barBorderRadius?: number;
  /** Title for a heatmap's continuous color legend (x-charts' zAxis has no title slot). */
  colorLegendTitle?: string;
  /** `encoding.color.legend.direction` for a heatmap's continuous/piecewise color legend. */
  colorLegendDirection?: 'horizontal' | 'vertical';
  /** `encoding.color.legend.gradientLength` for a heatmap's continuous/piecewise color legend. */
  colorLegendLength?: number;
  /**
   * Ids of scatter series this layer produced that should render with hollow
   * (stroke-only) markers — Vega-Lite's default for the `point` mark (and any
   * mark with `filled: false`). The shell renders these through a custom
   * scatter marker slot; unlisted series keep the default solid-filled marker.
   */
  hollowSeriesIds?: string[];
  /**
   * A stroke override (color + width) for solid-filled scatter markers this
   * layer produced, keyed by series id — for a `point`/`circle` mark with an
   * explicit `mark.stroke` alongside a fill (a filled circle with a distinct
   * outline, as opposed to the hollow stroke-only style above). The shell
   * feeds these to the same custom scatter marker slot.
   */
  markerStroke?: Record<string, { color: string; width?: number }>;
  /**
   * Per-series line-path styling (`strokeWidth`/`strokeDasharray`), keyed by
   * series id — from a `mark.strokeWidth`/`strokeDash` (constant), or a
   * field-based `strokeDash` split (one dash pattern per group). x-charts'
   * line series has no such prop; the shell instead passes these through
   * `<LinePlot slotProps={{line: ...}}>`, which forwards arbitrary SVG props
   * to the underlying `<path>` per series.
   */
  lineStyle?: Record<string, { strokeWidth?: number; strokeDasharray?: string; stroke?: string }>;
  /**
   * SVG linear-gradient fills contributed by this layer (a Vega-Lite gradient
   * `mark.color`/`fill`). x-charts fills are a single color, so the shell emits
   * one `<linearGradient>` def per entry and the series references it via
   * `fill: url(#id)`.
   */
  gradients?: CompiledGradient[];
}

/**
 * An SVG linear-gradient a mark fill references by id. Coordinates are in
 * `objectBoundingBox` units (0–1), mirroring Vega-Lite's gradient `x1/y1/x2/y2`.
 */
export interface CompiledGradient {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: Array<{ offset: number; color: string }>;
}

/** One entry in an overlay's custom legend (a colored swatch + label). */
export interface OverlayLegendItem {
  label: string;
  color: string;
}

/** A bubble-size legend: representative data values with their marker radii (px). */
export interface SizeLegend {
  title?: string;
  entries: Array<{ value: number; radius: number }>;
}

/**
 * The x/y axis resolution shared by every layer. `categories` is set for
 * band/point scales and defines the index-alignment contract: mark compilers
 * must emit series `data` arrays aligned to `categories` order.
 */
export interface AxisResolution<Config extends XAxis | YAxis = XAxis | YAxis> {
  config: Config & { id: string };
  fieldType: VegaFieldType;
  /**
   * True when the spec pinned an explicit `scale.domain` on this axis (as
   * opposed to a domain bound derived from the `zero` default). Overlay-domain
   * seeding skips only genuinely explicit domains, so a zero-pinned min still
   * lets overlay geometry extend the other end.
   */
  hasExplicitDomain?: boolean;
  /** Present for band/point scales — the ordered domain values. */
  categories?: Array<string | number | Date>;
  /** Serialized category keys, index-aligned with `categories`. */
  categoryKeys?: string[];
  /** The channel def the axis was derived from (from the first layer defining it). */
  channel?: VegaChannelDef;
  /** The dataset column (possibly synthetic, post-transform) backing the axis. */
  field?: string;
  /**
   * True for an axis fabricated without any backing channel — currently only
   * the one-category band axis behind aggregate-only bars. Mark compilers
   * place every row at index 0 instead of looking a field value up.
   */
  synthetic?: boolean;
}

/** Everything a mark compiler can see. */
export interface UnitContext {
  unit: NormalizedUnit;
  /** Rows after top-level and encoding-level transforms. */
  rows: readonly DatasetRow[];
  encoding: VegaEncoding;
  x?: AxisResolution<XAxis>;
  y?: AxisResolution<YAxis>;
  gaps: GapCollector;
  /** Categorical palette used for series without explicit colors. */
  palette: readonly string[];
  /** Resolved param/signal values (bound variable params), keyed by name. */
  signals?: Readonly<Record<string, unknown>>;
  /**
   * Returns the index of a row's x (or y) value within the axis categories,
   * or -1 when the axis is not categorical or the value is absent.
   * @param {AxisResolution | undefined} axis The axis whose category domain to search.
   * @param {unknown} value The row's raw value for that axis.
   * @returns {number} The index into `categories`, or -1.
   */
  categoryIndex: (axis: AxisResolution | undefined, value: unknown) => number;
  /**
   * Stable serialization of a domain value for grouping/joining.
   * @param {unknown} value The domain value to serialize.
   * @returns {string} A collision-safe string key.
   */
  categoryKey: (value: unknown) => string;
}

export function categoryKey(value: unknown): string {
  if (value instanceof Date) {
    return `d:${value.getTime()}`;
  }
  return `${typeof value}:${String(value)}`;
}

export function categoryIndex(axis: AxisResolution | undefined, value: unknown): number {
  if (!axis?.categoryKeys) {
    return -1;
  }
  return axis.categoryKeys.indexOf(categoryKey(value));
}
