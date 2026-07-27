import { resolveDateRangePresets } from './filterUtils';
import type { StudioFilterState } from '../models';

/**
 * Returns the subset of `filters` that applies to a specific widget.
 *
 * Single source of truth for all three data paths (async adapter, sync in-memory,
 * non-React pipeline). Filters without `scope` are silently skipped; `scope` is a
 * REQUIRED field of `StudioFilterState` and `deserializeState` drops any persisted
 * entry whose scope fails `isValidFilterScope`, so this guard only ever fires on a
 * hand-constructed or otherwise untyped filter.
 *
 * @param include
 *   Gates ONLY the two interaction-driven scope kinds. `page`, `widget` and
 *   `dashboard-date-range` are authored filters and are considered for every value:
 *
 *   'all' (default) — page + widget + dashboard-date-range + cross-filter + interactive
 *   'no-cross'      — page + widget + dashboard-date-range (filteredRowsNoCross)
 *   'no-chart-cross'— the above plus interactive, no scope:'cross-filter'
 *                     (filteredRowsNoChartCross)
 *
 *   The `dashboard-date-range` term used to be missing from this list, which read as
 *   "'no-cross' = page + widget only" — `useBlendedSeriesRows` relies on the opposite
 *   (it passes 'no-cross' precisely to get the page + dashboard-date-range set for a
 *   foreign series' source), so the omission described a behaviour no caller wanted.
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

/**
 * The CANDIDATE filters an ADAPTER-backed widget must still evaluate client-side after the
 * server has answered its query — the "residual".
 *
 * ## Why a residual exists at all
 *
 * `buildQueryDescriptor` bakes the widget's authored page/widget/dashboard-date-range filters
 * into the wire request (`include: 'no-cross'`), so the rows that come back have ALREADY been
 * reduced by them. Re-applying them locally is not merely redundant, it is destructive: the
 * descriptor's `select` list is built from `collectSelectFields(widget)` plus rank/cross field
 * refs (`internals/queryDescriptor.ts`), NOT from the fields the authored page filters
 * reference. A page filter on `order_date` therefore evaluates against rows that carry no
 * `order_date` key at all and rejects every one of them — a dashboard date range turned the
 * CSV export into a headers-only file while the grid on screen showed N rows (finding M1b).
 *
 * ## The rule
 *
 * The residual is EXACTLY the set of filters `buildQueryDescriptor` did not put into the wire
 * `filter` tree. That tree is
 * `serverFilters.filter((f) => filterMode !== 'rank' && isFilterComplete(f))`, which yields two
 * complementary halves:
 *
 * - **Authored scopes** (`page`, `widget`, `dashboard-date-range`) contribute ONLY their
 *   rank-mode (top/bottom-N) filters. A rank reduction has no wire representation —
 *   `filterStateToLeaf` drops `filterMode`, so shipping one would serialize as a bogus
 *   `field = <N>` predicate — hence `buildQueryDescriptor` strips it and the reduction has to
 *   run here instead. Their NON-rank filters are already enforced server-side and must not be
 *   re-applied (that is the M1b failure above).
 * - **Interaction scopes** (`cross-filter`, `interactive`) contribute everything. They are
 *   deliberately kept off the descriptor so a chart click never triggers a server round-trip or
 *   churns the request cacheKey, which makes this client-side pass their SOLE enforcement point.
 *
 * `dashboard-date-range` is keyed on rank-ness for the same reason `page` is, rather than being
 * excluded wholesale by scope kind. `applyFilters` decides what is a rank reduction purely from
 * `filterMode`, with no regard for scope, so a rank-mode date-range filter is reduced at L3 on
 * the sync path — and `buildQueryDescriptor` strips it from the wire tree just like any other
 * rank filter. Excluding it by scope kind would leave it enforced nowhere at all. This is where
 * the export path's former hand-transcribed copy of this predicate had drifted: it excluded
 * every `dashboard-date-range` filter unconditionally, so an adapter-backed export silently
 * dropped a rank-mode one that the on-screen render path applied.
 *
 * Incomplete filters (`isFilterComplete` false — e.g. the drawer's `{ operator: 'equals',
 * value: '' }` add-filter default) are pruned from the wire tree too, but they are equally
 * dropped by `applyFilters` client-side, so they need no residual treatment either way.
 *
 * ## This returns CANDIDATES, not a final set
 *
 * Callers MUST still pass the result through {@link selectFiltersForWidget}. This function
 * decides only the rank-vs-scope-kind half of the rule; the page/source/`disabled`/`include`/
 * `crossFilterAllPages`/self-emission scoping — and `resolveDateRangePresets` — all live there
 * and are deliberately not duplicated here.
 *
 * @param includeWidgetRank
 *   Whether this widget's WIDGET-scoped rank filter is reduced at L3 rather than
 *   post-aggregation. Callers pass `shouldApplyWidgetRankAtL3(widget)`
 *   (`internals/StudioPipeline.ts`), the single source of truth for that rule.
 *
 *   It is a REQUIRED parameter with no default, deliberately. `selectFiltersForWidget` applies
 *   the same gate downstream, so a caller that omitted it would still get the right answer via
 *   that second gate — which is precisely what makes a default dangerous: the two callers of
 *   this function previously disagreed about whether to gate here or downstream, and the
 *   difference was invisible because it happened to be masked. Forcing both to state the flag
 *   makes the two gates provably the same boolean rather than coincidentally equivalent.
 *
 *   It is a parameter rather than an internal `shouldApplyWidgetRankAtL3(widget)` call for a
 *   structural reason as well: `StudioPipeline.ts` imports this module, so importing it back
 *   would form a cycle.
 */
export function selectAdapterResidualFilters(
  filters: StudioFilterState[],
  opts: { widgetId: string; includeWidgetRank: boolean },
): StudioFilterState[] {
  const { widgetId, includeWidgetRank } = opts;
  const residual: StudioFilterState[] = [];

  for (const f of filters) {
    const scope = f.scope;
    if (!scope) {
      continue;
    }
    const isRank = (f.filterMode ?? 'condition') === 'rank';
    switch (scope.kind) {
      case 'page':
      case 'dashboard-date-range':
        // Authored, and already enforced server-side unless it is a rank reduction the wire
        // protocol cannot express. Page/date-range scoping by `pageId` is left to
        // `selectFiltersForWidget`.
        if (isRank) {
          residual.push(f);
        }
        break;
      case 'widget':
        // Same rule as the authored scopes above, plus the L3-vs-post-aggregation gate. The
        // widget-id match is re-checked by `selectFiltersForWidget`; it is applied here too so
        // a rank filter belonging to another widget never even enters the candidate set.
        if (scope.widgetId === widgetId && isRank && includeWidgetRank) {
          residual.push(f);
        }
        break;
      case 'cross-filter':
      case 'interactive':
        // Never sent to the server; this pass is their sole enforcement point.
        residual.push(f);
        break;
      default:
        break;
    }
  }

  return residual;
}
