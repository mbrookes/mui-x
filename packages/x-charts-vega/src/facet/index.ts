/**
 * Faceting & view-composition planning.
 *
 * This module turns a composite Vega-Lite spec — one that uses `row`/`column`
 * facet channels, the `facet` operator, `hconcat`/`vconcat`/`concat`, or the
 * `repeat` operator — into a flat, row-major grid of independent unit/layer
 * sub-specs (`FacetPlan`). The render shell (`<VegaLiteChart />`) renders one
 * nested `<VegaLiteChart />` per cell.
 *
 * Everything here is pure: `planFacets` performs no rendering and has no React
 * dependency. The wrapper-level composition (the CSS grid, per-cell sizing,
 * aggregated gap reporting, depth guard) lives in the shell.
 *
 * Data handling:
 *   - Faceting partitions the resolved top-level rows by the facet field's
 *     distinct values (row → grid rows, column → grid columns, both → matrix;
 *     `facet.field` / `encoding.facet` + `columns` → a wrapping grid).
 *   - Concatenation does NOT partition: each entry is an independent sub-spec
 *     that resolves its own data, inheriting the top-level data when it has
 *     none (mirroring the normalizer's inheritance rules).
 *   - Repetition does NOT partition either: every cell plots the full dataset
 *     but through a different field, substituted into the shared `spec` template
 *     wherever a `{repeat}` reference appears.
 *
 * Facet ordering: `row`/`column`/`facet` (and the `facet`-operator equivalents)
 * accept a `sort` — `'ascending'`/`'descending'`, an explicit value array, or a
 * `{field, op, order}` aggregate rule — applied to the distinct facet values
 * before the grid is laid out. When `sort` is undefined the values keep
 * first-seen data order (a deliberate deviation: Vega-Lite defaults to ascending,
 * but data order preserves the wrapper's existing behavior).
 *
 * Shared scales (Vega-Lite's default `resolve.scale: "shared"` for facets):
 * before building the sub-specs, the union domain is computed across the whole
 * dataset so every cell renders on the same axis. For the quantitative value
 * channel a `scale.domain: [min, max]` is injected (respecting an existing
 * explicit domain); for discrete positional channels the union category array
 * is injected as `sort` so every cell shows the same category order. Concat
 * sub-specs keep independent scales by default (Vega-Lite's own default for
 * concat) — but an explicit top-level `resolve: {scale: {x: 'shared'}}` (or
 * `y`) is honored: the union quantitative domain across every entry (and, for
 * a `layer` entry, every one of its layers) is computed and injected the same
 * way, before each entry is handed to its cell (see `planConcat`). Repeat
 * cells likewise keep INDEPENDENT scales — each cell plots a different field,
 * so a shared domain would be meaningless; this is a deliberate deviation from
 * Vega-Lite's default `resolve.scale` for repeat.
 *
 * Known repeat limitations (also tracked in GAPS.md):
 *   - Nested same-key repeats (a repeat template that itself repeats on the same
 *     `row`/`column`/`repeat` key) mis-substitute the inner refs; distinct keys
 *     are fine, and the shell's `MAX_FACET_DEPTH` (2) caps nesting regardless.
 *   - Repeat cells do not share scales (the deviation noted above).
 */
import type {
  DatasetRow,
  VegaAggregateOp,
  VegaBinParams,
  VegaChannelDef,
  VegaEncoding,
  VegaFieldDef,
  VegaLayerSpec,
  VegaLiteSpec,
  VegaRepeatMapping,
  VegaRepeatRef,
  VegaScale,
  VegaSort,
} from '../types';
import { isFieldDef, isRepeatRef } from '../types';
import type { TranslationGap } from '../gaps';
import { createGapCollector } from '../gaps';
import { resolveFieldType, toDate, toNumber } from '../compile/fieldTypes';
import { evaluateAggregate } from '../transforms/aggregateOps';
import { applyTransforms } from '../transforms';
import { applyInlineTimeUnit } from '../transforms/timeUnit';
import { binOf, computeNiceBinning, isPreBinned } from '../transforms/bin';
import { titleText } from '../normalize';

/** Maximum levels of nested faceting/concat the shell will expand (gap beyond). */
export const MAX_FACET_DEPTH = 2;

/** Fallback grid dimensions when neither a prop nor a numeric spec size exists. */
const DEFAULT_TOTAL_WIDTH = 600;
const DEFAULT_TOTAL_HEIGHT = 400;
/** Below these, sub-charts stop being legible; the grid clamps and reports it. */
const MIN_CELL_WIDTH = 120;
const MIN_CELL_HEIGHT = 100;
export interface FacetOptions {
  /** Host-provided rows overriding/standing in for `spec.data`. */
  data?: readonly DatasetRow[];
  /** Host-provided named datasets, merged over `spec.datasets`. */
  datasets?: Record<string, readonly DatasetRow[]>;
  /** Total width available for the whole grid (already resolved from props/spec). */
  width: number;
  /** Total height available for the whole grid. */
  height: number;
}

export interface FacetCell {
  /** Stable React key / dedupe key for the cell. */
  key: string;
  /** The unit/layer sub-spec rendered in this cell. */
  spec: VegaLiteSpec;
  /** Facet value (or concat entry title) shown above the cell. */
  header?: string;
  /** Cell width passed to the nested chart. */
  width: number;
  /** Cell height passed to the nested chart. */
  height: number;
}

export interface FacetPlan {
  /** Number of grid columns. */
  columns: number;
  /** Number of grid rows. */
  rows: number;
  /** Cells in row-major order. */
  cells: FacetCell[];
  /**
   * Whether the cells share one x/y scale and legend (true for `row`/`column`/
   * `facet` small multiples). The shell then draws axis labels only on the left
   * column / bottom row and hoists a single legend. Concat and repeat cells are
   * independent views, so they keep their own axes and legends.
   */
  sharedAxes?: boolean;
  /**
   * Left margin (px) the shared y-axis needs for its longest category label —
   * a long variety/category name (e.g. "Wisconsin No. 38") needs more room
   * than the fixed default, or it's truncated and the cell reads as
   * emptier/smaller than Vega's. Only set for a shared nominal/ordinal y-axis.
   */
  yAxisMargin?: number;
  /**
   * True when each cell's `header` names its ROW (a `row` facet with no
   * `column`). Vega draws a row header to the LEFT of its cell, vertically
   * centered; drawing it above instead adds the header's height to every row's
   * pitch, which is what made `trellis_area_seattle`'s 24 rows twice Vega's
   * pitch and the isotype charts ~1.15x too tall.
   */
  rowHeaders?: boolean;
  /** Facet-level gaps (min cell size, empty data, malformed operator, …). */
  gaps: TranslationGap[];
}

/** Resolve a numeric width/height, ignoring `'container'` / step objects. */
export function numericSize(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** The mark type name from a `mark` string or `{type}` object. */
function markTypeOf(mark: VegaLiteSpec['mark'] | undefined): string | undefined {
  if (typeof mark === 'string') {
    return mark;
  }
  if (mark && typeof mark === 'object' && typeof (mark as { type?: unknown }).type === 'string') {
    return (mark as { type: string }).type;
  }
  return undefined;
}

/** Render a facet value for a header (dates get a locale date, else `String`). */
function formatFacetValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toLocaleDateString();
  }
  const date = typeof value === 'string' && Number.isNaN(Number(value)) ? toDate(value) : null;
  return date ? date.toLocaleDateString() : String(value);
}

