import { describe, expect, it } from 'vitest';
import { computeGridLineLefts, type LiveDragState } from './StudioCanvas';

/**
 * Unit tests for the BL-109/BL-156 grid-line positioning formula.
 *
 * These now call the real `computeGridLineLefts` exported from
 * `StudioCanvas.tsx` (extracted verbatim from the column-divider overlay
 * render, no behavior change) instead of a hand-copied re-implementation.
 *
 * The overlay is only ever rendered by the component while a resize drag is
 * in progress (`liveDrag &&` guard in `StudioCanvas.tsx`), so every case below
 * supplies a `LiveDragState`. Where the original test wanted to check the
 * "static" positions of a row that isn't actually being dragged, we pass a
 * no-op drag — `leftSpanLive`/`totalSpan` reproducing the widget's stored
 * span exactly, and a `rightId` that isn't in the row — so the drag has no
 * effect on `cumSpans` and the assertions match the pre-drag geometry.
 * Driving this via a real pointer-drag simulation (`WidgetGap`) would be far
 * more setup for the same coverage of the pure positioning math.
 *
 * The formula: for column boundary `col` falling inside widget `j`,
 *   left = (j + 1) * 8 + (col / GRID_COLS) * (containerWidth - (numWidgets + 1) * 8)
 */

describe('computeGridLineLefts (BL-109)', () => {
  describe('single-widget row', () => {
    const row = ['w0'];
    const spans = { w0: 24 };
    // No-op drag: w0 keeps its stored span of 24; there's no second widget.
    const noOpDrag: LiveDragState = {
      leftId: 'w0',
      rightId: '__no_widget__',
      leftSpanLive: 24,
      totalSpan: 24,
    };

    it('column 1 offset is 8px (single leading IP)', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[0]).toBe('calc(8px + 0.041666666666666664 * (100% - 16px))');
    });

    it('column 12 is at 50% of flex area plus one 8px IP', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[11]).toBe('calc(8px + 0.5 * (100% - 16px))');
    });
  });

  describe('two-widget row (equal spans 12+12)', () => {
    const row = ['w0', 'w1'];
    const spans = { w0: 12, w1: 12 };
    // No-op drag: leftSpanLive/totalSpan reproduce the stored 12+12 split.
    const noOpDrag: LiveDragState = {
      leftId: 'w0',
      rightId: 'w1',
      leftSpanLive: 12,
      totalSpan: 24,
    };

    it('column 1 is inside widget 0 → 8px offset', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[0]).toBe('calc(8px + 0.041666666666666664 * (100% - 24px))');
    });

    it('column 12 is at the widget boundary — treated as inside widget 1 → 16px offset', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[11]).toBe('calc(16px + 0.5 * (100% - 24px))');
    });

    it('column 13 is inside widget 1 → 16px offset', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[12]).toBe('calc(16px + 0.5416666666666666 * (100% - 24px))');
    });

    it('column 6 is inside widget 0 → 8px offset', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[5]).toBe('calc(8px + 0.25 * (100% - 24px))');
    });

    it('column 18 is inside widget 1 → 16px offset', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[17]).toBe('calc(16px + 0.75 * (100% - 24px))');
    });
  });

  describe('four-widget row (equal spans 6+6+6+6)', () => {
    const row = ['w0', 'w1', 'w2', 'w3'];
    const spans = { w0: 6, w1: 6, w2: 6, w3: 6 };
    // No-op drag on w0 alone (rightId not present in the row).
    const noOpDrag: LiveDragState = {
      leftId: 'w0',
      rightId: '__no_widget__',
      leftSpanLive: 6,
      totalSpan: 6,
    };

    it('col 5 → 8px offset (inside first widget)', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[4]).toBe('calc(8px + 0.20833333333333334 * (100% - 40px))');
    });

    it('col 6 → 16px offset (boundary, second widget starts)', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[5]).toBe('calc(16px + 0.25 * (100% - 40px))');
    });

    it('col 12 → 24px offset (third widget)', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[11]).toBe('calc(24px + 0.5 * (100% - 40px))');
    });

    it('col 18 → 32px offset (fourth widget)', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[17]).toBe('calc(32px + 0.75 * (100% - 40px))');
    });

    it('col 23 → 32px offset (last column, inside fourth widget)', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[22]).toBe('calc(32px + 0.9583333333333334 * (100% - 40px))');
    });
  });

  describe('live drag: two widgets 8+16 being dragged to 12+12', () => {
    const row = ['w0', 'w1'];
    // Stored (pre-drag) spans — overridden for w0/w1 by the live drag values below.
    const spans = { w0: 8, w1: 16 };
    const liveDrag: LiveDragState = {
      leftId: 'w0',
      rightId: 'w1',
      leftSpanLive: 12,
      totalSpan: 24,
    };

    it('col 11 → inside left widget during drag → 8px offset', () => {
      const lefts = computeGridLineLefts(row, spans, liveDrag);
      expect(lefts[10]).toBe('calc(8px + 0.4583333333333333 * (100% - 24px))');
    });

    it('col 12 → boundary moves to the live drag position → 16px offset', () => {
      const lefts = computeGridLineLefts(row, spans, liveDrag);
      expect(lefts[11]).toBe('calc(16px + 0.5 * (100% - 24px))');
    });
  });

  describe('unequal three-widget row (spans 6+12+6)', () => {
    const row = ['w0', 'w1', 'w2'];
    const spans = { w0: 6, w1: 12, w2: 6 };
    // No-op drag on w0 alone (rightId not present in the row).
    const noOpDrag: LiveDragState = {
      leftId: 'w0',
      rightId: '__no_widget__',
      leftSpanLive: 6,
      totalSpan: 6,
    };

    it('col 5 → 8px leading offset', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[4]).toBe('calc(8px + 0.20833333333333334 * (100% - 32px))');
    });

    it('col 6 → 16px leading offset', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[5]).toBe('calc(16px + 0.25 * (100% - 32px))');
    });

    it('col 17 → 16px leading offset (still inside middle widget)', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[16]).toBe('calc(16px + 0.7083333333333334 * (100% - 32px))');
    });

    it('col 18 → 24px leading offset (third widget starts)', () => {
      const lefts = computeGridLineLefts(row, spans, noOpDrag);
      expect(lefts[17]).toBe('calc(24px + 0.75 * (100% - 32px))');
    });
  });

  it('returns exactly GRID_COLS - 1 (23) entries', () => {
    const lefts = computeGridLineLefts(
      ['w0'],
      { w0: 24 },
      { leftId: 'w0', rightId: '__none__', leftSpanLive: 24, totalSpan: 24 },
    );
    expect(lefts).toHaveLength(23);
  });
});

