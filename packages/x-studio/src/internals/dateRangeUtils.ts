import dayjs from 'dayjs';
import type { StudioDateRangePreset } from '../models';

/**
 * KNOWN GAP (finding 8, documented not fixed): every preset below computes its dynamic bound
 * (`today`, "this month", "this quarter", …) from the VIEWER'S LOCAL calendar (`now.getFullYear()`
 * / `getMonth()` / `getDate()`). Rows are compared against the resolved bound differently
 * depending on the target column's declared type (`filterUtils.ts`):
 *   - a `date`-typed column compares via a LOCAL-safe canonical string
 *     (`temporalUtils.normalizeToDateOnlyString`), which agrees with this file's local "today";
 *   - but a `datetime`-typed column compares at UTC-day granularity (`filterUtils.ts`'s
 *     `toDayComparable`/`toComparable`, which routes a `datetime` value through
 *     `d.toISOString()`).
 * For a viewer at a negative UTC offset, local "today" can still be UTC "yesterday" for part of
 * the day, so a `datetime` row timestamped "just now" can fall on the NEXT UTC day and be
 * excluded from a `to: <local today>` bound (e.g. `ytd`) until the viewer's local calendar
 * catches up to UTC.
 *
 * This wasn't force-fixed here because there is no single correct "now" for this file to use:
 * switching to a UTC-based "today" would fix the `datetime` case but REGRESS the (more common)
 * `date`-typed case, where the viewer's own local calendar day is the intuitively-expected
 * "today". A correct fix needs to thread the target filter's `fieldType` into preset resolution
 * (available one layer up, in `filterUtils.ts`'s `resolveDateRangePreset`, which already reads
 * `filter.fieldType` for the analogous UTC-end-of-day-anchor decision) and give EVERY preset here
 * — not just the simple `to: today` ones — a parallel UTC-mode date-arithmetic path (month/
 * quarter-boundary presets are also "now"-sensitive), which is a broader change than this
 * iteration's scope justifies forcing.
 */

/** Computes start/end ISO date strings for a given date range preset. */
export function computeDateRangePreset(preset: Exclude<StudioDateRangePreset, 'custom'>): {
  from: string;
  to: string;
} {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = toISO(now);

  switch (preset) {
    case 'this_month': {
      const from = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const to = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}`;
      return { from, to };
    }
    case 'last_3_months': {
      // Use dayjs subtraction, which clamps the day-of-month to the target month's last day,
      // rather than `Date.prototype.setMonth`, which rolls a "Feb 31" over into March. Run on
      // May 31, the naive `setMonth(-3)` lands on March 3 (non-leap year), starting the window
      // up to 3 days late and excluding boundary rows (finding T3.2).
      return { from: dayjs(now).subtract(3, 'month').format('YYYY-MM-DD'), to: today };
    }
    case 'last_12_months': {
      // dayjs clamps Feb 29 → Feb 28 when subtracting a year; `setFullYear` would roll it to
      // March 1 (finding T3.2).
      return { from: dayjs(now).subtract(1, 'year').format('YYYY-MM-DD'), to: today };
    }
    case 'ytd':
      return { from: `${now.getFullYear()}-01-01`, to: today };
    case 'this_calendar_year': {
      const year = now.getFullYear();
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    case 'last_calendar_year': {
      const year = now.getFullYear() - 1;
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    case 'last_2_calendar_years': {
      const lastYear = now.getFullYear() - 1;
      const twoYearsAgo = now.getFullYear() - 2;
      return { from: `${twoYearsAgo}-01-01`, to: `${lastYear}-12-31` };
    }
    case 'this_quarter': {
      const year = now.getFullYear();
      const qStart = Math.floor(now.getMonth() / 3) * 3;
      const qEnd = qStart + 2;
      const lastDay = new Date(year, qEnd + 1, 0).getDate();
      return {
        from: `${year}-${pad(qStart + 1)}-01`,
        to: `${year}-${pad(qEnd + 1)}-${pad(lastDay)}`,
      };
    }
    case 'last_quarter': {
      let year = now.getFullYear();
      let qStart = Math.floor(now.getMonth() / 3) * 3 - 3;
      if (qStart < 0) {
        qStart += 12;
        year -= 1;
      }
      const qEnd = qStart + 2;
      const lastDay = new Date(year, qEnd + 1, 0).getDate();
      return {
        from: `${year}-${pad(qStart + 1)}-01`,
        to: `${year}-${pad(qEnd + 1)}-${pad(lastDay)}`,
      };
    }
    case 'this_and_last_quarter': {
      const year = now.getFullYear();
      const thisQStart = Math.floor(now.getMonth() / 3) * 3;
      const thisQEnd = thisQStart + 2;
      let lastQStart = thisQStart - 3;
      let lastQYear = year;
      if (lastQStart < 0) {
        lastQStart += 12;
        lastQYear -= 1;
      }
      const thisQLastDay = new Date(year, thisQEnd + 1, 0).getDate();
      return {
        from: `${lastQYear}-${pad(lastQStart + 1)}-01`,
        to: `${year}-${pad(thisQEnd + 1)}-${pad(thisQLastDay)}`,
      };
    }
    default: {
      const exhaustive: never = preset;
      void exhaustive;
      return { from: today, to: today };
    }
  }
}
