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

  it('reports unknown marks with a generic gap instead of throwing', () => {
    const compiled = compileSpec({
      data: { values: [{ a: 1 }] },
      mark: 'sunburst',
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:sunburst');
    expect(gap?.severity).to.equal('unsupported');
    expect(gap?.message).to.contain('no x-charts equivalent');
    expect(compiled.series).to.have.length(0);
  });

  it('converts TopoJSON data (format.type topojson + feature) into a geo FeatureCollection', () => {
    const topology = {
      type: 'Topology',
      objects: {
        islands: {
          type: 'GeometryCollection',
          geometries: [{ type: 'Polygon', arcs: [[0]], properties: { name: 'A', v: 7 } }],
        },
      },
      arcs: [
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
      ],
    };
    const compiled = compileSpec({
      data: { values: topology, format: { type: 'topojson', feature: 'islands' } },
      mark: 'geoshape',
    } as unknown as VegaLiteSpec);
    expect(compiled.chartKind).to.equal('geo');
    expect(compiled.gaps.filter((gap) => gap.code.startsWith('data:topojson'))).to.have.length(0);
    const geoData = compiled.geo?.geoData as { features?: unknown[] };
    expect(geoData?.features).to.have.length(1);
  });

  it('de-duplicates TopoJSON features that share an id, preferring the real geometry', () => {
    // Real-world topologies (e.g. us-10m counties) carry a null-geometry
    // placeholder alongside the real polygon for the same id. Both would key
    // the map shape by that id and collide ("two children with the same key");
    // the conversion collapses them to one, keeping the real geometry.
    const topology = {
      type: 'Topology',
      objects: {
        counties: {
          type: 'GeometryCollection',
          geometries: [
            { type: null, id: 100, properties: {} },
            { type: 'Polygon', id: 100, arcs: [[0]], properties: { name: 'X' } },
            { type: 'Polygon', id: 200, arcs: [[0]], properties: { name: 'Y' } },
          ],
        },
      },
      arcs: [
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
      ],
    };
    const compiled = compileSpec({
      data: { values: topology, format: { type: 'topojson', feature: 'counties' } },
      mark: 'geoshape',
    } as unknown as VegaLiteSpec);
    const geoData = compiled.geo?.geoData as {
      features: Array<{ id?: number; geometry: unknown }>;
    };
    // One feature per id (100 and 200), not three.
    expect(geoData.features).to.have.length(2);
    const feature100 = geoData.features.find((entry) => entry.id === 100);
    // The real polygon replaced the null-geometry placeholder.
    expect(feature100?.geometry).not.to.equal(null);
  });

  it('keeps every LINE feature sharing an id (a route network is many arcs, not one)', () => {
    // The id-dedupe above exists to disambiguate keyed choropleth polygons, but
    // `londonTubeLines` splits each named line across dozens of `LineString`
    // arcs that all carry the SAME id — collapsing those kept one stub per line
    // and threw the rest of the route away, so the tube map rendered as a dozen
    // disconnected fragments.
    const topology = {
      type: 'Topology',
      objects: {
        line: {
          type: 'GeometryCollection',
          geometries: [
            { type: 'LineString', id: 'Central', arcs: [0], properties: {} },
            { type: 'LineString', id: 'Central', arcs: [1], properties: {} },
            { type: 'LineString', id: 'Victoria', arcs: [0], properties: {} },
          ],
        },
      },
      arcs: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [1, 1],
          [2, 2],
        ],
      ],
    };
    const compiled = compileSpec({
      data: { values: topology, format: { type: 'topojson', feature: 'line' } },
      mark: 'geoshape',
    } as unknown as VegaLiteSpec);
    const geoData = compiled.geo?.geoData as { features: Array<{ id?: string }> };
    // All three arcs survive — both "Central" segments plus "Victoria".
    expect(geoData.features).to.have.length(3);
    expect(geoData.features.filter((entry) => entry.id === 'Central')).to.have.length(2);
  });

  it('reports a gap naming the available objects for a missing topojson feature', () => {
    const compiled = compileSpec({
      data: {
        values: { type: 'Topology', objects: { counties: {} }, arcs: [] },
        format: { type: 'topojson', feature: 'nope' },
      },
      mark: 'geoshape',
    } as unknown as VegaLiteSpec);
    const gap = compiled.gaps.find((entry) => entry.code === 'data:topojson-feature');
    expect(gap?.severity).to.equal('unsupported');
    expect(gap?.message).to.contain('counties');
  });

  it('seeds continuous-axis domains from overlay geometry for overlay-only charts', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { cat: 'A', v: 10 },
          { cat: 'A', v: 20 },
          { cat: 'A', v: 30 },
          { cat: 'B', v: 15 },
          { cat: 'B', v: 25 },
          { cat: 'B', v: 60 },
        ],
      },
      mark: 'boxplot',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
      },
    });
    expect(compiled.series).to.have.length(0);
    expect(compiled.overlays[0]?.kind).to.equal('boxes');
    const config = compiled.yAxis?.config as { min?: number; max?: number };
    expect(config.min).to.be.a('number');
    expect(config.max).to.be.a('number');
    expect(config.min!).to.be.at.most(10);
    expect(config.max!).to.be.at.least(60);
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

  it('generates rows from a data.sequence (start inclusive, stop exclusive)', () => {
    const compiled = compileSpec({
      data: { sequence: { start: 0, stop: 3, as: 'x' } },
      mark: 'bar',
      encoding: {
        x: { field: 'x', type: 'ordinal' },
        y: { aggregate: 'count' },
      },
    });
    expect(compiled.xAxis?.categories).to.deep.equal([0, 1, 2]);
    expect(compiled.gaps).to.have.length(0);
  });

  it('honors a data.sequence step, including counting down with a negative step', () => {
    const forward = compileSpec({
      data: { sequence: { start: 0, stop: 1, step: 0.25, as: 'x' } },
      mark: 'bar',
      encoding: { x: { field: 'x', type: 'ordinal' }, y: { aggregate: 'count' } },
    });
    expect(forward.xAxis?.categories).to.deep.equal([0, 0.25, 0.5, 0.75]);

    const backward = compileSpec({
      data: { sequence: { start: 3, stop: 0, step: -1, as: 'x' } },
      mark: 'bar',
      encoding: { x: { field: 'x', type: 'ordinal' }, y: { aggregate: 'count' } },
    });
    // Rows generate in descending order (3, 2, 1) — stop (0) is excluded —
    // but the x-axis categories still default to ascending, per Vega-Lite.
    expect(backward.xAxis?.categories).to.deep.equal([1, 2, 3]);
  });

  it('reports an unsupported gap for a data.sequence that can never produce a row', () => {
    const compiled = compileSpec({
      data: { sequence: { start: 0, stop: 10, step: -1, as: 'x' } },
      mark: 'bar',
      encoding: { x: { field: 'x', type: 'ordinal' }, y: { aggregate: 'count' } },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'data:sequence-invalid');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('wraps a bare primitive array in data.values into one-field "data" records', () => {
    const compiled = compileSpec({
      data: { values: [12, 23, 47] },
      mark: 'bar',
      encoding: {
        x: { field: 'data', type: 'ordinal' },
        y: { aggregate: 'count' },
      },
    } as unknown as VegaLiteSpec);
    expect(compiled.xAxis?.categories).to.deep.equal([12, 23, 47]);
  });

  it('wraps a bare primitive array in a named dataset the same way as inline data.values', () => {
    // layer_line_window's shape: `datasets.falcon`/`.square` are bare arrays
    // of numbers, referenced via `data: {name: ...}` rather than inline
    // `data.values` — the same "data" field wrapping must apply either way,
    // or a downstream `calculate`/`window` transform reading `datum.data`
    // (or a direct `encoding.field: "data"`) silently sees `undefined` for
    // every row.
    const compiled = compileSpec({
      data: { name: 'falcon' },
      datasets: { falcon: [12, 23, 47] },
      mark: 'bar',
      encoding: {
        x: { field: 'data', type: 'ordinal' },
        y: { aggregate: 'count' },
      },
    } as unknown as VegaLiteSpec);
    expect(compiled.xAxis?.categories).to.deep.equal([12, 23, 47]);
  });

  it('parses an inline CSV string `data.values` payload, auto-typing numeric cells', () => {
    const compiled = compileSpec({
      data: {
        values: 'category,amount\nA,28\nB,55\n',
        format: { type: 'csv' },
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    } as unknown as VegaLiteSpec);
    expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B']);
    expect(compiled.gaps.filter((entry) => entry.code === 'data:string-values')).to.have.length(0);
  });

  it('parses a tab-delimited TSV string `data.values` payload', () => {
    const compiled = compileSpec({
      data: {
        values: 'category\tamount\nA\t28\nB\t55\n',
        format: { type: 'tsv' },
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    } as unknown as VegaLiteSpec);
    expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B']);
  });

  it('parses a custom-delimiter DSV string `data.values` payload via `format.delimiter`', () => {
    const compiled = compileSpec({
      data: {
        values: 'category|amount\nA|28\nB|55\n',
        format: { type: 'dsv', delimiter: '|' },
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    } as unknown as VegaLiteSpec);
    expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B']);
  });

  it('honors a quoted CSV field embedding the delimiter itself', () => {
    const compiled = compileSpec({
      data: {
        values: 'category,amount\n"A, Inc.",28\nB,55\n',
        format: { type: 'csv' },
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    } as unknown as VegaLiteSpec);
    expect(compiled.xAxis?.categories).to.deep.equal(['A, Inc.', 'B']);
  });

  it("parses a JSON string `data.values` payload (no `format.type`, matching Vega-Lite's default)", () => {
    const compiled = compileSpec({
      data: { values: '[{"category":"A","amount":28},{"category":"B","amount":55}]' },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    } as unknown as VegaLiteSpec);
    expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B']);
  });

  it('reports an unsupported gap for a string `data.values` payload that is neither delimited nor valid JSON', () => {
    const compiled = compileSpec({
      data: { values: 'not { valid json' },
      mark: 'bar',
      encoding: { x: { field: 'category', type: 'nominal' }, y: { aggregate: 'count' } },
    } as unknown as VegaLiteSpec);
    const gap = compiled.gaps.find((entry) => entry.code === 'data:string-values');
    expect(gap?.severity).to.equal('unsupported');
  });
});
