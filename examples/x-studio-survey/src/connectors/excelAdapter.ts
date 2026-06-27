/**
 * Generic Excel (.xlsx) data-source adapter for x-studio.
 *
 * Reads any workbook and turns it into one or more x-studio data sources:
 *   - every sheet (tab) becomes a **separate** `StudioDataSource`
 *   - all sheets of a workbook are served by the **same** adapter instance
 *
 * The adapter is intentionally schema-agnostic: column names, field types
 * (string / number / boolean / date), and distinct values are all inferred
 * from the sheet contents, so it works with any spreadsheet, not just the
 * survey files shipped with this example.
 *
 * Rows are read once, in full, and cached in memory. x-studio's client-side
 * pipeline (filtering, grouping, aggregation) does the rest, so the adapter
 * itself only ever has to hand back the cached rows for a given source.
 *
 * The spreadsheet path is provided by the caller (hardcoded in this example,
 * see `surveyData.ts`), but `loadExcelWorkbook` accepts any URL the browser
 * can `fetch`, including files served from the app's `public/` directory.
 */
import * as XLSX from 'xlsx';
import type {
  StudioDataSource,
  StudioDataField,
  StudioDataSourceAdapter,
  StudioQueryDescriptor,
  StudioQueryResult,
} from '@mui/x-studio';

/** Maximum number of non-empty values sampled per column when inferring a type. */
const TYPE_SAMPLE_SIZE = 200;

type CellValue = string | number | boolean | Date | null;

/** Turn an arbitrary header string into a stable, slug-like field/source id. */
function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Ensure every id in a sequence is unique by suffixing `-2`, `-3`, … on collision. */
function dedupe(rawId: string, used: Set<string>): string {
  let id = rawId || 'column';
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let n = 2;
  while (used.has(`${id}-${n}`)) {
    n += 1;
  }
  id = `${id}-${n}`;
  used.add(id);
  return id;
}

function isBlank(value: CellValue): boolean {
  return value === null || value === undefined || value === '';
}

/** Infer a Studio field type from a sample of a column's non-blank values. */
function inferType(sample: CellValue[]): StudioDataField['type'] {
  if (sample.length === 0) {
    return 'string';
  }
  let allDate = true;
  let allNumber = true;
  let allBoolean = true;
  let anyTime = false;
  for (const value of sample) {
    if (value instanceof Date) {
      allNumber = false;
      allBoolean = false;
      if (value.getHours() || value.getMinutes() || value.getSeconds()) {
        anyTime = true;
      }
    } else if (typeof value === 'number') {
      allDate = false;
      allBoolean = false;
    } else if (typeof value === 'boolean') {
      allDate = false;
      allNumber = false;
    } else {
      allDate = false;
      allNumber = false;
      allBoolean = false;
    }
  }
  if (allDate) {
    return anyTime ? 'datetime' : 'date';
  }
  if (allNumber) {
    return 'number';
  }
  if (allBoolean) {
    return 'boolean';
  }
  return 'string';
}

/** Normalize a raw cell value for storage in a Studio row. */
function normalizeValue(value: CellValue, type: StudioDataField['type']): unknown {
  if (isBlank(value)) {
    return null;
  }
  if (value instanceof Date) {
    // Studio date/datetime fields are happiest with ISO strings.
    return type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString();
  }
  return value;
}

export interface ExcelSheetSource {
  source: StudioDataSource;
  rows: Record<string, unknown>[];
}

/**
 * Convert one worksheet into a `StudioDataSource` (fields + rows).
 *
 * The first row is treated as the header. Blank or duplicate headers are
 * given safe fallback ids so no column is silently dropped.
 */
function sheetToSource(
  sheet: XLSX.WorkSheet,
  sourceId: string,
  sheetLabel: string,
): ExcelSheetSource {
  const matrix = XLSX.utils.sheet_to_json<CellValue[]>(sheet, {
    header: 1,
    raw: true,
    blankrows: false,
    defval: null,
  });

  const headerRow = (matrix[0] ?? []) as CellValue[];
  const bodyRows = matrix.slice(1) as CellValue[][];
  const columnCount = matrix.reduce((max, row) => Math.max(max, row.length), 0);

  const usedIds = new Set<string>();
  const fields: StudioDataField[] = [];
  const columnIds: string[] = [];

  for (let col = 0; col < columnCount; col += 1) {
    const rawHeader = headerRow[col];
    const label =
      typeof rawHeader === 'string' && rawHeader.trim()
        ? rawHeader.trim()
        : `Column ${col + 1}`;
    const fieldId = dedupe(slugify(label) || `column-${col + 1}`, usedIds);
    columnIds.push(fieldId);

    const sample: CellValue[] = [];
    for (const row of bodyRows) {
      const value = row[col] ?? null;
      if (!isBlank(value)) {
        sample.push(value);
        if (sample.length >= TYPE_SAMPLE_SIZE) {
          break;
        }
      }
    }

    fields.push({ id: fieldId, label, type: inferType(sample) });
  }

  const rows: Record<string, unknown>[] = bodyRows.map((row) => {
    const record: Record<string, unknown> = {};
    for (let col = 0; col < columnCount; col += 1) {
      record[columnIds[col]] = normalizeValue(row[col] ?? null, fields[col].type);
    }
    return record;
  });

  return {
    source: { id: sourceId, label: sheetLabel, fields, rows },
    rows,
  };
}

/**
 * Split a multi-select cell value into individual option strings.
 *
 * The delimiter is `, ` (comma + space) at parenthesis depth 0.
 * Commas inside `(…)` or `[…]` are treated as part of the option text,
 * not as separators — e.g. "Component API (prop names, defaults)" is one option.
 */
