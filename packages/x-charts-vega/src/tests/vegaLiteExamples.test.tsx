import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { barClasses } from '@mui/x-charts/BarChart';
import { lineClasses } from '@mui/x-charts/LineChart';
import { pieClasses } from '@mui/x-charts/PieChart';
import { legendClasses } from '@mui/x-charts/ChartsLegend';
import { referenceLineClasses } from '@mui/x-charts/ChartsReferenceLine';
import { compileSpec } from '../compile';
import { VegaLiteChart } from '../VegaLiteChart';
import type { VegaLiteSpec } from '../types';

/*
 * "Golden" integration tests: a batch of canonical Vega-Lite example-gallery
 * specs (bar/line/area/scatter/pie/rule families, plus a transform
 * pipeline), run end-to-end through `compileSpec` and asserted against the
 * compiled structure. A representative subset is also rendered through
 * `<VegaLiteChart />` in jsdom to confirm the compiled structure produces
 * real DOM (bars/lines/arcs/legend/reference-lines).
 *
 * These tests document CURRENT behavior. Where a spec would need a lenient
 * assertion to pass despite an actual bug, the test is `it.skip`ped with a
 * `// BUG:` comment instead of being loosened — see the skipped tests below.
 */

type BarSeries = {
  type: string;
  data: unknown[];
  layout?: string;
  stack?: string;
  stackOffset?: string;
  color?: string;
  label?: string;
};
type LineSeries = {
  type: string;
  data: unknown[];
  label?: string;
  area?: boolean;
  showMark?: boolean;
  stack?: string;
  stackOffset?: string;
  color?: string;
};
type ScatterSeries = {
  type: string;
  data: ReadonlyArray<{ x: unknown; y: unknown; id: number }>;
  label?: string;
  color?: string;
  markerSize?: number;
};
type PieSeries = {
  type: string;
  data: ReadonlyArray<{ id: unknown; value: number; label?: string; color?: string }>;
  innerRadius?: number;
};

