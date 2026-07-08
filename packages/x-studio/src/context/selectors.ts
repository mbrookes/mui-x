import { createSelectorMemoized } from '@mui/x-internals/store';
import { isWidgetOfKind } from '../models';
import type {
  StudioDoc,
  StudioExpressionField,
  StudioFilterState,
  StudioState,
  StudioWidget,
  StudioDataSource,
} from '../models';

/**
 * Module-level stable selector functions for use with useStudioSelector.
 *
 * Using module-level functions (rather than inline arrows) ensures selector
 * identity is stable across renders, which prevents unnecessary re-evaluations
 * in React 19's useSyncExternalStore path.
 */

export const selectFilters = (state: StudioState) => state.doc.filters;
const EMPTY_FILTER_PRESETS: NonNullable<StudioDoc['filterPresets']> = [];
export const selectFilterPresets = (state: StudioState) =>
  state.doc.filterPresets ?? EMPTY_FILTER_PRESETS;
export const selectDataSources = (state: StudioState) => state.runtime.dataSources;
export const selectRelationships = (state: StudioState) => state.doc.relationships;
export const selectExpressionFields = (state: StudioState) => state.doc.expressionFields;
export const selectWidgets = (state: StudioState) => state.doc.widgets;
export const selectMode = (state: StudioState) => state.session.mode;
export const selectShell = (state: StudioState) => state.session.shell;
export const selectActivePageId = (state: StudioState) => state.doc.dashboard.activePageId;
export const selectPages = (state: StudioState) => state.doc.pages;
export const selectDashboard = (state: StudioState) => state.doc.dashboard;
export const selectActivePage = (state: StudioState) =>
  state.doc.pages[state.doc.dashboard.activePageId];
export const selectGlobalCrossFilterMode = (state: StudioState) =>
  state.doc.dashboard.globalCrossFilterMode ?? null;
export const selectCrossFilterAllPages = (state: StudioState) =>
  state.doc.dashboard.crossFilterAllPages ?? false;
export const selectAi = (state: StudioState) => state.doc.ai;

/**
 * Returns a stable memoized selector for the active interactive filter
 * emitted by the given filter widget.
 *
 * @example
 * const sel = React.useMemo(
 *   () => makeSelectActiveInteractiveFilter(widget.id),
 *   [widget.id],
 * );
 * const activeFilter = useStudioSelector(sel);
 */
export function makeSelectActiveInteractiveFilter(widgetId: string) {
  return (state: StudioState) =>
    state.doc.filters.find(
      (f) => f.scope.kind === 'interactive' && f.scope.sourceWidgetId === widgetId,
    ) ?? null;
}

/**
 * Returns a stable memoized selector that filters expressionFields to only
 * those belonging to the given sourceId.
 *
 * The returned selector:
 * - Returns the same array reference if the global expressionFields array
 *   reference is unchanged (O(1) check).
 * - If the global array changed (e.g. another source's field was added),
 *   re-filters but returns the previous reference if all filtered elements
 *   are identical — so widgets for other sources don't re-render.
 * - Only returns a new array when this source's fields actually changed.
 *
 * Use with useMemo to ensure the selector function is stable for the same
 * sourceId across renders:
 * @example
 * const sel = React.useMemo(
 *   () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
 *   [widget.sourceId],
 * );
 * const expressionFields = useStudioSelector(sel);
 */
export function makeSelectExpressionFieldsForSource(sourceId: string) {
  let lastInput: StudioExpressionField[] | undefined;
  let lastResult: StudioExpressionField[] | undefined;

  return (state: StudioState): StudioExpressionField[] => {
    const exprFields = state.doc.expressionFields;
    if (exprFields === lastInput && lastResult !== undefined) {
      return lastResult;
    }
    const filtered = exprFields.filter((ef) => ef.sourceId === sourceId);
    // If filtered items are reference-identical to the previous result,
    // return the previous array so downstream useSyncExternalStore comparisons
    // see no change and skip the re-render.
    if (
      lastResult !== undefined &&
      filtered.length === lastResult.length &&
      // react-doctor-disable-next-line react-doctor/js-length-check-first -- length check is on the line above
      filtered.every((ef, i) => ef === lastResult![i])
    ) {
      lastInput = exprFields;
      return lastResult;
    }
    lastInput = exprFields;
    lastResult = filtered;
    return filtered;
  };
}

