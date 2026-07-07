import dayjs from 'dayjs';

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
 * Deliberately does not take a `localeText` parameter — the date format and separators
 * are hardcoded-English today, matching the prior behavior of both call sites.
 */
export function formatCrossFilterValueLabel(value: unknown): string {
  if (value == null) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatCrossFilterValueLabel(item)).join(', ');
  }

  if (typeof value === 'object' && 'from' in value && 'to' in value) {
    const range = value as { from?: string; to?: string };
    const formatDate = (date?: string) => (date ? dayjs(date).format('D MMM YYYY') : '');
    if (range.from && range.to && range.from !== range.to) {
      return `${formatDate(range.from)} – ${formatDate(range.to)}`;
    }
    return formatDate(range.from ?? range.to) || '';
  }

  return String(value);
}
