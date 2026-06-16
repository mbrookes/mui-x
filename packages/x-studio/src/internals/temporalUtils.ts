import type { StudioDataSource } from '../models';

export type XGroupBy = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * Converts a sort-stable period key (output of truncateToGranularity) to an
 * inclusive [from, to] date range string pair suitable for a `between` filter.
 *
 * '2024-Q1'   → { from: '2024-01-01', to: '2024-03-31' }
 * '2024-01'   → { from: '2024-01-01', to: '2024-01-31' }
 * '2024'      → { from: '2024-01-01', to: '2024-12-31' }
 * '2024-W03'  → { from: '2024-01-15', to: '2024-01-21' }
 * '2024-01-15' → { from: '2024-01-15', to: '2024-01-15' }
 */
export function periodKeyToDateRange(key: string): { from: string; to: string } | null {
  // Day: '2024-01-15'
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return { from: key, to: key };
  }
  // Quarter: '2024-Q1'
  const qMatch = key.match(/^(\d{4})-Q([1-4])$/);
  if (qMatch) {
    const year = qMatch[1];
    const q = Number(qMatch[2]);
    const firstMonth = (q - 1) * 3 + 1;
    const lastMonth = firstMonth + 2;
    const lastDay = new Date(Date.UTC(Number(year), lastMonth, 0)).getUTCDate();
    return {
      from: `${year}-${String(firstMonth).padStart(2, '0')}-01`,
      to: `${year}-${String(lastMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  // Month: '2024-01'
  const mMatch = key.match(/^(\d{4})-(\d{2})$/);
  if (mMatch) {
    const lastDay = new Date(Date.UTC(Number(mMatch[1]), Number(mMatch[2]), 0)).getUTCDate();
    return {
      from: `${mMatch[1]}-${mMatch[2]}-01`,
      to: `${mMatch[1]}-${mMatch[2]}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  // Year: '2024'
  if (/^\d{4}$/.test(key)) {
    return { from: `${key}-01-01`, to: `${key}-12-31` };
  }
  // Week: '2024-W03'
  const wMatch = key.match(/^(\d{4})-W(\d{2})$/);
  if (wMatch) {
    const year = Number(wMatch[1]);
    const week = Number(wMatch[2]);
    // ISO week 1 contains Jan 4. Monday is day 1.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
    const weekStart = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
    const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return { from: fmt(weekStart), to: fmt(weekEnd) };
  }
  return null;
}

/** Normalise any date-like value (Date, ms number, or string) to a Date. */
export function normalizeToDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Normalise all date/datetime field values in a data source's rows to canonical
 * ISO strings on ingestion, so the rest of the system can assume a single format.
 *
 * - `date`     fields → `"YYYY-MM-DD"`
 * - `datetime` fields → `"YYYY-MM-DDTHH:mm:ss.sssZ"` (full ISO-8601 UTC)
 *
 * Accepts JS `Date` objects, millisecond timestamps (numbers), and any string
 * that `new Date()` can parse. The format is inferred once from the first
 * non-null value of each field; if it's already canonical every row is skipped
 * without per-cell regex checks.
 */
/**
 * Returns a normalized copy of `dataSource`.
 *
 * When `usedFieldIds` is provided, only the fields in that set are processed:
 * - Date/datetime normalization: only for date-type fields in the set
 * - `fieldDistinctValues`: only for categorical (string/boolean) fields in the set
 *
 * Omitting `usedFieldIds` processes all fields (backward-compatible, source-scoped).
 */
export function normalizeDataSourceRows(
  dataSource: StudioDataSource,
  usedFieldIds?: ReadonlySet<string>,
): StudioDataSource {
  if (!dataSource.rows || dataSource.rows.length === 0) {
    return dataSource;
  }

  const allDateFieldIds = dataSource.fields.flatMap((f) => (f.type === 'date' ? [f.id] : []));
  const allDatetimeFieldIds = dataSource.fields.flatMap((f) =>
    f.type === 'datetime' ? [f.id] : [],
  );

  // When usedFieldIds is provided, scope to only the requested date fields.
  const dateFieldIds = usedFieldIds
    ? allDateFieldIds.filter((id) => usedFieldIds.has(id))
    : allDateFieldIds;
  const datetimeFieldIds = usedFieldIds
    ? allDatetimeFieldIds.filter((id) => usedFieldIds.has(id))
    : allDatetimeFieldIds;

  // ── Date normalization ────────────────────────────────────────────────────

  let rows = dataSource.rows;

  if (dateFieldIds.length > 0 || datetimeFieldIds.length > 0) {
    const { rows: originalRows } = dataSource;

    // Infer once per field: find the first non-null value and decide whether
    // normalization is needed at all. Fields already in canonical form are excluded.
    const dateIdsToNormalize = dateFieldIds.filter((id) => {
      const sample = originalRows.find((r) => r[id] != null)?.[id];
      return (
        sample !== undefined && !(typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sample))
      );
    });
    const datetimeIdsToNormalize = datetimeFieldIds.filter((id) => {
      const sample = originalRows.find((r) => r[id] != null)?.[id];
      return (
        sample !== undefined && !(typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(sample))
      );
    });

    if (dateIdsToNormalize.length > 0 || datetimeIdsToNormalize.length > 0) {
      rows = originalRows.map((row) => {
        let changed = false;
        const next: Record<string, unknown> = { ...row };

        for (const id of dateIdsToNormalize) {
          const raw = row[id];
          if (raw == null) {
            continue;
          }
          const d = normalizeToDate(raw);
          if (d) {
            next[id] = d.toISOString().slice(0, 10);
            changed = true;
          }
        }

        for (const id of datetimeIdsToNormalize) {
          const raw = row[id];
          if (raw == null) {
            continue;
          }
          const d = normalizeToDate(raw);
          if (d) {
            next[id] = d.toISOString();
            changed = true;
          }
        }

        return changed ? next : row;
      });
    }
  }

  // ── Pre-compute distinct values for string/boolean fields ─────────────────
  // Used by filter widgets to avoid an O(N) per-render scan for distinct values.
  // Only covers native fields (expression fields are computed from other sources
  // and cannot be pre-indexed at ingestion time).
  // When usedFieldIds is provided, only compute distinct values for those fields.
  const categoricalFields = dataSource.fields.filter(
    (f) =>
      (f.type === 'string' || f.type === 'boolean') && (!usedFieldIds || usedFieldIds.has(f.id)),
  );

  let fieldDistinctValues: Record<string, string[]> | undefined;

  if (categoricalFields.length > 0) {
    fieldDistinctValues = {};
    for (const f of categoricalFields) {
      const seen = new Set<string>();
      for (const row of rows) {
        const v = row[f.id];
        if (v != null && String(v) !== '') {
          seen.add(String(v));
        }
      }
      if (seen.size > 0) {
        fieldDistinctValues[f.id] = Array.from(seen).sort();
      }
    }
  }

  if (rows === dataSource.rows && !fieldDistinctValues) {
    return dataSource;
  }

  return { ...dataSource, rows, ...(fieldDistinctValues ? { fieldDistinctValues } : {}) };
}

