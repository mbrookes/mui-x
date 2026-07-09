import { truncateToGranularity, type XGroupBy } from './temporalUtils';
import { DEFAULT_STUDIO_LOCALE_TEXT, type StudioLocaleText } from './localeText';

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

/**
 * The bucket label used for a null/undefined x-axis value. Falls back to the
 * English default when `localeText` (or the key) isn't supplied, so existing
 * callers that don't thread a locale through keep their current behavior.
 */
function emptyBucketLabel(localeText?: Partial<StudioLocaleText>): string {
  return localeText?.chartEmptyCategoryLabel ?? DEFAULT_STUDIO_LOCALE_TEXT.chartEmptyCategoryLabel;
}

/** Safely extracts a row field value as a string or number suitable for chart grouping. */
export function toXValue(raw: unknown, localeText?: Partial<StudioLocaleText>): string | number {
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (typeof raw === 'boolean') {
    return String(raw);
  }
  if (raw === null || raw === undefined) {
    return emptyBucketLabel(localeText);
  }
  if (typeof raw === 'object') {
    return String(raw);
  }
  return raw as string | number;
}

export function isEmptyXValue(raw: unknown, localeText?: Partial<StudioLocaleText>): boolean {
  return raw === null || raw === undefined || raw === '' || raw === emptyBucketLabel(localeText);
}
