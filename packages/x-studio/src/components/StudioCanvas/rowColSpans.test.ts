import { describe, expect, it } from 'vitest';
import { GRID_COLS, MIN_SPAN } from '@mui/x-studio-schema';
import {
  defaultColSpan,
  resolveResizePair,
  resolveRowColSpans,
  storedColSpan,
} from './rowColSpans';

/**
 * Finding M2: a MISSING `page.widgetColSpans` entry meant four different things across the
 * layout code — `0` in the reducer's overflow sweep, `round(GRID_COLS / row.length)` in the
 * edit-mode flex-grow, the same default again in the resize-pair math, and `flex: 1` (auto,
 * not a percentage basis) in view mode. This module is the single meaning the canvas now
 * shares; these tests pin it down.
 */

describe('storedColSpan', () => {
  it('returns the explicit span when there is one', () => {
    expect(storedColSpan({ a: 16 }, 'a')).toBe(16);
  });

  it('returns null for a widget with no entry', () => {
    expect(storedColSpan({ a: 16 }, 'b')).toBe(null);
    expect(storedColSpan(undefined, 'a')).toBe(null);
  });

  it('treats an inherited Object.prototype-named key as "no entry"', () => {
    // A bare `spans['toString']` resolves the inherited function, which `??` never replaces.
    expect(storedColSpan({}, 'toString')).toBe(null);
    expect(storedColSpan({}, 'constructor')).toBe(null);
  });

  it('treats a non-finite or non-positive stored span as "no entry"', () => {
    expect(storedColSpan({ a: Number.NaN }, 'a')).toBe(null);
    expect(storedColSpan({ a: Number.POSITIVE_INFINITY }, 'a')).toBe(null);
    expect(storedColSpan({ a: 0 }, 'a')).toBe(null);
    expect(storedColSpan({ a: -6 }, 'a')).toBe(null);
  });
});

describe('defaultColSpan', () => {
  it('is an equal share of the row', () => {
    expect(defaultColSpan(1)).toBe(GRID_COLS);
    expect(defaultColSpan(2)).toBe(12);
    expect(defaultColSpan(3)).toBe(8);
    expect(defaultColSpan(4)).toBe(MIN_SPAN);
  });

  it('does not divide by zero for an empty row', () => {
    expect(defaultColSpan(0)).toBe(GRID_COLS);
  });
});

describe('resolveRowColSpans', () => {
  it('gives every unspanned widget an equal share — the pre-existing edit-mode default', () => {
    expect(resolveRowColSpans(['a', 'b'], undefined)).toEqual([12, 12]);
    expect(resolveRowColSpans(['a', 'b', 'c'], {})).toEqual([8, 8, 8]);
  });

  it('passes an explicitly spanned, in-budget row through untouched', () => {
    expect(resolveRowColSpans(['a', 'b'], { a: 16, b: 8 })).toEqual([16, 8]);
  });

  it('leaves an UNDER-budget row alone (a lone span-6 widget is a quarter-width widget)', () => {
    // Matches `enforceLayoutColSpans`, which only ever objects to a row summing OVER
    // `GRID_COLS`. Normalizing up would silently full-width every deliberately narrow row.
    expect(resolveRowColSpans(['a'], { a: 6 })).toEqual([6]);
    expect(resolveRowColSpans(['a', 'b'], { a: 6, b: 6 })).toEqual([6, 6]);
  });

  it('M2 repro A: scales an over-budget row back into GRID_COLS instead of overflowing', () => {
    // `{ a: 16, b: 8 }` plus an unspanned `c`: the reducer counts `c` as 0, so
    // `16 + 0 + 8 = 24` looks in budget and `enforceLayoutColSpans` never fires — but the
    // row actually wants `16 + 8 + 8 = 32`. Edit mode rendered three across while view mode
    // wrapped `c` onto its own line.
    const spans = resolveRowColSpans(['a', 'c', 'b'], { a: 16, b: 8 });
    expect(spans).toEqual([12, 6, 6]);
    expect(spans.reduce((acc, s) => acc + s, 0)).toBe(GRID_COLS);
  });

  it('never resolves a widget to zero width, however lopsided the row', () => {
    const spans = resolveRowColSpans(['a', 'b', 'c'], { a: 24, b: 24, c: 1 });
    expect(spans.every((s) => s >= 1)).toBe(true);
    expect(spans.reduce((acc, s) => acc + s, 0)).toBeLessThanOrEqual(GRID_COLS);
  });

  it('returns an empty list for an empty row', () => {
    expect(resolveRowColSpans([], { a: 6 })).toEqual([]);
  });
});