/** Distinct values of `field` in data (first-seen) order. */
function distinctValues(rows: readonly DatasetRow[], field: string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const row of rows) {
    const value = row[field];
    if (value == null) {
      continue;
    }
    const key = String(value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

/** Whether a row belongs to the partition identified by `value` on `field`. */
function facetMatch(row: DatasetRow, field: string, value: unknown): boolean {
  return String(row[field]) === String(value);
}

/** Natural comparison for facet values: numeric, then chronological, then locale. */
function compareFacetValues(a: unknown, b: unknown): number {
  const numA = toNumber(a);
  const numB = toNumber(b);
  if (numA != null && numB != null) {
    return numA - numB;
  }
  const dateA = toDate(a);
  const dateB = toDate(b);
  if (dateA && dateB) {
    return dateA.getTime() - dateB.getTime();
  }
  return String(a).localeCompare(String(b));
}

/**
 * Order the distinct facet values according to a channel/operator `sort`.
 *   - `undefined` / `null` → first-seen data order (see the module deviation note).
 *   - `'ascending'` / `'descending'` → natural comparison, reversed for descending.
 *   - an explicit value array → those values first in array order, the rest kept
 *     in data order at the end.
 *   - `{field, op?, order?}` → group the rows by the facet field, aggregate the
 *     `field` per group (`op` defaults to `min`), and order by that aggregate
 *     (reversed for `order: 'descending'`); values with no aggregate trail last.
 *   - any other form (a bare `"field"` string, `{field}` missing, …) is reported
 *     as a `facet:sort` gap and the values are left in data order.
 */
function sortFacetValues(
  values: unknown[],
  sort: VegaSort | undefined,
  rows: readonly DatasetRow[],
  facetField: string,
  gaps: TranslationGap[],
): unknown[] {
  if (sort === null) {
    // `sort: null` explicitly opts out of ordering — keep data order.
    return values;
  }
  if (sort === undefined || sort === 'ascending' || sort === 'descending') {
    // Vega-Lite orders a nominal/ordinal/temporal facet ascending by default, so
    // an absent `sort` sorts ascending too (not first-seen data order).
    const sorted = [...values].sort(compareFacetValues);
    return sort === 'descending' ? sorted.reverse() : sorted;
  }
  if (Array.isArray(sort)) {
    const rank = new Map<string, number>();
    sort.forEach((value, index) => {
      const key = String(value);
      if (!rank.has(key)) {
        rank.set(key, index);
      }
    });
    const listed = values
      .filter((value) => rank.has(String(value)))
      .sort((a, b) => rank.get(String(a))! - rank.get(String(b))!);
    const unlisted = values.filter((value) => !rank.has(String(value)));
    return [...listed, ...unlisted];
  }
  if (typeof sort === 'object' && typeof (sort as { field?: unknown }).field === 'string') {
    const def = sort as { field: string; op?: VegaAggregateOp; order?: 'ascending' | 'descending' };
    const op = def.op ?? 'min';
    const buckets = new Map<string, unknown[]>();
    for (const row of rows) {
      const key = String(row[facetField]);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(row[def.field]);
    }
    const aggregate = new Map<string, number>();
    for (const [key, bucket] of buckets) {
      const value = evaluateAggregate(op, bucket);
      if (typeof value === 'number' && Number.isFinite(value)) {
        aggregate.set(key, value);
      }
    }
    const ranked = values.filter((value) => aggregate.has(String(value)));
    const unranked = values.filter((value) => !aggregate.has(String(value)));
    ranked.sort((a, b) => aggregate.get(String(a))! - aggregate.get(String(b))!);
    if (def.order === 'descending') {
      ranked.reverse();
    }
    return [...ranked, ...unranked];
  }
  gaps.push({
    code: 'facet:sort',
    message:
      `The facet \`sort\` form ${JSON.stringify(sort)} is not supported ` +
      '(only `ascending`/`descending`, an explicit value array, or a `{field, op, order}` ' +
      'rule are). Facets are shown in first-seen data order.',
    severity: 'partial',
    path: 'facet',
  });
  return values;
}

/** Resolve the top-level rows the same way the normalizer would. */
function resolveRootRows(spec: VegaLiteSpec, options: FacetOptions): readonly DatasetRow[] {
  if (options.data) {
    return options.data;
  }
  const datasets: Record<string, readonly DatasetRow[]> = {
    ...(spec.datasets as Record<string, readonly DatasetRow[]> | undefined),
    ...options.datasets,
  };
  const data = spec.data;
  if (!data) {
    return [];
  }
  if (Array.isArray(data.values)) {
    return data.values as readonly DatasetRow[];
  }
  if (typeof data.name === 'string' && datasets[data.name]) {
    return datasets[data.name];
  }
  return [];
}

/**
 * Resolves the root rows AND applies the spec's top-level `transform` array
 * before faceting partitions them. This matches Vega-Lite's order (data
 * transforms run on the whole dataset, then faceting splits the result), and is
 * essential when the facet field itself is produced by a transform — e.g. a
 * `row`/`column` field created by a `calculate`, or rows selected by a `filter`.
 * Without it, partitioning by a derived field finds no values and every cell is
 * empty. The transforms are applied once here (their gaps surface at the facet
 * level) and stripped from each cell so they don't re-run per partition.
 */
function transformedRootRows(
  spec: VegaLiteSpec,
  options: FacetOptions,
): { rows: readonly DatasetRow[]; gaps: TranslationGap[] } {
  const raw = resolveRootRows(spec, options);
  const transforms = spec.transform;
  if (!transforms || transforms.length === 0) {
    return { rows: raw, gaps: [] };
  }
  const collector = createGapCollector();
  // Same merge `resolveRootRows` does for the primary data source — passed
  // through so a `lookup` transform's `from.data.name` can resolve a named
  // secondary dataset too.
  const datasets: Record<string, readonly DatasetRow[]> = {
    ...(spec.datasets as Record<string, readonly DatasetRow[]> | undefined),
    ...options.datasets,
  };
  const rows = applyTransforms(raw, transforms, collector, '$', undefined, datasets);
  return { rows, gaps: collector.list() };
}

/**
 * Fields the shared domain groups the value channel by: the facet field(s) plus
 * the opposite discrete positional channel. Series-splitting channels (`color`,
 * `xOffset`/`yOffset`, `detail`) are deliberately NOT grouped on, so the domain
 * sums across them — this equals the stacked-bar/area total (exact for stacked
 * marks) and merely leaves benign headroom for grouped/dodged marks. Grouping
 * on them instead would under-shoot a stack's height and clip every cell.
 */
/**
 * Group key a cell would aggregate by: the facet fields plus the opposite
 * (category) positional channel.
 *
 * Returns a key FUNCTION rather than a field-name list because a binned category
 * groups by its BIN, not by its raw value. `trellis_bar_histogram` counts cars
 * per Horsepower bin: grouping by each distinct Horsepower put the shared
 * domain's max at ~22, while the rendered bars — one per bin — reach 80, so
 * every facet cell after the first clipped flat against the shared axis it does
 * not draw.
 */
type GroupKeyFn = (row: DatasetRow) => string;

function buildGroupKey(
  encoding: VegaEncoding,
  facetFields: string[],
  valueChannel: 'x' | 'y',
  rows: readonly DatasetRow[],
): GroupKeyFn {
  const parts: GroupKeyFn[] = facetFields.map(
    (facetField) => (row: DatasetRow) => String(row[facetField]),
  );
  const categoryChannel = valueChannel === 'y' ? 'x' : 'y';
  const def = encoding[categoryChannel];
  if (isFieldDef(def) && def.field && def.aggregate === undefined) {
    const field = def.field;
    // Pre-binned data already carries its bucket in the field itself.
    const binning =
      def.bin && !isPreBinned(def.bin)
        ? computeNiceBinning(
            rows
              .map((row) => toNumber(row[field]))
              .filter((value): value is number => value != null),
            def.bin === true ? undefined : (def.bin as VegaBinParams),
          )
        : null;
    if (binning) {
      parts.push((row: DatasetRow) => {
        const value = toNumber(row[field]);
        const bin = value == null ? null : binOf(value, binning);
        return bin ? String(bin.index) : 'no-bin';
      });
    } else {
      parts.push((row: DatasetRow) => String(row[field]));
    }
  }
  return (row: DatasetRow) => parts.map((part) => part(row)).join('\u0000');
}

/**
 * Compute the shared quantitative domain for a value channel across the whole
 * dataset. When the channel aggregates, the rows are grouped exactly as a cell
 * would group them (facet fields + the other discrete channels) so the domain
 * matches the rendered bar/line heights rather than the raw values.
 */
function quantDomain(
  def: VegaFieldDef,
  rows: readonly DatasetRow[],
  keyOf: GroupKeyFn,
): [number, number] | undefined {
  const field = def.field;
  const aggregate = typeof def.aggregate === 'string' ? def.aggregate : undefined;
  let values: number[];
  if (aggregate === undefined) {
    if (!field) {
      return undefined;
    }
    values = rows
      .map((row) => toNumber(row[field]))
      .filter((value): value is number => value != null);
  } else {
    const groups = new Map<string, unknown[]>();
    for (const row of rows) {
      const key = keyOf(row);
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = [];
        groups.set(key, bucket);
      }
      bucket.push(field ? row[field] : row);
    }
    values = [];
    for (const bucket of groups.values()) {
      const aggregated = evaluateAggregate(aggregate, bucket);
      if (typeof aggregated === 'number' && Number.isFinite(aggregated)) {
        values.push(aggregated);
      }
    }
  }
  if (values.length === 0) {
    return undefined;
  }
  let min = Math.min(...values);
  let max = Math.max(...values);
  // Quantitative scales include zero unless `scale.zero: false`; anchoring the
  // shared domain at zero keeps bars/areas from clipping across cells.
  const scale = def.scale && typeof def.scale === 'object' ? (def.scale as VegaScale) : undefined;
  if (scale?.zero !== false) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  return [min, max];
}

/**
 * Inject shared-scale hints into an encoding: a `scale.domain` on the
 * quantitative value channel, and a `sort` union category array on discrete
 * positional channels. Existing explicit domains/sorts are left untouched.
 */
function injectSharedScales(
  encoding: VegaEncoding,
  rows: readonly DatasetRow[],
  facetFields: string[],
): VegaEncoding {
  const result: VegaEncoding = { ...encoding };
  for (const channel of ['x', 'y'] as const) {
    const def = encoding[channel];
    if (!isFieldDef(def)) {
      continue;
    }
    const fieldType = resolveFieldType(def, rows);
    if (fieldType === 'quantitative') {
      const scale =
        def.scale && typeof def.scale === 'object' ? (def.scale as VegaScale) : undefined;
      if (Array.isArray(scale?.domain)) {
        continue; // respect an explicit domain
      }
      const domain = quantDomain(def, rows, buildGroupKey(encoding, facetFields, channel, rows));
      if (domain) {
        result[channel] = { ...def, scale: { ...(scale ?? {}), domain } };
      }
    } else if (def.field && def.sort === undefined) {
      const categories = distinctValues(rows, def.field);
      if (categories.length > 0) {
        result[channel] = { ...def, sort: categories };
      }
    }
  }
  // Share the color scale too (Vega-Lite's default `resolve.scale.color:
  // "shared"`): inject the union of the color field's values, ascending, as the
  // scale domain so every cell maps the same value to the same swatch. Without
  // it, a facet whose facet field equals its color field (e.g. `row: gender` +
  // `color: gender`) gives each cell a single-value domain and every cell
  // reuses the first range color. An explicit domain or channel `sort` wins.
  const colorDef = encoding.color;
  if (isFieldDef(colorDef) && colorDef.field && colorDef.sort === undefined) {
    const scale =
      colorDef.scale && typeof colorDef.scale === 'object'
        ? (colorDef.scale as VegaScale)
        : undefined;
    if (!Array.isArray(scale?.domain)) {
      const values = [...distinctValues(rows, colorDef.field)].sort(compareFacetValues);
      if (values.length > 0) {
        result.color = { ...colorDef, scale: { ...(scale ?? {}), domain: values } };
      }
    }
  }
  return result;
}

/** Encoding with the facet channels removed (they never reach a leaf spec). */
function stripFacetChannels(encoding: VegaEncoding): VegaEncoding {
  const { row, column, facet, ...rest } = encoding;
  return rest;
}

// Vega-Lite's `config.view.continuousWidth/Height` default. A bare `vega-lite`
// compile of a genuinely unconstrained top-level view resolves this to 300 —
// but that is NOT what our reference actually renders: `GalleryPage.tsx`
// always calls `vega-embed`'s `embed()` with an explicit `{width, height}`
// (440×340), and under that (always-present, for us) constraint a facet/
// concat/repeat child's continuous axis default is 200, confirmed by
// instantiating `vega-embed`'s real `embed()` (not just `vega-lite`'s
// compiler) with those exact options and reading the resulting Vega view's
// internal `*_width`/`*_height` signals — verified across a facet operator
// (`trellis_barley`'s `child_width`), a `concat` grid
// (`concat_marginal_histograms`'s `concat_0_width`/`concat_1_height`), a
// `vconcat` (`vconcat_weather`'s shared `childHeight`), and a wrapping facet
// (`trellis_scatter`'s `child_width`/`child_height`) — all four resolve to
// 200, not 300.
const VEGA_DEFAULT_VIEW = 200;
/** Vega-Lite's default band `step` (px per discrete category). */
const VEGA_DEFAULT_STEP = 20;
// A trellis cell's plot is `cell size − axis space`; these mirror the shell's
// FACET_CELL_MARGIN so the cell's plot equals Vega's cell plot. The y-axis
// allowance is a floor — `yAxisAllowance` below grows it for long category
// labels (a fixed 60px truncates something like "Wisconsin No. 38" to
// "Wisc…", which also reads as a smaller/emptier cell than Vega's).
const CELL_Y_AXIS_ALLOWANCE = 60;
const CELL_X_AXIS_ALLOWANCE = 40;
const AXIS_LABEL_CHAR_PX = 7;
const CELL_Y_AXIS_ALLOWANCE_BASE = 38;

/** Padding to leave beside an axis that is hidden (`axis: null`) — just a small margin. */
const HIDDEN_AXIS_PAD = 8;

/**
 * The uniform drawing-area margin every trellis cell keeps, so the cells' plots
 * line up even though only the edge cells draw axis labels (matching Vega-Lite,
 * where faceted cells share one x/y axis). Lives here rather than in the shell
 * because `vegaCellSize` has to budget the same numbers when it sizes a cell —
 * the shell imports it back. The x allowance above deliberately equals
 * `bottom + top`, so a cell's height already covers both; the y allowance is the
 * LEFT side only, and `vegaCellSize` adds `right` explicitly.
 */
export const FACET_CELL_MARGIN = { top: 6, right: 8, bottom: 34, left: 52 };

/**
 * The longest tick-label length (chars) a shared y-axis will show, for margin
 * estimation. Nominal/ordinal axes measure their actual category strings; a
 * continuous quantitative axis has no fixed category array, but its tick
 * labels are still real, often-wide formatted numbers (e.g. a "US DVD Sales"
 * axis ticking up to "150,000,000") — estimate from the field's own value
 * extent, grouped the way x-charts' default number formatter renders it,
 * rather than treating every continuous axis as a fixed-width placeholder.
 */
function longestCategoryLabelChars(
  def: VegaChannelDef | undefined,
  rows: readonly DatasetRow[],
): number {
  if (!def || !isFieldDef(def) || !def.field) {
    return 1;
  }
  const fieldType = resolveFieldType(def, rows);
  if (fieldType === 'nominal' || fieldType === 'ordinal') {
    return distinctValues(rows, def.field).reduce<number>(
      (max, value) => Math.max(max, String(value).length),
      1,
    );
  }
  if (fieldType === 'quantitative') {
    const field = def.field;
    const values = rows
      .map((row) => toNumber(row[field]))
      .filter((value): value is number => value != null);
    if (values.length === 0) {
      return 1;
    }
    const extent = [Math.min(...values), Math.max(...values)];
    return extent.reduce<number>(
      (max, value) => Math.max(max, Math.round(value).toLocaleString('en-US').length),
      1,
    );
  }
  return 1;
}

/** Left margin (px) a shared trellis y-axis needs for its longest category label. */
function yAxisAllowance(def: VegaChannelDef | undefined, rows: readonly DatasetRow[]): number {
  // `axis: null` draws no y axis at all, so there are no labels to fit and the
  // cell only needs the small pad a hidden axis gets elsewhere. Budgeting the
  // full label allowance made `facet_grid_bar` — whose y axis IS null — reserve
  // 60px of empty gutter per cell.
  if (isFieldDef(def) && (def as { axis?: unknown }).axis === null) {
    return HIDDEN_AXIS_PAD;
  }
  const chars = longestCategoryLabelChars(def, rows);
  // Capped well below the longest real-world label (e.g. "Wisconsin No. 38",
  // 17 chars): x-charts' own `width: 'auto'` measurement — not this margin —
  // is what ultimately decides the axis's tick-label ellipsis, and it tops
  // out well short of that (a wrapper limitation, not something this pixel
  // budget can move past). Past this cap, growing the margin further just
  // adds dead space beside the already-settled label column instead of
  // revealing more text, so it stops short of matching every long label
  // exactly while still comfortably fitting short-to-medium ones.
  return Math.max(
    CELL_Y_AXIS_ALLOWANCE,
    CELL_Y_AXIS_ALLOWANCE_BASE + Math.min(chars, 10) * AXIS_LABEL_CHAR_PX,
  );
}

/** Inner-cell channel defs + explicit spec sizes, used to size a cell like Vega. */
interface CellSizing {
  xDef?: VegaChannelDef;
  yDef?: VegaChannelDef;
  specWidth?: VegaLiteSpec['width'];
  specHeight?: VegaLiteSpec['height'];
  /** The cell's mark type — `bar`/`rect`/`tick` band a numeric category axis. */
  mark?: string;
}

/** Marks that draw a numeric non-value channel on a discrete band scale (as Vega does). */
const BAND_MARKS = new Set(['bar', 'rect', 'tick']);

/**
 * The plot size Vega-Lite gives one axis of a view: a numeric spec size wins; a
 * discrete axis uses step-based sizing (`step × distinctCategoryCount`, default
 * step 20); everything else (continuous, temporal, binned) uses Vega's default
 * view size. A bar/rect/tick mark bands even a numeric category channel (its
 * non-aggregated positional field), so that is sized discretely too — otherwise
 * a `{step}` on such an axis (e.g. `trellis_bar`'s numeric `age`) is ignored.
 */
function vegaAxisPlotSize(
  specSize: VegaLiteSpec['width'] | undefined,
  def: VegaChannelDef | undefined,
  rows: readonly DatasetRow[],
  mark: string | undefined,
): number {
  if (typeof specSize === 'number') {
    return specSize;
  }
  // A `timeUnit` field is binned into a handful of time buckets (12 months, 4
  // quarters, …) at compile time, but the raw field still holds thousands of
  // distinct dates — counting those here would size the axis enormously. Treat
  // it as continuous (default view) instead of step-sizing over raw dates.
  const hasTimeUnit = isFieldDef(def) && (def as { timeUnit?: unknown }).timeUnit != null;
  if (def && isFieldDef(def) && def.field && !def.bin && !hasTimeUnit) {
    const fieldType = resolveFieldType(def, rows);
    const bandedNumericCategory =
      mark != null && BAND_MARKS.has(mark) && def.aggregate === undefined;
    if (fieldType === 'nominal' || fieldType === 'ordinal' || bandedNumericCategory) {
      const count = distinctValues(rows, def.field).length;
      // Guard against a mis-inferred discrete field with an unreasonable number of
      // distinct values (e.g. an un-binned continuous field): beyond this the
      // step sizing is almost certainly wrong, so fall back to the default view.
      if (count > 0 && count <= 60) {
        const step =
          specSize &&
          typeof specSize === 'object' &&
          typeof (specSize as { step?: unknown }).step === 'number'
            ? (specSize as { step: number }).step
            : VEGA_DEFAULT_STEP;
        return step * count;
      }
    }
  }
  return VEGA_DEFAULT_VIEW;
}

/** A trellis cell sized like Vega's cell (its plot size plus the axis allowance). */
function vegaCellSize(
  sizing: CellSizing | undefined,
  rows: readonly DatasetRow[],
): { width: number; height: number; yAxisMargin: number } {
  const plotWidth = vegaAxisPlotSize(sizing?.specWidth, sizing?.xDef, rows, sizing?.mark);
  const plotHeight = vegaAxisPlotSize(sizing?.specHeight, sizing?.yDef, rows, sizing?.mark);
  const yMargin = yAxisAllowance(sizing?.yDef, rows);
  // The MIN_CELL floors are a safety net for INFERRED sizes; a spec that states
  // its own size has already answered the question, and clamping overrode it.
  // `facet_grid_bar` asks for a 60x24 plot (`width: 60`, `height: {step: 8}`)
  // and got a 100px-tall cell — bars over twice Vega's thickness.
  const explicitWidth = sizing?.specWidth !== undefined;
  const explicitHeight = sizing?.specHeight !== undefined;
  return {
    // The cell has to cover the plot, the y axis on its left AND the margin the
    // shell keeps on its right — budgeting only the axis side left every cell's
    // plot exactly `FACET_CELL_MARGIN.right` short of Vega's (measured: a
    // `trellis_bar` cell rendered a 315px plot against Vega's 323px).
    width: explicitWidth
      ? plotWidth + yMargin + FACET_CELL_MARGIN.right
      : Math.max(MIN_CELL_WIDTH, plotWidth + yMargin + FACET_CELL_MARGIN.right),
    height: explicitHeight
      ? plotHeight + CELL_X_AXIS_ALLOWANCE
      : Math.max(MIN_CELL_HEIGHT, plotHeight + CELL_X_AXIS_ALLOWANCE),
    yAxisMargin: yMargin,
  };
}

/** The inter-view gap Vega-Lite leaves between concatenated views (`spacing`). */
const CONCAT_SPACING = 15;
// The margin x-charts keeps on the side of a concat cell's plot OPPOSITE the
// drawn axis (right of the y axis, top of the x axis). Calibrated against the
// rendered geometry: an 80px-wide cell measured a 65px left margin and a 20px
// right one, so budgeting only the left allowance left the plot at −5px.
const CONCAT_PLOT_FAR_PAD = 24;
// A concat cell renders as its own chart with x-charts' DEFAULT_MARGINS (20 per
// side), so an edge that draws NO axis still costs 20 — and both edges of that
// dimension cost 40. The small `HIDDEN_AXIS_PAD` used for trellis cells is wrong
// here because those override their margins via `FACET_CELL_MARGIN` and concat
// cells do not: measured on `concat_population_pyramid`, a 208px budget for a
// 200px plot with `axis: null` rendered 168px, exactly 40 short.
const CONCAT_HIDDEN_AXIS_PAD = 40;
// An axis title is a second line beyond the tick labels. Measured on the same
// cells: a drawn x axis spans 23px with `title: ""` and 45px with a real title,
// and a y axis is wider by the same amount for its rotated title.
const AXIS_TITLE_ALLOWANCE = 22;

/** Whether a channel draws its axis (shown unless `axis: null`), i.e. reserves label room. */
function channelAxisShown(def: VegaChannelDef | undefined): boolean {
  return isFieldDef(def) && def.axis !== null;
}

/**
 * Whether a drawn axis also renders a title. Vega-Lite defaults an axis title to
 * the field name, so a field def is titled unless it opts out with `title: null`
 * or `title: ""` — which is exactly how `concat_marginal_histograms` keeps its
 * marginal count axes thin.
 */
function channelAxisTitled(def: VegaChannelDef | undefined): boolean {
  if (!isFieldDef(def)) {
    return false;
  }
  const title = (def as { title?: unknown }).title;
  const axisTitle = (def.axis as { title?: unknown } | null | undefined)?.title;
  const resolved = axisTitle !== undefined ? axisTitle : title;
  return resolved !== null && resolved !== '';
}

/**
 * The positional def a concat entry effectively draws on `channel`, resolving a
 * `layer` composite the way the compiler itself does: the view-level encoding
 * carries the shared scale/axis config while a child layer supplies the actual
 * field (e.g. `concat_layer_voyager_result`'s error-bar unit declares
 * `x: {type, scale, axis}` at view level and `x: {field: "lo"}` on its rule
 * layer). Merging entry-over-layer keeps the view's own `axis: null`/`scale`
 * authoritative while still seeing the field, so sizing no longer mistakes a
 * layered unit for one with no positional encoding at all.
 */
function concatChannelDef(entry: VegaLiteSpec, channel: 'x' | 'y'): VegaChannelDef | undefined {
  const own = (entry.encoding ?? {})[channel];
  if (isFieldDef(own)) {
    return own;
  }
  const layer = (entry as { layer?: VegaLiteSpec[] }).layer;
  if (!Array.isArray(layer)) {
    return own;
  }
  // Recurse: a layer child can itself be a layer composite (a `repeat.layer`
  // cell wraps one substituted copy of the template PER repeated field, and
  // each copy may be a layer in its own right). Looking only one level down
  // found no positional def at all for `line_color_halo`, so its cell fell to
  // the bare-step default and rendered a 28px-wide sliver.
  const fromLayer = layer
    .map((child) => concatChannelDef(child, channel))
    .find((def): def is VegaChannelDef => isFieldDef(def));
  if (!fromLayer) {
    return own;
  }
  // Entry-level props win (the view owns the shared axis/scale); the layer only
  // contributes what the view left unspecified — in practice the `field`.
  return { ...fromLayer, ...(own && typeof own === 'object' ? own : {}) } as VegaChannelDef;
}

/** The mark of a concat entry, falling back to a `layer` composite's first child. */
function concatMarkType(entry: VegaLiteSpec): string | undefined {
  const own = markTypeOf(entry.mark);
  if (own) {
    return own;
  }
  const layer = (entry as { layer?: Array<{ mark?: VegaLiteSpec['mark'] }> }).layer;
  return Array.isArray(layer)
    ? layer.map((child) => markTypeOf(child.mark)).find((mark) => mark != null)
    : undefined;
}

/**
 * The natural (Vega-like) size of a concat sub-view, so concatenated views keep
 * their own dimensions and butt together (`bounds: "flush"`) instead of each
 * stretching to fill the whole composition. A nested concat combines its
 * children — widths sum / heights max for an `hconcat`, heights sum / widths max
 * for a `vconcat`. A leaf takes its plot size (explicit spec size, else
 * step/continuous sizing) plus an axis allowance only for the axes it actually
 * draws (a hidden `axis: null` reserves nothing), so a marginal histogram's
 * 60px bar stays ~60px rather than ballooning to a full axis margin.
 */
function naturalConcatSize(
  entry: VegaLiteSpec,
  rows: readonly DatasetRow[],
): { width: number; height: number } {
  const hconcat = (entry as { hconcat?: VegaLiteSpec[] }).hconcat;
  const vconcat =
    (entry as { vconcat?: VegaLiteSpec[] }).vconcat ??
    (entry as { concat?: VegaLiteSpec[] }).concat;
  const children = hconcat ?? vconcat;
  if (Array.isArray(children) && children.length > 0) {
    const sizes = children.map((child) => naturalConcatSize(child, rows));
    const gap = CONCAT_SPACING * (children.length - 1);
    if (hconcat) {
      return {
        width: sizes.reduce((sum, size) => sum + size.width, 0) + gap,
        height: sizes.reduce((max, size) => Math.max(max, size.height), 0),
      };
    }
    return {
      width: sizes.reduce((max, size) => Math.max(max, size.width), 0),
      height: sizes.reduce((sum, size) => sum + size.height, 0) + gap,
    };
  }
  const encoding = (entry.encoding ?? {}) as VegaEncoding;
  const mark = concatMarkType(entry);
  const xDef = concatChannelDef(entry, 'x');
  const yDef = concatChannelDef(entry, 'y');
  const plotWidth = concatAxisPlotSize(entry.width, xDef, encoding, 'x', rows, mark);
  const plotHeight = concatAxisPlotSize(
    entry.height as VegaLiteSpec['width'],
    yDef,
    encoding,
    'y',
    rows,
    mark,
  );
  return {
    // The left y-axis widens the view; the bottom x-axis heightens it — but only
    // when that axis is actually drawn. A drawn axis also needs the OPPOSITE
    // margin counted: x-charts keeps a margin on the far side of the plot too,
    // and budgeting only the labelled side leaves the plot short by that much.
    // For a wide continuous view the shortfall is invisible, but a view whose
    // plot is a single 20px band (`concat_bar_scales_discretize`'s circle
    // strips) has no slack at all — the drawing area came out NEGATIVE, so
    // x-charts rendered no marks whatsoever.
    width:
      plotWidth +
      (channelAxisShown(yDef)
        ? yAxisAllowance(yDef, rows) +
          CONCAT_PLOT_FAR_PAD +
          (channelAxisTitled(yDef) ? AXIS_TITLE_ALLOWANCE : 0)
        : CONCAT_HIDDEN_AXIS_PAD),
    height:
      plotHeight +
      (channelAxisShown(xDef)
        ? CELL_X_AXIS_ALLOWANCE +
          CONCAT_PLOT_FAR_PAD +
          (channelAxisTitled(xDef) ? AXIS_TITLE_ALLOWANCE : 0)
        : CONCAT_HIDDEN_AXIS_PAD),
  };
}

/**
 * `vegaAxisPlotSize` for a concat child, adding the composed-view rule for a
 * positional channel that is absent *entirely* (not present-but-fieldless):
 * Vega-Lite sizes that axis as one implicit band (`bandspace(1) × step`, i.e.
 * 20px) rather than the 200px continuous default it would use for a standalone
 * unit — the same single implicit category `compile/scales.ts` synthesizes for
 * such a unit. Verified against `vega-lite`'s own compiler, which emits
 * `concat_1_height: 20` for `concat_layer_voyager_result`'s y-less arrow strip.
 * Without this the strip claims 200px and squeezes its sibling out of the view.
 */
function concatAxisPlotSize(
  specSize: VegaLiteSpec['width'] | undefined,
  def: VegaChannelDef | undefined,
  encoding: VegaEncoding,
  channel: 'x' | 'y',
  rows: readonly DatasetRow[],
  mark: string | undefined,
): number {
  if (typeof specSize !== 'number' && def === undefined && encoding[channel] === undefined) {
    const step =
      specSize &&
      typeof specSize === 'object' &&
      typeof (specSize as { step?: unknown }).step === 'number'
        ? (specSize as { step: number }).step
        : VEGA_DEFAULT_STEP;
    return step;
  }
  return vegaAxisPlotSize(specSize, def, rows, mark);
}

/** Default column count for a wrapping facet (roughly square). */
function defaultWrapColumns(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count)) || 1);
}