/**
 * Returns a stable memoized selector that filters expressionFields to only
 * those belonging to any of the given source IDs.
 *
 * Semantics are identical to makeSelectExpressionFieldsForSource but for
 * multiple sources at once. Use this in useWidgetRows so that cross-filter
 * enrichment (which may need expression fields from related sources) works
 * correctly while still avoiding re-renders from completely unrelated sources.
 */
export function makeSelectExpressionFieldsForSources(sourceIds: ReadonlySet<string>) {
  let lastInput: StudioExpressionField[] | undefined;
  let lastResult: StudioExpressionField[] | undefined;

  return (state: StudioState): StudioExpressionField[] => {
    const exprFields = state.doc.expressionFields;
    if (exprFields === lastInput && lastResult !== undefined) {
      return lastResult;
    }
    const filtered = exprFields.filter((ef) => sourceIds.has(ef.sourceId));
    if (
      lastResult !== undefined &&
      filtered.length === lastResult.length &&
      // react-doctor-disable-next-line react-doctor/js-length-check-first -- length check is on the line above
      filtered.every((ef, i) => ef === lastResult![i])
    ) {
      lastInput = exprFields;
      return lastResult;
    }
    lastInput = exprFields;
    lastResult = filtered;
    return filtered;
  };
}

export interface PartitionedFilters {
  /** Filters with scope === 'page' */
  page: StudioFilterState[];
  /** All widget-scoped filters, keyed by widgetId */
  byWidgetId: Map<string, StudioFilterState[]>;
  /** Filters with scope === 'cross-filter' */
  cross: StudioFilterState[];
  /** Filters with scope === 'interactive' */
  interactive: StudioFilterState[];
}

/**
 * Like `PartitionedFilters` but only includes page-scoped and widget-scoped
 * filters — it is intentionally stable when only cross-filters or interactive
 * filters change.
 *
 * Use this for `isRecomputing` comparisons so that the loading overlay is NOT
 * shown during cross-filter changes (those use cached row results and are fast).
 */
export interface BasePartitionedFilters {
  page: StudioFilterState[];
  byWidgetId: Map<string, StudioFilterState[]>;
}

// ── Shared partitioning core ────────────────────────────────────────────────
//
// `selectPartitionedFilters`, `selectPartitionedBaseFilters`,
// `makeSelectPartitionedFiltersForPage`, and `makeSelectPartitionedBaseFiltersForPage`
// all partition the same `filters` array into the same page/widget/cross/interactive
// buckets and apply the same "reuse the previous result when bucket content is
// unchanged" reference-stability rule — historically copy-pasted four times with two
// toggles (where `pageId` comes from, and whether cross/interactive are included).
// `partitionFilters` and `isPartitionUnchanged` below are the one shared
// implementation of those two pieces; each of the four exports is now a thin wrapper.

/** Single O(F) pass that buckets `filters` by scope kind, scoping the `page` bucket to `pageId`. */
function partitionFilters(filters: StudioFilterState[], pageId: string | undefined) {
  const page: StudioFilterState[] = [];
  const byWidgetId = new Map<string, StudioFilterState[]>();
  const cross: StudioFilterState[] = [];
  const interactive: StudioFilterState[] = [];

  for (const f of filters) {
    if (f.scope.kind === 'page' || f.scope.kind === 'dashboard-date-range') {
      const scopePageId = 'pageId' in f.scope ? f.scope.pageId : undefined;
      if (!scopePageId || scopePageId === pageId) {
        page.push(f);
      }
    } else if (f.scope.kind === 'widget') {
      const key = f.scope.widgetId;
      let bucket = byWidgetId.get(key);
      if (!bucket) {
        bucket = [];
        byWidgetId.set(key, bucket);
      }
      bucket.push(f);
    } else if (f.scope.kind === 'cross-filter') {
      cross.push(f);
    } else if (f.scope.kind === 'interactive') {
      interactive.push(f);
    }
  }

  return { page, byWidgetId, cross, interactive };
}

function filterArrayUnchanged(prev: StudioFilterState[], next: StudioFilterState[]): boolean {
  return prev.length === next.length && prev.every((f, i) => f === next[i]);
}

