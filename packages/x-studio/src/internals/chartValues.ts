import { truncateToGranularity, type XGroupBy } from './temporalUtils';

/**
 * Small row-value helpers shared by the generic aggregators (`aggregators.ts`) and
 * the chart-type-specific prep (`chartShapes/`). Kept in a dedicated module so both
 * can depend on them without importing each other, and so they stay off the public
 * chart-aggregation surface (this module is not re-exported by `chartAggregation.ts`).
 */

/**
 * Apply xGroupBy truncation to an x-axis value.
 * Returns the original value when xGroupBy is not set or the value is not date-like.
 */
export function applyXGroupBy(
  value: string | number,
  xGroupBy: XGroupBy | undefined,
): string | number {
  if (!xGroupBy) {
    return value;
  }
  return truncateToGranularity(value, xGroupBy) ?? value;
}

/** Safely extracts a row field value as a string or number suitable for chart grouping. */
export function toXValue(raw: unknown): string | number {
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (typeof raw === 'boolean') {
    return String(raw);
  }
  if (raw === null || raw === undefined) {
    return '(empty)';
  }
  if (typeof raw === 'object') {
    return String(raw);
  }
  return raw as string | number;
}

export function isEmptyXValue(raw: unknown): boolean {
  return raw === null || raw === undefined || raw === '' || raw === '(empty)';
}
