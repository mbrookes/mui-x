import { describe, expect, it } from 'vitest';
import { aggregateHeatmap } from './heatmap';

/**
 * A cell that measured nothing must stay distinguishable from a cell whose rows aggregated to a
 * real computed 0. `aggregateHeatmap` encodes three states:
 * - no row landed in the cell → the key is absent from `cells`;
 * - rows landed but none carried a numeric measure → the key is present with the value `null`;
 * - rows measured → the key is present with the number, `0` included.
 *
 * Only the third is a measurement, and only it belongs in the colour domain.
 */
describe('aggregateHeatmap cell presence', () => {
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

  it('keeps a cell whose rows all had a non-measurable measure, with a null value', () => {
    const rows = [
      { region: 'oslo', product: 'march', temperature: null },
      { region: 'oslo', product: 'march', temperature: undefined },
      { region: 'oslo', product: 'march', temperature: '' },
      { region: 'oslo', product: 'march', temperature: 'n/a' },
      { region: 'rome', product: 'march', temperature: 20 },
    ];
    const result = aggregateHeatmap(rows, 'product', 'region', 'temperature', undefined, 'avg');
    const key = `march\x00oslo`;
    // Rows DID land in the cell, so the key exists — but there is no measurement, so the value
    // is `null`, never a synthetic 0 that would render as a real reading at the bottom of the
    // colour ramp ("0 °C" for a temperature nobody took).
    expect(result.cells.has(key)).toBe(true);
    expect(result.cells.get(key)).toBe(null);
    // The unmeasured cell is excluded from the colour domain.
    expect(result.minValue).toBe(20);
    expect(result.maxValue).toBe(20);
  });

  it('reports a null (not 0) cell for a sum over an all-null measure', () => {
    const rows = [{ region: 'east', product: 'A', amount: null }];
    const result = aggregateHeatmap(rows, 'product', 'region', 'amount', undefined, 'sum');
    expect(result.cells.get(`A\x00east`)).toBe(null);
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
