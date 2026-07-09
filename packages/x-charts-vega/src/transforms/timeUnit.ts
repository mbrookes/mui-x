import type { DatasetRow, VegaTimeUnit, VegaTimeUnitTransform } from '../types';
import type { GapCollector } from '../gaps';
import { toDate } from '../compile/fieldTypes';

/*
 * OWNERSHIP: the "transforms" work unit owns this file — calendar truncation
 * for the `timeUnit` transform and inline `timeUnit` on encoding channels
 * (`applyInlineTimeUnit`, wired in from encoding.ts).
 *
 * Simplification (documented, not a gap): unlike real Vega-Lite — where a
 * *single* unit like `month` normalizes every other component to a common
 * reference year/date so same-month values are comparable across years —
 * this wrapper always truncates in place and keeps the real calendar date
 * (so `month` and `yearmonth` produce the same result: the first of the real
 * month). That is the more useful behavior for the primary use case here
 * (time-series axes), at the cost of not supporting cross-year cyclic
 * alignment. The two genuinely cyclic units, `day` (day-of-week) and
 * `dayofyear`, have no truncation-only equivalent, so they are mapped onto a
 * canonical reference week / reference leap year (2012, matching Vega-Lite's
 * own convention) and flagged with a 'partial' gap.
 *
 * UTC: any unit may be prefixed with `utc` (e.g. `utcyear`, `utcyearmonth`,
 * `utcday`) to truncate using UTC calendar fields instead of local time —
 * `splitUtc` strips the prefix and every truncation path below has a plain
 * and a UTC variant. The cyclic units keep reporting their 'partial' gap
 * under their UTC forms too (`utcday`/`utcdayofyear`), since the reference-
 * date approximation still applies.
 */

type Granularity =
  | 'year'
  | 'quarter'
  | 'month'
  | 'week'
  | 'date'
  | 'hours'
  | 'minutes'
  | 'seconds'
  | 'milliseconds';

const UNIT_GRANULARITY: Partial<Record<string, Granularity>> = {
  year: 'year',
  quarter: 'quarter',
  month: 'month',
  week: 'week',
  date: 'date',
  hours: 'hours',
  minutes: 'minutes',
  seconds: 'seconds',
  milliseconds: 'milliseconds',
  // Composites: the leading `year`/`month`/etc. components are already kept
  // by construction (see the module doc above), so each composite maps onto
  // truncation at its *finest* named granularity.
  yearquarter: 'quarter',
  yearmonth: 'month',
  yearmonthdate: 'date',
  yearweek: 'week',
  monthdate: 'date',
  hoursminutes: 'minutes',
  hoursminutesseconds: 'seconds',
};

/** Splits a possibly-`utc`-prefixed unit into its UTC flag and base (non-prefixed) unit name. */
function splitUtc(unit: VegaTimeUnit): { utc: boolean; base: string } {
  const str = String(unit);
  if (str.startsWith('utc')) {
    return { utc: true, base: str.slice(3) };
  }
  return { utc: false, base: str };
}

function truncate(date: Date, granularity: Granularity): Date {
  const d = new Date(date.getTime());
  switch (granularity) {
    case 'year':
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      break;
    case 'quarter': {
      const quarter = Math.floor(d.getMonth() / 3);
      d.setMonth(quarter * 3, 1);
      d.setHours(0, 0, 0, 0);
      break;
    }
    case 'month':
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      break;
    case 'week': {
      const day = d.getDay();
      d.setDate(d.getDate() - day);
      d.setHours(0, 0, 0, 0);
      break;
    }
    case 'date':
      d.setHours(0, 0, 0, 0);
      break;
    case 'hours':
      d.setMinutes(0, 0, 0);
      break;
    case 'minutes':
      d.setSeconds(0, 0);
      break;
    case 'seconds':
      d.setMilliseconds(0);
      break;
    case 'milliseconds':
    default:
      break;
  }
  return d;
}

/** UTC mirror of `truncate`: same granularity semantics, `setUTC*`/`getUTC*` fields throughout. */
function truncateUTC(date: Date, granularity: Granularity): Date {
  const d = new Date(date.getTime());
  switch (granularity) {
    case 'year':
      d.setUTCMonth(0, 1);
      d.setUTCHours(0, 0, 0, 0);
      break;
    case 'quarter': {
      const quarter = Math.floor(d.getUTCMonth() / 3);
      d.setUTCMonth(quarter * 3, 1);
      d.setUTCHours(0, 0, 0, 0);
      break;
    }
    case 'month':
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      break;
    case 'week': {
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - day);
      d.setUTCHours(0, 0, 0, 0);
      break;
    }
    case 'date':
      d.setUTCHours(0, 0, 0, 0);
      break;
    case 'hours':
      d.setUTCMinutes(0, 0, 0);
      break;
    case 'minutes':
      d.setUTCSeconds(0, 0);
      break;
    case 'seconds':
      d.setUTCMilliseconds(0);
      break;
    case 'milliseconds':
    default:
      break;
  }
  return d;
}

// Jan 1, 2006 is a Sunday — used as the canonical reference week for the
// cyclic day-of-week `day` unit, matching Vega-Lite's own convention.
const DAY_OF_WEEK_REFERENCE = { year: 2006, month: 0, date: 1 };

function truncateDayOfWeek(date: Date): Date {
  const day = date.getDay();
  return new Date(
    DAY_OF_WEEK_REFERENCE.year,
    DAY_OF_WEEK_REFERENCE.month,
    DAY_OF_WEEK_REFERENCE.date + day,
  );
}

