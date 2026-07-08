import { compileSpec } from './index';
import type { VegaLiteSpec } from '../types';

const barSpec: VegaLiteSpec = {
  data: {
    values: [
      { category: 'A', amount: 28 },
      { category: 'B', amount: 55 },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'category', type: 'nominal' },
    y: { field: 'amount', type: 'quantitative' },
  },
};

describe('compileSpec (foundation pipeline)', () => {
  it('normalizes a unit spec and resolves a band x axis over the categories', () => {
    const compiled = compileSpec(barSpec);
    expect(compiled.chartKind).to.equal('cartesian');
    expect(compiled.xAxis?.config.scaleType).to.equal('band');
    expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B']);
    expect(compiled.yAxis?.config.scaleType).to.equal('linear');
  });

  it('prefers the data prop over spec data values', () => {
    const compiled = compileSpec(barSpec, { data: [{ category: 'Z', amount: 1 }] });
    expect(compiled.xAxis?.categories).to.deep.equal(['Z']);
  });

  it('flattens layers and merges shared encoding', () => {
    const compiled = compileSpec({
      data: { values: [{ x: 'A', y: 1 }] },
      encoding: { x: { field: 'x', type: 'nominal' } },
      layer: [
        { mark: 'line', encoding: { y: { field: 'y', type: 'quantitative' } } },
        { mark: 'point', encoding: { y: { field: 'y', type: 'quantitative' } } },
      ],
    });
    expect(compiled.xAxis?.categories).to.deep.equal(['A']);
    // Both layers see the inherited x encoding: each mark compiler either
    // produces series or reports a gap for its own layer path — nothing may
    // be silently dropped.
    const layerPaths = new Set([
      ...compiled.series.map(() => 'series'),
      ...compiled.gaps.map((gap) => gap.path ?? ''),
    ]);
    const layerAccounted = (index: number) =>
      compiled.series.length > 0 ||
      [...layerPaths].some((path) => path.startsWith(`layer[${index}]`));
    expect(layerAccounted(0)).to.equal(true);
    expect(layerAccounted(1)).to.equal(true);
  });

  it('reports unsupported marks with a hint instead of throwing', () => {
    const compiled = compileSpec({
      data: { values: [{ a: 1 }] },
      mark: 'boxplot',
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:boxplot');
    expect(gap?.severity).to.equal('unsupported');
    expect(gap?.message).to.contain('no x-charts equivalent');
    expect(compiled.series).to.have.length(0);
  });

  it('reports facet/concat compositions as gaps', () => {
    const compiled = compileSpec({
      hconcat: [{ mark: 'bar' }],
    } as unknown as VegaLiteSpec);
    expect(compiled.gaps.map((gap) => gap.code)).to.include('composition:hconcat');
  });

  it('applies inline aggregation by grouping on the categorical channel', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { cat: 'A', v: 1 },
          { cat: 'A', v: 3 },
          { cat: 'B', v: 5 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', aggregate: 'sum' },
      },
    });
    // Aggregation folds rows before axis resolution: two categories remain.
    expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B']);
  });

  it('runs top-level aggregate transforms', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { cat: 'A', v: 1 },
          { cat: 'A', v: 3 },
        ],
      },
      transform: [{ aggregate: [{ op: 'sum', field: 'v', as: 'total' }], groupby: ['cat'] }],
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'total', type: 'quantitative' },
      },
    });
    expect(compiled.xAxis?.categories).to.deep.equal(['A']);
    expect(compiled.gaps.filter((gap) => gap.code.startsWith('transform:'))).to.have.length(0);
  });
});
