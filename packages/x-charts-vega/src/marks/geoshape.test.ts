import { compileSpec } from '../compile';
import { compileGeoshapeMark } from './geoshape';
import { createGapCollector } from '../gaps';
import { categoryIndex, categoryKey } from '../compile/context';
import type { UnitContext } from '../compile/context';
import type { VegaEncoding, VegaLiteSpec } from '../types';

/** A minimal square polygon feature. */
function square(name: string, x: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'Feature',
    id: name,
    properties: { name, ...extra },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, 0],
          [x, 10],
          [x + 10, 10],
          [x + 10, 0],
          [x, 0],
        ],
      ],
    },
  };
}

const featureA = square('A', 0, { rate: 10, region: 'north' });
const featureB = square('B', 20, { rate: 20, region: 'south' });
const featureC = square('C', 40, { rate: 30, region: 'north' });

type MapShapeSeries = {
  type: string;
  label?: string;
  data: Array<{
    name: string;
    value?: number;
    color?: string;
    colorValue?: unknown;
    label?: string;
  }>;
};

/** Build a minimal UnitContext for unit-level tests (projection resolution etc.). */
function makeContext(options: {
  rows?: readonly Record<string, unknown>[];
  encoding?: VegaEncoding;
  projection?: Record<string, unknown>;
}): UnitContext {
  const gaps = createGapCollector();
  return {
    unit: {
      mark: { type: 'geoshape' },
      encoding: options.encoding ?? {},
      transform: [],
      rows: options.rows ?? [],
      path: '$',
      ...(options.projection ? { projection: options.projection } : {}),
    } as UnitContext['unit'],
    rows: options.rows ?? [],
    encoding: options.encoding ?? {},
    gaps,
    palette: ['#111111', '#222222', '#333333'],
    categoryIndex,
    categoryKey,
  };
}

