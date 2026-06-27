/**
 * Reads the survey Excel workbooks from `public/data/` and seeds a SQLite
 * database so the AI's `execute_query` tool can run SQL against them.
 *
 * Column names use underscores (valid SQL identifiers without quoting) via a
 * trivial dash→underscore conversion from the slugified header string.  The
 * client-side excelAdapter uses the same slugify logic with dashes, so the
 * mapping is 1-to-1: `submission-id` in the dashboard ↔ `submission_id` in SQL.
 *
 * All values are stored as TEXT so SQLite never mis-casts a numeric-looking
 * response string as a number.  The AI discovers column names via
 * `PRAGMA table_info(table_name)`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as XLSX from 'xlsx';
import type { Knex } from 'knex';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = resolve(__dirname, '../../public/data');

/** Mirrors the slugify logic in excelAdapter.ts. */
function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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

/** Dash-separated slug → underscore-separated SQL column name. */
function toSqlColumn(slug: string): string {
  return slug.replace(/-/g, '_');
}

interface ParsedSheet {
  tableName: string;
  columns: string[];
  rows: (string | null)[][];
}

function parseWorkbook(filePath: string, idPrefix: string): ParsedSheet[] {
  const buffer = readFileSync(filePath);
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheets: ParsedSheet[] = [];
  const usedSourceIds = new Set<string>();

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }

    const matrix = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(sheet, {
      header: 1,
      raw: true,
      blankrows: false,
      defval: null,
    });

    if (matrix.length === 0) {
      continue;
    }

    const headerRow = (matrix[0] ?? []) as (string | number | boolean | Date | null)[];
    const bodyRows = matrix.slice(1) as (string | number | boolean | Date | null)[][];
    const columnCount = matrix.reduce((max, row) => Math.max(max, row.length), 0);

    const usedColIds = new Set<string>();
    const columns: string[] = [];
    for (let col = 0; col < columnCount; col += 1) {
      const rawHeader = headerRow[col];
      const label =
        typeof rawHeader === 'string' && rawHeader.trim()
          ? rawHeader.trim()
          : `Column ${col + 1}`;
      const slug = dedupe(slugify(label) || `column-${col + 1}`, usedColIds);
      columns.push(toSqlColumn(slug));
    }

    const rows: (string | null)[][] = bodyRows.map((row) =>
      columns.map((_, col) => {
        const v = row[col] ?? null;
        if (v === null || v === '') {
          return null;
        }
        if (v instanceof Date) {
          return v.toISOString();
        }
        return String(v);
      }),
    );

    const slug = slugify(sheetName) || 'sheet';
    const sourceId = dedupe(`${idPrefix}-${slug}`, usedSourceIds);
    sheets.push({ tableName: toSqlColumn(sourceId), columns, rows });
  }

  return sheets;
}

export interface SeededTable {
  tableName: string;
  rowCount: number;
}

/**
 * Seeds the survey SQLite database from both Excel workbooks.
 * Drops and recreates each table on every call so restarts pick up file changes.
 */
export async function seedSurveyDatabase(db: Knex): Promise<SeededTable[]> {
  const workbooks: { file: string; idPrefix: string }[] = [
    { file: resolve(DATA_DIR, 'survey2025.xlsx'), idPrefix: 'survey-2025' },
    { file: resolve(DATA_DIR, 'survey2023.xlsx'), idPrefix: 'survey-2023' },
  ];

  const seeded: SeededTable[] = [];

  for (const { file, idPrefix } of workbooks) {
    const sheets = parseWorkbook(file, idPrefix);
    for (const { tableName, columns, rows } of sheets) {
      await db.schema.dropTableIfExists(tableName);
      await db.schema.createTable(tableName, (table) => {
        for (const col of columns) {
          table.text(col).nullable();
        }
      });

      if (rows.length > 0) {
        // SQLite caps the number of bound variables per statement
        // (SQLITE_MAX_VARIABLE_NUMBER, 32766). knex builds a multi-row insert
        // binding columns × rows values, and the survey sheets are wide, so a
        // fixed 500-row batch overflows the limit. Size each batch from the
        // column count (also capped at 500 for the compound-SELECT limit).
        const MAX_VARS = 32000;
        const BATCH = Math.max(1, Math.min(500, Math.floor(MAX_VARS / Math.max(1, columns.length))));
        for (let i = 0; i < rows.length; i += BATCH) {
          const records = rows.slice(i, i + BATCH).map((row) =>
            Object.fromEntries(columns.map((col, j) => [col, row[j] ?? null])),
          );
          await db(tableName).insert(records);
        }
      }

      seeded.push({ tableName, rowCount: rows.length });
    }
  }

  return seeded;
}