interface GridParams {
  rows: readonly DatasetRow[];
  rowField?: string;
  colField?: string;
  wrapField?: string;
  /** Explicit `columns` for a wrapping facet. */
  columns?: number;
  /** `sort` applied to the `row` facet's distinct values. */
  rowSort?: VegaSort;
  /** `sort` applied to the `column` facet's distinct values. */
  colSort?: VegaSort;
  /** `sort` applied to the wrapping (`facet`) field's distinct values. */
  wrapSort?: VegaSort;
  options: FacetOptions;
  /** Inner-cell x/y defs + spec sizes, for Vega-like per-cell sizing. */
  cellSizing?: CellSizing;
  // Build the leaf sub-spec for a partition of rows.
  makeCellSpec: (partition: readonly DatasetRow[]) => VegaLiteSpec;
}

/** Build the row-major grid for wrapping (`wrapField`) or matrix facets. */
function buildFacetGrid(params: GridParams): FacetPlan {
  const { rows, rowField, colField, wrapField, makeCellSpec } = params;
  const gaps: TranslationGap[] = [];

  if (rows.length === 0) {
    // Faceting partitions rows, so it needs resolvable data. `resolveRootRows`
    // returns [] for URL / CSV-string / topojson / single-object / missing
    // named datasets — sources the wrapper cannot slice — so the grid would be
    // empty with no explanation. Report it here (the single-view path reports
    // the equivalent `data:*` gaps through the compiler).
    gaps.push({
      code: 'facet:no-data',
      message:
        'The faceted spec resolved no rows to partition. Faceting requires inline `data.values` ' +
        '(an array of objects), a named dataset, or rows via the `data` prop; URL/CSV/TopoJSON ' +
        'sources are not sliced for faceting.',
      severity: 'unsupported',
      path: 'data',
    });
  }

  if (wrapField && !rowField && !colField) {
    const values = sortFacetValues(
      distinctValues(rows, wrapField),
      params.wrapSort,
      rows,
      wrapField,
      gaps,
    );
    const columns = Math.max(1, params.columns ?? defaultWrapColumns(values.length));
    const gridRows = Math.max(1, Math.ceil(values.length / columns) || 1);
    const { width, height, yAxisMargin } = vegaCellSize(params.cellSizing, rows);
    const cells = values.map((value, index) => ({
      key: `facet-${index}`,
      spec: makeCellSpec(rows.filter((row) => facetMatch(row, wrapField, value))),
      header: formatFacetValue(value),
      width,
      height,
    }));
    return { columns, rows: gridRows, cells, gaps, sharedAxes: true, yAxisMargin };
  }

  const rowValues = rowField
    ? sortFacetValues(distinctValues(rows, rowField), params.rowSort, rows, rowField, gaps)
    : [undefined];
  const colValues = colField
    ? sortFacetValues(distinctValues(rows, colField), params.colSort, rows, colField, gaps)
    : [undefined];
  const columns = Math.max(1, colValues.length);
  const gridRows = Math.max(1, rowValues.length);
  const { width, height, yAxisMargin } = vegaCellSize(params.cellSizing, rows);
  const cells: FacetCell[] = [];
  rowValues.forEach((rowValue, rowIndex) => {
    colValues.forEach((colValue, colIndex) => {
      const partition = rows.filter(
        (row) =>
          (rowField ? facetMatch(row, rowField, rowValue) : true) &&
          (colField ? facetMatch(row, colField, colValue) : true),
      );
      const headerParts: string[] = [];
      if (colField) {
        headerParts.push(formatFacetValue(colValue));
      }
      if (rowField) {
        headerParts.push(formatFacetValue(rowValue));
      }
      cells.push({
        key: `facet-${rowIndex}-${colIndex}`,
        spec: makeCellSpec(partition),
        header: headerParts.join(' × ') || undefined,
        width,
        height,
      });
    });
  });
  return {
    columns,
    rows: gridRows,
    cells,
    gaps,
    sharedAxes: true,
    yAxisMargin,
    rowHeaders: Boolean(rowField) && !colField,
  };
}

