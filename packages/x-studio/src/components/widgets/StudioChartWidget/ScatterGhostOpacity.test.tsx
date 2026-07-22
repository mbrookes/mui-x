import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import { StudioScatterChart } from './StudioScatterChart';
import type { ScatterDataPoint } from '../../../internals/chartAggregation';

// Real DOM-level test (finding 1): unlike `StudioScatterChart.test.tsx`, this file does
// NOT mock `@mui/x-charts/ScatterChart` — it renders the actual chart so the ghost-dimming
// `sx` selector is exercised against the real SVG shape (`<g data-series>` per series, per
// `Scatter.tsx`), not an assumption about it. A selector that merely *looks* plausible
// (e.g. targeting a nonexistent `MuiScatter-root` class, or using `:nth-of-type` to count
// series by position) would pass a test that mocks the chart away entirely, which is
// exactly why the original bug shipped.

const theme = createTheme();

const highlighted: ScatterDataPoint[] = [
  { id: 0, x: 1, y: 2 },
  { id: 1, x: 3, y: 4 },
];
const all: ScatterDataPoint[] = [...highlighted, { id: 2, x: 9, y: 9 }];

describe('StudioScatterChart ghost opacity (real DOM, finding 1)', () => {
  const { render } = createRenderer();

  it('dims the ghost series circles but not the highlighted series circles', () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <StudioScatterChart
          height={200}
          scatterData={highlighted}
          scatterSeries={null}
          allScatterData={all}
          allScatterSeries={null}
          shouldShowGhost
          skipAnimation
          // Give the chart an explicit pixel width — jsdom does no layout, so without
          // this the auto-sizing (ResizeObserver-driven) container measures 0 and the
          // series never mount their `<g>` wrappers.
          slotProps={{ width: 300 }}
        />
      </ThemeProvider>,
    );

    // eslint-disable-next-line testing-library/no-container -- asserting raw SVG structure/opacity, which has no accessible role to query by
    const ghostGroup = container.querySelector('g[data-series$="-ghost"]');
    // eslint-disable-next-line testing-library/no-container
    const highlightedGroup = container.querySelector('g[data-series]:not([data-series$="-ghost"])');

    expect(ghostGroup).not.toBeNull();
    expect(highlightedGroup).not.toBeNull();

    const ghostCircle = ghostGroup!.querySelector('circle');
    const highlightedCircle = highlightedGroup!.querySelector('circle');
    expect(ghostCircle).not.toBeNull();
    expect(highlightedCircle).not.toBeNull();

    // The ghost (baseline, unfiltered) series must render dimmed...
    expect(getComputedStyle(ghostCircle!).opacity).toBe('0.2');
    // ...while the highlighted (filtered) series stays at full opacity.
    expect(getComputedStyle(highlightedCircle!).opacity).not.toBe('0.2');
  });

  it('applies no ghost-dimming rule when cross-highlight is not active', () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <StudioScatterChart
          height={200}
          scatterData={highlighted}
          scatterSeries={null}
          allScatterData={null}
          allScatterSeries={null}
          shouldShowGhost={false}
          skipAnimation
          slotProps={{ width: 300 }}
        />
      </ThemeProvider>,
    );

    // eslint-disable-next-line testing-library/no-container
    const groups = container.querySelectorAll('g[data-series]');
    expect(groups.length).toBeGreaterThan(0);
    groups.forEach((g) => {
      expect(g.getAttribute('data-series')).not.toMatch(/-ghost$/);
      const circle = g.querySelector('circle');
      expect(circle).not.toBeNull();
      expect(getComputedStyle(circle!).opacity).not.toBe('0.2');
    });
  });
});
