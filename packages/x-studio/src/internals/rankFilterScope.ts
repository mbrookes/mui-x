import type { StudioFilterState, StudioPage } from '../models';

/**
 * Resolves the page a rank-eligible filter applies to, for the per-page
 * rank-uniqueness guard (1.7):
 *  - `page` scope → its explicit `pageId`, or `null` for a legacy pageId-less page
 *    filter (which applies on EVERY page, so it must conflict everywhere).
 *  - `widget` scope → the id of the page whose `widgetRows` contain the widget, or
 *    `null` when the widget is not placed on any page.
 *  - other scope kinds are never rank filters and are excluded by the caller.
 *
 * Extracted from `StudioController` so the filters-drawer rows and the controller's
 * `updateFilter` rank guard share ONE per-page-scoped implementation, instead of the
 * drawer independently scanning filters dashboard-wide (which disabled rank mode more
 * aggressively than the controller actually rejects it).
 */
export function resolveRankFilterPageId(
  filter: StudioFilterState,
  pages: Record<string, StudioPage>,
): string | null {
  const { scope } = filter;
  if (scope.kind === 'page') {
    return scope.pageId ?? null;
  }
  if (scope.kind === 'widget') {
    for (const page of Object.values(pages)) {
      if ((page.widgetRows ?? []).some((row) => row.includes(scope.widgetId))) {
        return page.id;
      }
    }
    return null;
  }
  return null;
}

/**
 * True when another rank filter already occupies `target`'s page context (1.7).
 * Rank uniqueness is per-page — a rank filter on page-1 does not block one on
 * page-2 — because page filters gate on `pageId === activePageId` and widget rank
 * filters are per-widget. A `null` resolved page (a pageId-less page filter, applied
 * everywhere) conflicts with — and is conflicted by — any other rank filter.
 *
 * `target` is only read for its `scope` (to resolve its page context), so callers can
 * pass the existing filter as-is when checking whether it may become a rank filter.
 */
export function hasConflictingRankFilter(
  filterId: string,
  target: StudioFilterState,
  filters: StudioFilterState[],
  pages: Record<string, StudioPage>,
): boolean {
  const targetPageId = resolveRankFilterPageId(target, pages);
  return filters.some((filter) => {
    if (
      filter.id === filterId ||
      filter.scope.kind === 'cross-filter' ||
      filter.filterMode !== 'rank'
    ) {
      return false;
    }
    const otherPageId = resolveRankFilterPageId(filter, pages);
    return targetPageId === null || otherPageId === null || otherPageId === targetPageId;
  });
}
