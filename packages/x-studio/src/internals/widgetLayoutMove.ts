export type WidgetMoveDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Computes a new `widgetRows` layout with `widgetId` moved one step in the given
 * direction. This is the keyboard-accessible equivalent of the canvas
 * drag-and-drop reorder (which is pointer-only).
 *
 * Semantics:
 * - `left` / `right`: swap with the adjacent widget in the same row.
 * - `up` / `down`: move the widget into the adjacent row (appended), or into a
 *   new row when it is already in the first/last row. Empty rows left behind are
 *   removed.
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
    row.splice(colIndex, 1);
    if (rowIndex === 0) {
      next.unshift([widgetId]);
    } else {
      next[rowIndex - 1].push(widgetId);
    }
  } else {
    // down
    if (rowIndex === rows.length - 1 && aloneInRow) {
      return null;
    }
    row.splice(colIndex, 1);
    if (rowIndex === rows.length - 1) {
      next.push([widgetId]);
    } else {
      next[rowIndex + 1].push(widgetId);
    }
  }

  return next.filter((r) => r.length > 0);
}
