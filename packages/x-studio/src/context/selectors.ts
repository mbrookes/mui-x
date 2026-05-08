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
    state.filters.find(
      (f) => f.scope === 'interactive' && f.sourceWidgetId === widgetId,
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