describe('Vega-Lite golden examples', () => {
  const { render } = createRenderer();

  // 1. Simple bar --------------------------------------------------------
  describe('simple bar', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', amount: 28 },
          { category: 'B', amount: 55 },
          { category: 'C', amount: 12 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    };

    it('compiles one bar series index-aligned to the category axis', () => {
      const compiled = compileSpec(spec);
      expect(compiled.chartKind).to.equal('cartesian');
      expect(compiled.xAxis?.config.scaleType).to.equal('band');
      expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B', 'C']);
      expect(compiled.yAxis?.config.scaleType).to.equal('linear');
      expect(compiled.series).to.have.length(1);
      const series = compiled.series[0] as BarSeries;
      expect(series.type).to.equal('bar');
      expect(series.data).to.deep.equal([28, 55, 12]);
      expect(compiled.gaps).to.have.length(0);
    });

    it('renders one bar rect per category', () => {
      const { container } = render(
        <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
      );
      expect(container.querySelectorAll(`.${barClasses.element}`)).to.have.length(3);
    });
  });

  // 2. Aggregate bar (mean) ----------------------------------------------
  describe('aggregate bar (mean)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', v: 2 },
          { cat: 'A', v: 4 },
          { cat: 'B', v: 10 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', aggregate: 'mean', type: 'quantitative' },
      },
    };

    it('groups by the categorical channel and computes the mean per group', () => {
      const compiled = compileSpec(spec);
      expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B']);
      const series = compiled.series[0] as BarSeries;
      expect(series.data).to.deep.equal([3, 10]);
      // See the BUG regression below: the axis label is the internal
      // synthetic column name, not a human "MEAN of v" title.
      expect(compiled.yAxis?.config.label).to.equal('__mean_v');
    });

    // BUG: `axisTitle` in compile/scales.ts has an explicit branch that
    // prefixes the aggregate op ("MEAN of v", "COUNT of Records", etc., see
    // scales.ts lines ~81-89) — but it can never fire for an encoding-level
    // `aggregate`, because `applyEncodingTransforms` (transforms/encoding.ts)
    // always strips `aggregate` and rewrites `field` to a synthetic column
    // name (e.g. "__mean_v") *before* axis resolution runs, and also resets
    // `title` to `def.title ?? undefined` (dropping any inherited title).
    // scales.ts's axisTitle then sees a plain field def named "__mean_v"
    // with no `aggregate` marker, so it falls through to using the raw
    // (synthetic, underscore-prefixed) field name as the axis title instead
    // of a human-readable aggregate label. This contradicts this package's
    // own GAPS.md, which documents axis titles as "auto-derived from field
    // name (e.g. 'COUNT of Sales')".
    it.skip('BUG: encoding-level aggregate (e.g. y: {field, aggregate: "mean"}) never produces a "MEAN of v"-style axis title; it shows the raw synthetic column name instead', () => {
      const compiled = compileSpec(spec);
      expect(compiled.yAxis?.config.label).to.equal('MEAN of v');
    });
  });

  // 3. Stacked bar with color ---------------------------------------------
  describe('stacked bar with color', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', v: 1 },
          { cat: 'A', g: 'y', v: 2 },
          { cat: 'B', g: 'x', v: 3 },
          { cat: 'B', g: 'y', v: 4 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'g', type: 'nominal' },
      },
    };

    it('splits into one series per color group, sharing a stack id with stackOffset "none"', () => {
      const compiled = compileSpec(spec);
      expect(compiled.series).to.have.length(2);
      const [seriesX, seriesY] = compiled.series as BarSeries[];
      expect(seriesX.data).to.deep.equal([1, 3]);
      expect(seriesY.data).to.deep.equal([2, 4]);
      expect(seriesX.stack).to.equal(seriesY.stack);
      expect(seriesX.stack).to.be.a('string');
      expect(seriesX.stackOffset).to.equal('none');
      expect(seriesY.stackOffset).to.equal('none');
      expect(compiled.hasLegend).to.equal(true);
    });
  });

  // 4. Normalized stacked bar ----------------------------------------------
  describe('normalized (100%) stacked bar', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', v: 1 },
          { cat: 'A', g: 'y', v: 3 },
          { cat: 'B', g: 'x', v: 2 },
          { cat: 'B', g: 'y', v: 2 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative', stack: 'normalize' },
        color: { field: 'g', type: 'nominal' },
      },
    };

    it('maps stack:"normalize" to stackOffset "expand" for every color-split series', () => {
      const compiled = compileSpec(spec);
      const series = compiled.series as BarSeries[];
      expect(series).to.have.length(2);
      series.forEach((entry) => {
        expect(entry.stackOffset).to.equal('expand');
        expect(entry.stack).to.equal(series[0].stack);
      });
    });
  });

  // 5. Grouped bar (xOffset) -----------------------------------------------
  describe('grouped bar (xOffset)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', g: 'x', v: 1 },
          { cat: 'A', g: 'y', v: 2 },
          { cat: 'B', g: 'x', v: 3 },
          { cat: 'B', g: 'y', v: 4 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'g', type: 'nominal' },
        xOffset: { field: 'g' },
      },
    };

    it('produces ungrouped (unstacked) series when xOffset groups bars by the color field', () => {
      const compiled = compileSpec(spec);
      const series = compiled.series as BarSeries[];
      expect(series).to.have.length(2);
      series.forEach((entry) => {
        expect(entry.stack).to.equal(undefined);
        expect(entry.stackOffset).to.equal(undefined);
      });
      expect(compiled.gaps.map((gap) => gap.code)).not.to.include('encoding:bar-offset-mismatch');
    });

    it('renders four grouped bar rects (two categories x two groups) and a two-item legend', () => {
      const { container } = render(
        <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
      );
      expect(container.querySelectorAll(`.${barClasses.element}`)).to.have.length(4);
      expect(container.querySelectorAll(`.${legendClasses.series}`)).to.have.length(2);
    });
  });

  // 6. Horizontal bar -------------------------------------------------------
  describe('horizontal bar', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', amount: 28 },
          { category: 'B', amount: 55 },
        ],
      },
      mark: 'bar',
      encoding: {
        y: { field: 'category', type: 'nominal' },
        x: { field: 'amount', type: 'quantitative' },
      },
    };

    it('infers a horizontal layout from a categorical y + quantitative x', () => {
      const compiled = compileSpec(spec);
      const series = compiled.series[0] as BarSeries;
      expect(series.layout).to.equal('horizontal');
      expect(series.data).to.deep.equal([28, 55]);
      expect(compiled.yAxis?.config.scaleType).to.equal('band');
      expect(compiled.xAxis?.config.scaleType).to.equal('linear');
    });
  });

  // 7. Histogram (x bin + y count) ------------------------------------------
  describe('histogram (bin + count)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 6 }, { x: 7 }, { x: 8 }, { x: 9 }],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'x', type: 'quantitative', bin: { step: 5, extent: [0, 10] } },
        y: { aggregate: 'count', type: 'quantitative' },
      },
    };

    it('bins x into fixed-width buckets and counts rows per bucket', () => {
      const compiled = compileSpec(spec);
      expect(compiled.xAxis?.categories).to.deep.equal(['0–5', '5–10']);
      const series = compiled.series[0] as BarSeries;
      expect(series.data).to.deep.equal([3, 4]);
      // No gap: binning succeeded and count is a fully-supported aggregate op.
      expect(compiled.gaps.filter((gap) => gap.code.startsWith('encoding:bin'))).to.have.length(0);
    });
  });

  // 8. Line with point overlay ----------------------------------------------
  describe('line with point overlay', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { day: 'Mon', temp: 10 },
          { day: 'Tue', temp: 14 },
          { day: 'Wed', temp: 9 },
        ],
      },
      mark: { type: 'line', point: true },
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    };

    it('enables showMark and requests the MarkPlot overlay', () => {
      const compiled = compileSpec(spec);
      const series = compiled.series[0] as LineSeries;
      expect(series.showMark).to.equal(true);
      expect(compiled.plots).to.include('marks');
      expect(compiled.plots).to.include('line');
    });
  });

  // 9. Multi-series line (color split) ---------------------------------------
  describe('multi-series line (color split)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { day: 'Mon', temp: 10, city: 'NY' },
          { day: 'Mon', temp: 20, city: 'LA' },
          { day: 'Tue', temp: 12, city: 'NY' },
          { day: 'Tue', temp: 22, city: 'LA' },
        ],
      },
      mark: 'line',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
        color: { field: 'city', type: 'nominal' },
      },
    };

    it('produces one line series per city, index-aligned to the category axis', () => {
      const compiled = compileSpec(spec);
      expect(compiled.series).to.have.length(2);
      const [ny, la] = compiled.series as LineSeries[];
      expect(ny.data).to.deep.equal([10, 12]);
      expect(la.data).to.deep.equal([20, 22]);
      expect(compiled.gaps).to.have.length(0);
    });

    it('renders one line path per city and a two-item legend', () => {
      const { container } = render(
        <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
      );
      expect(container.querySelectorAll(`.${lineClasses.line}`)).to.have.length(2);
      expect(container.querySelectorAll(`.${legendClasses.series}`)).to.have.length(2);
    });
  });

  // BUG: `compileLineAreaMark` (marks/lineArea.ts) indexes each row's x value
  // straight into `ctx.categoryIndex(x, row[xField])` without first coercing
  // it to a `Date` for a temporal axis. `resolveChannelAxis` (compile/scales.ts)
  // builds the temporal axis's `categoryKeys` from `Date` objects (via
  // `toDate(raw)`), whose `categoryKey()` serializes as `"d:<timestamp>"`; the
  // *raw* string value's `categoryKey()` serializes as `"string:2020-01-01"`.
  // These never match, so `categoryIndex` returns -1 for every row and every
  // line/area series compiles with an all-null `data` array — the line
  // silently renders nothing, with no gap reported beyond the
  // `scale:temporal-point-approximation` *partial* gap for the axis itself
  // (which reads as "approximated", not "completely broken"). `marks/point.ts`'s
  // `resolveAxisValue` shows the fix is already known elsewhere in this
  // codebase: it explicitly calls `toDate(raw)` for a temporal axis before
  // resolving position/index — `lineArea.ts` needs the same coercion but does
  // not have it.
  it.skip('BUG: a line/area mark against a temporal x axis compiles with all-null series data (the line renders nothing)', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { day: '2020-01-01', temp: 10 },
          { day: '2020-01-02', temp: 14 },
        ],
      },
      mark: 'line',
      encoding: {
        x: { field: 'day', type: 'temporal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    const series = compiled.series[0] as LineSeries;
    expect(series.data).to.deep.equal([10, 14]);
  });

  // 10. Stacked area ---------------------------------------------------------
  describe('stacked area', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { day: 'Mon', v: 1, g: 'x' },
          { day: 'Mon', v: 2, g: 'y' },
          { day: 'Tue', v: 3, g: 'x' },
          { day: 'Tue', v: 4, g: 'y' },
        ],
      },
      mark: 'area',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'g', type: 'nominal' },
      },
    };

    it('stacks the color-split area series by default (Vega-Lite default stack: "zero")', () => {
      const compiled = compileSpec(spec);
      expect(compiled.plots).to.include('area');
      const series = compiled.series as LineSeries[];
      expect(series).to.have.length(2);
      series.forEach((entry) => {
        expect(entry.area).to.equal(true);
        expect(entry.stackOffset).to.equal('none');
      });
      expect(series[0].stack).to.equal(series[1].stack);
    });
  });

  // 11. Scatter with color groups --------------------------------------------
  describe('scatter with color groups', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, region: 'east' },
          { x: 2, y: 2, region: 'west' },
          { x: 3, y: 3, region: 'east' },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        color: { field: 'region', type: 'nominal' },
      },
    };

    it('buckets points into one scatter series per color group', () => {
      const compiled = compileSpec(spec);
      expect(compiled.plots).to.deep.equal(['scatter']);
      const series = compiled.series as ScatterSeries[];
      expect(series).to.have.length(2);
      const east = series.find((entry) => entry.label === 'east');
      const west = series.find((entry) => entry.label === 'west');
      expect(east?.data).to.have.length(2);
      expect(west?.data).to.have.length(1);
    });
  });

  // 12. Bubble-ish scatter (size field — expect partial gap) -----------------
  describe('bubble-ish scatter (size field)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { horsepower: 130, mpg: 18, weight: 3400 },
          { horsepower: 165, mpg: 15, weight: 3700 },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'horsepower', type: 'quantitative' },
        y: { field: 'mpg', type: 'quantitative' },
        size: { field: 'weight', type: 'quantitative' },
      },
    };

    it('still renders markers but reports a partial gap: per-point size-by-field is unsupported in MIT scatter', () => {
      const compiled = compileSpec(spec);
      const series = compiled.series[0] as ScatterSeries;
      expect(series.data).to.have.length(2);
      const gap = compiled.gaps.find((entry) => entry.code === 'encoding:size-field');
      expect(gap?.severity).to.equal('partial');
    });
  });

  // 13. Donut ------------------------------------------------------------
  describe('donut', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', amount: 10 },
          { category: 'B', amount: 20 },
          { category: 'C', amount: 30 },
        ],
      },
      mark: { type: 'arc', innerRadius: 60 },
      encoding: {
        theta: { field: 'amount', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
      },
    };

    it('produces a pie series with innerRadius set from mark.innerRadius', () => {
      const compiled = compileSpec(spec);
      expect(compiled.chartKind).to.equal('polar');
      const series = compiled.series[0] as PieSeries;
      expect(series.innerRadius).to.equal(60);
      expect(series.data).to.deep.equal([
        { id: 'A', value: 10, label: 'A' },
        { id: 'B', value: 20, label: 'B' },
        { id: 'C', value: 30, label: 'C' },
      ]);
    });

    it('renders one pie arc per slice', () => {
      const { container } = render(
        <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
      );
      expect(container.querySelectorAll(`.${pieClasses.arc}`)).to.have.length(3);
    });
  });

  // 14. Pie -----------------------------------------------------------------
  describe('pie', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', amount: 10 },
          { category: 'A', amount: 5 },
          { category: 'B', amount: 20 },
        ],
      },
      mark: 'arc',
      encoding: {
        theta: { field: 'amount', aggregate: 'sum', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
      },
    };

    it('aggregates theta by the color group before producing pie slices', () => {
      const compiled = compileSpec(spec);
      const series = compiled.series[0] as PieSeries;
      expect(series.innerRadius).to.equal(undefined);
      expect(series.data).to.deep.equal([
        { id: 'A', value: 15, label: 'A' },
        { id: 'B', value: 20, label: 'B' },
      ]);
    });
  });

  // 15. Layered line + rule (mean reference line) ----------------------------
  describe('layered line + rule (mean reference line)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { day: 'Mon', value: 10 },
          { day: 'Tue', value: 20 },
          { day: 'Wed', value: 30 },
        ],
      },
      layer: [
        {
          mark: 'line',
          encoding: {
            x: { field: 'day', type: 'nominal' },
            y: { field: 'value', type: 'quantitative' },
          },
        },
        {
          mark: 'rule',
          encoding: {
            y: { field: 'value', aggregate: 'mean', type: 'quantitative' },
          },
        },
      ],
    };

    it('compiles the line series and a single mean-value horizontal reference line', () => {
      const compiled = compileSpec(spec);
      expect(compiled.series).to.have.length(1);
      const lineSeries = compiled.series[0] as LineSeries;
      expect(lineSeries.data).to.deep.equal([10, 20, 30]);
      expect(compiled.referenceLines).to.deep.equal([
        { axis: 'y', value: 20, lineStyle: undefined },
      ]);
    });

    it('renders the line path together with a reference line element', () => {
      const { container } = render(
        <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
      );
      expect(container.querySelector(`.${lineClasses.line}`)).not.to.equal(null);
      expect(container.querySelector(`.${referenceLineClasses.line}`)).not.to.equal(null);
    });
  });

  // 16. Filter + calculate transform pipeline ---------------------------------
  describe('filter + calculate transform pipeline', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', raw: 5 },
          { cat: 'B', raw: 12 },
          { cat: 'C', raw: 20 },
        ],
      },
      transform: [{ filter: 'datum.raw >= 10' }, { calculate: 'datum.raw * 2', as: 'doubled' }],
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'doubled', type: 'quantitative' },
      },
    };

    it('filters rows before calculating a derived field, with no transform gaps', () => {
      const compiled = compileSpec(spec);
      expect(compiled.xAxis?.categories).to.deep.equal(['B', 'C']);
      const series = compiled.series[0] as BarSeries;
      expect(series.data).to.deep.equal([24, 40]);
      expect(compiled.gaps.filter((gap) => gap.code.startsWith('transform:'))).to.have.length(0);
    });
  });

  // --- Known-bug regression placeholders -------------------------------
  // Intentionally skipped: these document real, reproducible gaps between
  // Vega-Lite semantics and this wrapper's current output. Do not "fix" by
  // loosening the assertion — either the implementation changes, or the
  // skip (and its BUG comment) stays.

  // BUG: a `count` aggregate with NO groupby field at all (bare
  // `{aggregate: 'count'}` on y, no x/color/detail grouping field) should
  // collapse the whole dataset to a single total, matching Vega-Lite. The
  // encoding-level aggregate pass in transforms/encoding.ts computes
  // `groupFields` from GROUPING_CHANNELS, which is empty here, so all rows
  // fall into one group and the aggregate does compute the right total in
  // isolation — however, with no positional x channel at all the bar mark
  // compiler has no categorical axis to plot the resulting single bar
  // against and drops the layer with a `mark:bar-missing-axes` gap instead
  // of rendering a single "Total" bar the way Vega-Lite would (an implicit
  // "all" category). Skipped rather than asserting the empty-series result
  // as if it were correct.
  it.skip('BUG: aggregate-only bar chart with no positional category channel renders nothing instead of a single total bar', () => {
    const compiled = compileSpec({
      data: { values: [{ v: 1 }, { v: 2 }, { v: 3 }] },
      mark: 'bar',
      encoding: {
        y: { aggregate: 'count', type: 'quantitative' },
      },
    });
    expect(compiled.series).to.have.length(1);
  });
});
