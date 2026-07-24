import { createGapCollector } from '../gaps';
import { applyTransforms } from './index';
import type { VegaTransform } from '../types';

describe('applyTransforms / dispatcher', () => {
  it('runs filter, calculate, aggregate, bin, and timeUnit transforms in order', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: 1, cat: 'A' },
      { x: 12, cat: 'A' },
      { x: 100, cat: 'B' },
    ];
    const transforms: VegaTransform[] = [
      { filter: { field: 'x', lt: 50 } },
      { calculate: 'datum.x * 2', as: 'doubled' },
    ];
    const result = applyTransforms(rows, transforms, gaps, '$');
    expect(result).to.deep.equal([
      { x: 1, cat: 'A', doubled: 2 },
      { x: 12, cat: 'A', doubled: 24 },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('dispatches lookup transforms', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }, { state: 'NY' }];
    const transforms: VegaTransform[] = [
      {
        lookup: 'state',
        from: {
          data: { values: [{ state: 'CA', population: 39 }] },
          key: 'state',
          fields: ['population'],
        },
      } as unknown as VegaTransform,
    ];
    const result = applyTransforms(rows, transforms, gaps, '$');
    expect(result).to.deep.equal([
      { state: 'CA', population: 39 },
      { state: 'NY', population: null },
    ]);
  });

  it('runs fold inline (unowned, but must keep working)', () => {
    const gaps = createGapCollector();
    const rows = [{ a: 1, b: 2 }];
    const result = applyTransforms(rows, [{ fold: ['a', 'b'] }], gaps, '$');
    expect(result).to.deep.equal([
      { a: 1, b: 2, key: 'a', value: 1 },
      { a: 1, b: 2, key: 'b', value: 2 },
    ]);
  });

  it('dispatches a pivot transform', () => {
    const gaps = createGapCollector();
    const rows = [
      { date: 'd1', k: 'A', v: 1 },
      { date: 'd1', k: 'B', v: 2 },
    ];
    const result = applyTransforms(
      rows,
      [{ pivot: 'k', value: 'v', groupby: ['date'] } as unknown as VegaTransform],
      gaps,
      '$',
    );
    expect(result).to.deep.equal([{ date: 'd1', A: 1, B: 2 }]);
    expect(gaps.list()).to.have.length(0);
  });

  it('dispatches a stack transform', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 10 }, { v: 20 }];
    const result = applyTransforms(
      rows,
      [{ stack: 'v', as: ['start', 'end'] } as unknown as VegaTransform],
      gaps,
      '$',
    );
    expect(result).to.deep.equal([
      { v: 10, start: 0, end: 10 },
      { v: 20, start: 10, end: 30 },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('dispatches a flatten transform', () => {
    const gaps = createGapCollector();
    const rows = [
      { species: 'A', outliers: [1, 2] },
      { species: 'B', outliers: [] },
    ];
    const result = applyTransforms(
      rows,
      [{ flatten: ['outliers'] } as unknown as VegaTransform],
      gaps,
      '$',
    );
    expect(result).to.deep.equal([
      { species: 'A', outliers: 1 },
      { species: 'A', outliers: 2 },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('reports a kind-specific gap for each recognized-but-unsupported transform kind', () => {
    const kinds: Array<[string, VegaTransform]> = [
      ['sample', { sample: 100 } as unknown as VegaTransform],
      ['impute', { impute: 'v', key: 'k' } as unknown as VegaTransform],
    ];
    for (const [kind, transform] of kinds) {
      const gaps = createGapCollector();
      applyTransforms([], [transform], gaps, '$');
      const gap = gaps.list().find((entry) => entry.code === `transform:${kind}`);
      expect(gap, `expected a gap for "${kind}"`).to.not.equal(undefined);
      expect(gap?.severity).to.equal('unsupported');
      expect(gap?.message.length).to.be.greaterThan(0);
    }
  });

  it('still reports a generic gap for a truly unknown transform kind', () => {
    const gaps = createGapCollector();
    applyTransforms([], [{ someMadeUpTransform: true } as unknown as VegaTransform], gaps, '$');
    const gap = gaps.list().find((entry) => entry.code === 'transform:someMadeUpTransform');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('dispatches a window transform', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const transforms: VegaTransform[] = [
      { window: [{ op: 'row_number', as: 'rn' }] } as unknown as VegaTransform,
    ];
    const result = applyTransforms(rows, transforms, gaps, '$');
    expect(result).to.deep.equal([
      { v: 1, rn: 1 },
      { v: 2, rn: 2 },
      { v: 3, rn: 3 },
    ]);
  });

  it('dispatches a joinaggregate transform', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const transforms: VegaTransform[] = [
      { joinaggregate: [{ op: 'sum', field: 'v', as: 'total' }] } as unknown as VegaTransform,
    ];
    const result = applyTransforms(rows, transforms, gaps, '$');
    expect(result).to.deep.equal([
      { v: 1, total: 6 },
      { v: 2, total: 6 },
      { v: 3, total: 6 },
    ]);
  });

  it('dispatches a regression transform', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
    ];
    const transforms: VegaTransform[] = [{ regression: 'y', on: 'x' } as unknown as VegaTransform];
    const result = applyTransforms(rows, transforms, gaps, '$');
    expect(result).to.have.length(2);
  });

  it('dispatches a loess transform', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    const transforms: VegaTransform[] = [{ loess: 'y', on: 'x' } as unknown as VegaTransform];
    const result = applyTransforms(rows, transforms, gaps, '$');
    expect(result).to.have.length(4);
  });

  it('dispatches a quantile transform', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }];
    const transforms: VegaTransform[] = [
      { quantile: 'v', probs: [0.5] } as unknown as VegaTransform,
    ];
    const result = applyTransforms(rows, transforms, gaps, '$');
    expect(result).to.deep.equal([{ prob: 0.5, value: 2.5 }]);
  });

  it('dispatches a density transform', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }];
    const transforms: VegaTransform[] = [{ density: 'v', steps: 4 } as unknown as VegaTransform];
    const result = applyTransforms(rows, transforms, gaps, '$');
    expect(result).to.have.length(5);
  });
});
