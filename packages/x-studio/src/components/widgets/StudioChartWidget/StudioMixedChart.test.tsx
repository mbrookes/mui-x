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
import { StudioMixedChart } from './StudioMixedChart';

const theme = createTheme();

type DataProviderProps = {
  series: Array<{ id: string; type: 'bar' | 'line'; label: string; yAxisId: string }>;
  yAxis: Array<{ id: string; position?: string }>;
};

function lastProps(): DataProviderProps {
  return dataProviderSpy.mock.calls.at(-1)?.[0] as DataProviderProps;
}

const dataSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'revenue', label: 'Revenue', type: 'number' },
    { id: 'count', label: 'Order Count', type: 'number' },
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

describe('StudioMixedChart', () => {
  const { render } = createRenderer();

  const renderMixed = (ui: React.ReactElement) =>
    render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);

  beforeEach(() => {
    dataProviderSpy.mockClear();
  });

  it('maps each y-series to its configured bar/line type (matched by fieldId)', () => {
    renderMixed(
      <StudioMixedChart
        multiYData={multiYData}
        ySeries={[
          { fieldId: 'count', seriesType: 'line' },
          { fieldId: 'revenue', seriesType: 'bar' },
        ]}
        isBlended={false}
        resolvedChartColors={['#111', '#222']}
        widgetSourceId="orders"
        dataSources={{ orders: dataSource }}
        dataSource={dataSource}
        height={300}
        skipAnimation={false}
      />,
    );
    const props = lastProps();
    const byId = Object.fromEntries(props.series.map((s) => [s.id, s.type]));
    // revenue is the first data series (id revenue-0), count is second (id count-1)
    expect(byId['revenue-0']).toBe('bar');
    expect(byId['count-1']).toBe('line');
    expect(props.series.map((s) => s.label)).toEqual(['Revenue', 'Order Count']);
  });

  it('uses a single left y-axis when dualYAxis is off', () => {
    renderMixed(
      <StudioMixedChart
        multiYData={multiYData}
        ySeries={[
          { fieldId: 'revenue', seriesType: 'bar' },
          { fieldId: 'count', seriesType: 'line' },
        ]}
        isBlended={false}
        resolvedChartColors={['#111', '#222']}
        widgetSourceId="orders"
        dataSources={{ orders: dataSource }}
        dataSource={dataSource}
        height={300}
        skipAnimation={false}
      />,
    );
    const props = lastProps();
    expect(props.yAxis).toHaveLength(1);
    expect(props.yAxis[0].id).toBe('left');
    // Line series stays on the left axis when there is no dual axis.
    expect(props.series.find((s) => s.type === 'line')?.yAxisId).toBe('left');
  });

  it('adds a right y-axis and routes line series to it when dualYAxis is on', () => {
    renderMixed(
      <StudioMixedChart
        multiYData={multiYData}
        ySeries={[
          { fieldId: 'revenue', seriesType: 'bar' },
          { fieldId: 'count', seriesType: 'line' },
        ]}
        dualYAxis
        isBlended={false}
        resolvedChartColors={['#111', '#222']}
        widgetSourceId="orders"
        dataSources={{ orders: dataSource }}
        dataSource={dataSource}
        height={300}
        skipAnimation={false}
      />,
    );
    const props = lastProps();
    expect(props.yAxis.map((a) => a.id)).toEqual(['left', 'right']);
    expect(props.series.find((s) => s.type === 'bar')?.yAxisId).toBe('left');
    expect(props.series.find((s) => s.type === 'line')?.yAxisId).toBe('right');
  });

  it('matches series config by index for blended charts', () => {
    renderMixed(
      <StudioMixedChart
        multiYData={multiYData}
        // Config order (index) drives type when blended, even though fieldIds differ.
        ySeries={[
          { fieldId: 'revenue', seriesType: 'line' },
          { fieldId: 'count', seriesType: 'bar' },
        ]}
        isBlended
        resolvedChartColors={['#111', '#222']}
        widgetSourceId="orders"
        dataSources={{ orders: dataSource }}
        dataSource={dataSource}
        height={300}
        skipAnimation={false}
      />,
    );
    const props = lastProps();
    const byId = Object.fromEntries(props.series.map((s) => [s.id, s.type]));
    expect(byId['revenue-0']).toBe('line');
    expect(byId['count-1']).toBe('bar');
  });
});
