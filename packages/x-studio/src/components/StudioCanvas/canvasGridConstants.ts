import * as React from 'react';

/** Total column count for the widget resize grid. */
export const GRID_COLS = 24;

/** Minimum column span any widget can be resized to (~12.5% of full width in a 2-widget row). */
export const MIN_SPAN = Math.round(GRID_COLS / 4);

/**
 * Returns true when a horizontal insertion point at `rowIndex` would produce no
 * change: the dragged widget is the sole occupant of its row, so dropping it
 * directly above or below that row just recreates the same layout after cleanup.
 */
export function isRedundantHorizontalDrop(
  rowIndex: number,
  widgetRowsRef: React.RefObject<string[][] | undefined>,
): boolean {
  const draggingId = document.body.dataset.studioDraggingWidgetId;
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
 */
export function isAdjacentToDraggingWidget(
  rowIndex: number,
  colIndex: number,
  widgetRowsRef: React.RefObject<string[][] | undefined>,
): boolean {
  const draggingId = document.body.dataset.studioDraggingWidgetId;
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
