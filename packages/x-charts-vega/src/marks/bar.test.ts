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

  it('orders explicit-domain stacked series descending by value (Vega stack order), keeping domain colors', () => {
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
    // Stacked → series (and thus the legend) are ordered descending by value
    // (`y` before `x`), matching how Vega-Lite stacks. Each series still takes
    // its color from the scale domain (`x`→#111111, `y`→#222222), not its
    // reordered position.
    expect(series.map((entry) => entry.label)).to.deep.equal(['y', 'x']);
    expect(series.map((entry) => entry.color)).to.deep.equal(['#222222', '#111111']);
  });

  it('compiles a ranged bar (y + y2) to a rangeBar series instead of a bar', () => {
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
    expect(gap).to.equal(undefined);
    expect(compiled.plots).to.include('rangeBar');
    expect(compiled.plots).not.to.include('bar');
    expect(compiled.series).to.have.length(1);
    const series = compiled.series[0] as { type: string; data: unknown[] };
    expect(series.type).to.equal('rangeBar');
    expect(series.data).to.deep.equal([[1, 5]]);
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
    // Ambiguous (both x2 and y2) falls back to a regular, non-ranged bar.
    expect(compiled.plots).to.include('bar');
    expect(compiled.plots).not.to.include('rangeBar');
    expect((compiled.series[0] as { type: string }).type).to.equal('bar');
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

  it('draws a fully continuous ranged bar (both axes continuous) as a custom rects overlay', () => {
    // `histogram_log`'s shape: a log-scaled x with explicit x/x2 bin edges,
    // paired with a plain quantitative y count — neither axis is categorical,
    // so x-charts' bar/rangeBar series can't draw this at all.
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x1: 1, x2: 10, count: 3 },
          { x1: 10, x2: 100, count: 5 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'x1', type: 'quantitative', scale: { type: 'log' } },
        x2: { field: 'x2' },
        y: { field: 'count', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(0);
    expect(compiled.overlays).to.deep.equal([
      {
        kind: 'rects',
        items: [
          { x1: 1, x2: 10, y1: 0, y2: 3, fill: '#4c78a8' },
          { x1: 10, x2: 100, y1: 0, y2: 5, fill: '#4c78a8' },
        ],
      },
    ]);
    const gap = compiled.gaps.find(
      (entry) => entry.code === 'mark:bar-continuous-range-custom-overlay',
    );
    expect(gap?.severity).to.equal('ignored');
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('mark:bar-missing-axes');
  });

  it('draws a fully continuous ranged bar with the range on y instead of x', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ y1: 1, y2: 10, count: 3 }] },
      mark: 'bar',
      encoding: {
        y: { field: 'y1', type: 'quantitative', scale: { type: 'log' } },
        y2: { field: 'y2' },
        x: { field: 'count', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.overlays).to.deep.equal([
      { kind: 'rects', items: [{ x1: 0, x2: 3, y1: 1, y2: 10, fill: '#4c78a8' }] },
    ]);
  });

  it('respects an explicit mark color for a fully continuous ranged bar', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x1: 1, x2: 10, count: 3 }] },
      mark: { type: 'bar', color: 'green' },
      encoding: {
        x: { field: 'x1', type: 'quantitative', scale: { type: 'log' } },
        x2: { field: 'x2' },
        y: { field: 'count', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const overlay = compiled.overlays[0] as { items: Array<{ fill?: string }> };
    expect(overlay.items[0].fill).to.equal('green');
  });

  it('falls back to mark:bar-missing-axes for a fully continuous ranged bar with a color split', () => {
    // A color split has no dedicated legend/grouping story for this overlay
    // shape, so it's left unsupported rather than silently dropping colors.
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x1: 1, x2: 10, count: 3, cat: 'A' },
          { x1: 10, x2: 100, count: 5, cat: 'B' },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'x1', type: 'quantitative', scale: { type: 'log' } },
        x2: { field: 'x2' },
        y: { field: 'count', type: 'quantitative' },
        color: { field: 'cat', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-missing-axes');
    expect(gap?.severity).to.equal('unsupported');
    expect(compiled.series).to.have.length(0);
    expect(compiled.overlays).to.have.length(0);
  });

  it('renders a quantitative category axis as a discrete band when the value is aggregated', () => {
    // Trellis-style spec: `age` is numeric (quantitative) but is the category
    // axis; the value channel carries the aggregate. x-charts draws bars over a
    // band scale, so the numeric category axis must be discretized rather than
    // left continuous (which produced no bars and a `mark:bar-missing-axes` gap).
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { age: 10, people: 5 },
          { age: 5, people: 3 },
          { age: 10, people: 2 },
          { age: 0, people: 4 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'age' },
        y: { aggregate: 'sum', field: 'people' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:bar-missing-axes');
    expect(compiled.xAxis?.config.scaleType).to.equal('band');
    // Numeric categories default to ascending order; duplicates are summed.
    expect(compiled.xAxis?.categories).to.deep.equal([0, 5, 10]);
    const series = compiled.series[0] as { data?: Array<number | null> };
    expect(series.data).to.deep.equal([4, 3, 7]);
  });

  it('keeps a quantitative value axis continuous for horizontal bars', () => {
    // The opposite (aggregated) channel must never be discretized: here `amount`
    // is the quantitative value on x and `cat` is the nominal category on y.
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', amount: 3 },
          { cat: 'B', amount: 5 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'amount', aggregate: 'sum', type: 'quantitative' },
        y: { field: 'cat', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.xAxis?.config.scaleType).not.to.equal('band');
    expect(compiled.yAxis?.config.scaleType).to.equal('band');
    const series = compiled.series[0] as { layout?: string };
    expect(series.layout).to.equal('horizontal');
  });

  it('reports a partial gap for mark.cornerRadius and applies it chart-wide', () => {
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
    expect(gap?.severity).to.equal('partial');
    expect(compiled.barBorderRadius).to.equal(6);
  });

  it('does not set barBorderRadius or a gap when cornerRadius is absent', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', amount: 1 }] },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.barBorderRadius).to.equal(undefined);
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:bar-corner-radius');
  });

  it('reports an ignored gap (not silence) for a non-positive or non-numeric cornerRadius', () => {
    const negative = compileSpec({
      data: { values: [{ category: 'A', amount: 1 }] },
      mark: { type: 'bar', cornerRadius: -4 },
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    });
    expect(negative.barBorderRadius).to.equal(undefined);
    const negativeGap = negative.gaps.find((entry) => entry.code === 'mark:bar-corner-radius');
    expect(negativeGap?.severity).to.equal('ignored');

    // A Vega-Lite signal-expression object is a realistic non-numeric shape.
    const signalSpec: VegaLiteSpec = {
      data: { values: [{ category: 'A', amount: 1 }] },
      mark: { type: 'bar', cornerRadius: { signal: 'someExpr' } as unknown as number },
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    };
    const signalCompiled = compileSpec(signalSpec);
    expect(signalCompiled.barBorderRadius).to.equal(undefined);
    const signalGap = signalCompiled.gaps.find((entry) => entry.code === 'mark:bar-corner-radius');
    expect(signalGap?.severity).to.equal('ignored');
  });

  it('reports an ignored gap for a per-corner radius', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ category: 'A', amount: 1 }] },
      mark: { type: 'bar', cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4 },
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:bar-corner-radius-per-corner');
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