function byWidgetIdUnchanged(
  prev: Map<string, StudioFilterState[]>,
  next: Map<string, StudioFilterState[]>,
): boolean {
  if (prev.size !== next.size) {
    return false;
  }
  for (const [key, arr] of next) {
    const prevArr = prev.get(key);
    if (!prevArr || !filterArrayUnchanged(prevArr, arr)) {
      return false;
    }
  }
  return true;
}

/**
 * True when `next`'s buckets are all content-equal to `prev`'s (same filter object
 * references, same order) — `cross`/`interactive` are only compared when
 * `includeCrossAndInteractive` is set, since `BasePartitionedFilters` doesn't have them.
 */
function isPartitionUnchanged(
  prev: PartitionedFilters | BasePartitionedFilters,
  next: PartitionedFilters | BasePartitionedFilters,
  includeCrossAndInteractive: boolean,
): boolean {
  if (
    !filterArrayUnchanged(prev.page, next.page) ||
    !byWidgetIdUnchanged(prev.byWidgetId, next.byWidgetId)
  ) {
    return false;
  }
  if (includeCrossAndInteractive) {
    const p = prev as PartitionedFilters;
    const n = next as PartitionedFilters;
    return (
      filterArrayUnchanged(p.cross, n.cross) && filterArrayUnchanged(p.interactive, n.interactive)
    );
  }
  return true;
}

/**
 * Creates a memoized partitioning selector: recomputes only when `state.doc.filters`
 * or the resolved `pageId` change by reference, and even then reuses the previous
 * result object when the relevant buckets are content-identical (so
 * `useSyncExternalStore` / `useDeferredValue` consumers see no change).
 *
 * The returned selector owns a private closure (`lastFilters`/`lastResult`) — callers
 * that need per-instance isolation (e.g. one selector per mounted widget) must call
 * this factory fresh for each instance; see `makeSelectPartitionedFiltersForPage` and
 * `makeSelectPartitionedBaseFiltersForPage`.
 */
function makePartitionedFiltersSelector(
  getPageId: (state: StudioState) => string | undefined,
  includeCrossAndInteractive: true,
): (state: StudioState) => PartitionedFilters;
function makePartitionedFiltersSelector(
  getPageId: (state: StudioState) => string | undefined,
  includeCrossAndInteractive: false,
): (state: StudioState) => BasePartitionedFilters;
function makePartitionedFiltersSelector(
  getPageId: (state: StudioState) => string | undefined,
  includeCrossAndInteractive: boolean,
) {
  let lastFilters: StudioFilterState[] | undefined;
  let lastPageId: string | undefined;
  let lastResult: PartitionedFilters | BasePartitionedFilters | undefined;

  return (state: StudioState): PartitionedFilters | BasePartitionedFilters => {
    const filters = state.doc.filters;
    const pageId = getPageId(state);
    if (filters === lastFilters && pageId === lastPageId && lastResult !== undefined) {
      return lastResult;
    }

    const full = partitionFilters(filters, pageId);
    const next: PartitionedFilters | BasePartitionedFilters = includeCrossAndInteractive
      ? full
      : { page: full.page, byWidgetId: full.byWidgetId };

    // Reference-stable: if the relevant bucket content matches the previous result,
    // return the prior object so downstream memo/selector consumers see no change.
    if (
      lastResult !== undefined &&
      isPartitionUnchanged(lastResult, next, includeCrossAndInteractive)
    ) {
      lastFilters = filters;
      lastPageId = pageId;
      return lastResult;
    }

    lastFilters = filters;
    lastPageId = pageId;
    lastResult = next;
    return next;
  };
}

/**
 * Partitions the filters array into typed buckets in a single O(F) pass.
 * Returned object is reference-stable as long as `state.doc.filters` and
 * `state.doc.dashboard.activePageId` do not change — all N widgets share the
 * same partition result.
 *
 * Page-scoped filters are scoped to the active page: only filters whose
 * `pageId` matches `activePageId` (or have no `pageId` for legacy data) are
 * included in the `page` bucket.
 *
 * Use this instead of N independent `.filter()` calls in each widget hook.
 *
 * Memoized with createSelectorMemoized (x-internals): re-computes only when
 * `filters` or `activePageId` change by reference. Deliberately NOT built on
 * `makePartitionedFiltersSelector` (unlike the other three exports below) —
 * `createSelectorMemoized` keys its cache per store instance (via a `__cacheKey__`
 * tag carried on the state object), so this bare, module-level export stays safe
 * when multiple `<Studio>` instances share the same process. A plain closure like
 * the other three use would leak state across instances for a bare export (see
 * `selectPartitionedBaseFilters` below).
 */
