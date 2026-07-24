import { createGapCollector } from '../gaps';
import { applyStackTransform } from './stack';
import type { VegaStackTransform } from '../types';

describe('applyStackTransform', () => {
  it('stacks rows within a group in input order (default zero offset)', () => {
    const gaps = createGapCollector();
    const rows = [
      { q: 'Q1', v: 10 },
      { q: 'Q1', v: 20 },
      { q: 'Q1', v: 30 },
    ];
    const transform: VegaStackTransform = { stack: 'v', as: ['v1', 'v2'], groupby: ['q'] };
    const result = applyStackTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([
      { q: 'Q1', v: 10, v1: 0, v2: 10 },
      { q: 'Q1', v: 20, v1: 10, v2: 30 },
      { q: 'Q1', v: 30, v1: 30, v2: 60 },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('stacks each groupby partition independently', () => {
    const gaps = createGapCollector();
    const rows = [
      { q: 'Q1', v: 10 },
      { q: 'Q2', v: 1 },
      { q: 'Q1', v: 20 },
      { q: 'Q2', v: 2 },
    ];
    const transform: VegaStackTransform = { stack: 'v', as: ['start', 'end'], groupby: ['q'] };
    const result = applyStackTransform(rows, transform, gaps, '$');
    expect(result.map((row) => [row.start, row.end])).to.deep.equal([
      [0, 10],
      [0, 1],
      [10, 30],
      [1, 3],
    ]);
  });

  it('defaults the end field to `<as>_end` for a single-string `as`', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 5 }, { v: 15 }];
    const transform: VegaStackTransform = { stack: 'v', as: 'x' };
    const result = applyStackTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([
      { v: 5, x: 0, x_end: 5 },
      { v: 15, x: 5, x_end: 20 },
    ]);
  });

  it("splits negative and nonnegative values into separate diverging stacks (bar_diverging_stack_transform's signed percentages)", () => {
    const gaps = createGapCollector();
    const rows = [
      { type: 'a', pct: -2 },
      { type: 'b', pct: -1 },
      { type: 'c', pct: 0 },
      { type: 'd', pct: 1 },
      { type: 'e', pct: 2 },
    ];
    const transform: VegaStackTransform = { stack: 'pct', as: ['v1', 'v2'] };
    const result = applyStackTransform(rows, transform, gaps, '$');
    // Negatives accumulate downward from 0 in encounter order; nonnegatives
    // (including the 0 value) accumulate upward from 0, separately.
    expect(result.map((row) => [row.v1, row.v2])).to.deep.equal([
      [0, -2],
      [-2, -3],
      [0, 0],
      [0, 1],
      [1, 3],
    ]);
  });

  it('orders each group by `sort` before stacking, instead of input row order', () => {
    const gaps = createGapCollector();
    const rows = [
      { k: 3, v: 30 },
      { k: 1, v: 10 },
      { k: 2, v: 20 },
    ];
    const transform: VegaStackTransform = {
      stack: 'v',
      as: ['start', 'end'],
      sort: [{ field: 'k', order: 'ascending' }],
    };
    const result = applyStackTransform(rows, transform, gaps, '$');
    // Output stays in the ORIGINAL row order/positions; only the stacking
    // arithmetic itself follows the sorted (by k) order.
    expect(result.find((row) => row.k === 1)).to.deep.equal({ k: 1, v: 10, start: 0, end: 10 });
    expect(result.find((row) => row.k === 2)).to.deep.equal({ k: 2, v: 20, start: 10, end: 30 });
    expect(result.find((row) => row.k === 3)).to.deep.equal({ k: 3, v: 30, start: 30, end: 60 });
  });

  it("normalizes to proportions of the group's total (rect_mosaic_labelled_with_offset-shaped)", () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 1 }, { v: 2 }];
    const transform: VegaStackTransform = { stack: 'v', as: ['start', 'end'], offset: 'normalize' };
    const result = applyStackTransform(rows, transform, gaps, '$');
    expect(result.map((row) => [row.start, row.end])).to.deep.equal([
      [0, 0.25],
      [0.25, 0.5],
      [0.5, 1],
    ]);
  });

  it('centers the stack around 0 for offset: "center"', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 10 }, { v: 10 }];
    const transform: VegaStackTransform = { stack: 'v', as: ['start', 'end'], offset: 'center' };
    const result = applyStackTransform(rows, transform, gaps, '$');
    expect(result.map((row) => [row.start, row.end])).to.deep.equal([
      [-10, 0],
      [0, 10],
    ]);
  });

  it('reports an unsupported gap and passes rows through when `as` is missing', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }];
    const transform = { stack: 'v' } as VegaStackTransform;
    const result = applyStackTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal(rows);
    const gap = gaps.list().find((g) => g.code === 'transform:stack');
    expect(gap?.severity).to.equal('unsupported');
  });
});
