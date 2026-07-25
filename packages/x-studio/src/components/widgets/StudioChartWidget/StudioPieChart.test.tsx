import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
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

// The item x-charts' keyboard navigation currently focuses. Mocked because the real hook reads
// the chart's own store, which the mocked `PieChart` below does not provide — `ChartFocusTracker`
// (rendered as a child of the chart) mirrors whatever this returns into the widget's focus ref.
let focusedItem: unknown = null;
vi.mock('@mui/x-charts/hooks', () => ({
  useFocusedItem: () => focusedItem,
}));

vi.mock('@mui/x-charts/PieChart', () => ({
  PieChart: (props: { children?: React.ReactNode }) => {
    pieSpy(props);
    capturedCtx = React.useContext(PieHighlightContext);
    React.useEffect(() => {
      pieMountCount += 1;
    }, []);
    // Children are rendered so `ChartFocusTracker` runs, exactly as it does inside a real chart.
    // Focusable like x-charts' own keyboard-navigation proxy, so a keydown can be targeted at it
    // and bubble to the widget's wrapper.
    return (
      <div data-testid="pie-chart" tabIndex={-1}>
        {props.children}
      </div>
    );
  },
}));

// eslint-disable-next-line import/first
import { StudioPieChart, type StudioPieChartProps } from './StudioPieChart';

const theme = createTheme();

type PieCallProps = {
  series: Array<{
    id?: string;
    label?: unknown;
    innerRadius?: number;
    outerRadius?: number;
    valueFormatter?: (item: { value: number }) => string;
    arcLabel?: 'value' | ((item: { value: number }) => string);
    data: Array<{ id: number; label: unknown; value: number; color?: string }>;
  }>;
  highlightedItem?: { seriesId: string; dataIndex: number } | null;
  colors?: string[];
  slots?: Record<string, unknown>;
  onItemClick?: (
    event: { shiftKey?: boolean } | null,
    params: { seriesId?: string | number; dataIndex: number },
  ) => void;
  desc?: string;
  disableKeyboardNavigation?: boolean;
};

function lastPieProps(): PieCallProps {
  return pieSpy.mock.calls.at(-1)?.[0] as PieCallProps;
}

// Collect the legend-visible label strings across every ring series. A slice contributes a
// legend entry only when its `label` is a plain string (function labels render '' for the
// legend location), so this is exactly the set of categories the legend describes.
function legendLabels(props: PieCallProps): string[] {
  const out: string[] = [];
  for (const s of props.series) {
    for (const d of s.data) {
      if (typeof d.label === 'string') {
        out.push(d.label);
      }
    }
  }
  return out;
}

