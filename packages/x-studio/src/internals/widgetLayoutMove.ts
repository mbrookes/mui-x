import { GRID_COLS, MIN_SPAN } from '@mui/x-studio-schema';

export type WidgetMoveDirection = 'up' | 'down' | 'left' | 'right';

// Maximum widgets a single row can hold, derived from the same shared grid
// constants the mouse-driven layout path uses (see
// `StudioController.duplicateWidget`'s `maxPerRow = Math.floor(GRID_COLS /
// MIN_SPAN_COLS)`): GRID_COLS / MIN_SPAN (24 / 6 = 4). Kept in lock-step with
// that computation — not a hard-coded literal — so a row can never end up
// denser than the grid can give each widget its minimum column span.
const MAX_PER_ROW = Math.floor(GRID_COLS / MIN_SPAN);

/**
 * Computes a new `widgetRows` layout with `widgetId` moved one step in the given
 * direction. This is the keyboard-accessible equivalent of the canvas
 * drag-and-drop reorder (which is pointer-only).
 *
 * Semantics:
 * - `left` / `right`: swap with the adjacent widget in the same row.
 * - `up` / `down`: move the widget into the adjacent row (appended), or into a
 *   new row when it is already in the first/last row. Empty rows left behind are
 *   removed. When the adjacent row already holds `MAX_PER_ROW` widgets, the
 *   widget is placed into a brand-new row between the two rather than appended,
 *   mirroring the `MAX_PER_ROW` invariant `duplicateWidget`'s row-splice
 *   geometry already enforces for the mouse-driven path — otherwise a
 *   keyboard-only move could produce a row denser than any pointer-driven edit
 *   allows.
 *
 * Returns the new layout, or `null` when the move is a no-op (e.g. the widget is
 * already at the edge), so callers can both skip pointless commits and derive a
 * "disabled" state for the corresponding control.
 */
export function moveWidgetInLayout(
  rows: string[][],
  widgetId: string,
  direction: WidgetMoveDirection,
): string[][] | null {
  let rowIndex = -1;
  let colIndex = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const j = rows[i].indexOf(widgetId);
    if (j !== -1) {
      rowIndex = i;
      colIndex = j;
      break;
    }
  }
  if (rowIndex === -1) {
    return null;
  }

  const next = rows.map((row) => [...row]);
  const row = next[rowIndex];

  if (direction === 'left') {
    if (colIndex === 0) {
      return null;
    }
    [row[colIndex - 1], row[colIndex]] = [row[colIndex], row[colIndex - 1]];
    return next;
  }

  if (direction === 'right') {
    if (colIndex === row.length - 1) {
      return null;
    }
    [row[colIndex + 1], row[colIndex]] = [row[colIndex], row[colIndex + 1]];
    return next;
  }

  const aloneInRow = row.length === 1;
  if (direction === 'up') {
    if (rowIndex === 0 && aloneInRow) {
      return null;
    }
    // A lone widget "moving up" past a full row would just be re-inserted into a
    // new row in the exact same slot it started in — a no-op in content, not just
    // in effect. Report it as the disabled/no-op case, matching every other edge.
    if (aloneInRow && rowIndex > 0 && next[rowIndex - 1].length >= MAX_PER_ROW) {
      return null;
    }
    row.splice(colIndex, 1);
    if (rowIndex === 0) {
      next.unshift([widgetId]);
    } else if (next[rowIndex - 1].length < MAX_PER_ROW) {
      next[rowIndex - 1].push(widgetId);
    } else {
      // The row above is already at MAX_PER_ROW — insert a new row in between
      // instead of overflowing it (mirrors duplicateWidget's "new row below when
      // full" fallback).
      next.splice(rowIndex, 0, [widgetId]);
    }
  } else {
    // down
    if (rowIndex === rows.length - 1 && aloneInRow) {
      return null;
    }
    // Same no-op case as 'up' above, mirrored for the row below.
    if (aloneInRow && rowIndex < rows.length - 1 && next[rowIndex + 1].length >= MAX_PER_ROW) {
      return null;
    }
    row.splice(colIndex, 1);
    if (rowIndex === rows.length - 1) {
      next.push([widgetId]);
    } else if (next[rowIndex + 1].length < MAX_PER_ROW) {
      next[rowIndex + 1].push(widgetId);
    } else {
      // The row below is already at MAX_PER_ROW — insert a new row in between
      // instead of overflowing it.
      next.splice(rowIndex + 1, 0, [widgetId]);
    }
  }

  return next.filter((r) => r.length > 0);
}
