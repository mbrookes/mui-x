import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { fireEvent, screen } from '@mui/internal-test-utils';
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
    it('records an initial value (no gap) for a named {name, value} param without select', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'threshold', value: 50 }],
      });
      expect(result.highlightScope).to.equal(undefined);
      expect(result.initialValues).to.deep.equal({ threshold: 50 });
      expect(gaps).to.have.length(0);
    });

    it('reports an ignored gap for a nameless value param', () => {
      const { gaps } = resolve({
        mark: 'bar',
        params: [{ value: 50 } as never],
      });
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
    it('compiles a range binding into a CompiledParamInput (no gap)', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [
          { name: 'threshold', value: 50, bind: { input: 'range', min: 0, max: 100, step: 5 } },
        ],
      });
      expect(gaps).to.have.length(0);
      expect(result.inputs).to.deep.equal([
        {
          name: 'threshold',
          kind: 'range',
          label: 'threshold',
          initialValue: 50,
          min: 0,
          max: 100,
          step: 5,
        },
      ]);
      expect(result.initialValues).to.deep.equal({ threshold: 50 });
    });

    it('defaults a range binding min/max and seeds the initial value from min', () => {
      const { result } = resolve({
        mark: 'bar',
        params: [{ name: 'x', bind: { input: 'range' } }],
      });
      const input = result.inputs?.[0];
      expect(input).to.include({ kind: 'range', min: 0, max: 100, initialValue: 0 });
      expect(input?.step).to.equal(undefined);
    });

    it('compiles a checkbox binding, defaulting the initial value to false', () => {
      const { result } = resolve({
        mark: 'bar',
        params: [{ name: 'flag', bind: { input: 'checkbox' } }],
      });
      expect(result.inputs?.[0]).to.deep.equal({
        name: 'flag',
        kind: 'checkbox',
        label: 'flag',
        initialValue: false,
      });
    });

    it('compiles a select binding with options and labels', () => {
      const { result } = resolve({
        mark: 'bar',
        params: [
          {
            name: 'cat',
            bind: { input: 'select', options: ['a', 'b'], labels: ['A', 'B'], name: 'Category' },
          },
        ],
      });
      expect(result.inputs?.[0]).to.deep.equal({
        name: 'cat',
        kind: 'select',
        label: 'Category',
        initialValue: 'a',
        options: ['a', 'b'],
        labels: ['A', 'B'],
      });
    });

    it('compiles a radio binding', () => {
      const { result } = resolve({
        mark: 'bar',
        params: [{ name: 'r', value: 2, bind: { input: 'radio', options: [1, 2, 3] } }],
      });
      expect(result.inputs?.[0]).to.include({ kind: 'radio', initialValue: 2 });
    });

    it('reports param:bind-options and drops a select without options', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'cat', bind: { input: 'select' } }],
      });
      const gap = gaps.find((entry) => entry.code === 'param:bind-options');
      expect(gap?.severity).to.equal('unsupported');
      expect(result.inputs).to.equal(undefined);
    });

    it('reports param:bind for an unsupported input type', () => {
      const { gaps } = resolve({
        mark: 'bar',
        params: [{ name: 't', bind: { input: 'text' } }],
      });
      const gap = gaps.find((entry) => entry.code === 'param:bind');
      expect(gap?.severity).to.equal('unsupported');
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

  describe('scale-bound interval (zoom)', () => {
    it('maps a scale-bound interval to full x/y zoom with no interval gap', () => {
      const { result, gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'grid', select: 'interval', bind: 'scales' }],
      });
      expect(result.zoom).to.deep.equal({ x: true, y: true });
      expect(gaps.map((entry) => entry.code)).to.not.include('param:interval');
    });

    it('restricts zoom to x when encodings: ["x"]', () => {
      const { result } = resolve({
        mark: 'bar',
        params: [{ name: 'grid', select: { type: 'interval', encodings: ['x'] }, bind: 'scales' }],
      });
      expect(result.zoom).to.deep.equal({ x: true, y: false });
    });

    it('restricts zoom to y when encodings: ["y"]', () => {
      const { result } = resolve({
        mark: 'bar',
        params: [{ name: 'grid', select: { type: 'interval', encodings: ['y'] }, bind: 'scales' }],
      });
      expect(result.zoom).to.deep.equal({ x: false, y: true });
    });

    it('ORs multiple scale-bound intervals together', () => {
      const { result } = resolve({
        mark: 'bar',
        params: [
          { name: 'gx', select: { type: 'interval', encodings: ['x'] }, bind: 'scales' },
          { name: 'gy', select: { type: 'interval', encodings: ['y'] }, bind: 'scales' },
        ],
      });
      expect(result.zoom).to.deep.equal({ x: true, y: true });
    });

    it('reports param:interval-init (ignored) for a scale-bound interval with an initial value', () => {
      const { gaps } = resolve({
        mark: 'bar',
        params: [{ name: 'grid', select: 'interval', value: { x: [0, 1] }, bind: 'scales' }],
      });
      const gap = gaps.find((entry) => entry.code === 'param:interval-init');
      expect(gap?.severity).to.equal('ignored');
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
      const { result, gaps } = resolve({
        data: { values: [{ x: 1, y: 1 }] },
        params: [{ name: 'threshold', value: 10 }],
        layer: [{ mark: 'line', encoding: {}, params: [{ name: 'brush', select: 'interval' }] }],
      } as unknown as VegaLiteSpec);
      // The named top-level variable records an initial value (no gap); the
      // layer's plain interval selection stays a partial gap.
      expect(gaps.map((entry) => entry.code)).to.deep.equal(['param:interval']);
      expect(result.initialValues).to.deep.equal({ threshold: 10 });
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

  it('flags axis zoom and reports no interval gap for a scale-bound interval', () => {
    const compiled = compileSpec({
      ...barSpec,
      params: [{ name: 'grid', select: 'interval', bind: 'scales' }],
    });
    expect(compiled.zoom).to.deep.equal({ x: true, y: true });
    expect((compiled.xAxis?.config as { zoom?: boolean }).zoom).to.equal(true);
    expect((compiled.yAxis?.config as { zoom?: boolean }).zoom).to.equal(true);
    expect(compiled.gaps.map((gap) => gap.code)).to.not.include('param:interval');
  });

  it('only flags the x axis for an x-restricted scale-bound interval', () => {
    const compiled = compileSpec({
      ...barSpec,
      params: [{ name: 'grid', select: { type: 'interval', encodings: ['x'] }, bind: 'scales' }],
    });
    expect((compiled.xAxis?.config as { zoom?: boolean }).zoom).to.equal(true);
    expect((compiled.yAxis?.config as { zoom?: boolean }).zoom).to.equal(undefined);
  });

  it('reports param:interval-scales-noncartesian for a scale binding on a polar chart', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { c: 'A', v: 1 },
          { c: 'B', v: 2 },
        ],
      },
      mark: 'arc',
      encoding: {
        theta: { field: 'v', type: 'quantitative' },
        color: { field: 'c', type: 'nominal' },
      },
      params: [{ name: 'grid', select: 'interval', bind: 'scales' }],
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'param:interval-scales-noncartesian');
    expect(gap?.severity).to.equal('partial');
  });

  it('feeds a named variable param value to a calculate expression', () => {
    const compiled = compileSpec({
      data: { values: [{ amount: 5 }, { amount: 30 }] },
      transform: [{ calculate: "datum.amount > cutoff ? 'HI' : 'LO'", as: 'band' }],
      mark: 'bar',
      encoding: {
        x: { field: 'band', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
      params: [{ name: 'cutoff', value: 20 }],
    });
    expect(compiled.xAxis?.categories).to.deep.equal(['LO', 'HI']);
    expect(compiled.paramValues).to.deep.equal({ cutoff: 20 });
  });

  it('lets options.params override the spec-declared initial value', () => {
    const compiled = compileSpec(
      {
        data: { values: [{ amount: 5 }, { amount: 30 }] },
        transform: [{ calculate: "datum.amount > cutoff ? 'HI' : 'LO'", as: 'band' }],
        mark: 'bar',
        encoding: {
          x: { field: 'band', type: 'nominal' },
          y: { field: 'amount', type: 'quantitative' },
        },
        params: [{ name: 'cutoff', value: 20 }],
      },
      { params: { cutoff: 100 } },
    );
    // With cutoff raised to 100, both rows fall in the 'LO' band.
    expect(compiled.xAxis?.categories).to.deep.equal(['LO']);
    expect(compiled.paramValues).to.deep.equal({ cutoff: 100 });
  });

  it('exposes bound input descriptors through compiled.inputs', () => {
    const compiled = compileSpec({
      ...barSpec,
      params: [{ name: 'threshold', value: 10, bind: { input: 'range', min: 0, max: 50 } }],
    });
    expect(compiled.inputs).to.deep.equal([
      { name: 'threshold', kind: 'range', label: 'threshold', initialValue: 10, min: 0, max: 50 },
    ]);
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

describe('<VegaLiteChart /> bound input widgets', () => {
  const { render } = createRenderer();

  it('renders a checkbox control and flips a calculate-driven bar count on change', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', amount: 1 },
          { cat: 'B', amount: 2 },
        ],
      },
      transform: [{ calculate: "showAll ? datum.cat : 'ALL'", as: 'group' }],
      mark: 'bar',
      encoding: {
        x: { field: 'group', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
      params: [{ name: 'showAll', value: true, bind: { input: 'checkbox' } }],
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).to.equal(true);
    expect(container.querySelectorAll(`.${barClasses.element}`).length).to.equal(2);

    fireEvent.click(checkbox);

    expect(container.querySelectorAll(`.${barClasses.element}`).length).to.equal(1);
  });

  it('renders a range slider control for a range binding', () => {
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
      params: [{ name: 'threshold', value: 30, bind: { input: 'range', min: 0, max: 100 } }],
    };
    render(<VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />);
    expect(screen.getByRole('slider')).not.to.equal(null);
  });

  it('renders the widget toolbar once for a faceted spec with a bound param', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { region: 'N', category: 'A', amount: 3 },
          { region: 'S', category: 'A', amount: 5 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
        column: { field: 'region', type: 'nominal' },
      },
      params: [{ name: 'flag', bind: { input: 'checkbox' } }],
    };
    render(<VegaLiteChart width={600} height={300} spec={spec} onGaps={() => {}} />);
    expect(screen.getAllByRole('checkbox')).to.have.length(1);
  });
});

describe('<VegaLiteChart /> scale-bound zoom', () => {
  const { render } = createRenderer();

  it('renders a bar chart with a scale-bound interval selection without crashing', () => {
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
      params: [{ name: 'grid', select: 'interval', bind: 'scales' }],
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    expect(container.querySelectorAll(`.${barClasses.element}`).length).to.equal(2);
  });
});
