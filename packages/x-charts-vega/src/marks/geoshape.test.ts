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

    it('reports an unsupported gap for plain tabular rows (lookup join)', () => {
      const compiled = compileSpec({
        data: { values: [{ state: 'A', rate: 1 }] },
        mark: 'geoshape',
        encoding: { color: { field: 'rate', type: 'quantitative' } },
      } as VegaLiteSpec);

      expect(compiled.chartKind).to.not.equal('geo');
      const gap = compiled.gaps.find((entry) => entry.code === 'mark:geoshape-lookup');
      expect(gap?.severity).to.equal('unsupported');
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

    it('ignores projection tuning params but keeps the projection name', () => {
      const ctx = makeContext({
        rows: [featureA],
        projection: { type: 'mercator', scale: 900, rotate: [-46, -6] },
      });
      const compiled = compileGeoshapeMark(ctx);
      expect(compiled.geo?.projection).to.equal('mercator');
      const gap = ctx.gaps.list().find((entry) => entry.code === 'projection:params');
      expect(gap?.severity).to.equal('ignored');
    });

    it('defaults to the mercator projection when none is specified', () => {
      const compiled = compileGeoshapeMark(makeContext({ rows: [featureA] }));
      expect(compiled.geo?.projection).to.equal('mercator');
    });
  });

  describe('choropleth', () => {
    it('builds a mapShape series with per-feature values for a quantitative color field', () => {
      const compiled = compileSpec({
        data: { values: [featureA, featureB, featureC] },
        mark: 'geoshape',
        encoding: { color: { field: 'properties.rate', type: 'quantitative' } },
      } as VegaLiteSpec);

      expect(compiled.chartKind).to.equal('geo');
      expect(compiled.plots).to.include('geoBase');
      expect(compiled.plots).to.include('mapShape');
      expect(compiled.series).to.have.length(1);

      const series = compiled.series[0] as unknown as MapShapeSeries;
      expect(series.type).to.equal('mapShape');
      expect(series.data.map((entry) => entry.name)).to.deep.equal(['A', 'B', 'C']);
      expect(series.data.map((entry) => entry.value)).to.deep.equal([10, 20, 30]);
      series.data.forEach((entry) => {
        expect(entry.color).to.match(/^#[0-9a-f]{6}$/i);
        expect(entry.colorValue).to.be.a('number');
      });
      // Distinct values yield distinct colors along the ramp.
      const colors = new Set(series.data.map((entry) => entry.color));
      expect(colors.size).to.equal(3);
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

    it('skips features without a string name (they cannot be joined to the map)', () => {
      const unnamed = {
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
        data: { values: [featureA, unnamed, featureB] },
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