/** ISO week number (1–53) for a given date. */
function isoWeek(d: Date): { year: number; week: number } {
  // Shift to Thursday of the same week (ISO weeks start on Monday)
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: tmp.getUTCFullYear(), week };
}

/**
 * Truncate a date-like value to a granularity and return a sort-stable ISO key.
 * Returns null if the value cannot be parsed as a date.
 *
 * Examples (UTC):
 *   'day'     → '2024-01-15'
 *   'week'    → '2024-W03'
 *   'month'   → '2024-01'
 *   'quarter' → '2024-Q1'
 *   'year'    → '2024'
 */
export function truncateToGranularity(value: unknown, granularity: XGroupBy): string | null {
  let y: number;
  let m: number; // 0-indexed
  let day: number;

  // Fast path: parse canonical ISO strings (YYYY-MM-DD or YYYY-MM-DDTHH:…) directly
  // without allocating a Date. This is the common case after normalizeDataSourceRows.
  if (typeof value === 'string' && value.length >= 10 && value[4] === '-' && value[7] === '-') {
    y = Number(value.slice(0, 4));
    m = Number(value.slice(5, 7)) - 1; // convert to 0-indexed
    day = Number(value.slice(8, 10));
  } else {
    const d = normalizeToDate(value);
    if (!d) {
      return null;
    }
    y = d.getUTCFullYear();
    m = d.getUTCMonth(); // 0-indexed
    day = d.getUTCDate();
  }

  switch (granularity) {
    case 'day': {
      const mm = String(m + 1).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    case 'week': {
      // isoWeek requires a Date — construct one only for this case.
      const d = new Date(Date.UTC(y, m, day));
      const { year, week } = isoWeek(d);
      return `${year}-W${String(week).padStart(2, '0')}`;
    }
    case 'month': {
      return `${y}-${String(m + 1).padStart(2, '0')}`;
    }
    case 'quarter': {
      const q = Math.floor(m / 3) + 1;
      return `${y}-Q${q}`;
    }
    case 'year': {
      return `${y}`;
    }
    default:
      return null;
  }
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Convert a sort-stable period key into a human-readable axis label.
 *
 * Examples:
 *   '2024-01-15' → 'Jan 15, 2024'
 *   '2024-W03'   → 'W03 2024'
 *   '2024-01'    → 'Jan 2024'
 *   '2024-Q1'    → 'Q1 2024'
 *   '2024'       → '2024'
 */
export function formatPeriodLabel(key: string): string {
  // Year only: '2024'
  if (/^\d{4}$/.test(key)) {
    return key;
  }
  // Quarter: '2024-Q1'
  const qMatch = key.match(/^(\d{4})-Q(\d)$/);
  if (qMatch) {
    return `Q${qMatch[2]} ${qMatch[1]}`;
  }
  // Week: '2024-W03'
  const wMatch = key.match(/^(\d{4})-W(\d{2})$/);
  if (wMatch) {
    return `Week ${parseInt(wMatch[2], 10)} ${wMatch[1]}`;
  }
  // Month: '2024-01'
  const mMatch = key.match(/^(\d{4})-(\d{2})$/);
  if (mMatch) {
    const monthIndex = parseInt(mMatch[2], 10) - 1;
    return `${MONTH_NAMES[monthIndex] ?? mMatch[2]} ${mMatch[1]}`;
  }
  // Day: '2024-01-15'
  const dMatch = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dMatch) {
    const monthIndex = parseInt(dMatch[2], 10) - 1;
    return `${MONTH_NAMES[monthIndex] ?? dMatch[2]} ${parseInt(dMatch[3], 10)}, ${dMatch[1]}`;
  }
  return key;
}

type TemporalLabelKind = 'day' | 'week' | 'month' | 'quarter' | 'year';

function parseTemporalLabelKind(label: string): TemporalLabelKind | null {
  if (/^\d{4}$/.test(label)) {
    return 'year';
  }
  if (/^\d{4}-Q[1-4]$/.test(label)) {
    return 'quarter';
  }
  if (/^\d{4}-W\d{2}$/.test(label)) {
    return 'week';
  }
  if (/^\d{4}-\d{2}$/.test(label)) {
    return 'month';
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(label) || /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(label)) {
    return 'day';
  }
  return null;
}

function parseIsoWeekLabel(label: string): Date | null {
  const match = label.match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  return monday;
}

function parseTemporalLabelValue(label: string, kind: TemporalLabelKind): Date | null {
  switch (kind) {
    case 'day':
      return normalizeToDate(label);
    case 'week':
      return parseIsoWeekLabel(label);
    case 'month': {
      const match = label.match(/^(\d{4})-(\d{2})$/);
      return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)) : null;
    }
    case 'quarter': {
      const match = label.match(/^(\d{4})-Q([1-4])$/);
      return match ? new Date(Date.UTC(Number(match[1]), (Number(match[2]) - 1) * 3, 1)) : null;
    }
    case 'year': {
      const match = label.match(/^(\d{4})$/);
      return match ? new Date(Date.UTC(Number(match[1]), 0, 1)) : null;
    }
    default:
      return null;
  }
}

