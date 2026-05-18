import type { StudioExpressionField, StudioFilterState, StudioState } from '../models';

/**
 * Module-level stable selector functions for use with useStudioSelector.
 *
 * Using module-level functions (rather than inline arrows) ensures selector
 * identity is stable across renders, which prevents unnecessary re-evaluations
 * in React 19's useSyncExternalStore path.
 */

export const selectFilters = (state: StudioState) => state.filters;
export const selectDataSources = (state: StudioState) => state.dataSources;
export const selectRelationships = (state: StudioState) => state.relationships;
export const selectExpressionFields = (state: StudioState) => state.expressionFields;
export const selectWidgets = (state: StudioState) => state.widgets;
export const selectMode = (state: StudioState) => state.mode;
export const selectShell = (state: StudioState) => state.shell;
export const selectActivePageId = (state: StudioState) => state.dashboard.activePageId;
export const selectPages = (state: StudioState) => state.pages;
export const selectDashboard = (state: StudioState) => state.dashboard;
export const selectActivePage = (state: StudioState) => state.pages[state.dashboard.activePageId];

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
    state.filters.find((f) => f.scope === 'interactive' && f.sourceWidgetId === widgetId) ?? null;
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
    const exprFields = state.expressionFields;
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
    const exprFields = state.expressionFields;
    if (exprFields === lastInput && lastResult !== undefined) {
      return lastResult;
    }
    const filtered = exprFields.filter((ef) => sourceIds.has(ef.sourceId));
    if (
      lastResult !== undefined &&
      filtered.length === lastResult.length &&
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
 * Partitions the filters array into typed buckets in a single O(F) pass.
 * Returned object is reference-stable as long as `state.filters` reference
 * does not change — all N widgets share the same partition result.
 *
 * Use this instead of N independent `.filter()` calls in each widget hook.
 */
let lastFiltersInput: StudioFilterState[] | undefined;
let lastPartitionResult: PartitionedFilters | undefined;

export const selectPartitionedFilters = (state: StudioState): PartitionedFilters => {
  const filters = state.filters;
  if (filters === lastFiltersInput && lastPartitionResult !== undefined) {
    return lastPartitionResult;
  }
  const page: StudioFilterState[] = [];
  const byWidgetId = new Map<string, StudioFilterState[]>();
  const cross: StudioFilterState[] = [];
  const interactive: StudioFilterState[] = [];

  for (const f of filters) {
    if (f.scope === 'page') {
      page.push(f);
    } else if (f.scope === 'widget') {
      const key = f.widgetId ?? '';
      let bucket = byWidgetId.get(key);
      if (!bucket) {
        bucket = [];
        byWidgetId.set(key, bucket);
      }
      bucket.push(f);
    } else if (f.scope === 'cross-filter') {
      cross.push(f);
    } else if (f.scope === 'interactive') {
      interactive.push(f);
    }
  }

  const result: PartitionedFilters = { page, byWidgetId, cross, interactive };
  lastFiltersInput = filters;
  lastPartitionResult = result;
  return result;
};

/**
 * Like selectPartitionedFilters but only includes page-scoped and widget-scoped
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

let lastBaseFiltersInput: StudioFilterState[] | undefined;
let lastBasePartitionResult: BasePartitionedFilters | undefined;

export const selectPartitionedBaseFilters = (state: StudioState): BasePartitionedFilters => {
  const filters = state.filters;
  if (filters === lastBaseFiltersInput && lastBasePartitionResult !== undefined) {
    return lastBasePartitionResult;
  }

  // Check whether the page/widget filters are the same as before — if so,
  // return the previous result so useDeferredValue sees no change (no spinner).
  const page: StudioFilterState[] = [];
  const byWidgetId = new Map<string, StudioFilterState[]>();

  for (const f of filters) {
    if (f.scope === 'page') {
      page.push(f);
    } else if (f.scope === 'widget') {
      const key = f.widgetId ?? '';
      let bucket = byWidgetId.get(key);
      if (!bucket) {
        bucket = [];
        byWidgetId.set(key, bucket);
      }
      bucket.push(f);
    }
  }

  // If the previous result had the same page/widget filter content, reuse it.
  if (lastBasePartitionResult !== undefined) {
    const prev = lastBasePartitionResult;
    const pageUnchanged =
      prev.page.length === page.length && prev.page.every((f, i) => f === page[i]);
    if (pageUnchanged) {
      // Check byWidgetId: same keys and same arrays
      let widgetUnchanged = prev.byWidgetId.size === byWidgetId.size;
      if (widgetUnchanged) {
        for (const [key, arr] of byWidgetId) {
          const prevArr = prev.byWidgetId.get(key);
          if (!prevArr || prevArr.length !== arr.length || arr.some((f, i) => f !== prevArr[i])) {
            widgetUnchanged = false;
            break;
          }
        }
      }
      if (widgetUnchanged) {
        lastBaseFiltersInput = filters;
        return prev;
      }
    }
  }

  const result: BasePartitionedFilters = { page, byWidgetId };
  lastBaseFiltersInput = filters;
  lastBasePartitionResult = result;
  return result;
};

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
    state.filters.find(
      (f) => f.scope === 'cross-filter' && f.sourceWidgetId === widgetId && f.pageId === pageId,
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
    const filters = state.filters;
    if (filters === lastInput && lastResult !== undefined) {
      return lastResult;
    }
    const filtered = filters.filter(
      (f) => f.scope === 'cross-filter' && f.sourceWidgetId !== widgetId && f.pageId === pageId,
    );
    if (
      lastResult !== undefined &&
      filtered.length === lastResult.length &&
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
