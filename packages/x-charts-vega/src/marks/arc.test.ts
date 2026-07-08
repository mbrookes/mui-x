import type { PieValueType } from '@mui/x-charts/models';
import { compileSpec } from '../compile';
import type { VegaLiteSpec } from '../types';

describe('compileArcMark', () => {
  const rows = [
    { category: 'A', amount: 10 },
    { category: 'A', amount: 5 },
    { category: 'B', amount: 20 },
  ];

  const baseSpec: VegaLiteSpec = {
    data: { values: rows },
    mark: 'arc',
    encoding: {
      theta: { field: 'amount', aggregate: 'sum', type: 'quantitative' },
      color: { field: 'category', type: 'nominal' },
    },
  };

  it('produces a pie series from an aggregated theta channel and a color-field split', () => {
    const compiled = compileSpec(baseSpec);
    expect(compiled.chartKind).to.equal('polar');
    expect(compiled.plots).to.deep.equal(['pie']);
    expect(compiled.series).to.have.length(1);

    const pieSeries = compiled.series[0] as unknown as { type: string; data: PieValueType[] };
    expect(pieSeries.type).to.equal('pie');
    expect(pieSeries.data).to.deep.equal([
      { id: 'A', value: 15, label: 'A' },
      { id: 'B', value: 20, label: 'B' },
    ]);
  });

  it('maps mark.innerRadius/outerRadius/cornerRadius and converts padAngle radians to degrees', () => {
    const compiled = compileSpec({
      ...baseSpec,
      mark: {
        type: 'arc',
        innerRadius: 20,
        outerRadius: 100,
        cornerRadius: 4,
        padAngle: Math.PI / 2,
      },
    });
    const pieSeries = compiled.series[0] as unknown as {
      innerRadius?: number;
      outerRadius?: number;
      cornerRadius?: number;
      paddingAngle?: number;
    };
    expect(pieSeries.innerRadius).to.equal(20);
    expect(pieSeries.outerRadius).to.equal(100);
    expect(pieSeries.cornerRadius).to.equal(4);
    expect(pieSeries.paddingAngle).to.be.closeTo(90, 1e-9);
  });

  it('falls back to a quantitative y channel with a partial gap when theta is missing', () => {
    const compiled = compileSpec({
      data: { values: [{ category: 'A', amount: 3 }] },
      mark: 'arc',
      encoding: {
        y: { field: 'amount', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:arc-theta-fallback-y');
    expect(gap?.severity).to.equal('partial');
    expect(compiled.series).to.have.length(1);
    const pieSeries = compiled.series[0] as unknown as { data: PieValueType[] };
    expect(pieSeries.data).to.deep.equal([{ id: 'A', value: 3, label: 'A' }]);
  });

  it('falls back to an inferred-quantitative y channel even without an explicit type annotation', () => {
    const compiled = compileSpec({
      data: { values: [{ category: 'A', amount: 3 }] },
      mark: 'arc',
      encoding: {
        // No explicit `type` on `y` — the pipeline infers quantitative from
        // the numeric data, same as the rest of the package.
        y: { field: 'amount' },
        color: { field: 'category', type: 'nominal' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:arc-theta-fallback-y');
    expect(gap?.severity).to.equal('partial');
    const pieSeries = compiled.series[0] as unknown as { data: PieValueType[] };
    expect(pieSeries.data).to.deep.equal([{ id: 'A', value: 3, label: 'A' }]);
  });

  it('reports an unsupported gap when theta resolves to no numeric slice values', () => {
    const compiled = compileSpec({
      data: { values: [{ category: 'A', amount: 'not-a-number' }] },
      mark: 'arc',
      encoding: {
        theta: { field: 'amount', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:arc-non-numeric-theta');
    expect(gap?.severity).to.equal('unsupported');
    const pieSeries = compiled.series[0] as unknown as { data: PieValueType[] };
    expect(pieSeries.data).to.have.length(0);
  });

  it('applies explicit scale.range colors positionally even without an explicit scale.domain', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: 'arc',
      encoding: {
        theta: { field: 'amount', aggregate: 'sum', type: 'quantitative' },
        color: { field: 'category', type: 'nominal', scale: { range: ['#ff0000', '#00ff00'] } },
      },
    });
    const pieSeries = compiled.series[0] as unknown as { data: PieValueType[] };
    expect(pieSeries.data).to.deep.equal([
      { id: 'A', value: 15, label: 'A', color: '#ff0000' },
      { id: 'B', value: 20, label: 'B', color: '#00ff00' },
    ]);
  });

  it('reports an unsupported gap and produces no series when there is no usable value channel', () => {
    const compiled = compileSpec({
      data: { values: [{ category: 'A' }] },
      mark: 'arc',
      encoding: { color: { field: 'category', type: 'nominal' } },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:arc-missing-value');
    expect(gap?.severity).to.equal('unsupported');
    expect(compiled.series).to.have.length(0);
  });

  it('reports gaps for theta2/radius/radius2 and text/order channels', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: 'arc',
      encoding: {
        theta: { field: 'amount', aggregate: 'sum', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
        theta2: { field: 'amount' },
        radius: { field: 'amount' },
        radius2: { field: 'amount' },
        text: { field: 'category' },
        order: { field: 'amount' },
      },
    });
    const codes = compiled.gaps.map((entry) => entry.code);
    expect(codes).to.include('encoding:arc-theta2');
    expect(codes).to.include('encoding:arc-radius');
    expect(codes).to.include('encoding:arc-radius2');
    expect(codes).to.include('encoding:arc-text-label');
    const orderGap = compiled.gaps.find((entry) => entry.code === 'encoding:arc-order');
    expect(orderGap?.severity).to.equal('ignored');
  });
});
