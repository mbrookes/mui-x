import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
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
  }>;
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

  it('renders nothing when there is no data', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        scatterData={[]}
        scatterSeries={null}
        allScatterData={null}
        allScatterSeries={null}
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    expect(scatterSpy).not.toHaveBeenCalled();
  });

  it('renders a single hidden-legend series for ungrouped data', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        scatterData={pointsA}
        scatterSeries={null}
        allScatterData={null}
        allScatterSeries={null}
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

    it('still renders nothing when the filtered set is empty and shouldShowGhost is false', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          scatterData={[]}
          scatterSeries={null}
          allScatterData={pointsA}
          allScatterSeries={null}
          shouldShowGhost={false}
          skipAnimation={false}
        />,
      );
      expect(scatterSpy).not.toHaveBeenCalled();
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

    it('renders nothing for a grouped chart when both the filtered and baseline series lists are empty', () => {
      renderScatter(
        <StudioScatterChart
          height={200}
          colorField="segment"
          scatterSeries={[]}
          scatterData={null}
          allScatterData={null}
          allScatterSeries={[]}
          shouldShowGhost
          skipAnimation={false}
        />,
      );
      expect(scatterSpy).not.toHaveBeenCalled();
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
});