/** True when the spec uses the `facet` operator (`facet` + `spec`). */
function isFacetOperator(spec: VegaLiteSpec): boolean {
  return spec.facet !== undefined && spec.spec !== undefined;
}

/** True when the spec carries facet channels in its encoding. */
function hasFacetChannels(spec: VegaLiteSpec): boolean {
  const encoding = spec.encoding;
  return !!encoding && (!!encoding.row || !!encoding.column || !!encoding.facet);
}

/**
 * Applies a facet channel's inline `timeUnit` (e.g. `{field: 'date', timeUnit:
 * 'hours'}`), if any, before partitioning. Without this, faceting groups on
 * the raw field — for a `timeUnit`'d channel that means one (near-empty) cell
 * per distinct raw timestamp instead of one cell per time-unit bucket (24
 * cells for `hours`, 12 for `month`, …), which both mis-renders the trellis
 * and is combinatorially slow for a large dataset. Returns the rows with a
 * synthetic truncated column added (mirroring `applyInlineTimeUnit`'s other
 * callers) and the field name to actually group/sort/match on.
 */
function resolveFacetTimeUnit(
  def: VegaChannelDef | undefined,
  rows: readonly DatasetRow[],
  gaps: TranslationGap[],
  path: string,
): { rows: readonly DatasetRow[]; field: string | undefined } {
  if (!def || !isFieldDef(def) || !def.field) {
    return { rows, field: undefined };
  }
  const timeUnit = def.timeUnit;
  if (!timeUnit) {
    return { rows, field: def.field };
  }
  const collector = createGapCollector();
  const result = applyInlineTimeUnit(rows, def.field, timeUnit, collector, path);
  gaps.push(...collector.list());
  if (!result) {
    // Unsupported unit: `applyInlineTimeUnit` already recorded the gap; fall
    // back to the raw field rather than an all-null synthetic column.
    return { rows, field: def.field };
  }
  return { rows: result.rows, field: result.field };
}

