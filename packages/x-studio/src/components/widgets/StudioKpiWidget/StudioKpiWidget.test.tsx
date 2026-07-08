import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  StudioDataSource,
  StudioState,
  StudioWidgetOf,
  StudioExpressionField,
  StudioRelationship,
  StudioFilterState,
} from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import type { KpiTrendProps } from './KpiTrend';
import type { KpiValueProps } from './KpiValue';
import { StudioKpiWidget } from './StudioKpiWidget';

// The KPI widget reads its current-period rows through useWidgetRows. Route the mock
// through a hoisted holder so each test can swap the fixture rows it returns.
const rowsHolder = vi.hoisted(() => ({
  current: [] as Record<string, unknown>[],
}));

vi.mock('../../../internals/useWidgetRows', () => ({
  useWidgetRows: () => ({
    filteredRowsNoCross: rowsHolder.current,
    effectiveRows: rowsHolder.current,
    isLoading: false,
    isError: false,
    errorMessage: undefined,
  }),
}));

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

// Spy slot components: record the numeric trend result and the displayed value string
// so assertions can check the computed numbers without coupling to KpiTrend/KpiValue
// string formatting.
const trendSpy = vi.fn();
function TrendSpy(props: KpiTrendProps) {
  trendSpy(props.trendResult);
  return null;
}
const valueSpy = vi.fn();
function ValueSpy(props: KpiValueProps) {
  valueSpy(props.value);
  return null;
}

function lastTrend(): KpiTrendProps['trendResult'] {
  return trendSpy.mock.calls.at(-1)?.[0] ?? null;
}
function lastValue(): string | undefined {
  return valueSpy.mock.calls.at(-1)?.[0];
}

let mockState: StudioState;

/**
 * Flat override bag for `createState` — mirrors the pre-partition `StudioState`
 * shape as test-fixture sugar; `createState` routes each field into the correct
 * `doc` / `session` / `runtime` partition.
 */
interface StateOverrides {
  widgets?: StudioState['doc']['widgets'];
  dataSources?: StudioState['runtime']['dataSources'];
  relationships?: StudioRelationship[];
  filters?: StudioFilterState[];
  expressionFields?: StudioExpressionField[];
}

function createState(overrides?: StateOverrides): StudioState {
  return {
    doc: {
      schemaVersion: 1,
      dashboard: {
        id: 'dashboard-1',
        title: 'Dashboard',
        activePageId: 'page-1',
      },
      pages: {
        'page-1': { id: 'page-1', title: 'Overview', widgetRows: [] },
      },
      widgets: overrides?.widgets ?? {},
      relationships: overrides?.relationships ?? [],
      filters: overrides?.filters ?? [],
      expressionFields: overrides?.expressionFields ?? [],
    },
    session: {
      mode: 'edit',
      shell: {
        openDrawers: { data: false, compose: false, filters: false },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
      },
    },
    runtime: {
      dataSources: overrides?.dataSources ?? {},
    },
  } as unknown as StudioState;
}

const { render } = createRenderer();

function renderKpi(widget: StudioWidgetOf<'kpi'>, dataSource: StudioDataSource) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <StudioKpiWidget
        widget={widget}
        dataSource={dataSource}
        pageId="page-1"
        slots={{ trend: TrendSpy, value: ValueSpy }}
      />
    </ThemeProvider>,
  );
}

// ─── Cross-source fixtures: KPI on `order_items`, value field is `orders.revenue`. ──
// order_items is the "many"/child grain; orders is the parent that owns `revenue`.
// Multiple child rows per parent so a naive child-grain aggregation would differ from
// the correct parent-grain one.
const orderItemsSource: StudioDataSource = {
  id: 'order_items',
  label: 'Order items',
  fields: [
    { id: 'id', label: 'ID', type: 'string' },
    { id: 'orderId', label: 'Order', type: 'string' },
    { id: 'oiDate', label: 'Date', type: 'date' },
  ],
  rows: [],
} as unknown as StudioDataSource;

const ordersSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'id', label: 'ID', type: 'string' },
    { id: 'revenue', label: 'Revenue', type: 'number' },
  ],
  rows: [
    { id: 'O1', revenue: 300 },
    { id: 'O2', revenue: 200 },
  ],
} as unknown as StudioDataSource;

// order_items pointing at O1 (revenue 300) fall in the current fixed-period window;
// those pointing at O2 (revenue 200) fall in the previous window.
const currentWindowItems = [
  { id: 'oi1', orderId: 'O1', oiDate: '2026-07-01' },
  { id: 'oi2', orderId: 'O1', oiDate: '2026-07-02' },
  { id: 'oi3', orderId: 'O1', oiDate: '2026-06-20' },
];
const previousWindowItems = [
  { id: 'oi4', orderId: 'O2', oiDate: '2026-05-20' },
  { id: 'oi5', orderId: 'O2', oiDate: '2026-05-25' },
];
const allOrderItems = [...currentWindowItems, ...previousWindowItems];

const crossSourceRelationship: StudioRelationship = {
  id: 'rel-1',
  sourceId: 'orders',
  targetId: 'order_items',
  sourceField: 'id',
  targetField: 'orderId',
  type: 'many-to-one',
} as unknown as StudioRelationship;

