import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HeatmapData } from '@mui/x-studio-core/engine';

const theme = createTheme();
const heatmapSpy = vi.fn();

vi.mock('@mui/x-charts-premium/HeatmapPremium', () => ({
  HeatmapPremium: (props: unknown) => {
    heatmapSpy(props);
    return <div data-testid="heatmap" />;
  },
}));

// eslint-disable-next-line import/first
import { StudioHeatmapChart } from './StudioHeatmapChart';

type HeatmapCallProps = {
  series: Array<{
    data: [number, number, number][];
    valueFormatter: (v: number | null) => string;
  }>;
  xAxis: Array<{ data: string[]; valueFormatter: (v: string | number) => string }>;
  zAxis: Array<{ colorMap: { color: [string, string]; min: number; max: number } }>;
};

function lastHeatmapProps(): HeatmapCallProps {
  return heatmapSpy.mock.calls.at(-1)?.[0] as HeatmapCallProps;
}

function makeHeatData(): HeatmapData {
  // 'B'/'y2' never had a contributing row — its cell must be absent from `cells`.
  const cells = new Map<string, number | null>([
    [`A\x00y1`, 10],
    [`A\x00y2`, 0], // a genuine computed 0 (e.g. avg over rows summing to 0)
    [`B\x00y1`, 5],
  ]);
  return { xLabels: ['A', 'B'], yLabels: ['y1', 'y2'], cells, minValue: 0, maxValue: 10 };
}

/** A grid where ('B', 'y1') had rows but no measurable value — `aggregateHeatmap` emits `null`. */
function makeHeatDataWithUnmeasuredCell(): HeatmapData {
  const cells = new Map<string, number | null>([
    [`A\x00y1`, 10],
    [`B\x00y1`, null],
  ]);
  return { xLabels: ['A', 'B'], yLabels: ['y1'], cells, minValue: 10, maxValue: 10 };
}

