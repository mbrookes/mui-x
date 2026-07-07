import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrossFilterBarContext } from './CrossFilterBarContext';
import { SourceSelectionContext } from './SourceSelectionContext';

const barChartSpy = vi.fn();

// Read the (live) cross-filter / source-selection contexts from inside the mocked BarChart so
// tests can assert on the per-bar ghost values and multi-select set the wrapping Providers feed.
let capturedBarCtx: {
  filteredValuesBySeriesId: Record<string, (number | null)[]>;
  allValuesBySeriesId: Record<string, number[]>;
} | null = null;
let capturedSourceSelection: Set<number> | null = null;

vi.mock('@mui/x-charts/BarChart', () => ({
  BarChart: (props: unknown) => {
    barChartSpy(props);
    capturedBarCtx = React.useContext(CrossFilterBarContext);
    capturedSourceSelection = React.useContext(SourceSelectionContext);
    return <div data-testid="bar-chart" />;
  },
}));

// eslint-disable-next-line import/first
import { StudioBarChart, type StudioBarChartProps } from './StudioBarChart';
// eslint-disable-next-line import/first
import { CrossFilterGhostBar } from './CrossFilterGhostBar';
// eslint-disable-next-line import/first
import { SourceSelectionBar } from './SourceSelectionBar';
// eslint-disable-next-line import/first
import { AxisFieldTooltip } from './StudioChartFieldTooltip';

const theme = createTheme();

type SeriesEntry = {
  id: string;
  data: (number | null)[];
  label?: string;
  stack?: string;
  color?: string;
  yAxisKey?: string;
  valueFormatter?: (value: number | null, context: { dataIndex: number }) => string;
};

type AxisEntry = {
  id?: string;
  data?: (string | number)[];
  scaleType?: string;
  position?: string;
  min?: number;
  max?: number;
  width?: number | string;
  height?: number | string;
  categoryGapRatio?: number;
  tickLabelStyle?: { fontSize?: string };
  valueFormatter?: (value: string | number, context?: unknown) => string;
};

type BarCallProps = {
  series: SeriesEntry[];
  xAxis: AxisEntry[];
  yAxis: AxisEntry[];
  colors?: string[];
  layout?: string;
  hideLegend?: boolean;
  margin?: { top: number; right: number; bottom: number; left: number };
  highlightedItem?: { seriesId: string; dataIndex: number } | null;
  highlightedAxis?: Array<{ axisId: string; dataIndex: number }>;
  slots?: { tooltip?: unknown; bar?: unknown };
  onHighlightChange?: (item: { seriesId: string; dataIndex: number } | null) => void;
  onAxisClick?: (
    event: { shiftKey?: boolean } | null,
    params: { axisValue?: string | number } | null,
  ) => void;
};

function lastBarProps(): BarCallProps {
  return barChartSpy.mock.calls.at(-1)?.[0] as BarCallProps;
}

const noop = () => {};
const identity = (label: string | number) => String(label);

