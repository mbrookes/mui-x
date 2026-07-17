import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioDataSource, StudioExpressionField } from '../../../models';

const lineChartSpy = vi.fn();

vi.mock('@mui/x-charts/LineChart', () => ({
  LineChart: (props: unknown) => {
    lineChartSpy(props);
    return <div data-testid="line-chart" />;
  },
}));

// eslint-disable-next-line import/first
import { StudioLineAreaChart, type StudioLineAreaChartProps } from './StudioLineAreaChart';

const theme = createTheme();

type SeriesEntry = {
  id: string;
  data: (number | null)[];
  label?: string;
  area?: boolean;
  connectNulls?: boolean;
  color?: string;
  stack?: string;
  stackOrder?: string;
  yAxisId?: string;
  valueFormatter?: (value: number | null, context: { dataIndex: number }) => string;
};

type LineCallProps = {
  series: SeriesEntry[];
  colors?: string[];
  highlightedItem?: { seriesId: string; dataIndex: number } | null;
  highlightedAxis?: Array<{ axisId: string; dataIndex: number }>;
  yAxis: Array<{ id?: string; position?: string }>;
};

function lastLineProps(): LineCallProps {
  return lineChartSpy.mock.calls.at(-1)?.[0] as LineCallProps;
}

const noop = () => {};
const identity = (label: string | number) => String(label);

function baseProps(overrides: Partial<StudioLineAreaChartProps> = {}): StudioLineAreaChartProps {
  return {
    chartType: 'line',
    height: 300,
    chartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
    allChartData: null,
    seriesFieldData: null,
    allSeriesFieldData: null,
    multiYData: null,
    allMultiYData: null,
    activeYFields: ['total'],
    dataSource: undefined,
    expressionFields: [],
    xGroupBy: undefined,
    formatLabel: identity,
    forecast: undefined,
    forecastSeriesLabel: 'Forecast',
    defaultSeriesLabel: 'Value',
    chartColors: undefined,
    resolvedChartColors: ['#111111', '#222222', '#333333', '#444444'],
    getSeriesColor: () => undefined,
    shouldShowGhost: false,
    preserveXFieldBaseline: true,
    preserveSplitByBaseline: true,
    skipAnimation: false,
    getSelectedDataIndices: () => [],
    hoveredItem: null,
    hoveredAxis: null,
    hasActiveXFilter: false,
    hasIncomingCrossFilters: false,
    onHoverChange: noop,
    onAxisHoverChange: noop,
    onItemClick: noop,
    ...overrides,
  };
}

