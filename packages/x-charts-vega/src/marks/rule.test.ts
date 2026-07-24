import { compileSpec } from '../compile';
import type { VegaLiteSpec } from '../types';

describe('compileRuleMark', () => {
  it('emits a horizontal reference line for a datum-based y rule layered with another mark', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 2 },
          { x: 2, y: 5 },
        ],
      },
      layer: [
        {
          mark: 'line',
          encoding: {
            x: { field: 'x', type: 'quantitative' },
            y: { field: 'y', type: 'quantitative' },
          },
        },
        {
          mark: 'rule',
          encoding: { y: { datum: 3 } },
        },
      ],
    };
    const compiled = compileSpec(spec);
    expect(compiled.referenceLines).to.deep.equal([{ axis: 'y', value: 3, lineStyle: undefined }]);
  });

  it('emits a vertical reference line for a single aggregated x value', () => {
    const compiled = compileSpec({
      data: { values: [{ v: 1 }, { v: 3 }, { v: 5 }] },
      mark: 'rule',
      encoding: { x: { field: 'v', aggregate: 'mean', type: 'quantitative' } },
    });
    expect(compiled.referenceLines).to.deep.equal([{ axis: 'x', value: 3, lineStyle: undefined }]);
  });

  it('emits one reference line per distinct value for a per-datum field rule, capped at 10', () => {
    const values = Array.from({ length: 12 }, (_, index) => ({ threshold: index }));
    const compiled = compileSpec({
      data: { values },
      mark: 'rule',
      encoding: { y: { field: 'threshold', type: 'quantitative' } },
    });
    expect(compiled.referenceLines).to.have.length(10);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:rule-too-many-lines');
    expect(gap?.severity).to.equal('partial');
  });

  it('drops a genuinely-unanchorable x/x2 span (no y/yOffset, no categorical y axis) with a partial gap', () => {
    const compiled = compileSpec({
      data: { values: [{ xStart: 1, xEnd: 5 }] },
      mark: 'rule',
      encoding: {
        x: { field: 'xStart', type: 'quantitative' },
        x2: { field: 'xEnd' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:rule-segment-x-no-anchor');
    expect(gap?.severity).to.equal('partial');
    expect(compiled.referenceLines).to.have.length(0);
    expect(compiled.overlays).to.have.length(0);
  });

  it('drops a genuinely-unanchorable y/y2 span (no x/xOffset, no categorical x axis) with a partial gap', () => {
    const compiled = compileSpec({
      data: { values: [{ yStart: 1, yEnd: 5 }] },
      mark: 'rule',
      encoding: {
        y: { field: 'yStart', type: 'quantitative' },
        y2: { field: 'yEnd' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:rule-segment-y-no-anchor');
    expect(gap?.severity).to.equal('partial');
    expect(compiled.overlays).to.have.length(0);
  });

  it('builds an x/x2 segments overlay anchored at `yOffset` when there is no `y` encoding', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { xStart: 1, xEnd: 5, level: 2 },
          { xStart: 2, xEnd: 3, level: 4 },
        ],
      },
      mark: 'rule',
      encoding: {
        x: { field: 'xStart', type: 'quantitative' },
        x2: { field: 'xEnd' },
        yOffset: { field: 'level', type: 'quantitative' },
      },
    });
    const codes = compiled.gaps.map((entry) => entry.code);
    expect(codes).not.to.include('mark:rule-segment-x-no-anchor');
    expect(compiled.overlays).to.have.length(1);
    const overlay = compiled.overlays[0] as { kind: string; items: unknown[] };
    expect(overlay.kind).to.equal('segments');
    expect(overlay.items).to.deep.equal([
      { x1: 1, x2: 5, y1: 2, y2: 2, style: undefined },
      { x1: 2, x2: 3, y1: 4, y2: 4, style: undefined },
    ]);
    // x-charts has no span-rule primitive — this must still surface as an
    // ignored, x-charts-origin gap, not read as a silently-native render.
    const overlayGap = compiled.gaps.find(
      (entry) => entry.code === 'mark:rule-segment-custom-overlay',
    );
    expect(overlayGap?.severity).to.equal('ignored');
    expect(overlayGap?.origin).to.equal('x-charts');
  });

  it('builds a y/y2 segments overlay anchored at `xOffset` when there is no `x` encoding', () => {
    const compiled = compileSpec({
      data: { values: [{ yStart: 1, yEnd: 9, slot: 3 }] },
      mark: 'rule',
      encoding: {
        y: { field: 'yStart', type: 'quantitative' },
        y2: { field: 'yEnd' },
        xOffset: { field: 'slot', type: 'quantitative' },
      },
    });
    const codes = compiled.gaps.map((entry) => entry.code);
    expect(codes).not.to.include('mark:rule-segment-y-no-anchor');
    expect(compiled.overlays).to.have.length(1);
    const overlay = compiled.overlays[0] as { items: unknown[] };
    expect(overlay.items).to.deep.equal([{ x1: 3, x2: 3, y1: 1, y2: 9, style: undefined }]);
  });

  it('distributes an x/x2 span across the bands of a categorical y axis shared from another layer', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { cat: 'A', v: 10, xStart: 1, xEnd: 5 },
          { cat: 'B', v: 20, xStart: 2, xEnd: 4 },
        ],
      },
      layer: [
        {
          mark: 'bar',
          encoding: {
            y: { field: 'cat', type: 'nominal' },
            x: { field: 'v', type: 'quantitative' },
          },
        },
        {
          mark: 'rule',
          encoding: {
            x: { field: 'xStart', type: 'quantitative' },
            x2: { field: 'xEnd' },
          },
        },
      ],
    });
    const codes = compiled.gaps.map((entry) => entry.code);
    expect(codes).not.to.include('mark:rule-segment-x-no-anchor');
    const overlay = compiled.overlays.find((entry) => entry.kind === 'segments') as {
      items: Array<{ x1: unknown; x2: unknown; y1: unknown; y2: unknown }>;
    };
    expect(overlay).not.to.equal(undefined);
    // Each row is anchored at its row-index category (A, then B).
    expect(overlay.items).to.deep.equal([
      { x1: 1, x2: 5, y1: 'A', y2: 'A', style: undefined },
      { x1: 2, x2: 4, y1: 'B', y2: 'B', style: undefined },
    ]);
  });

  it('builds a horizontal segments overlay per row from x/x2 anchored at the row y', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { xStart: 1, xEnd: 5, y: 10 },
          { xStart: 2, xEnd: 3, y: 20 },
        ],
      },
      mark: 'rule',
      encoding: {
        x: { field: 'xStart', type: 'quantitative' },
        x2: { field: 'xEnd' },
        y: { field: 'y', type: 'quantitative' },
      },
    });
    expect(compiled.overlays).to.have.length(1);
    const overlay = compiled.overlays[0];
    expect(overlay.kind).to.equal('segments');
    expect((overlay as { items: unknown[] }).items).to.deep.equal([
      { x1: 1, x2: 5, y1: 10, y2: 10, style: undefined },
      { x1: 2, x2: 3, y1: 20, y2: 20, style: undefined },
    ]);
    // No reference lines/point-approximation gap should fire for the
    // segment case.
    expect(compiled.referenceLines).to.have.length(0);
  });

  it('colors each segment by the color field on an x/x2 span (e.g. a Gantt by task)', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { task: 'Design', start: 0, end: 3 },
          { task: 'Build', start: 3, end: 8 },
        ],
      },
      mark: 'rule',
      encoding: {
        x: { field: 'start', type: 'quantitative' },
        x2: { field: 'end' },
        y: { field: 'task', type: 'nominal' },
        color: {
          field: 'task',
          type: 'nominal',
          scale: { domain: ['Design', 'Build'], range: ['#111111', '#222222'] },
        },
      },
    });
    const overlay = compiled.overlays.find((entry) => entry.kind === 'segments') as {
      items: Array<{ style?: { stroke?: string } }>;
    };
    // Each segment carries its own color-group stroke (not one shared style).
    expect(overlay.items.map((item) => item.style?.stroke)).to.deep.equal(['#111111', '#222222']);
  });

  it('builds a vertical segments overlay per row from y/y2 anchored at the row x', () => {
    const compiled = compileSpec({
      data: {
        values: [{ x: 7, yStart: 1, yEnd: 9 }],
      },
      mark: 'rule',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'yStart', type: 'quantitative' },
        y2: { field: 'yEnd' },
      },
    });
    expect(compiled.overlays).to.have.length(1);
    const overlay = compiled.overlays[0];
    expect((overlay as { items: unknown[] }).items).to.deep.equal([
      { x1: 7, x2: 7, y1: 1, y2: 9, style: undefined },
    ]);
  });

  it('builds a diagonal segments overlay per row when x, y, x2 and y2 are all set', () => {
    const compiled = compileSpec({
      data: { values: [{ x1: 1, y1: 2, x2: 3, y2: 4 }] },
      mark: 'rule',
      encoding: {
        x: { field: 'x1', type: 'quantitative' },
        y: { field: 'y1', type: 'quantitative' },
        x2: { field: 'x2' },
        y2: { field: 'y2' },
      },
    });
    expect(compiled.overlays).to.have.length(1);
    const overlay = compiled.overlays[0];
    expect((overlay as { items: unknown[] }).items).to.deep.equal([
      { x1: 1, x2: 3, y1: 2, y2: 4, style: undefined },
    ]);
  });

  it('applies mark color/strokeWidth/strokeDash to segment items', () => {
    const compiled = compileSpec({
      data: { values: [{ xStart: 1, xEnd: 5, y: 10 }] },
      mark: { type: 'rule', color: 'red', strokeWidth: 2, strokeDash: [4, 2] },
      encoding: {
        x: { field: 'xStart', type: 'quantitative' },
        x2: { field: 'xEnd' },
        y: { field: 'y', type: 'quantitative' },
      },
    });
    const overlay = compiled.overlays[0] as { items: Array<{ style?: unknown }> };
    expect(overlay.items[0].style).to.deep.equal({
      stroke: 'red',
      strokeWidth: 2,
      strokeDasharray: '4 2',
    });
  });

  it('reports a partial gap for a literal `value` x2 endpoint and approximates it as a data value', () => {
    const compiled = compileSpec({
      data: { values: [{ x: 1, y: 10 }] },
      mark: 'rule',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        x2: { value: 200 },
        y: { field: 'y', type: 'quantitative' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:rule-x2-value-position');
    expect(gap?.severity).to.equal('partial');
    const overlay = compiled.overlays[0] as { items: Array<{ x2: unknown }> };
    expect(overlay.items[0].x2).to.equal(200);
  });

  it('maps mark color/strokeWidth/strokeDash to lineStyle', () => {
    const compiled = compileSpec({
      data: { values: [{ y: 10 }] },
      mark: { type: 'rule', color: 'red', strokeWidth: 2, strokeDash: [4, 2] },
      encoding: { y: { field: 'y', type: 'quantitative' } },
    });
    expect(compiled.referenceLines).to.deep.equal([
      {
        axis: 'y',
        value: 10,
        lineStyle: { stroke: 'red', strokeWidth: 2, strokeDasharray: '4 2' },
      },
    ]);
  });

  it('reports a partial gap for a literal `value` on a positional channel (pixel space, not data space)', () => {
    const compiled = compileSpec({
      data: { values: [{ a: 1 }] },
      mark: 'rule',
      encoding: { y: { value: 50 } },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:rule-y-value-position');
    expect(gap?.severity).to.equal('partial');
    expect(compiled.referenceLines).to.deep.equal([{ axis: 'y', value: 50, lineStyle: undefined }]);
  });

  it('draws a scatter-marker point (not crossing reference lines) when both x and y are set, with a partial gap', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
      mark: 'rule',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    });
    const gap = compiled.gaps.find(
      (entry) => entry.code === 'mark:rule-point-scatter-approximated',
    );
    expect(gap?.severity).to.equal('partial');
    expect(compiled.referenceLines).to.deep.equal([]);
    expect(compiled.series).to.have.length(1);
    const series = compiled.series[0] as unknown as {
      type: string;
      data: { x: number; y: number; id: number }[];
    };
    expect(series.type).to.equal('scatter');
    expect(series.data).to.deep.equal([
      { x: 1, y: 2, id: 0 },
      { x: 3, y: 4, id: 1 },
    ]);
  });

  it('uses mark.color as the scatter marker color for an x/y point rule', () => {
    const compiled = compileSpec({
      data: { values: [{ x: 1, y: 2 }] },
      mark: { type: 'rule', color: 'firebrick' },
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    } as unknown as VegaLiteSpec);
    const series = compiled.series[0] as unknown as { color?: string };
    expect(series.color).to.equal('firebrick');
  });

  it('drops the point marker entirely (no series, still the gap) when no row resolves to a plottable position', () => {
    const compiled = compileSpec({
      data: { values: [{ x: null, y: null }] },
      mark: 'rule',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    } as unknown as VegaLiteSpec);
    expect(compiled.series).to.have.length(0);
    const gap = compiled.gaps.find(
      (entry) => entry.code === 'mark:rule-point-scatter-approximated',
    );
    expect(gap?.severity).to.equal('partial');
  });

  it('reports a partial gap when no axis is resolved anywhere in the spec', () => {
    const compiled = compileSpec({
      data: { values: [{ a: 1 }] },
      mark: 'rule',
      encoding: {},
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:rule-no-axis');
    expect(gap?.severity).to.equal('partial');
    expect(compiled.referenceLines).to.have.length(0);
  });

  describe('geo-projected (longitude/latitude) rules', () => {
    it('draws a geoSegments overlay for a longitude/latitude/longitude2/latitude2 rule (geo_rule-shaped)', () => {
      const compiled = compileSpec({
        projection: { type: 'albersUsa' },
        data: {
          values: [{ lon1: -122.3, lat1: 47.6, lon2: -73.9, lat2: 40.7 }],
        },
        mark: 'rule',
        encoding: {
          longitude: { field: 'lon1', type: 'quantitative' },
          latitude: { field: 'lat1', type: 'quantitative' },
          longitude2: { field: 'lon2' },
          latitude2: { field: 'lat2' },
        },
      });
      const overlay = compiled.overlays.find((entry) => entry.kind === 'geoSegments') as
        Extract<(typeof compiled.overlays)[number], { kind: 'geoSegments' }> | undefined;
      expect(overlay?.items).to.deep.equal([
        { lon1: -122.3, lat1: 47.6, lon2: -73.9, lat2: 40.7, style: overlay?.items[0].style },
      ]);
      expect(compiled.gaps.map((gap) => gap.code)).to.include(
        'mark:rule-geo-projected-custom-overlay',
      );
    });

    it('reports mark:rule-geo-missing-fields and drops the layer when longitude2/latitude2 are absent', () => {
      const compiled = compileSpec({
        projection: { type: 'albersUsa' },
        data: { values: [{ lon: -122.3, lat: 47.6 }] },
        mark: 'rule',
        encoding: {
          longitude: { field: 'lon', type: 'quantitative' },
          latitude: { field: 'lat', type: 'quantitative' },
        },
      });
      expect(compiled.overlays).to.have.length(0);
      expect(compiled.gaps.map((gap) => gap.code)).to.include('mark:rule-geo-missing-fields');
    });
  });
});
