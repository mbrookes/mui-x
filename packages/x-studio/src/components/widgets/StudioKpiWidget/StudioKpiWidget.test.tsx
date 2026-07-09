import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
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
import type { KpiSparklineProps } from './KpiSparkline';
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
const sparklineSpy = vi.fn();
function SparklineSpy(props: KpiSparklineProps) {
  sparklineSpy(props);
  return null;
}

function lastTrend(): KpiTrendProps['trendResult'] {
  return trendSpy.mock.calls.at(-1)?.[0] ?? null;
}
function lastValue(): string | undefined {
  return valueSpy.mock.calls.at(-1)?.[0];
}
function lastSparkline(): KpiSparklineProps | undefined {
  return sparklineSpy.mock.calls.at(-1)?.[0];
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
        slots={{ trend: TrendSpy, value: ValueSpy, sparkline: SparklineSpy }}
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
    sparklineSpy.mockClear();
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

  it('computes a fixed-period trend when the date field lives on a related (cross-source) source (finding 2.8)', () => {
    // KPI on order_items; BOTH the value (`orders.revenue`) and the fixed-period DATE
    // field (`orders.orderDate`) live on the parent `orders` source, the date selected
    // via kpiSparklineSourceId. `orderDate` is NOT a column on the widget's own rows, so
    // reading it straight off currentRows (the pre-fix behavior) matched no rows and the
    // trend silently degenerated to null. The fix resolves the date field against the
    // related source (re-anchoring to the orders grain, bringing revenue along) so both
    // are present, then reduces without a second grain-anchor pass.
    const itemsSource = {
      id: 'order_items',
      label: 'Order items',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'orderId', label: 'Order', type: 'string' },
      ],
      rows: [],
    } as unknown as StudioDataSource;
    const ordersWithDate = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'orderDate', label: 'Order date', type: 'date' },
        { id: 'revenue', label: 'Revenue', type: 'number' },
      ],
      rows: [
        { id: 'O1', orderDate: '2026-07-01', revenue: 300 }, // current window
        { id: 'O2', orderDate: '2026-05-20', revenue: 200 }, // previous window
      ],
    } as unknown as StudioDataSource;
    const items = [
      { id: 'oi1', orderId: 'O1' },
      { id: 'oi2', orderId: 'O1' },
      { id: 'oi3', orderId: 'O2' },
      { id: 'oi4', orderId: 'O2' },
    ];
    rowsHolder.current = items;
    const widget = makeWidget(
      {
        kpiValueField: 'revenue',
        kpiAggregation: 'sum',
        kpiTrend: true,
        kpiTrendFixedPeriod: 'month',
        kpiSparklineField: 'orderDate',
        kpiSparklineSourceId: 'orders',
      },
      'order_items',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: {
        order_items: { ...itemsSource, rows: items } as StudioDataSource,
        orders: ordersWithDate,
      },
      relationships: [crossSourceRelationship],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, { ...itemsSource, rows: items } as StudioDataSource);

    const trend = lastTrend();
    // Pre-fix: null (orderDate absent on order_items rows → no rows matched either window).
    expect(trend).not.toBeNull();
    // Current window order (O1 revenue 300) vs previous window order (O2 revenue 200): +50%.
    expect(trend!.previousValue).toBe(200);
    expect(trend!.delta).toBeCloseTo(0.5);
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

  it("filter-based trend does NOT leak another page's filters into the previous period (finding 2.17)", () => {
    // Headline current-window rows (sum 300) come straight from useWidgetRows.
    rowsHolder.current = [
      { id: 'c1', amount: 100, saleDate: '2026-07-01', region: 'A' },
      { id: 'c2', amount: 200, saleDate: '2026-07-02', region: 'B' },
    ];
    // The full row set the previous-period resolveRows re-windows over: one region-A
    // and one region-B row, both inside the previous window. If another page's
    // `region = A` filter leaked in (the pre-fix behavior, which partitioned the raw
    // filters array with no pageId check), the region-B row would be dropped and
    // previousValue would be 100 instead of the correct 200.
    const salesWithRegion = {
      id: 'sales',
      label: 'Sales',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number' },
        { id: 'saleDate', label: 'Date', type: 'date' },
        { id: 'region', label: 'Region', type: 'string' },
      ],
      rows: [
        { id: 'p1', amount: 100, saleDate: '2026-05-20', region: 'A' },
        { id: 'p2', amount: 100, saleDate: '2026-05-25', region: 'B' },
      ],
    } as unknown as StudioDataSource;

    // Date filter on THIS widget's page defines the current period.
    const dateFilter: StudioFilterState = {
      id: 'f-date',
      field: 'saleDate',
      fieldType: 'date',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'between',
      value: { from: '2026-06-07', to: '2026-07-07' },
    } as unknown as StudioFilterState;

    // A page filter that belongs to ANOTHER page — must never touch this widget's trend.
    const otherPageFilter: StudioFilterState = {
      id: 'f-other-page',
      field: 'region',
      fieldType: 'string',
      scope: { kind: 'page', pageId: 'page-2' },
      operator: 'equals',
      value: 'A',
    } as unknown as StudioFilterState;

    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', kpiTrend: true },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesWithRegion },
      filters: [dateFilter, otherPageFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesWithRegion);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    // previousValue must be 200 (both previous-window rows), NOT 100 (region-A only).
    expect(trend!.previousValue).toBe(200);
    expect(trend!.delta).toBeCloseTo(0.5);
  });
});