/** Plan the `row`/`column`/`facet` encoding-channel form (unit spec + mark). */
function planFacetChannels(spec: VegaLiteSpec, options: FacetOptions): FacetPlan {
  const { rows: rootRows, gaps: transformGaps } = transformedRootRows(spec, options);
  const encoding = spec.encoding ?? {};
  const rowRes = resolveFacetTimeUnit(encoding.row, rootRows, transformGaps, 'encoding.row');
  const colRes = resolveFacetTimeUnit(
    encoding.column,
    rowRes.rows,
    transformGaps,
    'encoding.column',
  );
  const wrapRes = resolveFacetTimeUnit(
    encoding.facet,
    colRes.rows,
    transformGaps,
    'encoding.facet',
  );
  const rows = wrapRes.rows;
  const rowField = rowRes.field;
  const colField = colRes.field;
  const wrapField = wrapRes.field;
  const facetFields = [rowField, colField, wrapField].filter(Boolean) as string[];
  const cellEncoding = stripFacetChannels(injectSharedScales(encoding, rows, facetFields));
  const makeCellSpec = (partition: readonly DatasetRow[]): VegaLiteSpec => {
    // `encoding`/`title`/`transform` are rest siblings: encoding is replaced per
    // cell, the facet-level title must not repeat inside every cell, and the
    // top-level transforms were already applied to `rows` above — the cell gets
    // the transformed partition, so re-running them would be wrong.
    const { encoding, title, transform, ...rest } = spec;
    return { ...rest, data: { values: partition }, encoding: cellEncoding } as VegaLiteSpec;
  };
  const sortOf = (def: VegaChannelDef | undefined): VegaSort | undefined =>
    isFieldDef(def) ? def.sort : undefined;
  // A wrapping `facet` channel carries `columns` either on the channel def
  // itself (`encoding.facet.columns`, as Vega-Lite's own examples do) or at the
  // top level (`spec.columns`); the channel def wins.
  const facetColumns =
    numericSize((encoding.facet as { columns?: unknown } | undefined)?.columns) ??
    numericSize(spec.columns);
  const plan = buildFacetGrid({
    rows,
    rowField,
    colField,
    wrapField,
    columns: facetColumns,
    rowSort: sortOf(encoding.row),
    colSort: sortOf(encoding.column),
    wrapSort: sortOf(encoding.facet),
    options,
    cellSizing: {
      xDef: cellEncoding.x,
      yDef: cellEncoding.y,
      specWidth: spec.width,
      specHeight: spec.height,
      mark: markTypeOf(spec.mark),
    },
    makeCellSpec,
  });
  return { ...plan, gaps: [...transformGaps, ...plan.gaps] };
}

