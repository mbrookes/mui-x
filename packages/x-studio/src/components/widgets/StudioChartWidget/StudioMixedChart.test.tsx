import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioDataSource } from '../../../models';
import type { MultiYSeriesData } from '../../../internals/chartAggregation';

const dataProviderSpy = vi.fn();

vi.mock('@mui/x-charts/ChartsDataProvider', () => ({
  ChartsDataProvider: (props: { children?: React.ReactNode }) => {
    dataProviderSpy(props);
    return <div data-testid="mixed-chart">{props.children}</div>;
  },
}));
vi.mock('@mui/x-charts/BarChart', () => ({ BarPlot: () => null }));
vi.mock('@mui/x-charts/LineChart', () => ({ LinePlot: () => null, MarkPlot: () => null }));
vi.mock('@mui/x-charts/ChartsWrapper', () => ({
  ChartsWrapper: (p: { children?: React.ReactNode }) => <div>{p.children}</div>,
}));
vi.mock('@mui/x-charts/ChartsSurface', () => ({
  ChartsSurface: (p: { children?: React.ReactNode }) => <div>{p.children}</div>,
}));
vi.mock('@mui/x-charts/ChartsXAxis', () => ({ ChartsXAxis: () => null }));
vi.mock('@mui/x-charts/ChartsYAxis', () => ({ ChartsYAxis: () => null }));
vi.mock('@mui/x-charts/ChartsTooltip', () => ({ ChartsTooltip: () => null }));
vi.mock('@mui/x-charts/ChartsLegend', () => ({ ChartsLegend: () => null }));
vi.mock('@mui/x-charts/ChartsAxisHighlight', () => ({ ChartsAxisHighlight: () => null }));
vi.mock('@mui/x-charts/ChartsGrid', () => ({ ChartsGrid: () => null }));

// eslint-disable-next-line import/first
import { StudioMixedChart, type StudioMixedChartProps } from './StudioMixedChart';

const theme = createTheme();

type SeriesEntry = {
  id: string;
  type: 'bar' | 'line';
  label: string;
  yAxisId: string;
  valueFormatter?: (value: number | null) => string;
};

type DataProviderProps = {
  series: SeriesEntry[];
  yAxis: Array<{ id: string; position?: string }>;
  xAxis: Array<{ id: string; valueFormatter?: (value: string | number) => string }>;
};

function lastProps(): DataProviderProps {
  return dataProviderSpy.mock.calls.at(-1)?.[0] as DataProviderProps;
}

const identity = (label: string | number) => String(label);

const dataSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'revenue', label: 'Revenue', type: 'number' },
    { id: 'count', label: 'Order Count', type: 'number', format: 'integer' },
  ],
  rows: [],
};

const multiYData: MultiYSeriesData = {
  labels: ['Jan', 'Feb'],
  series: [
    { fieldId: 'revenue', values: [10, 20] },
    { fieldId: 'count', values: [1, 2] },
  ],
};

function baseProps(overrides: Partial<StudioMixedChartProps> = {}): StudioMixedChartProps {
  return {
    multiYData,
    ySeries: [
      { fieldId: 'revenue', seriesType: 'bar' },
      { fieldId: 'count', seriesType: 'line' },
    ],
    isBlended: false,
    resolvedChartColors: ['#111', '#222'],
    widgetSourceId: 'orders',
    dataSources: { orders: dataSource },
    dataSource,
    height: 300,
    skipAnimation: false,
    formatLabel: identity,
    ...overrides,
  };
}

