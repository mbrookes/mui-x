import { createGapCollector } from '../gaps';
import type { VegaEncoding, DatasetRow } from '../types';
import { resolveColor } from './color';

function resolve(encoding: VegaEncoding, rows: readonly DatasetRow[] = []) {
  const gaps = createGapCollector();
  const result = resolveColor(encoding, rows, gaps, '$');
  return { result, gaps: gaps.list() };
}

describe('resolveColor', () => {
  describe('baseline: none / static / split-by-field', () => {
    it('returns hasLegend: false when no color-related channel is present', () => {
      const { result, gaps } = resolve({});
      expect(result).to.deep.equal({ hasLegend: false });
      expect(gaps).to.have.length(0);
    });

    it('resolves a static value def to staticColor', () => {
      const { result } = resolve({ color: { value: 'red' } });
      expect(result.staticColor).to.equal('red');
      expect(result.hasLegend).to.equal(false);
    });

    it('ignores a non-string static value', () => {
      const { result } = resolve({ color: { value: 5 } });
      expect(result.staticColor).to.equal(undefined);
    });

    it('resolves a nominal field def to a splitField with legend', () => {
      const { result } = resolve({ color: { field: 'category', type: 'nominal' } });
      expect(result.splitField).to.equal('category');
      expect(result.hasLegend).to.equal(true);
      expect(result.domain).to.equal(undefined);
      expect(result.range).to.equal(undefined);
    });

    it('respects legend: null to disable the legend', () => {
      const { result } = resolve({
        color: { field: 'category', type: 'nominal', legend: null },
      });
      expect(result.hasLegend).to.equal(false);
    });
  });

  describe('explicit scale.range / scale.domain', () => {
    it('passes through an explicit range array', () => {
      const { result, gaps } = resolve({
        color: {
          field: 'category',
          type: 'nominal',
          scale: { range: ['#111111', '#222222'] },
        },
      });
      expect(result.range).to.deep.equal(['#111111', '#222222']);
      expect(gaps).to.have.length(0);
    });

    it('passes through an explicit domain array', () => {
      const { result } = resolve({
        color: {
          field: 'category',
          type: 'nominal',
          scale: { domain: ['B', 'A'] },
        },
      });
      expect(result.domain).to.deep.equal(['B', 'A']);
    });

    it('reports a partial gap when domain/range lengths mismatch', () => {
      const { result, gaps } = resolve({
        color: {
          field: 'category',
          type: 'nominal',
          scale: { domain: ['A', 'B', 'C'], range: ['#111111', '#222222'] },
        },
      });
      expect(result.domain).to.have.length(3);
      expect(result.range).to.have.length(2);
      const gap = gaps.find((g) => g.code === 'encoding:color-domain-range-mismatch');
      expect(gap).to.not.equal(undefined);
      expect(gap?.severity).to.equal('partial');
    });

    it('does not report a mismatch gap when lengths agree', () => {
      const { gaps } = resolve({
        color: {
          field: 'category',
          type: 'nominal',
          scale: { domain: ['A', 'B'], range: ['#111111', '#222222'] },
        },
      });
      expect(gaps.map((g) => g.code)).to.not.include('encoding:color-domain-range-mismatch');
    });
  });

  describe('scale.scheme mapping (nominal/ordinal)', () => {
    it('maps a known categorical scheme name to an x-charts palette range', () => {
      const { result, gaps } = resolve({
        color: { field: 'category', type: 'nominal', scale: { scheme: 'category10' } },
      });
      expect(result.range).to.be.an('array').with.length.greaterThan(0);
      expect(gaps.map((g) => g.code)).to.not.include('encoding:color-scheme-unknown');
    });

    it('reproduces a categorical scheme with its exact Vega swatch array (category20b)', () => {
      const { result } = resolve({
        color: { field: 'category', type: 'nominal', scale: { scheme: 'category20b' } },
      });
      expect(result.range?.slice(0, 4)).to.deep.equal([
        '#393b79',
        '#5254a3',
        '#6b6ecf',
        '#9c9ede',
      ]);
      expect(result.range).to.have.length(20);
    });

    it('maps a scheme given as {name} object form', () => {
      const { result } = resolve({
        color: { field: 'category', type: 'ordinal', scale: { scheme: { name: 'Dark2' } } },
      });
      expect(result.range).to.be.an('array').with.length.greaterThan(0);
    });

    it('prefers an explicit range over a scheme name', () => {
      const { result } = resolve({
        color: {
          field: 'category',
          type: 'nominal',
          scale: { scheme: 'category10', range: ['#abcdef'] },
        },
      });
      expect(result.range).to.deep.equal(['#abcdef']);
    });

    it('maps a single-hue sequential scheme name (blues) to a discrete range', () => {
      const { result, gaps } = resolve({
        color: { field: 'category', type: 'nominal', scale: { scheme: 'blues' } },
      });
      expect(result.range).to.be.an('array').with.length.greaterThan(0);
      expect(gaps.map((g) => g.code)).to.not.include('encoding:color-scheme-unknown');
    });

    it('maps a multi-hue scheme name (viridis) to an approximating discrete range', () => {
      const { result, gaps } = resolve({
        color: { field: 'category', type: 'ordinal', scale: { scheme: 'viridis' } },
      });
      expect(result.range).to.be.an('array').with.length.greaterThan(0);
      expect(gaps.map((g) => g.code)).to.not.include('encoding:color-scheme-unknown');
    });

    it('reports a partial gap and leaves range unset for an unknown scheme', () => {
      const { result, gaps } = resolve({
        color: { field: 'category', type: 'nominal', scale: { scheme: 'totally-unknown-scheme' } },
      });
      expect(result.range).to.equal(undefined);
      const gap = gaps.find((g) => g.code === 'encoding:color-scheme-unknown');
      expect(gap?.severity).to.equal('partial');
    });
  });

  describe('continuous color (quantitative/temporal)', () => {
    const rows: DatasetRow[] = [{ v: 10 }, { v: 20 }, { v: 30 }];

    it('computes a continuous colorMap from the data extent with the default yellow-green-blue ramp', () => {
      const { result, gaps } = resolve({ color: { field: 'v', type: 'quantitative' } }, rows);
      expect(result.hasLegend).to.equal(false);
      expect(result.colorMap).to.include({ type: 'continuous', min: 10, max: 30 });
      // Vega-Lite's default continuous scheme (`yellowgreenblue`) is multi-hue,
      // so it resolves to an interpolator function rather than a two-color pair.
      const color = result.colorMap && 'color' in result.colorMap ? result.colorMap.color : null;
      expect(color).to.be.a('function');
      expect((color as (t: number) => string)(0)).to.match(/^#/);
      expect((color as (t: number) => string)(1)).to.match(/^#/);
      const gap = gaps.find((g) => g.code === 'encoding:color-continuous');
      expect(gap?.severity).to.equal('partial');
    });

    it('resolves a multi-hue sequential scheme (yellowgreenblue) to an interpolator', () => {
      const { result } = resolve(
        { color: { field: 'v', type: 'quantitative', scale: { scheme: 'yellowgreenblue' } } },
        rows,
      );
      const color = result.colorMap && 'color' in result.colorMap ? result.colorMap.color : null;
      expect(color).to.be.a('function');
    });

    it('maps a known sequential scheme name to palette endpoints', () => {
      const { result } = resolve(
        { color: { field: 'v', type: 'quantitative', scale: { scheme: 'greens' } } },
        rows,
      );
      expect(result.colorMap?.type).to.equal('continuous');
    });

    it('honors an explicit domain override instead of the data extent', () => {
      const { result } = resolve(
        { color: { field: 'v', type: 'quantitative', scale: { domain: [0, 100] } } },
        rows,
      );
      expect(result.colorMap).to.include({ min: 0, max: 100 });
    });

    it('reverses the color range when scale.reverse is set', () => {
      const forward = resolve(
        { color: { field: 'v', type: 'quantitative', scale: { range: ['#000000', '#ffffff'] } } },
        rows,
      ).result;
      const reversed = resolve(
        {
          color: {
            field: 'v',
            type: 'quantitative',
            scale: { range: ['#000000', '#ffffff'], reverse: true },
          },
        },
        rows,
      ).result;
      const forwardColor =
        forward.colorMap && 'color' in forward.colorMap ? forward.colorMap.color : undefined;
      const reversedColor =
        reversed.colorMap && 'color' in reversed.colorMap ? reversed.colorMap.color : undefined;
      expect(forwardColor).to.deep.equal(['#000000', '#ffffff']);
      expect(reversedColor).to.deep.equal(['#ffffff', '#000000']);
    });

    it('handles temporal color fields by using Date extents', () => {
      const temporalRows: DatasetRow[] = [{ t: '2020-01-01' }, { t: '2021-01-01' }];
      const { result } = resolve({ color: { field: 't', type: 'temporal' } }, temporalRows);
      expect(result.colorMap?.type).to.equal('continuous');
      const continuous = result.colorMap as { min?: unknown; max?: unknown };
      expect(continuous.min).to.be.instanceOf(Date);
      expect(continuous.max).to.be.instanceOf(Date);
    });

    it('returns no colorMap when the data extent is degenerate', () => {
      const { result, gaps } = resolve({ color: { field: 'v', type: 'quantitative' } }, [
        { v: 5 },
        { v: 5 },
      ]);
      expect(result.colorMap).to.equal(undefined);
      // The gap is still reported: the feature was recognized, just not computable.
      expect(gaps.map((g) => g.code)).to.include('encoding:color-continuous');
    });

    it('returns no colorMap when there are no rows / no valid values', () => {
      const { result } = resolve({ color: { field: 'v', type: 'quantitative' } }, []);
      expect(result.colorMap).to.equal(undefined);
    });
  });

  describe('binned color fields', () => {
    const rows: DatasetRow[] = [{ v: 0 }, { v: 25 }, { v: 50 }, { v: 75 }, { v: 100 }];

    it('produces a piecewise colorMap for a binned quantitative field', () => {
      const { result, gaps } = resolve(
        { color: { field: 'v', type: 'quantitative', bin: true } },
        rows,
      );
      expect(result.colorMap?.type).to.equal('piecewise');
      const piecewise = result.colorMap as { thresholds: unknown[]; colors: string[] };
      expect(piecewise.colors).to.have.length(piecewise.thresholds.length + 1);
      const gap = gaps.find((g) => g.code === 'encoding:color-binned');
      expect(gap?.severity).to.equal('partial');
    });

    it('honors bin.maxbins for the number of bands', () => {
      const { result } = resolve(
        { color: { field: 'v', type: 'quantitative', bin: { maxbins: 3 } } },
        rows,
      );
      const piecewise = result.colorMap as { thresholds: unknown[]; colors: string[] };
      expect(piecewise.colors).to.have.length(3);
      expect(piecewise.thresholds).to.have.length(2);
    });

    it('treats bin: "binned" as already-binned data', () => {
      const { result } = resolve(
        { color: { field: 'v', type: 'quantitative', bin: 'binned' } },
        rows,
      );
      expect(result.colorMap?.type).to.equal('piecewise');
    });

    it('falls back to a hard split (no black-anchored ramp) for non-hex range colors', () => {
      const { result } = resolve(
        {
          color: {
            field: 'v',
            type: 'quantitative',
            bin: { maxbins: 4 },
            scale: { range: ['steelblue', 'orange'] },
          },
        },
        rows,
      );
      const piecewise = result.colorMap as { thresholds: unknown[]; colors: string[] };
      expect(piecewise.colors).to.have.length(4);
      // Must not silently collapse to a black-anchored ramp (parseInt(NaN) >> n coerces to 0).
      expect(piecewise.colors).to.not.include('#000000');
      expect(piecewise.colors).to.deep.equal(['steelblue', 'steelblue', 'orange', 'orange']);
    });

    it('still interpolates a real gradient for valid hex range colors', () => {
      const { result } = resolve(
        {
          color: {
            field: 'v',
            type: 'quantitative',
            bin: { maxbins: 3 },
            scale: { range: ['#000000', '#ffffff'] },
          },
        },
        rows,
      );
      const piecewise = result.colorMap as { thresholds: unknown[]; colors: string[] };
      expect(piecewise.colors).to.deep.equal(['#000000', '#808080', '#ffffff']);
    });
  });

  describe('fill vs stroke precedence', () => {
    it('falls back to fill when color is absent', () => {
      const { result } = resolve({ fill: { value: 'blue' } });
      expect(result.staticColor).to.equal('blue');
    });

    it('falls back to stroke when color and fill are absent', () => {
      const { result } = resolve({ stroke: { value: 'green' } });
      expect(result.staticColor).to.equal('green');
    });

    it('prefers color over fill and stroke', () => {
      const { result } = resolve({
        color: { value: 'red' },
        fill: { value: 'blue' },
        stroke: { value: 'green' },
      });
      expect(result.staticColor).to.equal('red');
    });

    it('reports an ignored gap for stroke when both fill and stroke are present', () => {
      const { result, gaps } = resolve({
        fill: { value: 'blue' },
        stroke: { value: 'green' },
      });
      expect(result.staticColor).to.equal('blue');
      const gap = gaps.find((g) => g.code === 'encoding:color-fill-stroke-conflict');
      expect(gap?.severity).to.equal('ignored');
      expect(gap?.path).to.equal('$.encoding.stroke');
    });

    it('does not report a fill/stroke conflict when only one is present', () => {
      const { gaps } = resolve({ fill: { value: 'blue' } });
      expect(gaps.map((g) => g.code)).to.not.include('encoding:color-fill-stroke-conflict');
    });
  });

  describe('conditional defs', () => {
    it('reports an unsupported gap and falls back to the base value', () => {
      const { result, gaps } = resolve({
        color: {
          condition: { test: 'datum.x > 0', value: 'green' },
          value: 'red',
        } as VegaEncoding['color'],
      });
      expect(result.staticColor).to.equal('red');
      const gap = gaps.find((g) => g.code === 'encoding:color-condition-unsupported');
      expect(gap?.severity).to.equal('unsupported');
    });

    it('reports an unsupported gap and falls back to the base field', () => {
      const { result, gaps } = resolve({
        color: {
          condition: { test: 'datum.x > 0', value: 'green' },
          field: 'category',
          type: 'nominal',
        } as VegaEncoding['color'],
      });
      expect(result.splitField).to.equal('category');
      expect(gaps.map((g) => g.code)).to.include('encoding:color-condition-unsupported');
    });

    it('does not report a condition gap when condition is absent', () => {
      const { gaps } = resolve({ color: { value: 'red' } });
      expect(gaps.map((g) => g.code)).to.not.include('encoding:color-condition-unsupported');
    });
  });

  describe('legend config objects', () => {
    it('reports an ignored gap for an unsupported legend config key', () => {
      const { result, gaps } = resolve({
        color: { field: 'category', type: 'nominal', legend: { title: 'Category' } },
      });
      expect(result.hasLegend).to.equal(true);
      const gap = gaps.find((g) => g.code === 'encoding:color-legend-config-ignored');
      expect(gap?.severity).to.equal('ignored');
    });

    it('does not report a gap for an orient-only legend config (position is honored)', () => {
      const { result, gaps } = resolve({
        color: { field: 'category', type: 'nominal', legend: { orient: 'bottom' } },
      });
      expect(result.hasLegend).to.equal(true);
      expect(gaps.map((g) => g.code)).to.not.include('encoding:color-legend-config-ignored');
    });

    it('does not report a gap for positional-offset legend keys', () => {
      const { gaps } = resolve({
        color: { field: 'category', type: 'nominal', legend: { legendX: 10, legendY: 20 } },
      });
      expect(gaps.map((g) => g.code)).to.not.include('encoding:color-legend-config-ignored');
    });

    it('still gaps unsupported keys even when orient is also present', () => {
      const { gaps } = resolve({
        color: {
          field: 'category',
          type: 'nominal',
          legend: { orient: 'bottom', title: 'Category' },
        },
      });
      expect(gaps.map((g) => g.code)).to.include('encoding:color-legend-config-ignored');
    });

    it('does not report a gap for an empty legend config object', () => {
      const { gaps } = resolve({
        color: { field: 'category', type: 'nominal', legend: {} },
      });
      expect(gaps.map((g) => g.code)).to.not.include('encoding:color-legend-config-ignored');
    });

    it('does not report a gap when legend is undefined', () => {
      const { gaps } = resolve({ color: { field: 'category', type: 'nominal' } });
      expect(gaps.map((g) => g.code)).to.not.include('encoding:color-legend-config-ignored');
    });
  });

  describe('opacity / fillOpacity', () => {
    it('ignores value-def opacity silently', () => {
      const { gaps } = resolve({
        color: { field: 'category', type: 'nominal' },
        opacity: { value: 0.5 },
      });
      expect(gaps.map((g) => g.code)).to.not.include('encoding:opacity-field-unsupported');
    });

    it('reports an unsupported gap for field-def opacity', () => {
      const { gaps } = resolve({
        color: { field: 'category', type: 'nominal' },
        opacity: { field: 'v', type: 'quantitative' },
      });
      const gap = gaps.find(
        (g) => g.code === 'encoding:opacity-field-unsupported' && g.path === '$.encoding.opacity',
      );
      expect(gap?.severity).to.equal('unsupported');
    });

    it('reports an unsupported gap for field-def fillOpacity', () => {
      const { gaps } = resolve({
        color: { field: 'category', type: 'nominal' },
        fillOpacity: { field: 'v', type: 'quantitative' },
      });
      const gap = gaps.find(
        (g) =>
          g.code === 'encoding:opacity-field-unsupported' && g.path === '$.encoding.fillOpacity',
      );
      expect(gap?.severity).to.equal('unsupported');
    });

    it('ignores value-def fillOpacity silently', () => {
      const { gaps } = resolve({
        color: { field: 'category', type: 'nominal' },
        fillOpacity: { value: 0.8 },
      });
      expect(gaps.map((g) => g.code)).to.not.include('encoding:opacity-field-unsupported');
    });
  });
});
