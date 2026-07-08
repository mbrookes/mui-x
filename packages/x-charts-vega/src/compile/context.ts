import type { ChartsContainerProps } from '@mui/x-charts/ChartsContainer';
import type { XAxis, YAxis } from '@mui/x-charts/models';
import type { DatasetRow, VegaChannelDef, VegaEncoding, VegaFieldType } from '../types';
import type { GapCollector } from '../gaps';
import type { NormalizedUnit } from '../normalize';

/** A series object accepted by `ChartsContainer`'s `series` prop. */
export type CompiledSeries = NonNullable<ChartsContainerProps['series']>[number];

/** Plot subcomponents the shell knows how to render. */
export type PlotKind = 'bar' | 'line' | 'area' | 'marks' | 'scatter' | 'pie' | 'lineHighlight';

export interface CompiledReferenceLine {
  axis: 'x' | 'y';
  value: number | Date | string;
  label?: string;
  lineStyle?: React.CSSProperties;
}

/** What a mark compiler hands back for one normalized unit (layer). */
export interface CompiledUnit {
  series: CompiledSeries[];
  plots: PlotKind[];
  referenceLines?: CompiledReferenceLine[];
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
   */
  categoryIndex: (axis: AxisResolution | undefined, value: unknown) => number;
  /** Stable serialization of a domain value for grouping/joining. */
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
