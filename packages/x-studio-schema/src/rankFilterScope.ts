/**
 * Rank-filter page-scope resolution, and the per-page rank-uniqueness predicate built on it.
 *
 * These two functions began life inside `applyMutation.ts`, next to the reducer handlers that
 * enforce the invariant. That home made them unreachable from `factories.ts` — the fourth
 * trust boundary — because `applyMutation.ts` imports `factories.ts` (for
 * `normalizeChartSeries`), so an import the other way would cycle. The factory was therefore
 * the ONE producer of a `StudioDoc` that could not re-check rank uniqueness, and an
 * `initialState` carrying two conflicting rank filters installed both: live-valid but
 * load-invalid, with the next layout mutation or reload silently dropping one and
 * re-persisting the loss.
 *
 * This module exists to break that constraint, and can only do so by importing NOTHING at
 * runtime — the two functions below need `StudioDoc['pages']` and `StudioFilterState` as
 * TYPES only, so a dependency-free module is the natural home. All four consumers
 * (`applyMutation.ts`'s `addFilter`/layout sweeps, `statePersistence.ts`'s load-boundary
 * dedup, `factories.ts`'s override screen, and `@mui/x-studio`'s filter-drawer affordances via
 * the package index) now read the SAME implementation, which is the whole point: the four
 * trust boundaries must agree on which payloads are acceptable, and a hand-copy per boundary
 * is exactly how they drift.
 */
import type { StudioDoc, StudioFilterState } from './stateTypes';

/**
 * A widget-id → owning-page-id lookup, built once per sweep so the `widget` branch of
 * {@link resolveRankFilterPageId} is an O(1) hit instead of a fresh walk of every page's
 * `widgetRows`.
 */
export type RankFilterWidgetPageIndex = ReadonlyMap<string, string>;

/**
 * Builds the {@link RankFilterWidgetPageIndex} for a page map in ONE O(widgets) pass.
 *
 * Why this exists: `resolveRankFilterPageId`'s `widget` branch scans `Object.values(pages)`
 * × rows on every call, `hasConflictingRankFilter` calls it once for the target plus once
 * per already-kept filter, and `dedupeRankFilters` calls THAT once per filter — so the
 * layout walk ran O(R²) times over a `pages` map that is immutable for the whole sweep.
 * On a legitimate 100-page / 5 000-widget doc with 100 rank filters that is ~120ms inside a
 * SYNCHRONOUS reducer call (`setWidgetLayout`, `removePage`, `applyBulkUpdate`), and it is
 * far worse at the load boundary, which sweeps the UN-deduped array from untrusted input
 * where the one-rank-filter-per-page invariant does not hold: 1 000 rank filters over that
 * same doc took more than a second in a single `deserializeState`.
 *
 * The tie-break MUST match the scan it replaces: that scan returns the FIRST page (in
 * `Object.values(pages)` order) whose `widgetRows` contain the widget, so this builder
 * iterates in the same order and never overwrites a key that is already present. A widget
 * duplicated across pages therefore still resolves to the page it resolved to before.
 *
 * A missing key yields `undefined` from `Map.get`, which is exactly the UNRESOLVABLE
 * sentinel the scan returns for an unplaced widget — so the indexed and un-indexed paths
 * agree on all three states with no extra mapping.
 *
 * The value stored is the page's RECORD KEY, not its `page.id` field — see
 * {@link resolveRankFilterPageId} for why (R6 F2).
 */
export function buildRankFilterWidgetPageIndex(
  pages: StudioDoc['pages'],
): RankFilterWidgetPageIndex {
  const index = new Map<string, string>();
  for (const [pageKey, page] of Object.entries(pages)) {
    // Every IN-PACKAGE caller is already immune — `screenPagesShape` (factory) and
    // `normalizePersistedPages` (load) both drop a null page value before this runs. The
    // guard is for the caller they do not cover: this function is exported from the package
    // index and `@mui/x-studio`'s `StudioFiltersDrawer` calls it directly with `pages` read
    // straight off the store, which a host's `initialState` populates. So a null page
    // reaching here is a live path, not dead defense, and skipping rather than dereferencing
    // keeps this builder from being the one place a malformed override still throws. Pinned
    // by `rankFilterScope.test.ts`.
    if (!page) {
      continue;
    }
    for (const row of page.widgetRows ?? []) {
      for (const widgetId of row) {
        if (!index.has(widgetId)) {
          index.set(widgetId, pageKey);
        }
      }
    }
  }
  return index;
}

