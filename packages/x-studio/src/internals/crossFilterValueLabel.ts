/**
 * Formats a cross-filter value for display in a chip label.
 *
 * A cross-filter value emitted by a chart/grid/map click can be:
 * - `null`/`undefined` — no value (renders empty).
 * - a `{ from, to }` date-range object — emitted by a period-grouped bar click
 *   (e.g. clicking a monthly bar applies a `between` filter over that month).
 * - an array of scalars — an `in` operator, produced by a shift-click multi-select.
 * - a plain scalar (string/number/boolean/Date) — everything else.
 *
 * This is the single shared implementation of that formatting — do not re-declare a
 * private copy elsewhere (previously duplicated as an inline IIFE in
 * `StudioWidgetCard.tsx` and a bare `String(...)` cast in `StudioQuickFilterBar.tsx`,
 * neither of which handled the `between`/array cases correctly).
 *
 * Dates are formatted through `Intl` rather than dayjs, matching
 * `internals/temporalUtils.ts`'s `formatTemporalAxisLabel`: nothing in this package ever
 * calls `dayjs.locale(...)`, so `dayjs(v).format('D MMM YYYY')` always produced English
 * month names in a fixed DMY order no matter the dashboard's locale.
 */

/**
 * The range bounds reaching this function are the plain `YYYY-MM-DD` strings produced by
 * `periodKeyToDateRange`. `new Date('YYYY-MM-DD')` parses as UTC midnight, so the formatter
 * is pinned to UTC — the same convention `formatTemporalAxisLabel` uses — otherwise a
 * negative-offset runtime would render the day before the one the user clicked.
 */
function formatRangeBound(date?: string): string {
  if (!date) {
    return '';
  }
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return parsed.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatCrossFilterValueLabel(value: unknown): string {
  if (value == null) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatCrossFilterValueLabel(item)).join(', ');
  }

  if (typeof value === 'object' && 'from' in value && 'to' in value) {
    const range = value as { from?: string; to?: string };
    if (range.from && range.to && range.from !== range.to) {
      return `${formatRangeBound(range.from)} – ${formatRangeBound(range.to)}`;
    }
    return formatRangeBound(range.from ?? range.to) || '';
  }

  return String(value);
}
