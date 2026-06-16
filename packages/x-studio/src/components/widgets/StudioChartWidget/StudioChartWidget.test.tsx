import * as React from 'react';
import { createRenderer, act, screen } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StudioDataSource, StudioState, StudioWidget } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { StudioChartWidget } from './StudioChartWidget';

const barChartSpy = vi.fn();
const lineChartSpy = vi.fn();
const pieChartSpy = vi.fn();
const scatterChartSpy = vi.fn();
const sankeyChartSpy = vi.fn();

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

vi.mock('@mui/x-charts-pro/SankeyChart', () => ({
  SankeyChart: (props: unknown) => {
    sankeyChartSpy(props);
    return <div data-testid="sankey-chart" />;
  },
}));

let mockState: StudioState;

const controller = {
  clearCrossFilter: vi.fn(),
  applyCrossFilter: vi.fn(),
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

function renderChart(widget: StudioWidget, dataSource: StudioDataSource) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <StudioChartWidget widget={widget} dataSource={dataSource} pageId="page-1" />
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
    sankeyChartSpy.mockClear();
    controller.clearCrossFilter.mockClear();
    controller.applyCrossFilter.mockClear();
    // The getter reads the live `mockState`, which each test assigns before rendering.
    configureStudioContextMock({ getState: () => mockState, controller });
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

  it('does not keep extra expression-backed donut slices when company cross-filter determines a single segment', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'customerId', label: 'Customer ID', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: 'o1', customerId: 'c1', total: 100 },
        { id: 'o2', customerId: 'c1', total: 80 },
        { id: 'o3', customerId: 'c2', total: 60 },
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
      id: 'chart-expr-donut-segment',
      kind: 'chart',
      title: 'Revenue by Segment',
      sourceId: 'orders',
      config: {
        chartType: 'donut',
        xField: 'expr-order-segment',
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
          id: 'cf-expr-company-donut',
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

    const props = pieChartSpy.mock.calls.at(-1)?.[0] as {
      series: Array<{ data: Array<{ label: string }> }>;
    };

    expect(props.series[0].data.map((slice) => slice.label)).toEqual(['Enterprise']);
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
      series: Array<{
        label: string;
        stack?: string;
        data: number[];
        valueFormatter?: (value: number | null) => string;
      }>;
    };

    expect(props.yAxis).toHaveLength(1);
    expect(props.yAxis[0].min).toBe(0);
    expect(props.yAxis[0].max).toBe(100);
    expect(props.yAxis[0].valueFormatter?.(42)).toBe('42%');
    expect(
      props.series.map((series) => ({
        label: series.label,
        stack: series.stack,
        data: series.data,
        formatted: series.valueFormatter?.(series.data[0] ?? null),
      })),
    ).toEqual([
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
    expect(props.yAxis[0].data).toEqual([1, 2]);
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
      series: Array<{
        label: string;
        stack?: string;
        data: Array<number | null>;
        valueFormatter?: (value: number | null) => string;
      }>;
    };

    expect(props.yAxis).toHaveLength(1);
    expect(props.yAxis[0].min).toBe(0);
    expect(props.yAxis[0].max).toBe(100);
    expect(props.yAxis[0].valueFormatter?.(42)).toBe('42%');
    expect(
      props.series.map((series) => ({
        label: series.label,
        stack: series.stack,
        data: series.data,
        formatted: series.valueFormatter?.(series.data[0]),
      })),
    ).toEqual([
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
    expect(props.yAxis[0].data).toEqual([1, 2]);
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
    expect(
      props.series.map((series) => ({
        label: series.label,
        area: series.area,
        stack: series.stack,
        connectNulls: series.connectNulls,
        data: series.data,
        formatted: series.valueFormatter?.(series.data[0]),
      })),
    ).toEqual([
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

    renderChart(widget, dataSource);

    expect(barChartSpy).not.toHaveBeenCalled();
    screen.getByText('Use the Setup tab to configure this chart.');
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
          <StudioChartWidget
            widget={mockState.widgets[widget.id]}
            dataSource={dataSource}
            pageId="page-1"
          />
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

  describe('dual cross-filter: both category (own) and date (incoming) active simultaneously', () => {
    const orderItemsSource: StudioDataSource = {
      id: 'source-order-items',
      label: 'Order Items',
      fields: [
        { id: 'orderId', label: 'Order ID', type: 'string' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: 'li1', orderId: 'o1', category: 'Supplies', total: 100 },
        { id: 'li2', orderId: 'o2', category: 'Electronics', total: 200 },
        { id: 'li3', orderId: 'o3', category: 'Supplies', total: 150 },
        { id: 'li4', orderId: 'o4', category: 'Furniture', total: 300 },
      ],
    };

    const ordersSource: StudioDataSource = {
      id: 'source-orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'date', label: 'Date', type: 'date' },
        { id: 'country', label: 'Country', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: 'o1', date: '2024-01-15', country: 'USA', total: 100 },
        { id: 'o2', date: '2023-11-01', country: 'Germany', total: 200 },
        { id: 'o3', date: '2024-02-20', country: 'USA', total: 150 },
        { id: 'o4', date: '2024-04-10', country: 'France', total: 300 },
      ],
    };

    const relationship = {
      id: 'rel-orderitems-orders',
      sourceId: 'source-order-items',
      sourceField: 'orderId',
      targetId: 'source-orders',
      targetField: 'id',
      type: 'many-to-one' as const,
    };

    // Both filters active at the same time:
    //   - category=Supplies from widget-chart-category (OWN widget, excluded from incoming)
    //   - date Q1 2024 from widget-chart-quarterly (INCOMING cross-filter)
    const bothFilters = [
      {
        id: 'cf-category',
        scope: 'cross-filter' as const,
        sourceWidgetId: 'widget-chart-category',
        pageId: 'page-1',
        field: 'category',
        operator: 'equals' as const,
        value: 'Supplies',
        filterSourceId: 'source-order-items',
      },
      {
        id: 'cf-date',
        scope: 'cross-filter' as const,
        sourceWidgetId: 'widget-chart-quarterly',
        pageId: 'page-1',
        field: 'date',
        operator: 'between' as const,
        value: { from: '2024-01-01', to: '2024-03-31' },
        filterSourceId: 'source-orders',
        fieldType: 'date' as const,
      },
    ];

    it('Revenue by Category (ORDER_ITEMS bar): renders a BarChart with ghost+filtered data when both cross-filters active', () => {
      const widget: StudioWidget = {
        id: 'widget-chart-category',
        kind: 'chart',
        title: 'Revenue by Category',
        sourceId: 'source-order-items',
        config: {
          chartType: 'bar',
          xField: 'category',
          yField: 'total',
        },
      };

      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: {
          'source-order-items': orderItemsSource,
          'source-orders': ordersSource,
        },
        relationships: [relationship],
        filters: bothFilters,
      });

      renderChart(widget, orderItemsSource);

      // Should render a BarChart — NOT return a blank box (chartData must be non-null/non-empty).
      // filteredRows = ORDER_ITEMS whose order is in Q1 2024: li1 (o1=Jan), li3 (o3=Feb) → Supplies:250
      // hasCrossFilters=true, preserveXFieldBaseline=true → ghost rendering:
      //   effectiveSingleSeriesData = allBarChartData → all categories as x-axis
      //   series[0].data = all-category totals from allBarChartData
      expect(barChartSpy).toHaveBeenCalled();
      const props = barChartSpy.mock.calls.at(-1)?.[0] as {
        series: Array<{ data: Array<number | null> }>;
        xAxis: Array<{ data: unknown[] }>;
      };
      // Ghost rendering: x-axis shows ALL categories (not just filtered ones)
      expect(props.xAxis[0].data).toEqual(['Electronics', 'Furniture', 'Supplies']);
      // series data = all-category totals (ghost baseline): Electronics:200, Furniture:300, Supplies:250
      expect(props.series[0].data).toEqual([200, 300, 250]);
    });

    it('Revenue by Country (ORDERS pie): renders a PieChart with cross-filter overlay when both cross-filters active', () => {
      const widget: StudioWidget = {
        id: 'widget-chart-country',
        kind: 'chart',
        title: 'Revenue by Country',
        sourceId: 'source-orders',
        config: {
          chartType: 'pie',
          xField: 'country',
          yField: 'total',
        },
      };

      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: {
          'source-order-items': orderItemsSource,
          'source-orders': ordersSource,
        },
        relationships: [relationship],
        filters: bothFilters,
      });

      renderChart(widget, ordersSource);

      // Should render a PieChart — NOT return a blank box.
      // filteredRows for ORDERS:
      //   category cross-filter (filterSourceId='source-order-items'): orders with Supplies items = o1, o3
      //   date native filter (filterSourceId='source-orders'): o1 (Jan), o3 (Feb) — both in Q1 2024
      //   filtered: o1 (USA, 100), o3 (USA, 150) → { USA: 250 }
      // allChartData (filteredRowsNoCross): all orders → { USA: 250, Germany: 200, France: 300 }
      // hasCrossFilters=true, preserveXFieldBaseline=true → ghost + overlay arc rendering:
      //   series[0] uses allChartData labels (all countries, stable angles)
      //   CrossHighlightPieArc draws dimmed ghost arc + proportional overlay arc per slice
      //   ratioByIndex: USA=1.0, Germany=0, France=0
      expect(pieChartSpy).toHaveBeenCalled();
      const props = pieChartSpy.mock.calls.at(-1)?.[0] as {
        series: Array<{ data: Array<{ label?: string; value: number; color?: string }> }>;
        slots?: { pieArc?: unknown };
      };
      // Single series using allChartData baseline; no per-slice color overrides in data
      // (colors are handled by CrossHighlightPieArc via context, not in the data array).
      expect(props.series).toHaveLength(1);
      const labels = props.series[0].data.map((s) => s.label).filter(Boolean);
      expect(labels).toContain('USA');
      expect(labels).toContain('Germany');
      expect(labels).toContain('France');
      // All slice values come from allChartData (stable baseline), not filtered values
      const sliceByLabel = Object.fromEntries(props.series[0].data.map((s) => [s.label, s]));
      expect(sliceByLabel.USA?.value).toBe(250); // USA total (all orders, not just Supplies)
      expect(sliceByLabel.Germany?.value).toBe(200);
      expect(sliceByLabel.France?.value).toBe(300);
      // Overlay arc rendering delegated to CrossHighlightPieArc via slots.pieArc
      expect(props.slots?.pieArc).toBeDefined();
    });

    it('Quarterly Revenue by Category (ORDER_ITEMS bar-stacked): receives only the category native filter', () => {
      // This widget EMITS the date cross-filter (sourceWidgetId='widget-chart-quarterly'),
      // so it receives category=Supplies as a native filter.
      const widget: StudioWidget = {
        id: 'widget-chart-quarterly',
        kind: 'chart',
        title: 'Quarterly Revenue by Category',
        sourceId: 'source-order-items',
        config: {
          chartType: 'bar-stacked',
          xField: 'date',
          xGroupBy: 'quarter',
          yField: 'total',
          seriesField: 'category',
        },
      };

      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: {
          'source-order-items': orderItemsSource,
          'source-orders': ordersSource,
        },
        relationships: [relationship],
        filters: bothFilters,
      });

      renderChart(widget, orderItemsSource);

      // Should render a BarChart with Supplies data.
      // filteredRows: category cross-filter (filterSourceId='source-order-items' = widgetSourceId → NATIVE)
      //   → ORDER_ITEMS where category='Supplies' = li1 (orderId=o1) and li3 (orderId=o3)
      //   (date cross-filter is from own widget → excluded)
      // After enriching with date from ORDERS: li1.date='2024-01-15', li3.date='2024-02-20'
      // chartData (seriesField): { Supplies: { '2024-Q1': 250 } }
      expect(barChartSpy).toHaveBeenCalled();
      const props = barChartSpy.mock.calls.at(-1)?.[0] as {
        series: Array<{ label: string }>;
      };
      expect(props.series.map((s) => s.label)).toContain('Supplies');
    });
  });

  // ─── crossFilterMode per widget ──────────────────────────────────────────────
  //
  // Tests for the three crossFilterMode settings:
  //   'cross-highlight' (default) — ghost overlay shown when chart is clicked
  //   'cross-filter'              — no ghost, chart redraws with filtered data only
  //   'none'                      — chart ignores all cross-filters entirely
  //
  // Also verifies that interactive (filter widget) filters never trigger ghost
  // rendering regardless of crossFilterMode.

  describe('crossFilterMode per widget', () => {
    const ordersSource: StudioDataSource = {
      id: 'source-orders',
      label: 'Orders',
      fields: [
        { id: 'country', label: 'Country', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: 'o1', country: 'Germany', total: 100 },
        { id: 'o2', country: 'France', total: 200 },
        { id: 'o3', country: 'Germany', total: 150 },
      ],
    };

    // A chart-click cross-filter (scope: 'cross-filter') from another widget
    const chartClickFilter = {
      id: 'cf-country',
      scope: 'cross-filter' as const,
      sourceWidgetId: 'other-widget',
      pageId: 'page-1',
      field: 'country',
      operator: 'equals' as const,
      value: 'Germany',
      filterSourceId: 'source-orders',
    };

    // An interactive filter (scope: 'interactive') from a StudioFilterWidget
    const interactiveFilter = {
      id: 'int-country',
      scope: 'interactive' as const,
      sourceWidgetId: 'filter-widget',
      pageId: 'page-1',
      field: 'country',
      operator: 'equals' as const,
      value: 'Germany',
      filterSourceId: 'source-orders',
    };

    function makeBarWidget(
      id: string,
      crossFilterMode?: 'cross-highlight' | 'cross-filter' | 'none',
    ): StudioWidget {
      return {
        id,
        kind: 'chart',
        title: 'Revenue by Country',
        sourceId: 'source-orders',
        config: {
          chartType: 'bar',
          xField: 'country',
          yField: 'total',
          ...(crossFilterMode ? { crossFilterMode } : {}),
        },
      };
    }

    it('cross-highlight (default): chart-click cross-filter triggers ghost overlay', () => {
      // Default mode (no crossFilterMode set) — ghost bars should appear.
      // With Germany filter: filteredRows = o1+o3 (Germany), allRows = o1+o2+o3 (all).
      // Ghost bar for France should still appear in the x-axis basis.
      const widget = makeBarWidget('widget-highlight');

      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { 'source-orders': ordersSource },
        filters: [chartClickFilter],
      });

      renderChart(widget, ordersSource);

      expect(barChartSpy).toHaveBeenCalled();
      const props = barChartSpy.mock.calls.at(-1)?.[0] as {
        xAxis: Array<{ data: unknown[] }>;
        slots?: { bar?: unknown };
      };
      // Ghost rendering: x-axis should include all countries (from allBarChartData)
      const xLabels = props.xAxis[0].data;
      expect(xLabels).toContain('Germany');
      expect(xLabels).toContain('France');
      // CrossFilterGhostBar slot should be injected
      expect(props.slots?.bar).toBeDefined();
    });

    it('cross-filter mode: chart-click cross-filter shows filtered data, no ghost slot', () => {
      // crossFilterMode='cross-filter': no ghost overlay, chart redraws with Germany only.
      const widget = makeBarWidget('widget-cfmode', 'cross-filter');

      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { 'source-orders': ordersSource },
        filters: [chartClickFilter],
      });

      renderChart(widget, ordersSource);

      expect(barChartSpy).toHaveBeenCalled();
      const props = barChartSpy.mock.calls.at(-1)?.[0] as {
        xAxis: Array<{ data: unknown[] }>;
        slots?: { bar?: unknown };
      };
      // No ghost: x-axis should contain only Germany (filtered data drives the axis)
      const xLabels = props.xAxis[0].data;
      expect(xLabels).toContain('Germany');
      expect(xLabels).not.toContain('France');
      // No CrossFilterGhostBar slot
      expect(props.slots?.bar).toBeUndefined();
    });

    it('none mode: chart-click cross-filter is ignored, full data always shown', () => {
      // crossFilterMode='none': widget ignores cross-filters entirely.
      const widget = makeBarWidget('widget-nonemode', 'none');

      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { 'source-orders': ordersSource },
        filters: [chartClickFilter],
      });

      renderChart(widget, ordersSource);

      expect(barChartSpy).toHaveBeenCalled();
      const props = barChartSpy.mock.calls.at(-1)?.[0] as {
        xAxis: Array<{ data: unknown[] }>;
        slots?: { bar?: unknown };
      };
      // All data shown: both Germany and France in x-axis
      const xLabels = props.xAxis[0].data;
      expect(xLabels).toContain('Germany');
      expect(xLabels).toContain('France');
      // No ghost slot
      expect(props.slots?.bar).toBeUndefined();
    });

    it('interactive (filter widget) filter: no ghost overlay regardless of mode', () => {
      // scope: 'interactive' (filter widget) should never trigger ghost rendering.
      // Default mode (cross-highlight) — but it's an interactive filter, so no ghost.
      const widget = makeBarWidget('widget-interactive');

      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { 'source-orders': ordersSource },
        filters: [interactiveFilter],
      });

      renderChart(widget, ordersSource);

      expect(barChartSpy).toHaveBeenCalled();
      const props = barChartSpy.mock.calls.at(-1)?.[0] as {
        xAxis: Array<{ data: unknown[] }>;
        slots?: { bar?: unknown };
      };
      // Data IS filtered (Germany only) — the interactive filter is a hard filter
      const xLabels = props.xAxis[0].data;
      expect(xLabels).toContain('Germany');
      // No ghost slot: interactive filters don't trigger ghost rendering
      expect(props.slots?.bar).toBeUndefined();
    });
  });

  describe('sankey chart', () => {
    const flowSource: StudioDataSource = {
      id: 'flows',
      label: 'Flows',
      fields: [
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number' },
      ],
      rows: [
        { id: '1', category: 'Hardware', region: 'EU', amount: 10 },
        { id: '2', category: 'Hardware', region: 'EU', amount: 5 },
        { id: '3', category: 'Hardware', region: 'US', amount: 8 },
        { id: '4', category: 'Software', region: 'US', amount: 3 },
      ],
    };

    function makeSankeyWidget(config: Partial<StudioWidget['config']> = {}): StudioWidget {
      return {
        id: 'sankey-1',
        kind: 'chart',
        title: 'Revenue flow',
        sourceId: 'flows',
        config: {
          chartType: 'sankey',
          xField: 'category',
          sankeyTargetField: 'region',
          yField: 'amount',
          ...config,
        },
      };
    }

    it('aggregates rows into summed node/link data', () => {
      const widget = makeSankeyWidget();
      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { flows: flowSource },
      });

      renderChart(widget, flowSource);

      expect(screen.getByTestId('sankey-chart')).toBeVisible();
      const props = sankeyChartSpy.mock.calls.at(-1)?.[0] as {
        series: {
          data: {
            nodes: { id: string }[];
            links: { source: string; target: string; value: number }[];
          };
          linkOptions?: { color?: string; showValues?: boolean };
        };
      };
      expect(props.series.data.nodes).toEqual([
        { id: 'Hardware' },
        { id: 'EU' },
        { id: 'US' },
        { id: 'Software' },
      ]);
      expect(props.series.data.links).toEqual([
        { source: 'Hardware', target: 'EU', value: 15 },
        { source: 'Hardware', target: 'US', value: 8 },
        { source: 'Software', target: 'US', value: 3 },
      ]);
    });

    it('forwards link colour and show-values options', () => {
      const widget = makeSankeyWidget({ sankeyLinkColor: 'target', sankeyShowValues: true });
      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { flows: flowSource },
      });

      renderChart(widget, flowSource);

      const props = sankeyChartSpy.mock.calls.at(-1)?.[0] as {
        series: { linkOptions?: { color?: string; showValues?: boolean } };
      };
      expect(props.series.linkOptions).toMatchObject({ color: 'target', showValues: true });
    });

    it('shows a hint when the target field is not configured', () => {
      const widget = makeSankeyWidget({ sankeyTargetField: undefined });
      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { flows: flowSource },
      });

      renderChart(widget, flowSource);

      expect(sankeyChartSpy).not.toHaveBeenCalled();
      expect(
        screen.getByText(/Sankey chart requires source, target, and value fields/i),
      ).toBeVisible();
    });
  });
});
