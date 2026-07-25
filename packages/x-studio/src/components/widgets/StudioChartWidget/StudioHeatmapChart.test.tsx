import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HeatmapData } from '../../../internals/chartShapes/heatmap';

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
  zAxis: Array<{ colorMap: { color: [string, string]; min: number; max: number } }>;
};

function lastHeatmapProps(): HeatmapCallProps {
  return heatmapSpy.mock.calls.at(-1)?.[0] as HeatmapCallProps;
}

function makeHeatData(): HeatmapData {
  // 'B'/'y2' never had a contributing row — its cell must be absent from `cells`.
  const cells = new Map<string, number>([
    [`A\x00y1`, 10],
    [`A\x00y2`, 0], // a genuine computed 0 (e.g. avg over rows summing to 0)
    [`B\x00y1`, 5],
  ]);
  return { xLabels: ['A', 'B'], yLabels: ['y1', 'y2'], cells, minValue: 0, maxValue: 10 };
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

  // ── finding 5: a no-data cell must not be indistinguishable from a real 0 ───────
  describe('no-data cells vs. genuine computed 0 (finding 5)', () => {
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
      const { container } = renderHeatmap('Revenue heatmap');
      const img = container.querySelector('[role="img"]')!;
      expect(img).not.toBeNull();
      const label = img.getAttribute('aria-label')!;
      expect(label).toContain('Revenue heatmap');
      expect(label).toContain('Region');
      expect(label).toContain('Segment');
      expect(label).toContain('0');
      expect(label).toContain('10');
    });

    it('still exposes the graphic role when no title is supplied', () => {
      const { container } = renderHeatmap(undefined);
      expect(container.querySelector('[role="img"]')).not.toBeNull();
    });
  });
});