// ─── Single-source fixtures: `sales` with a numeric `amount` and a date `saleDate`. ──
const salesSource: StudioDataSource = {
  id: 'sales',
  label: 'Sales',
  fields: [
    { id: 'id', label: 'ID', type: 'string' },
    { id: 'amount', label: 'Amount', type: 'number' },
    { id: 'saleDate', label: 'Date', type: 'date' },
  ],
  rows: [],
} as unknown as StudioDataSource;

const salesRows = [
  // current window (sum 300)
  { id: 's1', amount: 100, saleDate: '2026-07-01' },
  { id: 's2', amount: 200, saleDate: '2026-07-02' },
  // previous window (sum 200)
  { id: 's3', amount: 100, saleDate: '2026-05-20' },
  { id: 's4', amount: 100, saleDate: '2026-05-21' },
  // outside both windows — only affects the all-time headline
  { id: 's5', amount: 1000, saleDate: '2026-01-01' },
];

const revenueMeasure: StudioExpressionField = {
  id: 'revenueMeasure',
  label: 'Revenue',
  sourceId: 'sales',
  isMeasure: true,
  type: 'number',
  expression: { id: 'amount', aggregation: 'sum' },
} as unknown as StudioExpressionField;

function makeWidget(config: Record<string, unknown>, sourceId: string): StudioWidgetOf<'kpi'> {
  return {
    id: 'kpi-1',
    kind: 'kpi',
    title: 'KPI',
    sourceId,
    config,
  } as unknown as StudioWidgetOf<'kpi'>;
}

describe('<StudioKpiWidget /> fixed-period trend correctness', () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    // The fixed-period branch reads `new Date()`; pin "today" so the rolling windows
    // are deterministic. Only fake Date so React scheduling is unaffected.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('computes a fixed-period trend for a cross-source (parent) value field', () => {
    rowsHolder.current = allOrderItems;
    const widget = makeWidget(
      {
        kpiValueField: 'revenue',
        kpiAggregation: 'sum',
        kpiTrend: true,
        kpiTrendFixedPeriod: 'month',
        kpiSparklineField: 'oiDate',
      },
      'order_items',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { order_items: orderItemsSource, orders: ordersSource },
      relationships: [crossSourceRelationship],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, orderItemsSource);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    // Current window → O1 (300), previous window → O2 (200): +50%.
    expect(trend!.delta).toBeCloseTo(0.5);
    expect(trend!.previousValue).toBe(200);
    // Headline stays the grain-anchored all-time total (300 + 200 = 500), not inflated.
    expect(lastValue()).toBe('500');
  });

  it('computes a fixed-period trend for a measure value field', () => {
    rowsHolder.current = salesRows;
    const widget = makeWidget(
      {
        kpiValueField: 'revenueMeasure',
        kpiTrend: true,
        kpiTrendFixedPeriod: 'month',
        kpiSparklineField: 'saleDate',
      },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      expressionFields: [revenueMeasure],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    // evaluateMeasure over the current window (100 + 200 = 300) vs previous (100 + 100 = 200).
    expect(trend!.delta).toBeCloseTo(0.5);
    expect(trend!.previousValue).toBe(200);
  });

  it('leaves a plain native field fixed-period trend unchanged', () => {
    rowsHolder.current = salesRows;
    const widget = makeWidget(
      {
        kpiValueField: 'amount',
        kpiAggregation: 'sum',
        kpiTrend: true,
        kpiTrendFixedPeriod: 'month',
        kpiSparklineField: 'saleDate',
      },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    expect(trend!.delta).toBeCloseTo(0.5);
    expect(trend!.previousValue).toBe(200);
  });

  it('computes a fieldless count fixed-period trend as a row-count ratio', () => {
    rowsHolder.current = salesRows;
    const widget = makeWidget(
      {
        kpiAggregation: 'count',
        kpiTrend: true,
        kpiTrendFixedPeriod: 'month',
        kpiSparklineField: 'saleDate',
      },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    // 2 rows in the current window vs 2 in the previous → 0% change.
    expect(trend!.delta).toBe(0);
    expect(trend!.previousValue).toBe(2);
  });

  it('computes a filter-based trend for a cross-source value field', () => {
    // useWidgetRows returns the current-window child rows (as the pipeline would after
    // applying the active date filter); the full child set lives on dataSource.rows so
    // the previous-period resolveRows can re-window it.
    rowsHolder.current = currentWindowItems;
    const dateFilter: StudioFilterState = {
      id: 'f-date',
      field: 'oiDate',
      fieldType: 'date',
      scope: { kind: 'widget', widgetId: 'kpi-1' },
      operator: 'between',
      value: { from: '2026-06-07', to: '2026-07-07' },
    } as unknown as StudioFilterState;
    const widget = makeWidget(
      {
        kpiValueField: 'revenue',
        kpiAggregation: 'sum',
        kpiTrend: true,
      },
      'order_items',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: {
        order_items: { ...orderItemsSource, rows: allOrderItems } as StudioDataSource,
        orders: ordersSource,
      },
      relationships: [crossSourceRelationship],
      filters: [dateFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, { ...orderItemsSource, rows: allOrderItems } as StudioDataSource);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    // Headline (current window → O1 = 300) vs previous window (O2 = 200): +50%.
    expect(trend!.delta).toBeCloseTo(0.5);
    expect(trend!.previousValue).toBe(200);
  });
});
