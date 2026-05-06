import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { act } from 'react';
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

vi.mock('../context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context')>();
  return {
    ...actual,
    useStudioController: () => controller,
    useStudioSelector: (selector: (state: StudioState) => unknown) => selector(mockState),
  };
});

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

  it('keeps split-by series colors stable and shows all categories as ghost bars when a cross-filter is active', () => {
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
          theme: {},
        },
      },
      dashboard: {
        id: 'test-dash',
        title: 'Test',
        activePageId: 'page-1',
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

    expect(props.series.map((series) => series.label)).toEqual(['A', 'B', 'C']);
  });

  it('applies cross-filter with the owning source when xField comes from a related source', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'customerId', label: 'Customer ID', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: 'o1', customerId: 'c1', total: 100 },
        { id: 'o2', customerId: 'c2', total: 80 },
      ],
    };

    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'company', label: 'Company', type: 'string' },
        { id: 'segment', label: 'Segment', type: 'string' },
      ],
      rows: [
        { id: 'c1', company: 'Tech Systems', segment: 'Enterprise' },
        { id: 'c2', company: 'Retail Co', segment: 'SMB' },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-related-xfield',
      kind: 'chart',
      title: 'Top Customers by Revenue',
      sourceId: 'orders',
      config: {
        chartType: 'bar',
        xField: 'company',
        yField: 'total',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, customers: customersSource },
      relationships: [
        {
          id: 'rel-orders-customers',
          sourceId: 'orders',
          sourceField: 'customerId',
          targetId: 'customers',
          targetField: 'id',
          type: 'many-to-one',
        },
      ],
    });

    renderChart(widget, ordersSource);

    const props = barChartSpy.mock.calls.at(-1)?.[0] as {
      onAxisClick?: (event: unknown, params: { axisValue?: string | number | Date }) => void;
    };

    act(() => {
      props.onAxisClick?.(null, { axisValue: 'Tech Systems' });
    });

    expect(controller.applyCrossFilter).toHaveBeenCalledWith(
      'chart-related-xfield',
      'company',
      'Tech Systems',
      'customers',
    );
  });

  it('does not keep unrelated split-by ghost series when the incoming cross-filter constrains the series owner source', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'customerId', label: 'Customer ID', type: 'string' },
        { id: 'month', label: 'Month', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: 'o1', customerId: 'c1', month: 'Jan', total: 100 },
        { id: 'o2', customerId: 'c1', month: 'Feb', total: 80 },
        { id: 'o3', customerId: 'c2', month: 'Jan', total: 60 },
      ],
    };

    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'company', label: 'Company', type: 'string' },
        { id: 'segment', label: 'Segment', type: 'string' },
      ],
      rows: [
        { id: 'c1', company: 'Tech Systems', segment: 'Enterprise' },
        { id: 'c2', company: 'Retail Co', segment: 'SMB' },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-segment-split',
      kind: 'chart',
      title: 'Revenue by Segment',
      sourceId: 'orders',
      config: {
        chartType: 'bar-stacked',
        xField: 'month',
        yField: 'total',
        seriesField: 'segment',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, customers: customersSource },
      relationships: [
        {
          id: 'rel-orders-customers',
          sourceId: 'orders',
          sourceField: 'customerId',
          targetId: 'customers',
          targetField: 'id',
          type: 'many-to-one',
        },
      ],
      filters: [
        {
          id: 'cf-company',
          scope: 'cross-filter',
          sourceWidgetId: 'top-customers-chart',
          pageId: 'page-1',
          field: 'company',
          operator: 'equals',
          value: 'Tech Systems',
          filterSourceId: 'customers',
        },
      ],
    });

    renderChart(widget, ordersSource);

    const props = barChartSpy.mock.calls.at(-1)?.[0] as {
      series: Array<{ label: string }>;
    };

    expect(props.series.map((series) => series.label)).toEqual(['Enterprise']);
  });

  it('filters split-by line series down to the related-source segment selected by a company cross-filter', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'customerId', label: 'Customer ID', type: 'string' },
        { id: 'month', label: 'Month', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: 'o1', customerId: 'c1', month: 'Jan', total: 100 },
        { id: 'o2', customerId: 'c1', month: 'Feb', total: 80 },
        { id: 'o3', customerId: 'c2', month: 'Jan', total: 60 },
      ],
    };

    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'company', label: 'Company', type: 'string' },
        { id: 'segment', label: 'Segment', type: 'string' },
      ],
      rows: [
        { id: 'c1', company: 'Tech Systems', segment: 'Enterprise' },
        { id: 'c2', company: 'Retail Co', segment: 'Midmarket' },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-line-segment-split',
      kind: 'chart',
      title: 'Revenue by Segment',
      sourceId: 'orders',
      config: {
        chartType: 'line',
        xField: 'month',
        yField: 'total',
        seriesField: 'segment',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, customers: customersSource },
      relationships: [
        {
          id: 'rel-orders-customers',
          sourceId: 'orders',
          sourceField: 'customerId',
          targetId: 'customers',
          targetField: 'id',
          type: 'many-to-one',
        },
      ],
      filters: [
        {
          id: 'cf-company-line',
          scope: 'cross-filter',
          sourceWidgetId: 'top-customers-chart',
          pageId: 'page-1',
          field: 'company',
          operator: 'equals',
          value: 'Tech Systems',
          filterSourceId: 'customers',
        },
      ],
    });

    renderChart(widget, ordersSource);

    const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
      series: Array<{ label: string }>;
    };

    expect(props.series.map((series) => series.label)).toEqual(['Enterprise']);
  });

  it('filters expression-backed segment series down to one series when cross-filtered by expression-backed company', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'customerId', label: 'Customer ID', type: 'string' },
        { id: 'month', label: 'Month', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: 'o1', customerId: 'c1', month: 'Jan', total: 100 },
        { id: 'o2', customerId: 'c1', month: 'Feb', total: 80 },
        { id: 'o3', customerId: 'c2', month: 'Jan', total: 60 },
      ],
    };

    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'company', label: 'Company', type: 'string' },
        { id: 'segment', label: 'Segment', type: 'string' },
      ],
      rows: [
        { id: 'c1', company: 'Tech Systems', segment: 'Enterprise' },
        { id: 'c2', company: 'Retail Co', segment: 'Midmarket' },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-expr-line-segment-split',
      kind: 'chart',
      title: 'Quarterly Revenue by Segment',
      sourceId: 'orders',
      config: {
        chartType: 'area-stacked',
        xField: 'month',
        yField: 'total',
        seriesField: 'expr-order-segment',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, customers: customersSource },
      relationships: [
        {
          id: 'rel-orders-customers',
          sourceId: 'orders',
          sourceField: 'customerId',
          targetId: 'customers',
          targetField: 'id',
          type: 'many-to-one',
        },
      ],
      expressionFields: [
        {
          id: 'expr-order-company',
          label: 'Company',
          sourceId: 'orders',
          isMeasure: false,
          type: 'string',
          expression: { joinSourceId: 'customers', fieldId: 'company' },
        },
        {
          id: 'expr-order-segment',
          label: 'Segment',
          sourceId: 'orders',
          isMeasure: false,
          type: 'string',
          expression: { joinSourceId: 'customers', fieldId: 'segment' },
        },
      ],
      filters: [
        {
          id: 'cf-expr-company-line',
          scope: 'cross-filter',
          sourceWidgetId: 'top-customers-chart',
          pageId: 'page-1',
          field: 'expr-order-company',
          operator: 'equals',
          value: 'Tech Systems',
          filterSourceId: 'orders',
        },
      ],
    });

    renderChart(widget, ordersSource);

    const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
      series: Array<{ label: string }>;
    };

    expect(props.series.map((series) => series.label)).toEqual(['Enterprise']);
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

  it('renders multi-y horizontal bars with horizontal layout and a banded y-axis', () => {
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
      id: 'chart-horizontal-multi-y',
      kind: 'chart',
      title: 'Revenue Mix',
      sourceId: 'orders',
      config: {
        chartType: 'bar',
        barLayout: 'horizontal',
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
      layout?: 'horizontal' | 'vertical';
      xAxis: Array<{ scaleType?: string }>;
      yAxis: Array<{ scaleType?: string; data?: Array<string | number> }>;
    };

    expect(props.layout).toBe('horizontal');
    expect(props.xAxis[0].scaleType).toBeUndefined();
    expect(props.yAxis[0].scaleType).toBe('band');
    expect(props.yAxis[0].data).toEqual(['1', '2']);
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

  it('renders split horizontal bars with horizontal layout and a banded y-axis', () => {
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
      id: 'chart-horizontal-split',
      kind: 'chart',
      title: 'Revenue by Category',
      sourceId: 'orders',
      config: {
        chartType: 'bar-stacked',
        barLayout: 'horizontal',
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
      layout?: 'horizontal' | 'vertical';
      xAxis: Array<{ scaleType?: string }>;
      yAxis: Array<{ scaleType?: string; data?: Array<string | number> }>;
    };

    expect(props.layout).toBe('horizontal');
    expect(props.xAxis[0].scaleType).toBeUndefined();
    expect(props.yAxis[0].scaleType).toBe('band');
    expect(props.yAxis[0].data).toEqual(['1', '2']);
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

  it('sets connectNulls to true for split-by line series', () => {
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
    expect(props.series.every((series) => series.connectNulls === true)).toBe(true);
  });

  it('normalizes split-by area-100 series and connects across null values', () => {
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
        connectNulls: true,
        data: [75, 80],
        formatted: '75.0%',
      },
      {
        label: 'B',
        area: true,
        stack: 'total',
        connectNulls: true,
        data: [25, 20],
        formatted: '25.0%',
      },
    ]);
  });

  it('renders a setup placeholder when xField is not configured', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'total', label: 'Total', type: 'number' }],
      rows: [{ id: '1', total: 10 }],
    };

    const widget: StudioWidget = {
      id: 'chart-no-xfield',
      kind: 'chart',
      title: 'Unconfigured Chart',
      sourceId: 'orders',
      config: { chartType: 'bar' } as StudioWidget['config'],
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
    });

    const { getByText } = renderChart(widget, dataSource);

    expect(barChartSpy).not.toHaveBeenCalled();
    getByText('Use the Setup tab to configure this chart.');
  });

  it('renders an empty box for scatter when there is no data', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'revenue', label: 'Revenue', type: 'number' },
        { id: 'profit', label: 'Profit', type: 'number' },
      ],
      rows: [],
    };

    const widget: StudioWidget = {
      id: 'chart-scatter-empty',
      kind: 'chart',
      title: 'Empty Scatter',
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

    expect(scatterChartSpy).not.toHaveBeenCalled();
  });

  it('renders an empty box for a bar chart when there is no data', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'bucket', label: 'Bucket', type: 'number' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [],
    };

    const widget: StudioWidget = {
      id: 'chart-bar-empty',
      kind: 'chart',
      title: 'Empty Bar',
      sourceId: 'orders',
      config: {
        chartType: 'bar',
        xField: 'bucket',
        yField: 'total',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
    });

    renderChart(widget, dataSource);

    expect(barChartSpy).not.toHaveBeenCalled();
  });

  it('passes hoveredItem as highlightedItem when no cross-filter is active', () => {
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
      id: 'chart-no-filter',
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
    });

    renderChart(widget, dataSource);

    const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
      highlightedItem: { seriesId: string; dataIndex: number } | null;
    };

    // hoveredItem starts as null; with no active cross-filter it is passed through as-is
    expect(props.highlightedItem).toBeNull();
  });

  it('drops stale highlightedItem when chart fields change to a different bar series shape', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'bucket', label: 'Bucket', type: 'number' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
        { id: 'profit', label: 'Profit', type: 'number' },
      ],
      rows: [
        { id: '1', bucket: 1, category: 'A', total: 10, profit: 2 },
        { id: '2', bucket: 1, category: 'B', total: 20, profit: 4 },
        { id: '3', bucket: 2, category: 'A', total: 15, profit: 3 },
        { id: '4', bucket: 2, category: 'B', total: 25, profit: 5 },
      ],
    };

    const widget: StudioWidget = {
      id: 'chart-stale-highlight',
      kind: 'chart',
      title: 'Revenue by Category',
      sourceId: 'orders',
      config: {
        chartType: 'bar',
        xField: 'bucket',
        yField: 'total',
        seriesField: 'category',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
    });

    const view = renderChart(widget, dataSource);

    const firstProps = barChartSpy.mock.calls.at(-1)?.[0] as {
      highlightedItem: { seriesId: string; dataIndex: number } | null;
      onHighlightChange: (item: { seriesId: string; dataIndex: number } | null) => void;
    };

    act(() => {
      firstProps.onHighlightChange({ seriesId: 'A', dataIndex: 0 });
    });

    mockState.widgets[widget.id] = {
      ...widget,
      config: {
        chartType: 'bar',
        xField: 'bucket',
        yField: 'total',
        ySeries: [{ fieldId: 'total' }, { fieldId: 'profit' }],
      },
    };

    expect(() =>
      view.rerender(
        <ThemeProvider theme={createTheme()}>
          <StudioChartWidget widget={mockState.widgets[widget.id]} dataSource={dataSource} />
        </ThemeProvider>,
      ),
    ).not.toThrow();

    const nextProps = barChartSpy.mock.calls.at(-1)?.[0] as {
      highlightedItem: { seriesId: string; dataIndex: number } | null;
    };

    expect(nextProps.highlightedItem).toBeNull();
  });

  it('uses a UTC axis and connects across null values for single-series area charts', () => {
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
    expect(props.series[0].connectNulls).toBe(true);
  });
});