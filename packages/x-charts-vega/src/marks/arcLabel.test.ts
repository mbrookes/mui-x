import type { PieValueType, PieSeriesType } from '@mui/x-charts/models';
import { compileSpec } from '../compile';
import type { VegaLiteSpec } from '../types';

describe('compileArcMark text -> arcLabel wiring', () => {
  const rows = [
    { category: 'A', amount: 10 },
    { category: 'B', amount: 20 },
  ];

  const baseSpec: VegaLiteSpec = {
    data: { values: rows },
    mark: 'arc',
    encoding: {
      theta: { field: 'amount', type: 'quantitative' },
      color: { field: 'category', type: 'nominal' },
    },
  };

  it('maps a text field equal to the color field to arcLabel: "label" and adds the pieLabels plot', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: { ...baseSpec.encoding, text: { field: 'category' } },
    });
    expect(compiled.plots).to.deep.equal(['pie', 'pieLabels']);
    const pieSeries = compiled.series[0] as unknown as { arcLabel?: PieSeriesType['arcLabel'] };
    expect(pieSeries.arcLabel).to.equal('label');
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('encoding:arc-text-label');
  });

  it('maps a text field equal to the theta field to arcLabel: "value"', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: { ...baseSpec.encoding, text: { field: 'amount' } },
    });
    expect(compiled.plots).to.include('pieLabels');
    const pieSeries = compiled.series[0] as unknown as { arcLabel?: PieSeriesType['arcLabel'] };
    expect(pieSeries.arcLabel).to.equal('value');
  });

  it('maps a plain (unrelated) text field to a callback that reads the per-slice value', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { category: 'A', amount: 10, note: 'first' },
          { category: 'B', amount: 20, note: 'second' },
        ],
      },
      mark: 'arc',
      encoding: {
        theta: { field: 'amount', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
        text: { field: 'note' },
      },
    });
    const pieSeries = compiled.series[0] as unknown as {
      data: PieValueType[];
      arcLabel?: PieSeriesType['arcLabel'];
    };
    expect(typeof pieSeries.arcLabel).to.equal('function');
    const arcLabelFn = pieSeries.arcLabel as (item: { id?: unknown }) => string;
    expect(arcLabelFn({ id: 'A' })).to.equal('first');
    expect(arcLabelFn({ id: 'B' })).to.equal('second');
    expect(compiled.gaps.map((gap) => gap.code)).not.to.include('encoding:arc-text-label');
  });

  it('maps a constant value-def text to a callback returning that constant for every slice', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: { ...baseSpec.encoding, text: { value: 'fixed' } },
    });
    const pieSeries = compiled.series[0] as unknown as { arcLabel?: PieSeriesType['arcLabel'] };
    expect(typeof pieSeries.arcLabel).to.equal('function');
    const arcLabelFn = pieSeries.arcLabel as (item: { id?: unknown }) => string;
    expect(arcLabelFn({ id: 'A' })).to.equal('fixed');
  });

  it('reports a partial gap (not the old unsupported one) for a format string on the text field', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: { ...baseSpec.encoding, text: { field: 'amount', format: '.2f' } },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'encoding:arc-text-label');
    expect(gap?.severity).to.equal('partial');
    // Still maps onto arcLabel (best-effort, unformatted) rather than being dropped.
    const pieSeries = compiled.series[0] as unknown as { arcLabel?: PieSeriesType['arcLabel'] };
    expect(pieSeries.arcLabel).to.equal('value');
  });

  it('reports a partial gap and sets no arcLabel for a field-less text aggregate', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: { ...baseSpec.encoding, text: { aggregate: 'count' } },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'encoding:arc-text-label');
    expect(gap?.severity).to.equal('partial');
    const pieSeries = compiled.series[0] as unknown as { arcLabel?: PieSeriesType['arcLabel'] };
    expect(pieSeries.arcLabel).to.equal(undefined);
    expect(compiled.plots).to.deep.equal(['pie']);
  });

  it('produces no arcLabel and no pieLabels plot when there is no text encoding', () => {
    const compiled = compileSpec(baseSpec);
    expect(compiled.plots).to.deep.equal(['pie']);
    const pieSeries = compiled.series[0] as unknown as { arcLabel?: PieSeriesType['arcLabel'] };
    expect(pieSeries.arcLabel).to.equal(undefined);
  });
});