export const selectPartitionedFilters = createSelectorMemoized(
  selectFilters,
  selectActivePageId,
  (filters, activePageId): PartitionedFilters => partitionFilters(filters, activePageId),
);

/**
 * Like selectPartitionedFilters but only includes page-scoped and widget-scoped
 * filters — it is intentionally stable when only cross-filters or interactive
 * filters change.
 *
 * Use this for `isRecomputing` comparisons so that the loading overlay is NOT
 * shown during cross-filter changes (those use cached row results and are fast).
 *
 * KNOWN LIMITATION (pre-existing, unchanged by this refactor): unlike
 * `selectPartitionedFilters`, this bare export's memo closure is a single
 * module-level instance shared by every caller, so multiple `<Studio>` instances in
 * the same process would ping-pong its cache. No production code calls this bare
 * export directly today (production goes through `makeSelectPartitionedBaseFiltersForPage`,
 * which correctly creates one closure per widget instance) — only tests and, in
 * principle, external deep-importers do. Left as-is rather than "fixed" via
 * `createSelectorMemoized`, which would drop the content-level bucket-reuse
 * behavior this selector is specifically tested for.
 */
export const selectPartitionedBaseFilters = makePartitionedFiltersSelector(
  (state) => state.doc.dashboard.activePageId,
  false,
);

/**
 * Per-page variant of `selectPartitionedFilters`. Returns a memoized selector
 * that scopes page-level filters to the given `pageId` instead of the globally
 * active page.
 *
 * Use this (via React.useMemo) in widgets that must remain mounted even when
 * their page is not the active one — ensures each page's widgets only see
 * their own page's filters.
 */
export function makeSelectPartitionedFiltersForPage(pageId: string) {
  return makePartitionedFiltersSelector(() => pageId, true);
}

/**
 * Per-page variant of `selectPartitionedBaseFilters`. Returns a memoized
 * selector that scopes page-level filters to the given `pageId`.
 *
 * Use this for `isRecomputing` detection in mounted-but-inactive page widgets.
 */
export function makeSelectPartitionedBaseFiltersForPage(pageId: string) {
  return makePartitionedFiltersSelector(() => pageId, false);
}

/**
 * Returns a stable memoized selector that returns only the cross-filter
 * emitted by the given widget on the given page (or null if none).
 *
 * The returned filter object reference is preserved between renders as long
 * as the same filter is in the array, so charts that produced a cross-filter
 * won't re-render just because another widget's filter changed.
 *
 * @example
 * const sel = React.useMemo(
 *   () => makeSelectActiveCrossFilter(widget.id, activePageId),
 *   [widget.id, activePageId],
 * );
 * const activeCrossFilter = useStudioSelector(sel);
 */
export function makeSelectActiveCrossFilter(widgetId: string, pageId: string) {
  return (state: StudioState): StudioFilterState | null =>
    state.doc.filters.find(
      (f) =>
        f.scope.kind === 'cross-filter' &&
        f.scope.sourceWidgetId === widgetId &&
        f.scope.pageId === pageId &&
        !f.disabled,
    ) ?? null;
}

/**
 * Returns a stable memoized selector that returns the cross-filters
 * arriving from OTHER widgets on the given page.
 *
 * Uses reference-equality caching so a chart only re-renders when the
 * set of incoming cross-filters actually changes (same pattern as
 * makeSelectExpressionFieldsForSource).
 *
 * @example
 * const sel = React.useMemo(
 *   () => makeSelectIncomingCrossFilters(widget.id, activePageId),
 *   [widget.id, activePageId],
 * );
 * const incomingCrossFilters = useStudioSelector(sel);
 */
export function makeSelectIncomingCrossFilters(widgetId: string, pageId: string) {
  let lastInput: StudioFilterState[] | undefined;
  let lastResult: StudioFilterState[] | undefined;

  return (state: StudioState): StudioFilterState[] => {
    const filters = state.doc.filters;
    if (filters === lastInput && lastResult !== undefined) {
      return lastResult;
    }
    const filtered = filters.filter(
      (f) =>
        f.scope.kind === 'cross-filter' &&
        f.scope.sourceWidgetId !== widgetId &&
        f.scope.pageId === pageId &&
        !f.disabled,
    );
    if (
      lastResult !== undefined &&
      filtered.length === lastResult.length &&
      // react-doctor-disable-next-line react-doctor/js-length-check-first -- length check is on the line above
      filtered.every((f, i) => f === lastResult![i])
    ) {
      lastInput = filters;
      return lastResult;
    }
    lastInput = filters;
    lastResult = filtered;
    return filtered;
  };
}

