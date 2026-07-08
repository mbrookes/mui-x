import { compileSpec } from '../compile';
import type { VegaLiteSpec } from '../types';

describe('compilePointMark', () => {
  it('compiles a quantitative x/y point mark into a single scatter series aligned to the rows', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { horsepower: 130, mpg: 18 },
          { horsepower: 165, mpg: 15 },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'horsepower', type: 'quantitative' },
        y: { field: 'mpg', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.plots).to.deep.equal(['scatter']);
    expect(compiled.series).to.have.length(1);
    const series = compiled.series[0] as unknown as {
      type: string;
      data: { x: number; y: number; id: number }[];
    };
    expect(series.type).to.equal('scatter');
    expect(series.data).to.deep.equal([
      { x: 130, y: 18, id: 0 },
      { x: 165, y: 15, id: 1 },
    ]);
    expect(compiled.gaps).to.have.length(0);
  });

  it('renders a strip plot (nominal x, quantitative y) using the category values as x', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { group: 'A', value: 3 },
          { group: 'B', value: 7 },
        ],
      },
      mark: 'circle',
      encoding: {
        x: { field: 'group', type: 'nominal' },
        y: { field: 'value', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.xAxis?.config.scaleType).to.equal('point');
    const series = compiled.series[0] as unknown as { data: { x: unknown; y: unknown }[] };
    expect(series.data).to.deep.equal([
      { x: 'A', y: 3, id: 0 },
      { x: 'B', y: 7, id: 1 },
    ]);
    // `circle` has no shape gaps of its own.
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:point-square-shape');
  });

  it('splits into one series per color group, ordered and colored by the scale domain/range', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, region: 'east' },
          { x: 2, y: 2, region: 'west' },
          { x: 3, y: 3, region: 'east' },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        color: {
          field: 'region',
          type: 'nominal',
          scale: { domain: ['west', 'east'], range: ['#111111', '#222222'] },
        },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(2);
    const [west, east] = compiled.series as unknown as {
      label?: string;
      color?: string;
      data: { x: number; y: number }[];
    }[];
    expect(west.label).to.equal('west');
    expect(west.color).to.equal('#111111');
    expect(west.data).to.deep.equal([{ x: 2, y: 2, id: 1 }]);
    expect(east.label).to.equal('east');
    expect(east.color).to.equal('#222222');
    expect(east.data).to.deep.equal([
      { x: 1, y: 1, id: 0 },
      { x: 3, y: 3, id: 2 },
    ]);
  });

  it('approximates mark.size with a square root and reports a partial gap', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1 }] },
      mark: { type: 'point', size: 100 },
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series[0] as unknown as { markerSize?: number };
    expect(series.markerSize).to.equal(10);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:point-size-approximation');
    expect(gap?.severity).to.equal('partial');
  });

  it('reports a partial gap for a quantitative size field encoding (no per-point size in MIT scatter)', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1, weight: 5 }] },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        size: { field: 'weight', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'encoding:size-field');
    expect(gap?.severity).to.equal('partial');
    // The layer still renders (degrade gracefully, not drop the mark).
    expect(compiled.series).to.have.length(1);
  });

  it('reports an ignored gap for the shape encoding', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1, kind: 'a' }] },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        shape: { field: 'kind', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'encoding:shape');
    expect(gap?.severity).to.equal('ignored');
  });

  it('reports an ignored gap for the square mark shape but still renders a scatter series', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1 }] },
      mark: 'square',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:point-square-shape');
    expect(gap?.severity).to.equal('ignored');
    expect(compiled.plots).to.include('scatter');
  });

  it('reports a partial gap for the tick mark and renders it as scatter points', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1 }] },
      mark: 'tick',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:point-tick');
    expect(gap?.severity).to.equal('partial');
    expect(compiled.plots).to.include('scatter');
  });

  it('reports separate ignored gaps for filled:false and opacity styling', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1 }] },
      mark: { type: 'point', filled: false, opacity: 0.5 },
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const filledGap = compiled.gaps.find((entry) => entry.code === 'mark:point-filled');
    expect(filledGap?.severity).to.equal('ignored');
    const opacityGap = compiled.gaps.find((entry) => entry.code === 'encoding:opacity');
    expect(opacityGap?.severity).to.equal('ignored');
  });

  it('drops the layer with an unsupported gap when a positional channel is missing', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1 }] },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(0);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:point-missing-axis');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('drops the layer with an unsupported gap when a positional channel is a value/datum def (no field)', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1 }] },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { value: 0 },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(0);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:point-missing-axis');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('skips rows whose positional value cannot be coerced instead of throwing', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1 },
          { x: 'not-a-number', y: 2 },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series[0] as unknown as { data: unknown[] };
    expect(series.data).to.have.length(1);
  });

  it('positions points correctly on a temporal (point-scale) x axis using Date values', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { day: '2020-01-01', value: 3 },
          { day: '2020-01-02', value: 7 },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'day', type: 'temporal' },
        y: { field: 'value', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.xAxis?.config.scaleType).to.equal('point');
    const series = compiled.series[0] as unknown as { data: { x: unknown; y: number }[] };
    expect(series.data).to.have.length(2);
    expect(series.data[0].x).to.be.instanceOf(Date);
    expect((series.data[0].x as Date).getTime()).to.equal(new Date('2020-01-01').getTime());
    expect(series.data[1].y).to.equal(7);
  });

  it('groups rows with a null/undefined color field value instead of dropping them', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, region: 'east' },
          { x: 2, y: 2, region: null },
          { x: 3, y: 3 },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        color: { field: 'region', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    // 3 rows in, 3 rows rendered total across whatever series result — none
    // silently dropped just for having a missing color value.
    const totalPoints = (compiled.series as unknown as { data: unknown[] }[]).reduce(
      (sum, entry) => sum + entry.data.length,
      0,
    );
    expect(totalPoints).to.equal(3);
  });

  it('assigns each row a distinct point id even when two rows are the same object reference', () => {
    const sharedRow = { x: 1, y: 1 };
    const spec: VegaLiteSpec = {
      data: { values: [sharedRow, sharedRow, { x: 2, y: 2 }] },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const series = compiled.series[0] as unknown as { data: { id: number }[] };
    const ids = series.data.map((datum) => datum.id);
    expect(ids).to.deep.equal([0, 1, 2]);
    expect(new Set(ids).size).to.equal(3);
  });
});
