/**
 * A pragmatic subset of the Vega-Lite specification grammar.
 *
 * These types intentionally model only the portion of Vega-Lite that this
 * wrapper attempts to translate to `@mui/x-charts`. Anything outside this
 * subset is still accepted at runtime (extra keys are ignored) and surfaced
 * through the gap-reporting mechanism instead of failing hard.
 *
 * Reference: https://vega.github.io/vega-lite/docs/spec.html
 */

export type DatasetRow = Record<string, unknown>;

export type VegaFieldType = 'quantitative' | 'temporal' | 'ordinal' | 'nominal' | 'geojson';

export type VegaAggregateOp =
  | 'count'
  | 'valid'
  | 'missing'
  | 'distinct'
  | 'sum'
  | 'product'
  | 'mean'
  | 'average'
  | 'variance'
  | 'variancep'
  | 'stdev'
  | 'stdevp'
  | 'stderr'
  | 'median'
  | 'q1'
  | 'q3'
  | 'ci0'
  | 'ci1'
  | 'min'
  | 'max'
  | 'argmin'
  | 'argmax';

export type VegaTimeUnit =
  | 'year'
  | 'quarter'
  | 'month'
  | 'week'
  | 'day'
  | 'date'
  | 'dayofyear'
  | 'hours'
  | 'minutes'
  | 'seconds'
  | 'milliseconds'
  | 'yearquarter'
  | 'yearmonth'
  | 'yearmonthdate'
  | 'yearweek'
  | 'monthdate'
  | 'hoursminutes'
  | 'hoursminutesseconds'
  | (string & {});

export interface VegaBinParams {
  maxbins?: number;
  step?: number;
  extent?: [number, number];
  nice?: boolean;
  [key: string]: unknown;
}

export interface VegaScale {
  type?:
    | 'linear'
    | 'log'
    | 'pow'
    | 'sqrt'
    | 'symlog'
    | 'time'
    | 'utc'
    | 'ordinal'
    | 'band'
    | 'point'
    | (string & {});
  domain?: unknown[] | { unionWith?: unknown[] };
  range?: unknown[] | string;
  scheme?: string | { name?: string; count?: number };
  zero?: boolean;
  nice?: boolean | number;
  reverse?: boolean;
  padding?: number;
  paddingInner?: number;
  paddingOuter?: number;
  base?: number;
  exponent?: number;
  constant?: number;
  [key: string]: unknown;
}

export interface VegaAxis {
  title?: string | null;
  labels?: boolean;
  ticks?: boolean;
  grid?: boolean;
  orient?: 'top' | 'bottom' | 'left' | 'right';
  format?: string;
  /** Explicit formatter kind override (`'number' | 'time' | 'utc'`). */
  formatType?: string;
  tickCount?: number;
  values?: unknown[];
  labelAngle?: number;
  domain?: boolean;
  [key: string]: unknown;
}

export interface VegaLegend {
  title?: string | null;
  orient?: string;
  [key: string]: unknown;
}

export type VegaSort =
  | 'ascending'
  | 'descending'
  | null
  | unknown[]
  | { field?: string; op?: VegaAggregateOp; order?: 'ascending' | 'descending' }
  | (string & {});

export interface VegaFieldDef {
  field?: string;
  type?: VegaFieldType;
  aggregate?: VegaAggregateOp | { argmax?: string; argmin?: string };
  bin?: boolean | VegaBinParams | 'binned';
  timeUnit?: VegaTimeUnit;
  title?: string | null;
  scale?: VegaScale | null;
  axis?: VegaAxis | null;
  legend?: VegaLegend | null;
  sort?: VegaSort;
  stack?: 'zero' | 'normalize' | 'center' | null | boolean;
  format?: string;
  /** Explicit formatter kind override (`'number' | 'time' | 'utc'`). */
  formatType?: string;
  bandPosition?: number;
  impute?: unknown;
  condition?: unknown;
  [key: string]: unknown;
}

