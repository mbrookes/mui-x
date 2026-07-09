import { createGapCollector } from '../gaps';
import { applyQuantileTransform } from './quantile';
import { evaluateAggregate } from './aggregateOps';
import type { VegaQuantileTransform } from '../types';

describe('applyQuantileTransform', () => {
  it('computes explicit probs', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }];
    const transform: VegaQuantileTransform = { quantile: 'v', probs: [0, 0.5, 1] };
    const result = applyQuantileTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([
      { prob: 0, value: 1 },
      { prob: 0.5, value: 3 },
      { prob: 1, value: 5 },
    ]);
  });

  it('generates probs from step when probs is omitted', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }];
    const transform: VegaQuantileTransform = { quantile: 'v', step: 0.5 };
    const result = applyQuantileTransform(rows, transform, gaps, '$');
    // step=0.5 -> probs = [0.25, 0.75]
    expect(result.map((row) => row.prob)).to.deep.equal([0.25, 0.75]);
  });

  it('agrees with the median aggregate op at prob 0.5', () => {
    const gaps = createGapCollector();
    const values = [4, 1, 7, 3, 9, 2];
    const rows = values.map((v) => ({ v }));
    const transform: VegaQuantileTransform = { quantile: 'v', probs: [0.5] };
    const result = applyQuantileTransform(rows, transform, gaps, '$');
    const median = evaluateAggregate('median', values);
    expect(result[0].value).to.equal(median);
  });

  it('computes independently per groupby partition', () => {
    const gaps = createGapCollector();
    const rows = [
      { g: 'A', v: 1 },
      { g: 'A', v: 3 },
      { g: 'B', v: 10 },
      { g: 'B', v: 30 },
    ];
    const transform: VegaQuantileTransform = { quantile: 'v', probs: [0.5], groupby: ['g'] };
    const result = applyQuantileTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([
      { g: 'A', prob: 0.5, value: 2 },
      { g: 'B', prob: 0.5, value: 20 },
    ]);
  });

  it('honors a custom `as`', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }];
    const transform: VegaQuantileTransform = { quantile: 'v', probs: [0.5], as: ['p', 'q'] };
    const result = applyQuantileTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([{ p: 0.5, q: 1.5 }]);
  });

  it('filters out non-numeric values before computing quantiles', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 'nope' }, { v: null }, { v: 3 }];
    const transform: VegaQuantileTransform = { quantile: 'v', probs: [0] };
    const result = applyQuantileTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([{ prob: 0, value: 1 }]);
  });

  it('emits nothing for an empty (all non-numeric) group', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 'x' }, { v: null }];
    const transform: VegaQuantileTransform = { quantile: 'v', probs: [0.5] };
    const result = applyQuantileTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([]);
  });

  it('falls back to the default step for a non-positive step (no infinite loop)', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const transform: VegaQuantileTransform = { quantile: 'v', step: 0 };
    // Must terminate; step 0 falls back to the 0.01 default (probs 0.005,
    // 0.015, …, 0.995 -> 100 generated probs).
    const result = applyQuantileTransform(rows, transform, gaps, '$');
    expect(result.length).to.equal(100);
  });
});