describe('compileGeoshapeMark', () => {
  describe('geo data resolution', () => {
    it('builds a FeatureCollection from rows that are Features (outline map)', () => {
      const compiled = compileSpec({
        data: { values: [featureA, featureB] },
        mark: 'geoshape',
      } as VegaLiteSpec);

      expect(compiled.chartKind).to.equal('geo');
      expect(compiled.plots).to.deep.equal(['geoBase']);
      expect(compiled.series).to.have.length(0);
      const geoData = compiled.geo?.geoData as { type: string; features: unknown[] };
      expect(geoData.type).to.equal('FeatureCollection');
      expect(geoData.features).to.have.length(2);
    });

    it('accepts a single row that is already a FeatureCollection', () => {
      const compiled = compileSpec({
        data: { values: [{ type: 'FeatureCollection', features: [featureA, featureB, featureC] }] },
        mark: 'geoshape',
      } as VegaLiteSpec);

      expect(compiled.chartKind).to.equal('geo');
      const geoData = compiled.geo?.geoData as { features: unknown[] };
      expect(geoData.features).to.have.length(3);
    });

    it('reports an unsupported gap for plain tabular rows (no shape field to resolve a Feature from)', () => {
      const compiled = compileSpec({
        data: { values: [{ state: 'A', rate: 1 }] },
        mark: 'geoshape',
        encoding: { color: { field: 'rate', type: 'quantitative' } },
      } as VegaLiteSpec);

      expect(compiled.chartKind).to.not.equal('geo');
      const gap = compiled.gaps.find((entry) => entry.code === 'mark:geoshape-lookup');
      expect(gap?.severity).to.equal('unsupported');
    });

    it('resolves a per-row `shape` field (a whole-row `lookup` join, geo_repeat/geo_trellis-shaped) into a real FeatureCollection', () => {
      const geoFeatureOne = {
        type: 'Feature',
        id: 1,
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [1, 0],
              [0, 0],
            ],
          ],
        },
      };
      const geoFeatureTwo = {
        type: 'Feature',
        id: 2,
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [2, 0],
              [2, 1],
              [3, 1],
              [3, 0],
              [2, 0],
            ],
          ],
        },
      };
      const compiled = compileSpec({
        data: {
          values: [
            { id: 1, population: 100 },
            { id: 2, population: 200 },
          ],
        },
        transform: [
          {
            lookup: 'id',
            from: { data: { values: [geoFeatureOne, geoFeatureTwo] }, key: 'id' },
            as: 'geo',
          },
        ],
        mark: 'geoshape',
        encoding: {
          shape: { field: 'geo', type: 'geojson' },
          color: { field: 'population', type: 'quantitative' },
        },
      } as VegaLiteSpec);

      expect(compiled.chartKind).to.equal('geo');
      expect(compiled.plots).to.include('mapShape');
      const geoData = compiled.geo?.geoData as {
        features: Array<{ properties?: Record<string, unknown> }>;
      };
      expect(geoData.features).to.have.length(2);
      // Every other row field (population) is folded into the joined
      // feature's own properties, so the color field resolves normally —
      // and a numeric `id` with no feature-native name is bridged the same
      // way an ordinary id-keyed choropleth already is.
      expect(geoData.features.map((f) => f.properties?.population)).to.deep.equal([100, 200]);
      expect(geoData.features.map((f) => f.properties?.name)).to.deep.equal(['1', '2']);
      expect(compiled.gaps.map((g) => g.code)).to.not.include('mark:geoshape-lookup');
      expect(compiled.gaps.map((g) => g.code)).to.not.include('encoding:shape');
    });

    it('drops rows whose `shape` field never resolved to a Feature (an unmatched lookup) instead of failing the whole map', () => {
      const geoFeatureOne = {
        type: 'Feature',
        id: 1,
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [1, 0],
              [0, 0],
            ],
          ],
        },
      };
      const compiled = compileSpec({
        data: {
          values: [
            { id: 1, population: 100 },
            { id: 999, population: 200 },
          ],
        },
        transform: [
          {
            lookup: 'id',
            from: { data: { values: [geoFeatureOne] }, key: 'id' },
            as: 'geo',
          },
        ],
        mark: 'geoshape',
        encoding: {
          shape: { field: 'geo', type: 'geojson' },
          color: { field: 'population', type: 'quantitative' },
        },
      } as VegaLiteSpec);

      expect(compiled.chartKind).to.equal('geo');
      const geoData = compiled.geo?.geoData as {
        features: Array<{ properties?: Record<string, unknown> }>;
      };
      expect(geoData.features).to.have.length(1);
      expect(geoData.features[0].properties?.population).to.equal(100);
    });

    it('reports an unsupported gap for empty geo data', () => {
      const compiled = compileSpec({
        data: { values: [] },
        mark: 'geoshape',
      } as VegaLiteSpec);
      const gap = compiled.gaps.find((entry) => entry.code === 'mark:geoshape-empty');
      expect(gap?.severity).to.equal('unsupported');
    });

    it('reports an unsupported gap for TopoJSON topology data', () => {
      const compiled = compileSpec({
        data: { values: [{ type: 'Topology', objects: {} }] },
        mark: 'geoshape',
      } as VegaLiteSpec);
      const gap = compiled.gaps.find((entry) => entry.code === 'mark:geoshape-topology');
      expect(gap?.severity).to.equal('unsupported');
    });
  });

  describe('projection', () => {
    it('passes through a known d3 named projection', () => {
      const compiled = compileGeoshapeMark(
        makeContext({ rows: [featureA, featureB], projection: { type: 'naturalEarth1' } }),
      );
      expect(compiled.geo?.projection).to.equal('naturalEarth1');
    });

    it('falls back to the default projection with a partial gap for an unknown name', () => {
      const ctx = makeContext({ rows: [featureA], projection: { type: 'winkel3' } });
      const compiled = compileGeoshapeMark(ctx);
      expect(compiled.geo?.projection).to.equal('mercator');
      const gap = ctx.gaps.list().find((entry) => entry.code === 'projection:unknown');
      expect(gap?.severity).to.equal('partial');
    });

    it('ignores unforwardable projection tuning params but keeps the projection name', () => {
      const ctx = makeContext({
        rows: [featureA],
        projection: { type: 'mercator', center: [10, 20], parallels: [29.5, 45.5] },
      });
      const compiled = compileGeoshapeMark(ctx);
      expect(compiled.geo?.projection).to.equal('mercator');
      const gap = ctx.gaps.list().find((entry) => entry.code === 'projection:params');
      expect(gap?.severity).to.equal('ignored');
      expect(gap?.message).to.include('center');
      expect(gap?.message).to.include('parallels');
    });

    it('defaults to the mercator projection when none is specified', () => {
      const compiled = compileGeoshapeMark(makeContext({ rows: [featureA] }));
      expect(compiled.geo?.projection).to.equal('mercator');
    });

    it('maps `rotate` to the provider `initialView` and gaps the absolute scale/translate', () => {
      const ctx = makeContext({
        rows: [featureA],
        projection: { type: 'mercator', scale: 900, rotate: [-46, -6], translate: [200, 150] },
      });
      const compiled = compileGeoshapeMark(ctx);
      // d3 `rotate: [-46, -6]` displays `[46, 6]` at the center, zoom fit-to-data.
      expect(compiled.geo?.initialView).to.deep.equal({ zoomLevel: 1, center: [46, 6] });
      // Absolute `scale`/`translate` (SVG pixels) have no relative-model equivalent.
      expect(
        ctx.gaps.list().find((entry) => entry.code === 'projection:scale-unsupported')?.severity,
      ).to.equal('partial');
      expect(
        ctx.gaps.list().find((entry) => entry.code === 'projection:translate-unsupported')
          ?.severity,
      ).to.equal('partial');
      expect(ctx.gaps.list().find((entry) => entry.code === 'projection:rotate-invalid')).to.equal(
        undefined,
      );
    });

    it('carries a 3-value rotate roll through to `initialView.roll` (no longer dropped)', () => {
      const ctx = makeContext({
        rows: [featureA],
        projection: { type: 'mercator', rotate: [-46, -6, 15] },
      });
      const compiled = compileGeoshapeMark(ctx);
      expect(compiled.geo?.initialView).to.deep.equal({
        zoomLevel: 1,
        center: [46, 6],
        roll: 15,
      });
      expect(
        ctx.gaps.list().find((entry) => entry.code === 'projection:rotate-roll-dropped'),
      ).to.equal(undefined);
    });

    it('ignores a malformed rotate with a gap and does not produce an initialView', () => {
      const ctx = makeContext({
        rows: [featureA],
        projection: { type: 'mercator', rotate: 'north' },
      });
      const compiled = compileGeoshapeMark(ctx);
      expect(compiled.geo?.initialView).to.equal(undefined);
      expect(
        ctx.gaps.list().find((entry) => entry.code === 'projection:rotate-invalid')?.severity,
      ).to.equal('ignored');
    });

    it('inherits a spec-level `projection` down through a `layer` array (normalize/index.ts)', () => {
      // `projection` is declared ONCE alongside `layer`, not repeated per
      // layer — normalize/index.ts's `walk()` must pass it down like it does
      // `encoding`/`transform`, or every layer (including this geoshape one)
      // silently falls back to the default `mercator` regardless of the
      // spec's real projection.
      const compiled = compileSpec({
        projection: { type: 'naturalEarth1' },
        layer: [{ data: { values: [featureA] }, mark: 'geoshape' }],
      } as VegaLiteSpec);
      expect(compiled.geo?.projection).to.equal('naturalEarth1');
    });
  });

  describe('choropleth', () => {
    it('builds a mapShape series with a real color axis for a quantitative color field', () => {
      const compiled = compileSpec({
        data: { values: [featureA, featureB, featureC] },
        mark: 'geoshape',
        encoding: { color: { field: 'properties.rate', type: 'quantitative' } },
      } as VegaLiteSpec);

      expect(compiled.chartKind).to.equal('geo');
      // A choropleth renders only the colored features (like Vega-Lite), with no
      // base `geoBase` layer that would fill color-join-skipped features (e.g.
      // the Great Lakes) with the default dark shape color.
      expect(compiled.plots).to.not.include('geoBase');
      expect(compiled.plots).to.include('mapShape');
      expect(compiled.series).to.have.length(1);

      const series = compiled.series[0] as unknown as MapShapeSeries;
      expect(series.type).to.equal('mapShape');
      expect(series.data.map((entry) => entry.name)).to.deep.equal(['A', 'B', 'C']);
      expect(series.data.map((entry) => entry.value)).to.deep.equal([10, 20, 30]);
      // The color is now driven by a color axis, not a per-entry approximation.
      series.data.forEach((entry) => {
        expect(entry.color).to.equal(undefined);
        expect(entry.colorValue).to.be.a('number');
      });
      expect(series.data.map((entry) => entry.colorValue)).to.deep.equal([10, 20, 30]);

      // The quantitative color field surfaces a `CompiledUnit.zAxis` entry
      // carrying a continuous `colorMap` computed from the data extent.
      expect(compiled.zAxis).to.have.length(1);
      const zAxisEntry = compiled.zAxis?.[0] as {
        id?: string;
        colorMap?: { type: string; min?: number; max?: number; color?: [string, string] };
      };
      expect(zAxisEntry.id).to.equal('vega-geo-color');
      expect(zAxisEntry.colorMap?.type).to.equal('continuous');
      expect(zAxisEntry.colorMap?.min).to.equal(10);
      expect(zAxisEntry.colorMap?.max).to.equal(30);
    });

    it('surfaces a piecewise colorMap for a binned quantitative color field', () => {
      // `bin` on the `color` channel is rewritten to an ordinal bin-label
      // field upstream (transforms/encoding.ts's `INLINE_TRANSFORM_CHANNELS`
      // covers x/y/color, matching the band-scale histogram path), so this
      // uses `fill` — untouched by that rewrite — to exercise the binned
      // branch of `resolveColor`'s continuous/piecewise resolution.
      const compiled = compileSpec({
        data: { values: [featureA, featureB, featureC] },
        mark: 'geoshape',
        encoding: {
          fill: { field: 'properties.rate', type: 'quantitative', bin: { maxbins: 2 } },
        },
      } as VegaLiteSpec);

      const zAxisEntry = compiled.zAxis?.[0] as {
        colorMap?: { type: string; thresholds?: unknown[]; colors?: string[] };
      };
      expect(zAxisEntry?.colorMap?.type).to.equal('piecewise');
      expect(zAxisEntry?.colorMap?.thresholds).to.have.length.greaterThan(0);
    });

    it('honors a `legend.format` on the color field for the continuous legend', () => {
      const compiled = compileSpec({
        data: { values: [square('A', 0, { rate: 0.012 }), square('B', 20, { rate: 0.301 })] },
        mark: 'geoshape',
        encoding: {
          color: { field: 'properties.rate', type: 'quantitative', legend: { format: '.1%' } },
        },
      } as VegaLiteSpec);
      // The format is compiled to a legend formatter (percent, one decimal)...
      const format = compiled.geo?.colorLegendFormat;
      expect(format).to.be.a('function');
      expect(format!(0.012)).to.equal('1.2%');
      expect(format!(0.301)).to.equal('30.1%');
      // ...and it is not reported as an ignored legend key.
      expect(compiled.gaps.map((gap) => gap.code)).not.to.include(
        'encoding:color-legend-config-ignored',
      );
    });

    it('reads the color field via a bare property name', () => {
      const compiled = compileSpec({
        data: { values: [featureA, featureB] },
        mark: 'geoshape',
        encoding: { color: { field: 'rate', type: 'quantitative' } },
      } as VegaLiteSpec);
      const series = compiled.series[0] as unknown as MapShapeSeries;
      expect(series.data.map((entry) => entry.value)).to.deep.equal([10, 20]);
    });

    it('assigns one palette color per distinct value for a nominal color field', () => {
      const compiled = compileSpec(
        {
          data: { values: [featureA, featureB, featureC] },
          mark: 'geoshape',
          encoding: { color: { field: 'properties.region', type: 'nominal' } },
        } as VegaLiteSpec,
        { palette: ['#aa0000', '#00bb00'] },
      );
      const series = compiled.series[0] as unknown as MapShapeSeries;
      // north, south, north -> two distinct categories, first colour reused.
      expect(series.data[0].color).to.equal('#aa0000');
      expect(series.data[1].color).to.equal('#00bb00');
      expect(series.data[2].color).to.equal('#aa0000');
    });

    it('de-duplicates entries that share a feature name (the map processor throws on duplicates)', () => {
      const duplicate = square('A', 60, { rate: 99 });
      const compiled = compileSpec({
        data: { values: [featureA, duplicate, featureB] },
        mark: 'geoshape',
        encoding: { color: { field: 'properties.rate', type: 'quantitative' } },
      } as VegaLiteSpec);
      const series = compiled.series[0] as unknown as MapShapeSeries;
      expect(series.data.map((entry) => entry.name)).to.deep.equal(['A', 'B']);
    });

    it('bridges a feature `id` into a name so an id-keyed feature can still join', () => {
      // No `properties.name`, but an `id` — x-charts joins only by name, so the
      // id is bridged into `properties.name` (String(id)) and the feature colors.
      const idOnly = {
        type: 'Feature',
        id: 42,
        properties: { rate: 5 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [60, 0],
              [60, 10],
              [70, 10],
              [70, 0],
              [60, 0],
            ],
          ],
        },
      };
      const compiled = compileSpec({
        data: { values: [featureA, idOnly, featureB] },
        mark: 'geoshape',
        encoding: { color: { field: 'properties.rate', type: 'quantitative' } },
      } as VegaLiteSpec);
      const series = compiled.series[0] as unknown as MapShapeSeries;
      expect(series.data.map((entry) => entry.name)).to.deep.equal(['A', '42', 'B']);
    });

    it('joins values onto id-keyed features via a `lookup` transform and colors them', () => {
      // Real-world choropleth shape: TopoJSON-style features identified only by a
      // numeric `id`, with the values living in a separate dataset joined by id.
      const county = (id: number, x: number) => ({
        type: 'Feature',
        id,
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [x, 0],
              [x, 10],
              [x + 10, 10],
              [x + 10, 0],
              [x, 0],
            ],
          ],
        },
      });
      const compiled = compileSpec({
        data: { values: [county(1001, 0), county(1002, 20)] },
        transform: [
          {
            lookup: 'id',
            from: {
              data: {
                values: [
                  { id: 1001, rate: 0.05 },
                  { id: 1002, rate: 0.09 },
                ],
              },
              key: 'id',
              fields: ['rate'],
            },
          },
        ],
        mark: 'geoshape',
        encoding: { color: { field: 'rate', type: 'quantitative' } },
      } as unknown as VegaLiteSpec);
      // The lookup put `rate` on each feature; the id bridged into a name so the
      // shapes color instead of falling back to the outline `mark:geoshape-lookup`.
      expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:geoshape-lookup');
      const series = compiled.series[0] as unknown as MapShapeSeries;
      expect(series.data.map((entry) => entry.name)).to.deep.equal(['1001', '1002']);
      expect(series.data.map((entry) => entry.colorValue)).to.deep.equal([0.05, 0.09]);
    });

    it('skips features with neither a name nor an id (nothing to join on)', () => {
      const anonymous = {
        type: 'Feature',
        properties: { rate: 5 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [60, 0],
              [60, 10],
              [70, 10],
              [70, 0],
              [60, 0],
            ],
          ],
        },
      };
      const compiled = compileSpec({
        data: { values: [featureA, anonymous, featureB] },
        mark: 'geoshape',
        encoding: { color: { field: 'properties.rate', type: 'quantitative' } },
      } as VegaLiteSpec);
      const series = compiled.series[0] as unknown as MapShapeSeries;
      expect(series.data.map((entry) => entry.name)).to.deep.equal(['A', 'B']);
    });

    it('supports the `fill` channel as a color encoding', () => {
      const compiled = compileSpec({
        data: { values: [featureA, featureB] },
        mark: 'geoshape',
        encoding: { fill: { field: 'properties.rate', type: 'quantitative' } },
      } as VegaLiteSpec);
      expect(compiled.plots).to.include('mapShape');
      expect(compiled.series).to.have.length(1);
    });
  });

  describe('gaps', () => {
    it('ignores the shape channel', () => {
      const compiled = compileSpec({
        data: { values: [featureA, featureB] },
        mark: 'geoshape',
        encoding: { shape: { field: 'geo', type: 'geojson' } },
      } as VegaLiteSpec);
      const gap = compiled.gaps.find((entry) => entry.code === 'encoding:shape');
      expect(gap?.severity).to.equal('ignored');
    });

    it('ignores a custom tooltip channel', () => {
      const compiled = compileSpec({
        data: { values: [featureA, featureB] },
        mark: 'geoshape',
        encoding: {
          color: { field: 'properties.rate', type: 'quantitative' },
          tooltip: { field: 'properties.name', type: 'nominal' },
        },
      } as VegaLiteSpec);
      const gap = compiled.gaps.find((entry) => entry.code === 'encoding:tooltip');
      expect(gap?.severity).to.equal('ignored');
    });
  });
});
