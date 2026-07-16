import { compileSpec } from '../compile';
import type { VegaLiteSpec } from '../types';

describe('compileRectMark', () => {
  it('compiles a two-discrete-axis rect + aggregated color into a single heatmap series', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { day: 'Mon', hour: 9, v: 3 },
          { day: 'Mon', hour: 9, v: 4 },
          { day: 'Mon', hour: 10, v: 5 },
          { day: 'Tue', hour: 9, v: 1 },
          { day: 'Tue', hour: 10, v: 8 },
        ],
      },
      mark: 'rect',
      encoding: {
        x: { field: 'day', type: 'ordinal' },
        y: { field: 'hour', type: 'ordinal' },
        color: { field: 'v', aggregate: 'sum' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.plots).to.deep.equal(['heatmap']);
    expect(compiled.series).to.have.length(1);
    const series = compiled.series[0] as unknown as {
      type: string;
      data: readonly [number, number, number][];
    };
    expect(series.type).to.equal('heatmap');

    // day categories: ['Mon', 'Tue'] (first-appearance order), hour: [9, 10].
    expect(compiled.xAxis?.config.data).to.deep.equal(['Mon', 'Tue']);
    expect(compiled.yAxis?.config.data).to.deep.equal([9, 10]);

    const byCell = new Map(series.data.map(([x, y, value]) => [`${x}_${y}`, value]));
    expect(byCell.get('0_0')).to.equal(7); // Mon/9 -> sum(3, 4)
    expect(byCell.get('0_1')).to.equal(5); // Mon/10
    expect(byCell.get('1_0')).to.equal(1); // Tue/9
    expect(byCell.get('1_1')).to.equal(8); // Tue/10
    expect(series.data).to.have.length(4);

    expect(compiled.zAxis).to.have.length(1);
    const colorMap = compiled.zAxis?.[0].colorMap as {
      type: string;
      min?: number;
      max?: number;
      color: readonly [string, string] | ((t: number) => string);
    };
    expect(colorMap.type).to.equal('continuous');
    expect(colorMap.min).to.equal(1);
    expect(colorMap.max).to.equal(8);
    // The default continuous scheme (`yellowgreenblue`) is multi-hue, so the
    // colorMap carries an interpolator function rather than a two-color pair.
    expect(colorMap.color).to.be.a('function');

    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:rect-not-implemented');
  });

  it('anchors the colorMap extent to rendered cells, ignoring null-bin phantom counts', () => {
    // Binning a positional field that some rows lack produces a `(bin, null)`
    // count group. That group is skipped when building cells (the null bin has
    // no category), but must not stretch the color extent past the darkest
    // drawn cell — otherwise every cell renders lighter than Vega-Lite's.
    const spec: VegaLiteSpec = {
      data: {
        values: [
          // Ten rows with no `y` at all → a single (x-bin, null) group of 10,
          // larger than any real cell but never rendered.
          ...Array.from({ length: 10 }, () => ({ x: 1, y: null })),
          { x: 1, y: 5 },
          { x: 1, y: 5 },
          { x: 1, y: 5 }, // cell (1-bin, 5-bin) -> count 3 (the true max)
          { x: 2, y: 5 },
          { x: 2, y: 8 },
        ],
      },
      mark: 'rect',
      encoding: {
        x: { field: 'x', type: 'ordinal' },
        y: { bin: { maxbins: 10 }, field: 'y', type: 'quantitative' },
        color: { aggregate: 'count', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series[0] as unknown as {
      data: readonly [number, number, number][];
    };
    const maxCell = Math.max(...series.data.map(([, , value]) => value));
    expect(maxCell).to.equal(3);
    const colorMap = compiled.zAxis?.[0].colorMap as { type: string; min?: number; max?: number };
    expect(colorMap.type).to.equal('continuous');
    // Extent tracks the drawn cells (max 3), not the phantom null-bin group (10).
    expect(colorMap.max).to.equal(3);
  });

  it('compiles one row per cell (no aggregation) using an explicit quantitative color type', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 'A', y: 'X', v: 10 },
          { x: 'B', y: 'X', v: 20 },
        ],
      },
      mark: 'rect',
      encoding: {
        x: { field: 'x', type: 'nominal' },
        y: { field: 'y', type: 'nominal' },
        color: { field: 'v', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series[0] as unknown as { data: readonly [number, number, number][] };
    expect(series.data).to.deep.equal([
      [0, 0, 10],
      [1, 0, 20],
    ]);
  });

  it('derives a default colorMap when the color field type is only inferred, not declared', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 'A', y: 'X', v: 2 },
          { x: 'B', y: 'X', v: 6 },
        ],
      },
      mark: 'rect',
      encoding: {
        x: { field: 'x', type: 'nominal' },
        y: { field: 'y', type: 'nominal' },
        color: { field: 'v' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.zAxis).to.have.length(1);
    const colorMap = compiled.zAxis?.[0].colorMap as { type: string; min?: number; max?: number };
    expect(colorMap.type).to.equal('continuous');
    expect(colorMap.min).to.equal(2);
    expect(colorMap.max).to.equal(6);
  });

  it('uses an explicit scale range for the colorMap when the spec configures one', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 'A', y: 'X', v: 2 },
          { x: 'B', y: 'X', v: 8 },
        ],
      },
      mark: 'rect',
      encoding: {
        x: { field: 'x', type: 'nominal' },
        y: { field: 'y', type: 'nominal' },
        color: { field: 'v', type: 'quantitative', scale: { range: ['#000000', '#ffffff'] } },
      },
    };
    const compiled = compileSpec(spec);
    const colorMap = compiled.zAxis?.[0].colorMap as {
      type: string;
      min?: number;
      max?: number;
      color: readonly [string, string];
    };
    expect(colorMap.type).to.equal('continuous');
    expect(colorMap.min).to.equal(2);
    expect(colorMap.max).to.equal(8);
    expect(colorMap.color).to.deep.equal(['#000000', '#ffffff']);
  });

  it('reports an unsupported gap and drops the layer when x2/y2 is present', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 'A', x2: 'B', y: 'X', v: 1 }] },
      mark: 'rect',
      encoding: {
        x: { field: 'x', type: 'nominal' },
        x2: { field: 'x2' },
        y: { field: 'y', type: 'nominal' },
        color: { field: 'v', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(0);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:rect-ranged');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('reports an unsupported gap and drops the layer when a positional channel is quantitative (not discrete)', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 'A', y: 1, v: 1 }] },
      mark: 'rect',
      encoding: {
        x: { field: 'x', type: 'nominal' },
        y: { field: 'y', type: 'quantitative' },
        color: { field: 'v', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(0);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:rect-missing-discrete-axes');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('reports an unsupported gap and drops the layer when the color channel is missing', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 'A', y: 'X' }] },
      mark: 'rect',
      encoding: {
        x: { field: 'x', type: 'nominal' },
        y: { field: 'y', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(0);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:rect-missing-color');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('reports an unsupported gap and drops the layer when the color channel is not quantitative', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 'A', y: 'X', v: 'low' }] },
      mark: 'rect',
      encoding: {
        x: { field: 'x', type: 'nominal' },
        y: { field: 'y', type: 'nominal' },
        color: { field: 'v', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(0);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:rect-non-quantitative-color');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('reports ignored gaps for mark opacity/stroke styling but still renders the heatmap', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 'A', y: 'X', v: 1 }] },
      mark: { type: 'rect', opacity: 0.5, stroke: 'black', strokeWidth: 2 },
      encoding: {
        x: { field: 'x', type: 'nominal' },
        y: { field: 'y', type: 'nominal' },
        color: { field: 'v', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(1);
    const opacityGap = compiled.gaps.find((entry) => entry.code === 'mark:rect-opacity');
    expect(opacityGap?.severity).to.equal('ignored');
    const strokeGap = compiled.gaps.find((entry) => entry.code === 'mark:rect-stroke');
    expect(strokeGap?.severity).to.equal('ignored');
  });

  it('indexes a temporal positional axis correctly (row values are raw date strings, not Date instances)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { day: '2020-01-01', hour: 'AM', v: 3 },
          { day: '2020-01-02', hour: 'AM', v: 9 },
        ],
      },
      mark: 'rect',
      encoding: {
        x: { field: 'day', type: 'temporal' },
        y: { field: 'hour', type: 'nominal' },
        color: { field: 'v', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series[0] as unknown as { data: readonly [number, number, number][] };
    // Both rows must land in the grid (not be dropped as unresolvable positions).
    expect(series.data).to.have.length(2);
    const values = series.data.map(([, , value]) => value).sort();
    expect(values).to.deep.equal([3, 9]);
  });

  it('skips rows whose position or value cannot be resolved instead of throwing', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 'A', y: 'X', v: 1 },
          { x: 'A', y: 'X', v: 'not-a-number' },
          { x: null, y: 'X', v: 2 },
        ],
      },
      mark: 'rect',
      encoding: {
        x: { field: 'x', type: 'nominal' },
        y: { field: 'y', type: 'nominal' },
        color: { field: 'v', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series[0] as unknown as { data: readonly unknown[] };
    expect(series.data).to.have.length(1);
  });
});
