import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AggregatedData } from '../../../internals/chartAggregation';
import {
  StudioUIConfigContext,
  DEFAULT_STUDIO_LOCALE_TEXT,
} from '../../../internals/StudioUIConfigContext';
import { PieHighlightContext } from './PieCrossHighlightContext';

const pieSpy = vi.fn();
// Read the (live) PieHighlightContext from inside the mocked PieChart so tests can assert
// on the per-arc ratio map the wrapping Provider feeds down.
let capturedCtx: { ratioByIndex: Map<number, number>; isActive: boolean } | null = null;
// Counts mount/unmount of the mocked PieChart so a test can prove arcs are not remounted.
let pieMountCount = 0;

vi.mock('@mui/x-charts/PieChart', () => ({
  PieChart: (props: unknown) => {
    pieSpy(props);
    capturedCtx = React.useContext(PieHighlightContext);
    React.useEffect(() => {
      pieMountCount += 1;
    }, []);
    return <div data-testid="pie-chart" />;
  },
}));

// eslint-disable-next-line import/first
import { StudioPieChart, type StudioPieChartProps } from './StudioPieChart';

const theme = createTheme();

type PieCallProps = {
  series: Array<{
    id?: string;
    innerRadius?: number;
    outerRadius?: number;
    data: Array<{ id: number; label: unknown; value: number; color?: string }>;
  }>;
  highlightedItem?: { seriesId: string; dataIndex: number } | null;
  colors?: string[];
  slots?: Record<string, unknown>;
  onItemClick?: (event: { shiftKey?: boolean } | null, params: { dataIndex: number }) => void;
};

function lastPieProps(): PieCallProps {
  return pieSpy.mock.calls.at(-1)?.[0] as PieCallProps;
}

const noop = () => {};
const identity = (label: string | number) => String(label);

function baseProps(overrides: Partial<StudioPieChartProps> = {}): StudioPieChartProps {
  return {
    chartType: 'pie',
    height: 300,
    chartData: { labels: ['A', 'B'], values: [10, 20] },
    allChartData: null,
    enrichedRows: [],
    allEnrichedRows: [],
    activeYFields: ['total'],
    pieLegendBelow: false,
    chartColors: undefined,
    resolvedChartColors: ['#111', '#222', '#333', '#444'],
    shouldShowGhost: false,
    preserveXFieldBaseline: true,
    skipAnimation: false,
    valueFormatter: (v) => String(v ?? 0),
    formatLabel: identity,
    getSelectedDataIndices: () => [],
    hoveredItem: null,
    hasActiveXFilter: false,
    hasIncomingCrossFilters: false,
    onHoverChange: noop,
    onItemClick: noop,
    ...overrides,
  };
}