describe('StudioLineAreaChart', () => {
  const { render } = createRenderer();

  const renderChart = (props: StudioLineAreaChartProps) =>
    render(
      <ThemeProvider theme={theme}>
        <StudioLineAreaChart {...props} />
      </ThemeProvider>,
    );

  beforeEach(() => {
    lineChartSpy.mockClear();
  });

  it('renders a single-series line with connectNulls and area=false', () => {
    renderChart(baseProps());
    const props = lastLineProps();
    expect(props.series).toHaveLength(1);
    expect(props.series[0].id).toBe('cross-filter-series');
    expect(props.series[0].data).toEqual([10, 20, 30]);
    expect(props.series[0].area).toBe(false);
    expect(props.series[0].connectNulls).toBe(true);
  });

  it('renders a single-series area with area=true', () => {
    renderChart(baseProps({ chartType: 'area' }));
    const props = lastLineProps();
    expect(props.series).toHaveLength(1);
    expect(props.series[0].id).toBe('cross-filter-series');
    expect(props.series[0].area).toBe(true);
  });

  it('renders a faded ghost line at 25% alpha and gives the active series the cross-highlight formatter', () => {
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: { labels: ['A', 'B'], values: [4, 6] },
        allChartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
      }),
    );
    const props = lastLineProps();
    const ghost = props.series.find((s) => s.id === 'cross-filter-series-ghost');
    const active = props.series.find((s) => s.id === 'cross-filter-series');
    expect(ghost).toBeDefined();
    // Ghost renders the full baseline (all-data) values.
    expect(ghost!.data).toEqual([10, 20, 30]);
    // Alpha is applied via `color-mix()` (finding 3.7's fix, mirrored from StudioPieChart) so
    // it stays correct regardless of the input color's format — not a hex-alpha string suffix.
    expect(ghost!.color).toBe(`color-mix(in srgb, ${active!.color} 25%, transparent)`);
    // The active series formatter is the cross-highlight ("filtered / total") formatter, which
    // compares against the baseline value at the hovered index rather than echoing the value.
    const formatted = active!.valueFormatter!(4, { dataIndex: 0 });
    expect(formatted).toContain('/');
  });

  it('renders a faded ghost area at ~19% alpha', () => {
    renderChart(
      baseProps({
        chartType: 'area',
        chartData: { labels: ['A', 'B'], values: [4, 6] },
        allChartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
      }),
    );
    const props = lastLineProps();
    const ghost = props.series.find((s) => s.id === 'cross-filter-series-ghost');
    const active = props.series.find((s) => s.id === 'cross-filter-series');
    expect(ghost).toBeDefined();
    expect(ghost!.color).toBe(`color-mix(in srgb, ${active!.color} 19%, transparent)`);
  });

  it('applies ghost alpha via color-mix so a non-hex color (e.g. rgb()) still fades correctly', () => {
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: { labels: ['A', 'B'], values: [4, 6] },
        allChartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
        resolvedChartColors: ['rgb(10, 20, 30)', '#222222', '#333333', '#444444'],
      }),
    );
    const props = lastLineProps();
    const ghost = props.series.find((s) => s.id === 'cross-filter-series-ghost');
    // String concatenation (`rgb(10, 20, 30)40`) would be an invalid paint string; color-mix
    // wraps the color value instead so it is always valid regardless of format.
    expect(ghost!.color).toBe('color-mix(in srgb, rgb(10, 20, 30) 25%, transparent)');
  });

  it('suppresses the single-series ghost when preserveXFieldBaseline is false', () => {
    renderChart(
      baseProps({
        chartData: { labels: ['A', 'B'], values: [4, 6] },
        allChartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
        shouldShowGhost: true,
        preserveXFieldBaseline: false,
      }),
    );
    const props = lastLineProps();
    expect(props.series.find((s) => s.id.endsWith('-ghost'))).toBeUndefined();
    // Without a ghost, the active series shows the filtered data directly.
    expect(props.series[0].data).toEqual([4, 6]);
  });

  it('adds a forecast trend line and confidence bands for line charts', () => {
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
        forecast: { enabled: true, periods: 2, showConfidenceBands: true },
      }),
    );
    const props = lastLineProps();
    const ids = props.series.map((s) => s.id);
    expect(ids).toContain('__forecast__');
    expect(ids).toContain('__forecast_upper__');
    expect(ids).toContain('__forecast_lower__');
    const upper = props.series.find((s) => s.id === '__forecast_upper__')!;
    const lower = props.series.find((s) => s.id === '__forecast_lower__')!;
    expect(upper.stack).toBe('confidence');
    expect(lower.stack).toBe('confidence');
    expect(lower.color).toBe('transparent');
    const trend = props.series.find((s) => s.id === '__forecast__')!;
    expect(trend.label).toBe('Forecast');
    expect(trend.area).toBe(false);
  });

  // Regression for finding 1 (Tier 1): a prior fix made `__forecast_upper__` carry the band
  // WIDTH (relative to the ~0 connection point) rather than the absolute upper bound, relying
  // on d3-stack's `offset: 'none'` to SUM `lower + width` back into the absolute top edge. But
  // both series kept `stackOrder: 'ascending'` (by-sum order), which decides which series is the
  // stack BASE by comparing `Σvalues` — and once `upper` carries a small width instead of a large
  // absolute value, a typical "signal clearly above its noise band" series has `Σwidth < Σlower`,
  // which flips `ascending` order to put the (tinted) width series at the bottom and the
  // (transparent) lower-bound series on top: the confidence band collapses to a thin strip
  // hugging the x-axis with no visible tint around the forecast line. The fix pins the stacking
  // role to array order (`lower` first, `stackOrder: 'none'`) instead of leaving it to the
  // data-dependent by-sum comparison. See the "forecast confidence band stacking geometry"
  // describe block below for a numeric proof this now produces the correct rendered top edge in
  // both the signal > noise and signal < noise cases.
  it('lists __forecast_lower__ before __forecast_upper__ with stackOrder "none" so the stacking role never depends on which series has the larger sum', () => {
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
        forecast: { enabled: true, periods: 2, showConfidenceBands: true },
      }),
    );
    const props = lastLineProps();
    const ids = props.series.map((s) => s.id);
    const upperIndex = ids.indexOf('__forecast_upper__');
    const lowerIndex = ids.indexOf('__forecast_lower__');
    expect(lowerIndex).toBeGreaterThanOrEqual(0);
    expect(upperIndex).toBeGreaterThan(lowerIndex);

    const upper = props.series.find((s) => s.id === '__forecast_upper__')!;
    const lower = props.series.find((s) => s.id === '__forecast_lower__')!;
    // `stackOrder: 'none'` = d3's `stackOrderNone` = definition-order stacking, independent
    // of either series' sum — NOT `'ascending'` (by-sum order), which is what regressed.
    expect(lower.stackOrder).toBe('none');
    expect(upper.stackOrder).toBe('none');
  });

  it('adds a forecast trend line but no confidence bands for area charts', () => {
    renderChart(
      baseProps({
        chartType: 'area',
        chartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
        forecast: { enabled: true, periods: 2, showConfidenceBands: true },
      }),
    );
    const props = lastLineProps();
    const ids = props.series.map((s) => s.id);
    expect(ids).toContain('__forecast__');
    expect(ids).not.toContain('__forecast_upper__');
    expect(ids).not.toContain('__forecast_lower__');
    // Area forecast trend is itself an area series.
    expect(props.series.find((s) => s.id === '__forecast__')!.area).toBe(true);
  });

  it('never renders a forecast for area-stacked / area-100 chart types', () => {
    (['area-stacked', 'area-100'] as const).forEach((chartType) => {
      lineChartSpy.mockClear();
      renderChart(
        baseProps({
          chartType,
          chartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
          forecast: { enabled: true, periods: 2, showConfidenceBands: true },
        }),
      );
      const ids = lastLineProps().series.map((s) => s.id);
      expect(ids).not.toContain('__forecast__');
    });
  });

  it('suppresses the forecast entirely when the ghost is active', () => {
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: { labels: ['A', 'B'], values: [10, 20] },
        allChartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
        forecast: { enabled: true, periods: 2, showConfidenceBands: true },
      }),
    );
    const ids = lastLineProps().series.map((s) => s.id);
    expect(ids).not.toContain('__forecast__');
    expect(ids).toContain('cross-filter-series-ghost');
  });

  it('renders one line per split-by category, with ghost series at 25% alpha when active', () => {
    const seriesFieldData = {
      labels: ['Q1', 'Q2'],
      seriesNames: ['North', 'South'],
      seriesData: { North: [1, 2], South: [3, 4] },
    };
    const allSeriesFieldData = {
      labels: ['Q1', 'Q2', 'Q3'],
      seriesNames: ['North', 'South'],
      seriesData: { North: [1, 2, 5], South: [3, 4, 6] },
    };
    const colorByName: Record<string, string> = { North: '#aaaaaa', South: '#bbbbbb' };
    renderChart(
      baseProps({
        chartType: 'line',
        seriesFieldData,
        allSeriesFieldData,
        shouldShowGhost: true,
        preserveSplitByBaseline: true,
        getSeriesColor: (name) => colorByName[String(name)],
      }),
    );
    const props = lastLineProps();
    const ghostIds = props.series.filter((s) => s.id.endsWith('-ghost')).map((s) => s.id);
    expect(ghostIds).toEqual(['North-ghost', 'South-ghost']);
    const northGhost = props.series.find((s) => s.id === 'North-ghost')!;
    expect(northGhost.color).toBe('color-mix(in srgb, #aaaaaa 25%, transparent)');
    // Active (non-ghost) series exist for each category.
    expect(props.series.filter((s) => !s.id.endsWith('-ghost')).map((s) => s.id)).toEqual([
      'North',
      'South',
    ]);
  });

  it('suppresses split-by ghost series when preserveSplitByBaseline is false', () => {
    const seriesFieldData = {
      labels: ['Q1', 'Q2'],
      seriesNames: ['North', 'South'],
      seriesData: { North: [1, 2], South: [3, 4] },
    };
    const allSeriesFieldData = {
      labels: ['Q1', 'Q2', 'Q3'],
      seriesNames: ['North', 'South'],
      seriesData: { North: [1, 2, 5], South: [3, 4, 6] },
    };
    renderChart(
      baseProps({
        chartType: 'line',
        seriesFieldData,
        allSeriesFieldData,
        shouldShowGhost: true,
        preserveSplitByBaseline: false,
      }),
    );
    expect(lastLineProps().series.find((s) => s.id.endsWith('-ghost'))).toBeUndefined();
  });

  it('never renders split-by ghost series for stacked area variants', () => {
    const seriesFieldData = {
      labels: ['Q1', 'Q2'],
      seriesNames: ['North', 'South'],
      seriesData: { North: [1, 2], South: [3, 4] },
    };
    const allSeriesFieldData = {
      labels: ['Q1', 'Q2', 'Q3'],
      seriesNames: ['North', 'South'],
      seriesData: { North: [1, 2, 5], South: [3, 4, 6] },
    };
    renderChart(
      baseProps({
        chartType: 'area-stacked',
        seriesFieldData,
        allSeriesFieldData,
        shouldShowGhost: true,
        preserveSplitByBaseline: true,
      }),
    );
    expect(lastLineProps().series.find((s) => s.id.endsWith('-ghost'))).toBeUndefined();
  });

  it('uses independent left/right axes for an unstacked multi-Y chart with >1 series', () => {
    const multiYData = {
      labels: ['A', 'B'],
      series: [
        { fieldId: 'revenue', values: [10, 20] },
        { fieldId: 'cost', values: [5, 7] },
      ],
    };
    renderChart(baseProps({ chartType: 'line', chartData: null, multiYData }));
    const props = lastLineProps();
    expect(props.yAxis).toHaveLength(2);
    expect(props.yAxis[0].position).toBe('left');
    expect(props.yAxis[1].position).toBe('right');
    // Rendered series ids carry the index suffix.
    expect(props.series.map((s) => s.id)).toEqual(['revenue-0', 'cost-1']);
    // Each series binds to its own axis via `yAxisId` (the real x-charts prop, not the
    // dead `yAxisKey`), matching the per-axis ids above (finding 1.1).
    expect(props.yAxis[0].id).toBe('y-0');
    expect(props.yAxis[1].id).toBe('y-1');
    expect(props.series.map((s) => s.yAxisId)).toEqual(['y-0', 'y-1']);
  });

  it('renders multi-Y ghost series ids suffixed with the field index and -ghost when active', () => {
    const multiYData = {
      labels: ['A', 'B'],
      series: [{ fieldId: 'revenue', values: [10, 20] }],
    };
    const allMultiYData = {
      labels: ['A', 'B', 'C'],
      series: [{ fieldId: 'revenue', values: [10, 20, 30] }],
    };
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: null,
        multiYData,
        allMultiYData,
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
      }),
    );
    const props = lastLineProps();
    expect(props.series.map((s) => s.id)).toContain('revenue-0-ghost');
  });

  it('highlights the multi-Y cross-filter selection against the suffixed first series id', () => {
    // The rendered series ids carry an index suffix (`${fieldId}-${i}`), so the highlighted
    // seriesId must be `${fieldId}-0` (the first rendered series) for the cross-filter highlight
    // to actually match a rendered series.
    const multiYData = {
      labels: ['A', 'B', 'C'],
      series: [{ fieldId: 'revenue', values: [10, 20, 30] }],
    };
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: null,
        multiYData,
        getSelectedDataIndices: () => [1],
      }),
    );
    const props = lastLineProps();
    expect(props.highlightedItem).toEqual({ seriesId: 'revenue-0', dataIndex: 1 });
    // The highlighted id is among the rendered (suffixed) series ids.
    expect(props.series.map((s) => s.id)).toContain('revenue-0');
  });

  it('highlights the suffixed first series id in the multi-Y ghost-active path', () => {
    const multiYData = {
      labels: ['A', 'B'],
      series: [{ fieldId: 'revenue', values: [10, 20] }],
    };
    const allMultiYData = {
      labels: ['A', 'B', 'C'],
      series: [{ fieldId: 'revenue', values: [10, 20, 30] }],
    };
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: null,
        multiYData,
        allMultiYData,
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
        getSelectedDataIndices: () => [1],
      }),
    );
    const props = lastLineProps();
    expect(props.highlightedItem).toEqual({ seriesId: 'revenue-0', dataIndex: 1 });
    expect(props.series.map((s) => s.id)).toContain('revenue-0');
  });

  // Regression for finding 2.1: the normal (non-ghost) multi-Y branch used to delegate to
  // `buildMultiYLineSeries`, whose internal field lookup never consulted expression fields
  // — so a computed y-field showed its raw field id (unformatted) in the legend/tooltip in
  // the normal state, and only resolved correctly once a ghost activated (which uses
  // `resolveFieldDef`), flipping back when the ghost cleared. Both branches must resolve
  // the SAME label/format for the same field, whether or not a ghost is active.
  it('resolves an expression (computed) y-field label/format identically in the ghost and non-ghost multi-Y branches', () => {
    const dataSource: StudioDataSource = {
      id: 'src',
      label: 'Source',
      rows: [],
      fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
    };
    const expressionFields: StudioExpressionField[] = [
      {
        id: 'margin',
        label: 'Margin %',
        sourceId: 'src',
        isMeasure: false,
        type: 'number',
        format: 'percent',
        expression: { id: 'revenue' },
      },
    ];
    const multiYData = {
      labels: ['A', 'B'],
      series: [
        { fieldId: 'revenue', values: [10, 20] },
        { fieldId: 'margin', values: [12.345, 50] },
      ],
    };

    // Non-ghost render.
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: null,
        multiYData,
        dataSource,
        expressionFields,
      }),
    );
    const nonGhostProps = lastLineProps();
    const marginNonGhost = nonGhostProps.series.find((s) => s.id === 'margin-1')!;
    expect(marginNonGhost.label).toBe('Margin %');
    expect(marginNonGhost.valueFormatter!(12.345, { dataIndex: 0 })).toBe('12.3%');

    // Ghost render (same field) must resolve to the identical label and formatted string —
    // no flip when a cross-filter ghost activates.
    const allMultiYData = {
      labels: ['A', 'B', 'C'],
      series: [
        { fieldId: 'revenue', values: [10, 20, 30] },
        { fieldId: 'margin', values: [12.345, 50, 75] },
      ],
    };
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: null,
        multiYData,
        allMultiYData,
        dataSource,
        expressionFields,
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
      }),
    );
    const ghostProps = lastLineProps();
    const marginGhost = ghostProps.series.find((s) => s.id === 'margin-1')!;
    expect(marginGhost.label).toBe(marginNonGhost.label);
    expect(marginGhost.valueFormatter!(12.345, { dataIndex: 0 })).toBe(
      marginNonGhost.valueFormatter!(12.345, { dataIndex: 0 }),
    );
  });

  it('drives highlightedItem from getSelectedDataIndices for a single-series line', () => {
    renderChart(
      baseProps({
        chartType: 'line',
        chartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
        getSelectedDataIndices: () => [2],
      }),
    );
    expect(lastLineProps().highlightedItem).toEqual({
      seriesId: 'cross-filter-series',
      dataIndex: 2,
    });
  });

  it('suppresses stale hover highlight when an incoming cross-filter is present', () => {
    renderChart(
      baseProps({
        chartType: 'line',
        hoveredItem: { seriesId: 'cross-filter-series', dataIndex: 1 },
        hasIncomingCrossFilters: true,
      }),
    );
    expect(lastLineProps().highlightedItem).toBeNull();
  });

  it('passes hoveredItem as highlightedItem when nothing is filtering', () => {
    renderChart(
      baseProps({
        chartType: 'line',
        hoveredItem: { seriesId: 'cross-filter-series', dataIndex: 1 },
      }),
    );
    expect(lastLineProps().highlightedItem).toEqual({
      seriesId: 'cross-filter-series',
      dataIndex: 1,
    });
  });
});

