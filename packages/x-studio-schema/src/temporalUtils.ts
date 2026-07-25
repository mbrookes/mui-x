/**
 * Temporal (date-bucketing) helpers shared by the client (`@mui/x-studio`) and
 * the AI middleware (`@mui/x-studio-ai-middleware`). Pure, dependency-free.
 *
 * Previously these existed as two hand-maintained copies: `truncateToGranularity`
 * / `isoWeek` in `@mui/x-studio`'s `internals/temporalUtils.ts`, and
 * `mcpTruncateToPeriod` / `mcpIsoWeek` in `@mui/x-studio-ai-middleware`'s
 * `mcp/dataTools.ts`. Both consumers now import the single implementation here.
 */

/**
 * Builds a UTC `Date` for the given year/month(0-indexed)/day WITHOUT the
 * `Date.UTC`/multi-arg-`Date`-constructor two-digit-year quirk, where a `year`
 * in `[0, 99]` is silently reinterpreted as `1900 + year` (so year `50` becomes
 * `1950`). `setUTCFullYear` takes the year literally at any magnitude, so
 * constructing via a placeholder epoch and re-stamping the real components onto
 * it is the one construction path in this file that stays correct for years 0–99.
 */
function utcDateFromYMD(year: number, month: number, day: number): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  return d;
}

/** ISO week number (1–53) for a given UTC date. */
export function isoWeek(d: Date): { year: number; week: number } {
  // Shift to Thursday of the same week (ISO weeks start on Monday).
  const tmp = utcDateFromYMD(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = utcDateFromYMD(tmp.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: tmp.getUTCFullYear(), week };
}

/** Zero-pads a year to at least 4 digits (e.g. `5` → `'0005'`) so a truncated-period
 *  key sorts and displays correctly for years 0–999, matching the `MM`/`DD` padding
 *  every other component of these keys already gets. */
function padYear(year: number): string {
  return String(year).padStart(4, '0');
}

/**
 * Parses a date-like value into UTC year/month(0-indexed)/day components, or
 * `null` if the value can't be interpreted as a date.
 *
 * Fast-paths canonical, OFFSET-FREE ISO strings (`YYYY-MM-DD`, or a datetime whose
 * time carries no explicit `±HH:MM` offset) by slicing directly instead of allocating
 * a `Date`. An offset-carrying string (`2024-06-01T01:00:00+05:00`) and any other
 * format fall back to `new Date(...)`, which converts to UTC — slicing the written
 * components there would bucket the value into the wrong UTC day.
 */
function toUtcYMD(value: unknown): { y: number; m: number; day: number } | null {
  if (typeof value === 'string' && value.length >= 10 && value[4] === '-' && value[7] === '-') {
    // Take the fast path only when there is no explicit UTC offset in the tail after
    // the date: a bare date (nothing after position 10) or a time ending in `Z`/no
    // offset. A REAL offset (`+05:00`, `-0500`, …) always trails the time-of-day
    // component with nothing after it, so it is anchored to the END of the tail —
    // `/[+-]\d{2}:?\d{2}$/`. Checking for a bare `+`/`-` ANYWHERE in the tail (as a
    // plain `.includes` would) contradicts the "non-offset garbage tail is ignored"
    // behavior documented below: a malformed-but-canonical-prefixed value like
    // `2024-06-01Tgarbage-more` carries a `-` inside the garbage, not a timezone
    // offset, and must still fast-path off the leading `YYYY-MM-DD` rather than fall
    // through to `new Date(...)` (which can't parse it either, returning `null`).
    const tail = value.slice(10);
    if (!/[+-]\d{2}:?\d{2}$/.test(tail)) {
      const y = Number(value.slice(0, 4));
      const m = Number(value.slice(5, 7)) - 1;
      const day = Number(value.slice(8, 10));
      // Coarse range-check on the sliced components: a clearly out-of-range month
      // (`2024-13-…`) or day (`2024-…-40`) falls through to `new Date(...)`, where it
      // becomes `Invalid Date` → `null`. This is deliberately a bounds check, NOT a
      // calendar-validity check: a per-month-invalid but in-range day (e.g. `2024-06-31`,
      // or `2024-02-30`) is accepted here as-is and NOT reconciled the way `new Date`
      // would overflow it into the next month. Likewise a non-offset garbage tail after
      // the date (`2024-06-01Tgarbage`) is ignored — only the leading `YYYY-MM-DD` is
      // read. Callers pass canonical values in practice, so this keeps the hot path
      // allocation-free; the fallback below covers everything this check rejects.
      if (!Number.isNaN(y) && m >= 0 && m <= 11 && day >= 1 && day <= 31) {
        return { y, m, day };
      }
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
      return `${padYear(y)}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    case 'week': {
      // `utcDateFromYMD` (not `new Date(Date.UTC(y, m, day))`) so a year 0–99 isn't
      // reinterpreted as 1900+year before `isoWeek` ever sees it.
      const { year, week } = isoWeek(utcDateFromYMD(y, m, day));
      return `${padYear(year)}-W${String(week).padStart(2, '0')}`;
    }
    case 'month':
      return `${padYear(y)}-${String(m + 1).padStart(2, '0')}`;
    case 'quarter':
      return `${padYear(y)}-Q${Math.floor(m / 3) + 1}`;
    case 'year':
      return padYear(y);
    default:
      return null;
  }
}
