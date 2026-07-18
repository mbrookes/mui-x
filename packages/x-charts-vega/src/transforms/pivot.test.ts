import { createGapCollector } from '../gaps';
import { applyPivotTransform } from './pivot';
import type { VegaPivotTransform } from '../types';

describe('applyPivotTransform', () => {
  it('pivots long-format rows to wide, one column per distinct pivot value', () => {
    const gaps = createGapCollector();
    const rows = [
      { date: '2020-01', symbol: 'AAPL', price: 10 },
      { date: '2020-01', symbol: 'MSFT', price: 20 },
      { date: '2020-02', symbol: 'AAPL', price: 11 },
      { date: '2020-02', symbol: 'MSFT', price: 22 },
    ];
    const transform: VegaPivotTransform = { pivot: 'symbol', value: 'price', groupby: ['date'] };
    const result = applyPivotTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([
      { date: '2020-01', AAPL: 10, MSFT: 20 },
      { date: '2020-02', AAPL: 11, MSFT: 22 },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('fills a missing (groupby, pivot-value) combination with null', () => {
    const gaps = createGapCollector();
    const rows = [
      { date: '2020-01', symbol: 'AAPL', price: 10 },
      { date: '2020-02', symbol: 'MSFT', price: 22 },
    ];
    const transform: VegaPivotTransform = { pivot: 'symbol', value: 'price', groupby: ['date'] };
    const result = applyPivotTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([
      { date: '2020-01', AAPL: 10, MSFT: null },
      { date: '2020-02', AAPL: null, MSFT: 22 },
    ]);
  });

  it('aggregates multiple rows sharing a (groupby, pivot-value) cell with the default sum', () => {
    const gaps = createGapCollector();
    const rows = [
      { date: '2020-01', symbol: 'AAPL', price: 10 },
      { date: '2020-01', symbol: 'AAPL', price: 5 },
    ];
    const transform: VegaPivotTransform = { pivot: 'symbol', value: 'price', groupby: ['date'] };
    const result = applyPivotTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([{ date: '2020-01', AAPL: 15 }]);
  });

  it('honors an explicit aggregation op', () => {
    const gaps = createGapCollector();
    const rows = [
      { date: '2020-01', symbol: 'AAPL', price: 10 },
      { date: '2020-01', symbol: 'AAPL', price: 20 },
    ];
    const transform: VegaPivotTransform = {
      pivot: 'symbol',
      value: 'price',
      groupby: ['date'],
      op: 'mean',
    };
    const result = applyPivotTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([{ date: '2020-01', AAPL: 15 }]);
  });

  it('caps pivot columns to the first `limit` sorted values', () => {
    const gaps = createGapCollector();
    const rows = [
      { g: 1, k: 'C', v: 3 },
      { g: 1, k: 'A', v: 1 },
      { g: 1, k: 'B', v: 2 },
    ];
    const transform: VegaPivotTransform = { pivot: 'k', value: 'v', groupby: ['g'], limit: 2 };
    const result = applyPivotTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([{ g: 1, A: 1, B: 2 }]);
  });

  it('defaults groupby to every field other than pivot/value when omitted', () => {
    const gaps = createGapCollector();
    const rows = [
      { date: '2020-01', symbol: 'AAPL', price: 10 },
      { date: '2020-01', symbol: 'MSFT', price: 20 },
    ];
    const transform: VegaPivotTransform = { pivot: 'symbol', value: 'price' };
    const result = applyPivotTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([{ date: '2020-01', AAPL: 10, MSFT: 20 }]);
  });

  it('reports a gap for an unimplemented aggregation op and nulls the cell', () => {
    const gaps = createGapCollector();
    const rows = [{ date: '2020-01', symbol: 'AAPL', price: 10 }];
    const transform: VegaPivotTransform = {
      pivot: 'symbol',
      value: 'price',
      groupby: ['date'],
      op: 'made_up_op' as never,
    };
    const result = applyPivotTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([{ date: '2020-01', AAPL: null }]);
    const gap = gaps.list().find((entry) => entry.code === 'aggregate:made_up_op');
    expect(gap?.severity).to.equal('unsupported');
  });
});
