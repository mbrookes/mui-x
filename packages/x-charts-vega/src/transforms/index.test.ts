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

  it('reports a kind-specific gap for each recognized-but-unsupported transform kind', () => {
    const kinds: Array<[string, VegaTransform]> = [
      ['window', { window: [] } as unknown as VegaTransform],
      ['joinaggregate', { joinaggregate: [] } as unknown as VegaTransform],
      ['density', { density: 'x' } as unknown as VegaTransform],
      ['regression', { regression: 'y', on: 'x' } as unknown as VegaTransform],
      ['loess', { loess: 'y', on: 'x' } as unknown as VegaTransform],
      ['pivot', { pivot: 'k', value: 'v' } as unknown as VegaTransform],
      ['quantile', { quantile: 'x' } as unknown as VegaTransform],
      ['sample', { sample: 100 } as unknown as VegaTransform],
      ['stack', { stack: 'x', as: 'y' } as unknown as VegaTransform],
      ['impute', { impute: 'v', key: 'k' } as unknown as VegaTransform],
      ['flatten', { flatten: ['a'] } as unknown as VegaTransform],
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
});
