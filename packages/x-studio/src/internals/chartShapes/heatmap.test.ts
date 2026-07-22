import { describe, expect, it } from 'vitest';
import { aggregateHeatmap } from './heatmap';

/**
 * Regression tests for finding 5: a cell with genuinely zero contributing rows must
 * be distinguishable from a cell whose rows aggregated to a real computed 0 — the
 * former is absent from `cells` entirely (callers must render it as "no data"), the
 * latter is present with value 0.
 */
describe('aggregateHeatmap cell presence (finding 5)', () => {
  it('omits a (x, y) combo entirely from `cells` when no row ever contributed to it', () => {
    const rows = [
      { region: 'east', product: 'A', amount: 10 },
      { region: 'east', product: 'B', amount: 20 },
      // No 'west' rows at all — every (west, *) cell must be absent from `cells`.
    ];
    const result = aggregateHeatmap(rows, 'product', 'region', 'amount', undefined, 'avg');
    expect(result.xLabels).toEqual(['A', 'B']);
    expect(result.yLabels).toEqual(['east']);
    expect(result.cells.has(`A\x00east`)).toBe(true);
    expect(result.cells.has(`B\x00east`)).toBe(true);
    // 'west' never appears as a y-label at all, since no row contributed to it.
    expect(result.yLabels).not.toContain('west');
  });

  it('keeps a genuine computed 0 present in `cells` for sum aggregation', () => {
    const rows = [
      { region: 'east', product: 'A', amount: -5 },
      { region: 'east', product: 'A', amount: 5 },
    ];
    const result = aggregateHeatmap(rows, 'product', 'region', 'amount', undefined, 'sum');
    const key = `A\x00east`;
    // The cell DID have contributing rows, so it must be present — with a real 0,
    // not treated as "no data".
    expect(result.cells.has(key)).toBe(true);
    expect(result.cells.get(key)).toBe(0);
  });

  it('keeps a genuine computed 0 present in `cells` for avg aggregation over rows summing to 0', () => {
    const rows = [
      { region: 'east', product: 'A', amount: -5 },
      { region: 'east', product: 'A', amount: 5 },
    ];
    const result = aggregateHeatmap(rows, 'product', 'region', 'amount', undefined, 'avg');
    const key = `A\x00east`;
    expect(result.cells.has(key)).toBe(true);
    expect(result.cells.get(key)).toBe(0);
  });

  it('count aggregation still counts every row landing in a cell, including non-numeric measures', () => {
    const rows = [
      { region: 'east', product: 'A', amount: 'n/a' },
      { region: 'east', product: 'A', amount: 5 },
    ];
    const result = aggregateHeatmap(rows, 'product', 'region', 'amount', undefined, 'count');
    expect(result.cells.get(`A\x00east`)).toBe(2);
  });
});
