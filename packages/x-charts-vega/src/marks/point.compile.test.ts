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
    // A `point` mark carries Vega-Lite's default 0.7 opacity (unopinionated
    // markers stay visible when overlapping), baked into the resolved color.
    expect(west.label).to.equal('west');
    expect(west.color).to.equal('rgba(17, 17, 17, 0.7)');
    expect(west.data).to.deep.equal([{ x: 2, y: 2, id: 1 }]);
    expect(east.label).to.equal('east');
    expect(east.color).to.equal('rgba(34, 34, 34, 0.7)');
    expect(east.data).to.deep.equal([
      { x: 1, y: 1, id: 0 },
      { x: 3, y: 3, id: 2 },
    ]);
  });

  it('converts mark.size (a symbol area) to a circle radius and reports a partial gap', () => {
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
    // Vega-Lite `size` is an area; x-charts `markerSize` is a radius: r = sqrt(area/π).
    expect(series.markerSize).to.equal(Math.sqrt(100 / Math.PI));
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:point-size-approximation');
    expect(gap?.severity).to.equal('partial');
  });

  it('maps a quantitative size field to per-point sizeValue + a zAxis sizeMap (bubble chart), with no gap', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, weight: 5 },
          { x: 2, y: 2, weight: 15 },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        size: { field: 'weight', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    // Fully supported now — no partial gap for the quantitative case.
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('encoding:size-field');
    expect(compiled.series).to.have.length(1);
    const series = compiled.series[0] as unknown as {
      data: Array<{ x: number; y: number; sizeValue?: number }>;
    };
    expect(series.data.map((datum) => datum.sizeValue)).to.deep.equal([5, 15]);
    expect(compiled.zAxis).to.have.length(1);
    const zAxis = compiled.zAxis![0] as unknown as {
      min?: number;
      max?: number;
      sizeMap?: { type: string; size: [number, number]; interpolator?: string };
    };
    // Vega-Lite defaults `zero: true` for the size scale: the domain starts
    // at 0, not the data minimum (5), unless `scale.zero: false` opts out.
    expect(zAxis.min).to.equal(0);
    expect(zAxis.max).to.equal(15);
    expect(zAxis.sizeMap?.type).to.equal('continuous');
    // Radius range matching Vega-Lite's default point size (area up to 361 →
    // radius ≈ 10.7), with a `sqrt` interpolator so area ∝ value.
    expect(zAxis.sizeMap?.size).to.deep.equal([0, 11]);
  });

  it('honors an explicit size scale.domain/.range instead of the data extent + default [0, 11] radius range', () => {
    // Vega-Lite's scale.domain pins the size axis independent of this layer's
    // own data extent (e.g. so bubble sizes stay comparable across multiple
    // views), and scale.range is a [minArea, maxArea] symbol-area pair —
    // converted to sizeMap's marker-radius range via r = sqrt(area/π), the
    // same conversion mark.size uses. Previously both were silently ignored
    // with no gap (interactive_seattle_weather/dynamic_color_legend).
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, weight: 10 },
          { x: 2, y: 2, weight: 500 },
        ],
      },
      mark: 'circle',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        size: {
          field: 'weight',
          type: 'quantitative',
          scale: { domain: [0, 1000], range: [0, 200] },
        },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.gaps).to.have.length(0);
    const zAxis = compiled.zAxis![0] as unknown as {
      min?: number;
      max?: number;
      sizeMap?: { size: [number, number] };
    };
    expect(zAxis.min).to.equal(0);
    expect(zAxis.max).to.equal(1000);
    expect(zAxis.sizeMap?.size).to.deep.equal([0, Math.sqrt(200 / Math.PI)]);
  });

  it('reports an unsupported gap for a discretizing size scale (quantile/quantize/threshold)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, weight: 10 },
          { x: 2, y: 2, weight: 20 },
        ],
      },
      mark: 'circle',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        size: {
          field: 'weight',
          type: 'quantitative',
          scale: { type: 'quantile', range: [80, 160, 240] } as never,
        },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find((entry) => entry.code === 'encoding:size-scale-discretizing');
    expect(gap?.severity).to.equal('unsupported');
    // Falls back to the plain continuous default rather than misreading the
    // per-band size list as a two-element continuous range.
    const zAxis = compiled.zAxis![0] as unknown as { sizeMap?: { size: [number, number] } };
    expect(zAxis.sizeMap?.size).to.deep.equal([0, 11]);
  });

  it('reports a partial gap for a size scale.range with a non-numeric endpoint (e.g. a signal expression)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, weight: 10 },
          { x: 2, y: 2, weight: 20 },
        ],
      },
      mark: 'circle',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        size: {
          field: 'weight',
          type: 'quantitative',
          scale: { domain: [0, 100], range: [0, { expr: 'earthquakeSize' }] as never },
        },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find(
      (entry) => entry.code === 'encoding:size-scale-range-unsupported',
    );
    expect(gap?.severity).to.equal('partial');
    const zAxis = compiled.zAxis![0] as unknown as { sizeMap?: { size: [number, number] } };
    expect(zAxis.sizeMap?.size).to.deep.equal([0, 11]);
  });

  it('reports a partial gap for a non-quantitative size field (no x-charts size-scale equivalent)', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1, tier: 'gold' }] },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        size: { field: 'tier', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    const gap = compiled.gaps.find(
      (entry) => entry.code === 'encoding:size-field-non-quantitative',
    );
    expect(gap?.severity).to.equal('partial');
    expect(compiled.series).to.have.length(1);
    expect(compiled.zAxis).to.equal(undefined);
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

  it('renders the tick mark as a segments overlay instead of a scatter series', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
        ],
      },
      mark: 'tick',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    // Tick no longer falls back to circular scatter markers.
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('mark:point-tick');
    expect(compiled.series).to.have.length(0);
    expect(compiled.plots).not.to.include('scatter');
    expect(compiled.overlays).to.have.length(1);
    const overlay = compiled.overlays[0];
    expect(overlay.kind).to.equal('segments');
    const items = (
      overlay as { items: Array<{ x1: unknown; y1: unknown; x2: unknown; y2: unknown }> }
    ).items;
    expect(items).to.have.length(2);
    // Degenerate segments (x1 === x2, y1 === y2) — see src/overlays/Segments.tsx.
    items.forEach((item) => {
      expect(item.x1).to.equal(item.x2);
      expect(item.y1).to.equal(item.y2);
    });
    // x-charts has no tick-mark primitive — this must still surface as an
    // ignored, x-charts-origin gap, not read as a silently-native render.
    const overlayGap = compiled.gaps.find((entry) => entry.code === 'mark:tick-custom-overlay');
    expect(overlayGap?.severity).to.equal('ignored');
    expect(overlayGap?.origin).to.equal('x-charts');
  });

  it("passes an explicit tick `mark.size` through as the segment's pixel tickLength", () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1 }] },
      mark: { type: 'tick', size: 8 },
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const overlay = compiled.overlays[0] as { items: Array<{ tickLength?: number }> };
    expect(overlay.items[0].tickLength).to.equal(8);
  });

  it('omits tickLength when the tick mark has no explicit `size` (Segments.tsx falls back to its bandwidth-ratio default)', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1 }] },
      mark: 'tick',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    const overlay = compiled.overlays[0] as { items: Array<{ tickLength?: number }> };
    expect(overlay.items[0].tickLength).to.equal(undefined);
  });

  it('renders a 1D strip plot (tick with only x) over a synthetic perpendicular band', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ p: 0.5 }, { p: 1.2 }, { p: 3.4 }] },
      mark: 'tick',
      encoding: {
        x: { field: 'p', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    // No longer dropped for a missing y channel.
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('mark:point-missing-axis');
    // The perpendicular axis is synthesized as a one-category band.
    expect(compiled.yAxis?.synthetic).to.equal(true);
    expect(compiled.yAxis?.config.scaleType).to.equal('band');
    const overlay = compiled.overlays[0] as {
      kind: string;
      items: Array<{ x1: unknown; y1: unknown }>;
    };
    expect(overlay.kind).to.equal('segments');
    // One tick per row, each anchored to the lone synthetic category on y.
    expect(overlay.items).to.have.length(3);
    overlay.items.forEach((item) => {
      expect(item.y1).to.equal('');
    });
    expect(overlay.items.map((item) => item.x1)).to.deep.equal([0.5, 1.2, 3.4]);
  });

  it('colors tick segments per color-field group using the palette/domain order, without creating scatter series', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, region: 'east' },
          { x: 2, y: 1, region: 'west' },
        ],
      },
      mark: 'tick',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        color: { field: 'region', type: 'nominal' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.series).to.have.length(0);
    const overlay = compiled.overlays[0] as { items: Array<{ style?: { stroke?: string } }> };
    expect(overlay.items).to.have.length(2);
    expect(overlay.items[0].style?.stroke).to.be.a('string');
    expect(overlay.items[1].style?.stroke).to.be.a('string');
    expect(overlay.items[0].style?.stroke).not.to.equal(overlay.items[1].style?.stroke);
  });

  it('honors a layer-local literal `{value: N}` y position instead of the chart-wide field-based axis (parallel_coordinate fixed tick rows)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { key: 'a', norm: 0.2 },
          { key: 'b', norm: 0.8 },
        ],
      },
      layer: [
        // Establishes the chart-wide field-based y axis, inherited by the
        // tick layer below (which has no field-based y of its own).
        {
          mark: 'line',
          encoding: {
            x: { field: 'key', type: 'nominal' },
            y: { field: 'norm', type: 'quantitative' },
          },
        },
        {
          mark: { type: 'tick' },
          encoding: {
            x: { field: 'key', type: 'nominal' },
            y: { value: 150 },
          },
        },
      ],
    };
    const compiled = compileSpec(spec);
    const tickOverlay = compiled.overlays.find((overlay) => overlay.kind === 'segments') as {
      items: Array<{ y1: unknown; y2: unknown }>;
    };
    expect(tickOverlay).not.to.equal(undefined);
    expect(tickOverlay.items).to.have.length(2);
    // Every tick pins to the literal pixel value, not the shared `norm` axis
    // (which would have scattered them across 0.2/0.8 instead).
    tickOverlay.items.forEach((item) => {
      expect(item.y1).to.deep.equal({ pixel: 150 });
      expect(item.y2).to.deep.equal({ pixel: 150 });
    });
  });

  it('bakes a static mark opacity into the marker color (no gap); still gaps strokeOpacity', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1 }] },
      mark: { type: 'point', filled: false, opacity: 0.5 },
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    // `filled: false` now renders hollow markers (via the shell's marker slot)
    // instead of being dropped with a gap: the series id is flagged as hollow.
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('mark:point-filled');
    expect(compiled.hollowSeriesIds).to.include((compiled.series[0] as { id: string }).id);
    // A constant opacity is applied via the color's alpha, not reported as a gap.
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('encoding:opacity');
    const color = (compiled.series[0] as { color?: string }).color ?? '';
    expect(color).to.match(/^rgba\(/);

    // strokeOpacity has no single-color equivalent and stays ignored.
    const withStroke = compileSpec({
      data: { values: [{ x: 1, y: 1 }] },
      mark: { type: 'point', strokeOpacity: 0.3 },
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    });
    const strokeGap = withStroke.gaps.find((entry) => entry.code === 'encoding:opacity');
    expect(strokeGap?.severity).to.equal('ignored');
  });

  it('flags a bare `point` mark as hollow by default, but not `circle`', () => {
    const encoding = {
      x: { field: 'x', type: 'quantitative' as const },
      y: { field: 'y', type: 'quantitative' as const },
    };
    const values = [{ x: 1, y: 1 }];

    const point = compileSpec({ data: { values }, mark: 'point', encoding });
    expect(point.hollowSeriesIds).to.include((point.series[0] as { id: string }).id);

    const circle = compileSpec({ data: { values }, mark: 'circle', encoding });
    expect(circle.hollowSeriesIds).to.equal(undefined);

    // An explicit `filled: true` overrides the `point` default back to solid.
    const filledPoint = compileSpec({
      data: { values },
      mark: { type: 'point', filled: true },
      encoding,
    });
    expect(filledPoint.hollowSeriesIds).to.equal(undefined);
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

  it('positions points correctly on a temporal (continuous time-scale) x axis using Date values', () => {
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
    expect(compiled.xAxis?.config.scaleType).to.equal('time');
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

  describe('geo-projected (longitude/latitude) points', () => {
    it('draws a geoPoints overlay and resolves its own projection for a standalone lon/lat spec (geo_circle-shaped)', () => {
      const spec: VegaLiteSpec = {
        projection: { type: 'albersUsa' },
        data: {
          values: [
            { longitude: -72.6, latitude: 40.9, digit: '1' },
            { longitude: -73.9, latitude: 40.7, digit: '2' },
          ],
        },
        mark: 'circle',
        encoding: {
          longitude: { field: 'longitude', type: 'quantitative' },
          latitude: { field: 'latitude', type: 'quantitative' },
        },
      };
      const compiled = compileSpec(spec);
      expect(compiled.chartKind).to.equal('geo');
      expect(compiled.series).to.have.length(0);
      const overlay = compiled.overlays.find((entry) => entry.kind === 'geoPoints') as
        Extract<(typeof compiled.overlays)[number], { kind: 'geoPoints' }> | undefined;
      expect(overlay?.items).to.deep.equal([
        { lon: -72.6, lat: 40.9, radius: overlay?.items[0].radius, color: overlay?.items[0].color },
        { lon: -73.9, lat: 40.7, radius: overlay?.items[1].radius, color: overlay?.items[1].color },
      ]);
      // No sibling geoshape layer: this layer must resolve its own projection.
      expect(typeof compiled.geo?.projection).to.equal('function');
      expect(compiled.gaps.map((gap) => gap.code)).to.include(
        'mark:point-geo-projected-custom-overlay',
      );
    });

    it('honors encoding.size: {value: N} (a constant set via the size channel, not mark.size)', () => {
      const spec: VegaLiteSpec = {
        projection: { type: 'mercator' },
        data: { values: [{ longitude: 0, latitude: 0 }] },
        mark: 'circle',
        encoding: {
          longitude: { field: 'longitude', type: 'quantitative' },
          latitude: { field: 'latitude', type: 'quantitative' },
          size: { value: 10 } as never,
        },
      };
      const compiled = compileSpec(spec);
      const overlay = compiled.overlays.find((entry) => entry.kind === 'geoPoints') as
        Extract<(typeof compiled.overlays)[number], { kind: 'geoPoints' }> | undefined;
      expect(overlay?.items[0].radius).to.be.closeTo(Math.sqrt(10 / Math.PI), 1e-9);
    });

    it("defers to a sibling geoshape layer's projection/geoData instead of setting its own (geo_layer-shaped)", () => {
      const spec: VegaLiteSpec = {
        projection: { type: 'albersUsa' },
        layer: [
          {
            data: {
              values: [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'Polygon', coordinates: [[[0, 0]]] },
                },
              ],
            },
            mark: { type: 'geoshape', fill: 'lightgray' },
          },
          {
            data: { values: [{ longitude: -89.2, latitude: 31.9 }] },
            mark: 'circle',
            encoding: {
              longitude: { field: 'longitude', type: 'quantitative' },
              latitude: { field: 'latitude', type: 'quantitative' },
            },
          },
        ],
      };
      const compiled = compileSpec(spec);
      expect(compiled.chartKind).to.equal('geo');
      expect(compiled.plots).to.include('geoBase');
      const overlay = compiled.overlays.find((entry) => entry.kind === 'geoPoints');
      expect(overlay).to.not.equal(undefined);
      // No `composition:multiple-geo-layers` gap: the point layer deferred to
      // the geoshape's own geo instead of also trying to set one.
      expect(compiled.gaps.map((gap) => gap.code)).to.not.include(
        'composition:multiple-geo-layers',
      );
    });

    it('reports mark:point-geo-missing-fields and drops the layer when longitude/latitude have no field', () => {
      const spec: VegaLiteSpec = {
        data: { values: [{ a: 1 }] },
        mark: 'circle',
        encoding: {
          // `aggregate` with no `field` still satisfies `isFieldDef`, so this
          // reaches `compileGeoPointMark` — which then has no field to read.
          longitude: { aggregate: 'sum' } as never,
          latitude: { aggregate: 'sum' } as never,
        },
      };
      const compiled = compileSpec(spec);
      expect(compiled.series).to.have.length(0);
      expect(compiled.overlays).to.have.length(0);
      expect(compiled.gaps.map((gap) => gap.code)).to.include('mark:point-geo-missing-fields');
    });
  });
});