/**
 * Resolves the page a rank-eligible filter applies to, for the per-page rank-uniqueness
 * guard. The answer is THREE-state, and the two non-string states mean OPPOSITE things:
 *  - a `string` → the concrete page this filter's rank window applies to.
 *  - `null` → "applies EVERYWHERE": the legacy pageId-less `page` scope, active on every
 *    page, so it conflicts with — and is conflicted by — every rank filter.
 *  - `undefined` → "UNRESOLVABLE": there is no page context to compare against, so it
 *    conflicts with nothing and blocks nothing. Returned for a `widget` scope whose widget
 *    sits on no page's `widgetRows` (left in `doc.widgets` but unplaced — e.g. after a
 *    `setWidgetLayout`, or an `applyBulkUpdate` whose `activePageId` no longer exists), and
 *    for every non-rank-eligible scope kind.
 *
 * Keeping UNRESOLVABLE distinct from the `null` wildcard is what stops ONE unplaced-widget
 * rank filter — which nothing removes, since `dropWidgetScopedFilters` fires only on widget
 * REMOVAL — from "conflicting" with, and therefore silently rejecting, every rank
 * `addFilter` on every page.
 *
 * The mirror consequence is that an unresolvable filter is accepted with no page context to
 * check, so a later PLACEMENT can create the conflict `addFilter` could not see. That is
 * what `applyMutation.ts`'s `dropConflictingRankFilters` exists to catch in the layout
 * handlers.
 *
 * The resolved page is the page's RECORD KEY, not its `page.id` field (R6 F2). The two are
 * the same for any well-formed doc, but a host `initialState` can install a page whose `id`
 * disagrees with its key, and the key is the source of truth for every OTHER page reference
 * in the system — `state.pages[pageId]`, `dashboard.activePageId`, a filter's
 * `scope.pageId`, and `@mui/x-studio`'s `internals/widgetPageResolution.ts` (which the
 * cross-filter/interactive stamping and the widget-move paths use) all key off it, and
 * `normalizePersistedPages` repairs a desync by re-stamping `page.id` FROM the key. Keying
 * off `page.id` here made this guard and those paths disagree about which page a widget is
 * on: with `pages: { p1: { id: 'zzz', widgetRows: [['w1']] } }`, a `widget`-scoped rank
 * filter on `w1` resolved to `'zzz'` while a `page`-scoped rank filter stamped with the
 * active page resolved to `'p1'`, so the uniqueness guard saw no conflict and BOTH installed
 * — then the next load repaired `page.id` to `'p1'`, `dedupeRankFilters` finally saw the
 * conflict, and one of the user's filters silently disappeared.
 *
 * `@mui/x-studio`'s `internals/rankFilterScope.ts` is a pure re-export of this module: the
 * dependency arrow runs `x-studio` → `x-studio-schema`, never the reverse, so this
 * dependency-free package owns the implementation and the client reads it. The reducer is
 * the mutation-semantics source of truth and must not depend on every caller
 * (`StudioController`'s five call sites) enforcing the invariant first.
 */
export function resolveRankFilterPageId(
  filter: StudioFilterState,
  pages: StudioDoc['pages'],
  widgetPageIndex?: RankFilterWidgetPageIndex,
): string | null | undefined {
  const { scope } = filter;
  if (scope.kind === 'page') {
    return scope.pageId ?? null;
  }
  if (scope.kind === 'widget') {
    if (widgetPageIndex) {
      // A miss is `undefined`, which IS the UNRESOLVABLE sentinel documented above — the
      // same answer the scan below gives for a widget that sits on no page's `widgetRows`.
      return widgetPageIndex.get(scope.widgetId);
    }
    for (const [pageKey, page] of Object.entries(pages)) {
      // The RECORD KEY, matching `buildRankFilterWidgetPageIndex` (which must agree with
      // this scan) and every other page reference in the system — see this function's doc
      // comment (R6 F2).
      if ((page?.widgetRows ?? []).some((row) => row.includes(scope.widgetId))) {
        return pageKey;
      }
    }
    // UNRESOLVABLE, not "everywhere": an unplaced widget's rank filter has no page
    // context, so it must neither conflict with nor be conflicted by anything.
    return undefined;
  }
  // Not rank-eligible at all — also unresolvable, never a wildcard.
  return undefined;
}

/**
 * True when another rank filter already occupies `target`'s page context. Rank
 * uniqueness is per-page — a rank filter on page-1 does not block one on page-2 —
 * because page filters gate on `pageId === activePageId` and widget rank filters
 * are per-widget. A `null` resolved page (a pageId-less page filter, applied
 * everywhere) conflicts with — and is conflicted by — any other rank filter.
 *
 * An `undefined` resolved page ({@link resolveRankFilterPageId}'s UNRESOLVABLE sentinel)
 * is the opposite of the `null` wildcard:
 *  - an unresolvable TARGET conflicts with NOTHING (no page context to collide on, so the
 *    add is always allowed), and
 *  - an unresolvable OTHER filter is NON-conflicting (it cannot block anything).
 *
 * Only `page`/`widget` scopes are rank-eligible, so the existing-filter loop below excludes
 * every OTHER scope kind. `filterMode: 'rank'` on e.g. a `dashboard-date-range` or
 * `interactive` scope is wire-valid (the wire boundary never restricts `filterMode` to a
 * scope kind) but is not a rank window over a page, and treating it as one would make a
 * single such filter reject every legitimate `page`/`widget` rank filter thereafter.
 * `addFilter` mirrors the exclusion by skipping the gate entirely for those scopes, so this
 * loop's copy is what protects the OTHER callers — the layout handlers' sweep, the
 * load-boundary dedup in `statePersistence.ts`, and the factory's override screen in
 * `factories.ts`.
 */
