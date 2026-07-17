import { resolveDateRangePresets } from './filterUtils';
import type { StudioFilterState } from '../models';

/**
 * Returns the subset of `filters` that applies to a specific widget.
 *
 * Single source of truth for all three data paths (async adapter, sync in-memory,
 * non-React pipeline). Filters without `scope` are silently skipped — all
 * filter-creation sites in `StudioController` now emit `scope`.
 *
 * @param include
 *   'all' (default) — page + widget + cross-filter + interactive
 *   'no-cross'      — page + widget only (filteredRowsNoCross)
 *   'no-chart-cross'— page + widget + interactive, no scope:'cross-filter' (filteredRowsNoChartCross)
 *
 * @param activePageId
 *   When undefined, there is no active-page scoping restriction AT ALL — every scope kind that
 *   carries a `pageId` (page, cross-filter, interactive, dashboard-date-range) is included
 *   regardless of which page it was authored on, rather than only some of them. This matters for
 *   the non-React `StudioPipeline` (CSV export, benchmarks, unit tests), which is documented to
 *   run `resolveWidgetRows` without an `activePageId` when there is no page-navigation context to
 *   scope by (see `StudioPipeline.ts`'s class doc examples) — a caller in that position wants
 *   every authored filter to apply, not an inconsistent mix where page filters are silently
 *   dropped while cross/interactive filters from every page are silently kept (finding 5).
 *
 * @param includeWidgetRank
 *   By default a WIDGET-scoped rank (Top-N) filter is excluded from the returned set, because
 *   the chart widget re-applies its own widget rank as a post-aggregation reduction
 *   (`useChartWidgetData`) and would otherwise double-apply it. Every OTHER widget kind
 *   (grid / KPI / map / pivot / filter) has no such post-aggregation path, so a widget rank
 *   authored on one of them was silently ignored (finding 2.1). Non-chart callers set this to
 *   `true` so a widget-scoped rank filter is applied at L3 as a dataset-level reduction, exactly
 *   like a page-scoped rank filter already is (both flow into `applyFilters`' "filter then rank").
 */
export function selectFiltersForWidget(
  filters: StudioFilterState[],
  opts: {
    widgetId: string;
    widgetSourceId: string | undefined;
    activePageId: string | undefined;
    include?: 'all' | 'no-cross' | 'no-chart-cross';
    crossFilterAllPages?: boolean;
    includeWidgetRank?: boolean;
  },
): StudioFilterState[] {
  const {
    widgetId,
    widgetSourceId,
    activePageId,
    include = 'all',
    crossFilterAllPages = false,
    includeWidgetRank = false,
  } = opts;
  const result: StudioFilterState[] = [];

  for (const f of filters) {
    if (f.disabled) {
      continue;
    }

    const sv2 = f.scope;
    if (!sv2) {
      continue;
    }
    switch (sv2.kind) {
      case 'page':
        // `activePageId === undefined` is a wildcard here too, symmetric with the cross-filter/
        // interactive/dashboard-date-range branches below — see the `activePageId` doc above
        // (finding 5). Without it, a page-scoped filter with a `pageId` was silently dropped
        // whenever there was no active-page context, while cross/interactive filters from every
        // page were kept — an undocumented asymmetry.
        if (!sv2.pageId || activePageId === undefined || sv2.pageId === activePageId) {
          result.push(f);
        }
        break;
      case 'widget':
        if (sv2.widgetId === widgetId && (includeWidgetRank || f.filterMode !== 'rank')) {
          result.push(f);
        }
        break;
      case 'cross-filter':
        if (
          include === 'all' &&
          sv2.sourceWidgetId !== widgetId &&
          (crossFilterAllPages || activePageId === undefined || sv2.pageId === activePageId)
        ) {
          result.push(f);
        }
        break;
      case 'interactive':
        if (
          include !== 'no-cross' &&
          sv2.sourceWidgetId !== widgetId &&
          (activePageId === undefined || sv2.pageId === activePageId)
        ) {
          result.push(f);
        }
        break;
      case 'dashboard-date-range':
        if (
          sv2.sourceId === widgetSourceId &&
          (activePageId === undefined || sv2.pageId === activePageId)
        ) {
          result.push(f);
        }
        break;
      default:
        break;
    }
  }

  return resolveDateRangePresets(result);
}
