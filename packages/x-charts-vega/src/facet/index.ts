/**
 * Faceting & view-composition planning.
 *
 * This module turns a composite Vega-Lite spec — one that uses `row`/`column`
 * facet channels, the `facet` operator, or `hconcat`/`vconcat`/`concat` — into
 * a flat, row-major grid of independent unit/layer sub-specs (`FacetPlan`).
 * The render shell (`<VegaLiteChart />`) renders one nested `<VegaLiteChart />`
 * per cell.
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
 *
 * Shared scales (Vega-Lite's default `resolve.scale: "shared"` for facets):
 * before building the sub-specs, the union domain is computed across the whole
 * dataset so every cell renders on the same axis. For the quantitative value
 * channel a `scale.domain: [min, max]` is injected (respecting an existing
 * explicit domain); for discrete positional channels the union category array
 * is injected as `sort` so every cell shows the same category order. Concat
 * sub-specs keep independent scales (Vega-Lite's default for concat), so no
 * domains are injected there.
 */
import type {
  DatasetRow,
  VegaChannelDef,
  VegaEncoding,
  VegaFieldDef,
  VegaLiteSpec,
  VegaScale,
} from '../types';
import { isFieldDef } from '../types';
import type { TranslationGap } from '../gaps';
import { resolveFieldType, toDate, toNumber } from '../compile/fieldTypes';
import { evaluateAggregate } from '../transforms/aggregateOps';
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
    const values = distinctValues(rows, wrapField);
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
    return { columns, rows: gridRows, cells, gaps };
  }

  const rowValues = rowField ? distinctValues(rows, rowField) : [undefined];
  const colValues = colField ? distinctValues(rows, colField) : [undefined];
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
  return { columns, rows: gridRows, cells, gaps };
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
  const rows = resolveRootRows(spec, options);
  const encoding = spec.encoding ?? {};
  const rowField = fieldOf(encoding.row);
  const colField = fieldOf(encoding.column);
  const wrapField = fieldOf(encoding.facet);
  const facetFields = [rowField, colField, wrapField].filter(Boolean) as string[];
  const cellEncoding = stripFacetChannels(injectSharedScales(encoding, rows, facetFields));
  const makeCellSpec = (partition: readonly DatasetRow[]): VegaLiteSpec => {
    // `encoding`/`title` are rest siblings: encoding is replaced per cell, and
    // the facet-level title must not repeat inside every cell.
    const { encoding, title, ...rest } = spec;
    return { ...rest, data: { values: partition }, encoding: cellEncoding } as VegaLiteSpec;
  };
  return buildFacetGrid({
    rows,
    rowField,
    colField,
    wrapField,
    columns: numericSize(spec.columns),
    options,
    makeCellSpec,
  });
}

/** Plan the `facet` operator form (`facet: {row,column} | {field}` + `spec`). */
function planFacetOperator(spec: VegaLiteSpec, options: FacetOptions): FacetPlan {
  const rows = resolveRootRows(spec, options);
  const facet = (spec.facet ?? {}) as {
    field?: string;
    row?: VegaFieldDef;
    column?: VegaFieldDef;
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
  return buildFacetGrid({
    rows,
    rowField,
    colField,
    wrapField,
    columns: numericSize(spec.columns),
    options,
    makeCellSpec,
  });
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
  const { width, height } = cellSize(options, columns, gridRows, gaps);

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

/**
 * Detect and plan a composite spec. Returns `null` for a plain unit/layer spec
 * (the shell renders it directly) and for `repeat` (kept as an unsupported gap
 * by `compileSpec`/`normalizeSpec`).
 */
export function planFacets(spec: VegaLiteSpec, options: FacetOptions): FacetPlan | null {
  if (spec.repeat !== undefined) {
    return null; // reported as `composition:repeat` by the compiler
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