// ─── finding 2.5: sparkline + filter tooltip must use widget-scoped filters ──────

describe('<StudioKpiWidget /> sparkline and filter-tooltip scoping (finding 2.5)', () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    sparklineSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not let another page's date filter drive the sparkline time field / granularity", () => {
    // Only a page-2-scoped date filter exists, on a field that isn't even present on
    // `sales` rows. Pre-fix, `findDateFilter` matched ANY `scope.kind === 'page'`
    // filter with no pageId check, so this widget (on page-1, with no
    // `kpiSparklineField` configured) would have resolved its time axis to
    // `otherDate` — producing an empty sparkline instead of the "no time field"
    // placeholder. Post-fix, `selectFiltersForWidget` excludes it (wrong pageId), so
    // no date filter applies and no time field is resolved.
    rowsHolder.current = [
      { id: 's1', amount: 100, saleDate: '2026-07-01' },
      { id: 's2', amount: 200, saleDate: '2026-07-02' },
    ];
    const otherPageFilter: StudioFilterState = {
      id: 'f-other-page',
      field: 'otherDate',
      fieldType: 'date',
      scope: { kind: 'page', pageId: 'page-2' },
      operator: 'greater_than_or_equal',
      value: '2020-01-01',
    } as unknown as StudioFilterState;
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', kpiSparkline: true },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [otherPageFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    const sparkline = lastSparkline();
    expect(sparkline?.timeFieldResolved).toBe(false);
    expect(sparkline?.data).toBeNull();
  });

  it('still resolves the sparkline time field from a date filter scoped to this widget’s page', () => {
    rowsHolder.current = [
      { id: 's1', amount: 100, saleDate: '2026-07-01' },
      { id: 's2', amount: 200, saleDate: '2026-07-15' },
    ];
    const pageFilter: StudioFilterState = {
      id: 'f-page-1',
      field: 'saleDate',
      fieldType: 'date',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'greater_than_or_equal',
      value: '2020-01-01',
    } as unknown as StudioFilterState;
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', kpiSparkline: true },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [pageFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    const sparkline = lastSparkline();
    expect(sparkline?.timeFieldResolved).toBe(true);
    expect(sparkline?.data).not.toBeNull();
  });

  it('ignores a disabled date filter when resolving the sparkline time field', () => {
    rowsHolder.current = [
      { id: 's1', amount: 100, saleDate: '2026-07-01' },
      { id: 's2', amount: 200, saleDate: '2026-07-02' },
    ];
    const disabledFilter: StudioFilterState = {
      id: 'f-disabled',
      field: 'otherDate',
      fieldType: 'date',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'greater_than_or_equal',
      value: '2020-01-01',
      disabled: true,
    } as unknown as StudioFilterState;
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', kpiSparkline: true },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [disabledFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    const sparkline = lastSparkline();
    expect(sparkline?.timeFieldResolved).toBe(false);
    expect(sparkline?.data).toBeNull();
  });

  it("does not leak another page's filter into the KPI hover tooltip", async () => {
    rowsHolder.current = [
      { id: 's1', amount: 100, saleDate: '2026-07-01' },
      { id: 's2', amount: 200, saleDate: '2026-07-02' },
    ];
    const otherPageFilter: StudioFilterState = {
      id: 'f-other-page',
      field: 'saleDate',
      fieldType: 'date',
      scope: { kind: 'page', pageId: 'page-2' },
      operator: 'greater_than_or_equal',
      value: '2020-01-01',
    } as unknown as StudioFilterState;
    const widget = makeWidget({ kpiValueField: 'amount', kpiAggregation: 'sum' }, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [otherPageFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    const { container, user } = renderKpi(widget, salesSource);
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);
    // filterSubtitle must be empty (the other page's filter is excluded), which
    // disables the tooltip's hover listener entirely — no tooltip should open.
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows this page’s filter in the KPI hover tooltip', async () => {
    rowsHolder.current = [
      { id: 's1', amount: 100, saleDate: '2026-07-01' },
      { id: 's2', amount: 200, saleDate: '2026-07-02' },
    ];
    const pageFilter: StudioFilterState = {
      id: 'f-page-1',
      field: 'saleDate',
      fieldType: 'date',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'greater_than_or_equal',
      value: '2020-01-01',
    } as unknown as StudioFilterState;
    const widget = makeWidget({ kpiValueField: 'amount', kpiAggregation: 'sum' }, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [pageFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    const { container, user } = renderKpi(widget, salesSource);
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Date');
  });
});

// ─── finding 2.6: KPI sparkline on a measure expression field ────────────────────

describe('<StudioKpiWidget /> sparkline on a measure expression field (finding 2.6)', () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    sparklineSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is not flat zero for a KPI configured on a measure field', () => {
    // salesRows: Jul (100+200=300), May (100+100=200), Jan (1000) — bucketed by month.
    // Pre-fix, `computeAggregate(bucketRows, 'revenueMeasure', 'sum')` read the
    // nonexistent `row['revenueMeasure']` and produced [0, 0, 0].
    rowsHolder.current = salesRows;
    const widget = makeWidget(
      {
        kpiValueField: 'revenueMeasure',
        kpiSparkline: true,
        kpiSparklineField: 'saleDate',
        kpiSparklineGranularity: 'month',
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

    const sparkline = lastSparkline();
    expect(sparkline?.data).not.toBeNull();
    expect(sparkline!.data!.some((v) => v !== 0)).toBe(true);
    // Chronological month buckets: Jan (1000), May (200), Jul (300).
    expect(sparkline!.data).toEqual([1000, 200, 300]);
  });

  it("propagates a measure field's format/currency to the sparkline tooltip formatting", () => {
    rowsHolder.current = salesRows;
    const formattedMeasure: StudioExpressionField = {
      ...revenueMeasure,
      format: 'currency',
      currencyCode: 'EUR',
    } as unknown as StudioExpressionField;
    const widget = makeWidget(
      {
        kpiValueField: 'revenueMeasure',
        kpiSparkline: true,
        kpiSparklineField: 'saleDate',
        kpiSparklineGranularity: 'month',
      },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      expressionFields: [formattedMeasure],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    const sparkline = lastSparkline();
    expect(sparkline?.fieldFormat).toBe('currency');
    expect(sparkline?.fieldCurrencyCode).toBe('EUR');
  });
});

// ─── finding 1.10: editing a measure formula must invalidate headline + sparkline ─

describe('<StudioKpiWidget /> measure formula edit busts the cached headline + sparkline (finding 1.10)', () => {
  beforeEach(() => {
    valueSpy.mockClear();
    sparklineSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('recomputes the headline and sparkline when only the measure formula changes (same rows reference)', () => {
    // The computed-value cache is keyed on (rows reference, string key). Measures are
    // deliberately excluded from row-identity invalidation, so editing a formula leaves
    // the rows reference untouched — only a content fingerprint in the cache KEY can bust
    // the stale entry. Reuse the SAME rows array across both renders so the module-level
    // WeakMap entry persists; without the fingerprint the second render serves the
    // pre-edit number for both the headline and the sparkline.
    const sharedRows = [
      { id: 'm1', amount: 100, saleDate: '2026-06-01' }, // Jun
      { id: 'm2', amount: 100, saleDate: '2026-07-01' },
      { id: 'm3', amount: 300, saleDate: '2026-07-15' }, // Jul
    ];
    rowsHolder.current = sharedRows;

    const baseConfig = {
      kpiValueField: 'measure-x',
      kpiCompact: false,
      kpiSparkline: true,
      kpiSparklineField: 'saleDate',
      kpiSparklineGranularity: 'month',
    };
    const sumMeasure = {
      id: 'measure-x',
      label: 'M',
      sourceId: 'sales',
      isMeasure: true,
      type: 'number',
      expression: { id: 'amount', aggregation: 'sum' },
    } as unknown as StudioExpressionField;

    const widgetSum = makeWidget(baseConfig, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widgetSum },
      dataSources: { sales: salesSource },
      expressionFields: [sumMeasure],
    });
    configureStudioContextMock({ getState: () => mockState });
    const view = renderKpi(widgetSum, salesSource);
    const sumValue = lastValue();
    const sumSpark = lastSparkline()?.data;
    view.unmount();

    valueSpy.mockClear();
    sparklineSpy.mockClear();

    // Edit the formula sum → avg (same measure id, same rows reference).
    const avgMeasure = {
      ...sumMeasure,
      expression: { id: 'amount', aggregation: 'avg' },
    } as unknown as StudioExpressionField;
    const widgetAvg = makeWidget(baseConfig, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widgetAvg },
      dataSources: { sales: salesSource },
      expressionFields: [avgMeasure],
    });
    configureStudioContextMock({ getState: () => mockState });
    renderKpi(widgetAvg, salesSource);
    const avgValue = lastValue();
    const avgSpark = lastSparkline()?.data;

    // Headline: sum (500) vs avg (500 / 3 ≈ 166.67) — must differ (pre-fix: identical).
    expect(sumValue).toBeDefined();
    expect(avgValue).not.toBe(sumValue);
    // Sparkline: Jul bucket sum (400) vs avg (200) — must differ (pre-fix: identical).
    expect(sumSpark).toEqual([100, 400]);
    expect(avgSpark).toEqual([100, 200]);
    expect(avgSpark).not.toEqual(sumSpark);
  });
});