describe('StudioHeatmapChart', () => {
  const { render } = createRenderer();

  beforeEach(() => {
    heatmapSpy.mockClear();
  });

  // ── finding 4: dark-mode color ramp must not anchor to hardcoded white ─────────
  describe('color ramp low anchor', () => {
    it('does not anchor the color ramp to a hardcoded white in dark mode', () => {
      const darkTheme = createTheme({ palette: { mode: 'dark' } });
      render(
        <ThemeProvider theme={darkTheme}>
          <StudioHeatmapChart
            height={200}
            heatData={makeHeatData()}
            colorScheme="primary"
            legendPosition="bottom"
            legendAlign="center"
          />
        </ThemeProvider>,
      );
      const props = lastHeatmapProps();
      const [lowAnchor] = props.zAxis[0].colorMap.color;
      expect(lowAnchor).not.toBe('#ffffff');
      expect(lowAnchor).toBe(darkTheme.palette.background.paper);
    });

    it("tracks the theme's background.paper in light mode too", () => {
      const lightTheme = createTheme({ palette: { mode: 'light' } });
      render(
        <ThemeProvider theme={lightTheme}>
          <StudioHeatmapChart
            height={200}
            heatData={makeHeatData()}
            colorScheme="primary"
            legendPosition="bottom"
            legendAlign="center"
          />
        </ThemeProvider>,
      );
      const props = lastHeatmapProps();
      const [lowAnchor] = props.zAxis[0].colorMap.color;
      expect(lowAnchor).toBe(lightTheme.palette.background.paper);
    });
  });

  // A cell that measured nothing must not be indistinguishable from a real 0.
  describe('no-data cells vs. genuine computed 0', () => {
    const theme = createTheme();

    it('omits an (x, y) combo with no contributing rows from the series data entirely', () => {
      render(
        <ThemeProvider theme={theme}>
          <StudioHeatmapChart
            height={200}
            heatData={makeHeatData()}
            colorScheme="primary"
            legendPosition="bottom"
            legendAlign="center"
          />
        </ThemeProvider>,
      );
      const props = lastHeatmapProps();
      const data = props.series[0].data;
      // xLabels = ['A', 'B'], yLabels = ['y1', 'y2'] -> indices: A=0,B=1; y1=0,y2=1.
      // (B, y2) never had a contributing row, so index pair (1, 1) must be absent.
      expect(data.some(([xi, yi]) => xi === 1 && yi === 1)).toBe(false);
      // The genuine computed 0 for (A, y2) -> (0, 1) must still be present.
      expect(data.some(([xi, yi, v]) => xi === 0 && yi === 1 && v === 0)).toBe(true);
      // And an ordinary populated cell (A, y1) -> (0, 0) is present with its value.
      expect(data.some(([xi, yi, v]) => xi === 0 && yi === 0 && v === 10)).toBe(true);
    });

    it('omits a cell whose rows had no measurable value (null), instead of painting it as 0', () => {
      render(
        <ThemeProvider theme={theme}>
          <StudioHeatmapChart
            height={200}
            heatData={makeHeatDataWithUnmeasuredCell()}
            colorScheme="primary"
            legendPosition="bottom"
            legendAlign="center"
          />
        </ThemeProvider>,
      );
      const data = lastHeatmapProps().series[0].data;
      // ('B', 'y1') -> (1, 0): rows landed there, but nothing was measured. It must not be
      // pushed as a datum at all — a `0` here would render a coloured tile and a "0" tooltip
      // for a reading that was never taken.
      expect(data.some(([xi, yi]) => xi === 1 && yi === 0)).toBe(false);
      expect(data).toEqual([[0, 0, 10]]);
    });

    it('formats a genuinely missing cell differently from a real computed 0 via valueFormatter', () => {
      render(
        <ThemeProvider theme={theme}>
          <StudioHeatmapChart
            height={200}
            heatData={makeHeatData()}
            colorScheme="primary"
            legendPosition="bottom"
            legendAlign="center"
          />
        </ThemeProvider>,
      );
      const { valueFormatter } = lastHeatmapProps().series[0];
      // The `v == null` branch (previously dead code, since 0 was always passed for
      // missing cells) must now actually be reachable and produce a distinct ('')
      // rendering from a genuine 0.
      expect(valueFormatter(null)).toBe('');
      expect(valueFormatter(0)).not.toBe('');
    });
  });

  // `xLabels` are raw aggregation keys ('2024-01' under `xGroupBy: 'month'`), so the axis has to
  // run them through the widget's `formatLabel` like every other x-axis family does.
  describe('x-axis label formatting', () => {
    function renderWithFormatLabel(formatLabel?: (label: string | number) => string) {
      const periodData: HeatmapData = {
        xLabels: ['2024-01', '2024-02'],
        yLabels: ['EU'],
        cells: new Map<string, number | null>([
          [`2024-01\x00EU`, 10],
          [`2024-02\x00EU`, 20],
        ]),
        minValue: 10,
        maxValue: 20,
      };
      return render(
        <ThemeProvider theme={theme}>
          <StudioHeatmapChart
            height={200}
            heatData={periodData}
            colorScheme="primary"
            legendPosition="bottom"
            legendAlign="center"
            formatLabel={formatLabel}
          />
        </ThemeProvider>,
      );
    }

    it('renders x-axis ticks through formatLabel instead of the raw period key', () => {
      renderWithFormatLabel((label) => (label === '2024-01' ? 'Jan 2024' : 'Feb 2024'));
      const { valueFormatter } = lastHeatmapProps().xAxis[0];
      expect(valueFormatter('2024-01')).toBe('Jan 2024');
      expect(valueFormatter('2024-02')).toBe('Feb 2024');
    });

    it('falls back to rendering the label as-is when no formatLabel is supplied', () => {
      renderWithFormatLabel(undefined);
      expect(lastHeatmapProps().xAxis[0].valueFormatter('2024-01')).toBe('2024-01');
    });
  });

  // M10: the heatmap had no accessible name. Unlike every sibling family, `HeatmapPremium`
  // never threads `title`/`desc` through to its `ChartsLayerContainer`, so the name has to be
  // applied on a `role="img"` wrapper — the same shape as `StudioSankeyChart`/`StudioGanttChart`.
  describe('accessibility', () => {
    function renderHeatmap(ariaTitle?: string) {
      return render(
        <ThemeProvider theme={theme}>
          <StudioHeatmapChart
            height={200}
            heatData={makeHeatData()}
            xFieldLabel="Region"
            yFieldLabel="Segment"
            colorScheme="primary"
            legendPosition="bottom"
            legendAlign="center"
            ariaTitle={ariaTitle}
          />
        </ThemeProvider>,
      );
    }

    it('exposes a named image with the measured dimensions and value range', () => {
      renderHeatmap('Revenue heatmap');
      const img = screen.getByRole('img');
      const label = img.getAttribute('aria-label')!;
      expect(label).toContain('Revenue heatmap');
      expect(label).toContain('Region');
      expect(label).toContain('Segment');
      expect(label).toContain('0');
      expect(label).toContain('10');
    });

    it('still exposes the graphic role when no title is supplied', () => {
      renderHeatmap(undefined);
      expect(screen.getByRole('img')).not.toBeNull();
    });
  });
});