describe('StudioPieChart', () => {
  const { render } = createRenderer();

  const renderPie = (props: StudioPieChartProps) =>
    render(
      <ThemeProvider theme={theme}>
        <StudioPieChart {...props} />
      </ThemeProvider>,
    );

  beforeEach(() => {
    pieSpy.mockClear();
    capturedCtx = null;
    pieMountCount = 0;
  });

  it('renders a single-series pie with one arc per label', () => {
    renderPie(baseProps());
    const props = lastPieProps();
    expect(props.series).toHaveLength(1);
    expect(props.series[0].id).toBe('cross-filter-series');
    expect(props.series[0].data.map((d) => d.value)).toEqual([10, 20]);
    expect(props.series[0].data.map((d) => d.label)).toEqual(['A', 'B']);
    // pie (not donut) has no inner hole
    expect(props.series[0].innerRadius).toBe(0);
  });

  it('adds a centre hole for donut', () => {
    renderPie(baseProps({ chartType: 'donut' }));
    const props = lastPieProps();
    expect(props.series[0].innerRadius).toBeGreaterThan(0);
  });

  it('renders concentric rings when a series field groups the data', () => {
    const enrichedRows = [
      { region: 'North', segment: 'SMB', total: 5 },
      { region: 'North', segment: 'Enterprise', total: 7 },
      { region: 'South', segment: 'SMB', total: 3 },
    ];
    renderPie(
      baseProps({
        seriesField: 'segment',
        xField: 'region',
        yField: 'total',
        enrichedRows,
        allEnrichedRows: enrichedRows,
        // chartData is ignored for the grouped-ring path but must be provided.
        chartData: { labels: ['North', 'South'], values: [12, 3] },
      }),
    );
    const props = lastPieProps();
    // One ring per region category.
    expect(props.series).toHaveLength(2);
    // Concentric: outer ring radius > inner ring radius.
    expect(props.series[0].outerRadius!).toBeGreaterThan(props.series[1].outerRadius!);
    // North ring slices: SMB=5, Enterprise=7.
    const north = props.series[0];
    expect(north.data.map((d) => d.value).sort()).toEqual([5, 7]);
  });

  it('groups the tail into an "Other" bucket when pieMaxSlices is set', () => {
    const chartData: AggregatedData = {
      labels: ['a', 'b', 'c', 'd', 'e'],
      values: [100, 80, 60, 40, 20],
    };
    renderPie(baseProps({ chartData, pieMaxSlices: 3 }));
    const props = lastPieProps();
    const labels = props.series[0].data.map((d) => d.label);
    // topN = pieMaxSlices - 1 = 2 kept, remainder collapsed into "Other".
    expect(labels).toEqual(['a', 'b', 'Other']);
    const otherSlice = props.series[0].data.find((d) => d.label === 'Other');
    expect(otherSlice?.value).toBe(60 + 40 + 20);
  });

  it('ignores a click on the synthetic "Other" bucket but forwards a kept slice', () => {
    const onItemClick = vi.fn();
    const chartData: AggregatedData = {
      labels: ['a', 'b', 'c', 'd', 'e'],
      values: [100, 80, 60, 40, 20],
    };
    renderPie(baseProps({ chartData, pieMaxSlices: 3, onItemClick }));
    const props = lastPieProps();
    const labels = props.series[0].data.map((d) => d.label);
    const otherIndex = labels.indexOf('Other');
    // The synthetic "Other" bucket must not cross-filter.
    props.onItemClick!({ shiftKey: false }, { dataIndex: otherIndex });
    expect(onItemClick).not.toHaveBeenCalled();
    // A kept slice forwards its label.
    const keptIndex = labels.indexOf('a');
    props.onItemClick!({ shiftKey: false }, { dataIndex: keptIndex });
    expect(onItemClick).toHaveBeenCalledWith('a', false);
  });

  it('forwards a click on a REAL "Other" slice when no grouping is active', () => {
    const onItemClick = vi.fn();
    const chartData: AggregatedData = { labels: ['a', 'Other'], values: [10, 20] };
    renderPie(baseProps({ chartData, onItemClick }));
    const props = lastPieProps();
    const otherIndex = props.series[0].data.map((d) => d.label).indexOf('Other');
    props.onItemClick!({ shiftKey: false }, { dataIndex: otherIndex });
    expect(onItemClick).toHaveBeenCalledWith('Other', false);
  });

  it('merges into an existing category literally named "Other" instead of duplicating it', () => {
    const chartData: AggregatedData = {
      labels: ['a', 'b', 'c', 'Other'],
      values: [100, 80, 5, 5],
    };
    renderPie(baseProps({ chartData, pieMaxSlices: 3 }));
    const props = lastPieProps();
    const labels = props.series[0].data.map((d) => d.label);
    // Exactly one "Other" entry (no duplicate).
    expect(labels.filter((l) => l === 'Other')).toHaveLength(1);
    const otherSlice = props.series[0].data.find((d) => d.label === 'Other');
    // c (5) folds into the existing Other (5) → 10.
    expect(otherSlice?.value).toBe(10);
  });

  it('localizes the "Other" bucket label via localeText.chartOtherBucketLabel (finding 3.2)', () => {
    const chartData: AggregatedData = {
      labels: ['a', 'b', 'c', 'd', 'e'],
      values: [100, 80, 60, 40, 20],
    };
    render(
      <ThemeProvider theme={theme}>
        <StudioUIConfigContext.Provider
          value={{
            tableSourceMode: 'explicit',
            featureFlags: {},
            localeText: { ...DEFAULT_STUDIO_LOCALE_TEXT, chartOtherBucketLabel: 'Autre' },
          }}
        >
          <StudioPieChart {...baseProps({ chartData, pieMaxSlices: 3 })} />
        </StudioUIConfigContext.Provider>
      </ThemeProvider>,
    );
    const props = lastPieProps();
    const labels = props.series[0].data.map((d) => d.label);
    expect(labels).toEqual(['a', 'b', 'Autre']);
    expect(labels).not.toContain('Other');
  });

  it('computes selectedDataIndices against the rendered displayLabels order (ghost reorder active)', () => {
    // Filtered data is a subset in a different order; the ghost baseline (allChartData) drives
    // the rendered arc order, so getSelectedDataIndices must be called with THAT order.
    const chartData: AggregatedData = { labels: ['B'], values: [20] };
    const allChartData: AggregatedData = { labels: ['A', 'B', 'C'], values: [10, 20, 30] };
    const seen: Array<Array<string | number | Date>> = [];
    renderPie(
      baseProps({
        chartData,
        allChartData,
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
        getSelectedDataIndices: (labels) => {
          seen.push(labels);
          // Highlight 'B' — index 1 in the ghost/baseline order.
          return labels.map((l, i) => (String(l) === 'B' ? i : -1)).filter((i) => i >= 0);
        },
      }),
    );
    // Called with the baseline (allChartData) label order, not the filtered chartData order.
    expect(seen.at(-1)).toEqual(['A', 'B', 'C']);
    const props = lastPieProps();
    expect(props.highlightedItem).toEqual({ seriesId: 'cross-filter-series', dataIndex: 1 });
  });

  it('always wraps PieChart in a live PieHighlightContext (does not remount arcs when ghost flips)', () => {
    const chartData: AggregatedData = { labels: ['A', 'B', 'C'], values: [10, 20, 30] };
    const allChartData: AggregatedData = { labels: ['A', 'B', 'C'], values: [10, 20, 30] };

    function Wrapper(props: { ghost: boolean }) {
      return (
        <ThemeProvider theme={theme}>
          <StudioPieChart
            {...baseProps({ chartData, allChartData, shouldShowGhost: props.ghost })}
          />
        </ThemeProvider>
      );
    }

    // Inactive (no ghost): context present and inactive.
    const { setProps } = render(<Wrapper ghost={false} />);
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.isActive).toBe(false);
    const mountsAfterFirstRender = pieMountCount;

    // Flip ghost on: same tree position, so PieChart re-renders (not remounts) with an active
    // ctx — the mount count must stay flat (arcs are never torn down on a filter change).
    setProps({ ghost: true });
    expect(pieMountCount).toBe(mountsAfterFirstRender);
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.isActive).toBe(true);
  });

  it('renders the custom below-chart legend with percentages when pieLegendBelow is set', () => {
    const { container } = renderPie(
      baseProps({ chartData: { labels: ['A', 'B'], values: [25, 75] }, pieLegendBelow: true }),
    );
    // Custom legend rows render the label text + percentage of the total.
    expect(container.textContent).toContain('25.0%');
    expect(container.textContent).toContain('75.0%');
    expect(container.textContent).toContain('A');
    expect(container.textContent).toContain('B');
    // The built-in legend is suppressed via slots in this mode.
    const props = lastPieProps();
    expect(props.slots?.legend).toBeDefined();
  });
});
