import { truncateToPeriod } from '@mui/x-studio-schema';
import type { StudioDataSource } from '../models';
import { DEFAULT_STUDIO_LOCALE_TEXT, type StudioLocaleText } from './localeText';
import { getStudioLocale } from './studioLocale';

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

/**
 * Whether a raw date input is in a timezone-aware format, i.e. one `new Date()` resolves
 * to a definite instant independent of the runtime timezone:
 * - a bare ISO date `YYYY-MM-DD` (parsed as UTC midnight), or
 * - an ISO datetime carrying an explicit zone (`Z` or `±hh:mm`).
 *
 * Everything else — non-ISO strings like `'1/15/2024'`, zone-less ISO datetimes, `Date`
 * objects, and numeric timestamps — is parsed in (or relative to) local time, so its
 * calendar date must be read from the LOCAL Y/M/D components rather than through UTC
 * (`toISOString`), which would day-shift for UTC+ viewers (finding 2.27).
 */
function isZonedDateInput(raw: unknown): boolean {
  if (typeof raw !== 'string') {
    return false;
  }
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(raw) || /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
  );
}

/** Formats a `Date` as `YYYY-MM-DD` from its LOCAL calendar components (no UTC conversion). */
function toLocalYmd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Normalises a raw date input to a canonical `YYYY-MM-DD` string. Timezone-aware inputs
 * round-trip through UTC (canonical ISO inputs are unaffected); local-time-ambiguous
 * inputs use their LOCAL calendar date to avoid a day-shift for UTC+ viewers.
 *
 * Exported so callers outside the L1 ingestion pass (`normalizeDataSourceRows` below) can
 * apply the SAME timezone-safe day-string conversion to a raw value that never went through
 * L1 — e.g. a foreign row pulled in during a cross-filter semi-join, or an L4 re-filtered
 * anchor/remote/junction row — instead of reimplementing (and potentially re-breaking) the
 * zoned/local-time distinction (`filterUtils.ts`'s `toComparable`).
 */
export function normalizeToDateOnlyString(raw: unknown): string | null {
  const d = normalizeToDate(raw);
  if (!d) {
    return null;
  }
  return isZonedDateInput(raw) ? d.toISOString().slice(0, 10) : toLocalYmd(d);
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

/** Canonical `date` cell: exactly `YYYY-MM-DD`. */
const CANONICAL_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Canonical `datetime` cell: exactly what `Date.prototype.toISOString()` emits,
 * `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * The explicit-zone requirement is the load-bearing part. A zone-less
 * `'2024-01-15T23:30:00'` — the shape MySQL/SQLite drivers routinely hand back — denotes no
 * definite instant: `new Date()` reads it as LOCAL time on the filter path while
 * `truncateToPeriod` reads its UTC components on the chart-grouping path, so one timestamp
 * lands in two different buckets. Treating it as already-canonical left that split in place;
 * it must be normalized to a real UTC instant instead. Offset forms (`+02:00`) are
 * unambiguous but still not the canonical spelling, so they are normalized too — otherwise
 * two spellings of the same instant compare unequal in any string-keyed grouping.
 */
const CANONICAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Whether EVERY non-null cell of `fieldId` across `rows` already matches `canonical`.
 *
 * Scans rather than sampling one cell: a single column can legitimately mix formats — a host
 * merging a JSON-revived batch with a CSV batch, or an adapter response spliced onto seeded
 * rows — so a canonical row 0 says nothing about rows 1..N. Deciding from the sample alone
 * left those later `Date` objects raw, which rendered one calendar day as two axis buckets
 * and let the filter path day-shift it for a non-UTC viewer.
 *
 * The loop short-circuits on the first non-canonical cell, so a column that DOES need
 * normalizing costs a handful of regex tests before falling through to the row pass, while an
 * already-canonical column pays one cheap regex per row and skips N `Date` constructions.
 */
function isFieldAlreadyCanonical(
  rows: readonly Record<string, unknown>[],
  fieldId: string,
  canonical: RegExp,
): boolean {
  for (const row of rows) {
    const value = row[fieldId];
    if (value == null) {
      continue;
    }
    if (typeof value !== 'string' || !canonical.test(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Normalise all date/datetime field values in a data source's rows to canonical
 * ISO strings on ingestion, so the rest of the system can assume a single format.
 *
 * - `date`     fields → `"YYYY-MM-DD"`
 * - `datetime` fields → `"YYYY-MM-DDTHH:mm:ss.sssZ"` (full ISO-8601 UTC)
 *
 * Accepts JS `Date` objects, millisecond timestamps (numbers), and any string
 * that `new Date()` can parse. A field is skipped entirely only when EVERY one of its
 * non-null cells is already canonical (see {@link isFieldAlreadyCanonical}); otherwise every
 * cell of that field is converted. Rows whose cells all come back byte-identical are returned
 * by reference, so a mostly-canonical column does not clone the row array.
 *
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

    // Decide per field, over ALL of its cells: a field is excluded from the row pass only
    // when it holds nothing but canonical values. One canonical cell is not evidence about
    // the others (see `isFieldAlreadyCanonical`).
    const dateIdsToNormalize = dateFieldIds.filter(
      (id) => !isFieldAlreadyCanonical(originalRows, id, CANONICAL_DATE_ONLY),
    );
    const datetimeIdsToNormalize = datetimeFieldIds.filter(
      (id) => !isFieldAlreadyCanonical(originalRows, id, CANONICAL_DATETIME),
    );

    if (dateIdsToNormalize.length > 0 || datetimeIdsToNormalize.length > 0) {
      rows = originalRows.map((row) => {
        let changed = false;
        const next: Record<string, unknown> = { ...row };

        for (const id of dateIdsToNormalize) {
          const raw = row[id];
          if (raw == null) {
            continue;
          }
          const normalized = normalizeToDateOnlyString(raw);
          // Compare before assigning: a mixed-format column puts EVERY row through this pass,
          // but the rows that were already canonical must still be returned by reference so
          // callers relying on row identity (and the row-array clone cost) are unaffected.
          if (normalized != null && normalized !== raw) {
            next[id] = normalized;
            changed = true;
          }
        }

        for (const id of datetimeIdsToNormalize) {
          const raw = row[id];
          if (raw == null) {
            continue;
          }
          const d = normalizeToDate(raw);
          const normalized = d?.toISOString();
          if (normalized != null && normalized !== raw) {
            next[id] = normalized;
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
    // One pass over `rows`, accumulating every field's distinct set simultaneously.
    // Previously this ran a FULL row scan per field, so a 40-column × 500k-row source
    // walked the (large) rows array 40 separate times on ingestion — the same 20M cell
    // reads, but with 40× the memory traffic over `rows` and no locality between them.
    const fieldIds = categoricalFields.map((f) => f.id);
    const seenByField = fieldIds.map(() => new Set<string>());
    for (const row of rows) {
      for (let i = 0; i < fieldIds.length; i += 1) {
        const v = row[fieldIds[i]];
        if (v != null && String(v) !== '') {
          seenByField[i].add(String(v));
        }
      }
    }
    fieldDistinctValues = {};
    for (let i = 0; i < fieldIds.length; i += 1) {
      if (seenByField[i].size > 0) {
        fieldDistinctValues[fieldIds[i]] = Array.from(seenByField[i]).sort();
      }
    }
  }

  if (rows === dataSource.rows && !fieldDistinctValues) {
    return dataSource;
  }

  return { ...dataSource, rows, ...(fieldDistinctValues ? { fieldDistinctValues } : {}) };
}

/**
 * Truncate a date-like value to a granularity and return a sort-stable ISO key.
 * Returns null if the value cannot be parsed as a date.
 *
 * The implementation lives in `@mui/x-studio-schema`'s `truncateToPeriod` (shared
 * with `@mui/x-studio-ai-middleware`'s MCP data tools) — this wrapper only keeps
 * the `XGroupBy`-typed signature existing callers in this package rely on.
 *
 * Examples (UTC):
 *   'day'     → '2024-01-15'
 *   'week'    → '2024-W03'
 *   'month'   → '2024-01'
 *   'quarter' → '2024-Q1'
 *   'year'    → '2024'
 */
export function truncateToGranularity(value: unknown, granularity: XGroupBy): string | null {
  return truncateToPeriod(value, granularity);
}

/**
 * Locale-aware short month name (e.g. 'Jan', 'janv.', 'Ene') via `Intl.DateTimeFormat`,
 * mirroring the `toLocaleDateString` pattern already used by `formatTemporalAxisLabel`'s
 * non-grouped branch below — the dashboard's locale (`<Studio locale={…} />`, falling back
 * to the runtime default) instead of hardcoded English month abbreviations.
 *
 * Deliberately NOT memoized in a module-level cache. A cache of the 12 names can only be
 * reused when the locale it was built under still applies, and there is no cheap way to
 * read the runtime's current default locale in the fallback case — `Intl.DateTimeFormat()
 * .resolvedOptions()` requires constructing the very formatter the cache exists to avoid.
 * A cache that skips that check is worse than no cache: whichever locale populates it
 * first wins for the rest of the process and every other locale silently renders English
 * month names. Since a correctly-keyed cache would pay the construction cost anyway, the
 * cache buys nothing, so the formatter is simply built per call — exactly what the
 * `toLocaleDateString` branch below already does for the non-grouped path.
 */
function getShortMonthName(monthIndex: number): string {
  const formatter = new Intl.DateTimeFormat(getStudioLocale(), {
    month: 'short',
    timeZone: 'UTC',
  });
  return formatter.format(new Date(Date.UTC(2000, monthIndex, 1)));
}

/**
 * Convert a sort-stable period key into a human-readable axis label.
 *
 * Month names are localized via `Intl.DateTimeFormat` (finding: hardcoded English month
 * names). The week label's "Week" word comes from `localeText.timeGranWeek` — the same
 * token already translated for the time-granularity picker — so a non-English `localeText`
 * (e.g. `frLocaleText`) produces a translated axis label instead of a hardcoded English one.
 *
 * Examples (default English `localeText`):
 *   '2024-01-15' → 'Jan 15, 2024'
 *   '2024-W03'   → 'Week 3 2024'
 *   '2024-01'    → 'Jan 2024'
 *   '2024-Q1'    → 'Q1 2024'
 *   '2024'       → '2024'
 */
export function formatPeriodLabel(
  key: string,
  localeText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT,
): string {
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
    return `${localeText.timeGranWeek} ${parseInt(wMatch[2], 10)} ${wMatch[1]}`;
  }
  // Month: '2024-01'
  const mMatch = key.match(/^(\d{4})-(\d{2})$/);
  if (mMatch) {
    const monthIndex = parseInt(mMatch[2], 10) - 1;
    return `${getShortMonthName(monthIndex)} ${mMatch[1]}`;
  }
  // Day: '2024-01-15'
  const dMatch = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dMatch) {
    const monthIndex = parseInt(dMatch[2], 10) - 1;
    return `${getShortMonthName(monthIndex)} ${parseInt(dMatch[3], 10)}, ${dMatch[1]}`;
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

/**
 * Hard cap on the number of labels {@link fillTemporalLabelGaps} will synthesize.
 *
 * The endpoints are DATA-DERIVED, so a single bad cell defines the range: one
 * `order_date: '1900-01-05'` typo in an otherwise-2024 dataset grouped by `'day'` asks
 * for ~45 600 labels, each costing a `toISOString()` plus a full `truncateToGranularity`
 * re-parse — then a 45 600-entry Map and value array PER SERIES downstream. The tab
 * locks up (M9). Past this cap the densified axis is unreadable anyway (a chart cannot
 * usefully show 2000 categories), so the only useful behaviour is to stop and hand back
 * the original labels ungapped.
 */
const MAX_FILLED_TEMPORAL_LABELS = 2000;

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
    if (filled.length >= MAX_FILLED_TEMPORAL_LABELS) {
      // Bail out rather than run the sequence to its data-derived end (M9). Returning the
      // input unchanged is safe for every caller: gap filling is a presentation nicety,
      // and `densifyAggregated`/`densifyMultiSeries`/`densifyMultiY` all short-circuit on
      // reference equality when no gaps were filled.
      return labels;
    }
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

export function formatTemporalAxisLabel(
  value: Date | number,
  xGroupBy?: XGroupBy,
  localeText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT,
): string {
  const dateValue = value instanceof Date ? value : new Date(value);

  if (xGroupBy) {
    const grouped = truncateToGranularity(dateValue, xGroupBy);
    return grouped ? formatPeriodLabel(grouped, localeText) : dateValue.toISOString();
  }

  return dateValue.toLocaleDateString(getStudioLocale(), {
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
