import { describe, expect, it } from 'vitest';
import {
  buildGhostBarContext,
  computeControlledHighlight,
  computeStackTotals,
  crossFilterValueEquals,
  densifyAggregated,
  densifyMultiSeries,
  densifyMultiY,
  formatPercentAxis,
  formatPercentValue,
  isAreaStacked,
  isBarStacked,
  makeValueFormatter,
  normalizeCrossFilterValue,
} from './chartWidgetHelpers';

// ─── crossFilterValueEquals ───────────────────────────────────────────────────
//
// Regression coverage for the three-way divergence documented in the architecture
// review (finding #5): chart widgets used loose `==`, grid widgets used
// `String(a) === String(b)`, and neither agreed with the other on real inputs.
// `crossFilterValueEquals` is the single implementation both should use.

describe('crossFilterValueEquals', () => {
  it('treats identical numbers as equal', () => {
    expect(crossFilterValueEquals(5, 5)).toBe(true);
  });

  it('treats identical strings as equal', () => {
    expect(crossFilterValueEquals('DHL', 'DHL')).toBe(true);
  });

  it('treats a number and its string representation as equal', () => {
    // Cross-filter values may arrive as either type depending on whether they came
    // from a click handler (native type) or a stored filter (often stringified).
    expect(crossFilterValueEquals(5, '5')).toBe(true);
  });

  it('does NOT treat 0 and empty string as equal (loose `==` bug)', () => {
    // `0 == ''` is `true` in JS — the chart widget's old `looseEq` helper got this
    // wrong. An empty-string category value and a numeric 0 must stay distinct.
    expect(crossFilterValueEquals(0, '')).toBe(false);
    expect(crossFilterValueEquals('', 0)).toBe(false);
  });

  it('treats null and undefined as equal', () => {
    // Both normalize to `null` — matches the loose-`==` intent without loose `==`'s
    // other footguns (0/''), and fixes the grid's `String(a) === String(b)`, where
    // `String(null) === 'null'` and `String(undefined) === 'undefined'` disagree.
    expect(crossFilterValueEquals(null, undefined)).toBe(true);
    expect(crossFilterValueEquals(undefined, null)).toBe(true);
    expect(crossFilterValueEquals(null, null)).toBe(true);
    expect(crossFilterValueEquals(undefined, undefined)).toBe(true);
  });

  it('does not treat null/undefined as equal to 0 or empty string', () => {
    expect(crossFilterValueEquals(null, 0)).toBe(false);
    expect(crossFilterValueEquals(undefined, '')).toBe(false);
  });

  it('treats equal Date instances as equal', () => {
    const a = new Date('2024-01-01T00:00:00.000Z');
    const b = new Date('2024-01-01T00:00:00.000Z');
    expect(crossFilterValueEquals(a, b)).toBe(true);
  });

  it('treats a Date and its matching ISO string as equal', () => {
    const date = new Date('2024-06-15T12:00:00.000Z');
    expect(crossFilterValueEquals(date, date.toISOString())).toBe(true);
  });

  it('treats different Date instances as not equal', () => {
    const a = new Date('2024-01-01T00:00:00.000Z');
    const b = new Date('2024-01-02T00:00:00.000Z');
    expect(crossFilterValueEquals(a, b)).toBe(false);
  });

  it('treats different strings as not equal', () => {
    expect(crossFilterValueEquals('DHL', 'FedEx')).toBe(false);
  });
});

describe('normalizeCrossFilterValue', () => {
  it('normalizes null and undefined to null', () => {
    expect(normalizeCrossFilterValue(null)).toBe(null);
    expect(normalizeCrossFilterValue(undefined)).toBe(null);
  });

  it('normalizes a Date to its ISO string', () => {
    const date = new Date('2024-03-01T00:00:00.000Z');
    expect(normalizeCrossFilterValue(date)).toBe(date.toISOString());
  });

  it('normalizes numbers and strings via String()', () => {
    expect(normalizeCrossFilterValue(0)).toBe('0');
    expect(normalizeCrossFilterValue('')).toBe('');
    expect(normalizeCrossFilterValue(42)).toBe('42');
  });
});

