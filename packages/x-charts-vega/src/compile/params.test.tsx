import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { barClasses } from '@mui/x-charts/BarChart';
import { resolveParams } from './params';
import { compileSpec } from './index';
import { createGapCollector } from '../gaps';
import { VegaLiteChart } from '../VegaLiteChart';
import type { VegaLiteSpec } from '../types';

function resolve(spec: VegaLiteSpec) {
  const gaps = createGapCollector();
  const result = resolveParams(spec, gaps);
  return { result, gaps: gaps.list() };
}

describe('resolveParams', () => {
  describe('point selection', () => {
    it('returns a highlightScope for the string shorthand `select: "point"`', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'select', select: 'point' }],
      });
      expect(result.highlightScope).to.deep.equal({ highlight: 'item', fade: 'global' });
      expect(gaps).to.have.length(0);
    });

    it('returns a highlightScope for the object form `select: {type: "point"}`', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'select', select: { type: 'point' } }],
      });
      expect(result.highlightScope).to.deep.equal({ highlight: 'item', fade: 'global' });
      expect(gaps).to.have.length(0);
    });

    it('reports one ignored gap per refinement present', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [
          {
            name: 'select',
            select: {
              type: 'point',
              on: 'mouseover',
              toggle: 'event.shiftKey',
              fields: ['category'],
              encodings: ['color'],
              nearest: true,
            },
          },
        ],
      });
      expect(result.highlightScope).to.deep.equal({ highlight: 'item', fade: 'global' });
      const codes = gaps.map((gap) => gap.code).sort();
      expect(codes).to.deep.equal(
        [
          'param:point-on',
          'param:point-toggle',
          'param:point-fields',
          'param:point-encodings',
          'param:point-nearest',
        ].sort(),
      );
      gaps.forEach((gap) => expect(gap.severity).to.equal('ignored'));
    });

    it('does not report refinement gaps when none are present', () => {
      const { gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'select', select: { type: 'point' } }],
      });
      expect(gaps).to.have.length(0);
    });

    it('reports only the refinements that are actually present', () => {
      const { gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'select', select: { type: 'point', toggle: false } }],
      });
      expect(gaps.map((gap) => gap.code)).to.deep.equal(['param:point-toggle']);
    });

    it('tags the gap path with the param index and refinement key', () => {
      const { gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'select', select: { type: 'point', nearest: true } }],
      });
      expect(gaps[0].path).to.equal('$.params[0].select.nearest');
    });
  });

  describe('interval selection', () => {
    it('reports a partial gap for the string shorthand `select: "interval"`', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'brush', select: 'interval' }],
      });
      expect(result.highlightScope).to.equal(undefined);
      const gap = gaps.find((entry) => entry.code === 'param:interval');
      expect(gap?.severity).to.equal('partial');
      expect(gap?.path).to.equal('$.params[0]');
    });

    it('reports a partial gap for the object form `select: {type: "interval"}`', () => {
      const { gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] } }],
      });
      const gap = gaps.find((entry) => entry.code === 'param:interval');
      expect(gap?.severity).to.equal('partial');
      // Point-only refinement gaps must not fire for an interval selection.
      expect(gaps.map((entry) => entry.code)).to.not.include('param:point-encodings');
    });
  });

  describe('value-only params (variables)', () => {
    it('reports an ignored gap for a {name, value} param without select', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'threshold', value: 50 }],
      });
      expect(result.highlightScope).to.equal(undefined);
      const gap = gaps.find((entry) => entry.code === 'param:variable');
      expect(gap?.severity).to.equal('ignored');
      expect(gap?.path).to.equal('$.params[0]');
    });

    it('does not report a variable gap for a param with neither select, value, nor bind', () => {
      const { gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'unused' }],
      });
      expect(gaps).to.have.length(0);
    });
  });

  describe('bind (input widgets)', () => {
    it('reports an unsupported gap for a bound variable param', () => {
      const { gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'threshold', value: 50, bind: { input: 'range', min: 0, max: 100 } }],
      });
      const bindGap = gaps.find((entry) => entry.code === 'param:bind');
      expect(bindGap?.severity).to.equal('unsupported');
      expect(bindGap?.path).to.equal('$.params[0].bind');
      // The value is still reported separately as a variable gap.
      expect(gaps.map((entry) => entry.code)).to.include('param:variable');
    });

    it('reports an unsupported gap for a legend-bound point selection, in addition to the highlightScope', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'select', select: 'point', bind: 'legend' }],
      });
      expect(result.highlightScope).to.deep.equal({ highlight: 'item', fade: 'global' });
      const gap = gaps.find((entry) => entry.code === 'param:bind');
      expect(gap?.severity).to.equal('unsupported');
    });
  });

  describe('multiple params / no params', () => {
    it('returns an empty resolution and no gaps when params is absent', () => {
      const { result, gaps } = resolve({ mark: 'bar' });
      expect(result).to.deep.equal({});
      expect(gaps).to.have.length(0);
    });

    it('sets the highlightScope once even with multiple point-select params', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [
          { name: 'a', select: 'point' },
          { name: 'b', select: 'point' },
        ],
      });
      expect(result.highlightScope).to.deep.equal({ highlight: 'item', fade: 'global' });
      expect(gaps).to.have.length(0);
    });
  });

  describe('layered specs', () => {
    it('collects params from first-level layer entries', () => {
      const { result, gaps } = resolve({
        data: { values: [{ x: 1, y: 1 }] },
        layer: [
          {
            mark: 'line',
            encoding: {},
            params: [{ name: 'select', select: 'point' }],
          },
          {
            mark: 'point',
            encoding: {},
            params: [{ name: 'brush', select: 'interval' }],
          },
        ],
      } as unknown as VegaLiteSpec);
      expect(result.highlightScope).to.deep.equal({ highlight: 'item', fade: 'global' });
      const intervalGap = gaps.find((entry) => entry.code === 'param:interval');
      expect(intervalGap?.path).to.equal('layer[1].params[0]');
    });

    it('collects params from both the top level and layer entries', () => {
      const { gaps } = resolve({
        data: { values: [{ x: 1, y: 1 }] },
        params: [{ name: 'threshold', value: 10 }],
        layer: [{ mark: 'line', encoding: {}, params: [{ name: 'brush', select: 'interval' }] }],
      } as unknown as VegaLiteSpec);
      expect(gaps.map((entry) => entry.code).sort()).to.deep.equal(
        ['param:interval', 'param:variable'].sort(),
      );
    });
  });
});

