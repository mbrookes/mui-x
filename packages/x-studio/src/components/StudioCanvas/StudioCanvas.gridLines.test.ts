import { describe, expect, it } from 'vitest';

/**
 * Unit tests for the BL-109/BL-156 grid-line positioning formula.
 *
 * The formula: for column boundary `col` falling inside widget `j`,
 *   left = (j + 1) * 8 + (col / GRID_COLS) * (containerWidth - (numWidgets + 1) * 8)
 *
 * Where:
 *   - Each gap/insertion-point is 8 px
 *   - Container has one 8px leading IP plus one 8px trailing gap per widget
 *   - j = last widget index whose cumulative start span ≤ col
 */

const GRID_COLS = 24;

/** Mirrors the cumSpans computation in StudioCanvas.tsx */
function buildCumSpans(
  row: string[],
  spans: Record<string, number>,
  liveDrag?: { leftId: string; rightId: string; leftSpanLive: number; totalSpan: number },
): number[] {
  const flexGrowDefault = Math.round(GRID_COLS / row.length);
  let acc = 0;
  return row.map((wId) => {
    const start = acc;
    if (liveDrag && wId === liveDrag.leftId) {
      acc += liveDrag.leftSpanLive;
    } else if (liveDrag && wId === liveDrag.rightId) {
      acc += liveDrag.totalSpan - liveDrag.leftSpanLive;
    } else {
      acc += spans[wId] ?? flexGrowDefault;
    }
    return start;
  });
}

/** Mirrors the j-finder loop in StudioCanvas.tsx */
function findWidgetIndex(col: number, cumSpans: number[]): number {
  let j = 0;
  for (let k = 1; k < cumSpans.length; k++) {
    if (cumSpans[k] <= col) {
      j = k;
    }
  }
  return j;
}

/** Returns the computed `left` CSS calc string for a given column on a given row. */
function gridLineLeft(
  col: number,
  row: string[],
  spans: Record<string, number>,
  liveDrag?: { leftId: string; rightId: string; leftSpanLive: number; totalSpan: number },
): string {
  const cumSpans = buildCumSpans(row, spans, liveDrag);
  const j = findWidgetIndex(col, cumSpans);
  return `calc(${(j + 1) * 8}px + ${col / GRID_COLS} * (100% - ${(row.length + 1) * 8}px))`;
}

describe('StudioCanvas grid-line formula (BL-109)', () => {
  describe('single-widget row', () => {
    const row = ['w0'];
    const spans = { w0: 24 };

    it('column 1 offset is 8px (single leading IP)', () => {
      expect(gridLineLeft(1, row, spans)).toBe('calc(8px + 0.041666666666666664 * (100% - 16px))');
    });

    it('column 12 is at 50% of flex area plus one 8px IP', () => {
      const left = gridLineLeft(12, row, spans);
      expect(left).toBe('calc(8px + 0.5 * (100% - 16px))');
    });
  });

  describe('two-widget row (equal spans 12+12)', () => {
    const row = ['w0', 'w1'];
    const spans = { w0: 12, w1: 12 };

    it('column 1 is inside widget 0 → j=0 → 8px offset', () => {
      expect(findWidgetIndex(1, buildCumSpans(row, spans))).toBe(0);
    });

    it('column 12 is at widget boundary — still inside widget 0 (cumSpans[1]=12, col=12 → j=1)', () => {
      // cumSpans = [0, 12]; col=12 → cumSpans[1]=12 <= 12 → j=1
      expect(findWidgetIndex(12, buildCumSpans(row, spans))).toBe(1);
    });

    it('column 13 is inside widget 1 → j=1 → 16px offset', () => {
      expect(findWidgetIndex(13, buildCumSpans(row, spans))).toBe(1);
      const left = gridLineLeft(13, row, spans);
      expect(left).toBe('calc(16px + 0.5416666666666666 * (100% - 24px))');
    });

    it('column 6 is inside widget 0 → j=0 → 8px offset', () => {
      expect(findWidgetIndex(6, buildCumSpans(row, spans))).toBe(0);
    });

    it('column 18 is inside widget 1 → j=1 → 16px offset', () => {
      expect(findWidgetIndex(18, buildCumSpans(row, spans))).toBe(1);
    });
  });

  describe('four-widget row (equal spans 6+6+6+6)', () => {
    const row = ['w0', 'w1', 'w2', 'w3'];
    const spans = { w0: 6, w1: 6, w2: 6, w3: 6 };

    it('builds cumSpans [0, 6, 12, 18]', () => {
      expect(buildCumSpans(row, spans)).toEqual([0, 6, 12, 18]);
    });

    it('col 5 → j=0 → 8px offset (inside first widget)', () => {
      expect(findWidgetIndex(5, [0, 6, 12, 18])).toBe(0);
    });

    it('col 6 → j=1 → 16px offset (boundary, second widget starts)', () => {
      expect(findWidgetIndex(6, [0, 6, 12, 18])).toBe(1);
    });

    it('col 12 → j=2 → 24px offset (third widget)', () => {
      expect(findWidgetIndex(12, [0, 6, 12, 18])).toBe(2);
    });

    it('col 18 → j=3 → 32px offset (fourth widget)', () => {
      expect(findWidgetIndex(18, [0, 6, 12, 18])).toBe(3);
    });

    it('col 23 → j=3 → 32px offset (last column, inside fourth widget)', () => {
      expect(findWidgetIndex(23, [0, 6, 12, 18])).toBe(3);
    });
  });

  describe('live drag: two widgets 8+16 → being dragged to 12+12', () => {
    const row = ['w0', 'w1'];
    const spans = { w0: 8, w1: 16 };
    const liveDrag = { leftId: 'w0', rightId: 'w1', leftSpanLive: 12, totalSpan: 24 };

    it('cumSpans reflect live drag spans [0, 12]', () => {
      expect(buildCumSpans(row, spans, liveDrag)).toEqual([0, 12]);
    });

    it('col 11 → j=0 (inside left widget during drag)', () => {
      expect(findWidgetIndex(11, [0, 12])).toBe(0);
    });

    it('col 12 → j=1 (boundary moves to live position)', () => {
      expect(findWidgetIndex(12, [0, 12])).toBe(1);
    });
  });

  describe('unequal three-widget row (spans 6+12+6)', () => {
    const row = ['w0', 'w1', 'w2'];
    const spans = { w0: 6, w1: 12, w2: 6 };

    it('builds cumSpans [0, 6, 18]', () => {
      expect(buildCumSpans(row, spans)).toEqual([0, 6, 18]);
    });

    it('col 5 → j=0 → 8px leading offset', () => {
      expect(findWidgetIndex(5, [0, 6, 18])).toBe(0);
    });

    it('col 6 → j=1 → 16px leading offset', () => {
      expect(findWidgetIndex(6, [0, 6, 18])).toBe(1);
    });

    it('col 17 → j=1 → 16px leading offset (still inside middle widget)', () => {
      expect(findWidgetIndex(17, [0, 6, 18])).toBe(1);
    });

    it('col 18 → j=2 → 24px leading offset (third widget starts)', () => {
      expect(findWidgetIndex(18, [0, 6, 18])).toBe(2);
    });
  });
});