// ── Finding 1 (Tier 1) regression: confidence-band stacking geometry ──
//
// `StudioLineAreaChart` mocks away `LineChart` entirely (see the top of this file), so the
// series-order/`stackOrder` assertions above can prove the PROPS passed to the chart are correct,
// but not that x-charts actually renders the right geometry from them. This block closes that gap
// by reimplementing the exact stacking math `@mui/x-charts` applies (confirmed by reading
// `packages/x-charts/src/internals/stacking/stackSeries.ts` and
// `packages/x-charts/src/internals/processLineLikeSeries.ts`):
//
//   - `stack: 'confidence'` groups `__forecast_lower__`/`__forecast_upper__` into one d3-stack
//     group, keyed in ARRAY-DEFINITION order (`d3.stack().keys(ids)`, `ids` built by pushing in
//     `seriesOrder` iteration order — i.e. the order the series appear in the `series` array).
//   - `stackOffset: 'none'` (the line/area default strategy) is d3's `stackOffsetNone`: each
//     series in stacking order gets `y0 = <running cumulative total>`, `y1 = y0 + value` — a
//     plain cumulative sum, order-dependent.
//   - `stackOrder: 'none'` is d3's `stackOrderNone`: the stacking order is simply the key order
//     above (identity), unlike `'ascending'`, which reorders by comparing each series' `Σvalues`.
//
// `computeWidgetForecast` (`forecastUtils.ts`) makes `__forecast_lower__` carry the absolute
// lower bound and `__forecast_upper__` carry the band WIDTH (`upperBound - lowerBound`), relying
// on the chart to sum them back into the absolute upper bound at the rendered top edge. That
// summation is only correct if `lower` stacks first (bottom) and `upper` (width) stacks on top —
// which is exactly what listing `lower` before `upper` with `stackOrder: 'none'` guarantees,
// regardless of either series' magnitude.
describe('forecast confidence band stacking geometry (finding 1)', () => {
  /** Cumulative-sum stack matching d3's `stackOffsetNone`, applied in the given series order. */
  function stackOffsetNone(
    seriesValues: number[][],
    order: number[],
  ): { y0: number; y1: number }[][] {
    const pointCount = seriesValues[0].length;
    const result: { y0: number; y1: number }[][] = seriesValues.map(() =>
      Array.from({ length: pointCount }, () => ({ y0: 0, y1: 0 })),
    );
    for (let point = 0; point < pointCount; point += 1) {
      let running = 0;
      for (const seriesIndex of order) {
        const value = seriesValues[seriesIndex][point];
        result[seriesIndex][point] = { y0: running, y1: running + value };
        running += value;
      }
    }
    return result;
  }

  /** `d3.stackOrderNone`: identity permutation over the series' definition order. */
  function stackOrderNone(seriesCount: number): number[] {
    return Array.from({ length: seriesCount }, (_, i) => i);
  }

  /** `d3.stackOrderAscending`: series with the smaller `Σvalues` sort first (bottom). */
  function stackOrderAscending(seriesValues: number[][]): number[] {
    const sums = seriesValues.map((values) => values.reduce((a, b) => a + b, 0));
    return sums
      .map((sum, index) => ({ sum, index }))
      .sort((a, b) => a.sum - b.sum)
      .map((entry) => entry.index);
  }

  // Two concrete numeric scenarios, mirroring `computeWidgetForecast`'s output shape at a single
  // forecast point (`lowerBand` = absolute lower bound, `upperBand` = width = upper - lower):
  const signalGreaterThanNoise = {
    // A clear upward trend (forecast ≈ 100) with modest noise (stdError = 5).
    lowerBand: [95],
    upperBand: [10], // width = upperBound(105) - lowerBound(95)
    absoluteUpperBound: 105,
  };
  const signalLessThanNoise = {
    // A near-zero/noisy series (forecast ≈ 5) with large relative noise (stdError = 50).
    lowerBand: [-45],
    upperBand: [100], // width = upperBound(55) - lowerBound(-45)
    absoluteUpperBound: 55,
  };

  it.each([
    ['signal > noise (Σwidth < Σlower)', signalGreaterThanNoise],
    ['signal < noise (Σwidth > Σlower)', signalLessThanNoise],
  ])(
    'renders the correct absolute top-of-band edge for %s under the fixed stacking',
    (_label, scenario) => {
      // Fixed array order: `__forecast_lower__` (index 0) before `__forecast_upper__` (index 1),
      // `stackOrder: 'none'` — exactly what `StudioLineAreaChart` now emits.
      const seriesValues = [scenario.lowerBand, scenario.upperBand];
      const order = stackOrderNone(seriesValues.length);
      const stacked = stackOffsetNone(seriesValues, order);

      const lowerStack = stacked[0][0];
      const upperStack = stacked[1][0];
      // The lower band's own layer spans exactly its own value (it is the stack base).
      expect(lowerStack).toEqual({ y0: 0, y1: scenario.lowerBand[0] });
      // The upper (width) layer's top edge — what actually paints as the top of the tinted
      // confidence-band area — must equal the absolute upper bound, in BOTH scenarios.
      expect(upperStack.y1).toBe(scenario.absoluteUpperBound);
    },
  );

  it('demonstrates the regression: `stackOrder: ascending` (the reverted config) produces the WRONG top edge whenever Σwidth < Σlower', () => {
    // This reproduces the exact bug the prior iteration introduced, to document why
    // `stackOrder: 'none'` (order-independent) is required instead of `'ascending'`
    // (by-sum order) — using the "signal > noise" scenario, the common real-data case.
    const { lowerBand, upperBand, absoluteUpperBound } = signalGreaterThanNoise;
    const seriesValues = [upperBand, lowerBand]; // upper listed first, as the reverted code had it
    const ascendingOrder = stackOrderAscending(seriesValues);
    // Σwidth (10) < Σlower (95) ⇒ ascending puts the WIDTH series at the bottom (index 0 here).
    expect(ascendingOrder).toEqual([0, 1]);
    const stacked = stackOffsetNone(seriesValues, ascendingOrder);
    const upperLayerTop = stacked[0][0].y1; // the tinted `__forecast_upper__` layer's top edge
    // The regression: the tinted band's visible top edge is just the width, hugging the
    // x-axis — nowhere near the real confidence bound — because it got stacked at the bottom.
    expect(upperLayerTop).toBe(upperBand[0]);
    expect(upperLayerTop).not.toBe(absoluteUpperBound);
  });
});