describe('resolveParams via compileSpec', () => {
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
    params: [{ name: 'select', select: 'point' }],
  };

  it('applies the resolved highlightScope to every series lacking one', () => {
    const compiled = compileSpec(barSpec);
    expect(compiled.series.length).to.be.greaterThan(0);
    compiled.series.forEach((entry) => {
      expect((entry as { highlightScope?: unknown }).highlightScope).to.deep.equal({
        highlight: 'item',
        fade: 'global',
      });
    });
  });

  // The "only fill in series that don't already carry a highlightScope" rule
  // is enforced by the orchestrator (compile/index.ts, out of this unit's
  // ownership), not by resolveParams itself — resolveParams only reports
  // what the spec's params say, unconditionally. No built-in mark compiler
  // currently sets its own highlightScope, so that guard has no spec-level
  // fixture to exercise end-to-end from this file.

  it('surfaces the interval-selection gap through compileSpec', () => {
    const compiled = compileSpec({
      ...barSpec,
      params: [{ name: 'brush', select: 'interval' }],
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'param:interval');
    expect(gap?.severity).to.equal('partial');
  });
});

describe('<VegaLiteChart /> point-select spec', () => {
  const { render } = createRenderer();

  it('still renders a bar chart when the spec declares a point selection param', () => {
    const spec: VegaLiteSpec = {
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
      params: [{ name: 'select', select: 'point' }],
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    const bars = container.querySelectorAll(`.${barClasses.element}`);
    expect(bars.length).to.equal(2);
  });
});
