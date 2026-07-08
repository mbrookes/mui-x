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
 * alignment. The one genuinely cyclic unit, `day` (day-of-week), has no
 * truncation-only equivalent, so it is mapped onto a canonical reference
 * week and flagged with a 'partial' gap.
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

/** Whether `unit` is in the supported truncation set (including the cyclic `day`). */
export function isTimeUnitSupported(unit: VegaTimeUnit): boolean {
  return unit === 'day' || UNIT_GRANULARITY[unit] !== undefined;
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
 * recording a gap) for units outside the supported set; `day` is supported
 * but always records a 'partial' gap since it maps onto a synthetic
 * reference week rather than the real calendar date.
 */
export function resolveTimeUnit(
  date: Date,
  unit: VegaTimeUnit,
  gaps: GapCollector,
  path: string,
): Date | null {
  if (unit === 'day') {
    gaps.add({
      code: 'timeUnit:day',
      message:
        'The `day` (day-of-week) time unit maps every date onto a canonical reference week; the result is comparable day-to-day but is not the real calendar date.',
      severity: 'partial',
      path,
    });
    return truncateDayOfWeek(date);
  }
  const granularity = UNIT_GRANULARITY[unit];
  if (!granularity) {
    addUnsupportedUnitGap(unit, gaps, path);
    return null;
  }
  return truncate(date, granularity);
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