/** Plan the `facet` operator form (`facet: {row,column} | {field}` + `spec`). */
function planFacetOperator(spec: VegaLiteSpec, options: FacetOptions): FacetPlan {
  // Outer transforms run once on the whole dataset before partitioning; the
  // cell is the inner `spec` (which carries its own per-cell transforms), so
  // the outer transforms are naturally excluded from each cell.
  const { rows: rootRows, gaps: transformGaps } = transformedRootRows(spec, options);
  const facet = (spec.facet ?? {}) as {
    field?: string;
    type?: VegaFieldDef['type'];
    timeUnit?: VegaFieldDef['timeUnit'];
    row?: VegaFieldDef;
    column?: VegaFieldDef;
    sort?: VegaSort;
  };
  const sub = spec.spec as VegaLiteSpec | undefined;
  if (!sub) {
    return {
      columns: 1,
      rows: 1,
      cells: [],
      gaps: [
        {
          code: 'composition:facet',
          message:
            'The `facet` operator is missing its `spec`, so there is nothing to render in each cell.',
          severity: 'unsupported',
          path: 'facet',
        },
      ],
    };
  }
  const rowRes = resolveFacetTimeUnit(facet.row, rootRows, transformGaps, 'facet.row');
  const colRes = resolveFacetTimeUnit(facet.column, rowRes.rows, transformGaps, 'facet.column');
  // The flat wrapping form (`facet: {field, timeUnit, …}` with no row/column)
  // carries its own field/timeUnit directly on `facet`.
  const wrapDef = facet.field !== undefined ? (facet as VegaFieldDef) : undefined;
  const wrapRes = resolveFacetTimeUnit(wrapDef, colRes.rows, transformGaps, 'facet');
  const rows = wrapRes.rows;
  const rowField = rowRes.field;
  const colField = colRes.field;
  const wrapField = wrapRes.field;
  const facetFields = [rowField, colField, wrapField].filter(Boolean) as string[];
  const sharedEncoding = sub.encoding
    ? injectSharedScales(sub.encoding, rows, facetFields)
    : undefined;
  const makeCellSpec = (partition: readonly DatasetRow[]): VegaLiteSpec => {
    const cell = { ...sub, data: { values: partition } } as VegaLiteSpec;
    if (sharedEncoding) {
      cell.encoding = sharedEncoding;
    }
    return cell;
  };
  const plan = buildFacetGrid({
    rows,
    rowField,
    colField,
    wrapField,
    columns: numericSize(spec.columns),
    rowSort: facet.row?.sort,
    colSort: facet.column?.sort,
    wrapSort: facet.sort,
    options,
    cellSizing: {
      xDef: sharedEncoding?.x ?? sub.encoding?.x,
      yDef: sharedEncoding?.y ?? sub.encoding?.y,
      specWidth: (sub as { width?: VegaLiteSpec['width'] }).width ?? spec.width,
      specHeight: (sub as { height?: VegaLiteSpec['height'] }).height ?? spec.height,
      mark: markTypeOf(sub.mark),
    },
    makeCellSpec,
  });
  return { ...plan, gaps: [...transformGaps, ...plan.gaps] };
}

/**
 * Rows a concat entry resolves against for shared-domain purposes: the shared
 * root rows, unless the entry supplies its own inline `data.values` array — a
 * named/URL data source is left alone (mirrors the "own data wins" rule
 * `planConcat`'s cell-building already follows; there's no cheap way to
 * resolve a named/URL source's rows this early without duplicating the
 * normalizer's own resolution).
 */
function concatEntryRows(
  entry: VegaLiteSpec,
  rootRows: readonly DatasetRow[],
): readonly DatasetRow[] | undefined {
  if (entry.data == null) {
    return rootRows;
  }
  const values = (entry.data as { values?: unknown }).values;
  return Array.isArray(values) ? (values as DatasetRow[]) : undefined;
}

/**
 * Every encoding within a concat entry that carries this channel — the
 * entry's own top-level `encoding`, plus (for a `layer` entry, e.g. a mosaic
 * cell's rect+label layer pair) each child layer's own encoding. A child with
 * no own encoding inherits the entry's, which is already included once, so it
 * isn't listed again.
 */