// ─── makeValueFormatter ───────────────────────────────────────────────────────

describe('makeValueFormatter', () => {
  it('falls back to String(value) when there is no format/precision (default)', () => {
    const formatter = makeValueFormatter();
    expect(formatter(1234)).toBe('1234');
    expect(formatter(null)).toBe('');
  });

  it('returns undefined when there is no format/precision and noFormatFallback is "undefined"', () => {
    // This is the behavior `lineSeries.ts`'s private copy used to implement on its
    // own (finding #8) — now available as an explicit opt-in on the shared function.
    const formatter = makeValueFormatter(undefined, undefined, undefined, {
      noFormatFallback: 'undefined',
    });
    expect(formatter).toBeUndefined();
  });

  it('formats using the given format/precision regardless of noFormatFallback', () => {
    const formatter = makeValueFormatter('integer', undefined, undefined, {
      noFormatFallback: 'undefined',
    });
    expect(formatter).toBeTypeOf('function');
    expect(formatter?.(null)).toBe('');
  });

  it('defaults to compact notation (historical chart-widget behavior)', () => {
    const formatter = makeValueFormatter('integer');
    expect(formatter(1_500_000)).toMatch(/M/);
  });

  it('honors compact: false (used by lineSeries.ts)', () => {
    const formatter = makeValueFormatter('integer', undefined, undefined, {
      compact: false,
      noFormatFallback: 'undefined',
    });
    expect(formatter?.(1_500_000)).not.toMatch(/M/);
  });
});

// ─── densify* ─────────────────────────────────────────────────────────────────

describe('densifyAggregated', () => {
  it('returns the same object when there are no temporal gaps to fill', () => {
    const data = { labels: ['A', 'B', 'C'], values: [1, 2, 3] };
    expect(densifyAggregated(data)).toBe(data);
  });

  it('inserts null-valued positions for filled temporal gaps', () => {
    const result = densifyAggregated({ labels: ['2024-01', '2024-03'], values: [10, 30] });
    expect(result.labels).toEqual(['2024-01', '2024-02', '2024-03']);
    expect(result.values).toEqual([10, null, 30]);
  });
});

describe('densifyMultiSeries', () => {
  it('returns the same object when there are no gaps', () => {
    const data = {
      labels: ['A', 'B'],
      seriesNames: ['N'],
      seriesData: { N: [1, 2] },
    };
    expect(densifyMultiSeries(data)).toBe(data);
  });

  it('fills gaps per series with null', () => {
    const result = densifyMultiSeries({
      labels: ['2024-01', '2024-03'],
      seriesNames: ['N', 'S'],
      seriesData: { N: [1, 2], S: [3, 4] },
    });
    expect(result.labels).toEqual(['2024-01', '2024-02', '2024-03']);
    expect(result.seriesData.N).toEqual([1, null, 2]);
    expect(result.seriesData.S).toEqual([3, null, 4]);
  });
});

describe('densifyMultiY', () => {
  it('returns the same object when there are no gaps', () => {
    const data = {
      labels: ['A', 'B'],
      series: [{ fieldId: 'revenue', values: [1, 2] }],
    };
    expect(densifyMultiY(data)).toBe(data);
  });

  it('fills gaps per y-series with null', () => {
    const result = densifyMultiY({
      labels: ['2024-01', '2024-03'],
      series: [{ fieldId: 'revenue', values: [10, 30] }],
    });
    expect(result.labels).toEqual(['2024-01', '2024-02', '2024-03']);
    expect(result.series[0].values).toEqual([10, null, 30]);
  });
});

// ─── buildGhostBarContext ───────────────────────────────────────────────────────