function baseProps(overrides: Partial<StudioBarChartProps> = {}): StudioBarChartProps {
  return {
    chartType: 'bar',
    height: 300,
    barLayout: 'grouped',
    chartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
    allChartData: null,
    seriesFieldData: null,
    allSeriesFieldData: null,
    multiYData: null,
    allMultiYData: null,
    activeYFields: ['total'],
    dataSource: undefined,
    expressionFields: [],
    formatLabel: identity,
    defaultSeriesLabel: 'Value',
    barMinBandSize: undefined,
    barCategoryGapRatio: undefined,
    axisTickFontSize: undefined,
    barMaxCategories: undefined,
    barBandLabelWrap: undefined,
    wrapBandLabelMaxLines: undefined,
    chartColors: undefined,
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

describe('StudioBarChart', () => {
  const { render } = createRenderer();

  const renderChart = (props: StudioBarChartProps) =>
    render(
      <ThemeProvider theme={theme}>
        <StudioBarChart {...props} />
      </ThemeProvider>,
    );

  beforeEach(() => {
    barChartSpy.mockClear();
    capturedBarCtx = null;
    capturedSourceSelection = null;
  });

  // ── Multi-Y ────────────────────────────────────────────────────────────────
  describe('multi-Y', () => {
    const multiYData = {
      labels: ['A', 'B'],
      series: [
        { fieldId: 'revenue', values: [10, 30] },
        { fieldId: 'cost', values: [30, 10] },
      ],
    };

    it('normalizes bar-100 to percentages with a 0–100 axis and total stacking', () => {
      renderChart(baseProps({ chartType: 'bar-100', chartData: null, multiYData }));
      const props = lastBarProps();
      expect(props.series.map((s) => s.id)).toEqual(['revenue-0', 'cost-1']);
      expect(props.series[0].data).toEqual([25, 75]);
      expect(props.series[1].data).toEqual([75, 25]);
      expect(props.series[0].stack).toBe('total');
      expect(props.yAxis[0].min).toBe(0);
      expect(props.yAxis[0].max).toBe(100);
      // Percent value formatter on the series.
      expect(props.series[0].valueFormatter!(25, { dataIndex: 0 })).toBe('25.0%');
    });

    it('uses independent left/right axes when grouped + unstacked + >1 series', () => {
      renderChart(baseProps({ chartType: 'bar', chartData: null, multiYData }));
      const props = lastBarProps();
      expect(props.yAxis).toHaveLength(2);
      expect(props.yAxis[0].position).toBe('left');
      expect(props.yAxis[1].position).toBe('right');
      expect(props.series.map((s) => s.yAxisKey)).toEqual(['y-0', 'y-1']);
    });

    it('renders a horizontal layout with a band y-axis and a value x-axis', () => {
      renderChart(
        baseProps({ chartType: 'bar', barLayout: 'horizontal', chartData: null, multiYData }),
      );
      const props = lastBarProps();
      expect(props.layout).toBe('horizontal');
      expect(props.yAxis[0].scaleType).toBe('band');
      expect(props.yAxis[0].data).toEqual(['A', 'B']);
    });

    it('always passes highlightedItem=null and registers no onHighlightChange (invariant 5)', () => {
      renderChart(
        baseProps({
          chartType: 'bar',
          chartData: null,
          multiYData,
          hoveredItem: { seriesId: 'revenue-0', dataIndex: 1 },
          getSelectedDataIndices: () => [1],
        }),
      );
      const props = lastBarProps();
      expect(props.highlightedItem).toBeNull();
      expect(props.onHighlightChange).toBeUndefined();
    });

    it('ghosts via the CrossFilterGhostBar slot gated ONLY on shouldShowGhost, even when preserveXFieldBaseline is false (invariant 1)', () => {
      const allMultiYData = {
        labels: ['A', 'B', 'C'],
        series: [
          { fieldId: 'revenue', values: [10, 30, 50] },
          { fieldId: 'cost', values: [30, 10, 20] },
        ],
      };
      renderChart(
        baseProps({
          chartType: 'bar',
          chartData: null,
          multiYData,
          allMultiYData,
          shouldShowGhost: true,
          preserveXFieldBaseline: false,
        }),
      );
      const props = lastBarProps();
      expect(props.slots?.bar).toBe(CrossFilterGhostBar);
    });
  });

  // ── SeriesField (split-by) ───────────────────────────────────────────────────
  describe('seriesField', () => {
    it('renders one stacked series per category coloured by getSeriesColor', () => {
      const seriesFieldData = {
        labels: ['Q1', 'Q2'],
        seriesNames: ['North', 'South'],
        seriesData: { North: [1, 2], South: [3, 4] },
      };
      const colorByName: Record<string, string> = { North: '#aaaaaa', South: '#bbbbbb' };
      renderChart(
        baseProps({
          chartType: 'bar-stacked',
          chartData: null,
          seriesFieldData,
          getSeriesColor: (name) => colorByName[String(name)],
        }),
      );
      const props = lastBarProps();
      expect(props.series.map((s) => s.id)).toEqual(['North', 'South']);
      expect(props.series.every((s) => s.stack === 'stack')).toBe(true);
      expect(props.series[0].color).toBe('#aaaaaa');
      expect(props.series[1].color).toBe('#bbbbbb');
    });

    it('normalizes bar-100 split-by data to percentages on a 0–100 axis', () => {
      const seriesFieldData = {
        labels: ['Q1'],
        seriesNames: ['North', 'South'],
        seriesData: { North: [30], South: [10] },
      };
      renderChart(baseProps({ chartType: 'bar-100', chartData: null, seriesFieldData }));
      const props = lastBarProps();
      expect(props.series[0].data).toEqual([75]);
      expect(props.series[1].data).toEqual([25]);
      expect(props.yAxis[0].min).toBe(0);
      expect(props.yAxis[0].max).toBe(100);
    });

    it('ghosts the split-by only when preserveSplitByBaseline is true', () => {
      const seriesFieldData = {
        labels: ['Q1', 'Q2'],
        seriesNames: ['North'],
        seriesData: { North: [1, 2] },
      };
      const allSeriesFieldData = {
        labels: ['Q1', 'Q2', 'Q3'],
        seriesNames: ['North'],
        seriesData: { North: [1, 2, 5] },
      };
      renderChart(
        baseProps({
          chartType: 'bar',
          chartData: null,
          seriesFieldData,
          allSeriesFieldData,
          shouldShowGhost: true,
          preserveSplitByBaseline: true,
        }),
      );
      expect(lastBarProps().slots?.bar).toBe(CrossFilterGhostBar);

      barChartSpy.mockClear();
      renderChart(
        baseProps({
          chartType: 'bar',
          chartData: null,
          seriesFieldData,
          allSeriesFieldData,
          shouldShowGhost: true,
          preserveSplitByBaseline: false,
        }),
      );
      expect(lastBarProps().slots?.bar).toBeUndefined();
    });

    it('suppresses the hover highlight under active / incoming cross-filters', () => {
      const seriesFieldData = {
        labels: ['Q1', 'Q2'],
        seriesNames: ['North', 'South'],
        seriesData: { North: [1, 2], South: [3, 4] },
      };
      renderChart(
        baseProps({
          chartType: 'bar',
          chartData: null,
          seriesFieldData,
          hoveredItem: { seriesId: 'North', dataIndex: 1 },
        }),
      );
      expect(lastBarProps().highlightedItem).toEqual({ seriesId: 'North', dataIndex: 1 });

      barChartSpy.mockClear();
      renderChart(
        baseProps({
          chartType: 'bar',
          chartData: null,
          seriesFieldData,
          hoveredItem: { seriesId: 'North', dataIndex: 1 },
          hasIncomingCrossFilters: true,
        }),
      );
      expect(lastBarProps().highlightedItem).toBeNull();
    });
  });

  // ── Single-series ────────────────────────────────────────────────────────────
  describe('single-series', () => {
    it('always sets AxisFieldTooltip as the tooltip slot (vertical and horizontal)', () => {
      renderChart(baseProps());
      expect(lastBarProps().slots?.tooltip).toBe(AxisFieldTooltip);

      barChartSpy.mockClear();
      renderChart(baseProps({ barLayout: 'horizontal' }));
      expect(lastBarProps().slots?.tooltip).toBe(AxisFieldTooltip);
    });

    it('ghosts via CrossFilterGhostBar, suppressed when preserveXFieldBaseline is false', () => {
      const withGhost = baseProps({
        chartData: { labels: ['A', 'B'], values: [4, 6] },
        allChartData: { labels: ['A', 'B', 'C'], values: [10, 20, 30] },
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
      });
      renderChart(withGhost);
      expect(lastBarProps().slots?.bar).toBe(CrossFilterGhostBar);

      barChartSpy.mockClear();
      renderChart(baseProps({ ...withGhost, preserveXFieldBaseline: false }));
      expect(lastBarProps().slots?.bar).toBeUndefined();
    });

    it('groups all but the top N−1 categories into an "Other" bar', () => {
      renderChart(
        baseProps({
          chartData: { labels: ['A', 'B', 'C', 'D', 'E'], values: [5, 4, 3, 2, 1] },
          barMaxCategories: 3,
        }),
      );
      const props = lastBarProps();
      expect(props.xAxis[0].data).toEqual(['A', 'B', 'Other']);
      expect(props.series[0].data).toEqual([5, 4, 6]);
    });

    it('keeps the top N−1 categories by VALUE (not by axis position) when grouping', () => {
      // Unsorted input: the two largest categories are B (5) and D (4); everything else
      // (A=1, C=2, E=3) folds into "Other" = 6. Grouping must sort by value, not slice the
      // first N axis positions.
      renderChart(
        baseProps({
          chartData: { labels: ['A', 'B', 'C', 'D', 'E'], values: [1, 5, 2, 4, 3] },
          barMaxCategories: 3,
        }),
      );
      const props = lastBarProps();
      expect(props.xAxis[0].data).toEqual(['B', 'D', 'Other']);
      expect(props.series[0].data).toEqual([5, 4, 6]);
    });

    it('merges the remainder into an existing "Other" category when one is already in the top N', () => {
      renderChart(
        baseProps({
          chartData: { labels: ['A', 'Other', 'C', 'D'], values: [5, 4, 3, 2] },
          barMaxCategories: 3,
        }),
      );
      const props = lastBarProps();
      expect(props.xAxis[0].data).toEqual(['A', 'Other']);
      expect(props.series[0].data).toEqual([5, 9]);
    });

    it('highlights the selected bar for a lone selection', () => {
      renderChart(baseProps({ getSelectedDataIndices: () => [1] }));
      const props = lastBarProps();
      expect(props.highlightedItem).toEqual({ seriesId: 'cross-filter-series', dataIndex: 1 });
      expect(props.slots?.bar).toBeUndefined();
    });

    it('computes the selection against the display order (empty labels dropped)', () => {
      // The leading empty label is dropped from the rendered order, so getSelectedDataIndices
      // must be called with the display labels ['A','B'] — a selection of 'B' then lands on the
      // correct rendered bar (dataIndex 1), not the pre-transform index 2.
      const seen: Array<Array<string | number | Date>> = [];
      renderChart(
        baseProps({
          chartData: { labels: ['', 'A', 'B'], values: [5, 10, 20] },
          getSelectedDataIndices: (labels) => {
            seen.push(labels);
            return labels.map((l, i) => (String(l) === 'B' ? i : -1)).filter((i) => i >= 0);
          },
        }),
      );
      expect(seen.at(-1)).toEqual(['A', 'B']);
      expect(lastBarProps().highlightedItem).toEqual({
        seriesId: 'cross-filter-series',
        dataIndex: 1,
      });
    });

    it('aligns the ghost cross-filter context to the display order incl. the "Other" bucket', () => {
      renderChart(
        baseProps({
          // Unsorted baseline of >N labels; grouping keeps C(20) & D(15), folds A+B into "Other".
          allChartData: { labels: ['A', 'B', 'C', 'D'], values: [10, 5, 20, 15] },
          // Filtered subset (C reduced to 12, A reduced to 6, B & D filtered out entirely).
          chartData: { labels: ['C', 'A'], values: [12, 6] },
          shouldShowGhost: true,
          preserveXFieldBaseline: true,
          barMaxCategories: 3,
        }),
      );
      const props = lastBarProps();
      // Rendered display order: ['C','D','Other'] with baseline values [20,15,15].
      expect(props.xAxis[0].data).toEqual(['C', 'D', 'Other']);
      expect(props.series[0].data).toEqual([20, 15, 15]);

      // (a) filtered ghost values align to the display order; the "Other" bucket sums the
      //     filtered values of every folded-away label (A=6, B absent→0) = 6.
      const filtered = capturedBarCtx!.filteredValuesBySeriesId['cross-filter-series'];
      expect(filtered).toHaveLength(3);
      expect(filtered[2]).toBe(6);
      // C kept (filtered 12); D kept but absent from the filtered set → null ("filtered out").
      expect(filtered[0]).toBe(12);
      expect(filtered[1]).toBe(null);

      // (b) allValues equal the rendered series data.
      expect(capturedBarCtx!.allValuesBySeriesId['cross-filter-series']).toEqual([20, 15, 15]);

      // (c) the series valueFormatter indexes by the rendered dataIndex → "filtered / total".
      expect(props.series[0].valueFormatter!(20, { dataIndex: 0 })).toBe('12 / 20');
    });

    it('feeds the SourceSelectionContext the display-order multi-select indices', () => {
      renderChart(
        baseProps({
          chartData: { labels: ['', 'A', 'B', 'C'], values: [1, 10, 20, 30] },
          // Two kept-label indices in the display order ['A','B','C'].
          getSelectedDataIndices: () => [0, 2],
        }),
      );
      const props = lastBarProps();
      expect(props.slots?.bar).toBe(SourceSelectionBar);
      expect([...capturedSourceSelection!].sort((a, b) => a - b)).toEqual([0, 2]);
    });

    it('ignores a click on the synthetic "Other" bucket but forwards a kept category', () => {
      const onItemClick = vi.fn();
      renderChart(
        baseProps({
          chartData: { labels: ['A', 'B', 'C', 'D', 'E'], values: [5, 4, 3, 2, 1] },
          barMaxCategories: 3,
          onItemClick,
        }),
      );
      // Display order is ['A','B','Other']; the synthetic bucket must not cross-filter.
      lastBarProps().onAxisClick!({ shiftKey: false }, { axisValue: 'Other' });
      expect(onItemClick).not.toHaveBeenCalled();
      lastBarProps().onAxisClick!({ shiftKey: false }, { axisValue: 'B' });
      expect(onItemClick).toHaveBeenCalledWith('B', false);
    });

    it('forwards a click on a REAL "Other" category when no grouping is active', () => {
      const onItemClick = vi.fn();
      renderChart(
        baseProps({
          chartData: { labels: ['A', 'Other', 'C'], values: [5, 4, 3] },
          onItemClick,
        }),
      );
      lastBarProps().onAxisClick!({ shiftKey: false }, { axisValue: 'Other' });
      expect(onItemClick).toHaveBeenCalledWith('Other', false);
    });

    it('uses the SourceSelectionBar slot and no item highlight for a multi-selection', () => {
      renderChart(baseProps({ getSelectedDataIndices: () => [0, 2] }));
      const props = lastBarProps();
      expect(props.slots?.bar).toBe(SourceSelectionBar);
      expect(props.highlightedItem).toBeNull();
    });

    it('falls back to the hover highlight when there is no selection', () => {
      renderChart(
        baseProps({
          getSelectedDataIndices: () => [],
          hoveredItem: { seriesId: 'cross-filter-series', dataIndex: 2 },
        }),
      );
      expect(lastBarProps().highlightedItem).toEqual({
        seriesId: 'cross-filter-series',
        dataIndex: 2,
      });
    });

    it('computes the band-axis width from label content in horizontal layout', () => {
      renderChart(baseProps({ barLayout: 'horizontal' }));
      const props = lastBarProps();
      expect(props.layout).toBe('horizontal');
      // Horizontal single-series uses a numeric band-axis width (not the 'auto' string).
      expect(typeof props.yAxis[0].width).toBe('number');
      expect(props.yAxis[0].scaleType).toBe('band');
    });

    it('never applies axisTickFontSize in the vertical single-series layout (invariant 2)', () => {
      renderChart(baseProps({ barLayout: 'grouped', axisTickFontSize: 14 }));
      const props = lastBarProps();
      expect(props.xAxis[0].tickLabelStyle).toBeUndefined();
      expect(props.yAxis[0].tickLabelStyle).toBeUndefined();
    });

    it('applies axisTickFontSize in the horizontal single-series layout', () => {
      renderChart(baseProps({ barLayout: 'horizontal', axisTickFontSize: 14 }));
      const props = lastBarProps();
      expect(props.xAxis[0].tickLabelStyle).toEqual({ fontSize: '14px' });
      expect(props.yAxis[0].tickLabelStyle).toEqual({ fontSize: '14px' });
    });
  });

  // ── Shared behaviour across shapes ───────────────────────────────────────────
  describe('shared', () => {
    it('densifies temporal gaps with null values (single-series)', () => {
      renderChart(baseProps({ chartData: { labels: ['2024-01', '2024-03'], values: [10, 30] } }));
      const props = lastBarProps();
      expect(props.xAxis[0].data).toEqual(['2024-01', '2024-02', '2024-03']);
      expect(props.series[0].data).toEqual([10, null, 30]);
    });

    it('densifies temporal gaps with null values (seriesField)', () => {
      renderChart(
        baseProps({
          chartType: 'bar',
          chartData: null,
          seriesFieldData: {
            labels: ['2024-01', '2024-03'],
            seriesNames: ['North'],
            seriesData: { North: [10, 30] },
          },
        }),
      );
      const props = lastBarProps();
      expect(props.xAxis[0].data).toEqual(['2024-01', '2024-02', '2024-03']);
      expect(props.series[0].data).toEqual([10, null, 30]);
    });

    it('wraps long band labels via the band-axis value formatter', () => {
      renderChart(
        baseProps({
          chartData: { labels: ['Hello World Foo'], values: [1] },
          barBandLabelWrap: 5,
        }),
      );
      const formatter = lastBarProps().xAxis[0].valueFormatter!;
      expect(formatter('Hello World Foo')).toContain('\n');
    });

    it('routes onAxisClick through onItemClick', () => {
      const onItemClick = vi.fn();
      renderChart(baseProps({ onItemClick }));
      lastBarProps().onAxisClick!({ shiftKey: true }, { axisValue: 'B' });
      expect(onItemClick).toHaveBeenCalledWith('B', true);
    });
  });
});
