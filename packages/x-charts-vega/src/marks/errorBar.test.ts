import { compileSpec } from '../compile';
import type { VegaLiteSpec } from '../types';
import type { OverlayBandPoint, OverlayErrorBarItem } from '../compile/context';

describe('compileErrorBarMark', () => {
  const rows = [
    { day: 'Mon', temp: 10 },
    { day: 'Mon', temp: 12 },
    { day: 'Mon', temp: 14 },
    { day: 'Tue', temp: 20 },
    { day: 'Tue', temp: 22 },
    { day: 'Tue', temp: 24 },
  ];

  const baseSpec: VegaLiteSpec = {
    data: { values: rows },
    mark: 'errorbar',
    encoding: {
      x: { field: 'day', type: 'nominal' },
      y: { field: 'temp', type: 'quantitative' },
    },
  };

  it('defaults to extent "stderr": mean ± stderr per category', () => {
    const compiled = compileSpec(baseSpec);
    expect(compiled.plots).to.deep.equal([]);
    expect(compiled.series).to.have.length(0);
    expect(compiled.overlays).to.have.length(1);
    const overlay = compiled.overlays[0];
    expect(overlay.kind).to.equal('errorBars');
    if (overlay.kind !== 'errorBars') {
      throw new Error('expected errorBars overlay');
    }
    expect(overlay.orientation).to.equal('vertical');
    expect(overlay.items).to.have.length(2);

    const [mon, tue] = overlay.items;
    // Mon: [10, 12, 14] -> mean 12, stdev 2, stderr 2/sqrt(3)
    expect(mon.category).to.equal('Mon');
    expect(mon.center).to.equal(12);
    const stderrMon = 2 / Math.sqrt(3);
    expect(mon.lower).to.be.closeTo(12 - stderrMon, 1e-9);
    expect(mon.upper).to.be.closeTo(12 + stderrMon, 1e-9);

    expect(tue.category).to.equal('Tue');
    expect(tue.center).to.equal(22);

    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:errorbar-not-implemented');
  });

  it('extent "stdev": mean ± standard deviation', () => {
    const compiled = compileSpec({
      ...baseSpec,
      mark: { type: 'errorbar', extent: 'stdev' },
    });
    const overlay = compiled.overlays[0];
    if (overlay.kind !== 'errorBars') {
      throw new Error('expected errorBars overlay');
    }
    const [mon] = overlay.items;
    // Mon: [10, 12, 14] -> mean 12, sample stdev 2
    expect(mon.center).to.equal(12);
    expect(mon.lower).to.be.closeTo(10, 1e-9);
    expect(mon.upper).to.be.closeTo(14, 1e-9);
  });

  it('extent "iqr": q1..q3 interval, and reports no ci-approximation gap', () => {
    const compiled = compileSpec({
      ...baseSpec,
      mark: { type: 'errorbar', extent: 'iqr' },
    });
    const overlay = compiled.overlays[0];
    if (overlay.kind !== 'errorBars') {
      throw new Error('expected errorBars overlay');
    }
    const [mon] = overlay.items;
    expect(mon.lower).to.be.a('number');
    expect(mon.upper).to.be.a('number');
    expect(mon.lower).to.be.lessThan(mon.upper);
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:errorbar-ci-approximation');
  });

  it('extent "ci": approximates mean ± 1.96×stderr and records a partial approximation gap', () => {
    const compiled = compileSpec({
      ...baseSpec,
      mark: { type: 'errorbar', extent: 'ci' },
    });
    const overlay = compiled.overlays[0];
    if (overlay.kind !== 'errorBars') {
      throw new Error('expected errorBars overlay');
    }
    const [mon] = overlay.items;
    const stderrMon = 2 / Math.sqrt(3);
    const margin = 1.96 * stderrMon;
    expect(mon.lower).to.be.closeTo(12 - margin, 1e-9);
    expect(mon.upper).to.be.closeTo(12 + margin, 1e-9);

    const gap = compiled.gaps.find((entry) => entry.code === 'mark:errorbar-ci-approximation');
    expect(gap?.severity).to.equal('partial');
  });

  it('falls back to "stderr" and reports a partial gap for an unrecognized extent', () => {
    const compiled = compileSpec({
      ...baseSpec,
      mark: { type: 'errorbar', extent: 'bogus' },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:errorbar-extent-unsupported');
    expect(gap?.severity).to.equal('partial');
    expect(compiled.overlays).to.have.length(1);
  });

  it('supports horizontal orientation (category on y, value on x)', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: { type: 'errorbar', orient: 'horizontal' },
      encoding: {
        y: { field: 'day', type: 'nominal' },
        x: { field: 'temp', type: 'quantitative' },
      },
    });
    const overlay = compiled.overlays[0];
    if (overlay.kind !== 'errorBars') {
      throw new Error('expected errorBars overlay');
    }
    expect(overlay.orientation).to.equal('horizontal');
    expect(overlay.items.map((item: OverlayErrorBarItem) => item.category)).to.deep.equal([
      'Mon',
      'Tue',
    ]);
  });

  it('uses a static mark/value color and drops a color-field split with a partial gap', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { day: 'Mon', temp: 10, region: 'east' },
          { day: 'Mon', temp: 14, region: 'west' },
          { day: 'Tue', temp: 20, region: 'east' },
          { day: 'Tue', temp: 24, region: 'west' },
        ],
      },
      mark: { type: 'errorbar', color: '#ff0000' },
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
        color: { field: 'region', type: 'nominal' },
      },
    });
    const overlay = compiled.overlays[0];
    if (overlay.kind !== 'errorBars') {
      throw new Error('expected errorBars overlay');
    }
    expect(overlay.items).to.have.length(2);
    expect(overlay.items.every((item) => item.color === '#ff0000')).to.equal(true);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:errorbar-color-split');
    expect(gap?.severity).to.equal('partial');
  });

  it('reports an unsupported gap and renders nothing when a positional channel is missing', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: 'errorbar',
      encoding: {
        x: { field: 'day', type: 'nominal' },
      },
    });
    expect(compiled.overlays).to.have.length(0);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:errorbar-missing-axes');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('errorband: produces a band overlay with points sorted by the x category order', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: 'errorband',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    expect(compiled.overlays).to.have.length(1);
    const overlay = compiled.overlays[0];
    expect(overlay.kind).to.equal('band');
    if (overlay.kind !== 'band') {
      throw new Error('expected band overlay');
    }
    expect(overlay.points.map((point: OverlayBandPoint) => point.x)).to.deep.equal(['Mon', 'Tue']);
    expect(overlay.opacity).to.equal(0.3);
  });

  it('errorband: a transposed (categorical-y) band renders with orientation "horizontal" and no transposed gap', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: { type: 'errorband', orient: 'horizontal' },
      encoding: {
        y: { field: 'day', type: 'nominal' },
        x: { field: 'temp', type: 'quantitative' },
      },
    });
    expect(compiled.overlays).to.have.length(1);
    const overlay = compiled.overlays[0];
    expect(overlay.kind).to.equal('band');
    if (overlay.kind !== 'band') {
      throw new Error('expected band overlay');
    }
    expect(overlay.orientation).to.equal('horizontal');
    expect(overlay.points.map((point: OverlayBandPoint) => point.x)).to.deep.equal(['Mon', 'Tue']);
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:errorband-transposed');
  });

  it('errorband: a standalone horizontal band seeds axis domain from foundation overlayAxisValues', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: { type: 'errorband', orient: 'horizontal' },
      encoding: {
        y: { field: 'day', type: 'nominal' },
        x: { field: 'temp', type: 'quantitative' },
      },
    });
    // No series exist for a standalone overlay-only spec, so the quantitative
    // x-axis domain must be seeded from the band's own lower/upper values
    // (see compile/index.ts's applyOverlayDomains / overlayAxisValues).
    const config = compiled.xAxis?.config as { min?: number; max?: number } | undefined;
    expect(config?.min).to.be.a('number');
    expect(config?.max).to.be.a('number');
    expect(config!.min!).to.be.lessThan(config!.max!);
  });

  it('layers an errorband under a line mark sharing the same encodings', () => {
    const compiled = compileSpec({
      data: { values: rows },
      layer: [
        {
          mark: 'errorband',
          encoding: {
            x: { field: 'day', type: 'nominal' },
            y: { field: 'temp', type: 'quantitative' },
          },
        },
        {
          mark: 'line',
          encoding: {
            x: { field: 'day', type: 'nominal' },
            y: { field: 'temp', aggregate: 'mean', type: 'quantitative' },
          },
        },
      ],
    });
    expect(compiled.plots).to.deep.equal(['line']);
    expect(compiled.series).to.have.length(1);
    expect(compiled.overlays).to.have.length(1);
    expect(compiled.overlays[0].kind).to.equal('band');
    expect(compiled.xAxis?.categories).to.deep.equal(['Mon', 'Tue']);
  });
});