function parseMultiSelectValue(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(' || ch === '[') {
      depth += 1;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth -= 1;
      current += ch;
    } else if (depth === 0 && ch === ',' && value[i + 1] === ' ') {
      const trimmed = current.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      current = '';
      i += 1; // skip the space after the comma
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) {
    parts.push(trimmed);
  }

  return parts;
}

/**
 * A single adapter instance that serves every sheet of one workbook.
 *
 * Because the whole workbook is already in memory, `getRows` just returns the
 * cached rows for the requested source — x-studio's pipeline applies the
 * filters and aggregations described by the query descriptor.
 *
 * When `multiSelectFields` is provided and the query's `groupBy` field is in
 * that set, each cell value is split on `, ` (paren-aware) and the row is
 * duplicated once per option — giving correct per-option counts for multi-select
 * survey questions.
 *
 * When `fieldValueTransforms` is provided, the transform for the `groupBy` field
 * (if any) is applied to each value after multi-select splitting — useful for
 * collapsing long-tail verbatim values into a named bucket (e.g. "Other").
 */
export function createExcelAdapter(
  rowsBySourceId: Map<string, Record<string, unknown>[]>,
  multiSelectFields?: ReadonlySet<string>,
  fieldValueTransforms?: Record<string, (value: string) => string>,
): StudioDataSourceAdapter {
  return {
    async getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult> {
      const baseRows = rowsBySourceId.get(descriptor.sourceId) ?? [];
      const groupBy = descriptor.groupBy;
      const transform = groupBy && fieldValueTransforms ? fieldValueTransforms[groupBy] : undefined;

      if (multiSelectFields && groupBy && multiSelectFields.has(groupBy)) {
        const field = groupBy;
        const expandedRows: Record<string, unknown>[] = [];
        for (const row of baseRows) {
          const rawValue = row[field];
          if (rawValue == null) {
            continue; // skip non-responses for this question
          }
          const options = parseMultiSelectValue(String(rawValue));
          for (const option of options) {
            expandedRows.push({ ...row, [field]: transform ? transform(option) : option });
          }
        }
        return { rows: expandedRows, totalCount: expandedRows.length };
      }

      if (transform && groupBy) {
        const field = groupBy;
        const transformedRows = baseRows.map((row) => {
          const rawValue = row[field];
          if (rawValue == null) {
            return row;
          }
          return { ...row, [field]: transform(String(rawValue)) };
        });
        return { rows: transformedRows, totalCount: transformedRows.length };
      }

      return { rows: baseRows, totalCount: baseRows.length };
    },
  };
}

export interface LoadedWorkbook {
  /** One data source per sheet, in workbook order. */
  sources: StudioDataSource[];
  /** The shared adapter that serves every sheet of this workbook. */
  adapter: StudioDataSourceAdapter;
}

export interface LoadExcelOptions {
  /** Prefix used to build each sheet's source id, e.g. `survey-2025`. */
  idPrefix: string;
  /** Optional prefix prepended to each sheet's display label. */
  labelPrefix?: string;
  /** Skip sheets whose (trimmed) name matches one of these. */
  excludeSheets?: string[];
  /**
   * Field IDs whose cells contain `, `-delimited multi-select values.
   * When the adapter receives a query grouped by one of these fields it
   * expands each row into one row per selection so per-option counts are
   * correct.  Commas inside `(…)` are not treated as delimiters.
   */
  multiSelectFields?: string[];
  /**
   * Per-field value transforms applied at query time when that field is used as
   * `groupBy`. For multi-select fields the transform runs on each individual
   * option after splitting; for regular fields it runs on the whole cell value.
   * Useful for collapsing long-tail verbatim responses into a named bucket —
   * e.g. `(v) => v.startsWith('Specific request:') ? 'Other' : v`.
   */
  fieldValueTransforms?: Record<string, (value: string) => string>;
}

/**
 * Fetch and parse an .xlsx workbook, returning one Studio data source per
 * sheet plus a single shared adapter. Works with any spreadsheet — the path
 * can be a `public/` asset, a blob URL, or any fetchable URL.
 */
export async function loadExcelWorkbook(
  url: string,
  options: LoadExcelOptions,
): Promise<LoadedWorkbook> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `MUI X Studio (Excel adapter): failed to load workbook from "${url}" ` +
        `(HTTP ${response.status} ${response.statusText}). ` +
        'Check that the file exists and the path is correct.',
    );
  }
  const buffer = await response.arrayBuffer();
  return parseExcelWorkbook(buffer, options);
}

/** Parse an already-fetched workbook buffer. Shared by the loader and tests. */
export function parseExcelWorkbook(
  buffer: ArrayBuffer | Uint8Array,
  options: LoadExcelOptions,
): LoadedWorkbook {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const exclude = new Set((options.excludeSheets ?? []).map((s) => s.trim()));

  const sources: StudioDataSource[] = [];
  const rowsBySourceId = new Map<string, Record<string, unknown>[]>();
  const usedSourceIds = new Set<string>();

  for (const sheetName of workbook.SheetNames) {
    if (exclude.has(sheetName.trim())) {
      continue;
    }
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }
    const sourceId = dedupe(
      `${options.idPrefix}-${slugify(sheetName) || 'sheet'}`,
      usedSourceIds,
    );
    const label = options.labelPrefix ? `${options.labelPrefix} — ${sheetName}` : sheetName;
    const { source, rows } = sheetToSource(sheet, sourceId, label);
    sources.push(source);
    rowsBySourceId.set(sourceId, rows);
  }

  const multiSelectSet = options.multiSelectFields?.length
    ? new Set(options.multiSelectFields)
    : undefined;

  return {
    sources,
    adapter: createExcelAdapter(rowsBySourceId, multiSelectSet, options.fieldValueTransforms),
  };
}
