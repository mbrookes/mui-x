/**
 * Per-Studio-instance drag session state.
 *
 * Which widget is currently being dragged is consumed by the canvas's drop-target logic
 * (`isAdjacentToDraggingWidget`, `isRedundantHorizontalDrop`) to disable the gaps that
 * flank the drag source, because dropping a widget back where it already is is a no-op the
 * user shouldn't be offered.
 *
 * That id used to live in `document.body.dataset.studioDraggingWidgetId` — a DOCUMENT-level
 * singleton, which is wrong as soon as a host renders two Studios on one page. Two
 * `<StudioDashboard config={sameConfig} />` instances share widget ids, so dragging `w1` in
 * instance A wrote a document-wide "w1 is being dragged" flag that instance B's canvas read
 * against ITS OWN rows and used to disable the gaps flanking B's untouched copy of `w1` —
 * an instance the user was not interacting with at all.
 *
 * The session is therefore keyed by the Studio instance's `StudioController`, the object
 * that already scopes everything else per instance and that every participant (widget cards
 * via `useStudioController()`, the canvas's own drop targets) can reach. A `WeakMap` keeps
 * the entry collectable with the controller, so an unmounted Studio leaves nothing behind.
 *
 * The `document.body` dataset flag is still written by `useStudioWidgetCardDrag` as a
 * purely presentational hook for host CSS; no logic reads it any more.
 */

/** Anything object-identity-scoped per Studio instance — in practice the `StudioController`. */
export type StudioDragScope = object;

const draggingWidgetIdByScope = new WeakMap<StudioDragScope, string>();

/** Record that `widgetId` is being dragged within `scope`'s Studio instance. */
export function setDraggingWidgetId(scope: StudioDragScope, widgetId: string): void {
  draggingWidgetIdByScope.set(scope, widgetId);
}

/** Clear `scope`'s drag session (drop, cancel, or teardown mid-drag). */
export function clearDraggingWidgetId(scope: StudioDragScope): void {
  draggingWidgetIdByScope.delete(scope);
}

/** The widget id being dragged within `scope`'s Studio instance, or `undefined`. */
export function getDraggingWidgetId(scope: StudioDragScope | null | undefined): string | undefined {
  if (!scope) {
    return undefined;
  }
  return draggingWidgetIdByScope.get(scope);
}
