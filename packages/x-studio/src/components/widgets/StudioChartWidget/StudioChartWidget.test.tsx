import * as React from 'react';
import { createRenderer, act, screen } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  StudioDataSource,
  StudioState,
  StudioWidgetConfigForKind,
  StudioWidgetOf,
} from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import {
  StudioUIConfigContext,
  DEFAULT_STUDIO_LOCALE_TEXT,
  type StudioLocaleText,
} from '../../../internals/StudioUIConfigContext';
import { frLocaleText } from '../../../locales/fr';
import { StudioChartWidget } from './StudioChartWidget';
import { withAlpha } from './chartWidgetHelpers';

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

function renderChart(
  widget: StudioWidgetOf<'chart'>,
  dataSource: StudioDataSource,
  localeText?: Partial<StudioLocaleText>,
) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <StudioUIConfigContext.Provider
        value={{
          tableSourceMode: 'explicit',
          featureFlags: {},
          localeText: { ...DEFAULT_STUDIO_LOCALE_TEXT, ...localeText },
        }}
      >
        <StudioChartWidget widget={widget} dataSource={dataSource} pageId="page-1" />
      </StudioUIConfigContext.Provider>
    </ThemeProvider>,
  );
}

/**
 * Flat override bag for `createState` — deliberately mirrors the pre-partition
 * `StudioState` shape as test-fixture sugar local to this file. `createState`
 * itself routes each field into the correct `doc`/`session`/`runtime` partition
 * of the real `StudioState` it returns.
 */
interface StateOverrides {
  mode?: StudioState['session']['mode'];
  dashboard?: Partial<StudioState['doc']['dashboard']>;
  pages?: StudioState['doc']['pages'];
  widgets?: StudioState['doc']['widgets'];
  dataSources?: StudioState['runtime']['dataSources'];
  relationships?: StudioState['doc']['relationships'];
  filters?: StudioState['doc']['filters'];
  expressionFields?: StudioState['doc']['expressionFields'];
  shell?: Partial<StudioState['session']['shell']>;
}

