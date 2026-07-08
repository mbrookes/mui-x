import { compileSpec } from '../compile';
import { categoryIndex, categoryKey } from '../compile/context';
import type { UnitContext } from '../compile/context';
import { createGapCollector } from '../gaps';
import type { VegaLiteSpec } from '../types';
import { compileBarMark } from './bar';

describe('compileBarMark', () => {
  it('compiles vertical bars: band x + quantitative y, one series, index-aligned data', () => {
    const spec: VegaLiteSpec = {
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
    const compiled = compileSpec(spec);
    expect(compiled.plots).to.include('bar');
    expect(compiled.series).to.have.length(1);
    const series = compiled.series[0] as { type: string; data: unknown[]; layout?: string };
    expect(series.type).to.equal('bar');
    expect(series.layout).to.equal(undefined);
    expect(series.data).to.deep.equal([28, 55]);
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:bar-not-implemented');
  });

  it('applies a static mark color when there is no color encoding', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', amount: 1 }] },
      mark: { type: 'bar', color: '#ff0000' },
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect((compiled.series[0] as { color?: string }).color).to.equal('#ff0000');
  });

  it('applies a static color from an explicit color value encoding', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', amount: 1 }] },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
        color: { value: '#00ff00' },
      },
    };
    const compiled = compileSpec(spec);
    expect((compiled.series[0] as { color?: string }).color).to.equal('#00ff00');
    // A value-def color channel carries no legend.
    expect(compiled.hasLegend).to.equal(false);
  });

  it('splits into one series per color group, stacked by default (Vega-Lite default stack behavior)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', v: 1 },
          { cat: 'A', g: 'y', v: 2 },
          { cat: 'B', g: 'x', v: 3 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'g', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(2);
    const [seriesX, seriesY] = compiled.series as Array<{
      label?: string;
      data: unknown[];
      stack?: string;
      stackOffset?: string;
    }>;
    expect(seriesX.label).to.equal('x');
    expect(seriesX.data).to.deep.equal([1, 3]);
    expect(seriesY.label).to.equal('y');
    expect(seriesY.data).to.deep.equal([2, null]);
    // Both share the same stack id and use the 'none' offset (stack: zero default).
    expect(seriesX.stack).to.be.a('string').and.to.equal(seriesY.stack);
    expect(seriesX.stackOffset).to.equal('none');
  });

  it('maps stack: "normalize" to stackOffset: "expand"', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', v: 1 },
          { cat: 'A', g: 'y', v: 2 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative', stack: 'normalize' },
        color: { field: 'g', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series as Array<{ stackOffset?: string }>;
    expect(series[0].stackOffset).to.equal('expand');
    expect(series[1].stackOffset).to.equal('expand');
  });

  it('maps stack: "center" to stackOffset: "silhouette"', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', v: 1 },
          { cat: 'A', g: 'y', v: 2 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative', stack: 'center' },
        color: { field: 'g', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series as Array<{ stackOffset?: string }>;
    expect(series[0].stackOffset).to.equal('silhouette');
  });

  it('treats stack: null as grouped (no stack id)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', v: 1 },
          { cat: 'A', g: 'y', v: 2 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative', stack: null },
        color: { field: 'g', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series as Array<{ stack?: string }>;
    expect(series[0].stack).to.equal(undefined);
    expect(series[1].stack).to.equal(undefined);
  });

  it('treats an xOffset channel matching the color field as grouped bars (no stack)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', v: 1 },
          { cat: 'A', g: 'y', v: 2 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        xOffset: { field: 'g' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'g', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series as Array<{ stack?: string }>;
    expect(series[0].stack).to.equal(undefined);
    expect(series[1].stack).to.equal(undefined);
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('encoding:bar-offset-mismatch');
  });

  it('reports a partial gap when xOffset groups by a field different from color', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', h: 'p', v: 1 },
          { cat: 'A', g: 'y', h: 'q', v: 2 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        xOffset: { field: 'h' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'g', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'encoding:bar-offset-mismatch');
    expect(gap?.severity).to.equal('partial');
  });

  it('respects an explicit scale.domain order for series ordering and colors', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'y', v: 2 },
          { cat: 'A', g: 'x', v: 1 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        color: {
          field: 'g',
          type: 'nominal',
          scale: { domain: ['x', 'y'], range: ['#111111', '#222222'] },
        },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series as Array<{ label?: string; color?: string }>;
    expect(series.map((entry) => entry.label)).to.deep.equal(['x', 'y']);
    expect(series.map((entry) => entry.color)).to.deep.equal(['#111111', '#222222']);
  });

  it('reports an unsupported gap for ranged bars (x2/y2) but still renders the base bar', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', amount: 1, amount2: 5 }] },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
        y2: { field: 'amount2' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-ranged');
    expect(gap?.severity).to.equal('unsupported');
    expect(gap?.path).to.equal('$.encoding.y2');
    expect(compiled.series).to.have.length(1);
  });

  it('reports a gap for both x2 and y2 when both are present on the same unit', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', amount: 1, amount2: 5, category2: 'B' }] },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        x2: { field: 'category2' },
        y: { field: 'amount', type: 'quantitative' },
        y2: { field: 'amount2' },
      },
    };
    const compiled = compileSpec(spec);
    const rangedGapPaths = compiled.gaps
      .filter((entry) => entry.code === 'mark:bar-ranged')
      .map((entry) => entry.path);
    expect(rangedGapPaths).to.deep.equal(['$.encoding.x2', '$.encoding.y2']);
  });

  it('scopes the stack id per layer so two independent bar layers do not stack together', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', v: 1 },
          { cat: 'A', g: 'y', v: 2 },
        ],
      },
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'g', type: 'nominal' },
      },
      layer: [{ mark: 'bar' }, { mark: 'bar' }],
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(4);
    const stackIds = (compiled.series as Array<{ stack?: string }>).map((entry) => entry.stack);
    // Series from layer[0] must not share a stack id with series from layer[1].
    expect(stackIds[0]).to.equal(stackIds[1]);
    expect(stackIds[2]).to.equal(stackIds[3]);
    expect(stackIds[0]).not.to.equal(stackIds[2]);
  });

  it('reports an unsupported gap when both positional channels resolve to categorical axes', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ cat: 'A', other: 'P' }] },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'other', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-missing-axes');
    expect(gap?.severity).to.equal('unsupported');
    expect(compiled.series).to.have.length(0);
  });

  it('reports an ignored gap for mark.cornerRadius', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', amount: 1 }] },
      mark: { type: 'bar', cornerRadius: 6 },
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-corner-radius');
    expect(gap?.severity).to.equal('ignored');
  });

  it('reports an ignored gap for mark.size / binSpacing', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', amount: 1 }] },
      mark: { type: 'bar', size: 10, binSpacing: 2 },
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-size');
    expect(gap?.severity).to.equal('ignored');
  });

  it('reports an unsupported gap and renders nothing when a positional channel is missing', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A' }] },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-missing-axes');
    expect(gap?.severity).to.equal('unsupported');
    expect(compiled.series).to.have.length(0);
    expect(compiled.plots).not.to.include('bar');
  });

  // The scales work unit's `resolveAxes` only resolves a `band` scale for a
  // categorical *x* axis today (a categorical y falls back to `point`), so
  // horizontal bars are exercised here against a hand-built `UnitContext`
  // rather than through `compileSpec`.
  it('compiles horizontal bars: quantitative x + categorical y', () => {
    const rows = [
      { cat: 'A', v: 5 },
      { cat: 'B', v: 7 },
    ];
    const gaps = createGapCollector();
    const ctx: UnitContext = {
      unit: {
        mark: { type: 'bar' },
        encoding: {
          x: { field: 'v', type: 'quantitative' },
          y: { field: 'cat', type: 'nominal' },
        },
        transform: [],
        rows,
        path: '$',
      },
      rows,
      encoding: {
        x: { field: 'v', type: 'quantitative' },
        y: { field: 'cat', type: 'nominal' },
      },
      x: {
        config: { id: 'vega-x', scaleType: 'linear' },
        fieldType: 'quantitative',
        field: 'v',
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
    expect(compiled.plots).to.deep.equal(['bar']);
    expect(compiled.series).to.have.length(1);
    const series = compiled.series[0] as { layout?: string; data: unknown[] };
    expect(series.layout).to.equal('horizontal');
    expect(series.data).to.deep.equal([5, 7]);
  });
});