export interface VegaValueDef {
  value: string | number | boolean | null;
  condition?: unknown;
  [key: string]: unknown;
}

export interface VegaDatumDef {
  datum: string | number | boolean;
  type?: VegaFieldType;
  [key: string]: unknown;
}

export type VegaChannelDef = VegaFieldDef | VegaValueDef | VegaDatumDef;

export function isFieldDef(def: VegaChannelDef | undefined): def is VegaFieldDef {
  return (
    !!def &&
    ((def as VegaFieldDef).field !== undefined ||
      (def as VegaFieldDef).aggregate !== undefined ||
      (def as VegaFieldDef).timeUnit !== undefined ||
      (def as VegaFieldDef).bin !== undefined)
  );
}

export function isValueDef(def: VegaChannelDef | undefined): def is VegaValueDef {
  return !!def && (def as VegaValueDef).value !== undefined;
}

export function isDatumDef(def: VegaChannelDef | undefined): def is VegaDatumDef {
  return !!def && (def as VegaDatumDef).datum !== undefined;
}

export interface VegaEncoding {
  x?: VegaChannelDef;
  y?: VegaChannelDef;
  x2?: VegaChannelDef;
  y2?: VegaChannelDef;
  xOffset?: VegaChannelDef;
  yOffset?: VegaChannelDef;
  color?: VegaChannelDef;
  fill?: VegaChannelDef;
  stroke?: VegaChannelDef;
  opacity?: VegaChannelDef;
  size?: VegaChannelDef;
  shape?: VegaChannelDef;
  angle?: VegaChannelDef;
  theta?: VegaChannelDef;
  theta2?: VegaChannelDef;
  radius?: VegaChannelDef;
  radius2?: VegaChannelDef;
  detail?: VegaChannelDef | VegaChannelDef[];
  order?: VegaChannelDef;
  text?: VegaChannelDef;
  tooltip?: VegaChannelDef | VegaChannelDef[] | null;
  href?: VegaChannelDef;
  key?: VegaChannelDef;
  facet?: VegaChannelDef;
  row?: VegaChannelDef;
  column?: VegaChannelDef;
  [key: string]: unknown;
}

export type VegaMarkType =
  | 'arc'
  | 'area'
  | 'bar'
  | 'boxplot'
  | 'circle'
  | 'errorband'
  | 'errorbar'
  | 'geoshape'
  | 'image'
  | 'line'
  | 'point'
  | 'rect'
  | 'rule'
  | 'square'
  | 'text'
  | 'tick'
  | 'trail'
  | (string & {});

export interface VegaMarkDef {
  type: VegaMarkType;
  point?: boolean | Record<string, unknown> | 'transparent';
  line?: boolean | Record<string, unknown>;
  interpolate?:
    | 'linear'
    | 'monotone'
    | 'natural'
    | 'step'
    | 'step-before'
    | 'step-after'
    | 'basis'
    | 'cardinal'
    | 'catmull-rom'
    | 'bundle'
    | (string & {});
  color?: string;
  fill?: string;
  stroke?: string;
  opacity?: number;
  fillOpacity?: number;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDash?: number[];
  size?: number;
  filled?: boolean;
  innerRadius?: number;
  outerRadius?: number;
  padAngle?: number;
  cornerRadius?: number;
  orient?: 'horizontal' | 'vertical';
  tooltip?: boolean | null | Record<string, unknown>;
  [key: string]: unknown;
}

export type VegaMark = VegaMarkType | VegaMarkDef;

