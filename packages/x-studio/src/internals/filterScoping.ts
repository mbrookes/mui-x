import { resolveDateRangePresets } from './filterUtils';
import type { StudioFilterState } from '../models';

/**
 * Returns the subset of `filters` that applies to a specific widget.
 *
 * Single source of truth for all three data paths (async adapter, sync in-memory,
 * non-React pipeline):
 * - disabled guard
 * - isDashboardDateRange + filterSourceId scope guard — prevents a date-range
 *   filter created for source A from leaking into source B queries
 * - scope partitioning (page / widget / cross-filter / interactive)
 * - resolveDateRangePresets — concrete {from, to} computation for preset filters
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
  },
): StudioFilterState[] {
  const { widgetId, widgetSourceId, activePageId, include = 'all' } = opts;
  const result: StudioFilterState[] = [];

  for (const f of filters) {
    if (f.disabled) {
      continue;
    }

    if (f.scopeV2) {
      // Typed path — scopeV2 encodes all scope information; legacy fields are ignored.
      const sv2 = f.scopeV2;
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
            (activePageId === undefined || sv2.pageId === activePageId)
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
    } else {
      // Legacy path — fall back to the flat fields present on all existing filters.
      // Dashboard date-range filters are scoped to their own source. A filter
      // created for source A must not apply to widgets on source B — it would
      // either target a non-existent field or trigger a spurious semi-join.
      if (f.isDashboardDateRange && f.filterSourceId && f.filterSourceId !== widgetSourceId) {
        continue;
      }

      switch (f.scope) {
        case 'page':
          result.push(f);
          break;
        case 'widget':
          if (f.widgetId === widgetId && f.filterMode !== 'rank') {
            result.push(f);
          }
          break;
        case 'cross-filter':
          if (
            include === 'all' &&
            f.sourceWidgetId !== widgetId &&
            (activePageId === undefined || f.pageId === activePageId)
          ) {
            result.push(f);
          }
          break;
        case 'interactive':
          if (
            include !== 'no-cross' &&
            f.sourceWidgetId !== widgetId &&
            (activePageId === undefined || f.pageId === activePageId)
          ) {
            result.push(f);
          }
          break;
        default:
          break;
      }
    }
  }

  return resolveDateRangePresets(result);
}
