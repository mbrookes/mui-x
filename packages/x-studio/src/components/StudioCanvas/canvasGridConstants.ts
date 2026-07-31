import * as React from 'react';
import { GRID_COLS, MIN_SPAN } from '@mui/x-studio-schema';
import { DRAG_TYPE_CANVAS_WIDGET, type StudioDragItem } from './studioWidgetDndTypes';
import { getDraggingWidgetId, type StudioDragScope } from './studioDragSession';

// `GRID_COLS`/`MIN_SPAN` are owned by `@mui/x-studio-schema` (the shared reducer
// that clamps AI-driven resizes must agree with what the canvas renders). Import
// and re-export them here so existing `./canvasGridConstants` importers are
// unaffected, but the value is defined in exactly one place.
export { GRID_COLS, MIN_SPAN };

/**
 * Maximum number of widgets a single row may hold: `floor(GRID_COLS / MIN_SPAN)` = 4.
 *
 * Derived, never a literal, so it can't drift from the grid it protects. A fifth widget in
 * a row is not merely cramped — it is UNRESIZABLE. Every widget's default span drops to
 * `round(24 / 5) = 5`, below `MIN_SPAN`, so every divider in the row computes
 * `minLeft = 6 > maxLeft = 4`; `RowResizeHandle`'s clamp then collapses to a constant and
 * every arrow key and pointer drag on that handle becomes a permanent no-op, with an
 * invalid `aria-valuemin > aria-valuemax` to match.
 *
 * This is THE definition for the canvas — the mouse drop path, which users actually reach it
 * by, previously enforced nothing at all.
 *
 * It is NOT the only site (R6 F8 — this comment used to say `internals/widgetLayoutMove.ts`
 * (keyboard move) and `StudioController.duplicateWidget` "each USED TO re-derive their own
 * copy"; both still do, as `Math.floor(GRID_COLS / MIN_SPAN)` and
 * `Math.floor(GRID_COLS / MIN_SPAN_COLS)` respectively). There is no functional drift and
 * there cannot be: all three derive from the same `GRID_COLS`/`MIN_SPAN` exported by
 * `@mui/x-studio-schema`, never from a literal. The two non-canvas sites re-derive rather
 * than import this module because it pulls in React and the drag-session types they have no
 * reason to depend on. Keep every site derived; a fourth must derive from the schema
 * constants too.
 */
export const MAX_PER_ROW = Math.floor(GRID_COLS / MIN_SPAN);

/**
 * Returns true when dropping `item` into row `rowIndex` would push it past
 * {@link MAX_PER_ROW}.
 *
 * A widget already in the target row is a REORDER, not an addition, so it never overflows
 * the row and must stay droppable — otherwise reordering inside a full row would become
 * impossible. Compose drags (a brand-new widget) and moves from another row/page always
 * count as additions.
 */
export function wouldOverflowRow(
  rowIndex: number,
  widgetRowsRef: React.RefObject<string[][] | undefined>,
  item: StudioDragItem,
): boolean {
  const row = widgetRowsRef.current?.[rowIndex];
  if (!row) {
    return false;
  }
  if (item.type === DRAG_TYPE_CANVAS_WIDGET && row.includes(item.widgetId)) {
    return false;
  }
  return row.length >= MAX_PER_ROW;
}

/**
 * Returns true when a horizontal insertion point at `rowIndex` would produce no
 * change: the dragged widget is the sole occupant of its row, so dropping it
 * directly above or below that row just recreates the same layout after cleanup.
 */
export function isRedundantHorizontalDrop(
  rowIndex: number,
  widgetRowsRef: React.RefObject<string[][] | undefined>,
  scope: StudioDragScope | null | undefined,
): boolean {
  const draggingId = getDraggingWidgetId(scope);
  if (!draggingId) {
    return false;
  }
  const rows = widgetRowsRef.current;
  if (!rows) {
    return false;
  }
  for (let r = 0; r < rows.length; r += 1) {
    if (rows[r].includes(draggingId)) {
      // Only a no-op when the widget is alone in its row
      if (rows[r].length === 1) {
        return rowIndex === r || rowIndex === r + 1;
      }
      return false;
    }
  }
  return false;
}

/**
 * Returns true when the given grid position (rowIndex, colIndex) is immediately
 * adjacent (left or right) to the widget currently being dragged.
 * Used by InsertionPoint and WidgetGap to opt out of activating as drop targets
 * when the dragged widget's own flanking gaps are hovered (BL-112).
 *
 * `scope` is the Studio instance the caller belongs to — see `studioDragSession.ts` for
 * why "which widget is being dragged" cannot be a document-level flag.
 */
export function isAdjacentToDraggingWidget(
  rowIndex: number,
  colIndex: number,
  widgetRowsRef: React.RefObject<string[][] | undefined>,
  scope: StudioDragScope | null | undefined,
): boolean {
  const draggingId = getDraggingWidgetId(scope);
  if (!draggingId) {
    return false;
  }
  const rows = widgetRowsRef.current;
  if (!rows) {
    return false;
  }
  // Build a position index for O(1) lookup instead of indexOf in loop
  const positionMap = new Map<string, [number, number]>();
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < rows[r].length; c += 1) {
      positionMap.set(rows[r][c], [r, c]);
    }
  }
  const pos = positionMap.get(draggingId);
  if (!pos) {
    return false;
  }
  const [dRow, dCol] = pos;
  // Adjacent left: colIndex === dCol; adjacent right: colIndex === dCol + 1
  return dRow === rowIndex && (colIndex === dCol || colIndex === dCol + 1);
}