// Mutates `date` in place rather than allocating a new Date per step.
// Callers must not reuse `date` after calling this.
function stepTemporalDateInPlace(date: Date, kind: TemporalLabelKind): void {
  switch (kind) {
    case 'day':
      date.setUTCDate(date.getUTCDate() + 1);
      break;
    case 'week':
      date.setUTCDate(date.getUTCDate() + 7);
      break;
    case 'month':
      date.setUTCMonth(date.getUTCMonth() + 1, 1);
      break;
    case 'quarter':
      date.setUTCMonth(date.getUTCMonth() + 3, 1);
      break;
    case 'year':
      date.setUTCFullYear(date.getUTCFullYear() + 1, 0, 1);
      break;
    default:
      break;
  }
}

function serializeTemporalLabel(date: Date, kind: TemporalLabelKind, sampleLabel: string): string {
  if (kind === 'day' && sampleLabel.includes('T')) {
    return date.toISOString();
  }
  return truncateToGranularity(date.toISOString(), kind) ?? sampleLabel;
}

export function fillTemporalLabelGaps(labels: (string | number)[]): (string | number)[] {
  if (labels.length < 2 || !labels.every((label) => typeof label === 'string')) {
    return labels;
  }

  const stringLabels = sortLabels(labels) as string[];
  const kind = parseTemporalLabelKind(stringLabels[0]);
  // Check only the last label for kind consistency — all labels in the same aggregation
  // bucket share the same format, so validating first + last is sufficient and avoids
  // running N regex executions across the full label set.
  if (!kind || parseTemporalLabelKind(stringLabels[stringLabels.length - 1]) !== kind) {
    return labels;
  }

  const start = parseTemporalLabelValue(stringLabels[0], kind);
  const end = parseTemporalLabelValue(stringLabels[stringLabels.length - 1], kind);
  if (!start || !end) {
    return labels;
  }

  const filled: string[] = [];
  // Use a single Date object mutated in place to avoid one allocation per step.
  const cursor = new Date(start);
  while (cursor <= end) {
    filled.push(serializeTemporalLabel(cursor, kind, stringLabels[0]));
    stepTemporalDateInPlace(cursor, kind);
  }

  return filled.length > stringLabels.length ? filled : labels;
}

