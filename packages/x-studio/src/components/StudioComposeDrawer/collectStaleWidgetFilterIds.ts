import { getReachableSourceIds } from '../../internals/dataSourceGraph';
import type { StudioFilterState, StudioRelationship } from '../../models';

/**
 * Identify the widget-scoped filters that no longer resolve after a widget
 * switches its data source to `newSourceId`.
 *
 * A widget-scoped filter is applied purely by `widgetId` (`internals/filterScoping.ts`),
 * with no check that its field still exists on the widget's current source. So a filter
 * whose field belongs to the OLD source (or to a source no longer reachable from the new
 * one) stays active after a source switch — and because the date `between`/`gte` branches
 * of `internals/filterUtils.ts` return `false` when the field is absent from a row, that
 * stale filter silently excludes EVERY row, blanking the widget (a KPI shows 0, a Grid
 * shows no rows) with no visible indication why.
 *
 * The setup panels are the only place with the field-catalog + reachability context needed
 * to tell which filters no longer resolve, so they compute the stale ids here and fold the
 * removal into the SAME `updateWidget` commit as the source switch (via its
 * `removeFilterIds` option) — keeping the whole gesture a single undo step. This mirrors
 * `GridSetupPanel`'s `clearFieldBoundGridConfig`, which clears field-bound config keys for
 * the identical "old field ids no longer resolve against the new source" reason.
 *
 * A field resolves when it belongs to a source reachable from `newSourceId` (the new source
 * itself plus its many-to-one related sources). When `newSourceId` is `undefined` (the
 * source was cleared entirely) nothing is reachable, so every widget-scoped filter is stale.
 *
 * @param filters      All filters in the doc (`selectFilters`).
 * @param widgetId     The widget being re-sourced.
 * @param newSourceId  The source the widget is switching to (`undefined` = cleared).
 * @param fieldCatalog Every known field with its owning `sourceId` (`buildFieldCatalog`).
 * @param relationships The declared relationships (for reachability).
 * @returns The ids of widget-scoped filters that no longer resolve and should be removed.
 */
export function collectStaleWidgetFilterIds(
  filters: StudioFilterState[] | undefined,
  widgetId: string,
  newSourceId: string | undefined,
  fieldCatalog: readonly { id: string; sourceId: string }[],
  relationships: StudioRelationship[],
): string[] {
  const reachableSourceIds = newSourceId
    ? getReachableSourceIds(newSourceId, relationships)
    : new Set<string>();
  // `${sourceId}/${fieldId}` for every field on a reachable source — the set of field
  // references that still resolve against the new source.
  const resolvableFieldKeys = new Set(
    fieldCatalog
      .filter((entry) => reachableSourceIds.has(entry.sourceId))
      .map((entry) => `${entry.sourceId}/${entry.id}`),
  );
  return (filters ?? [])
    .filter((f) => f.scope.kind === 'widget' && f.scope.widgetId === widgetId && f.field !== '')
    .filter((f) => {
      // A filter without an explicit `filterSourceId` targets the widget's own (now new)
      // source, so resolve it against `newSourceId`; a cross-source filter keeps its
      // declared `filterSourceId`.
      const effectiveSourceId = f.filterSourceId ?? newSourceId ?? '';
      return !resolvableFieldKeys.has(`${effectiveSourceId}/${f.field}`);
    })
    .map((f) => f.id);
}
