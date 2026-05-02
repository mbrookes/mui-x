import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StudioDataSource, StudioState, StudioWidget } from '../models';
import { StudioChartWidget } from './StudioChartWidget';

const barChartSpy = vi.fn();
const lineChartSpy = vi.fn();
const pieChartSpy = vi.fn();
const scatterChartSpy = vi.fn();

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
  PieChart: (props: unknown) => {
    pieChartSpy(props);
    return <div data-testid="pie-chart" />;
  },
}));

vi.mock('@mui/x-charts/ScatterChart', () => ({
  ScatterChart: (props: unknown) => {
    scatterChartSpy(props);
    return <div data-testid="scatter-chart" />;
  },
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
    pieChartSpy.mockClear();
    scatterChartSpy.mockClear();
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

  it('normalizes multi-y bar-100 series and configures a percent axis', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'bucket', label: 'Bucket', type: 'number' },
        { id: 'revenue', label: 'Revenue', type: 'number' },
        { id: 'profit', label: 'Profit', type: 'number' },
      ],
      rows: [
        { id: '1', bucket: 1, revenue: 30, profit: 10 },
        { id: '2', bucket: 2, revenue: 20, profit: 5 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-bar-100',
      kind: 'chart',
      title: 'Revenue Mix',
      sourceId: 'orders',
      config: {
        chartType: 'bar-100',
        xField: 'bucket',
        yField: 'revenue',
        ySeries: [{ fieldId: 'revenue' }, { fieldId: 'profit' }],
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
    });

    renderChart(widget, dataSource);

    const props = barChartSpy.mock.calls.at(-1)?.[0] as {
      yAxis: Array<{ min?: number; max?: number; valueFormatter?: (value: number) => string }>;
      series: Array<{ label: string; stack?: string; data: number[]; valueFormatter?: (value: number | null) => string }>;
    };

    expect(props.yAxis).toHaveLength(1);
    expect(props.yAxis[0].min).toBe(0);
    expect(props.yAxis[0].max).toBe(100);
    expect(props.yAxis[0].valueFormatter?.(42)).toBe('42%');
    expect(props.series.map((series) => ({
      label: series.label,
      stack: series.stack,
      data: series.data,
      formatted: series.valueFormatter?.(series.data[0] ?? null),
    }))).toEqual([
      { label: 'Revenue', stack: 'total', data: [75, 80], formatted: '75.0%' },
      { label: 'Profit', stack: 'total', data: [25, 20], formatted: '25.0%' },
    ]);
  });

  it('normalizes split-by bar-100 series and configures a percent axis', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'bucket', label: 'Bucket', type: 'number' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: '1', bucket: 1, category: 'A', total: 30 },
        { id: '2', bucket: 1, category: 'B', total: 10 },
        { id: '3', bucket: 2, category: 'A', total: 20 },
        { id: '4', bucket: 2, category: 'B', total: 5 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-split-bar-100',
      kind: 'chart',
      title: 'Revenue Mix by Category',
      sourceId: 'orders',
      config: {
        chartType: 'bar-100',
        xField: 'bucket',
        yField: 'total',
        seriesField: 'category',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
    });

    renderChart(widget, dataSource);

    const props = barChartSpy.mock.calls.at(-1)?.[0] as {
      yAxis: Array<{ min?: number; max?: number; valueFormatter?: (value: number) => string }>;
      series: Array<{ label: string; stack?: string; data: Array<number | null>; valueFormatter?: (value: number | null) => string }>;
    };

    expect(props.yAxis).toHaveLength(1);
    expect(props.yAxis[0].min).toBe(0);
    expect(props.yAxis[0].max).toBe(100);
    expect(props.yAxis[0].valueFormatter?.(42)).toBe('42%');
    expect(props.series.map((series) => ({
      label: series.label,
      stack: series.stack,
      data: series.data,
      formatted: series.valueFormatter?.(series.data[0]),
    }))).toEqual([
      { label: 'A', stack: 'stack', data: [75, 80], formatted: '75.0%' },
      { label: 'B', stack: 'stack', data: [25, 20], formatted: '25.0%' },
    ]);
  });

  it('highlights the selected x-value when a multi-y bar chart has an active cross-filter', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'bucket', label: 'Bucket', type: 'number' },
        { id: 'revenue', label: 'Revenue', type: 'number' },
        { id: 'profit', label: 'Profit', type: 'number' },
      ],
      rows: [
        { id: '1', bucket: 1, revenue: 30, profit: 10 },
        { id: '2', bucket: 2, revenue: 20, profit: 5 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-highlight',
      kind: 'chart',
      title: 'Revenue Mix',
      sourceId: 'orders',
      config: {
        chartType: 'bar',
        xField: 'bucket',
        yField: 'revenue',
        ySeries: [{ fieldId: 'revenue' }, { fieldId: 'profit' }],
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
      filters: [
        {
          id: 'cf-active',
          scope: 'cross-filter',
          sourceWidgetId: widget.id,
          pageId: 'page-1',
          field: 'bucket',
          operator: 'equals',
          value: 2,
        },
      ],
    });

    renderChart(widget, dataSource);

    const props = barChartSpy.mock.calls.at(-1)?.[0] as {
      highlightedAxis?: Array<{ axisId: string; dataIndex: number }>;
    };

    expect(props.highlightedAxis).toEqual([{ axisId: 'cross-filter-axis', dataIndex: 1 }]);
  });

  it('highlights the selected slice when a pie chart has an active cross-filter', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: '1', category: 'A', total: 10 },
        { id: '2', category: 'B', total: 20 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-pie-highlight',
      kind: 'chart',
      title: 'Revenue by Category',
      sourceId: 'orders',
      config: {
        chartType: 'pie',
        xField: 'category',
        yField: 'total',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
      filters: [
        {
          id: 'cf-pie-active',
          scope: 'cross-filter',
          sourceWidgetId: widget.id,
          pageId: 'page-1',
          field: 'category',
          operator: 'equals',
          value: 'B',
        },
      ],
    });

    renderChart(widget, dataSource);

    const props = pieChartSpy.mock.calls.at(-1)?.[0] as {
      highlightedItem?: { seriesId: string; dataIndex: number };
    };

    expect(props.highlightedItem).toEqual({ seriesId: 'cross-filter-series', dataIndex: 1 });
  });

  it('highlights the selected point when a single-series line chart has an active cross-filter', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'bucket', label: 'Bucket', type: 'number' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: '1', bucket: 1, total: 10 },
        { id: '2', bucket: 2, total: 20 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-line-highlight',
      kind: 'chart',
      title: 'Revenue Trend',
      sourceId: 'orders',
      config: {
        chartType: 'line',
        xField: 'bucket',
        yField: 'total',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
      filters: [
        {
          id: 'cf-line-active',
          scope: 'cross-filter',
          sourceWidgetId: widget.id,
          pageId: 'page-1',
          field: 'bucket',
          operator: 'equals',
          value: 2,
        },
      ],
    });

    renderChart(widget, dataSource);

    const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
      highlightedItem?: { seriesId: string; dataIndex: number };
    };

    expect(props.highlightedItem).toEqual({ seriesId: 'cross-filter-series', dataIndex: 1 });
  });

  it('passes prepared scatter data through as a single hidden-legend series', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'revenue', label: 'Revenue', type: 'number' },
        { id: 'profit', label: 'Profit', type: 'number' },
      ],
      rows: [
        { id: '1', revenue: 10, profit: 3 },
        { id: '2', revenue: 20, profit: 7 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-scatter',
      kind: 'chart',
      title: 'Revenue vs Profit',
      sourceId: 'orders',
      config: {
        chartType: 'scatter',
        xField: 'revenue',
        yField: 'profit',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
    });

    renderChart(widget, dataSource);

    const props = scatterChartSpy.mock.calls.at(-1)?.[0] as {
      hideLegend?: boolean;
      series: Array<{ data: Array<{ id: number; x: number; y: number }> }>;
    };

    expect(props.hideLegend).toBe(true);
    expect(props.series).toHaveLength(1);
    expect(props.series[0].data).toEqual([
      { id: 0, x: 10, y: 3 },
      { id: 1, x: 20, y: 7 },
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
      xAxis: Array<{ scaleType?: string; data: unknown[] }>;
      series: Array<{ connectNulls?: boolean }>;
    };

    expect(props.xAxis[0].scaleType).toBe('point');
    expect(props.xAxis[0].data).toEqual(['Feb', 'Jan']);
    expect(props.series.every((series) => series.connectNulls === false)).toBe(true);
  });

  it('normalizes split-by area-100 series and keeps gaps disconnected', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'bucket', label: 'Bucket', type: 'number' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: '1', bucket: 1, category: 'A', total: 30 },
        { id: '2', bucket: 1, category: 'B', total: 10 },
        { id: '3', bucket: 2, category: 'A', total: 20 },
        { id: '4', bucket: 2, category: 'B', total: 5 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-split-area-100',
      kind: 'chart',
      title: 'Revenue Mix Trend',
      sourceId: 'orders',
      config: {
        chartType: 'area-100',
        xField: 'bucket',
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
      yAxis: Array<{ min?: number; max?: number; valueFormatter?: (value: number) => string }>;
      series: Array<{
        label: string;
        area?: boolean;
        stack?: string;
        connectNulls?: boolean;
        data: Array<number | null>;
        valueFormatter?: (value: number | null) => string;
      }>;
    };

    expect(props.yAxis).toHaveLength(1);
    expect(props.yAxis[0].min).toBe(0);
    expect(props.yAxis[0].max).toBe(100);
    expect(props.yAxis[0].valueFormatter?.(42)).toBe('42%');
    expect(props.series.map((series) => ({
      label: series.label,
      area: series.area,
      stack: series.stack,
      connectNulls: series.connectNulls,
      data: series.data,
      formatted: series.valueFormatter?.(series.data[0]),
    }))).toEqual([
      {
        label: 'A',
        area: true,
        stack: 'total',
        connectNulls: false,
        data: [75, 80],
        formatted: '75.0%',
      },
      {
        label: 'B',
        area: true,
        stack: 'total',
        connectNulls: false,
        data: [25, 20],
        formatted: '25.0%',
      },
    ]);
  });

  it('uses a UTC axis and keeps gaps disconnected for single-series area charts', () => {
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
      xAxis: Array<{ scaleType?: string; data: unknown[] }>;
      series: Array<{ connectNulls?: boolean; area?: boolean }>;
    };

    expect(props.xAxis[0].scaleType).toBe('utc');
    expect(props.xAxis[0].data[0]).toBeInstanceOf(Date);
    expect(props.xAxis[0].data[1]).toBeInstanceOf(Date);
    expect(props.series).toHaveLength(1);
    expect(props.series[0].area).toBe(true);
    expect(props.series[0].connectNulls).toBe(false);
  });
});