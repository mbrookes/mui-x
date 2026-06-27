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
 */
export function selectFiltersForWidget(
  filters: StudioFilterState[],
  opts: {
    widgetId: string;
    widgetSourceId: string | undefined;
    activePageId: string | undefined;
    include?: 'all' | 'no-cross' | 'no-chart-cross';
    crossFilterAllPages?: boolean;
  },
): StudioFilterState[] {
  const { widgetId, widgetSourceId, activePageId, include = 'all', crossFilterAllPages = false } = opts;
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
        if (sv2.widgetId === widgetId && f.filterMode !== 'rank') {
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
