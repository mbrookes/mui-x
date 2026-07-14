import { compileSpec } from '../compile';
import type { VegaLiteSpec } from '../types';

/*
 * End-to-end tests driving the transforms work unit (filter, calculate,
 * timeUnit, bin) through the real compile pipeline (compileSpec), the same
 * way a host application would exercise it. These are in addition to the
 * direct unit tests in filter.test.ts / calculate.test.ts / bin.test.ts /
 * timeUnit.test.ts / aggregateOps.test.ts / encoding.test.ts / index.test.ts.
 */
describe('transforms pipeline (via compileSpec)', () => {
  it('runs filter + calculate + timeUnit top-level transforms together with zero transform gaps', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { amount: 10, category: 'A', ts: '2024-01-15' },
          { amount: 200, category: 'A', ts: '2024-02-20' },
          { amount: 30, category: 'B', ts: '2024-01-05' },
          { amount: 5, category: 'B', ts: '2024-03-01' },
        ],
      },
      transform: [
        { filter: { field: 'amount', gte: 10 } },
        { calculate: 'datum.amount * 2', as: 'doubled' },
        { timeUnit: 'month', field: 'ts', as: 'month' },
      ],
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'doubled', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const transformGaps = compiled.gaps.filter((gap) => gap.code.startsWith('transform:'));
    expect(transformGaps).to.have.length(0);
    // The amount === 5 row was filtered out; A and B both still have a
    // surviving row, so both remain as categories.
    expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B']);
  });

  it('produces a histogram-shaped ordinal x-axis from an inline `bin` + `count` aggregate', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ v: 1 }, { v: 2 }, { v: 12 }, { v: 13 }, { v: 14 }] },
      mark: 'bar',
      encoding: {
        x: { field: 'v', bin: { step: 10 }, type: 'quantitative' },
        y: { aggregate: 'count', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.xAxis?.config.scaleType).to.equal('band');
    expect(compiled.xAxis?.categories).to.deep.equal(['0–10', '10–20']);
    expect(compiled.gaps.filter((gap) => gap.code.startsWith('transform:'))).to.have.length(0);
  });

  it('buckets a temporal axis by inline `timeUnit: month`', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { d: new Date(2024, 0, 5), v: 1 },
          { d: new Date(2024, 0, 20), v: 2 },
          { d: new Date(2024, 1, 1), v: 3 },
        ],
      },
      mark: 'line',
      encoding: {
        x: { field: 'd', timeUnit: 'month', type: 'temporal' },
        y: { field: 'v', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.xAxis?.fieldType).to.equal('temporal');
    // Bare `month` is cyclic, so both dates collapse onto the 2012 reference year.
    expect(compiled.xAxis?.categories).to.deep.equal([new Date(2012, 0, 1), new Date(2012, 1, 1)]);
  });

  it('records a filter gap but keeps rows for an unsupported filter expression, without throwing', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1 }, { x: 2 }] },
      transform: [{ filter: 'someUnsupportedFn(datum.x)' }],
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'x', type: 'quantitative' },
      },
    };
    expect(() => compileSpec(spec)).to.not.throw();
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'transform:filter-expression');
    expect(gap?.severity).to.equal('unsupported');
  });
});
