import type { DatasetRow, VegaTimeUnit, VegaTimeUnitTransform } from '../types';
import type { GapCollector } from '../gaps';
import { toDate } from '../compile/fieldTypes';

/*
 * OWNERSHIP: the "transforms" work unit owns this file — calendar truncation
 * for the `timeUnit` transform and inline `timeUnit` on encoding channels
 * (`applyInlineTimeUnit`, wired in from encoding.ts).
 *
 * Cyclic alignment: matching real Vega-Lite, a unit keeps only the calendar
 * components it names and resets every *unnamed* component to a canonical
 * reference (year 2012 — a leap year — January 1, midnight). So a bare `month`
 * collapses the same month across every year into one bucket (2012-<month>-01),
 * which is what makes `x: {timeUnit: 'month'}, y: {aggregate: 'count'}` render
 * twelve bars rather than one per (year, month). A year-prefixed composite like
 * `yearmonth` keeps the real year, so it still walks the true time-series axis.
 * The two genuinely cyclic units, `day` (day-of-week) and `dayofyear`, are
 * mapped onto a canonical reference week / reference leap year and flagged with
 * a 'partial' gap. The lone exception is the `week` family, which still
 * truncates in place (keeping the real year) — a week-of-year reference frame
 * has no simple calendar-field construction.
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

// The calendar components a unit carries from the source date. Every component
// a unit does *not* list falls back to the reference base below, which is what
// gives non-year units their cyclic behavior (e.g. `month` drops the real year,
// so all years' Januaries collapse into one bucket). Year-prefixed composites
// list `year`, so they retain the true year. The `week` family is handled by
// the truncation path instead (no simple field construction) and is omitted.
type CalendarField = 'year' | 'quarter' | 'month' | 'date' | 'hours' | 'minutes' | 'seconds';

const UNIT_FIELDS: Partial<Record<string, CalendarField[]>> = {
  year: ['year'],
  quarter: ['quarter'],
  month: ['month'],
  date: ['date'],
  hours: ['hours'],
  minutes: ['minutes'],
  seconds: ['seconds'],
  yearquarter: ['year', 'quarter'],
  yearmonth: ['year', 'month'],
  yearmonthdate: ['year', 'month', 'date'],
  monthdate: ['month', 'date'],
  hoursminutes: ['hours', 'minutes'],
  hoursminutesseconds: ['hours', 'minutes', 'seconds'],
};

// Reference base for components a unit does not carry, matching Vega-Lite's own
// convention: year 2012 (a leap year, so a carried Feb 29 stays valid), January,
// the 1st, at midnight.
const REFERENCE_YEAR = 2012;

/**
 * Builds the truncated date for a unit expressed as a set of carried calendar
 * fields: components the unit names are read off `date`, everything else takes
 * the reference base. `quarter` snaps the month to its quarter start.
 */
function buildFromFields(date: Date, fields: CalendarField[], utc: boolean): Date {
  const get = {
    year: utc ? date.getUTCFullYear() : date.getFullYear(),
    month: utc ? date.getUTCMonth() : date.getMonth(),
    date: utc ? date.getUTCDate() : date.getDate(),
    hours: utc ? date.getUTCHours() : date.getHours(),
    minutes: utc ? date.getUTCMinutes() : date.getMinutes(),
    seconds: utc ? date.getUTCSeconds() : date.getSeconds(),
  };
  const out = { year: REFERENCE_YEAR, month: 0, date: 1, hours: 0, minutes: 0, seconds: 0 };
  for (const field of fields) {
    if (field === 'quarter') {
      out.month = Math.floor(get.month / 3) * 3;
    } else {
      out[field] = get[field];
    }
  }
  return utc
    ? new Date(Date.UTC(out.year, out.month, out.date, out.hours, out.minutes, out.seconds, 0))
    : new Date(out.year, out.month, out.date, out.hours, out.minutes, out.seconds, 0);
}

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

  // Units expressible as a set of carried calendar fields (everything except the
  // `week` family) build cyclically from the reference base, so non-year units
  // collapse across years the way Vega-Lite does.
  const fields = UNIT_FIELDS[base];
  if (fields) {
    return buildFromFields(date, fields, utc);
  }

  // The `week` family has no simple field construction, so it still truncates in
  // place at week granularity (keeping the real year).
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