describe('buildGhostBarContext', () => {
  it('aligns filtered values to the all-label order and null-coalesces baseline values', () => {
    const ctx = buildGhostBarContext(
      ['A', 'B', 'C'],
      ['A', 'C'],
      [{ seriesId: 's1', allValues: [10, null, 30], filteredValues: [5, 15] }],
    );
    // 'A'→5, 'B' absent from the filtered labels → null, 'C'→15.
    expect(ctx.filteredValuesBySeriesId.s1).toEqual([5, null, 15]);
    // Baseline nulls become 0.
    expect(ctx.allValuesBySeriesId.s1).toEqual([10, 0, 30]);
  });

  it('emits an all-null filtered column for a series missing from the filtered set', () => {
    const ctx = buildGhostBarContext(
      ['A', 'B', 'C'],
      ['A', 'B', 'C'],
      [{ seriesId: 's2', allValues: [1, 2, 3], filteredValues: null }],
    );
    expect(ctx.filteredValuesBySeriesId.s2).toEqual([null, null, null]);
    expect(ctx.allValuesBySeriesId.s2).toEqual([1, 2, 3]);
  });
});

// ─── computeControlledHighlight ─────────────────────────────────────────────────

describe('computeControlledHighlight', () => {
  const item = { seriesId: 'cross-filter-series', dataIndex: 1 };
  const axis = [{ axisId: 'cross-filter-axis', dataIndex: 1 }];
  const owned = new Set(['cross-filter-series']);

  it('passes through the hovered item and axis when nothing is cross-filtering', () => {
    expect(computeControlledHighlight(item, axis, false, false, owned)).toEqual({ item, axis });
  });

  it('suppresses both when an own x-filter is active', () => {
    expect(computeControlledHighlight(item, axis, true, false, owned)).toEqual({
      item: null,
      axis: [],
    });
  });

  it('suppresses both when an incoming cross-filter is present', () => {
    expect(computeControlledHighlight(item, axis, false, true, owned)).toEqual({
      item: null,
      axis: [],
    });
  });

  it('drops the item (but keeps the axis) when the hovered series is not owned', () => {
    expect(computeControlledHighlight(item, axis, false, false, new Set(['other']))).toEqual({
      item: null,
      axis,
    });
  });

  it('returns an empty axis when no axis is hovered', () => {
    expect(computeControlledHighlight(null, null, false, false, owned)).toEqual({
      item: null,
      axis: [],
    });
  });
});

// ─── shared chart-render helpers (finding 2.4) ────────────────────────────────

describe('computeStackTotals', () => {
  it('sums each series value at every label index (null → 0)', () => {
    const totals = computeStackTotals(
      [
        [10, null, 20],
        [30, 5, null],
      ],
      3,
    );
    expect(totals).toEqual([40, 5, 20]);
  });

  it('returns all-zero totals for no columns', () => {
    expect(computeStackTotals([], 2)).toEqual([0, 0]);
  });
});

describe('isBarStacked', () => {
  it('is true for the dedicated stacked / 100% bar types regardless of layout', () => {
    expect(isBarStacked('bar-stacked', 'grouped')).toBe(true);
    expect(isBarStacked('bar-100', 'grouped')).toBe(true);
  });

  it("is true for plain 'bar' only under a 'stacked' layout", () => {
    expect(isBarStacked('bar', 'stacked')).toBe(true);
    expect(isBarStacked('bar', 'grouped')).toBe(false);
    expect(isBarStacked('bar', 'horizontal')).toBe(false);
  });
});

describe('isAreaStacked', () => {
  it('is true only for area-stacked / area-100', () => {
    expect(isAreaStacked('area-stacked')).toBe(true);
    expect(isAreaStacked('area-100')).toBe(true);
    expect(isAreaStacked('area')).toBe(false);
    expect(isAreaStacked('line')).toBe(false);
    expect(isAreaStacked(undefined)).toBe(false);
  });
});

describe('percent formatters', () => {
  it('formatPercentValue: one-decimal percent, null → 0%', () => {
    expect(formatPercentValue(25)).toBe('25.0%');
    expect(formatPercentValue(12.345)).toBe('12.3%');
    expect(formatPercentValue(null)).toBe('0%');
  });

  it('formatPercentAxis: whole-number percent', () => {
    expect(formatPercentAxis(24.6)).toBe('25%');
    expect(formatPercentAxis(0)).toBe('0%');
  });
});