// Find the single slice within one ring whose value matches — used to identify a category's
// slice when its legend label may be a function in inner rings.
function sliceByValue(props: PieCallProps, seriesIndex: number, value: number) {
  return props.series[seriesIndex].data.find((d) => d.value === value);
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
    focusedItem = null;
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

  // Regression for Tier 2 finding 2: a cross-filter that empties EVERY row for this widget makes
  // `chartData` null/empty, so `pieFilteredValueByLabel` is legitimately an empty Map. The old
  // `pieFilteredValueByLabel.size > 0` gate then skipped building `filteredDisplayValues`
  // entirely, and `pieDisplayCtxValue`'s ratio computation fell back to `filteredValue = allValue`
  // for every slice — rendering the ghost at FULL (undimmed) opacity instead of the
  // fully-"filtered out" treatment (ratio 0) every slice should get here.
  it('dims every slice to ratio 0 (fully filtered out) when a cross-filter empties every row', () => {
    const chartData: AggregatedData = { labels: [], values: [] };
    const allChartData: AggregatedData = { labels: ['A', 'B', 'C'], values: [10, 20, 30] };
    renderPie(
      baseProps({
        chartData,
        allChartData,
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
      }),
    );
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.isActive).toBe(true);
    // Every rendered arc (one per baseline label) must be fully dimmed, not left at ratio 1
    // (undimmed) via the stale `: allValue` fallback.
    expect(capturedCtx!.ratioByIndex.get(0)).toBe(0);
    expect(capturedCtx!.ratioByIndex.get(1)).toBe(0);
    expect(capturedCtx!.ratioByIndex.get(2)).toBe(0);
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

  // ── Grouped rings honor hard filters (finding 1.1) ─────────────────────────
  describe('grouped rings honor hard filters (finding 1.1)', () => {
    it('aggregates rings from the FILTERED rows for an interactive filter-widget selection', () => {
      // A filter widget selected "North" → every widget hard-filters to North. `enrichedRows`
      // already reflects that; `allEnrichedRows` is the unfiltered baseline; `shouldShowGhost`
      // is false (interactive selections never ghost). The rings must follow `enrichedRows`.
      const filtered = [
        { region: 'North', segment: 'SMB', total: 5 },
        { region: 'North', segment: 'Enterprise', total: 7 },
      ];
      const baseline = [
        ...filtered,
        { region: 'South', segment: 'SMB', total: 3 },
        { region: 'South', segment: 'Enterprise', total: 4 },
      ];
      renderPie(
        baseProps({
          seriesField: 'segment',
          xField: 'region',
          yField: 'total',
          enrichedRows: filtered,
          allEnrichedRows: baseline,
          shouldShowGhost: false,
          chartData: { labels: ['North'], values: [12] },
        }),
      );
      const props = lastPieProps();
      // Only the North ring renders — the South baseline rows are filtered out, not dimmed.
      expect(props.series).toHaveLength(1);
      // And nothing is dimmed (every slice keeps its full-opacity base colour).
      expect(props.series[0].data.every((d) => !String(d.color).endsWith('40'))).toBe(true);
      expect(props.series[0].data.map((d) => d.value).sort()).toEqual([5, 7]);
    });

    it("removes filtered-out slices for a 'filter'-mode cross-filter (no ghost, no dimming)", () => {
      // crossFilterMode: 'filter' → the incoming cross-filter hard-filters this widget, so
      // `shouldShowGhost` is false and `enrichedRows` already excludes the Enterprise segment.
      const filtered = [
        { region: 'North', segment: 'SMB', total: 5 },
        { region: 'South', segment: 'SMB', total: 3 },
      ];
      const baseline = [
        ...filtered,
        { region: 'North', segment: 'Enterprise', total: 7 },
        { region: 'South', segment: 'Enterprise', total: 4 },
      ];
      renderPie(
        baseProps({
          seriesField: 'segment',
          xField: 'region',
          yField: 'total',
          enrichedRows: filtered,
          allEnrichedRows: baseline,
          shouldShowGhost: false,
          chartData: { labels: ['North', 'South'], values: [5, 3] },
        }),
      );
      const props = lastPieProps();
      // Both region rings render, but each keeps only the SMB slice (Enterprise is filtered out).
      expect(props.series).toHaveLength(2);
      for (const ring of props.series) {
        expect(ring.data).toHaveLength(1);
        expect(String(ring.data[0].color).endsWith('40')).toBe(false);
      }
      expect(props.series[0].data[0].value).toBe(5);
      expect(props.series[1].data[0].value).toBe(3);
    });

    it('still renders the unfiltered baseline with dimming when a chart-click ghost IS active', () => {
      // shouldShowGhost true → keep the baseline rings and DIM the filtered-out slices.
      const baseline = [
        { region: 'North', segment: 'SMB', total: 5 },
        { region: 'North', segment: 'Enterprise', total: 7 },
      ];
      const filtered = [{ region: 'North', segment: 'SMB', total: 5 }];
      renderPie(
        baseProps({
          seriesField: 'segment',
          xField: 'region',
          yField: 'total',
          enrichedRows: filtered,
          allEnrichedRows: baseline,
          shouldShowGhost: true,
          resolvedChartColors: ['#111', '#222', '#333', '#444'],
          chartData: { labels: ['North'], values: [5] },
        }),
      );
      const props = lastPieProps();
      // Both baseline slices still render (dim, not removed).
      expect(props.series[0].data).toHaveLength(2);
      // Labels sort alphabetically → categoryOrder (union) = [Enterprise, SMB]:
      // Enterprise=#111 (filtered out → dimmed), SMB=#222 (kept → full opacity).
      const smb = sliceByValue(props, 0, 5);
      const enterprise = sliceByValue(props, 0, 7);
      expect(smb!.color).toBe('#222');
      // The dimmed slice keeps its REAL, un-suffixed colour (finding 3.7) — dimming is
      // applied via `fill-opacity` by `RingDimmedPieArc` (the `pieArc` slot, reading a
      // per-slice dim map through `PieRingDimContext`), not by string-concatenating an
      // alpha byte onto `color` here. See `RingDimmedPieArc.test.tsx` for direct coverage
      // of the fill-opacity behaviour.
      expect(enterprise!.color).toBe('#111');
      expect(props.slots?.pieArc).toBeDefined();
    });

    // Regression for finding 4: `useGhostBaseline` used to ignore `preserveXFieldBaseline`
    // entirely, unlike the single-ring path's `isPieHighlightActive` (same file, ~line 368),
    // which DOES gate on it. A chart-click ghost with `preserveXFieldBaseline: false` must fall
    // back to the filtered rows (no baseline, no dimming) — mirroring the single-ring behaviour.
    it('falls back to the filtered rows (no baseline, no dimming) when preserveXFieldBaseline is false, even with a ghost active', () => {
      const baseline = [
        { region: 'North', segment: 'SMB', total: 5 },
        { region: 'North', segment: 'Enterprise', total: 7 },
      ];
      const filtered = [{ region: 'North', segment: 'SMB', total: 5 }];
      renderPie(
        baseProps({
          seriesField: 'segment',
          xField: 'region',
          yField: 'total',
          enrichedRows: filtered,
          allEnrichedRows: baseline,
          shouldShowGhost: true,
          preserveXFieldBaseline: false,
          resolvedChartColors: ['#111', '#222', '#333', '#444'],
          chartData: { labels: ['North'], values: [5] },
        }),
      );
      const props = lastPieProps();
      // Only the filtered (SMB) slice renders — the baseline's Enterprise slice must not leak in.
      expect(props.series[0].data).toHaveLength(1);
      expect(props.series[0].data[0].value).toBe(5);
    });

    // Regression for finding 6: a sibling widget's cross-filter can empty THIS widget's
    // `enrichedRows` entirely (0 rows matched) while `allEnrichedRows` still has rows for
    // every ring/category. The ring branch used to gate its entry guard on
    // `enrichedRows.length === 0` alone, which fell through to the single-ring aggregate-total
    // path below and collapsed an N-ring chart into one slice. It must instead keep rendering
    // every baseline ring, fully dimmed.
    it('keeps rendering every baseline ring (fully dimmed) when enrichedRows is empty but a ghost baseline exists', () => {
      const baseline = [
        { region: 'North', segment: 'SMB', total: 5 },
        { region: 'North', segment: 'Enterprise', total: 7 },
        { region: 'South', segment: 'SMB', total: 3 },
      ];
      renderPie(
        baseProps({
          seriesField: 'segment',
          xField: 'region',
          yField: 'total',
          enrichedRows: [],
          allEnrichedRows: baseline,
          shouldShowGhost: true,
          preserveXFieldBaseline: true,
          resolvedChartColors: ['#111', '#222', '#333', '#444'],
          chartData: { labels: [], values: [] },
        }),
      );
      const props = lastPieProps();
      // Both region rings still render from the baseline, not collapsed to a single ring.
      expect(props.series).toHaveLength(2);
      const north = props.series.find((s) => s.data.length === 2);
      expect(north).toBeDefined();
      expect(north!.data.map((d) => d.value).sort()).toEqual([5, 7]);
      // The dim map is populated (every slice dimmed, since nothing matched the filter).
      expect(props.slots?.pieArc).toBeDefined();
    });
  });

  // ── Stable category colours + union legend (finding 1.3) ───────────────────
  describe('grouped rings: stable colours and union legend (finding 1.3)', () => {
    // Sparse data: the split-by category set differs between rings (North has A,B; South has B,C).
    const sparseRows = [
      { region: 'North', segment: 'A', total: 1 },
      { region: 'North', segment: 'B', total: 2 },
      { region: 'South', segment: 'B', total: 3 },
      { region: 'South', segment: 'C', total: 4 },
    ];

    const sparseProps = () =>
      baseProps({
        seriesField: 'segment',
        xField: 'region',
        yField: 'total',
        enrichedRows: sparseRows,
        allEnrichedRows: sparseRows,
        resolvedChartColors: ['#111', '#222', '#333', '#444'],
        chartData: { labels: ['North', 'South'], values: [3, 7] },
      });

    it('assigns the same colour to a split-by category across every ring', () => {
      renderPie(sparseProps());
      const props = lastPieProps();
      // Identify each category's slice by its (unique) value.
      const northB = sliceByValue(props, 0, 2); // North / B
      const southB = sliceByValue(props, 1, 3); // South / B
      const northA = sliceByValue(props, 0, 1); // North / A
      const southC = sliceByValue(props, 1, 4); // South / C
      // Same category B → same colour in both rings (the core 1.3 fix).
      expect(southB!.color).toBe(northB!.color);
      // Different categories → different colours (no positional collision).
      expect(northA!.color).not.toBe(northB!.color);
      expect(southC!.color).not.toBe(southB!.color);
      expect(northA!.color).not.toBe(southC!.color);
    });

    it('builds the legend from the union of categories, each appearing exactly once', () => {
      renderPie(sparseProps());
      const props = lastPieProps();
      const labels = legendLabels(props).sort();
      // Union A,B,C — not just the outermost ring's [A,B]; C (inner-ring only) is included.
      expect(labels).toEqual(['A', 'B', 'C']);
    });

    it('reuses the reconciled pie palette for the rings', () => {
      renderPie(sparseProps());
      const props = lastPieProps();
      // The ring PieChart is fed the reconciled palette, not a bare `chartColors` (undefined).
      expect(props.colors).toEqual(['#111', '#222', '#333', '#444']);
    });
  });

  // ── valueFormatter + pieMaxSlices applied to rings (finding 1.3 secondary) ──
  describe('grouped rings apply valueFormatter and pieMaxSlices (finding 1.3)', () => {
    it('applies the measure valueFormatter to each ring series (tooltips are formatted)', () => {
      const rows = [
        { region: 'North', segment: 'SMB', total: 5 },
        { region: 'North', segment: 'Enterprise', total: 7 },
      ];
      renderPie(
        baseProps({
          seriesField: 'segment',
          xField: 'region',
          yField: 'total',
          enrichedRows: rows,
          allEnrichedRows: rows,
          valueFormatter: (v) => `$${v ?? 0}`,
          chartData: { labels: ['North'], values: [12] },
        }),
      );
      const props = lastPieProps();
      expect(typeof props.series[0].valueFormatter).toBe('function');
      expect(props.series[0].valueFormatter!({ value: 5 })).toBe('$5');
    });

    it('collapses the tail into a global "Other" bucket across rings when pieMaxSlices is set', () => {
      const rows = [
        { region: 'North', segment: 'A', total: 10 },
        { region: 'North', segment: 'B', total: 8 },
        { region: 'North', segment: 'C', total: 6 },
        { region: 'North', segment: 'D', total: 4 },
      ];
      renderPie(
        baseProps({
          seriesField: 'segment',
          xField: 'region',
          yField: 'total',
          enrichedRows: rows,
          allEnrichedRows: rows,
          pieMaxSlices: 3,
          chartData: { labels: ['North'], values: [28] },
        }),
      );
      const props = lastPieProps();
      // Keep top (pieMaxSlices - 1) = 2 categories by total (A=10, B=8); collapse C+D → Other.
      const labels = props.series[0].data.map((d) => d.label);
      expect(labels).toEqual(['A', 'B', 'Other']);
      const other = props.series[0].data.find((d) => d.label === 'Other');
      expect(other?.value).toBe(6 + 4);
    });
  });

  describe('selection highlight with pieMaxSlices', () => {
    // M8: the highlight used to be suppressed whenever `pieMaxSlices` was merely SET
    // (`pieMaxSlices ? [] : getSelectedDataIndices(...)`), but grouping only kicks in at
    // `displayLabels.length >= pieMaxSlices`. Clicking a slice applied the cross-filter while
    // the pie showed no selected arc at all.
    it('highlights the selected arc when pieMaxSlices is set but no grouping is triggered', () => {
      renderPie(
        baseProps({
          chartData: { labels: ['a', 'b', 'c', 'd', 'e'], values: [5, 4, 3, 2, 1] },
          pieMaxSlices: 8,
          getSelectedDataIndices: (labels) =>
            labels.map((l, i) => (String(l) === 'b' ? i : -1)).filter((i) => i >= 0),
        }),
      );
      expect(lastPieProps().highlightedItem).toEqual({
        seriesId: 'cross-filter-series',
        dataIndex: 1,
      });
    });

    // `getSelectedDataIndices` matches by LABEL, so the re-sorted/grouped display order
    // resolves the kept label to its new rendered index rather than losing the highlight.
    it('highlights against the re-sorted display order when grouping IS applied', () => {
      renderPie(
        baseProps({
          // Descending sort puts 'e' (100) first, so the selected 'd' (80) lands at index 1.
          chartData: { labels: ['a', 'b', 'c', 'd', 'e'], values: [10, 20, 30, 80, 100] },
          pieMaxSlices: 3,
          getSelectedDataIndices: (labels) =>
            labels.map((l, i) => (String(l) === 'd' ? i : -1)).filter((i) => i >= 0),
        }),
      );
      const props = lastPieProps();
      expect(props.series[0].data.map((d) => d.label)).toEqual(['e', 'd', 'Other']);
      expect(props.highlightedItem).toEqual({ seriesId: 'cross-filter-series', dataIndex: 1 });
    });

    it('never highlights the synthetic "Other" bucket for a folded-away selection', () => {
      renderPie(
        baseProps({
          chartData: { labels: ['a', 'b', 'c', 'd', 'e'], values: [10, 20, 30, 80, 100] },
          pieMaxSlices: 3,
          // 'a' is folded into the synthetic bucket — it must simply yield no index.
          getSelectedDataIndices: (labels) =>
            labels.map((l, i) => (String(l) === 'a' ? i : -1)).filter((i) => i >= 0),
        }),
      );
      expect(lastPieProps().highlightedItem).toBeNull();
    });
  });

  describe('"Other" fold-in under a cross-highlight', () => {
    // M11: the ghost fold-in lacked the `otherIsSynthetic` guard the bar chart applies at both
    // its keep-set exclusion and its sum (`otherGroupingApplied && …`). A dashboard with a REAL
    // category named "Other" therefore had it absorb the filtered value of every label missing
    // from the baseline — which happens routinely, because a widget rank filter applies to the
    // BASELINE aggregation while the ghost is active but not to the filtered one.
    it('does not let a real "Other" category absorb other categories\' filtered values', () => {
      renderPie(
        baseProps({
          // Filtered set carries a label ('b') the rank-limited baseline does not.
          chartData: { labels: ['A', 'b', 'Other'], values: [4, 30, 5] },
          allChartData: { labels: ['A', 'Other'], values: [10, 20] },
          shouldShowGhost: true,
          preserveXFieldBaseline: true,
        }),
      );
      expect(capturedCtx!.isActive).toBe(true);
      // 'Other' is a real category here: its dim ratio is its OWN 5 / 20, not (30 + 5) / 20,
      // which exceeded 1 and rendered the arc fully undimmed.
      expect(capturedCtx!.ratioByIndex.get(1)).toBe(0.25);
      expect(capturedCtx!.ratioByIndex.get(0)).toBe(0.4);
    });

    it('still folds filtered values into the SYNTHETIC bucket when grouping is applied', () => {
      renderPie(
        baseProps({
          chartData: { labels: ['a', 'b', 'c', 'd'], values: [50, 40, 10, 5] },
          allChartData: { labels: ['a', 'b', 'c', 'd'], values: [100, 80, 20, 10] },
          pieMaxSlices: 3,
          shouldShowGhost: true,
          preserveXFieldBaseline: true,
        }),
      );
      const props = lastPieProps();
      expect(props.series[0].data.map((d) => d.label)).toEqual(['a', 'b', 'Other']);
      // Synthetic bucket baseline = 20 + 10 = 30; filtered = 10 + 5 = 15 → ratio 0.5.
      expect(capturedCtx!.ratioByIndex.get(2)).toBe(0.5);
    });
  });

  describe('accessibility', () => {
    // M10: the pie shipped with no accessible name, and its slices were distinguished by hue
    // alone whenever arc labels were off.
    it('names the chart and describes its slices', () => {
      renderPie(
        baseProps({
          chartData: { labels: ['A', 'B'], values: [10, 20] },
          ariaTitle: 'Revenue by region',
        }),
      );
      const props = lastPieProps() as unknown as { title?: string; desc?: string };
      expect(props.title).toBe('Revenue by region');
      expect(props.desc).toBe('A: 10, B: 20');
    });

    it('opts into x-charts keyboard navigation so Enter/Space can reach the arcs', () => {
      renderPie(baseProps());
      const props = lastPieProps() as unknown as { disableKeyboardNavigation?: boolean };
      expect(props.disableKeyboardNavigation).toBe(false);
    });
  });

  // ── Unmeasured (null) categories ──────────────────────────────────────────
  // `aggregateByField` yields `null` for a category whose every contributing row had no
  // numeric measure (an "Average temperature by city" donut where Oslo's column is all null).
  // A synthetic 0 there is indistinguishable from a genuine zero measurement, so a null
  // category must never become a slice, a share of the total, or a "0.0%" legend row.
  describe('null (unmeasured) categories', () => {
    const nullData: AggregatedData = { labels: ['Oslo', 'Rome'], values: [null, -4] };

    it('renders no slice for an all-null category', () => {
      renderPie(baseProps({ chartData: nullData }));
      const props = lastPieProps();
      expect(props.series[0].data.map((d) => d.label)).toEqual(['Rome']);
      // Specifically: no fabricated zero-value arc.
      expect(props.series[0].data.map((d) => d.value)).not.toContain(0);
    });

    it('shows "—" (not "0.0%") for the unmeasured category in the custom legend', () => {
      const { container } = renderPie(
        baseProps({
          chartData: { labels: ['Oslo', 'Rome', 'Paris'], values: [null, 25, 75] },
          pieLegendBelow: true,
        }),
      );
      // The unmeasured category is still listed — the reader learns it exists and was not
      // measured — but it claims no share of the total, and the shares of the measured
      // categories are computed without it.
      expect(container.textContent).toBe('Oslo—Rome25.0%Paris75.0%');
      expect(container.textContent).not.toContain('0.0%');
    });

    it('describes the unmeasured category the same way the visible legend does', () => {
      renderPie(baseProps({ chartData: nullData, ariaTitle: 'Average temperature by city' }));
      // Previously the description said "Oslo: " (blank) while the legend claimed "0.0%".
      expect(lastPieProps().desc).toBe('Oslo: —, Rome: -4');
    });

    it('maps a click on the first rendered arc to the first MEASURED category', () => {
      const onItemClick = vi.fn();
      renderPie(baseProps({ chartData: nullData, onItemClick }));
      lastPieProps().onItemClick!({ shiftKey: false }, { dataIndex: 0 });
      expect(onItemClick).toHaveBeenCalledWith('Rome', false);
    });

    it('highlights the selected arc by its rendered index, not its display index', () => {
      // 'Rome' is display index 1 but arc index 0 once Oslo contributes no slice.
      renderPie(
        baseProps({
          chartData: nullData,
          getSelectedDataIndices: (labels) => {
            const i = labels.indexOf('Rome');
            return i >= 0 ? [i] : [];
          },
        }),
      );
      expect(lastPieProps().highlightedItem).toEqual({
        seriesId: 'cross-filter-series',
        dataIndex: 0,
      });
    });

    it('keeps an unmeasured category out of the "Other" bucket sum', () => {
      const chartData: AggregatedData = {
        labels: ['a', 'b', 'c', 'd', 'unmeasured'],
        values: [100, 80, 60, 40, null],
      };
      renderPie(baseProps({ chartData, pieMaxSlices: 3, pieLegendBelow: true }));
      const props = lastPieProps();
      // 'unmeasured' contributes no slice at all and nothing to the bucket's value.
      expect(props.series[0].data.map((d) => d.label)).toEqual(['a', 'b', 'Other']);
      expect(props.series[0].data.find((d) => d.label === 'Other')?.value).toBe(60 + 40);
      // …but it keeps its legend row, marked as having no value.
      expect(props.desc).toContain('unmeasured: —');
    });
  });

  // ── Grouped rings: cross-filtering and keyboard access ─────────────────────
  // The ring branch used to render with no `onItemClick`, no keyboard navigation and no focus
  // tracker, so switching a pie widget from "no split-by" to a `seriesField` split silently
  // dropped both click-to-cross-filter and the entire keyboard path.
  describe('grouped rings are interactive', () => {
    const ringRows = [
      { region: 'North', segment: 'SMB', total: 5 },
      { region: 'North', segment: 'Enterprise', total: 7 },
      { region: 'South', segment: 'SMB', total: 3 },
    ];
    const ringProps = (overrides: Partial<StudioPieChartProps> = {}) =>
      baseProps({
        seriesField: 'segment',
        xField: 'region',
        yField: 'total',
        enrichedRows: ringRows,
        allEnrichedRows: ringRows,
        chartData: { labels: ['North', 'South'], values: [12, 3] },
        ...overrides,
      });

    it("emits the RING's x-category (not the slice) when an arc is clicked", () => {
      const onItemClick = vi.fn();
      renderPie(ringProps({ onItemClick }));
      const props = lastPieProps();
      // Second ring = the 'South' category; its id encodes the category.
      const southRingId = props.series[1].id!;
      props.onItemClick!({ shiftKey: false }, { seriesId: southRingId, dataIndex: 0 });
      expect(onItemClick).toHaveBeenCalledWith('South', false);
    });

    it('forwards shift for multi-select, mirroring the single-series pie', () => {
      const onItemClick = vi.fn();
      renderPie(ringProps({ onItemClick }));
      const props = lastPieProps();
      props.onItemClick!({ shiftKey: true }, { seriesId: props.series[0].id!, dataIndex: 1 });
      expect(onItemClick).toHaveBeenCalledWith('North', true);
    });

    it('opts into keyboard navigation and enumerates the rings in its description', () => {
      renderPie(ringProps({ ariaTitle: 'Revenue by region and segment' }));
      const props = lastPieProps();
      expect(props.disableKeyboardNavigation).toBe(false);
      expect(props.desc).toBe('North, South');
    });

    // The keydown originates on the chart's own focus proxy and bubbles to the widget's
    // wrapper, exactly as it does in a real chart.
    const pressKeyOnChart = (_container: HTMLElement, key: string, shiftKey = false) => {
      const chart = screen.getByTestId('pie-chart');
      chart.focus();
      fireEvent.keyDown(chart, { key, shiftKey });
    };

    it('cross-filters the focused ring on Enter, like a pointer click', () => {
      const onItemClick = vi.fn();
      // `ring-<category>` is the id the ring branch assigns to each ring series.
      focusedItem = { type: 'pie', seriesId: 'ring-South', dataIndex: 0 };
      const { container } = renderPie(ringProps({ onItemClick }));
      pressKeyOnChart(container, 'Enter');
      expect(onItemClick).toHaveBeenCalledWith('South', false);
    });

    it('forwards shift on Space for multi-select', () => {
      const onItemClick = vi.fn();
      focusedItem = { type: 'pie', seriesId: 'ring-North', dataIndex: 1 };
      const { container } = renderPie(ringProps({ onItemClick }));
      pressKeyOnChart(container, ' ', true);
      expect(onItemClick).toHaveBeenCalledWith('North', true);
    });

    it('leaves keys it does not handle alone', () => {
      const onItemClick = vi.fn();
      focusedItem = { type: 'pie', seriesId: 'ring-South', dataIndex: 0 };
      const { container } = renderPie(ringProps({ onItemClick }));
      pressKeyOnChart(container, 'ArrowRight');
      expect(onItemClick).not.toHaveBeenCalled();
    });

    it('does nothing when no ring arc is focused', () => {
      const onItemClick = vi.fn();
      focusedItem = null;
      const { container } = renderPie(ringProps({ onItemClick }));
      pressKeyOnChart(container, ' ');
      expect(onItemClick).not.toHaveBeenCalled();
    });
  });
});