function createState(overrides?: StateOverrides): StudioState {
  return {
    doc: {
      schemaVersion: 1,
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
      relationships: overrides?.relationships ?? [],
      filters: overrides?.filters ?? [],
      expressionFields: overrides?.expressionFields ?? [],
    },
    session: {
      mode: overrides?.mode ?? 'edit',
      shell: {
        openDrawers: { data: true, compose: true, filters: false },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
        ...overrides?.shell,
      },
    },
    runtime: {
      dataSources: overrides?.dataSources ?? {},
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

    const widget: StudioWidgetOf<'chart'> = {
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
          field: 'month',
          operator: 'equals',
          value: 'Feb',
          scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-1' },
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

    const widget: StudioWidgetOf<'chart'> = {
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

    const widget: StudioWidgetOf<'chart'> = {
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
          field: 'company',
          operator: 'equals',
          value: 'Tech Systems',
          filterSourceId: 'customers',
          scope: {
            kind: 'cross-filter',
            sourceWidgetId: 'top-customers-chart',
            pageId: 'page-1',
          },
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

    const widget: StudioWidgetOf<'chart'> = {
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
          field: 'company',
          operator: 'equals',
          value: 'Tech Systems',
          filterSourceId: 'customers',
          scope: {
            kind: 'cross-filter',
            sourceWidgetId: 'top-customers-chart',
            pageId: 'page-1',
          },
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

    const widget: StudioWidgetOf<'chart'> = {
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
          field: 'expr-order-company',
          operator: 'equals',
          value: 'Tech Systems',
          filterSourceId: 'orders',
          scope: {
            kind: 'cross-filter',
            sourceWidgetId: 'top-customers-chart',
            pageId: 'page-1',
          },
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

    const widget: StudioWidgetOf<'chart'> = {
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
          field: 'expr-order-company',
          operator: 'equals',
          value: 'Tech Systems',
          filterSourceId: 'orders',
          scope: {
            kind: 'cross-filter',
            sourceWidgetId: 'top-customers-chart',
            pageId: 'page-1',
          },
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

    const widget: StudioWidgetOf<'chart'> = {
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

    const widget: StudioWidgetOf<'chart'> = {
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

    const widget: StudioWidgetOf<'chart'> = {
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

    const widget: StudioWidgetOf<'chart'> = {
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

    const widget: StudioWidgetOf<'chart'> = {
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
          field: 'bucket',
          operator: 'equals',
          value: 2,
          scope: { kind: 'cross-filter', sourceWidgetId: widget.id, pageId: 'page-1' },
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

    const widget: StudioWidgetOf<'chart'> = {
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
          field: 'category',
          operator: 'equals',
          value: 'B',
          scope: { kind: 'cross-filter', sourceWidgetId: widget.id, pageId: 'page-1' },
        },
      ],
    });

    renderChart(widget, dataSource);

    const props = pieChartSpy.mock.calls.at(-1)?.[0] as {
      highlightedItem?: { seriesId: string; dataIndex: number };
    };

    expect(props.highlightedItem).toEqual({ seriesId: 'cross-filter-series', dataIndex: 1 });
  });

  it('clears the cross-filter (does not add a duplicate) when the already-selected pie slice is clicked again', () => {
    // Regression for the crossFilterValueEquals toggle: clicking the currently-selected
    // value must clear the filter, not stack a second equal filter on top of it.
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

    const widget: StudioWidgetOf<'chart'> = {
      id: 'chart-pie-toggle',
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
      // This widget already emits an equals cross-filter on category = 'B'.
      filters: [
        {
          id: 'cf-pie-toggle',
          field: 'category',
          operator: 'equals',
          value: 'B',
          scope: { kind: 'cross-filter', sourceWidgetId: widget.id, pageId: 'page-1' },
        },
      ],
    });

    renderChart(widget, dataSource);

    const props = pieChartSpy.mock.calls.at(-1)?.[0] as {
      onItemClick?: (event: unknown, params: { dataIndex: number }) => void;
      series: Array<{ data: Array<{ label: string }> }>;
    };
    // Locate the rendered arc index of the already-selected 'B' slice.
    const bIndex = props.series[0].data.findIndex((d) => d.label === 'B');
    expect(bIndex).toBeGreaterThanOrEqual(0);

    act(() => {
      props.onItemClick?.(null, { dataIndex: bIndex });
    });

    // Toggle: same value clicked again → clear, never re-apply.
    expect(controller.clearCrossFilter).toHaveBeenCalledWith(widget.id);
    expect(controller.applyCrossFilter).not.toHaveBeenCalled();
  });

  // Regression for finding 1: the single-click toggle branch for an 'in'-operator active
  // cross-filter used to skip the field-equality check the sibling 'equals' branch already had,
  // so a single-value 'in' filter scoped to a DIFFERENT field (but coincidentally holding the
  // SAME value as the clicked bar) was wrongly treated as "already active for this axis" and
  // cleared instead of a new cross-filter being applied for the clicked field.
  it("applies a new cross-filter (does not clear) when clicking a bar whose value matches an unrelated field's active in-filter", () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'company', label: 'Company', type: 'string' },
        { id: 'segment', label: 'Segment', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: '1', company: 'Tech Systems', segment: 'Enterprise', total: 10 },
        { id: '2', company: 'Retail Co', segment: 'SMB', total: 20 },
      ],
    };

    const widget: StudioWidgetOf<'chart'> = {
      id: 'chart-bar-in-mismatch',
      kind: 'chart',
      title: 'Revenue by Company',
      sourceId: 'orders',
      config: {
        chartType: 'bar',
        xField: 'company',
        yField: 'total',
      },
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
      // This widget's own active cross-filter is a single-value 'in' filter on a DIFFERENT
      // field ('segment'), whose value happens to equal the 'company' bar being clicked below.
      filters: [
        {
          id: 'cf-bar-in-other-field',
          field: 'segment',
          operator: 'in',
          value: ['Tech Systems'],
          scope: { kind: 'cross-filter', sourceWidgetId: widget.id, pageId: 'page-1' },
        },
      ],
    });

    renderChart(widget, dataSource);

    const props = barChartSpy.mock.calls.at(-1)?.[0] as {
      onAxisClick?: (event: unknown, params: { axisValue?: string | number | Date }) => void;
    };

    act(() => {
      props.onAxisClick?.(null, { axisValue: 'Tech Systems' });
    });

    // Must apply a fresh cross-filter on 'company' — not clear the unrelated 'segment' filter as
    // if it were already active for this click.
    expect(controller.applyCrossFilter).toHaveBeenCalledWith(
      widget.id,
      'company',
      'Tech Systems',
      'orders',
    );
    expect(controller.clearCrossFilter).not.toHaveBeenCalled();
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

    const widget: StudioWidgetOf<'chart'> = {
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
          field: 'bucket',
          operator: 'equals',
          value: 2,
          scope: { kind: 'cross-filter', sourceWidgetId: widget.id, pageId: 'page-1' },
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

    const widget: StudioWidgetOf<'chart'> = {
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

    const widget: StudioWidgetOf<'chart'> = {
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

    const widget: StudioWidgetOf<'chart'> = {
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

    const widget: StudioWidgetOf<'chart'> = {
      id: 'chart-no-xfield',
      kind: 'chart',
      title: 'Unconfigured Chart',
      sourceId: 'orders',
      config: { chartType: 'bar' } as StudioWidgetConfigForKind<'chart'>,
    };

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: dataSource },
    });

    renderChart(widget, dataSource);

    expect(barChartSpy).not.toHaveBeenCalled();
    screen.getByText('Use the Setup tab to configure this chart.');
  });

  // These two used to assert only `expect(<chart>Spy).not.toHaveBeenCalled()`, which a crash
  // fallback — or rendering literally nothing — passes just as happily. The sibling above
  // ("renders a setup placeholder when xField is not configured") gets it right by also
  // asserting the hint text; assert what the widget actually shows here too.
  it('shows the no-data overlay for scatter when there is no data', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'revenue', label: 'Revenue', type: 'number' },
        { id: 'profit', label: 'Profit', type: 'number' },
      ],
      rows: [],
    };

    const widget: StudioWidgetOf<'chart'> = {
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
    screen.getByText('No data to display.');
  });

  it('shows the no-data overlay for a bar chart when there is no data', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'bucket', label: 'Bucket', type: 'number' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [],
    };

    const widget: StudioWidgetOf<'chart'> = {
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
    screen.getByText('No data to display.');
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

    const widget: StudioWidgetOf<'chart'> = {
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

    const widget: StudioWidgetOf<'chart'> = {
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

    mockState.doc.widgets[widget.id] = {
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
            widget={mockState.doc.widgets[widget.id] as StudioWidgetOf<'chart'>}
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

    const widget: StudioWidgetOf<'chart'> = {
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

  // Regression for ARCHITECTURE_REVIEW.md finding 1.2: without `xGroupBy`, a `date`-typed
  // x-axis renders as a UTC scale delivering real `Date` labels to `onAxisClick` (the
  // `Date → period key` handling previously existed only inside the `xGroupBy` branch).
  // The un-grouped path must convert the clicked Date to a day key ('YYYY-MM-DD') and tag
  // the filter `fieldType: 'date'` — otherwise the emitted filter's raw ISO string never
  // matches an L1-normalized 'YYYY-MM-DD' cell (loose `==`), blanking every same-source
  // widget instead of filtering it.
  describe('un-grouped daily line/area axis click (finding 1.2)', () => {
    const dailyDataSource: StudioDataSource = {
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

    it('emits a day-key, date-typed cross-filter (not a raw ISO string) on a single axis click', () => {
      const widget: StudioWidgetOf<'chart'> = {
        id: 'chart-daily-line',
        kind: 'chart',
        title: 'Revenue Trend',
        sourceId: 'orders',
        config: {
          chartType: 'line',
          xField: 'date',
          yField: 'total',
        },
      };

      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { orders: dailyDataSource },
      });

      renderChart(widget, dailyDataSource);

      const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
        onAxisClick?: (event: unknown, params: { axisValue?: string | number | Date }) => void;
      };

      act(() => {
        props.onAxisClick?.(null, { axisValue: new Date('2024-01-01T00:00:00.000Z') });
      });

      // Day key + fieldType: 'date' (NOT the pre-fix `label.toISOString()` full-ISO string
      // with no fieldType, which compileSingleCondition compares via loose `==` and which
      // never equals an L1-normalized 'YYYY-MM-DD' cell).
      expect(controller.applyCrossFilter).toHaveBeenCalledWith(
        'chart-daily-line',
        'date',
        '2024-01-01',
        'orders',
        'equals',
        'date',
      );
    });

    it('toggles (clears) the same day back off when the already-selected point is clicked again', () => {
      const widget: StudioWidgetOf<'chart'> = {
        id: 'chart-daily-line-toggle',
        kind: 'chart',
        title: 'Revenue Trend',
        sourceId: 'orders',
        config: {
          chartType: 'line',
          xField: 'date',
          yField: 'total',
        },
      };

      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { orders: dailyDataSource },
        filters: [
          {
            id: 'cf-daily-toggle',
            field: 'date',
            operator: 'equals',
            value: '2024-01-01',
            fieldType: 'date',
            filterSourceId: 'orders',
            scope: { kind: 'cross-filter', sourceWidgetId: widget.id, pageId: 'page-1' },
          },
        ],
      });

      renderChart(widget, dailyDataSource);

      const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
        onAxisClick?: (event: unknown, params: { axisValue?: string | number | Date }) => void;
      };

      act(() => {
        props.onAxisClick?.(null, { axisValue: new Date('2024-01-01T00:00:00.000Z') });
      });

      expect(controller.clearCrossFilter).toHaveBeenCalledWith(widget.id);
      expect(controller.applyCrossFilter).not.toHaveBeenCalled();
    });

    it('shift-clicking a second axis point emits an `in` filter of day keys with fieldType date', () => {
      const widget: StudioWidgetOf<'chart'> = {
        id: 'chart-daily-line-shift',
        kind: 'chart',
        title: 'Revenue Trend',
        sourceId: 'orders',
        config: {
          chartType: 'line',
          xField: 'date',
          yField: 'total',
        },
      };

      // Own widget already has a single day selected via a prior click.
      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { orders: dailyDataSource },
        filters: [
          {
            id: 'cf-daily-existing',
            field: 'date',
            operator: 'equals',
            value: '2024-01-01',
            fieldType: 'date',
            filterSourceId: 'orders',
            scope: { kind: 'cross-filter', sourceWidgetId: widget.id, pageId: 'page-1' },
          },
        ],
      });

      renderChart(widget, dailyDataSource);

      const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
        onAxisClick?: (
          event: { shiftKey?: boolean } | null,
          params: { axisValue?: string | number | Date },
        ) => void;
      };

      act(() => {
        props.onAxisClick?.(
          { shiftKey: true },
          { axisValue: new Date('2024-01-03T00:00:00.000Z') },
        );
      });

      expect(controller.applyCrossFilter).toHaveBeenCalledWith(
        'chart-daily-line-shift',
        'date',
        ['2024-01-01', '2024-01-03'],
        'orders',
        'in',
        'date',
      );
    });
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
        field: 'category',
        operator: 'equals' as const,
        value: 'Supplies',
        filterSourceId: 'source-order-items',
        scope: {
          kind: 'cross-filter' as const,
          sourceWidgetId: 'widget-chart-category',
          pageId: 'page-1',
        },
      },
      {
        id: 'cf-date',
        field: 'date',
        operator: 'between' as const,
        value: { from: '2024-01-01', to: '2024-03-31' },
        filterSourceId: 'source-orders',
        fieldType: 'date' as const,
        scope: {
          kind: 'cross-filter' as const,
          sourceWidgetId: 'widget-chart-quarterly',
          pageId: 'page-1',
        },
      },
    ];

    it('Revenue by Category (ORDER_ITEMS bar): renders a BarChart with ghost+filtered data when both cross-filters active', () => {
      const widget: StudioWidgetOf<'chart'> = {
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

    // Tier-1 #10: the single-series line/area cross-highlight ghost must carry its faded
    // alpha directly on `series.color`, not rely on a positional `colors` array (which x-charts
    // overrides with the explicit series color, rendering the ghost at full opacity). Since my
    // fix sets active.color = lineColor and ghost.color = `${lineColor}40`/`30`, the ghost color
    // must equal the active color plus the alpha suffix — a palette-independent invariant that
    // fails on the pre-fix code (where ghost.color === active.color at full opacity).
    it('Revenue by Category (line): renders the single-series line ghost at faded opacity', () => {
      const widget: StudioWidgetOf<'chart'> = {
        id: 'widget-chart-category',
        kind: 'chart',
        title: 'Revenue Trend',
        sourceId: 'source-order-items',
        config: {
          chartType: 'line',
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

      expect(lineChartSpy).toHaveBeenCalled();
      const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
        series: Array<{ id: string; color?: string }>;
      };
      const ghost = props.series.find((s) => s.id.endsWith('-ghost'));
      const active = props.series.find((s) => s.id === 'cross-filter-series');
      expect(ghost).toBeDefined();
      expect(active?.color).toBeDefined();
      expect(ghost!.color).toBe(withAlpha(active!.color!, 25));
      expect(ghost!.color).not.toBe(active!.color);
    });

    it('Revenue by Category (area): renders the single-series area ghost at faded opacity', () => {
      const widget: StudioWidgetOf<'chart'> = {
        id: 'widget-chart-category',
        kind: 'chart',
        title: 'Revenue Trend',
        sourceId: 'source-order-items',
        config: {
          chartType: 'area',
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

      expect(lineChartSpy).toHaveBeenCalled();
      const props = lineChartSpy.mock.calls.at(-1)?.[0] as {
        series: Array<{ id: string; color?: string }>;
      };
      const ghost = props.series.find((s) => s.id.endsWith('-ghost'));
      const active = props.series.find((s) => s.id === 'cross-filter-series');
      expect(ghost).toBeDefined();
      expect(active?.color).toBeDefined();
      expect(ghost!.color).toBe(withAlpha(active!.color!, 19));
      expect(ghost!.color).not.toBe(active!.color);
    });

    it('Revenue by Country (ORDERS pie): renders a PieChart with cross-filter overlay when both cross-filters active', () => {
      const widget: StudioWidgetOf<'chart'> = {
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
      const widget: StudioWidgetOf<'chart'> = {
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

    // A chart-click cross-filter (scope.kind: 'cross-filter') from another widget
    const chartClickFilter = {
      id: 'cf-country',
      field: 'country',
      operator: 'equals' as const,
      value: 'Germany',
      filterSourceId: 'source-orders',
      scope: { kind: 'cross-filter' as const, sourceWidgetId: 'other-widget', pageId: 'page-1' },
    };

    // An interactive filter (scope.kind: 'interactive') from a StudioFilterWidget
    const interactiveFilter = {
      id: 'int-country',
      field: 'country',
      operator: 'equals' as const,
      value: 'Germany',
      filterSourceId: 'source-orders',
      scope: { kind: 'interactive' as const, sourceWidgetId: 'filter-widget', pageId: 'page-1' },
    };

    function makeBarWidget(
      id: string,
      crossFilterMode?: 'cross-highlight' | 'cross-filter' | 'none',
    ): StudioWidgetOf<'chart'> {
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

    function makeSankeyWidget(
      config: Partial<StudioWidgetConfigForKind<'chart'>> = {},
    ): StudioWidgetOf<'chart'> {
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
        screen.getByText(DEFAULT_STUDIO_LOCALE_TEXT.chartSankeyRequiresFieldsHint),
      ).toBeVisible();
    });
  });

  describe('chart hint localization (heatmap / funnel / sankey / gantt)', () => {
    const genericSource: StudioDataSource = {
      id: 'generic',
      label: 'Generic',
      fields: [
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number' },
        { id: 'startDate', label: 'Start date', type: 'date' },
        { id: 'endDate', label: 'End date', type: 'date' },
      ],
      // At least one row so the shared "no data after filtering" guard doesn't
      // short-circuit before the chart-type-specific "missing fields" guard runs.
      rows: [
        { category: 'A', region: 'B', amount: 10, startDate: '2024-01-01', endDate: '2024-01-02' },
      ],
    };

    // `xField` is set (where the type needs it) but every OTHER required field is left
    // unconfigured, so the type-specific hint inside each `render*` function is reached
    // instead of the shared "chart not configured" / "no data" guards.
    function makeUnconfiguredWidget(
      chartType: 'heatmap' | 'funnel' | 'sankey' | 'gantt',
    ): StudioWidgetOf<'chart'> {
      return {
        id: `${chartType}-hint`,
        kind: 'chart',
        title: 'Chart',
        sourceId: 'generic',
        config: {
          chartType,
          ...(chartType !== 'gantt' ? { xField: 'category' } : {}),
        },
      };
    }

    const cases: Array<{
      chartType: 'heatmap' | 'funnel' | 'sankey' | 'gantt';
      key: keyof typeof DEFAULT_STUDIO_LOCALE_TEXT;
    }> = [
      { chartType: 'heatmap', key: 'chartHeatmapRequiresFieldsHint' },
      { chartType: 'funnel', key: 'chartFunnelRequiresFieldsHint' },
      { chartType: 'sankey', key: 'chartSankeyRequiresFieldsHint' },
      { chartType: 'gantt', key: 'chartGanttRequiresFieldsHint' },
    ];

    it.each(cases)(
      'shows the localized $chartType hint and not the English literal',
      ({ chartType, key }) => {
        const widget = makeUnconfiguredWidget(chartType);
        mockState = createState({
          widgets: { [widget.id]: widget },
          dataSources: { generic: genericSource },
        });

        renderChart(widget, genericSource, frLocaleText);

        const frenchHint = frLocaleText[key] as string;
        const englishHint = DEFAULT_STUDIO_LOCALE_TEXT[key] as string;
        expect(screen.getByText(frenchHint)).toBeVisible();
        expect(screen.queryByText(englishHint)).toBeNull();
      },
    );
  });

  // finding 3.5: a value-threshold annotation (`axis: 'y'`) must target whichever physical
  // axis actually carries the numeric measure, and a category/anomaly marker (`axis: 'x'`)
  // must target whichever physical axis carries the category band — which flips between
  // 'x'/'y' when `barLayout: 'horizontal'` swaps the measure onto the x-axis.
  describe('annotation axis targeting', () => {
    const dataSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number' },
      ],
      rows: [
        { id: '1', category: 'A', amount: 10 },
        { id: '2', category: 'B', amount: 20 },
      ],
    };

    function makeWidget(barLayout: 'grouped' | 'horizontal' | undefined): StudioWidgetOf<'chart'> {
      return {
        id: `chart-annotations-${barLayout ?? 'default'}`,
        kind: 'chart',
        title: 'Revenue',
        sourceId: 'orders',
        config: {
          chartType: 'bar',
          ...(barLayout ? { barLayout } : {}),
          xField: 'category',
          yField: 'amount',
          annotations: [
            { id: 'threshold', axis: 'y', value: 15, label: 'Threshold' },
            { id: 'peak', axis: 'x', value: 'A', label: 'Peak' },
          ],
        },
      };
    }

    type AnnotationLineProps = {
      x?: string | number | Date;
      y?: string | number | Date;
      label?: string;
    };

    /** Every child handed to the chart — annotation lines AND the a11y/keyboard-nav helpers. */
    function collectChartChildren(): Array<React.ReactElement<AnnotationLineProps>> {
      const props = barChartSpy.mock.calls.at(-1)?.[0] as { children?: React.ReactNode };
      return React.Children.toArray(props.children) as Array<
        React.ReactElement<AnnotationLineProps>
      >;
    }

    /**
     * Only the annotation reference lines. Annotations are no longer the chart's only
     * children: `StudioBarChart` also renders a `ChartFocusTracker` (which backs keyboard
     * activation of the cross-filter), so these tests filter by component type rather than
     * treating every child as an annotation.
     */
    function collectAnnotationLines(): Array<React.ReactElement<AnnotationLineProps>> {
      return collectChartChildren().filter((child) => child.type === ChartsReferenceLine);
    }

    it('targets the y-axis for a value annotation and the x-axis for a category annotation in the default (vertical) layout', () => {
      const widget = makeWidget(undefined);
      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { orders: dataSource },
      });

      renderChart(widget, dataSource);

      const lines = collectAnnotationLines();
      expect(lines).toHaveLength(2);
      // The two annotations are the only reference lines, but not the only children — the
      // keyboard-navigation focus tracker rides along too.
      expect(collectChartChildren().length).toBeGreaterThan(lines.length);

      const thresholdLine = lines.find((line) => line.props.label === 'Threshold')!;
      expect(thresholdLine.props.y).toBe(15);
      expect(thresholdLine.props.x).toBeUndefined();

      const peakLine = lines.find((line) => line.props.label === 'Peak')!;
      expect(peakLine.props.x).toBe('A');
      expect(peakLine.props.y).toBeUndefined();
    });

    it('swaps to target the x-axis for a value annotation and the y-axis for a category annotation when barLayout is horizontal (finding 3.5)', () => {
      const widget = makeWidget('horizontal');
      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { orders: dataSource },
      });

      renderChart(widget, dataSource);

      const lines = collectAnnotationLines();
      expect(lines).toHaveLength(2);

      // The numeric threshold now lands on the physical x-axis (which carries the measure
      // in horizontal layout), NOT on the band y-axis.
      const thresholdLine = lines.find((line) => line.props.label === 'Threshold')!;
      expect(thresholdLine.props.x).toBe(15);
      expect(thresholdLine.props.y).toBeUndefined();

      // The category marker now lands on the physical y-axis (the band axis in horizontal
      // layout), NOT on the value x-axis.
      const peakLine = lines.find((line) => line.props.label === 'Peak')!;
      expect(peakLine.props.y).toBe('A');
      expect(peakLine.props.x).toBeUndefined();
    });
  });

  // ─── Finding 2.1 ────────────────────────────────────────────────────────────
  // Before the fix, this component (and useChartWidgetData) subscribed to expression
  // fields scoped to the widget's OWN source only. A calculated column owned by a
  // directly-related source (one hop away) was therefore invisible to the chart-support
  // guard, which reported the chart unsupported even though ChartSetupPanel (which reads
  // the full expression-field list) validated and allowed the exact same configuration
  // — permanently rendering the "unsupported chart configuration" overlay instead of
  // the chart.
  //
  // Note on scope: this test asserts the overlay is gone and the chart renderer runs —
  // exactly what this fix (selector scoping) changes. It does not assert the joined
  // field's per-row VALUE is correct: `enrichRowsWithRelatedFields`
  // (`internals/dataSourceGraph.ts`, out of scope here) only pulls PHYSICAL fields from
  // a related source today, not a related source's own expression fields, so the
  // rendered series legitimately has empty/blank buckets for this exact fixture.
  describe('related-source expression field support (finding 2.1)', () => {
    it('renders the chart (not the unsupported overlay) when xField is a calculated column owned by a directly-related source', () => {
      const ordersSource: StudioDataSource = {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'customerId', label: 'Customer ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
        rows: [
          { id: 'o1', customerId: 'c1', total: 100 },
          { id: 'o2', customerId: 'c1', total: 50 },
          { id: 'o3', customerId: 'c2', total: 30 },
        ],
      };

      const customersSource: StudioDataSource = {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'region', label: 'Region', type: 'string' },
        ],
        rows: [
          { id: 'c1', region: 'US' },
          { id: 'c2', region: 'EU' },
        ],
      };

      const widget: StudioWidgetOf<'chart'> = {
        id: 'chart-customer-tier',
        kind: 'chart',
        title: 'Revenue by Customer Tier',
        sourceId: 'orders',
        config: {
          chartType: 'bar',
          xField: 'customer-tier',
          yField: 'total',
          yAggregation: 'sum',
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
            // Owned by `customers` (the related source), not `orders` (the widget's
            // own source) — the shape the previous own-source-only selector missed.
            id: 'customer-tier',
            label: 'Customer Tier',
            sourceId: 'customers',
            isMeasure: false,
            type: 'string',
            expression: { id: 'region' },
          },
        ],
      });

      renderChart(widget, ordersSource);

      // The permanent "unsupported chart configuration" overlay is gone — the outer
      // guard now agrees with what ChartSetupPanel already validated and allowed. (This
      // fixture's rendered bars are still empty because joining a related source's own
      // EXPRESSION field onto the widget's rows is a separate, out-of-scope limitation
      // of `enrichRowsWithRelatedFields` — see the note above — but the widget must no
      // longer misreport the config itself as unsupported.)
      expect(
        screen.queryByText(DEFAULT_STUDIO_LOCALE_TEXT.chartUnsupportedFieldNotFound),
      ).toBeNull();
      expect(screen.queryByText(DEFAULT_STUDIO_LOCALE_TEXT.chartUnsupportedDefault)).toBeNull();
      expect(
        screen.queryByText(DEFAULT_STUDIO_LOCALE_TEXT.chartUnsupportedMixedCrossSource),
      ).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 1.3 — "No data" guard tests the mode-appropriate baseline
// ─────────────────────────────────────────────────────────────────────────────
//
// The guard previously tested `filteredRows` (the include:'all' baseline, with sibling
// cross-filters applied). A chart that renders from a DIFFERENT baseline — a `'none'`-mode chart
// (renders from `effectiveRows`, ignoring cross-filters) or a cross-highlight ghost (renders from
// the pre-chart-cross baseline) — would blank to "No data" whenever a sibling's cross-filter
// happened to match zero rows, even though its own render set was non-empty.
describe('<StudioChartWidget /> — no-data guard baseline (finding 1.3)', () => {
  const guardSource: StudioDataSource = {
    id: 'guard-src',
    label: 'Guard',
    fields: [
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'region', label: 'Region', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: [
      { id: 'g1', category: 'A', region: 'EU', total: 10 },
      { id: 'g2', category: 'B', region: 'EU', total: 20 },
    ],
  };

  // A sibling chart-click cross-filter that matches ZERO rows of `guardSource`.
  const emptyingCrossFilter = {
    id: 'f-cross-empty',
    field: 'region',
    operator: 'equals',
    value: 'DOES_NOT_EXIST',
    scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
  } as unknown as StudioState['doc']['filters'][number];

  beforeEach(() => {
    barChartSpy.mockClear();
  });

  it("a 'none'-mode chart renders (not 'No data') when a sibling cross-filter matches zero rows", () => {
    const widget: StudioWidgetOf<'chart'> = {
      id: 'w-none',
      kind: 'chart',
      title: 'None-mode',
      sourceId: 'guard-src',
      config: {
        chartType: 'bar',
        xField: 'category',
        yField: 'total',
        crossFilterMode: 'none',
      } as unknown as StudioWidgetOf<'chart'>['config'],
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { 'guard-src': guardSource },
      filters: [emptyingCrossFilter],
    });

    renderChart(widget, guardSource);

    // 'none' mode ignores the cross-filter → effectiveRows is the full (non-empty) set, so the bar
    // chart renders instead of the "No data" overlay.
    expect(screen.queryByRole('status')).toBeNull();
    expect(barChartSpy).toHaveBeenCalled();
  });

  it('a cross-highlight chart renders its ghost (not "No data") when the cross-filter empties the set', () => {
    const widget: StudioWidgetOf<'chart'> = {
      id: 'w-ghost',
      kind: 'chart',
      title: 'Cross-highlight',
      sourceId: 'guard-src',
      // Default crossFilterMode is 'cross-highlight'.
      config: { chartType: 'bar', xField: 'category', yField: 'total' },
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { 'guard-src': guardSource },
      filters: [emptyingCrossFilter],
    });

    renderChart(widget, guardSource);

    // The pre-chart-cross baseline is non-empty, so the guard must NOT fire the "No data" overlay
    // (`StudioNoDataOverlay` renders `role="status"`). Previously the include:'all' `filteredRows`
    // was empty, so the overlay blanked the widget even though its baseline had data.
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// The orchestrator's `formatLabel` called `formatPeriodLabel(String(label))` without
// `localeText`, so the helper fell back to `DEFAULT_STUDIO_LOCALE_TEXT` and a French dashboard
// rendered a hardcoded English "Week 3 2024" on its temporal axis — even though
// `frLocaleText.timeGranWeek` exists and the granularity picker beside the chart was already
// translated.
describe('<StudioChartWidget /> temporal axis label localization', () => {
  const weeklySource: StudioDataSource = {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'date', label: 'Date', type: 'date' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: [
      { id: '1', date: '2024-01-15', total: 10 },
      { id: '2', date: '2024-01-22', total: 20 },
    ],
  };

  const weeklyWidget: StudioWidgetOf<'chart'> = {
    id: 'chart-weekly',
    kind: 'chart',
    title: 'Weekly revenue',
    sourceId: 'orders',
    config: {
      chartType: 'bar',
      xField: 'date',
      xGroupBy: 'week',
      yField: 'total',
    },
  };

  function bandAxisLabels() {
    const props = barChartSpy.mock.calls.at(-1)?.[0] as {
      xAxis: Array<{
        data?: Array<string | number>;
        valueFormatter?: (v: string | number) => string;
      }>;
    };
    const axis = props.xAxis[0];
    return (axis.data ?? []).map((v) => axis.valueFormatter!(v));
  }

  beforeEach(() => {
    barChartSpy.mockClear();
    mockState = createState({
      widgets: { [weeklyWidget.id]: weeklyWidget },
      dataSources: { orders: weeklySource },
    });
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('uses the default English "Week" token', () => {
    renderChart(weeklyWidget, weeklySource);
    expect(bandAxisLabels().every((label) => label.startsWith('Week '))).toBe(true);
  });

  it('translates the week token instead of hardcoding English', () => {
    renderChart(weeklyWidget, weeklySource, frLocaleText);
    const labels = bandAxisLabels();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label.startsWith(`${frLocaleText.timeGranWeek} `))).toBe(true);
    expect(labels.some((label) => label.includes('Week'))).toBe(false);
  });
});