function truncateDayOfWeekUTC(date: Date): Date {
  const day = date.getUTCDay();
  return new Date(
    Date.UTC(
      DAY_OF_WEEK_REFERENCE.year,
      DAY_OF_WEEK_REFERENCE.month,
      DAY_OF_WEEK_REFERENCE.date + day,
    ),
  );
}

// 2012 is a leap year — used as the canonical reference year for the cyclic
// `dayofyear` unit, matching Vega-Lite's own convention (so a leap-day input
// still maps onto a real Feb 29).
const DAY_OF_YEAR_REFERENCE_YEAR = 2012;

function truncateDayOfYear(date: Date): Date {
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const truncated = truncate(date, 'date');
  const doy = Math.round((truncated.getTime() - startOfYear.getTime()) / 86400000) + 1;
  return new Date(DAY_OF_YEAR_REFERENCE_YEAR, 0, doy);
}

function truncateDayOfYearUTC(date: Date): Date {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const truncated = truncateUTC(date, 'date');
  const doy = Math.round((truncated.getTime() - startOfYear) / 86400000) + 1;
  return new Date(Date.UTC(DAY_OF_YEAR_REFERENCE_YEAR, 0, doy));
}

/** Whether `unit` is in the supported truncation set (including the cyclic `day`/`dayofyear`, with or without a `utc` prefix). */
export function isTimeUnitSupported(unit: VegaTimeUnit): boolean {
  const { base } = splitUtc(unit);
  return base === 'day' || base === 'dayofyear' || UNIT_GRANULARITY[base] !== undefined;
}

function addUnsupportedUnitGap(unit: VegaTimeUnit, gaps: GapCollector, path: string): void {
  gaps.add({
    code: `timeUnit:${unit}`,
    message: `The \`${unit}\` time unit is not implemented; raw date values are used.`,
    severity: 'unsupported',
    path,
  });
}

/**
 * Truncates `date` to the given Vega-Lite `unit`. Returns `null` (after
 * recording a gap) for units outside the supported set; `day`/`dayofyear`
 * are supported but always record a 'partial' gap since they map onto a
 * synthetic reference week/year rather than the real calendar date. A `utc`
 * prefix (e.g. `utcyear`, `utcday`) truncates using UTC calendar fields.
 */
export function resolveTimeUnit(
  date: Date,
  unit: VegaTimeUnit,
  gaps: GapCollector,
  path: string,
): Date | null {
  const { utc, base } = splitUtc(unit);

  if (base === 'day') {
    gaps.add({
      code: 'timeUnit:day',
      message:
        'The `day` (day-of-week) time unit maps every date onto a canonical reference week; the result is comparable day-to-day but is not the real calendar date.',
      severity: 'partial',
      path,
    });
    return utc ? truncateDayOfWeekUTC(date) : truncateDayOfWeek(date);
  }

  if (base === 'dayofyear') {
    gaps.add({
      code: 'timeUnit:dayofyear',
      message: `The \`dayofyear\` (day-of-year) time unit maps every date onto a canonical reference leap year (${DAY_OF_YEAR_REFERENCE_YEAR}) by ordinal day; the result is comparable day-to-day but is not the real calendar date.`,
      severity: 'partial',
      path,
    });
    return utc ? truncateDayOfYearUTC(date) : truncateDayOfYear(date);
  }

  const granularity = UNIT_GRANULARITY[base];
  if (!granularity) {
    addUnsupportedUnitGap(unit, gaps, path);
    return null;
  }
  return utc ? truncateUTC(date, granularity) : truncate(date, granularity);
}

/** Shared by the inline and top-level paths: truncate `field` into `outKey` on every row. */
function truncateColumn(
  rows: readonly DatasetRow[],
  field: string,
  unit: VegaTimeUnit,
  outKey: string,
  gaps: GapCollector,
  path: string,
): DatasetRow[] {
  return rows.map((row) => {
    const date = toDate(row[field]);
    return { ...row, [outKey]: date == null ? null : resolveTimeUnit(date, unit, gaps, path) };
  });
}

/**
 * Wires an inline `timeUnit` on an encoding channel: truncates `field` on
 * every row and writes the result to a synthetic column, returning the new
 * field name for the caller to rewrite the channel onto (kept as `type:
 * 'temporal'`). Returns `null` (after recording a gap) for unsupported
 * units, so the caller can fall back to the original raw-date field instead
 * of rewriting the channel to an all-null synthetic column.
 */
export function applyInlineTimeUnit(
  rows: readonly DatasetRow[],
  field: string,
  unit: VegaTimeUnit,
  gaps: GapCollector,
  path: string,
): { rows: DatasetRow[]; field: string } | null {
  if (!isTimeUnitSupported(unit)) {
    addUnsupportedUnitGap(unit, gaps, path);
    return null;
  }
  const syntheticField = `__timeUnit_${String(unit)}_${field}`;
  return {
    rows: truncateColumn(rows, field, unit, syntheticField, gaps, path),
    field: syntheticField,
  };
}

/*
 * Top-level `timeUnit` transform: truncates `field` and writes the result to
 * `as`. An unsupported unit records a gap and passes rows through unchanged
 * (no `as` column) rather than producing an all-null column.
 */
export function applyTimeUnitTransform(
  rows: readonly DatasetRow[],
  transform: VegaTimeUnitTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  if (!isTimeUnitSupported(transform.timeUnit)) {
    addUnsupportedUnitGap(transform.timeUnit, gaps, path);
    return rows;
  }
  return truncateColumn(rows, transform.field, transform.timeUnit, transform.as, gaps, path);
}