function collectConcatChannelOccurrences(
  entry: VegaLiteSpec,
  rootRows: readonly DatasetRow[],
  channel: 'x' | 'y',
): Array<{ encoding: VegaEncoding; rows: readonly DatasetRow[] }> {
  const rows = concatEntryRows(entry, rootRows);
  if (!rows) {
    return [];
  }
  const encodings: VegaEncoding[] = [];
  if (entry.encoding) {
    encodings.push(entry.encoding);
  }
  const layer = (entry as { layer?: Array<{ encoding?: VegaEncoding }> }).layer;
  if (Array.isArray(layer)) {
    layer.forEach((child) => {
      if (child.encoding) {
        encodings.push(child.encoding);
      }
    });
  }
  return encodings
    .filter((encoding) => isFieldDef(encoding[channel]))
    .map((encoding) => ({ encoding, rows }));
}

/**
 * Union `[min, max]` domain for a channel across every entry/layer occurrence
 * `collectConcatChannelOccurrences` found, reusing the same aggregate-aware
 * `quantDomain`/`buildGroupKey` facet's own shared-scale injection
 * uses (no faceting fields here, so `buildGroupKey` only groups by the
 * occurrence's own other positional channel). An occurrence with its own
 * explicit `scale.domain` is skipped — its authored domain stands, and it
 * contributes nothing to the union. `undefined` when nothing quantitative
 * resolves at all.
 */
function concatSharedDomain(
  occurrences: Array<{ encoding: VegaEncoding; rows: readonly DatasetRow[] }>,
  channel: 'x' | 'y',
): [number, number] | undefined {
  let min: number | undefined;
  let max: number | undefined;
  for (const { encoding, rows } of occurrences) {
    const def = encoding[channel];
    if (!isFieldDef(def) || resolveFieldType(def, rows) !== 'quantitative') {
      continue;
    }
    const scale = def.scale && typeof def.scale === 'object' ? (def.scale as VegaScale) : undefined;
    if (Array.isArray(scale?.domain)) {
      continue;
    }
    const domain = quantDomain(def, rows, buildGroupKey(encoding, [], channel, rows));
    if (domain) {
      min = min === undefined ? domain[0] : Math.min(min, domain[0]);
      max = max === undefined ? domain[1] : Math.max(max, domain[1]);
    }
  }
  return min !== undefined && max !== undefined ? [min, max] : undefined;
}

/**
 * Overwrites a channel's `scale.domain` with the shared union domain on an
 * entry's own encoding and on every child layer's own encoding (a child with
 * no own encoding inherits the entry's, already updated) — mirroring facet's
 * `injectSharedScales`, but applied independently across each concat entry's
 * differently-shaped encoding instead of one shared template. An occurrence
 * with its own explicit domain is left untouched.
 */
function injectConcatSharedDomain(
  entry: VegaLiteSpec,
  channel: 'x' | 'y',
  domain: [number, number],
): VegaLiteSpec {
  const inject = (encoding: VegaEncoding): VegaEncoding => {
    const def = encoding[channel];
    if (!isFieldDef(def)) {
      return encoding;
    }
    const scale = def.scale && typeof def.scale === 'object' ? (def.scale as VegaScale) : undefined;
    if (Array.isArray(scale?.domain)) {
      return encoding;
    }
    return { ...encoding, [channel]: { ...def, scale: { ...(scale ?? {}), domain } } };
  };

  const nextEncoding = entry.encoding ? inject(entry.encoding) : entry.encoding;
  const layer = (entry as { layer?: Array<{ encoding?: VegaEncoding }> }).layer;
  if (Array.isArray(layer)) {
    return {
      ...entry,
      encoding: nextEncoding,
      layer: layer.map((child) =>
        child.encoding ? { ...child, encoding: inject(child.encoding) } : child,
      ),
    } as VegaLiteSpec;
  }
  return { ...entry, encoding: nextEncoding } as VegaLiteSpec;
}

/** Plan `hconcat`/`vconcat`/`concat`: independent sub-specs, no partitioning. */
function planConcat(spec: VegaLiteSpec, options: FacetOptions): FacetPlan {
  const gaps: TranslationGap[] = [];
  // A `concat`/`hconcat`/`vconcat` spec's own top-level `transform` (a sibling
  // of the composition array) is shared preprocessing that must run once before
  // the result is handed to every cell — the same rule already applied to
  // facet/repeat via `transformedRootRows`. Without it, a cell relying on a
  // root-level `calculate`/`filter`/`aggregate` etc. sees only the raw,
  // untransformed rows.
  const { rows: rootRows, gaps: rootTransformGaps } = transformedRootRows(spec, options);
  gaps.push(...rootTransformGaps);

  let entries: VegaLiteSpec[];
  let columns: number;
  if (spec.hconcat) {
    entries = spec.hconcat as VegaLiteSpec[];
    columns = Math.max(1, entries.length);
  } else if (spec.vconcat) {
    entries = spec.vconcat as VegaLiteSpec[];
    columns = 1;
  } else {
    entries = (spec.concat ?? []) as VegaLiteSpec[];
    columns = Math.max(1, (numericSize(spec.columns) ?? entries.length) || 1);
  }

  // Concat cells keep independent scales by default (Vega-Lite's own default),
  // but an explicit `resolve: {scale: {x: 'shared'}}` (or `y`) requests the
  // same shared-domain treatment facet gets — computed across every entry
  // (and each layer of a `layer` entry) instead of assuming one shared
  // template, since concat entries are independently shaped.
  const scaleResolve = ('resolve' in spec ? (spec as VegaLayerSpec).resolve : undefined)?.scale;
  for (const channel of ['x', 'y'] as const) {
    if (scaleResolve?.[channel] !== 'shared') {
      continue;
    }
    const occurrences = entries.flatMap((entry) =>
      collectConcatChannelOccurrences(entry, rootRows, channel),
    );
    const domain = concatSharedDomain(occurrences, channel);
    if (domain) {
      entries = entries.map((entry) => injectConcatSharedDomain(entry, channel, domain));
    }
  }

  const gridRows = Math.max(1, Math.ceil(entries.length / columns) || 1);
  // Concat subplots are full-size views, not the shrink-to-fit small multiples
  // of a facet grid: Vega-Lite lays each out at its natural size (see
  // `naturalConcatSize`, which sizes every cell below) and lets the composition
  // grow past the requested box rather than compressing panels into it. So the
  // available width is not divided among the cells — it only tells us whether
  // the composition will overflow, which is worth reporting.
  const rawWidth = Math.floor(options.width / columns);
  if (rawWidth < MIN_CELL_WIDTH) {
    gaps.push({
      code: 'facet:min-cell-size',
      message:
        `The ${columns}-column concatenation does not fit in the available ${options.width}px ` +
        'width; cells are clamped to a minimum width and the layout overflows. Increase `width` ' +
        'or reduce the number of concatenated views.',
      severity: 'partial',
      path: 'facet',
    });
  }

  const cells = entries.map((entry, index) => {
    // The entry title is surfaced as the cell header, so strip it from the spec
    // to avoid drawing it twice (`title` is a rest sibling here).
    const header = titleText(entry.title);
    const { title, ...entryRest } = entry;
    // Each entry resolves its own data, inheriting the top-level rows when it
    // declares none (mirrors the normalizer's data inheritance). Entries with
    // their own `data` (inline or named) are left untouched — the nested chart
    // resolves them (named datasets flow through the `datasets` prop).
    const cellSpec =
      entry.data == null && rootRows.length > 0
        ? ({ ...entryRest, data: { values: rootRows } } as VegaLiteSpec)
        : (entryRest as VegaLiteSpec);
    // Size each view to its own natural dimensions so concatenated views butt
    // together at their real sizes (Vega-Lite's `bounds: "flush"`) — a marginal
    // histogram's 60px bar stays a thin strip beside a square heatmap, rather
    // than every cell stretching to fill an equal share of the composition.
    const natural = naturalConcatSize(entry, rootRows);
    return {
      key: `concat-${index}`,
      spec: cellSpec,
      header,
      width: Math.max(40, natural.width),
      height: Math.max(40, natural.height),
    };
  });
  return { columns, rows: gridRows, cells, gaps };
}

/** Which `{repeat}` keys a substitution pass can resolve to concrete fields. */
type RepeatSubstitution = Partial<Record<'row' | 'column' | 'layer' | 'repeat', string>>;

/**
 * Deep-clone a repeat `spec` template, replacing every `{repeat: key}` field
 * reference with the concrete field bound to `key` in `values`.
 *   - Arrays recurse element-wise.
 *   - Plain objects recurse per entry, but `data`/`datasets` are copied verbatim
 *     (never scanned — a data row may legitimately contain a `{repeat: …}`-shaped
 *     value), and entries that substitute to `undefined` are omitted.
 *   - A reference to a key that is not currently being repeated resolves to
 *     `undefined`, and a `repeat:unresolved-ref` gap is recorded.
 */
