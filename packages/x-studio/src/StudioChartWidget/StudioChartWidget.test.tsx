import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StudioDataSource, StudioState, StudioWidget } from '../models';
import { StudioChartWidget } from './StudioChartWidget';

const barChartSpy = vi.fn();
const lineChartSpy = vi.fn();

vi.mock('@mui/x-charts/BarChart', () => ({
  BarChart: (props: unknown) => {
    barChartSpy(props);
    return <div data-testid="bar-chart" />;
  },
}));

vi.mock('@mui/x-charts/LineChart', () => ({
  LineChart: (props: unknown) => {
    lineChartSpy(props);
    return <div data-testid="line-chart" />;
  },
}));

vi.mock('@mui/x-charts/PieChart', () => ({
  PieChart: () => <div data-testid="pie-chart" />,
}));

vi.mock('@mui/x-charts/ScatterChart', () => ({
  ScatterChart: () => <div data-testid="scatter-chart" />,
}));

let mockState: StudioState;

const controller = {
  clearCrossFilter: vi.fn(),
  applyCrossFilter: vi.fn(),
};

vi.mock('../context', () => ({
  useStudioController: () => controller,
  useStudioSelector: (selector: (state: StudioState) => unknown) => selector(mockState),
}));

const { render } = createRenderer();

function renderChart(widget: StudioWidget, dataSource: StudioDataSource) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <StudioChartWidget widget={widget} dataSource={dataSource} />
    </ThemeProvider>,
  );
}

function createState(overrides?: Partial<StudioState>): StudioState {
  return {
    schemaVersion: 1,
    mode: 'edit',
    dashboard: {
      id: 'dashboard-1',
      title: 'Dashboard',
      activePageId: 'page-1',
      ...overrides?.dashboard,
    },
    pages: {
      'page-1': {
        id: 'page-1',
        title: 'Overview',
        widgetRows: [],
      },
      ...overrides?.pages,
    },
    widgets: overrides?.widgets ?? {},
    dataSources: overrides?.dataSources ?? {},
    relationships: overrides?.relationships ?? [],
    filters: overrides?.filters ?? [],
    expressionFields: overrides?.expressionFields ?? [],
    shell: {
      openDrawers: { data: true, compose: true, filters: false },
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
      ...overrides?.shell,
    },
  };
}

describe('<StudioChartWidget />', () => {
  beforeEach(() => {
    barChartSpy.mockClear();
    lineChartSpy.mockClear();
    controller.clearCrossFilter.mockClear();
    controller.applyCrossFilter.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps split-by series colors stable when a cross-filter removes earlier categories', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'month', label: 'Month', type: 'string' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: '1', month: 'Jan', category: 'A', total: 10 },
        { id: '2', month: 'Jan', category: 'B', total: 20 },
        { id: '3', month: 'Feb', category: 'B', total: 5 },
        { id: '4', month: 'Feb', category: 'C', total: 15 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-1',
      kind: 'chart',
      title: 'Revenue by Category',
      sourceId: 'orders',
      config: {
        chartType: 'bar-stacked',
        xField: 'month',
        yField: 'total',
        seriesField: 'category',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
      pages: {
        'page-1': {
          id: 'page-1',
          title: 'Overview',
          widgetRows: [],
          theme: {
            chartPalette: 'custom',
            chartCustomColors: ['#111111', '#222222', '#333333'],
          },
        },
      },
      filters: [
        {
          id: 'cf-1',
          scope: 'cross-filter',
          sourceWidgetId: 'other-widget',
          pageId: 'page-1',
          field: 'month',
          operator: 'equals',
          value: 'Feb',
        },
      ],
    });

    renderChart(widget, dataSource);

    const props = barChartSpy.mock.calls.at(-1)?.[0] as {
      series: Array<{ label: string; color?: string }>;
    };

    expect(props.series.map((series) => ({ label: series.label, color: series.color }))).toEqual([
      { label: 'B', color: '#222222' },
      { label: 'C', color: '#333333' },
    ]);
  });

  it('sets connectNulls to false for split-by line series', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'month', label: 'Month', type: 'string' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: '1', month: 'Jan', category: 'A', total: 10 },
        { id: '2', month: 'Feb', category: 'B', total: 20 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-2',
      kind: 'chart',
      title: 'Revenue by Category',
      sourceId: 'orders',
      config: {
        chartType: 'line',
        xField: 'month',
        yField: 'total',
        seriesField: 'category',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
    });

    renderChart(widget, dataSource);

    const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
      series: Array<{ connectNulls?: boolean }>;
    };

    expect(props.series.every((series) => series.connectNulls === false)).toBe(true);
  });

  it('sets connectNulls to false for single-series area charts', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'date', label: 'Date', type: 'date' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: '1', date: '2024-01-01', total: 10 },
        { id: '2', date: '2024-01-03', total: 20 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-4',
      kind: 'chart',
      title: 'Revenue Trend',
      sourceId: 'orders',
      config: {
        chartType: 'area',
        xField: 'date',
        yField: 'total',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
    });

    renderChart(widget, dataSource);

    const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
      series: Array<{ connectNulls?: boolean; area?: boolean }>;
    };

    expect(props.series).toHaveLength(1);
    expect(props.series[0].area).toBe(true);
    expect(props.series[0].connectNulls).toBe(false);
  });
});