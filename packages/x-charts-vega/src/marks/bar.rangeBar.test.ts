import { compileSpec } from '../compile';
import { categoryIndex, categoryKey } from '../compile/context';
import type { UnitContext } from '../compile/context';
import { createGapCollector } from '../gaps';
import type { VegaLiteSpec } from '../types';
import { compileBarMark } from './bar';

describe('compileBarMark — ranged bars (rangeBar)', () => {
  it('compiles vertical ranged bars: nominal x + quantitative y/y2 fields', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', low: 10, high: 25 },
          { category: 'B', low: 5, high: 40 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'low', type: 'quantitative' },
        y2: { field: 'high' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.plots).to.deep.equal(['rangeBar']);
    expect(compiled.series).to.have.length(1);
    const series = compiled.series[0] as { type: string; layout?: string; data: unknown[] };
    expect(series.type).to.equal('rangeBar');
    expect(series.layout).to.equal(undefined);
    expect(series.data).to.deep.equal([
      [10, 25],
      [5, 40],
    ]);
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:bar-ranged');
  });

  // Horizontal ranged bars (categorical y + quantitative x/x2) exercised
  // against a hand-built `UnitContext`, matching the regular-bar horizontal
  // test in bar.test.ts — the scales work unit only resolves a `band` scale
  // for a categorical *x* axis today.
  it('compiles horizontal ranged bars: quantitative x/x2 + categorical y', () => {
    const rows = [
      { cat: 'A', low: 1, high: 6 },
      { cat: 'B', low: 2, high: 9 },
    ];
    const gaps = createGapCollector();
    const ctx: UnitContext = {
      unit: {
        mark: { type: 'bar' },
        encoding: {
          x: { field: 'low', type: 'quantitative' },
          x2: { field: 'high' },
          y: { field: 'cat', type: 'nominal' },
        },
        transform: [],
        rows,
        path: '$',
      },
      rows,
      encoding: {
        x: { field: 'low', type: 'quantitative' },
        x2: { field: 'high' },
        y: { field: 'cat', type: 'nominal' },
      },
      x: {
        config: { id: 'vega-x', scaleType: 'linear' },
        fieldType: 'quantitative',
        field: 'low',
      },
      y: {
        config: { id: 'vega-y', scaleType: 'band', data: ['A', 'B'] },
        fieldType: 'nominal',
        categories: ['A', 'B'],
        categoryKeys: ['A', 'B'].map(categoryKey),
        field: 'cat',
      },
      gaps,
      palette: ['#111111', '#222222'],
      categoryIndex,
      categoryKey,
    };
    const compiled = compileBarMark(ctx);
    expect(compiled.plots).to.deep.equal(['rangeBar']);
    expect(compiled.series).to.have.length(1);
    const series = compiled.series[0] as { type: string; layout?: string; data: unknown[] };
    expect(series.type).to.equal('rangeBar');
    expect(series.layout).to.equal('horizontal');
    expect(series.data).to.deep.equal([
      [1, 6],
      [2, 9],
    ]);
  });

  it('splits ranged bars into one rangeBar series per color group and ignores the implied stack', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', low: 1, high: 3 },
          { cat: 'A', g: 'y', low: 2, high: 5 },
          { cat: 'B', g: 'x', low: 0, high: 4 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'low', type: 'quantitative' },
        y2: { field: 'high' },
        color: { field: 'g', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(2);
    const [seriesX, seriesY] = compiled.series as Array<{
      type: string;
      label?: string;
      data: unknown[];
      stack?: string;
    }>;
    expect(seriesX.type).to.equal('rangeBar');
    expect(seriesX.label).to.equal('x');
    expect(seriesX.data).to.deep.equal([
      [1, 3],
      [0, 4],
    ]);
    expect(seriesY.label).to.equal('y');
    expect(seriesY.data).to.deep.equal([[2, 5], null]);
    // rangeBar series carry no stack/stackOffset props.
    expect(seriesX.stack).to.equal(undefined);
    expect(seriesY.stack).to.equal(undefined);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-ranged-stack');
    expect(gap?.severity).to.equal('ignored');
  });

  it('treats a y2 datum def as a constant range end shared by every row', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', low: 10 },
          { category: 'B', low: 20 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'low', type: 'quantitative' },
        y2: { datum: 100 },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.plots).to.include('rangeBar');
    const series = compiled.series[0] as { data: unknown[] };
    expect(series.data).to.deep.equal([
      [10, 100],
      [20, 100],
    ]);
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:bar-ranged');
  });

  it('leaves a null cell when the range end is missing for a row', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', low: 10, high: 25 },
          { category: 'B', low: 5 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'low', type: 'quantitative' },
        y2: { field: 'high' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series[0] as { data: unknown[] };
    expect(series.data).to.deep.equal([[10, 25], null]);
  });

  it('reports a partial gap and drops the range for a y2 value def (pixel-space constant)', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', low: 10 }] },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'low', type: 'quantitative' },
        y2: { value: 50 },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.plots).to.include('bar');
    expect(compiled.plots).not.to.include('rangeBar');
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-ranged-value');
    expect(gap?.severity).to.equal('partial');
    expect(gap?.path).to.equal('$.encoding.y2');
  });

  it('reports an unsupported gap and drops the range for a non-numeric y2 datum def', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', low: 10 }] },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'low', type: 'quantitative' },
        y2: { datum: true },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.plots).to.include('bar');
    expect(compiled.plots).not.to.include('rangeBar');
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-ranged-datum-invalid');
    expect(gap?.severity).to.equal('unsupported');
    expect(gap?.path).to.equal('$.encoding.y2');
  });

  it('reports an unsupported gap for a lone mismatched-axis twin (x2 on a vertical bar)', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', category2: 'B', low: 10 }] },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        x2: { field: 'category2' },
        y: { field: 'low', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.plots).to.include('bar');
    expect(compiled.plots).not.to.include('rangeBar');
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-ranged-mismatched-axis');
    expect(gap?.severity).to.equal('unsupported');
    expect(gap?.path).to.equal('$.encoding.x2');
  });
});
