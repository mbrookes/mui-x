import type { GridSortModel } from '@mui/x-data-grid-premium';

/**
 * Per-widget record of the sort model a **view-mode** grid is currently rendering with.
 *
 * Why this exists — an edit-mode header click is committed to `gridSortField` /
 * `gridSortDirection` (the authored doc), so any consumer can read it back. A VIEW-mode
 * header click deliberately is not: `doc` is the persisted, undoable partition and a
 * read-only viewer must not rewrite it, so the viewer's sort lives in `StudioGridWidget`'s
 * local `viewSortModel` state and nowhere else (see `handleSortModelChange`).
 *
 * That left the CSV export — dispatched from `StudioWidgetCard` via `widgetExport.ts`, one
 * level ABOVE the grid — with no way to see the order the user is actually looking at, so a
 * viewer who sorted by Revenue desc and hit Export got the rows back in raw source order.
 * The natural channel would be a `sortModelRef` prop alongside the existing
 * `exportRef`/`chartContainerRef`, but that prop bag is declared in
 * `internals/widgetRegistry.ts`; this module-scoped registry is the equivalent-lifetime
 * side channel (same shape as the module-singleton `studioRequestCache`), keeping the
 * export and the screen in agreement without widening the widget prop contract.
 *
 * Lifetime: written on every view-mode sort change and cleared when the grid unmounts or
 * leaves view mode, so a stale entry can never outlive the grid that produced it. Entries
 * are keyed by widget id; two `<Studio>` instances rendering the SAME widget id in view mode
 * with different viewer sorts would share one entry — an accepted limitation, since the same
 * ambiguity already applies to every other widget-id-keyed module cache in the package.
 */
const viewSortModelByWidgetId = new Map<string, GridSortModel>();

/** Record the sort model a view-mode grid is currently rendering with. */
export function setGridViewSortModel(widgetId: string, sortModel: GridSortModel): void {
  viewSortModelByWidgetId.set(widgetId, sortModel);
}

/** Forget a widget's view-mode sort (unmount, or a switch back to edit mode). */
export function clearGridViewSortModel(widgetId: string): void {
  viewSortModelByWidgetId.delete(widgetId);
}

/**
 * The sort model a view-mode grid is currently rendering with, or `undefined` when the grid
 * is not mounted in view mode or the viewer has not sorted it (in which case the caller must
 * fall back to the authored `gridSortField` / `gridSortDirection`, exactly as the grid does).
 */
export function getGridViewSortModel(widgetId: string): GridSortModel | undefined {
  return viewSortModelByWidgetId.get(widgetId);
}
