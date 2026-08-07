import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioPieChartProps } from './StudioPieChart';

/**
 * Every percentage the pie renders — arc labels (single series AND concentric rings) and the
 * custom below-chart legend — must go through the shared `formatPercent` helper, which formats
 * via `Intl.NumberFormat`. Building them as `` `${x.toFixed(1)}%` `` hardcodes the `.` decimal
 * separator, so a French or German dashboard rendered `42.5%` next to a `42,5 €` produced by
 * `Intl` in the very same widget.
 *
 * `Intl` resolves against the process default locale, which a test cannot change once the
 * module-level formatter cache is warm — so the helper itself is stubbed with a French-style
 * formatter. What is pinned here is that each site DELEGATES to it: a `toFixed` call left behind
 * anywhere would keep emitting the `.` form and fail.
 *
 * This lives in its own file because the stub would otherwise leak into the sibling suite's
 * (default-locale) percentage assertions.
 */
vi.mock('@mui/x-studio-core/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mui/x-studio-core/engine')>()),
  formatPercent: (value: number, fractionDigits: number = 1) =>
    `${value.toFixed(fractionDigits).replace('.', ',')} %`,
}));

const pieSpy = vi.fn();

vi.mock('@mui/x-charts/PieChart', () => ({
  PieChart: (props: unknown) => {
    pieSpy(props);
    return <div data-testid="pie-chart" />;
  },
}));

vi.mock('@mui/x-charts/hooks', () => ({
  useFocusedItem: () => null,
}));

// eslint-disable-next-line import/first
import { StudioPieChart } from './StudioPieChart';

const theme = createTheme();

type PieCallProps = {
  series: Array<{
    arcLabel?: 'value' | ((item: { value: number }) => string);
    data: Array<{ id: number; label: unknown; value: number }>;
  }>;
};

function lastPieProps(): PieCallProps {
  return pieSpy.mock.calls.at(-1)?.[0] as PieCallProps;
}

const noop = () => {};

function baseProps(overrides: Partial<StudioPieChartProps> = {}): StudioPieChartProps {
  return {
    chartType: 'pie',
    height: 300,
    chartData: { labels: ['A', 'B'], values: [25, 75] },
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
    formatLabel: (label) => String(label),
    getSelectedDataIndices: () => [],
    hoveredItem: null,
    hasActiveXFilter: false,
    hasIncomingCrossFilters: false,
    onHoverChange: noop,
    onItemClick: noop,
    ...overrides,
  };
}

describe('StudioPieChart percentages are locale-formatted', () => {
  const { render } = createRenderer();

  const renderPie = (props: StudioPieChartProps) =>
    render(
      <ThemeProvider theme={theme}>
        <StudioPieChart {...props} />
      </ThemeProvider>,
    );

  beforeEach(() => {
    pieSpy.mockClear();
  });

  it('formats the single-series arc label percentage', () => {
    renderPie(baseProps({ pieArcLabel: 'percent' }));
    const arcLabel = lastPieProps().series[0].arcLabel as (item: { value: number }) => string;
    expect(arcLabel({ value: 25 })).toBe('25,0 %');
  });

  it('formats both halves of the filtered / baseline arc label under a cross-highlight', () => {
    renderPie(
      baseProps({
        pieArcLabel: 'percent',
        chartData: { labels: ['A', 'B'], values: [10, 90] },
        allChartData: { labels: ['A', 'B'], values: [25, 75] },
        shouldShowGhost: true,
        preserveXFieldBaseline: true,
      }),
    );
    const arcLabel = lastPieProps().series[0].arcLabel as (item: {
      id?: number;
      value: number;
    }) => string;
    // Filtered 10 of 100 → 10,0 %; baseline 25 of 100 → 25,0 %.
    expect(arcLabel({ id: 0, value: 25 })).toBe('10,0 % / 25,0 %');
  });

  it('formats the custom below-chart legend percentages', () => {
    const { container } = renderPie(baseProps({ pieLegendBelow: true }));
    expect(container.textContent).toContain('25,0 %');
    expect(container.textContent).toContain('75,0 %');
    expect(container.textContent).not.toContain('25.0%');
  });

  it('formats the concentric-ring arc label percentages', () => {
    const enrichedRows = [
      { region: 'North', segment: 'SMB', total: 25 },
      { region: 'North', segment: 'Enterprise', total: 75 },
    ];
    renderPie(
      baseProps({
        pieArcLabel: 'percent',
        seriesField: 'segment',
        xField: 'region',
        yField: 'total',
        enrichedRows,
        allEnrichedRows: enrichedRows,
        chartData: { labels: ['North'], values: [100] },
      }),
    );
    const arcLabel = lastPieProps().series[0].arcLabel as (item: { value: number }) => string;
    expect(arcLabel({ value: 25 })).toBe('25,0 %');
  });
});
