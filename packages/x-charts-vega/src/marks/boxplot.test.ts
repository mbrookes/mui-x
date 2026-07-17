import { compileSpec } from '../compile';
import type { CompiledOverlay } from '../compile/context';
import type { VegaLiteSpec } from '../types';

/** Extracts the single `boxes` overlay compiled for a spec (or fails). */
function boxesOverlay(spec: VegaLiteSpec): Extract<CompiledOverlay, { kind: 'boxes' }> {
  const compiled = compileSpec(spec);
  const overlay = compiled.overlays.find((entry) => entry.kind === 'boxes');
  if (!overlay || overlay.kind !== 'boxes') {
    throw new Error('expected a boxes overlay');
  }
  return overlay;
}

describe('compileBoxplotMark', () => {
  it('groups rows by the categorical channel and computes quartiles per category', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { group: 'A', value: 1 },
          { group: 'A', value: 2 },
          { group: 'A', value: 3 },
          { group: 'A', value: 4 },
          { group: 'A', value: 5 },
          { group: 'B', value: 10 },
          { group: 'B', value: 20 },
          { group: 'B', value: 30 },
        ],
      },
      mark: 'boxplot',
      encoding: {
        x: { field: 'group', type: 'nominal' },
        y: { field: 'value', type: 'quantitative' },
      },
    };
    const overlay = boxesOverlay(spec);
    expect(overlay.orientation).to.equal('vertical');
    expect(overlay.items).to.have.length(2);

    const [a, b] = overlay.items;
    expect(a.category).to.equal('A');
    expect(a.q1).to.equal(2);
    expect(a.median).to.equal(3);
    expect(a.q3).to.equal(4);
    // 1.5×IQR fence reaches beyond the data, so whiskers clamp to min/max.
    expect(a.min).to.equal(1);
    expect(a.max).to.equal(5);
    expect(a.outliers).to.equal(undefined);

    expect(b.category).to.equal('B');
    expect(b.median).to.equal(20);
  });

  it('reports no boxplot-not-implemented gap and does not emit series/plots', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ group: 'A', value: 1 }] },
      mark: 'boxplot',
      encoding: {
        x: { field: 'group', type: 'nominal' },
        y: { field: 'value', type: 'quantitative' },
      },
    };
    const compiled = compileSpec(spec);
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:boxplot-not-implemented');
    expect(compiled.series).to.have.length(0);
    expect(compiled.plots).to.have.length(0);
  });

  it('flags datapoints beyond 1.5×IQR as outliers and clamps whiskers to the fence', () => {
    // 0..9 plus a far outlier at 100. q1=2.25, q3=6.75, IQR=4.5, upper fence=13.5.
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((value) => ({ g: 'A', v: value }));
    const overlay = boxesOverlay({
      data: { values },
      mark: 'boxplot',
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
      },
    });
    const item = overlay.items[0];
    expect(item.outliers).to.deep.equal([100]);
    expect(item.max).to.equal(9);
    expect(item.min).to.equal(0);
  });

  it('uses the full extent and no outliers for extent: "min-max"', () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((value) => ({ g: 'A', v: value }));
    const overlay = boxesOverlay({
      data: { values },
      mark: { type: 'boxplot', extent: 'min-max' },
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
      },
    });
    const item = overlay.items[0];
    expect(item.min).to.equal(0);
    expect(item.max).to.equal(100);
    expect(item.outliers).to.equal(undefined);
  });

  it('honors a numeric extent k for the whisker fence', () => {
    // With k=3 the fence (q1-3*IQR .. q3+3*IQR = -11.25 .. 20.25) still excludes 100.
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((value) => ({ g: 'A', v: value }));
    const overlay = boxesOverlay({
      data: { values },
      mark: { type: 'boxplot', extent: 3 },
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
      },
    });
    expect(overlay.items[0].outliers).to.deep.equal([100]);
    expect(overlay.items[0].max).to.equal(9);
  });

  it('resolves horizontal orientation from a categorical y axis', () => {
    const overlay = boxesOverlay({
      data: {
        values: [
          { group: 'A', value: 1 },
          { group: 'A', value: 5 },
          { group: 'B', value: 2 },
        ],
      },
      mark: 'boxplot',
      encoding: {
        y: { field: 'group', type: 'nominal' },
        x: { field: 'value', type: 'quantitative' },
      },
    });
    expect(overlay.orientation).to.equal('horizontal');
    expect(overlay.items).to.have.length(2);
  });

  it('applies a static mark color to every box', () => {
    const overlay = boxesOverlay({
      data: {
        values: [
          { g: 'A', v: 1 },
          { g: 'A', v: 3 },
        ],
      },
      mark: { type: 'boxplot', color: '#ff0000' },
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
      },
    });
    expect(overlay.items[0].color).to.equal('#ff0000');
  });

  it('groups a color field into dodged boxes (one box per category per group) with a legend', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { g: 'A', v: 1, region: 'east' },
          { g: 'A', v: 5, region: 'east' },
          { g: 'A', v: 2, region: 'west' },
          { g: 'A', v: 8, region: 'west' },
          { g: 'B', v: 3, region: 'east' },
          { g: 'B', v: 7, region: 'east' },
          { g: 'B', v: 4, region: 'west' },
          { g: 'B', v: 9, region: 'west' },
        ],
      },
      mark: 'boxplot',
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        color: {
          field: 'region',
          type: 'nominal',
          scale: { domain: ['east', 'west'], range: ['#111111', '#222222'] },
        },
      },
    });
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:boxplot-color-field');
    // The dodged groups now surface a real legend instead of a gap.
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:boxplot-color-legend');
    expect(compiled.overlayLegend).to.deep.equal([
      { label: 'east', color: '#111111' },
      { label: 'west', color: '#222222' },
    ]);

    const overlay = compiled.overlays.find((entry) => entry.kind === 'boxes');
    if (!overlay || overlay.kind !== 'boxes') {
      throw new Error('expected a boxes overlay');
    }
    expect(overlay.groupCount).to.equal(2);
    // 2 categories x 2 groups: group 0 (east) covers both categories first,
    // then group 1 (west).
    expect(overlay.items).to.have.length(4);
    expect(overlay.items.map((item) => item.category)).to.deep.equal(['A', 'B', 'A', 'B']);
    expect(overlay.items.map((item) => item.groupIndex)).to.deep.equal([0, 0, 1, 1]);
    expect(overlay.items.map((item) => item.color)).to.deep.equal([
      '#111111',
      '#111111',
      '#222222',
      '#222222',
    ]);
  });

  it('falls back to the chart palette for group colors when no explicit range is set', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { g: 'A', v: 1, region: 'east' },
          { g: 'A', v: 2, region: 'west' },
        ],
      },
      mark: 'boxplot',
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'region', type: 'nominal' },
      },
    });
    const overlay = compiled.overlays.find((entry) => entry.kind === 'boxes');
    if (!overlay || overlay.kind !== 'boxes') {
      throw new Error('expected a boxes overlay');
    }
    expect(overlay.items).to.have.length(2);
    expect(overlay.items[0].color).to.equal(compiled.colors[0]);
    expect(overlay.items[1].color).to.equal(compiled.colors[1 % compiled.colors.length]);
  });

  it('does not collapse dodged groups to the same static mark.color when a color split is also set', () => {
    // A static `mark.color` combined with a color-field split is a
    // realistic (if slightly redundant) spec; the palette-derived per-group
    // colors must still win so dodged boxes stay visually distinguishable.
    const compiled = compileSpec({
      data: {
        values: [
          { g: 'A', v: 1, region: 'east' },
          { g: 'A', v: 2, region: 'west' },
        ],
      },
      mark: { type: 'boxplot', color: '#123456' },
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'region', type: 'nominal' },
      },
    });
    const overlay = compiled.overlays.find((entry) => entry.kind === 'boxes');
    if (!overlay || overlay.kind !== 'boxes') {
      throw new Error('expected a boxes overlay');
    }
    expect(overlay.items).to.have.length(2);
    expect(overlay.items[0].color).not.to.equal(overlay.items[1].color);
    expect(overlay.items.some((item) => item.color === '#123456')).to.equal(false);
  });

  it('reports a partial gap for mark.size (pixel thickness vs band ratio)', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { g: 'A', v: 1 },
          { g: 'A', v: 3 },
        ],
      },
      mark: { type: 'boxplot', size: 40 },
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:boxplot-size');
    expect(gap?.severity).to.equal('partial');
  });

  it('carries median/box/rule sub-mark color and opacity through with no submark-config gap', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { g: 'A', v: 1 },
          { g: 'A', v: 3 },
        ],
      },
      mark: {
        type: 'boxplot',
        median: { color: '#ff0000' },
        box: { fill: '#00ff00', fillOpacity: 0.7 },
        rule: { stroke: '#0000ff' },
      },
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
      },
    });
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('mark:boxplot-submark-config');
    const overlay = compiled.overlays.find((entry) => entry.kind === 'boxes');
    if (!overlay || overlay.kind !== 'boxes') {
      throw new Error('expected a boxes overlay');
    }
    expect(overlay.median).to.deep.equal({ color: '#ff0000' });
    expect(overlay.box).to.deep.equal({ color: '#00ff00', opacity: 0.7 });
    expect(overlay.rule).to.deep.equal({ color: '#0000ff' });
  });

  it('reports a partial submark-config gap listing unhonored keys (e.g. strokeDash)', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { g: 'A', v: 1 },
          { g: 'A', v: 3 },
        ],
      },
      mark: { type: 'boxplot', rule: { strokeDash: [4, 2] } },
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:boxplot-submark-config');
    expect(gap?.severity).to.equal('partial');
    expect(gap?.message).to.include('strokeDash');
  });

  it('passes outliers:false / ticks:false through to hide those sub-marks', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { g: 'A', v: 1 },
          { g: 'A', v: 3 },
        ],
      },
      mark: { type: 'boxplot', outliers: false, ticks: false },
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
      },
    });
    const overlay = compiled.overlays.find((entry) => entry.kind === 'boxes');
    if (!overlay || overlay.kind !== 'boxes') {
      throw new Error('expected a boxes overlay');
    }
    expect(overlay.outliers).to.equal(false);
    expect(overlay.ticks).to.equal(false);
  });

  it('carries whole-glyph mark.opacity through to the overlay', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { g: 'A', v: 1 },
          { g: 'A', v: 3 },
        ],
      },
      mark: { type: 'boxplot', opacity: 0.4 },
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
      },
    });
    const overlay = compiled.overlays.find((entry) => entry.kind === 'boxes');
    if (!overlay || overlay.kind !== 'boxes') {
      throw new Error('expected a boxes overlay');
    }
    expect(overlay.opacity).to.equal(0.4);
  });

  it('reports an unsupported gap when the categorical channel is missing', () => {
    const compiled = compileSpec({
      data: { values: [{ a: 1 }, { a: 2 }] },
      mark: 'boxplot',
      encoding: {
        x: { field: 'a', type: 'quantitative' },
        y: { field: 'a', type: 'quantitative' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:boxplot-missing-axes');
    expect(gap?.severity).to.equal('unsupported');
    expect(compiled.overlays.some((entry) => entry.kind === 'boxes')).to.equal(false);
  });

  it('treats a temporal value channel as unsupported (temporal axes are discrete here)', () => {
    // A temporal channel resolves to a discrete band/point scale in this
    // wrapper, so it cannot host continuous quartiles.
    const compiled = compileSpec({
      data: {
        values: [
          { group: 'A', when: '2020-01-01' },
          { group: 'A', when: '2020-02-01' },
        ],
      },
      mark: 'boxplot',
      encoding: {
        x: { field: 'group', type: 'nominal' },
        y: { field: 'when', type: 'temporal' },
      },
    });
    expect(compiled.gaps.map((gap) => gap.code)).to.include('mark:boxplot-missing-axes');
    expect(compiled.overlays.some((entry) => entry.kind === 'boxes')).to.equal(false);
  });

  it('reports an unsupported gap when the continuous channel is missing', () => {
    const compiled = compileSpec({
      data: { values: [{ g: 'A', h: 'x' }] },
      mark: 'boxplot',
      encoding: {
        x: { field: 'g', type: 'nominal' },
        y: { field: 'h', type: 'nominal' },
      },
    });
    expect(compiled.gaps.map((gap) => gap.code)).to.include('mark:boxplot-missing-axes');
  });

  it('reports an ignored x-charts-origin gap noting the custom-overlay rendering', () => {
    // x-charts has no boxplot series primitive — the mark always renders through
    // the custom overlay pipeline, which is a legitimate x-charts limitation
    // (not a Vega-Lite coverage gap), so it must surface via onGaps rather than
    // silently reading as "rendered natively".
    const compiled = compileSpec({
      data: {
        values: [
          { group: 'A', value: 1 },
          { group: 'A', value: 2 },
          { group: 'A', value: 3 },
        ],
      },
      mark: 'boxplot',
      encoding: {
        x: { field: 'group', type: 'nominal' },
        y: { field: 'value', type: 'quantitative' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:boxplot-custom-overlay');
    expect(gap?.severity).to.equal('ignored');
    expect(gap?.origin).to.equal('x-charts');
  });
});