function substituteRepeat<T>(
  node: T,
  values: RepeatSubstitution,
  gaps: TranslationGap[],
): T | undefined {
  if (isRepeatRef(node)) {
    const key = (node as VegaRepeatRef).repeat;
    const field = values[key];
    if (field === undefined) {
      gaps.push({
        code: 'repeat:unresolved-ref',
        message:
          `A \`{repeat: "${key}"}\` field reference in the repeat template has no matching ` +
          `repeated field, so that channel was dropped. Bind "${key}" in the \`repeat\` mapping ` +
          'or remove the reference.',
        severity: 'partial',
        path: 'repeat',
      });
      return undefined;
    }
    return field as unknown as T;
  }
  if (Array.isArray(node)) {
    return node.map((item) => substituteRepeat(item, values, gaps)) as unknown as T;
  }
  if (node && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'data' || key === 'datasets') {
        result[key] = value;
        continue;
      }
      const substituted = substituteRepeat(value, values, gaps);
      if (substituted !== undefined) {
        result[key] = substituted;
      }
    }
    return result as unknown as T;
  }
  return node;
}

/** The uniform empty plan returned when a `repeat` spec cannot be expanded. */
function repeatGapPlan(message: string): FacetPlan {
  return {
    columns: 1,
    rows: 1,
    cells: [],
    gaps: [{ code: 'composition:repeat', message, severity: 'unsupported', path: 'repeat' }],
  };
}

/**
 * Plan the `repeat` operator (`repeat` mapping + shared `spec` template).
 *
 * Repetition does not partition rows — every cell plots the full dataset through
 * a different field, substituted into the template wherever a `{repeat}` ref
 * appears. The flat `string[]` form wraps into a grid (`columns`); the
 * `{row, column}` form builds a matrix; `layer` repeats the template into a
 * layered spec within each cell. Cells keep independent scales (see the module
 * header) — no shared domain is injected.
 */
/**
 * A repeat cell's size, taken from the cell's OWN spec the way Vega sizes it
 * (`naturalConcatSize`, exactly as `planConcat` does) rather than by dividing
 * the available area between the cells.
 *
 * `cellSize` splits `options.width`/`height` across the grid, so a 1x3 repeat
 * handed the gallery's 440x340 gave each cell the full 340px height —
 * `interactive_crossfilter` rendered 400px-tall cells against Vega's 200px
 * ones, roughly 1.6x the reference's ink. Vega sizes a repeat child from its
 * own encoding (defaulting to VEGA_DEFAULT_VIEW), independent of how many
 * siblings it has.
 */
function repeatCellSize(
  cellSpec: VegaLiteSpec,
  rows: readonly DatasetRow[],
): { width: number; height: number } {
  return naturalConcatSize(cellSpec, rows);
}

function planRepeat(spec: VegaLiteSpec, options: FacetOptions): FacetPlan {
  const template = spec.spec as VegaLiteSpec | undefined;
  if (!template || typeof template !== 'object') {
    return repeatGapPlan(
      'The `repeat` operator is missing its `spec` template, so there is nothing to repeat.',
    );
  }
  const gaps: TranslationGap[] = [];
  // A `repeat` spec's own top-level `transform` (a sibling of `repeat`/`spec`)
  // is a preprocessing step shared by every repeated cell — e.g. a `pivot`
  // reshaping long-format data into the per-symbol columns a `repeat.layer`
  // template's `{field: {repeat: 'layer'}}` refs expect (`line_color_halo`).
  // Applying it here (once, before repeating) rather than leaving it for each
  // cell to re-run matches `transformedRootRows`'s use elsewhere for facets.
  const { rows: rootRows, gaps: rootTransformGaps } = transformedRootRows(spec, options);
  gaps.push(...rootTransformGaps);
  const templateHasData = template.data != null;
  // Repeat never partitions: a cell without its own template data plots every row.
  const cellData = templateHasData ? (template.data as unknown) : { values: rootRows };

  const repeat = spec.repeat;

  // Flat form: `repeat: ['a', 'b', …]`, refs use `{repeat: 'repeat'}`.
  if (Array.isArray(repeat)) {
    const fields = repeat.filter((field): field is string => typeof field === 'string');
    if (fields.length === 0) {
      return repeatGapPlan(
        'The `repeat` array is empty (or holds no field names), so no cells can be produced.',
      );
    }
    const columns = Math.max(1, numericSize(spec.columns) ?? defaultWrapColumns(fields.length));
    const gridRows = Math.max(1, Math.ceil(fields.length / columns) || 1);
    const cells = fields.map((field, index) => {
      const substituted = substituteRepeat(template, { repeat: field }, gaps) as VegaLiteSpec;
      const cellSpec = templateHasData
        ? substituted
        : ({ ...substituted, data: cellData } as VegaLiteSpec);
      const { width, height } = repeatCellSize(cellSpec, rootRows);
      return { key: `repeat-${index}`, spec: cellSpec, header: field, width, height };
    });
    return { columns, rows: gridRows, cells, gaps };
  }

  // Matrix form: `repeat: {row?, column?, layer?}`. An empty array is treated as
  // "not present" so `{row: ['a'], column: []}` stays a row-only repeat instead
  // of collapsing the grid to zero cells.
  const mapping = (repeat ?? {}) as VegaRepeatMapping;
  const asFields = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.length > 0 ? (value as string[]) : undefined;
  const rowFields = asFields(mapping.row);
  const colFields = asFields(mapping.column);
  const layerFields = asFields(mapping.layer);
  if (!rowFields && !colFields && !layerFields) {
    return repeatGapPlan(
      'The `repeat` mapping declares no `row`, `column`, or `layer` field arrays (nor a flat ' +
        'field array), so no cells can be produced.',
    );
  }

  const rowValues = rowFields ?? [undefined];
  const colValues = colFields ?? [undefined];
  const columns = Math.max(1, colValues.length);
  const gridRows = Math.max(1, rowValues.length);
  const cells: FacetCell[] = [];
  rowValues.forEach((rowField, rowIndex) => {
    colValues.forEach((colField, colIndex) => {
      const cellSubs: RepeatSubstitution = {};
      if (rowFields) {
        cellSubs.row = rowField;
      }
      if (colFields) {
        cellSubs.column = colField;
      }
      let cellSpec: VegaLiteSpec;
      if (layerFields) {
        // Layer the template once per layer field within the cell; each layer
        // copy drops its own data — the shared cell data lives on the wrapper.
        const layer = layerFields.map((layerField) => {
          const copy = substituteRepeat(
            template,
            { ...cellSubs, layer: layerField },
            gaps,
          ) as VegaLiteSpec;
          const { data, ...rest } = copy;
          return rest as VegaLiteSpec;
        });
        cellSpec = { data: cellData, layer } as unknown as VegaLiteSpec;
      } else {
        const copy = substituteRepeat(template, cellSubs, gaps) as VegaLiteSpec;
        cellSpec = templateHasData ? copy : ({ ...copy, data: cellData } as VegaLiteSpec);
      }
      const header = [colField, rowField].filter(Boolean).join(' × ') || undefined;
      const { width, height } = repeatCellSize(cellSpec, rootRows);
      cells.push({ key: `repeat-${rowIndex}-${colIndex}`, spec: cellSpec, header, width, height });
    });
  });
  return { columns, rows: gridRows, cells, gaps };
}

/**
 * Detect and plan a composite spec. Returns `null` for a plain unit/layer spec
 * (the shell renders it directly). Facet, concat and `repeat` compositions each
 * expand into a `FacetPlan` grid that `<VegaLiteChart />` renders cell-by-cell.
 */
export function planFacets(spec: VegaLiteSpec, options: FacetOptions): FacetPlan | null {
  if (spec.repeat !== undefined) {
    return planRepeat(spec, options);
  }
  if (isFacetOperator(spec)) {
    return planFacetOperator(spec, options);
  }
  if (hasFacetChannels(spec)) {
    return planFacetChannels(spec, options);
  }
  if (spec.hconcat || spec.vconcat || spec.concat) {
    return planConcat(spec, options);
  }
  return null;
}

/** Resolve the total grid size from props/spec, falling back to defaults. */
export function resolveGridSize(
  spec: VegaLiteSpec,
  width: number | undefined,
  height: number | undefined,
): { width: number; height: number } {
  return {
    width: width ?? numericSize(spec.width) ?? DEFAULT_TOTAL_WIDTH,
    height: height ?? numericSize(spec.height) ?? DEFAULT_TOTAL_HEIGHT,
  };
}
