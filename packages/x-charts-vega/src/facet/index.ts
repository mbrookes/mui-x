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
 * sub-specs keep independent scales (Vega-Lite's default for concat), so no
 * domains are injected there. Repeat cells likewise keep INDEPENDENT scales —
 * each cell plots a different field, so a shared domain would be meaningless;
 * this is a deliberate deviation from Vega-Lite's default `resolve.scale` for
 * repeat.
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
  VegaChannelDef,
  VegaEncoding,
  VegaFieldDef,
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
  /** Facet-level gaps (min cell size, empty data, malformed operator, …). */
  gaps: TranslationGap[];
}

/** Resolve a numeric width/height, ignoring `'container'` / step objects. */
export function numericSize(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function fieldOf(def: VegaChannelDef | undefined): string | undefined {
  return isFieldDef(def) ? def.field : undefined;
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
  if (sort == null) {
    return values;
  }
  if (sort === 'ascending' || sort === 'descending') {
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
  const rows = applyTransforms(raw, transforms, collector, '$');
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
function collectGroupByFields(
  encoding: VegaEncoding,
  facetFields: string[],
  valueChannel: 'x' | 'y',
): string[] {
  const fields = new Set<string>(facetFields);
  const categoryChannel = valueChannel === 'y' ? 'x' : 'y';
  const def = encoding[categoryChannel];
  if (isFieldDef(def) && def.field && def.aggregate === undefined) {
    fields.add(def.field);
  }
  return [...fields];
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
  groupByFields: string[],
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
      const key = groupByFields.map((groupField) => String(row[groupField])).join('\u0000');
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
      const domain = quantDomain(def, rows, collectGroupByFields(encoding, facetFields, channel));
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
  return result;
}

/** Encoding with the facet channels removed (they never reach a leaf spec). */
function stripFacetChannels(encoding: VegaEncoding): VegaEncoding {
  const { row, column, facet, ...rest } = encoding;
  return rest;
}

/** Per-cell width/height, clamped to a minimum with a `partial` gap when hit. */
function cellSize(
  options: FacetOptions,
  columns: number,
  rows: number,
  gaps: TranslationGap[],
): { width: number; height: number } {
  const rawWidth = Math.floor(options.width / columns);
  const rawHeight = Math.floor(options.height / rows);
  const width = Math.max(MIN_CELL_WIDTH, rawWidth);
  const height = Math.max(MIN_CELL_HEIGHT, rawHeight);
  if (rawWidth < MIN_CELL_WIDTH || rawHeight < MIN_CELL_HEIGHT) {
    gaps.push({
      code: 'facet:min-cell-size',
      message:
        `The ${columns}×${rows} facet grid does not fit in the available ` +
        `${options.width}×${options.height} area; cells are clamped to a minimum size and ` +
        'the grid overflows. Increase `width`/`height` or reduce the number of facets.',
      severity: 'partial',
      path: 'facet',
    });
  }
  return { width, height };
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
  // Build the leaf sub-spec for a partition of rows.
  makeCellSpec: (partition: readonly DatasetRow[]) => VegaLiteSpec;
}

/** Build the row-major grid for wrapping (`wrapField`) or matrix facets. */
function buildFacetGrid(params: GridParams): FacetPlan {
  const { rows, rowField, colField, wrapField, options, makeCellSpec } = params;
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
    const { width, height } = cellSize(options, columns, gridRows, gaps);
    const cells = values.map((value, index) => ({
      key: `facet-${index}`,
      spec: makeCellSpec(rows.filter((row) => facetMatch(row, wrapField, value))),
      header: formatFacetValue(value),
      width,
      height,
    }));
    return { columns, rows: gridRows, cells, gaps, sharedAxes: true };
  }

  const rowValues = rowField
    ? sortFacetValues(distinctValues(rows, rowField), params.rowSort, rows, rowField, gaps)
    : [undefined];
  const colValues = colField
    ? sortFacetValues(distinctValues(rows, colField), params.colSort, rows, colField, gaps)
    : [undefined];
  const columns = Math.max(1, colValues.length);
  const gridRows = Math.max(1, rowValues.length);
  const { width, height } = cellSize(options, columns, gridRows, gaps);
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
  return { columns, rows: gridRows, cells, gaps, sharedAxes: true };
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

/** Plan the `row`/`column`/`facet` encoding-channel form (unit spec + mark). */
function planFacetChannels(spec: VegaLiteSpec, options: FacetOptions): FacetPlan {
  const { rows, gaps: transformGaps } = transformedRootRows(spec, options);
  const encoding = spec.encoding ?? {};
  const rowField = fieldOf(encoding.row);
  const colField = fieldOf(encoding.column);
  const wrapField = fieldOf(encoding.facet);
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
  const plan = buildFacetGrid({
    rows,
    rowField,
    colField,
    wrapField,
    columns: numericSize(spec.columns),
    rowSort: sortOf(encoding.row),
    colSort: sortOf(encoding.column),
    wrapSort: sortOf(encoding.facet),
    options,
    makeCellSpec,
  });
  return { ...plan, gaps: [...transformGaps, ...plan.gaps] };
}

/** Plan the `facet` operator form (`facet: {row,column} | {field}` + `spec`). */
function planFacetOperator(spec: VegaLiteSpec, options: FacetOptions): FacetPlan {
  // Outer transforms run once on the whole dataset before partitioning; the
  // cell is the inner `spec` (which carries its own per-cell transforms), so
  // the outer transforms are naturally excluded from each cell.
  const { rows, gaps: transformGaps } = transformedRootRows(spec, options);
  const facet = (spec.facet ?? {}) as {
    field?: string;
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
  const rowField = facet.row?.field;
  const colField = facet.column?.field;
  const wrapField = facet.field;
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
    makeCellSpec,
  });
  return { ...plan, gaps: [...transformGaps, ...plan.gaps] };
}

/** Plan `hconcat`/`vconcat`/`concat`: independent sub-specs, no partitioning. */
function planConcat(spec: VegaLiteSpec, options: FacetOptions): FacetPlan {
  const gaps: TranslationGap[] = [];
  const rootRows = resolveRootRows(spec, options);

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
  const gridRows = Math.max(1, Math.ceil(entries.length / columns) || 1);
  // Concat subplots are full-size views, not the shrink-to-fit small multiples
  // of a facet grid: Vega-Lite lays each out at its natural size and lets the
  // composition grow. So the width is divided across columns (to sit side by
  // side within the available width), but each row keeps the full requested
  // height instead of dividing it — otherwise a vconcat's lower panel is
  // compressed until its marks (e.g. binned-scatter bubbles) overlap.
  const rawWidth = Math.floor(options.width / columns);
  const width = Math.max(MIN_CELL_WIDTH, rawWidth);
  const height = Math.max(MIN_CELL_HEIGHT, options.height);
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
    return {
      key: `concat-${index}`,
      spec: cellSpec,
      header,
      width: numericSize(entry.width) ?? width,
      height: numericSize(entry.height) ?? height,
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
function planRepeat(spec: VegaLiteSpec, options: FacetOptions): FacetPlan {
  const template = spec.spec as VegaLiteSpec | undefined;
  if (!template || typeof template !== 'object') {
    return repeatGapPlan(
      'The `repeat` operator is missing its `spec` template, so there is nothing to repeat.',
    );
  }
  const gaps: TranslationGap[] = [];
  const rootRows = resolveRootRows(spec, options);
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
    const { width, height } = cellSize(options, columns, gridRows, gaps);
    const cells = fields.map((field, index) => {
      const substituted = substituteRepeat(template, { repeat: field }, gaps) as VegaLiteSpec;
      const cellSpec = templateHasData
        ? substituted
        : ({ ...substituted, data: cellData } as VegaLiteSpec);
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
  const { width, height } = cellSize(options, columns, gridRows, gaps);

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
