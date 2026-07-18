import { describe, it, expect } from 'vitest';
import { moveWidgetInLayout } from './widgetLayoutMove';

describe('moveWidgetInLayout', () => {
  it('returns null when the widget is not present', () => {
    expect(moveWidgetInLayout([['a', 'b']], 'z', 'left')).toBe(null);
  });

  it('swaps with the left neighbour', () => {
    expect(moveWidgetInLayout([['a', 'b', 'c']], 'b', 'left')).toEqual([['b', 'a', 'c']]);
  });

  it('swaps with the right neighbour', () => {
    expect(moveWidgetInLayout([['a', 'b', 'c']], 'b', 'right')).toEqual([['a', 'c', 'b']]);
  });

  it('returns null moving left from the first column', () => {
    expect(moveWidgetInLayout([['a', 'b']], 'a', 'left')).toBe(null);
  });

  it('returns null moving right from the last column', () => {
    expect(moveWidgetInLayout([['a', 'b']], 'b', 'right')).toBe(null);
  });

  it('moves up into the previous row and drops the emptied row', () => {
    expect(moveWidgetInLayout([['a'], ['b']], 'b', 'up')).toEqual([['a', 'b']]);
  });

  it('moves down into the next row and drops the emptied row', () => {
    expect(moveWidgetInLayout([['a'], ['b']], 'a', 'down')).toEqual([['b', 'a']]);
  });

  it('moves up into a new top row when in the first (multi-widget) row', () => {
    expect(moveWidgetInLayout([['a', 'b']], 'b', 'up')).toEqual([['b'], ['a']]);
  });

  it('moves down into a new bottom row when in the last (multi-widget) row', () => {
    expect(moveWidgetInLayout([['a', 'b']], 'a', 'down')).toEqual([['b'], ['a']]);
  });

  it('returns null moving up when alone in the first row', () => {
    expect(moveWidgetInLayout([['a'], ['b']], 'a', 'up')).toBe(null);
  });

  it('returns null moving down when alone in the last row', () => {
    expect(moveWidgetInLayout([['a'], ['b']], 'b', 'down')).toBe(null);
  });

  it('does not mutate the input layout', () => {
    const rows = [['a', 'b']];
    moveWidgetInLayout(rows, 'a', 'right');
    expect(rows).toEqual([['a', 'b']]);
  });

  // MAX_PER_ROW (GRID_COLS / MIN_SPAN = 24 / 6 = 4) mirrors the invariant
  // `StudioController.duplicateWidget` enforces for its own row-splice geometry
  // (see `StudioController.test.ts`'s "places the copy in a new row below when
  // the source row is full (4 widgets)"). Keyboard moves must respect the same
  // cap so a row can never end up denser than a mouse-driven layout edit allows.
  describe('MAX_PER_ROW invariant', () => {
    it('merges into the row above when it has fewer than MAX_PER_ROW widgets', () => {
      expect(moveWidgetInLayout([['t1', 't2', 't3'], ['w']], 'w', 'up')).toEqual([
        ['t1', 't2', 't3', 'w'],
      ]);
    });

    it('merges into the row below when it has fewer than MAX_PER_ROW widgets', () => {
      expect(moveWidgetInLayout([['w'], ['t1', 't2', 't3']], 'w', 'down')).toEqual([
        ['t1', 't2', 't3', 'w'],
      ]);
    });

    it('inserts a new row instead of overflowing a full row above (up, not alone)', () => {
      expect(
        moveWidgetInLayout(
          [
            ['t1', 't2', 't3', 't4'],
            ['w', 'x'],
          ],
          'w',
          'up',
        ),
      ).toEqual([['t1', 't2', 't3', 't4'], ['w'], ['x']]);
    });

    it('inserts a new row instead of overflowing a full row below (down, not alone)', () => {
      expect(
        moveWidgetInLayout(
          [
            ['w', 'x'],
            ['t1', 't2', 't3', 't4'],
          ],
          'w',
          'down',
        ),
      ).toEqual([['x'], ['w'], ['t1', 't2', 't3', 't4']]);
    });

    it('returns null moving up when alone in its row and the row above is full', () => {
      expect(moveWidgetInLayout([['t1', 't2', 't3', 't4'], ['w']], 'w', 'up')).toBe(null);
    });

    it('returns null moving down when alone in its row and the row below is full', () => {
      expect(moveWidgetInLayout([['w'], ['t1', 't2', 't3', 't4']], 'w', 'down')).toBe(null);
    });

    it('never produces a row with more than MAX_PER_ROW widgets across any move', () => {
      const rows = [
        ['t1', 't2', 't3', 't4'],
        ['w', 'x'],
      ];
      const MAX_PER_ROW = 4;
      (['up', 'down', 'left', 'right'] as const).forEach((direction) => {
        const next = moveWidgetInLayout(rows, 'w', direction);
        if (next) {
          next.forEach((row) => expect(row.length).toBeLessThanOrEqual(MAX_PER_ROW));
        }
      });
    });
  });
});