/**
 * `widgetColSpans` is a doc-authored record keyed by widget id. A bare `widgetColSpans?.[id]`
 * on an id named after an `Object.prototype` member resolves the inherited function — truthy,
 * so `?? flexGrowDefault` never fires — and the accumulator poisons every subsequent boundary
 * into `NaN`. Guarded via `utils/safeLookup`'s `lookup`.
 */
describe('computeGridLineLefts — prototype-chain widget ids', () => {
  it('treats an Object.prototype-named widget id as having no stored span', () => {
    // `constructor` has no OWN entry in `widgetColSpans`, so it must fall back to the
    // even split (24 / 2 = 12) — putting the second widget's boundary at column 12.
    const lefts = computeGridLineLefts(
      ['constructor', 'w1'],
      { w1: 12 },
      { leftId: '__none__', rightId: '__none2__', leftSpanLive: 0, totalSpan: 0 },
    );
    expect(lefts).toHaveLength(23);
    // Column 11 is still inside the first widget (one 8px leading gap)…
    expect(lefts[10].startsWith('calc(8px + ')).toBe(true);
    // …column 12 starts the second widget (two 8px leading gaps). With the unguarded
    // lookup the accumulator became a string, every `cumSpans[k] <= col` comparison went
    // NaN-false, and every boundary stayed pinned to the first widget's 8px offset.
    expect(lefts[11].startsWith('calc(16px + ')).toBe(true);
  });
});
