/**
 * Temporal (date-bucketing) helpers shared by the client (`@mui/x-studio`) and
 * the AI middleware (`@mui/x-studio-ai-middleware`). Pure, dependency-free.
 *
 * Previously these existed as two hand-maintained copies: `truncateToGranularity`
 * / `isoWeek` in `@mui/x-studio`'s `internals/temporalUtils.ts`, and
 * `mcpTruncateToPeriod` / `mcpIsoWeek` in `@mui/x-studio-ai-middleware`'s
 * `mcp/dataTools.ts`. Both consumers now import the single implementation here.
 */

/** ISO week number (1–53) for a given UTC date. */
export function isoWeek(d: Date): { year: number; week: number } {
  // Shift to Thursday of the same week (ISO weeks start on Monday).
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: tmp.getUTCFullYear(), week };
}

/**
 * Parses a date-like value into UTC year/month(0-indexed)/day components, or
 * `null` if the value can't be interpreted as a date.
 *
 * Fast-paths canonical ISO strings (`YYYY-MM-DD` or `YYYY-MM-DDTHH:...`) by
 * slicing directly instead of allocating a `Date`. Falls back to `new Date(...)`
 * for `Date` instances, numeric (millisecond) timestamps, and any other string
 * format — the same permissive fallback both prior hand-copies relied on.
 */
function toUtcYMD(value: unknown): { y: number; m: number; day: number } | null {
  if (typeof value === 'string' && value.length >= 10 && value[4] === '-' && value[7] === '-') {
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(5, 7)) - 1;
    const day = Number(value.slice(8, 10));
    if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(day)) {
      return { y, m, day };
    }
  }

  let d: Date | null;
  if (value instanceof Date) {
    d = Number.isNaN(value.getTime()) ? null : value;
  } else if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value);
    d = Number.isNaN(parsed.getTime()) ? null : parsed;
  } else {
    d = null;
  }
  if (!d) {
    return null;
  }
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() };
}

/**
 * Truncate a date-like value to a granularity and return a sort-stable key.
 * Returns `null` if the value cannot be parsed as a date or `granularity` is
 * unrecognized.
 *
 * Accepts `Date` objects, ISO date/datetime strings, other Date-parseable
 * strings, and millisecond numeric timestamps (as produced by some DB drivers).
 *
 * Examples (UTC):
 *   'day'     → '2024-01-15'
 *   'week'    → '2024-W03'
 *   'month'   → '2024-01'
 *   'quarter' → '2024-Q1'
 *   'year'    → '2024'
 */
export function truncateToPeriod(value: unknown, granularity: string): string | null {
  const ymd = toUtcYMD(value);
  if (!ymd) {
    return null;
  }
  const { y, m, day } = ymd;

  switch (granularity) {
    case 'day':
      return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    case 'week': {
      const { year, week } = isoWeek(new Date(Date.UTC(y, m, day)));
      return `${year}-W${String(week).padStart(2, '0')}`;
    }
    case 'month':
      return `${y}-${String(m + 1).padStart(2, '0')}`;
    case 'quarter':
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    case 'year':
      return String(y);
    default:
      return null;
  }
}