/** Top-level `transform` array entries. Discriminated by the key present. */
export interface VegaAggregateTransform {
  aggregate: Array<{ op: VegaAggregateOp; field?: string; as: string }>;
  groupby?: string[];
}
export interface VegaBinTransform {
  bin: boolean | VegaBinParams;
  field: string;
  as: string | [string, string];
}
export interface VegaCalculateTransform {
  calculate: string;
  as: string;
}
export interface VegaFilterTransform {
  filter: unknown;
}
export interface VegaTimeUnitTransform {
  timeUnit: VegaTimeUnit;
  field: string;
  as: string;
}
export interface VegaFoldTransform {
  fold: string[];
  as?: [string, string];
}
/** The secondary dataset referenced by a `lookup` transform's `from.data`. */
export interface VegaLookupData {
  values?: DatasetRow[];
  name?: string;
  url?: string;
  [key: string]: unknown;
}
export interface VegaLookupTransform {
  /** The field in the primary data to match against `from.key` (may be a dotted path, e.g. GeoJSON `properties.name`). */
  lookup: string;
  from: {
    data: VegaLookupData;
    /** The field in the secondary data to match against `lookup`. */
    key: string;
    /** Fields to copy from the matched secondary row. Omitted means "the entire object". */
    fields?: string[];
  };
  /** Output field name(s). A single string when `fields` is omitted (stores the whole matched datum). */
  as?: string | string[];
  /** Value used for non-matching rows. Defaults to `null`. */
  default?: unknown;
}
export interface VegaWindowTransform {
  window: Array<{ op: string; field?: string; param?: number; as: string }>;
  frame?: [number | null, number | null];
  ignorePeers?: boolean;
  groupby?: string[];
  sort?: Array<{ field: string; order?: 'ascending' | 'descending' }>;
}
export interface VegaJoinAggregateTransform {
  joinaggregate: Array<{ op: VegaAggregateOp; field?: string; as: string }>;
  groupby?: string[];
}
export interface VegaRegressionTransform {
  regression: string;
  on: string;
  groupby?: string[];
  method?: 'linear' | 'log' | 'exp' | 'pow' | 'quad' | 'poly';
  order?: number;
  extent?: [number, number];
  params?: boolean;
  as?: [string, string];
}
export interface VegaLoessTransform {
  loess: string;
  on: string;
  groupby?: string[];
  bandwidth?: number;
  as?: [string, string];
}
export interface VegaQuantileTransform {
  quantile: string;
  groupby?: string[];
  probs?: number[];
  step?: number;
  as?: [string, string];
}
export interface VegaDensityTransform {
  density: string;
  groupby?: string[];
  cumulative?: boolean;
  counts?: boolean;
  bandwidth?: number;
  extent?: [number, number];
  steps?: number;
  minsteps?: number;
  maxsteps?: number;
  as?: [string, string];
}
export type VegaTransform =
  | VegaAggregateTransform
  | VegaBinTransform
  | VegaCalculateTransform
  | VegaFilterTransform
  | VegaTimeUnitTransform
  | VegaFoldTransform
  | VegaLookupTransform
  | VegaWindowTransform
  | VegaJoinAggregateTransform
  | VegaRegressionTransform
  | VegaLoessTransform
  | VegaQuantileTransform
  | VegaDensityTransform
  | Record<string, unknown>;