export function getTemporalAxisData(labels: (string | number)[]): Date[] | null {
  if (labels.length === 0 || !labels.every((label) => typeof label === 'string')) {
    return null;
  }

  const stringLabels = sortLabels(labels) as string[];
  const kind = parseTemporalLabelKind(stringLabels[0]);

  // Check only first + last label for kind consistency — avoids N regex matches.
  if (kind && parseTemporalLabelKind(stringLabels[stringLabels.length - 1]) === kind) {
    const axisData = stringLabels.map((label) => parseTemporalLabelValue(label, kind));
    return axisData.every((value) => value != null) ? (axisData as Date[]) : null;
  }

  const axisData = stringLabels.map((label) => normalizeToDate(label));
  return axisData.every((value) => value != null) ? (axisData as Date[]) : null;
}

export function formatTemporalAxisLabel(value: Date | number, xGroupBy?: XGroupBy): string {
  const dateValue = value instanceof Date ? value : new Date(value);

  if (xGroupBy) {
    const grouped = truncateToGranularity(dateValue, xGroupBy);
    return grouped ? formatPeriodLabel(grouped) : dateValue.toISOString();
  }

  return dateValue.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// ─── Label sorting ────────────────────────────────────────────────────────────

export function sortLabels(labels: (string | number)[]): (string | number)[] {
  if (labels.length === 0) {
    return labels;
  }
  if (labels.every((l) => typeof l === 'number')) {
    return labels.toSorted((a, b) => (a as number) - (b as number));
  }
  const allDates = labels.every((l) => {
    const s = String(l);
    return s.length >= 4 && !Number.isNaN(Date.parse(s));
  });
  if (allDates) {
    return labels.toSorted((a, b) => Date.parse(String(a)) - Date.parse(String(b)));
  }
  const allNumericStrings = labels.every((l) => {
    const s = String(l);
    return s !== '' && !Number.isNaN(Number(s));
  });
  if (allNumericStrings) {
    return labels.toSorted((a, b) => Number(a) - Number(b));
  }
  return labels.toSorted((a, b) => String(a).localeCompare(String(b)));
}
