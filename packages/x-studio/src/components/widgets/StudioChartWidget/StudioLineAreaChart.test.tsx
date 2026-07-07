import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  yAxisKey?: string;
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

  it('renders a faded ghost line at alpha 40 and gives the active series the cross-highlight formatter', () => {
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
    expect(ghost!.color).toBe('#11111140');
    expect(ghost!.color).toBe(`${active!.color}40`);
    // The active series formatter is the cross-highlight ("filtered / total") formatter, which
    // compares against the baseline value at the hovered index rather than echoing the value.
    const formatted = active!.valueFormatter!(4, { dataIndex: 0 });
    expect(formatted).toContain('/');
  });

  it('renders a faded ghost area at alpha 30', () => {
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
    expect(ghost!.color).toBe('#11111130');
    expect(ghost!.color).toBe(`${active!.color}30`);
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
    expect(upper.stackOrder).toBe('ascending');
    expect(lower.stack).toBe('confidence');
    expect(lower.color).toBe('transparent');
    const trend = props.series.find((s) => s.id === '__forecast__')!;
    expect(trend.label).toBe('Forecast');
    expect(trend.area).toBe(false);
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

  it('renders one line per split-by category, with ghost series at alpha 40 when active', () => {
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
    expect(northGhost.color).toBe('#aaaaaa40');
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
