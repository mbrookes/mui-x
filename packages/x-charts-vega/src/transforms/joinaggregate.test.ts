import { createGapCollector } from '../gaps';
import { applyJoinAggregateTransform } from './joinaggregate';
import { compileSpec } from '../compile';
import type { VegaJoinAggregateTransform } from '../types';

describe('applyJoinAggregateTransform', () => {
  it('joins a global mean onto every row (no groupby)', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const transform: VegaJoinAggregateTransform = {
      joinaggregate: [{ op: 'mean', field: 'v', as: 'avg' }],
    };
    const result = applyJoinAggregateTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([
      { v: 1, avg: 2 },
      { v: 2, avg: 2 },
      { v: 3, avg: 2 },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('computes aggregates per groupby partition', () => {
    const gaps = createGapCollector();
    const rows = [
      { g: 'A', v: 1 },
      { g: 'B', v: 10 },
      { g: 'A', v: 3 },
      { g: 'B', v: 30 },
    ];
    const transform: VegaJoinAggregateTransform = {
      joinaggregate: [{ op: 'sum', field: 'v', as: 'total' }],
      groupby: ['g'],
    };
    const result = applyJoinAggregateTransform(rows, transform, gaps, '$');
    expect(result.map((row) => row.total)).to.deep.equal([4, 40, 4, 40]);
  });

  it('count without a field counts rows in the group', () => {
    const gaps = createGapCollector();
    const rows = [{ g: 'A' }, { g: 'A' }, { g: 'B' }];
    const transform: VegaJoinAggregateTransform = {
      joinaggregate: [{ op: 'count', as: 'n' }],
      groupby: ['g'],
    };
    const result = applyJoinAggregateTransform(rows, transform, gaps, '$');
    expect(result.map((row) => row.n)).to.deep.equal([2, 2, 1]);
  });

  it('argmin resolves the whole matched row (joinaggregate always has group rows to point at)', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 2 }, { v: 1 }];
    const transform: VegaJoinAggregateTransform = {
      joinaggregate: [{ op: 'argmin', field: 'v', as: 'best' } as never],
    };
    const result = applyJoinAggregateTransform(rows, transform, gaps, '$');
    expect(result.map((row) => row.best)).to.deep.equal([{ v: 1 }, { v: 1 }]);
    expect(gaps.list()).to.have.length(0);
  });

  it('an unsupported op reports an aggregate gap and nulls the field', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }];
    const transform = {
      joinaggregate: [{ op: 'made_up_op', field: 'v', as: 'out' }],
    } as unknown as VegaJoinAggregateTransform;
    const result = applyJoinAggregateTransform(rows, transform, gaps, '$');
    expect(result.map((row) => row.out)).to.deep.equal([null, null]);
    const gap = gaps.list().find((entry) => entry.code === 'aggregate:made_up_op');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('preserves row order, fields, and count', () => {
    const gaps = createGapCollector();
    const rows = [
      { id: 3, v: 30 },
      { id: 1, v: 10 },
      { id: 2, v: 20 },
    ];
    const transform: VegaJoinAggregateTransform = {
      joinaggregate: [{ op: 'sum', field: 'v', as: 'total' }],
    };
    const result = applyJoinAggregateTransform(rows, transform, gaps, '$');
    expect(result).to.have.length(3);
    expect(result.map((row) => row.id)).to.deep.equal([3, 1, 2]);
    expect(result.map((row) => row.v)).to.deep.equal([30, 10, 20]);
  });

  it('integrates through compileSpec for a percent-of-total computation', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { category: 'A', amount: 10 },
          { category: 'B', amount: 30 },
        ],
      },
      transform: [
        {
          joinaggregate: [{ op: 'sum', field: 'amount', as: 'total' }],
        } as unknown as VegaJoinAggregateTransform,
        { calculate: 'datum.amount / datum.total', as: 'pct' },
      ],
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'pct', type: 'quantitative' },
      },
    });
    const gaps = compiled.gaps.filter(
      (gap) => gap.code.startsWith('aggregate:') || gap.code.startsWith('transform:calculate'),
    );
    expect(gaps).to.have.length(0);
    const barSeries = compiled.series.find((series) => series.type === 'bar') as
      | { data?: Array<number | null> }
      | undefined;
    expect(barSeries?.data).to.deep.equal([0.25, 0.75]);
  });
});
