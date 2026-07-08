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

  it('reports an unsupported gap for x2/y2 segment rules and drops the segment', () => {
    const compiled = compileSpec({
      data: { values: [{ xStart: 1, xEnd: 5 }] },
      mark: 'rule',
      encoding: {
        x: { field: 'xStart', type: 'quantitative' },
        x2: { field: 'xEnd' },
      },
    });
    const codes = compiled.gaps.map((entry) => entry.code);
    expect(codes).to.include('mark:rule-segment-x');
    expect(compiled.referenceLines).to.have.length(0);
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

  it('reports a partial gap when both x and y are set (point rule approximated as crossing lines)', () => {
    const compiled = compileSpec({
      data: { values: [{ x: 1, y: 2 }] },
      mark: 'rule',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    });
    const gap = compiled.gaps.find(
      (entry) => entry.code === 'mark:rule-point-approximated-as-crossing-lines',
    );
    expect(gap?.severity).to.equal('partial');
    expect(compiled.referenceLines).to.deep.equal([
      { axis: 'y', value: 2, lineStyle: undefined },
      { axis: 'x', value: 1, lineStyle: undefined },
    ]);
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
});
