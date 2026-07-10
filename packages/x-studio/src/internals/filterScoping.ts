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
 *   When undefined, cross-filter and interactive filters are included regardless
 *   of their pageId (used by the non-React StudioPipeline when no page context is available).
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
        if (!sv2.pageId || sv2.pageId === activePageId) {
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