// ── Per-widget selectors ──────────────────────────────────────────────────────
// These factory functions return stable selector functions that depend only on
// widgetId. Use with React.useMemo in components that render once per widget
// (e.g. StudioWidgetCard) so the selector identity is stable across renders,
// preventing React 19's useSyncExternalStore from recreating getSelection on
// every render.

/**
 * Returns the widget config for the given widgetId, or undefined if not found.
 */
export function makeSelectWidget(
  widgetId: string,
): (state: StudioState) => StudioWidget | undefined {
  return (state) => state.doc.widgets[widgetId];
}

/**
 * Returns true when this widget is the currently selected widget.
 */
export function makeSelectIsWidgetSelected(widgetId: string): (state: StudioState) => boolean {
  return (state) => state.session.shell.selectedWidgetId === widgetId;
}

/**
 * Returns true when another widget is selected (this widget should be dimmed).
 * Subscribing only to the selected-widget ID means that when selection moves
 * from A→B, only cards A and B re-render rather than all N cards.
 */
export function makeSelectIsWidgetDimmed(widgetId: string): (state: StudioState) => boolean {
  return (state) =>
    state.session.shell.selectedWidgetId !== null &&
    state.session.shell.selectedWidgetId !== widgetId;
}

/**
 * Returns the data source for the given widgetId's configured sourceId,
 * or undefined if the widget has no source or the source doesn't exist.
 */
export function makeSelectWidgetSource(
  widgetId: string,
): (state: StudioState) => StudioDataSource | undefined {
  return (state) => {
    const w = state.doc.widgets[widgetId];
    return w?.sourceId ? state.runtime.dataSources[w.sourceId] : undefined;
  };
}

/**
 * Returns the active rank filter for a chart widget (scope=widget, filterMode=rank,
 * value > 0), or null if the widget is not a chart or has no active rank filter.
 */
export function makeSelectWidgetRankFilter(
  widgetId: string,
): (state: StudioState) => StudioFilterState | null {
  return (state) => {
    const w = state.doc.widgets[widgetId];
    if (w?.kind !== 'chart') {
      return null;
    }
    return (
      state.doc.filters.find(
        (f) =>
          f.scope.kind === 'widget' &&
          f.scope.widgetId === widgetId &&
          f.filterMode === 'rank' &&
          typeof f.value === 'number' &&
          f.value > 0,
      ) ?? null
    );
  };
}

/**
 * Returns the active interactive (slider) filter emitted by this widget on the
 * given page, or null if the widget is not a slider or has no active filter.
 */
export function makeSelectWidgetSliderFilter(
  widgetId: string,
  pageId: string,
): (state: StudioState) => StudioFilterState | null {
  return (state) => {
    const w = state.doc.widgets[widgetId];
    if (!w || !isWidgetOfKind(w, 'filter') || w.config?.filterWidgetType !== 'slider') {
      return null;
    }
    return (
      state.doc.filters.find(
        (f) =>
          f.scope.kind === 'interactive' &&
          f.scope.sourceWidgetId === widgetId &&
          f.scope.pageId === pageId,
      ) ?? null
    );
  };
}

/**
 * Returns the active cross-filter emitted by this chart/grid widget on the
 * given page, or null if the widget kind doesn't emit cross-filters or has
 * none active.
 */
export function makeSelectWidgetActiveCrossFilter(
  widgetId: string,
  pageId: string,
): (state: StudioState) => StudioFilterState | null {
  return (state) => {
    const w = state.doc.widgets[widgetId];
    if (w?.kind !== 'chart' && w?.kind !== 'grid') {
      return null;
    }
    return (
      state.doc.filters.find(
        (f) =>
          f.scope.kind === 'cross-filter' &&
          f.scope.sourceWidgetId === widgetId &&
          f.scope.pageId === pageId,
      ) ?? null
    );
  };
}