export function hasConflictingRankFilter(
  filterId: string,
  target: StudioFilterState,
  filters: StudioFilterState[],
  pages: StudioDoc['pages'],
  widgetPageIndex?: RankFilterWidgetPageIndex,
): boolean {
  const targetPageId = resolveRankFilterPageId(target, pages, widgetPageIndex);
  // An unresolvable target has no page context to collide on — it conflicts with nothing.
  if (targetPageId === undefined) {
    return false;
  }
  return filters.some((filter) => {
    if (
      filter.id === filterId ||
      (filter.scope.kind !== 'page' && filter.scope.kind !== 'widget') ||
      filter.filterMode !== 'rank'
    ) {
      return false;
    }
    const otherPageId = resolveRankFilterPageId(filter, pages, widgetPageIndex);
    // An unresolvable OTHER filter (an unplaced widget's rank filter) blocks nothing.
    if (otherPageId === undefined) {
      return false;
    }
    return targetPageId === null || otherPageId === null || otherPageId === targetPageId;
  });
}

/**
 * Enforce per-page rank-filter uniqueness across a whole filter array, keeping the FIRST
 * rank filter for each page context in array order and dropping any later one that conflicts
 * with it.
 *
 * The three enforcement sites that need this array-wide sweep — `applyMutation.ts`'s
 * `dropConflictingRankFilters`, `statePersistence.ts`'s load-boundary dedup, and
 * `factories.ts`'s override screen — must agree on WHICH filter survives, or a doc that is
 * valid at one boundary loses a filter at the next. They share this loop so the predicate and
 * the array-order tie-break cannot drift.
 *
 * `changed` is reported rather than baked in because the callers differ in what they do with
 * a changed array: the reducer and the load boundary cascade the drops into the survivors'
 * `dependsOn` (via `pruneDependsOn`, which lives in `applyMutation.ts` and is therefore out
 * of this module's reach), while the factory — which does not prune after any of its other
 * filter drops — simply takes the array. Returning the SAME array reference when nothing
 * conflicted is what keeps a well-formed doc free of churn.
 */
export function dedupeRankFilters(
  filters: StudioFilterState[],
  pages: StudioDoc['pages'],
): { filters: StudioFilterState[]; changed: boolean } {
  let changed = false;
  const kept: StudioFilterState[] = [];
  // `pages` is immutable for the whole sweep, so the widget→page lookup is built ONCE here
  // and threaded down instead of being rediscovered by a full layout walk on every one of
  // the O(R²) resolves this loop performs. See `buildRankFilterWidgetPageIndex`.
  const widgetPageIndex = buildRankFilterWidgetPageIndex(pages);
  for (const filter of filters) {
    // Two independent gates, and only ONE of them is redundant. An earlier version of this
    // comment said "this clause is REDUNDANT, not load-bearing" without saying which clause;
    // that is true of one conjunct and false of the other.
    //
    //  - The SCOPE-KIND conjunct IS redundant. A `filterMode: 'rank'` filter on e.g. a
    //    `dashboard-date-range` scope resolves to the UNRESOLVABLE sentinel, and
    //    `hasConflictingRankFilter` returns false for an unresolvable target, so such a
    //    filter is consistently kept with or without it — including when it is reordered
    //    relative to a legitimate rank filter. It is kept as a cheap, local statement of the
    //    eligibility rule at the site that depends on it, so a future change to the
    //    sentinel's meaning cannot silently start sweeping non-rank-eligible scopes.
    //
    //  - The `filterMode === 'rank'` conjunct is LOAD-BEARING, and it is the only reason an
    //    ordinary page filter survives this sweep. `hasConflictingRankFilter` answers "is
    //    another rank filter already occupying this page context?" and deliberately never
    //    inspects the TARGET's own mode, so every caller must gate — which is why
    //    `applyMutation`'s `addFilter` mirrors this. Measured with only this conjunct
    //    removed: `dedupeRankFilters([rank, plain])` keeps `["rank-1"]` and reports
    //    `changed`, while `dedupeRankFilters([plain, rank])` keeps both. That is an ordinary
    //    filter silently deleted at the LOAD boundary, with an outcome that depends on array
    //    order — the property this comment used to claim could not happen.
    //    `rankFilterScope.test.ts`'s "the non-rank filters it must not touch" pins it.
    if (
      filter.filterMode === 'rank' &&
      (filter.scope.kind === 'page' || filter.scope.kind === 'widget') &&
      hasConflictingRankFilter(filter.id, filter, kept, pages, widgetPageIndex)
    ) {
      changed = true;
      continue;
    }
    kept.push(filter);
  }
  return changed ? { filters: kept, changed: true } : { filters, changed: false };
}
