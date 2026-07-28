import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterDataPoint, ScatterSeriesData } from '../../../internals/chartAggregation';

const scatterSpy = vi.fn();

vi.mock('@mui/x-charts/ScatterChart', () => ({
  ScatterChart: (props: unknown) => {
    scatterSpy(props);
    return <div data-testid="scatter-chart" />;
  },
}));

// eslint-disable-next-line import/first
import { StudioScatterChart } from './StudioScatterChart';

const theme = createTheme();

type ScatterCallProps = {
  hideLegend?: boolean;
  series: Array<{
    id?: string;
    label?: string;
    data: ScatterDataPoint[];
    markerSize?: number;
    color?: string;
    valueFormatter?: (value: { x: number; y: number } | null) => string;
  }>;
  xAxis?: Array<{ label?: string; valueFormatter?: (value: number | null) => string }>;
  yAxis?: Array<{ label?: string; valueFormatter?: (value: number | null) => string }>;
  zAxis?: unknown[];
  margin: { right: number };
  slotProps?: {
    tooltip?: unknown;
    legend?: { toggleVisibilityOnClick?: boolean; sx?: Record<string, unknown> };
  };
};

function lastScatterProps(): ScatterCallProps {
  return scatterSpy.mock.calls.at(-1)?.[0] as ScatterCallProps;
}

const pointsA: ScatterDataPoint[] = [
  { id: 0, x: 1, y: 2 },
  { id: 1, x: 3, y: 4 },
];

