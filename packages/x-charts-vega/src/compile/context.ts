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
}

export interface OverlayErrorBarItem {
  category: OverlayPosition;
  /** Optional center tick (mean/median). */
  center?: number;
  lower: number;
  upper: number;
  color?: string;
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
  | { kind: 'segments'; items: OverlaySegment[] }
  | {
      kind: 'boxes';
      orientation: 'vertical' | 'horizontal';
      items: OverlayBoxItem[];
      /** Box thickness as a fraction of the band width (default ~0.5). */
      widthRatio?: number;
    }
  | { kind: 'errorBars'; orientation: 'vertical' | 'horizontal'; items: OverlayErrorBarItem[] }
  | { kind: 'band'; points: OverlayBandPoint[]; color?: string; opacity?: number }
  | { kind: 'text'; items: OverlayTextItem[] }
  | { kind: 'image'; items: OverlayImageItem[] };

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
  /** A d3 named projection (e.g. 'naturalEarth1') or projection config. */
  projection?: string | Record<string, unknown>;
  /**
   * Projection rotation `[longitude, latitude]`, forwarded to
   * `ChartsGeoDataProviderPremium`'s `rotate` prop (see `useGeoProjection`'s
   * `UseGeoProjectionParameters.rotate` — the provider only accepts a 2-tuple;
   * a spec's 3rd "roll" value, if any, is dropped before reaching here).
   */
  rotate?: [number, number];
  /** Projection scale, forwarded to the provider's `scale` prop. */
  scale?: number;
  /** Projection translate `[x, y]`, forwarded to the provider's `translate` prop. */
  translate?: [number, number];
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
}

/**
 * The x/y axis resolution shared by every layer. `categories` is set for
 * band/point scales and defines the index-alignment contract: mark compilers
 * must emit series `data` arrays aligned to `categories` order.
 */
export interface AxisResolution<Config extends XAxis | YAxis = XAxis | YAxis> {
  config: Config & { id: string };
  fieldType: VegaFieldType;
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