describe('StudioMixedChart', () => {
  const { render } = createRenderer();

  const renderMixed = (props: StudioMixedChartProps) =>
    render(
      <ThemeProvider theme={theme}>
        <StudioMixedChart {...props} />
      </ThemeProvider>,
    );

  beforeEach(() => {
    dataProviderSpy.mockClear();
  });

  it('maps each y-series to its configured bar/line type (matched by fieldId)', () => {
    renderMixed(
      baseProps({
        ySeries: [
          { fieldId: 'count', seriesType: 'line' },
          { fieldId: 'revenue', seriesType: 'bar' },
        ],
      }),
    );
    const props = lastProps();
    const byId = Object.fromEntries(props.series.map((s) => [s.id, s.type]));
    // revenue is the first data series (id revenue-0), count is second (id count-1)
    expect(byId['revenue-0']).toBe('bar');
    expect(byId['count-1']).toBe('line');
    expect(props.series.map((s) => s.label)).toEqual(['Revenue', 'Order Count']);
  });

  it('uses a single left y-axis when dualYAxis is off', () => {
    renderMixed(baseProps());
    const props = lastProps();
    expect(props.yAxis).toHaveLength(1);
    expect(props.yAxis[0].id).toBe('left');
    // Line series stays on the left axis when there is no dual axis.
    expect(props.series.find((s) => s.type === 'line')?.yAxisId).toBe('left');
  });

  it('adds a right y-axis and routes line series to it when dualYAxis is on', () => {
    renderMixed(baseProps({ dualYAxis: true }));
    const props = lastProps();
    expect(props.yAxis.map((a) => a.id)).toEqual(['left', 'right']);
    expect(props.series.find((s) => s.type === 'bar')?.yAxisId).toBe('left');
    expect(props.series.find((s) => s.type === 'line')?.yAxisId).toBe('right');
  });

  it('matches series config by fieldId for blended charts (not by index)', () => {
    renderMixed(
      baseProps({
        // Config order (index) does NOT drive type when blended — fieldId does.
        ySeries: [
          { fieldId: 'revenue', seriesType: 'line' },
          { fieldId: 'count', seriesType: 'bar' },
        ],
        isBlended: true,
      }),
    );
    const props = lastProps();
    const byId = Object.fromEntries(props.series.map((s) => [s.id, s.type]));
    expect(byId['revenue-0']).toBe('line');
    expect(byId['count-1']).toBe('bar');
  });

  // Regression for finding 2.12: two blended series can share a fieldId across DIFFERENT
  // sources (e.g. `amount` from `orders` blended with `amount` from `refunds`) — matching
  // config by fieldId alone config-matches the second series to the first's `ySeries`
  // entry, rendering it with the wrong type/label/format. Blended `multiYData.series`
  // entries carry a `sourceId` (see `aggregateBlendedSeries`/`blendedMultiYData`), so the
  // match must consider the `(fieldId, sourceId)` pair.
  it('matches blended series config by (fieldId, sourceId), not fieldId alone, when two sources share a field id', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [],
    };
    const refundsSource: StudioDataSource = {
      id: 'refunds',
      label: 'Refunds',
      fields: [{ id: 'amount', label: 'Refund Amount', type: 'number' }],
      rows: [],
    };
    renderMixed(
      baseProps({
        multiYData: {
          labels: ['Jan', 'Feb'],
          series: [
            { fieldId: 'amount', sourceId: 'orders', values: [100, 200] },
            { fieldId: 'amount', sourceId: 'refunds', values: [10, 20] },
          ],
        },
        ySeries: [
          { fieldId: 'amount', sourceId: 'orders', seriesType: 'bar' },
          { fieldId: 'amount', sourceId: 'refunds', seriesType: 'line' },
        ] as unknown as StudioMixedChartProps['ySeries'],
        dataSources: { orders: ordersSource, refunds: refundsSource },
        dataSource: ordersSource,
        widgetSourceId: 'orders',
        isBlended: true,
      }),
    );
    const props = lastProps();
    // Both series render with distinct ids ('amount-0', 'amount-1') since ids are
    // fieldId + array index, not just fieldId.
    const byId = Object.fromEntries(props.series.map((s) => [s.id, s]));
    expect(byId['amount-0'].type).toBe('bar');
    // Pre-fix, matching by fieldId alone would resolve the SECOND (refunds) series to
    // the FIRST config entry it finds for fieldId 'amount' (the orders/bar one),
    // rendering it as a bar with the orders series' label instead of its own.
    expect(byId['amount-1'].type).toBe('line');
    expect(props.series.map((s) => s.label)).toEqual(['Amount', 'Refund Amount']);
  });

  // Regression for finding 2.2: aggregateBlendedSeries drops fieldless ySeries entries
  // (`blendSeries.flatMap((s) => s.fieldId ? [...] : [])`) before building `multiYData`,
  // so a half-configured series row (no fieldId yet — the state the setup panel passes
  // through while a user is mid-way through adding a series) shifts every subsequent
  // series one index out of alignment with `ySeries`. Matching by fieldId (rather than
  // index) must still resolve the correct config for the series that comes AFTER the
  // fieldless entry.
  it('matches by fieldId even when a fieldless ySeries entry precedes a configured one (blended)', () => {
    renderMixed(
      baseProps({
        // multiYData only has 2 series (revenue, count) because aggregateBlendedSeries
        // drops the fieldless middle entry — so ySeries[1] (index-wise) would be the
        // fieldless row, and ySeries[2] would be 'count'. An index-based match would
        // wrongly pair multiYData.series[1] ('count') with ySeries[1] (fieldless).
        ySeries: [
          { fieldId: 'revenue', seriesType: 'bar', sourceId: 'orders' },
          { seriesType: 'line' } as unknown as StudioMixedChartProps['ySeries'][number], // fieldless, mid-configuration
          { fieldId: 'count', seriesType: 'line', sourceId: 'orders' },
        ],
        isBlended: true,
      }),
    );
    const props = lastProps();
    const byId = Object.fromEntries(props.series.map((s) => [s.id, s.type]));
    expect(byId['revenue-0']).toBe('bar');
    // Must resolve to 'line' (the real config for fieldId 'count'), not the 'bar'
    // fallback an unmatched (fieldless-shifted) lookup would produce.
    expect(byId['count-1']).toBe('line');
    expect(props.series.map((s) => s.label)).toEqual(['Revenue', 'Order Count']);
  });

  // Regression for finding 2.3: the band x-axis had no valueFormatter, so period-grouped
  // x keys (e.g. '2024-W07') rendered raw instead of through the same `formatLabel` every
  // other categorical chart uses.
  it('formats the band x-axis labels via formatLabel', () => {
    const formatLabel = vi.fn((label: string | number) => `fmt(${label})`);
    renderMixed(baseProps({ formatLabel }));
    const props = lastProps();
    expect(props.xAxis[0].valueFormatter).toBeDefined();
    expect(props.xAxis[0].valueFormatter!('2024-W07')).toBe('fmt(2024-W07)');
  });

  // Regression for finding 2.3: series values ignored the field's format/currencyCode,
  // while the y-axes (which read the same field) were already formatted — the mismatch
  // was visible within one chart.
  it('formats series values via the field format/currencyCode, matching the y-axis', () => {
    renderMixed(baseProps());
    const props = lastProps();
    const countSeries = props.series.find((s) => s.id === 'count-1')!;
    expect(countSeries.valueFormatter).toBeDefined();
    // 'count' field has format: 'integer' — non-compact by default at this call site's
    // options-less usage matches the y-axis's own makeValueFormatter call.
    expect(countSeries.valueFormatter!(1500000)).not.toBe('1500000');
  });
});