describe('resolveResizePair', () => {
  it('is a no-op for an ordinary, fully-spanned, in-budget row', () => {
    expect(resolveResizePair(['a', 'b'], { a: 16, b: 8 }, 0, MIN_SPAN, MIN_SPAN)).toEqual({
      leftSpan: 16,
      rightSpan: 8,
      totalSpan: 24,
    });
  });

  it('lets an all-unspanned row resize across the full grid', () => {
    expect(resolveResizePair(['a', 'b'], undefined, 0, MIN_SPAN, MIN_SPAN)).toEqual({
      leftSpan: 12,
      rightSpan: 12,
      totalSpan: GRID_COLS,
    });
  });

  it('M2 repro B: caps the pair total at what the row can still afford', () => {
    // Row `[a(16), c(unspanned), b(8)]`, resizing the a|c divider. The pair RENDERS as
    // 12 + 6 = 18 (see repro A), but `b` keeps its stored 8, so PROPOSING 18 would describe a
    // row summing to 26. The reducer would now shrink that back on commit
    // (`setAdjacentWidgetColSpans` routes through `applyBulkUpdate`), so the cap here is what
    // keeps the handle from advertising a range it cannot actually deliver.
    const pair = resolveResizePair(['a', 'c', 'b'], { a: 16, b: 8 }, 0, MIN_SPAN, MIN_SPAN);
    expect(pair.totalSpan).toBe(GRID_COLS - 8);
    expect(pair.leftSpan + pair.rightSpan + 8).toBeLessThanOrEqual(GRID_COLS);
    expect(pair.leftSpan).toBeGreaterThanOrEqual(MIN_SPAN);
    expect(pair.rightSpan).toBeGreaterThanOrEqual(MIN_SPAN);
  });

  it("never caps below the pair's combined minimums", () => {
    // A row already over budget on its OTHER members would compute a negative budget.
    // Refusing a minimum span is worse than an over-budget row — the same policy
    // `setAdjacentWidgetColSpans`/`enforceLayoutColSpans` already apply.
    const pair = resolveResizePair(
      ['a', 'b', 'c', 'd'],
      { a: 6, b: 6, c: 12, d: 12 },
      0,
      MIN_SPAN,
      MIN_SPAN,
    );
    expect(pair.totalSpan).toBe(MIN_SPAN * 2);
    expect(pair.leftSpan).toBe(MIN_SPAN);
    expect(pair.rightSpan).toBe(MIN_SPAN);
  });

  it('respects a widget-specific minimum (a KPI without a sparkline may go to 4)', () => {
    const pair = resolveResizePair(['a', 'b'], { a: 20, b: 4 }, 0, MIN_SPAN, 4);
    expect(pair).toEqual({ leftSpan: 20, rightSpan: 4, totalSpan: GRID_COLS });
  });

  it('always yields a resizable range: minLeft <= maxLeft for the handle it feeds', () => {
    // `RowResizeHandle` computes `minLeft = leftMinSpan`, `maxLeft = totalSpan - rightMinSpan`.
    // An inverted range wedges every arrow key and pointer drag on that divider forever.
    const rows: Array<[string[], Record<string, number> | undefined]> = [
      [['a', 'b'], undefined],
      [['a', 'b', 'c'], { a: 16, b: 8 }],
      [['a', 'b', 'c', 'd'], {}],
      [['a', 'b', 'c'], { a: 24, b: 24, c: 24 }],
      // Both pair members scaled below MIN_SPAN by a wildly over-budget row.
      [['a', 'b', 'c', 'd'], { a: 6, b: 6, c: 12, d: 12 }],
    ];
    for (const [row, spans] of rows) {
      for (let i = 0; i < row.length - 1; i += 1) {
        const pair = resolveResizePair(row, spans, i, MIN_SPAN, MIN_SPAN);
        expect(pair.totalSpan - MIN_SPAN).toBeGreaterThanOrEqual(MIN_SPAN);
      }
    }
  });
});