export interface VegaData {
  /**
   * Inline rows, a raw CSV/TSV payload string, or a single object payload
   * (e.g. a TopoJSON topology when `format.type` is `'topojson'`).
   */
  values?: readonly DatasetRow[] | string | DatasetRow;
  name?: string;
  url?: string;
  format?: { type?: string; feature?: string; mesh?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * A top-level `params` entry (selection or variable parameter).
 *
 * Reference: https://vega.github.io/vega-lite/docs/parameter.html
 * Loosely typed on purpose — `select`/`bind`/`value` accept whatever shape
 * the spec provides and unrecognized refinements are still readable via the
 * index signature instead of being type errors.
 */
export interface VegaSelectionDef {
  type: 'point' | 'interval' | (string & {});
  on?: unknown;
  toggle?: unknown;
  fields?: unknown;
  encodings?: unknown;
  nearest?: unknown;
  [key: string]: unknown;
}

/**
 * An input-widget binding for a variable/selection param
 * (`bind: {input: 'range', min, max, step}` and friends).
 */
export interface VegaBindInput {
  input: 'range' | 'select' | 'checkbox' | 'radio' | (string & {});
  min?: number;
  max?: number;
  step?: number;
  options?: unknown[];
  labels?: string[];
  name?: string;
  debounce?: number;
  [key: string]: unknown;
}

/** A param binding: scale/legend interaction, an input widget, or a raw record. */
export type VegaBind = 'scales' | 'legend' | VegaBindInput | Record<string, unknown>;

export interface VegaParam {
  name?: string;
  /** Selection params only; absent for plain variable params. */
  select?: 'point' | 'interval' | VegaSelectionDef;
  /** Initial value: a selection's initial state, or a variable param's value. */
  value?: unknown;
  /** Input widget / scale / legend binding. */
  bind?: VegaBind;
  [key: string]: unknown;
}

export interface VegaUnitSpec {
  data?: VegaData | null;
  mark: VegaMark;
  encoding?: VegaEncoding;
  transform?: VegaTransform[];
  title?: string | Record<string, unknown>;
  name?: string;
  width?: number | 'container' | Record<string, unknown>;
  height?: number | 'container' | Record<string, unknown>;
  params?: unknown[];
  projection?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface VegaLayerSpec {
  data?: VegaData | null;
  layer: Array<VegaUnitSpec | VegaLayerSpec>;
  encoding?: VegaEncoding;
  transform?: VegaTransform[];
  resolve?: {
    scale?: Partial<
      Record<'x' | 'y' | 'color' | 'size' | 'shape' | 'theta', 'shared' | 'independent'>
    >;
    axis?: Record<string, unknown>;
    legend?: Record<string, unknown>;
  };
  title?: string | Record<string, unknown>;
  width?: number | 'container' | Record<string, unknown>;
  height?: number | 'container' | Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Facet-operator mapping (`facet: {field} | {row, column}`). Faceting by a
 * single field wraps into a grid (`columns`); `row`/`column` build a matrix.
 */
export interface VegaFacetMapping {
  field?: string;
  type?: VegaFieldType;
  row?: VegaFieldDef;
  column?: VegaFieldDef;
  sort?: VegaSort;
  [key: string]: unknown;
}

/**
 * The `repeat` operator's field mapping. A bare `string[]` wraps into a grid;
 * `row`/`column` (and `layer`) build a matrix / layered repeat.
 */
export interface VegaRepeatMapping {
  row?: string[];
  column?: string[];
  layer?: string[];
  [key: string]: unknown;
}

/**
 * A `{repeat: 'row' | 'column' | 'layer' | 'repeat'}` field reference used
 * inside a repeated sub-spec's encoding to point at the current repeat value.
 */
export interface VegaRepeatRef {
  repeat: 'row' | 'column' | 'layer' | 'repeat';
}

/**
 * Narrows a channel `field` value to a `{repeat}` reference.
 * @param {unknown} value The candidate field value.
 * @returns {value is VegaRepeatRef} True when it is a single-key `{repeat: string}`.
 */
export function isRepeatRef(value: unknown): value is VegaRepeatRef {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as VegaRepeatRef).repeat === 'string'
  );
}

/**
 * The accepted top-level spec. Facet/concat/repeat compositions are typed
 * loosely — they are detected before compilation and expanded by
 * `<VegaLiteChart />` into a grid of sub-charts (or, for `repeat`, reported as
 * a gap).
 */
export type VegaLiteSpec = (VegaUnitSpec | VegaLayerSpec) & {
  $schema?: string;
  config?: Record<string, unknown>;
  datasets?: Record<string, readonly DatasetRow[]>;
  background?: string;
  padding?: unknown;
  autosize?: unknown;
  /** Wrapping-grid column count for `concat` / single-field `facet`. */
  columns?: number;
  hconcat?: VegaLiteSpec[];
  vconcat?: VegaLiteSpec[];
  concat?: VegaLiteSpec[];
  repeat?: string[] | VegaRepeatMapping;
  facet?: VegaFacetMapping;
  spec?: unknown;
};