describe('StudioScatterChart', () => {
  const { render } = createRenderer();

  const renderScatter = (ui: React.ReactElement) =>
    render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);

  beforeEach(() => {
    scatterSpy.mockClear();
  });

  // MEDIUM 7. These used to assert only `expect(scatterSpy).not.toHaveBeenCalled()` — which a
  // crash fallback, or rendering literally nothing, passes just as happily. What the component
  // must actually do is show the announced no-data overlay every sibling chart family shows,
  // instead of the bare unlabelled `<Box>` it used to render.
  it('shows the announced no-data overlay when there is no data', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        scatterData={[]}
        scatterSeries={null}
        allScatterData={null}
        allScatterSeries={null}
        preserveXFieldBaseline
        preserveSplitByBaseline
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    expect(scatterSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('No data to display.');
  });

  it('renders a single hidden-legend series for ungrouped data', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        scatterData={pointsA}
        scatterSeries={null}
        allScatterData={null}
        allScatterSeries={null}
        preserveXFieldBaseline
        preserveSplitByBaseline
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    expect(props.hideLegend).toBe(true);
    expect(props.series).toHaveLength(1);
    expect(props.series[0].data).toEqual(pointsA);
    expect(props.margin.right).toBe(16);
  });

  it('renders one series per category when a colour-by field is set', () => {
    const series: ScatterSeriesData[] = [
      { id: 'a', label: 'A', data: pointsA },
      { id: 'b', label: 'B', data: [{ id: 0, x: 5, y: 6 }] },
    ];
    renderScatter(
      <StudioScatterChart
        height={200}
        colorField="segment"
        scatterData={null}
        scatterSeries={series}
        allScatterData={null}
        allScatterSeries={null}
        preserveXFieldBaseline
        preserveSplitByBaseline
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    expect(props.hideLegend).toBe(false);
    expect(props.series.map((s) => s.label)).toEqual(['A', 'B']);
    expect(props.margin.right).toBe(8);
  });

  it('prepends a dimmed ghost series when cross-highlighting is active', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        scatterData={pointsA}
        scatterSeries={null}
        allScatterData={[...pointsA, { id: 2, x: 9, y: 9 }]}
        allScatterSeries={null}
        preserveXFieldBaseline
        preserveSplitByBaseline
        shouldShowGhost
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    // ghost (all data) + highlighted (filtered)
    expect(props.series).toHaveLength(2);
    expect(props.series[0].id).toBe('__all-ghost');
    expect(props.series[0].data).toHaveLength(3);
    expect(props.series[1].data).toEqual(pointsA);
  });

  // ── Ghost baseline reliability gate (architecture review, Tier 2 finding 3) ──
  // `preserveXFieldBaseline`/`preserveSplitByBaseline` gate the ghost baseline exactly like
  // `StudioBarChart`/`StudioLineAreaChart`/`StudioPieChart` already do: when a sibling
  // cross-filter marks the baseline unreliable (e.g. the widget's x-field/colour-by field is a
  // join-field expression reading a related source), the ghost must not render even though
  // `shouldShowGhost` is true.
  describe('ghost baseline reliability gate', () => {
    it('suppresses the single-series ghost when preserveXFieldBaseline is false, even with shouldShowGhost active', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={[...pointsA, { id: 2, x: 9, y: 9 }]}
          allScatterSeries={null}
          shouldShowGhost
          preserveXFieldBaseline={false}
          preserveSplitByBaseline
          skipAnimation={false}
        />,
      );
      const props = lastScatterProps();
      // Only the highlighted (filtered) series renders — no `-ghost` series.
      expect(props.series).toHaveLength(1);
      expect(props.series.some((s) => s.id?.endsWith('-ghost'))).toBe(false);
      expect(props.series[0].data).toEqual(pointsA);
    });

    it('renders the single-series ghost when preserveXFieldBaseline is true', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={[...pointsA, { id: 2, x: 9, y: 9 }]}
          allScatterSeries={null}
          shouldShowGhost
          preserveXFieldBaseline
          preserveSplitByBaseline
          skipAnimation={false}
        />,
      );
      const props = lastScatterProps();
      expect(props.series.some((s) => s.id === '__all-ghost')).toBe(true);
    });

    it('suppresses the grouped (colour-by) ghost when preserveSplitByBaseline is false, even with shouldShowGhost active', () => {
      const highlighted: ScatterSeriesData[] = [
        { id: 'a', label: 'A', data: pointsA },
        { id: 'b', label: 'B', data: [{ id: 0, x: 5, y: 6 }] },
      ];
      const baseline: ScatterSeriesData[] = [
        { id: 'a', label: 'A', data: [...pointsA, { id: 2, x: 9, y: 9 }] },
        { id: 'b', label: 'B', data: [{ id: 0, x: 5, y: 6 }] },
      ];
      renderScatter(
        <StudioScatterChart
          height={200}
          colorField="segment"
          scatterData={null}
          scatterSeries={highlighted}
          allScatterData={null}
          allScatterSeries={baseline}
          shouldShowGhost
          preserveXFieldBaseline
          preserveSplitByBaseline={false}
          skipAnimation={false}
        />,
      );
      const props = lastScatterProps();
      // Only the highlighted (filtered) series render — no `-ghost` series.
      expect(props.series).toHaveLength(2);
      expect(props.series.some((s) => s.id?.endsWith('-ghost'))).toBe(false);
    });

    it('renders the grouped (colour-by) ghost when preserveSplitByBaseline is true', () => {
      const highlighted: ScatterSeriesData[] = [{ id: 'a', label: 'A', data: pointsA }];
      const baseline: ScatterSeriesData[] = [
        { id: 'a', label: 'A', data: [...pointsA, { id: 2, x: 9, y: 9 }] },
      ];
      renderScatter(
        <StudioScatterChart
          height={200}
          colorField="segment"
          scatterData={null}
          scatterSeries={highlighted}
          allScatterData={null}
          allScatterSeries={baseline}
          shouldShowGhost
          preserveXFieldBaseline
          preserveSplitByBaseline
          skipAnimation={false}
        />,
      );
      const props = lastScatterProps();
      expect(props.series.some((s) => s.id === 'a-ghost')).toBe(true);
    });
  });

  it('configures a bubble size axis when a size field is set', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        sizeField="volume"
        minRadius={5}
        maxRadius={30}
        scatterData={pointsA}
        scatterSeries={null}
        allScatterData={null}
        allScatterSeries={null}
        preserveXFieldBaseline
        preserveSplitByBaseline
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    expect(props.zAxis).toBeDefined();
    expect((props.zAxis as Array<{ sizeMap: { size: [number, number] } }>)[0].sizeMap.size).toEqual(
      [5, 30],
    );
  });

  // ── Bubble radius sanitization (architecture review, Tier 3) ─────────────────
  // `scatterMinRadius`/`scatterMaxRadius` are only validated by `ScatterConfigSection.tsx`'s
  // editor UI (min < max, 1-50, 1-100). A value written via `loadSerializedState`/an AI
  // `update_widget`/`apply_bulk_update` tool call bypasses that editor entirely and must be
  // sanitized at this render call site instead.
  describe('bubble radius sanitization', () => {
    function sizeMapRange(): [number, number] {
      const props = lastScatterProps();
      return (props.zAxis as Array<{ sizeMap: { size: [number, number] } }>)[0].sizeMap.size;
    }

    it('falls back to the defaults for a NaN min/max radius', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderScatter(
        <StudioScatterChart
          height={200}
          sizeField="volume"
          minRadius={NaN}
          maxRadius={NaN}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
        />,
      );
      expect(sizeMapRange()).toEqual([4, 40]);
      warnSpy.mockRestore();
    });

    it('falls back to the defaults for an inverted (min > max) radius range', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderScatter(
        <StudioScatterChart
          height={200}
          sizeField="volume"
          minRadius={50}
          maxRadius={10}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
        />,
      );
      expect(sizeMapRange()).toEqual([4, 40]);
      warnSpy.mockRestore();
    });

    it('falls back to the defaults for a negative radius', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderScatter(
        <StudioScatterChart
          height={200}
          sizeField="volume"
          minRadius={-5}
          maxRadius={40}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
        />,
      );
      expect(sizeMapRange()).toEqual([4, 40]);
      warnSpy.mockRestore();
    });

    it('falls back to the defaults when min equals max', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderScatter(
        <StudioScatterChart
          height={200}
          sizeField="volume"
          minRadius={20}
          maxRadius={20}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
        />,
      );
      expect(sizeMapRange()).toEqual([4, 40]);
      warnSpy.mockRestore();
    });

    it('still applies a valid, in-range radius pair', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          sizeField="volume"
          minRadius={5}
          maxRadius={30}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
        />,
      );
      expect(sizeMapRange()).toEqual([5, 30]);
    });
  });

  it('pins matching colors on ghost/highlighted series of the same category and strips ghost legend labels (finding 1.2)', () => {
    const highlighted: ScatterSeriesData[] = [
      { id: 'a', label: 'A', data: pointsA },
      { id: 'b', label: 'B', data: [{ id: 0, x: 5, y: 6 }] },
    ];
    // Baseline includes an extra category ('c') that has no points in the current
    // filtered set — this is the length/order mismatch the fix must tolerate.
    const baseline: ScatterSeriesData[] = [
      { id: 'a', label: 'A', data: [...pointsA, { id: 2, x: 9, y: 9 }] },
      { id: 'b', label: 'B', data: [{ id: 0, x: 5, y: 6 }] },
      { id: 'c', label: 'C', data: [{ id: 0, x: 1, y: 1 }] },
    ];
    renderScatter(
      <StudioScatterChart
        height={200}
        colorField="segment"
        scatterData={null}
        scatterSeries={highlighted}
        allScatterData={null}
        allScatterSeries={baseline}
        preserveXFieldBaseline
        preserveSplitByBaseline
        shouldShowGhost
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    // 3 ghost series (baseline) + 2 highlighted series (filtered)
    expect(props.series).toHaveLength(5);

    const ghostA = props.series.find((s) => s.id === 'a-ghost')!;
    const ghostB = props.series.find((s) => s.id === 'b-ghost')!;
    const ghostC = props.series.find((s) => s.id === 'c-ghost')!;
    const highlightedA = props.series.find((s) => s.id === 'a')!;
    const highlightedB = props.series.find((s) => s.id === 'b')!;

    // Same category → same color on both the ghost and the highlighted series,
    // even though the ghost list has one more entry than the highlighted list.
    expect(ghostA.color).toBeDefined();
    expect(ghostA.color).toBe(highlightedA.color);
    expect(ghostB.color).toBeDefined();
    expect(ghostB.color).toBe(highlightedB.color);
    // Every category still gets a distinct color from its neighbours.
    expect(new Set([ghostA.color, ghostB.color, ghostC.color]).size).toBe(3);

    // Ghost series must not carry a `label` — otherwise the legend shows every
    // category twice.
    expect(ghostA.label).toBeUndefined();
    expect(ghostB.label).toBeUndefined();
    expect(ghostC.label).toBeUndefined();
    expect(highlightedA.label).toBe('A');
    expect(highlightedB.label).toBe('B');
  });

  it('gives the ghost and highlighted series the same color in ungrouped (single-series) mode', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        scatterData={pointsA}
        scatterSeries={null}
        allScatterData={[...pointsA, { id: 2, x: 9, y: 9 }]}
        allScatterSeries={null}
        preserveXFieldBaseline
        preserveSplitByBaseline
        shouldShowGhost
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    expect(props.series).toHaveLength(2);
    expect(props.series[0].color).toBeDefined();
    expect(props.series[0].color).toBe(props.series[1].color);
  });

  it('does not treat a colour field as grouped when no series are provided', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        colorField="segment"
        scatterData={pointsA}
        scatterSeries={null}
        allScatterData={null}
        allScatterSeries={null}
        preserveXFieldBaseline
        preserveSplitByBaseline
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    expect(props.hideLegend).toBe(true);
    expect(props.series).toHaveLength(1);
  });

  // ── Emptied cross-filter falls back to the ghost baseline (finding 6) ────────
  describe('an emptied cross-filter shows the ghost baseline instead of blanking the chart', () => {
    it('renders the ghost baseline when the filtered (ungrouped) set is empty but allScatterData has points', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={[]}
          scatterSeries={null}
          allScatterData={pointsA}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost
          skipAnimation={false}
        />,
      );
      expect(scatterSpy).toHaveBeenCalled();
      const props = lastScatterProps();
      // Ghost (baseline) + the highlighted series — the highlighted series still renders
      // (with a genuinely empty `data` array, drawing nothing) since the ungrouped path builds
      // it unconditionally from `scatterData`; only the ghost carries points here.
      expect(props.series).toHaveLength(2);
      expect(props.series[0].id).toBe('__all-ghost');
      expect(props.series[0].data).toEqual(pointsA);
      expect(props.series[1].data).toEqual([]);
    });

    it('still shows the no-data overlay when the filtered set is empty and shouldShowGhost is false', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={[]}
          scatterSeries={null}
          allScatterData={pointsA}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
        />,
      );
      expect(scatterSpy).not.toHaveBeenCalled();
      expect(screen.getByRole('status').textContent).toContain('No data to display.');
    });

    it('renders the ghost baseline when the filtered (grouped) series list is empty but allScatterSeries has points', () => {
      const baseline: ScatterSeriesData[] = [
        { id: 'a', label: 'A', data: pointsA },
        { id: 'b', label: 'B', data: [{ id: 0, x: 5, y: 6 }] },
      ];
      renderScatter(
        <StudioScatterChart
          height={200}
          colorField="segment"
          // `prepareScatterDataGrouped` drops every empty category, so an emptied filter
          // yields `[]` here — truthy, not null.
          scatterSeries={[]}
          scatterData={null}
          allScatterData={null}
          allScatterSeries={baseline}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost
          skipAnimation={false}
        />,
      );
      expect(scatterSpy).toHaveBeenCalled();
      const props = lastScatterProps();
      // Only the ghost series render (baseline) — no highlighted series, since the
      // filtered set is genuinely empty.
      expect(props.series.map((s) => s.id)).toEqual(['a-ghost', 'b-ghost']);
    });

    it('shows the no-data overlay for a grouped chart when both series lists are empty', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          colorField="segment"
          scatterSeries={[]}
          scatterData={null}
          allScatterData={null}
          allScatterSeries={[]}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost
          skipAnimation={false}
        />,
      );
      expect(scatterSpy).not.toHaveBeenCalled();
      expect(screen.getByRole('status').textContent).toContain('No data to display.');
    });
  });

  // MEDIUM 7: scatter was the only chart family with no value formatting at all, so a currency
  // measure read `1234.5` here while the bar chart beside it read "€1,234.50".
  describe('value formatting', () => {
    const currency = (value: number | null) => (value === null ? '' : `€${value.toFixed(2)}`);
    const plain = (value: number | null) => (value === null ? '' : `${value} u`);

    it('applies the axis formatters to both axes', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
          xValueFormatter={plain}
          yValueFormatter={currency}
        />,
      );
      const props = lastScatterProps();
      expect(props.xAxis?.[0].valueFormatter?.(3)).toBe('3 u');
      expect(props.yAxis?.[0].valueFormatter?.(4)).toBe('€4.00');
    });

    it("formats the tooltip's point through both axis formatters", () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
          xValueFormatter={plain}
          yValueFormatter={currency}
        />,
      );
      const props = lastScatterProps();
      expect(props.series[0].valueFormatter?.({ x: 1, y: 2 })).toBe('(1 u, €2.00)');
    });

    it('falls back to the raw value when no formatter is supplied', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
        />,
      );
      const props = lastScatterProps();
      // The AXIS formatters stay `undefined` so the ScatterChart's own default tick formatting
      // applies — passing `String(value)` would override it with something worse.
      expect(props.xAxis?.[0].valueFormatter).toBe(undefined);
      expect(props.yAxis?.[0].valueFormatter).toBe(undefined);
      expect(props.series[0].valueFormatter?.({ x: 1, y: 2 })).toBe('(1, 2)');
    });
  });

  // ── Consumer-supplied slotProps must survive (finding 11) ────────────────────
  describe('merges rather than overwrites consumer-supplied slotProps', () => {
    it('preserves a consumer slotProps key this component does not itself override', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
          slotProps={{
            slotProps: {
              tooltip: { trigger: 'none' },
            },
          }}
        />,
      );
      const props = lastScatterProps();
      // The consumer's `tooltip` sub-key must survive — the component only ever
      // overrides `legend`, so any other key must pass through untouched.
      expect(props.slotProps?.tooltip).toEqual({ trigger: 'none' });
    });

    it("merges consumer-supplied legend overrides with this component's own legend sx, instead of dropping the consumer's legend key", () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
          slotProps={{
            slotProps: {
              legend: { toggleVisibilityOnClick: true, sx: { color: 'red' } },
            },
          }}
        />,
      );
      const props = lastScatterProps();
      // The consumer's own `legend.toggleVisibilityOnClick` key must survive...
      expect(props.slotProps?.legend?.toggleVisibilityOnClick).toBe(true);
      // ...and its `sx.color` must be preserved alongside this component's own
      // required sx overrides (overflow/maxHeight for the scrollable legend), rather
      // than the whole `sx` object (or the whole `legend` object) being clobbered.
      expect(props.slotProps?.legend?.sx?.color).toBe('red');
      expect(props.slotProps?.legend?.sx?.overflowY).toBe('auto');
      expect(props.slotProps?.legend?.sx?.maxHeight).toBe('100%');
    });
  });

  // M10: the scatter chart shipped with no accessible name, and its colour-by series are
  // otherwise distinguished by hue alone.
  describe('accessibility', () => {
    it('names the chart and describes its colour-by series', () => {
      const series: ScatterSeriesData[] = [
        { id: 'a', label: 'A', data: pointsA },
        { id: 'b', label: 'B', data: pointsA },
      ];
      renderScatter(
        <StudioScatterChart
          height={200}
          colorField="segment"
          scatterData={null}
          scatterSeries={series}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
          ariaTitle="Revenue vs orders"
        />,
      );
      const props = lastScatterProps() as unknown as { title?: string; desc?: string };
      expect(props.title).toBe('Revenue vs orders');
      expect(props.desc).toBe('A, B');
    });

    it('still names an ungrouped chart even with no series to describe', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={pointsA}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          preserveXFieldBaseline
          preserveSplitByBaseline
          shouldShowGhost={false}
          skipAnimation={false}
          ariaTitle="Revenue vs orders"
        />,
      );
      const props = lastScatterProps() as unknown as { title?: string; desc?: string };
      expect(props.title).toBe('Revenue vs orders');
      expect(props.desc).toBeUndefined();
    });
  });
});
