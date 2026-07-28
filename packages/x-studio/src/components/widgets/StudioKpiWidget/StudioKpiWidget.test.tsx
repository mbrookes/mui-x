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
  getConfiguredStudioState,
} from '../../../../test/studioContextMock';
import { selectFiltersForWidget } from '../../../internals/filterScoping';
import { shouldApplyWidgetRankAtL3 } from '../../../internals/StudioPipeline';
import {
  StudioUIConfigContext,
  DEFAULT_STUDIO_LOCALE_TEXT,
} from '../../../internals/StudioUIConfigContext';
import type { KpiTrendProps } from './KpiTrend';
import type { KpiValueProps } from './KpiValue';
import type { KpiSparklineProps } from './KpiSparkline';
import { StudioKpiWidget } from './StudioKpiWidget';

// The KPI widget reads its current-period rows through useWidgetRows. Route the mock
// through a hoisted holder so each test can swap the fixture rows it returns.
// `effective` and `noChartCross` both default to mirroring `current` (so most tests, which
// don't care about the three baselines' distinction, are unaffected) — a test exercising the
// `crossFilterMode` resolution (finding 3.8 / the `'none'`-mode baseline rule) can set them
// independently to tell which one the widget actually picked.
const rowsHolder = vi.hoisted(() => ({
  current: [] as Record<string, unknown>[],
  effective: null as Record<string, unknown>[] | null,
  noChartCross: null as Record<string, unknown>[] | null,
  isLoading: false,
  // Simulates a DEFERRED render window: when set, `useWidgetRows` reports THIS filter set
  // (the snapshot the mocked rows were produced from) while the store's live `doc.filters`
  // already holds a newer one. Every KPI derivation must follow the rows, not the store.
  deferredFilters: null as unknown[] | null,
}));

vi.mock('../../../internals/useWidgetRows', () => ({
  useWidgetRows: (widget: StudioWidgetOf<'kpi'>, _dataSource: unknown, pageId: string) => {
    // The real `useWidgetRows` now also exposes the widget's resolved/scoped filter sets so the
    // KPI's L4 grain-anchoring consumes them from the SAME snapshot the rows came from (finding
    // 2.1). Derive them here from the configured mock state via the real scoping authority so the
    // anchor-filter tests still exercise store filters — the mocked rows stay fixture-driven.
    let filters: StudioFilterState[] = [];
    let crossFilterAllPages = false;
    try {
      const state = getConfiguredStudioState<StudioState>();
      filters = state?.doc?.filters ?? [];
      crossFilterAllPages = state?.doc?.dashboard?.crossFilterAllPages ?? false;
    } catch {
      filters = [];
    }
    // A deferred window: the rows (and therefore the resolved filter sets) lag the store.
    const snapshotFilters = (rowsHolder.deferredFilters as StudioFilterState[] | null) ?? filters;
    const base = {
      widgetId: widget.id,
      widgetSourceId: widget.sourceId,
      activePageId: pageId,
      crossFilterAllPages,
    } as const;
    return {
      filteredRowsNoCross: rowsHolder.current,
      // The `'none'`-mode baseline (ARCHITECTURE.md): page + widget + interactive, no
      // chart-click cross-filters. Distinct from `filteredRowsNoCross`, which also strips
      // interactive (filter-widget) selections.
      filteredRowsNoChartCross: rowsHolder.noChartCross ?? rowsHolder.current,
      effectiveRows: rowsHolder.effective ?? rowsHolder.current,
      isLoading: rowsHolder.isLoading,
      isError: false,
      errorMessage: undefined,
      resolvedFiltersAll: selectFiltersForWidget(snapshotFilters, { ...base, include: 'all' }),
      resolvedFiltersNoCross: selectFiltersForWidget(snapshotFilters, {
        ...base,
        include: 'no-cross',
      }),
      resolvedFiltersNoChartCross: selectFiltersForWidget(snapshotFilters, {
        ...base,
        include: 'no-chart-cross',
      }),
      // Mirrors the real hook: `selectFiltersForWidget` drops WIDGET-scoped rank filters unless
      // `includeWidgetRank` is set, and the two sets above are built without it — so they are
      // exposed separately and the KPI re-adds them (see `kpiScopedFilters`).
      widgetScopedRankFilters: snapshotFilters.filter(
        (f) =>
          !f.disabled &&
          f.scope?.kind === 'widget' &&
          f.scope.widgetId === widget.id &&
          (f.filterMode ?? 'condition') === 'rank',
      ),
    };
  },
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
  trendSpy(props.trendResult, props.needsDateFilter);
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
function lastTrendNeedsDateFilter(): boolean {
  return trendSpy.mock.calls.at(-1)?.[1] ?? false;
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
  globalCrossFilterMode?: 'cross-highlight' | 'cross-filter' | 'none';
}

function createState(overrides?: StateOverrides): StudioState {
  return {
    doc: {
      schemaVersion: 1,
      dashboard: {
        id: 'dashboard-1',
        title: 'Dashboard',
        activePageId: 'page-1',
        ...(overrides?.globalCrossFilterMode
          ? { globalCrossFilterMode: overrides.globalCrossFilterMode }
          : {}),
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

// File-level reset: only the deferred-window tests opt into a lagging filter snapshot, and
// `rowsHolder` is module state shared by every test in this file.
beforeEach(() => {
  rowsHolder.deferredFilters = null;
});

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
    // The fixed-period trend re-derives its own "all rows" baseline from the raw
    // `dataSource.rows` (T2-2), so — like the mocked `useWidgetRows`'s `rowsHolder.current`
    // above — the own-source dataSource must carry the full (unfiltered) row set here too.
    const orderItemsWithRows = { ...orderItemsSource, rows: allOrderItems } as StudioDataSource;
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { order_items: orderItemsWithRows, orders: ordersSource },
      relationships: [crossSourceRelationship],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, orderItemsWithRows);

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
    // See T2-2 comment above: the fixed-period trend's "all rows" baseline now comes from
    // `dataSource.rows`, so it must carry the full row set, matching `rowsHolder.current`.
    const salesWithRows = { ...salesSource, rows: salesRows } as StudioDataSource;
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesWithRows },
      expressionFields: [revenueMeasure],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesWithRows);

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
    // See T2-2 comment above: the fixed-period trend's "all rows" baseline now comes from
    // `dataSource.rows`, so it must carry the full row set, matching `rowsHolder.current`.
    const salesWithRows = { ...salesSource, rows: salesRows } as StudioDataSource;
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesWithRows },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesWithRows);

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
    // See T2-2 comment above: the fixed-period trend's "all rows" baseline now comes from
    // `dataSource.rows`, so it must carry the full row set, matching `rowsHolder.current`.
    const salesWithRows = { ...salesSource, rows: salesRows } as StudioDataSource;
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesWithRows },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesWithRows);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    // 2 rows in the current window vs 2 in the previous → 0% change.
    expect(trend!.delta).toBe(0);
    expect(trend!.previousValue).toBe(2);
  });

  it('produces a real percentage trend, not ∞/"New", when an active date filter also narrows currentRows (T2-2)', () => {
    // In production the active page date filter below would make `useWidgetRows` return
    // ONLY the current-window rows as `filteredRowsNoCross` — mimicked here (since
    // `useWidgetRows` is mocked in this file) by setting `rowsHolder.current` to just those
    // two rows. Pre-fix, the fixed-period branch fed this ALREADY date-narrowed set into
    // `computeFixedPeriodTrend`, so windowing it again by the fixed 30-day range left NOTHING
    // in the previous-period window (both rows already fall in the CURRENT window) —
    // `previousValue` collapsed to 0 and the badge pinned at a bogus ∞ delta despite the
    // underlying (unfiltered) data trending normally. The fix re-derives the trend's "all
    // rows" baseline from `dataSource.rows` with the date filter stripped out, so both
    // windows see their real rows again.
    rowsHolder.current = [
      { id: 's1', amount: 100, saleDate: '2026-07-01' },
      { id: 's2', amount: 200, saleDate: '2026-07-02' },
    ];
    const activeDateFilter: StudioFilterState = {
      id: 'f-date',
      field: 'saleDate',
      fieldType: 'date',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'between',
      value: { from: '2026-07-01', to: '2026-07-02' },
    } as unknown as StudioFilterState;
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
    const salesWithRows = { ...salesSource, rows: salesRows } as StudioDataSource;
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesWithRows },
      filters: [activeDateFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesWithRows);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    expect(Number.isFinite(trend!.delta)).toBe(true);
    // Current window (s1 + s2 = 300) vs previous window (s3 + s4 = 200): +50%, not ∞.
    expect(trend!.delta).toBeCloseTo(0.5);
    expect(trend!.previousValue).toBe(200);
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

  it('filter-based trend re-applies an active Top-N rank filter to the previous period (finding 1)', () => {
    // Full dataset spans both the current and previous window, across two reps.
    // Current window: rep A totals 150 (100 + 50), rep B totals 30 — rep A ranks #1.
    // Previous window: rep A totals 20, rep B totals 300 (200 + 100) — rep B ranks #1.
    // A correct Top-1-by-rep rank filter therefore selects a DIFFERENT rep in each
    // window, so the previous-period value must be computed by re-applying the rank
    // reduction to the previous window's OWN rows, not by reusing the current window's
    // winning rep or dropping the rank filter entirely.
    const salesWithRep = {
      id: 'sales',
      label: 'Sales',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number' },
        { id: 'saleDate', label: 'Date', type: 'date' },
        { id: 'rep', label: 'Rep', type: 'string' },
      ],
      rows: [
        { id: 'c1', rep: 'A', amount: 100, saleDate: '2026-07-01' },
        { id: 'c2', rep: 'A', amount: 50, saleDate: '2026-07-02' },
        { id: 'c3', rep: 'B', amount: 30, saleDate: '2026-07-03' },
        { id: 'p1', rep: 'A', amount: 20, saleDate: '2026-05-20' },
        { id: 'p2', rep: 'B', amount: 200, saleDate: '2026-05-21' },
        { id: 'p3', rep: 'B', amount: 100, saleDate: '2026-05-22' },
      ],
    } as unknown as StudioDataSource;

    // The current-period rows the real L3 pipeline would produce: the date filter keeps
    // only the current-window rows, and the rank filter then keeps only rep A's rows
    // (150 > 30) — mirrored here since `useWidgetRows` is mocked.
    rowsHolder.current = [
      { id: 'c1', rep: 'A', amount: 100, saleDate: '2026-07-01' },
      { id: 'c2', rep: 'A', amount: 50, saleDate: '2026-07-02' },
    ];

    const dateFilter: StudioFilterState = {
      id: 'f-date',
      field: 'saleDate',
      fieldType: 'date',
      scope: { kind: 'widget', widgetId: 'kpi-1' },
      operator: 'between',
      value: { from: '2026-06-07', to: '2026-07-07' },
    } as unknown as StudioFilterState;
    const rankFilter: StudioFilterState = {
      id: 'f-rank',
      field: 'rep',
      fieldType: 'string',
      scope: { kind: 'widget', widgetId: 'kpi-1' },
      filterMode: 'rank',
      rankDirection: 'top',
      rankByField: 'amount',
      value: 1,
    } as unknown as StudioFilterState;

    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', kpiTrend: true },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesWithRep },
      filters: [dateFilter, rankFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesWithRep);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    // Headline (current window, rank-filtered to rep A) = 150.
    expect(lastValue()).toBe('150');
    // Previous period, independently rank-filtered to its own #1 rep (rep B) = 300 —
    // NOT 320 (both reps, unranked) and NOT 20 (rep A carried over from the current window).
    expect(trend!.previousValue).toBe(300);
    expect(trend!.delta).toBeCloseTo((150 - 300) / 300);
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

  it("still resolves the sparkline time field from a date filter scoped to this widget's page", () => {
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
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);
    // filterSubtitle must be empty (the other page's filter is excluded), which
    // disables the tooltip's hover listener entirely — no tooltip should open.
    //
    // This MUST wait. MUI's `Tooltip` has a 100ms default `enterDelay`, so a synchronous
    // `queryByRole('tooltip')` right after `hover` returns `null` whether or not the leak is
    // present — the assertion could never fail, making this test vacuous. `findByRole`
    // rejecting after a budget that comfortably exceeds the delay (and which the positive
    // counterpart below resolves well within) is what actually pins the leak.
    await expect(screen.findByRole('tooltip', {}, { timeout: 500 })).rejects.toThrow();
  });

  // M6: the "which filters are applied" subtitle used to be pointer-only — without
  // `describeChild` MUI attached the text as `aria-label` on a roleless `<span>`, which
  // assistive technology ignores (a generic element takes no name from the author).
  it('exposes the filter subtitle as a description, without hovering', () => {
    rowsHolder.current = [{ id: 's1', amount: 100, saleDate: '2026-07-01' }];
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

    const { container } = renderKpi(widget, salesSource);
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    expect(wrapperSpan.getAttribute('title')).toContain('Date');
    // Not a NAME: `aria-label` on a roleless span is ignored by assistive technology, which
    // is exactly how this text used to be exposed.
    expect(wrapperSpan.getAttribute('aria-label')).toBe(null);
    // And NOT a tab stop: a roleless focusable element is its own barrier
    // (`jsx-a11y/no-noninteractive-tabindex`) — the description is what carries the fix.
    expect(wrapperSpan.getAttribute('tabindex')).toBe(null);
  });

  it('adds no title when there are no filters to explain', () => {
    rowsHolder.current = [{ id: 's1', amount: 100, saleDate: '2026-07-01' }];
    const widget = makeWidget({ kpiValueField: 'amount', kpiAggregation: 'sum' }, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    const { container } = renderKpi(widget, salesSource);
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    expect(wrapperSpan.getAttribute('title')).toBe(null);
  });

  it("shows this page's filter in the KPI hover tooltip", async () => {
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
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Date');
  });

  it('finding 2.5: threads crossFilterAllPages into the hover subtitle so a cross-page cross-filter appears (5th call site, matching the other 4)', async () => {
    // A cross-filter emitted by a widget on ANOTHER page (page-2). With the dashboard
    // "cross-filter across all pages" toggle on, `useWidgetRows` already narrows the
    // KPI's rendered headline by this filter — the hover subtitle listing "which
    // filters apply" must agree, exactly as the other 4 `selectFiltersForWidget` call
    // sites in this file already do (fixed in iteration 9).
    rowsHolder.current = salesRows;
    const crossPageCrossFilter: StudioFilterState = {
      id: 'f-cross-amount',
      field: 'amount',
      fieldType: 'number',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-2' },
      operator: 'greater_than',
      value: 50,
    } as unknown as StudioFilterState;
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', crossFilterMode: 'cross-filter' },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [crossPageCrossFilter],
    });
    mockState.doc.dashboard.crossFilterAllPages = true;
    configureStudioContextMock({ getState: () => mockState });

    const { container, user } = renderKpi(widget, salesSource);
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);

    // Before the fix, `crossFilterAllPages` was never passed to this call site, so
    // `selectFiltersForWidget` defaulted it to `false` and excluded the page-2
    // cross-filter (`sv2.pageId !== activePageId`) — `filterSubtitle` was `''`, which
    // disables the tooltip's hover listener entirely, and no tooltip would open.
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Amount');
  });

  it('finding 2.5: does NOT show a cross-page cross-filter in the hover subtitle when crossFilterAllPages is off (contrast case)', async () => {
    rowsHolder.current = salesRows;
    const crossPageCrossFilter: StudioFilterState = {
      id: 'f-cross-amount',
      field: 'amount',
      fieldType: 'number',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-2' },
      operator: 'greater_than',
      value: 50,
    } as unknown as StudioFilterState;
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', crossFilterMode: 'cross-filter' },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [crossPageCrossFilter],
    });
    mockState.doc.dashboard.crossFilterAllPages = false;
    configureStudioContextMock({ getState: () => mockState });

    const { container, user } = renderKpi(widget, salesSource);
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);
    // With the toggle off, the cross-page filter is excluded, so `filterSubtitle` is
    // '' and the tooltip's hover listener stays disabled — no tooltip opens.
    //
    // Waited for the same reason as the sibling negative case above: a synchronous
    // `queryByRole('tooltip')` cannot fail through MUI's 100ms `enterDelay`.
    await expect(screen.findByRole('tooltip', {}, { timeout: 500 })).rejects.toThrow();
  });

  it('finding 2.5: routes the hover subtitle text through summarizeFilter with the active localeText (no locale bypass)', async () => {
    // A `selection`-mode filter with an empty `value` array summarizes via the
    // `filterSummaryAnyValue` locale token. Overriding it through
    // `StudioUIConfigContext` and asserting the override appears verbatim in the
    // tooltip proves the subtitle is routed through the active `localeText` rather
    // than always rendering `summarizeFilter`'s English default.
    rowsHolder.current = [
      { id: 's1', amount: 100, saleDate: '2026-07-01' },
      { id: 's2', amount: 200, saleDate: '2026-07-02' },
    ];
    const selectionFilter: StudioFilterState = {
      id: 'f-selection',
      field: 'amount',
      filterMode: 'selection',
      operator: 'in',
      value: [],
      scope: { kind: 'page', pageId: 'page-1' },
    } as unknown as StudioFilterState;
    const widget = makeWidget({ kpiValueField: 'amount', kpiAggregation: 'sum' }, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [selectionFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    const CUSTOM_ANY_VALUE_TEXT = 'CUALQUIER VALOR';
    const { container, user } = render(
      <ThemeProvider theme={createTheme()}>
        <StudioUIConfigContext.Provider
          value={{
            tableSourceMode: 'explicit',
            featureFlags: {},
            localeText: {
              ...DEFAULT_STUDIO_LOCALE_TEXT,
              filterSummaryAnyValue: CUSTOM_ANY_VALUE_TEXT,
            },
          }}
        >
          <StudioKpiWidget
            widget={widget}
            dataSource={salesSource}
            pageId="page-1"
            slots={{ trend: TrendSpy, value: ValueSpy, sparkline: SparklineSpy }}
          />
        </StudioUIConfigContext.Provider>
      </ThemeProvider>,
    );
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);

    // Before the fix, `summarizeFilter(f)` was called with no `localeText` argument, so
    // it always fell back to `DEFAULT_STUDIO_LOCALE_TEXT`'s English 'any value' text
    // regardless of the active locale.
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain(CUSTOM_ANY_VALUE_TEXT);
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
    // The period axis is dense: one entry per month from the first populated bucket to the
    // last, with the months that hold no rows at all (Feb–Apr, Jun) emitted as `null` gaps
    // rather than dropped, so the uniformly spaced points keep their true time spacing.
    expect(sparkline!.data).toEqual([1000, null, null, null, 200, null, 300]);
    // The populated buckets carry real measure values. Asserted separately from the shape
    // above because a `null` is not a measurement: a series of gaps, or one collapsed to
    // zero by `computeAggregate` reading a nonexistent `row['revenueMeasure']`, must both
    // fail here — only `evaluateMeasure` running per bucket produces these.
    expect(sparkline!.data!.filter((v) => v !== null)).toEqual([1000, 200, 300]);
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

describe("<StudioKpiWidget /> crossFilterMode resolution and the 'none'-mode baseline (finding 3.8 / HIGH 2)", () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    sparklineSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Reset so later tests (which never set these) keep the default
    // "mirrors `.current`" behaviour other describe blocks rely on.
    rowsHolder.effective = null;
    rowsHolder.noChartCross = null;
  });

  it("a dashboard-wide globalCrossFilterMode overrides the widget's own 'none' setting, matching every other widget kind's precedence", () => {
    // The 'none' baseline sums to 100; `effectiveRows` (what a global override should route
    // to) sums to 999. Pre-fix, the KPI's local `crossFilterMode` resolution ignored
    // `globalCrossFilterMode` entirely and always used the 'none' baseline here, regardless
    // of the dashboard-wide toggle.
    rowsHolder.current = [{ id: 's1', amount: 100, saleDate: '2026-07-01' }];
    rowsHolder.effective = [{ id: 's2', amount: 999, saleDate: '2026-07-01' }];
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', crossFilterMode: 'none' },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      globalCrossFilterMode: 'cross-filter',
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    expect(lastValue()).toBe('999');
  });

  it("keeps the widget's own 'none' setting (grand total) when there is no global override", () => {
    rowsHolder.current = [{ id: 's1', amount: 100, saleDate: '2026-07-01' }];
    rowsHolder.effective = [{ id: 's2', amount: 999, saleDate: '2026-07-01' }];
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', crossFilterMode: 'none' },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    expect(lastValue()).toBe('100');
  });

  // ── The `'none'`-mode baseline rule (ARCHITECTURE.md) ──────────────────────────────────
  // `'none'` suppresses CHART-CLICK cross-filters only. An interactive (filter-widget)
  // selection is an explicit user control and always hard-filters, so the `'none'` baseline
  // is `filteredRowsNoChartCross` — never `filteredRowsNoCross`, which also strips
  // interactive selections. The KPI used to read `filteredRowsNoCross` (and pair it with
  // `resolvedFiltersNoCross`), so a page whose Filter widget was set to "West" showed West in
  // the chart / grid / map / pivot while the KPI kept reporting the all-region total.

  it("in 'none' mode reads the no-chart-cross baseline, so a filter-widget selection still applies", () => {
    // Three distinguishable baselines: `filteredRowsNoCross` → 100, `filteredRowsNoChartCross`
    // → 42, `effectiveRows` → 999. Only the middle one is correct in 'none' mode.
    rowsHolder.current = [{ id: 's1', amount: 100, saleDate: '2026-07-01' }];
    rowsHolder.noChartCross = [{ id: 's2', amount: 42, saleDate: '2026-07-01' }];
    rowsHolder.effective = [{ id: 's3', amount: 999, saleDate: '2026-07-01' }];
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', crossFilterMode: 'none' },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    expect(lastValue()).toBe('42');
  });

  it("applies the same baseline for a KPI with no crossFilterMode at all (the 'none' default createDefaultWidget writes)", () => {
    rowsHolder.current = [{ id: 's1', amount: 100, saleDate: '2026-07-01' }];
    rowsHolder.noChartCross = [{ id: 's2', amount: 42, saleDate: '2026-07-01' }];
    rowsHolder.effective = [{ id: 's3', amount: 999, saleDate: '2026-07-01' }];
    const widget = makeWidget({ kpiValueField: 'amount', kpiAggregation: 'sum' }, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    expect(lastValue()).toBe('42');
  });

  it("pairs 'none'-mode rows with the no-chart-cross FILTER set, so a filter-widget selection is listed in the hover subtitle", async () => {
    // Level 3 of the baseline rule: the filter set handed to L4 must match the rows. Pre-fix
    // `kpiScopedFilters` used `resolvedFiltersNoCross`, which drops interactive filters — so
    // the subtitle both under-reported and (at L4) re-anchored against a set the rows did not
    // come from.
    rowsHolder.current = salesRows;
    const interactiveFilter: StudioFilterState = {
      id: 'f-interactive',
      field: 'amount',
      fieldType: 'number',
      scope: { kind: 'interactive', sourceWidgetId: 'other-widget', pageId: 'page-1' },
      operator: 'greater_than',
      value: 50,
    } as unknown as StudioFilterState;
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', crossFilterMode: 'none' },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [interactiveFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    const { container, user } = renderKpi(widget, salesSource);
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Amount');
  });

  it('no longer renders the hover-only "ignoring filters" indicator, because nothing is ignored any more', () => {
    // The `kpiGrandTotalTooltip` info icon existed only to explain the bug above, and it was
    // reachable by pointer hover alone (an `aria-hidden`, non-focusable MUI icon — M6). With
    // interactive filters honoured there is nothing left for it to explain.
    rowsHolder.current = [{ id: 's1', amount: 100, saleDate: '2026-07-01' }];
    const interactiveFilter: StudioFilterState = {
      id: 'f-interactive',
      field: 'amount',
      fieldType: 'number',
      scope: { kind: 'interactive', sourceWidgetId: 'other-widget', pageId: 'page-1' },
      operator: 'greater_than',
      value: 50,
    } as unknown as StudioFilterState;
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', crossFilterMode: 'none' },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [interactiveFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesSource);

    expect(screen.queryByTestId('InfoOutlinedIcon')).toBe(null);
  });
});

// ─── finding 1.2: KPI L4 anchor-filter re-application ────────────────────────────
//
// All four `resolveChartRowsForAggregation` call sites in StudioKpiWidget.tsx previously
// omitted the trailing `widgetFilters` argument, so a page/widget filter scoped to the
// anchor (or M:N remote-endpoint) source was enforced by L3's semi-join only — the L4
// re-anchoring join then read every one of a surviving widget row's anchor rows straight
// from the unfiltered store, resurrecting rows the filter excluded. Each sub-test below
// exercises one call site and asserts the anchor-filtered (not resurrected) result.
describe('<StudioKpiWidget /> KPI L4 anchor-filter re-application (finding 1.2)', () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    sparklineSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('scopes the headline value to the anchor-filtered rows (useKpiGrainAnchoredRows, call site 2)', () => {
    // Widget on `customers` (the "one" side); value field `total` owned by `orders` (the
    // "many" side) — the topology `useKpiGrainAnchoredRows` actually anchors (doc note D.1).
    // Customer C1 has two orders, one paid and one unpaid. The mocked `useWidgetRows`
    // returns C1's row unconditionally, mirroring what L3's semi-join would keep (C1 has
    // >= 1 matching order). Pre-fix, the L4 re-anchoring join read BOTH of C1's orders
    // straight from the unfiltered store — summing 500 (300 + 200) instead of the correct
    // paid-only 300.
    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [{ id: 'id', label: 'ID', type: 'string' }],
      rows: [],
    } as unknown as StudioDataSource;
    const ordersWithStatus: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'customerId', label: 'Customer', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
        { id: 'status', label: 'Status', type: 'string' },
      ],
      rows: [
        { id: 'O1', customerId: 'C1', total: 300, status: 'paid' },
        { id: 'O2', customerId: 'C1', total: 200, status: 'unpaid' },
      ],
    } as unknown as StudioDataSource;
    const customerOrdersRelationship: StudioRelationship = {
      id: 'rel-customer-orders',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    } as unknown as StudioRelationship;
    const paidStatusFilter: StudioFilterState = {
      id: 'f-status',
      field: 'status',
      filterSourceId: 'orders',
      fieldType: 'string',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'equals',
      value: 'paid',
    } as unknown as StudioFilterState;

    rowsHolder.current = [{ id: 'C1' }];
    const widget = makeWidget({ kpiValueField: 'total', kpiAggregation: 'sum' }, 'customers');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { customers: customersSource, orders: ordersWithStatus },
      relationships: [customerOrdersRelationship],
      filters: [paidStatusFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, customersSource);

    expect(lastValue()).toBe('300');
  });

  it('scopes a fixed-period trend delta to the anchor-filtered rows (computePeriodValue, call site 1)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T12:00:00Z'));

    // Same cross-source fixture as the "fixed-period trend for a cross-source (parent)
    // value field" test above, plus a `status` field on `orders` and a page filter scoped
    // to it. Current-window items point at O1 (paid); previous-window items point at O2
    // (unpaid). `kpiSparklineField: 'oiDate'` is native to `order_items`, keeping this off
    // the cross-source-date branch (call site 4) tested separately below.
    const ordersWithStatus: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'revenue', label: 'Revenue', type: 'number' },
        { id: 'status', label: 'Status', type: 'string' },
      ],
      rows: [
        { id: 'O1', revenue: 300, status: 'paid' },
        { id: 'O2', revenue: 200, status: 'unpaid' },
      ],
    } as unknown as StudioDataSource;
    const paidStatusFilter: StudioFilterState = {
      id: 'f-status',
      field: 'status',
      filterSourceId: 'orders',
      fieldType: 'string',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'equals',
      value: 'paid',
    } as unknown as StudioFilterState;

    rowsHolder.current = allOrderItems;
    // See T2-2: the fixed-period trend's "all rows" baseline now comes from
    // `dataSource.rows`, so the own-source (order_items) dataSource must carry the full
    // row set, matching `rowsHolder.current`.
    const orderItemsWithRows = { ...orderItemsSource, rows: allOrderItems } as StudioDataSource;
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
      dataSources: { order_items: orderItemsWithRows, orders: ordersWithStatus },
      relationships: [crossSourceRelationship],
      filters: [paidStatusFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, orderItemsWithRows);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    // Pre-fix: previousValue was 200 (O2's unpaid revenue resurrected by the unfiltered
    // anchor join). Post-fix: O2 is excluded by the anchor-scoped status filter, so the
    // previous period has no matching anchor rows at all.
    expect(trend!.previousValue).toBe(0);
    expect(trend!.delta).toBe(Infinity);
    // Headline stays the grain-anchored, anchor-filtered all-time total: only O1 (300).
    expect(lastValue()).toBe('300');
  });

  it('scopes a fixed-period trend delta to the anchor-filtered rows when the date field is cross-source (call site 4)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T12:00:00Z'));

    // Same cross-source-date fixture as the "finding 2.8" test above, plus a `status`
    // field on `orders` and a page filter scoped to it.
    const itemsSource = {
      id: 'order_items',
      label: 'Order items',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'orderId', label: 'Order', type: 'string' },
      ],
      rows: [],
    } as unknown as StudioDataSource;
    const ordersWithDateAndStatus = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'orderDate', label: 'Order date', type: 'date' },
        { id: 'revenue', label: 'Revenue', type: 'number' },
        { id: 'status', label: 'Status', type: 'string' },
      ],
      rows: [
        { id: 'O1', orderDate: '2026-07-01', revenue: 300, status: 'paid' }, // current window
        { id: 'O2', orderDate: '2026-05-20', revenue: 200, status: 'unpaid' }, // previous window
      ],
    } as unknown as StudioDataSource;
    const items = [
      { id: 'oi1', orderId: 'O1' },
      { id: 'oi2', orderId: 'O1' },
      { id: 'oi3', orderId: 'O2' },
      { id: 'oi4', orderId: 'O2' },
    ];
    const paidStatusFilter: StudioFilterState = {
      id: 'f-status',
      field: 'status',
      filterSourceId: 'orders',
      fieldType: 'string',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'equals',
      value: 'paid',
    } as unknown as StudioFilterState;

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
        orders: ordersWithDateAndStatus,
      },
      relationships: [crossSourceRelationship],
      filters: [paidStatusFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, { ...itemsSource, rows: items } as StudioDataSource);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    // Pre-fix: previousValue was 200 (O2's unpaid revenue resurrected before date
    // windowing even runs). Post-fix: O2 is excluded by the anchor-scoped status filter.
    expect(trend!.previousValue).toBe(0);
    expect(trend!.delta).toBe(Infinity);
    expect(lastValue()).toBe('300');
  });

  it('does not double-count a many-to-many sparkline dimension once the remote-endpoint filter is re-applied (call site 3)', () => {
    // Widget on `orders` with a NATIVE yField (`amount`), so the headline/trend value
    // paths are NOT grain-anchored (isGrainAnchored stays false — useKpiGrainAnchoredRows
    // never sees the sparkline's time field). The sparkline's own time field
    // (`createdDate`) lives on `tags`, reachable only via the M:N `order_tags` junction:
    // `analyzeChartSupport`'s widget-owned-measure branch anchors on the junction purely
    // to fan the dimension out (finding 1.1), which routes call site 3 through the M:N
    // branch of `resolveRowsAtGrain` — the branch that consults `remoteScopedFilters`
    // (finding 2.3), gated on the same `widgetFilters` argument this fix now threads.
    const ordersSourceNative: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number' },
      ],
      rows: [{ id: 'o1', amount: 50 }],
    } as unknown as StudioDataSource;
    const tagsSource: StudioDataSource = {
      id: 'tags',
      label: 'Tags',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'createdDate', label: 'Created', type: 'date' },
      ],
      rows: [
        { id: 't1', category: 'electronics', createdDate: '2026-07-01' },
        { id: 't2', category: 'books', createdDate: '2026-07-05' },
      ],
    } as unknown as StudioDataSource;
    const orderTagsSource: StudioDataSource = {
      id: 'order_tags',
      label: 'Order Tags',
      fields: [
        { id: 'orderId', label: 'Order', type: 'string' },
        { id: 'tagId', label: 'Tag', type: 'string' },
      ],
      rows: [
        { orderId: 'o1', tagId: 't1' },
        { orderId: 'o1', tagId: 't2' },
      ],
    } as unknown as StudioDataSource;
    const orderTagsRelationship: StudioRelationship = {
      id: 'rel-order-tags',
      type: 'many-to-many',
      sourceId: 'orders',
      sourceField: 'id',
      targetId: 'tags',
      targetField: 'id',
      junctionSourceId: 'order_tags',
      junctionSourceField: 'orderId',
      junctionTargetField: 'tagId',
    } as unknown as StudioRelationship;
    const electronicsFilter: StudioFilterState = {
      id: 'f-category',
      field: 'category',
      filterSourceId: 'tags',
      fieldType: 'string',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'equals',
      value: 'electronics',
    } as unknown as StudioFilterState;

    rowsHolder.current = [{ id: 'o1', amount: 50 }];
    const widget = makeWidget(
      {
        kpiValueField: 'amount',
        kpiAggregation: 'sum',
        kpiSparkline: true,
        kpiSparklineField: 'createdDate',
        kpiSparklineSourceId: 'tags',
        kpiSparklineGranularity: 'month',
      },
      'orders',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { orders: ordersSourceNative, tags: tagsSource, order_tags: orderTagsSource },
      relationships: [orderTagsRelationship],
      filters: [electronicsFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, ordersSourceNative);

    const sparkline = lastSparkline();
    // Pre-fix: both tag links ('electronics' + 'books') survive the join, double-counting
    // the single order's amount into the same July bucket (50 + 50 = 100). Post-fix: the
    // 'books' link is dropped by the remote-endpoint-scoped filter before the join, so the
    // bucket reflects the order's amount exactly once.
    expect(sparkline?.data).toEqual([50]);
  });
});

// ─── finding 3: a widget's own Top-N rank filter must scope the fixed-period trend,
// the sparkline join, and the "filters applied" tooltip the same way it scopes the headline ──
//
// `selectFiltersForWidget` excludes a widget-scoped `filterMode: 'rank'` filter unless
// `includeWidgetRank: true` is passed (it otherwise assumes the chart post-aggregation
// re-rank path). The headline (via `useWidgetRows`) and the filter-based trend branch
// (see the "finding 1" describe block above) already pass the flag. The fixed-period
// trend, the sparkline's cross-source join, and the hover tooltip previously did not —
// so a KPI configured with a Top-N rank filter showed a headline scoped to the winning
// group but a fixed-period delta / sparkline / tooltip scoped to the WHOLE, unranked
// dataset.
describe('<StudioKpiWidget /> Top-N rank filter scoping for fixed-period trend, sparkline join, and tooltip (finding 3)', () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    sparklineSpy.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('scopes the fixed-period trend delta and the "filters applied" tooltip by the widget-scoped rank filter (matching the headline)', async () => {
    // Same cross-source-date fixture as "call site 4" above (order_items → orders), plus a
    // `region` field on `orders` and a Top-1-by-revenue rank filter instead of the status
    // condition filter. Only the top-1 region ('east', via O1's revenue of 300 > O2's 100)
    // should survive.
    const ordersWithRegion = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'orderDate', label: 'Order date', type: 'date' },
        { id: 'revenue', label: 'Revenue', type: 'number' },
        { id: 'region', label: 'Region', type: 'string' },
      ],
      rows: [
        { id: 'O1', orderDate: '2026-07-01', revenue: 300, region: 'east' }, // current window
        { id: 'O2', orderDate: '2026-05-20', revenue: 100, region: 'west' }, // previous window
      ],
    } as unknown as StudioDataSource;
    // `order_items` (the widget's own source) references BOTH orders — mirroring "call site
    // 4", this deliberately does NOT pre-narrow to the winning region so the assertions below
    // isolate the join/trend's OWN re-application of the rank filter, rather than piggy-backing
    // on rows already excluded elsewhere.
    const items = [
      { id: 'oi1', orderId: 'O1' },
      { id: 'oi2', orderId: 'O1' },
      { id: 'oi3', orderId: 'O2' },
      { id: 'oi4', orderId: 'O2' },
    ];
    const itemsSource = {
      id: 'order_items',
      label: 'Order items',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'orderId', label: 'Order', type: 'string' },
      ],
      rows: items,
    } as unknown as StudioDataSource;
    const rankFilter: StudioFilterState = {
      id: 'f-rank',
      field: 'region',
      filterSourceId: 'orders',
      fieldType: 'string',
      scope: { kind: 'widget', widgetId: 'kpi-1' },
      filterMode: 'rank',
      rankDirection: 'top',
      rankByField: 'revenue',
      value: 1,
    } as unknown as StudioFilterState;

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
      dataSources: { order_items: itemsSource, orders: ordersWithRegion },
      relationships: [crossSourceRelationship],
      filters: [rankFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    const { container, user } = renderKpi(widget, itemsSource);

    // Fixed-period trend (~899): the previous window's only order (O2, 'west') is excluded
    // by the rank filter before date-windowing even runs, so the previous period has NO
    // matching rows at all — 0, not 200 (what O2's own revenue would windowed to if the
    // rank filter were dropped, as it was pre-fix, matching "call site 4"'s own pattern).
    const trend = lastTrend();
    expect(trend).not.toBeNull();
    expect(trend!.previousValue).toBe(0);
    expect(trend!.delta).toBe(Infinity);

    // Filter tooltip (~1286): the rank filter must be listed as an applied filter, exactly
    // like the headline it's actually scoping.
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Region');
    expect(tooltip.textContent).toContain('Top 1');
  });

  it('scopes the cross-source sparkline join by the widget-scoped rank filter (matching the headline)', () => {
    // Same M:N fixture as "call site 3" above (orders → tags via order_tags), plus a
    // `priority` field on `tags` and a Top-1-by-priority rank filter instead of the
    // `category = 'electronics'` condition filter. The widget's own yField (`amount`) is
    // native, so `isGrainAnchored` stays false and the sparkline routes through the
    // cross-source join this fix threads `includeWidgetRank` into (~725), not through
    // `useKpiGrainAnchoredRows`.
    const ordersSourceNative: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number' },
      ],
      rows: [{ id: 'o1', amount: 50 }],
    } as unknown as StudioDataSource;
    const tagsSource: StudioDataSource = {
      id: 'tags',
      label: 'Tags',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'createdDate', label: 'Created', type: 'date' },
        { id: 'priority', label: 'Priority', type: 'number' },
      ],
      rows: [
        { id: 't1', category: 'electronics', createdDate: '2026-07-01', priority: 5 },
        { id: 't2', category: 'books', createdDate: '2026-07-05', priority: 1 },
      ],
    } as unknown as StudioDataSource;
    const orderTagsSource: StudioDataSource = {
      id: 'order_tags',
      label: 'Order Tags',
      fields: [
        { id: 'orderId', label: 'Order', type: 'string' },
        { id: 'tagId', label: 'Tag', type: 'string' },
      ],
      rows: [
        { orderId: 'o1', tagId: 't1' },
        { orderId: 'o1', tagId: 't2' },
      ],
    } as unknown as StudioDataSource;
    const orderTagsRelationship: StudioRelationship = {
      id: 'rel-order-tags',
      type: 'many-to-many',
      sourceId: 'orders',
      sourceField: 'id',
      targetId: 'tags',
      junctionSourceId: 'order_tags',
      junctionSourceField: 'orderId',
      junctionTargetField: 'tagId',
      targetField: 'id',
    } as unknown as StudioRelationship;
    const rankFilter: StudioFilterState = {
      id: 'f-rank',
      field: 'priority',
      filterSourceId: 'tags',
      fieldType: 'number',
      scope: { kind: 'widget', widgetId: 'kpi-1' },
      filterMode: 'rank',
      rankDirection: 'top',
      value: 1,
    } as unknown as StudioFilterState;

    rowsHolder.current = [{ id: 'o1', amount: 50 }];
    const widget = makeWidget(
      {
        kpiValueField: 'amount',
        kpiAggregation: 'sum',
        kpiSparkline: true,
        kpiSparklineField: 'createdDate',
        kpiSparklineSourceId: 'tags',
        kpiSparklineGranularity: 'month',
      },
      'orders',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { orders: ordersSourceNative, tags: tagsSource, order_tags: orderTagsSource },
      relationships: [orderTagsRelationship],
      filters: [rankFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, ordersSourceNative);

    const sparkline = lastSparkline();
    // Pre-fix: both tag links ('electronics' priority 5 + 'books' priority 1) survive the
    // join, double-counting the single order's amount into the same July bucket (50 + 50 =
    // 100). Post-fix: the rank filter keeps only the top-1-priority tag link ('electronics'),
    // matching the headline's own Top-N scope — the bucket reflects the order's amount once.
    expect(sparkline?.data).toEqual([50]);
  });

  it('derives the rank scoping from the shared L3 rule rather than a per-call-site constant', () => {
    // The four `selectFiltersForWidget` calls in `StudioKpiWidget.tsx` (previous-period trend,
    // sparkline, trend badge, "filters applied" tooltip) each used to hardcode
    // `includeWidgetRank: true`. The literal was correct, but nothing tied it to
    // `shouldApplyWidgetRankAtL3` — the helper `useWidgetRows` resolves the SAME flag from when
    // it produces the headline rows. Whoever gave the KPI a post-aggregation rank path (as the xy
    // chart families already have) would flip the helper and leave four stale `true`s behind,
    // double-reducing the trend/sparkline/tooltip against a headline that reduced once. This
    // asserts the composed rule the four call sites now share: for a KPI the helper says "apply
    // at L3", and under that answer a widget-scoped rank filter must SURVIVE the scoping pass —
    // which is precisely what the two behavioural tests above depend on.
    const kpiWidget = makeWidget({ kpiValueField: 'revenue' }, 'orders');
    expect(shouldApplyWidgetRankAtL3(kpiWidget)).toBe(true);

    const rankFilter = {
      id: 'f-rank',
      field: 'region',
      fieldType: 'string',
      scope: { kind: 'widget', widgetId: 'kpi-1' },
      filterMode: 'rank',
      rankDirection: 'top',
      rankByField: 'revenue',
      value: 1,
    } as unknown as StudioFilterState;
    const scoped = selectFiltersForWidget([rankFilter], {
      widgetId: kpiWidget.id,
      widgetSourceId: kpiWidget.sourceId,
      activePageId: 'page-1',
      include: 'all',
      includeWidgetRank: shouldApplyWidgetRankAtL3(kpiWidget),
    });
    expect(scoped.map((f) => f.id)).toEqual(['f-rank']);
  });
});

// ─── findings 1.3 / 2.1 / 2.2: KPI expression-field & cross-page filter scoping ───────
//
// The KPI previously subscribed to its OWN source's expression fields only
// (`makeSelectExpressionFieldsForSource(widget.sourceId)`) and never threaded the
// dashboard-level `crossFilterAllPages` toggle into its filter scoping. That defeated the
// iteration-8 `widgetFilters` fix for two shapes:
//   • an anchor/related/junction-owned EXPRESSION-field filter was invisible, so
//     `effectiveFilterSourceId` never classified it as anchor-scoped → it was not re-applied
//     at L4 (resurrection) or, once threaded, zeroed the KPI (findings 1.3, 2.1);
//   • a cross-page cross-filter (`crossFilterAllPages: true`) was excluded from the L4/trend
//     scope while `useWidgetRows` already applied it to the rendered rows (finding 2.2).
describe('<StudioKpiWidget /> expression-field & cross-page filter scoping (findings 1.3, 2.1, 2.2)', () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    sparklineSpy.mockClear();
    rowsHolder.effective = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    rowsHolder.effective = null;
  });

  // Widget on `customers` (the "one" side); value field `total` owned by `orders` (the "many"
  // side) — the grain-anchored topology `useKpiGrainAnchoredRows` re-anchors on (doc note D.1).
  const customersSource = {
    id: 'customers',
    label: 'Customers',
    fields: [{ id: 'id', label: 'ID', type: 'string' }],
    rows: [],
  } as unknown as StudioDataSource;
  const ordersWithTotal = {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'customerId', label: 'Customer', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
      { id: 'status', label: 'Status', type: 'string' },
    ],
    rows: [
      { id: 'O1', customerId: 'C1', total: 300, status: 'paid' },
      { id: 'O2', customerId: 'C1', total: 200, status: 'unpaid' },
    ],
  } as unknown as StudioDataSource;
  const customerOrdersRelationship = {
    id: 'rel-customer-orders',
    sourceId: 'orders',
    sourceField: 'customerId',
    targetId: 'customers',
    targetField: 'id',
    type: 'many-to-one',
  } as unknown as StudioRelationship;
  // `bigOrder = total > 250` — a calculated boolean owned by the ANCHOR source (`orders`).
  // O1 (300) → true, O2 (200) → false.
  const bigOrderExpr = {
    id: 'bigOrder',
    label: 'Big order',
    sourceId: 'orders',
    isMeasure: false,
    type: 'boolean',
    expression: {
      operator: 'greaterThan',
      inputs: [{ id: 'total' }, { type: 'number', value: 250 }],
    },
  } as unknown as StudioExpressionField;

  it('finding 1.3: re-applies an anchor-owned EXPRESSION-field filter to the headline (no resurrection)', () => {
    // The drawer filter targets the anchor-owned expression column `bigOrder` and carries NO
    // `filterSourceId` (the exact shape finding 1.3a is about). Pre-fix the KPI saw only
    // `customers` expression fields, so `bigOrder` was invisible → `effectiveFilterSourceId`
    // could not classify it as anchor-scoped → it was never re-applied during L4 re-anchoring →
    // the expansion join resurrected O2, summing 500. With own+related subscription the filter is
    // anchor-scoped and applied: only O1 (300) survives.
    const bigOrderFilter = {
      id: 'f-big',
      field: 'bigOrder',
      fieldType: 'boolean',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'equals',
      value: true,
      // NOTE: no filterSourceId — owner is derived from the expression-field list.
    } as unknown as StudioFilterState;

    rowsHolder.current = [{ id: 'C1' }];
    const widget = makeWidget({ kpiValueField: 'total', kpiAggregation: 'sum' }, 'customers');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { customers: customersSource, orders: ordersWithTotal },
      relationships: [customerOrdersRelationship],
      expressionFields: [bigOrderExpr],
      filters: [bigOrderFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, customersSource);

    // Pre-fix: 500 (O1 + O2 resurrected). Post-fix: only the big order O1.
    expect(lastValue()).toBe('300');
  });

  it('finding 1.3: an anchor-owned EXPRESSION-field filter yields a correct trend delta (no bogus ∞ against a resurrected previous period)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T12:00:00Z'));

    // Widget on `order_items`; value `revenue` owned by `orders`. `bigRevenue = revenue > 250`
    // is owned by the anchor (`orders`): O1 (300) → true, O2 (200) → false. Current-window items
    // point at O1 (kept), previous-window items point at O2 (excluded by the anchor expression
    // filter). Pre-fix the expression field was invisible on the own-source-only list, so O2 was
    // resurrected into the previous period (previousValue 200, delta +50%). Post-fix the previous
    // period has no surviving anchor rows.
    const ordersWithRevenue = {
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
    const bigRevenueExpr = {
      id: 'bigRevenue',
      label: 'Big revenue',
      sourceId: 'orders',
      isMeasure: false,
      type: 'boolean',
      expression: {
        operator: 'greaterThan',
        inputs: [{ id: 'revenue' }, { type: 'number', value: 250 }],
      },
    } as unknown as StudioExpressionField;
    const bigRevenueFilter = {
      id: 'f-bigrev',
      field: 'bigRevenue',
      fieldType: 'boolean',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'equals',
      value: true,
    } as unknown as StudioFilterState;

    rowsHolder.current = allOrderItems;
    // See T2-2: the fixed-period trend's "all rows" baseline now comes from
    // `dataSource.rows`, so the own-source (order_items) dataSource must carry the full
    // row set, matching `rowsHolder.current`.
    const orderItemsWithRows = { ...orderItemsSource, rows: allOrderItems } as StudioDataSource;
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
      dataSources: { order_items: orderItemsWithRows, orders: ordersWithRevenue },
      relationships: [crossSourceRelationship],
      expressionFields: [bigRevenueExpr],
      filters: [bigRevenueFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, orderItemsWithRows);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    // Pre-fix: previousValue 200 (O2 resurrected), delta +0.5. Post-fix: O2 excluded.
    expect(trend!.previousValue).toBe(0);
    expect(trend!.delta).toBe(Infinity);
    // Headline stays the anchor-filtered all-time total: only O1 (300).
    expect(lastValue()).toBe('300');
  });

  it('finding 2.1: re-applies a JUNCTION-owned expression-field filter to an M:N sparkline dimension', () => {
    // Widget on `orders` (native yField `amount`) with a many-to-many relationship to `tags` via
    // the `order_tags` junction. The sparkline's time field (`createdDate`) lives on `tags`, so
    // `analyzeChartSupport` anchors on the junction to fan the dimension out (finding 1.1). The
    // page filter targets `heavy` — an expression field owned by the JUNCTION source
    // (`order_tags`) — and carries NO `filterSourceId`. Pre-fix the junction was omitted from
    // `relevantSourceIds`, so `heavy` was invisible: the filter could be neither classified as
    // junction(anchor)-scoped nor evaluated (the junction rows were never enriched with it), so
    // both tag links survived and the single order's amount was double-counted (100). Including
    // the junction source makes `heavy` resolvable → the light link is dropped before the join.
    const ordersSourceNative = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number' },
      ],
      rows: [{ id: 'o1', amount: 50 }],
    } as unknown as StudioDataSource;
    const tagsSource = {
      id: 'tags',
      label: 'Tags',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'createdDate', label: 'Created', type: 'date' },
      ],
      rows: [
        { id: 't1', createdDate: '2026-07-01' },
        { id: 't2', createdDate: '2026-07-05' },
      ],
    } as unknown as StudioDataSource;
    const orderTagsSource = {
      id: 'order_tags',
      label: 'Order Tags',
      fields: [
        { id: 'orderId', label: 'Order', type: 'string' },
        { id: 'tagId', label: 'Tag', type: 'string' },
        { id: 'weight', label: 'Weight', type: 'number' },
      ],
      rows: [
        { orderId: 'o1', tagId: 't1', weight: 10 },
        { orderId: 'o1', tagId: 't2', weight: 1 },
      ],
    } as unknown as StudioDataSource;
    const orderTagsRelationship = {
      id: 'rel-order-tags',
      type: 'many-to-many',
      sourceId: 'orders',
      sourceField: 'id',
      targetId: 'tags',
      targetField: 'id',
      junctionSourceId: 'order_tags',
      junctionSourceField: 'orderId',
      junctionTargetField: 'tagId',
    } as unknown as StudioRelationship;
    // `heavy = weight > 5` — a calculated boolean owned by the JUNCTION source. The t1 link (10)
    // is heavy; the t2 link (1) is not.
    const heavyLinkExpr = {
      id: 'heavy',
      label: 'Heavy link',
      sourceId: 'order_tags',
      isMeasure: false,
      type: 'boolean',
      expression: {
        operator: 'greaterThan',
        inputs: [{ id: 'weight' }, { type: 'number', value: 5 }],
      },
    } as unknown as StudioExpressionField;
    const heavyFilter = {
      id: 'f-heavy',
      field: 'heavy',
      fieldType: 'boolean',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'equals',
      value: true,
      // NOTE: no filterSourceId — owner (`order_tags`) is derived from the expression-field list.
    } as unknown as StudioFilterState;

    rowsHolder.current = [{ id: 'o1', amount: 50 }];
    const widget = makeWidget(
      {
        kpiValueField: 'amount',
        kpiAggregation: 'sum',
        kpiSparkline: true,
        kpiSparklineField: 'createdDate',
        kpiSparklineSourceId: 'tags',
        kpiSparklineGranularity: 'month',
      },
      'orders',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { orders: ordersSourceNative, tags: tagsSource, order_tags: orderTagsSource },
      relationships: [orderTagsRelationship],
      expressionFields: [heavyLinkExpr],
      filters: [heavyFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, ordersSourceNative);

    const sparkline = lastSparkline();
    // Pre-fix: both links survive (junction filter unresolvable) → 50 + 50 = 100. Post-fix: the
    // light link is dropped, so the order's amount is counted exactly once.
    expect(sparkline?.data).toEqual([50]);
  });

  it('finding 2.2: threads crossFilterAllPages so a cross-page cross-filter scopes the grain-anchored headline', () => {
    // Widget on `customers`, value `total` owned by `orders`, in cross-filter mode. A chart on
    // ANOTHER page (page-2) emitted a cross-filter `orders.status = 'paid'`. With the dashboard
    // "cross-filter across all pages" toggle ON, `useWidgetRows` already applied it to the
    // rendered rows — the KPI's L4 re-anchoring must scope to it too, or the expansion join
    // resurrects the unpaid order. Pre-fix the KPI never passed `crossFilterAllPages`, so
    // `selectFiltersForWidget` defaulted it to false and excluded the page-2 cross-filter → 500.
    const crossPagePaidFilter = {
      id: 'f-cross-status',
      field: 'status',
      filterSourceId: 'orders',
      fieldType: 'string',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-2' },
      operator: 'equals',
      value: 'paid',
    } as unknown as StudioFilterState;

    rowsHolder.current = [{ id: 'C1' }];
    const widget = makeWidget(
      { kpiValueField: 'total', kpiAggregation: 'sum', crossFilterMode: 'cross-filter' },
      'customers',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { customers: customersSource, orders: ordersWithTotal },
      relationships: [customerOrdersRelationship],
      filters: [crossPagePaidFilter],
    });
    mockState.doc.dashboard.crossFilterAllPages = true;
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, customersSource);

    // Post-fix: the cross-page cross-filter is in scope → only the paid order O1 (300).
    expect(lastValue()).toBe('300');
  });

  it('finding 2.2: a cross-page cross-filter is correctly EXCLUDED when crossFilterAllPages is off', () => {
    // Same fixture, toggle OFF: the page-2 cross-filter must NOT reach this page's KPI, so the
    // grain-anchored headline is the unscoped all-time total (O1 + O2 = 500). This proves the KPI
    // actually reads the toggle rather than hard-coding either behaviour.
    const crossPagePaidFilter = {
      id: 'f-cross-status',
      field: 'status',
      filterSourceId: 'orders',
      fieldType: 'string',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-2' },
      operator: 'equals',
      value: 'paid',
    } as unknown as StudioFilterState;

    rowsHolder.current = [{ id: 'C1' }];
    const widget = makeWidget(
      { kpiValueField: 'total', kpiAggregation: 'sum', crossFilterMode: 'cross-filter' },
      'customers',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { customers: customersSource, orders: ordersWithTotal },
      relationships: [customerOrdersRelationship],
      filters: [crossPagePaidFilter],
    });
    mockState.doc.dashboard.crossFilterAllPages = false;
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, customersSource);

    expect(lastValue()).toBe('500');
  });
});

describe('<StudioKpiWidget /> loading affordance for a cold adapter fetch (finding 4)', () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    sparklineSpy.mockClear();
    rowsHolder.effective = null;
    rowsHolder.isLoading = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
    rowsHolder.effective = null;
    rowsHolder.isLoading = false;
  });

  // An adapter-backed source that hasn't produced any rows yet — the exact shape
  // `useAdapterRows` returns before its first fetch resolves.
  const adapterSource = {
    id: 'sales',
    label: 'Sales',
    fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
    adapter: { getRows: async () => ({ rows: [] }) },
  } as unknown as StudioDataSource;

  it('shows a loading placeholder instead of a confident "0" while isLoading and no rows have arrived', () => {
    rowsHolder.current = [];
    rowsHolder.isLoading = true;
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', kpiSparkline: true },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: adapterSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, adapterSource);

    // The value slot (KpiValue/ValueSpy) must NOT be rendered with a computed "0" —
    // instead a Skeleton placeholder takes its place until real rows arrive.
    expect(valueSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.MuiSkeleton-root')).not.toBeNull();
    // The sparkline must not render off of an empty/loading row set either.
    expect(sparklineSpy).not.toHaveBeenCalled();
  });

  it('renders the real computed value once rows have arrived (isLoading false)', () => {
    rowsHolder.current = [{ id: 's1', amount: 300 }];
    rowsHolder.isLoading = false;
    const widget = makeWidget({ kpiValueField: 'amount', kpiAggregation: 'sum' }, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: adapterSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, adapterSource);

    expect(lastValue()).toBe('300');
    expect(document.querySelector('.MuiSkeleton-root')).toBeNull();
  });

  it('does not show the loading skeleton once isLoading is false even with zero matching rows (genuine "no data")', () => {
    rowsHolder.current = [];
    rowsHolder.isLoading = false;
    const widget = makeWidget({ kpiValueField: 'amount', kpiAggregation: 'sum' }, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: adapterSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, adapterSource);

    expect(document.querySelector('.MuiSkeleton-root')).toBeNull();
    expect(lastValue()).toBe('0');
  });
});

// ─── M3: an unmeasurable period must not become a confident "−100%" ───────────
//
// `aggregateNumbers` returns `null` for avg/min/max over an empty set — the package's
// documented "null means not measured, not zero" policy. `computePeriodValue` used to
// coerce that to `0` at all three of its return points, and `computeFixedPeriodTrend` then
// divided: a KPI whose CURRENT fixed-period window contains no rows rendered a red "−100%"
// as if the average had collapsed, when the truth is that there is no current measurement
// at all. The filter-based path was already protected by the `hasData` gate; the
// fixed-period path windows independently of the headline, so it was not.
describe('<StudioKpiWidget /> unmeasurable trend periods (M3)', () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    sparklineSpy.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // "today" is 2026-07-07, so the 'month' fixed period is 2026-06-08 → 2026-07-07 and the
  // previous window is 2026-05-09 → 2026-06-07. These rows populate ONLY the previous one.
  const previousOnlyRows = [
    { id: 'r1', rating: 4, saleDate: '2026-05-20' },
    { id: 'r2', rating: 4.4, saleDate: '2026-05-21' },
  ];
  const ratingSource = {
    id: 'sales',
    label: 'Sales',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'rating', label: 'Rating', type: 'number' },
      { id: 'saleDate', label: 'Date', type: 'date' },
    ],
    rows: previousOnlyRows,
  } as unknown as StudioDataSource;

  it('renders NO trend badge for an avg KPI whose current fixed period has no rows (not "−100%")', () => {
    rowsHolder.current = previousOnlyRows;
    const widget = makeWidget(
      {
        kpiValueField: 'rating',
        kpiAggregation: 'avg',
        kpiTrend: true,
        kpiTrendFixedPeriod: 'month',
        kpiSparklineField: 'saleDate',
      },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: ratingSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, ratingSource);

    // Headline: avg over every row that exists → 4.2 (there IS a measurement overall).
    expect(lastValue()).toBe('4.2');
    // Trend: the current window is unmeasurable, so no delta can be stated. Before the fix
    // this was `(0 − 4.2) / 4.2 = −1`, rendered in red as a −100% collapse.
    expect(lastTrend()).toBeNull();
  });

  it('still renders a trend badge for a SUM KPI with an empty current period (0 is a real total)', () => {
    // Contrast case, so the M3 fix cannot be satisfied by suppressing every empty period:
    // `sum`/`count` over no rows IS a genuine measurement of zero, unlike avg/min/max.
    rowsHolder.current = previousOnlyRows;
    const widget = makeWidget(
      {
        kpiValueField: 'rating',
        kpiAggregation: 'sum',
        kpiTrend: true,
        kpiTrendFixedPeriod: 'month',
        kpiSparklineField: 'saleDate',
      },
      'sales',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: ratingSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, ratingSource);

    const trend = lastTrend();
    expect(trend).not.toBeNull();
    expect(trend!.delta).toBeCloseTo(-1);
    expect(trend!.previousValue).toBeCloseTo(8.4);
  });
});

// ─── M5: one canonical "which date field does this KPI use?" rule ─────────────
describe('<StudioKpiWidget /> canonical date-field resolution (M5)', () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    sparklineSpy.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // Repro 1 fixtures: a KPI on `customers` (the "one" side) with a page date filter on
  // `orders_d.orderDate` (the related "many" side). `customers` deliberately has NO date
  // field of its own, so nothing but the cross-source filter can resolve a time axis.
  const customerRows = [
    { id: 'C1', name: 'Ada' },
    { id: 'C2', name: 'Grace' },
  ];
  const customersSource = {
    id: 'customers',
    label: 'Customers',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'name', label: 'Name', type: 'string' },
    ],
    rows: customerRows,
  } as unknown as StudioDataSource;

  const datedOrdersSource = {
    id: 'orders_d',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'customerId', label: 'Customer', type: 'string' },
      { id: 'orderDate', label: 'Order Date', type: 'date' },
    ],
    rows: [
      { id: 'O1', customerId: 'C1', orderDate: '2026-05-10' },
      { id: 'O2', customerId: 'C2', orderDate: '2026-06-10' },
    ],
  } as unknown as StudioDataSource;

  const customerOrdersRelationship = {
    id: 'rel-cust',
    sourceId: 'customers',
    targetId: 'orders_d',
    sourceField: 'id',
    targetField: 'customerId',
    type: 'many-to-one',
  } as unknown as StudioRelationship;

  it('repro 1: resolves the sparkline time field from a date filter on a RELATED source', () => {
    // Pre-fix, `useKpiSparkline` accepted the date filter's field only when it was NATIVE to
    // the widget's source, so this fell through to an unset `kpiSparklineField` → `timeField`
    // null → no sparkline at all. Meanwhile `KpiSparklineOptions` matched the very same filter
    // (it scans own + joined date fields), hid the Time-field picker and announced "Using the
    // date filter on Order Date" — leaving the user with no control left to fix it.
    rowsHolder.current = customerRows;
    const crossSourceDateFilter: StudioFilterState = {
      id: 'f-order-date',
      field: 'orderDate',
      fieldType: 'date',
      filterSourceId: 'orders_d',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'greater_than_or_equal',
      value: '2020-01-01',
    } as unknown as StudioFilterState;
    const widget = makeWidget(
      { kpiAggregation: 'count', kpiSparkline: true, kpiSparklineGranularity: 'month' },
      'customers',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { customers: customersSource, orders_d: datedOrdersSource },
      relationships: [customerOrdersRelationship],
      filters: [crossSourceDateFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, customersSource);

    expect(lastSparkline()?.timeFieldResolved).toBe(true);
  });

  // Repro 2 fixtures: two date columns, `createdAt` declared FIRST and `shippedAt` second.
  // "today" is 2026-07-07 → current fixed 'month' window 2026-06-08…2026-07-07, previous
  // 2026-05-09…2026-06-07. The two rows swap which window they land in depending on WHICH
  // date column is used, so the resulting delta identifies the field the trend picked.
  const twoDateRows = [
    { id: 'r1', amount: 100, createdAt: '2026-06-20', shippedAt: '2026-05-20' },
    { id: 'r2', amount: 300, createdAt: '2026-05-20', shippedAt: '2026-06-20' },
  ];
  const twoDateSource = {
    id: 'sales2',
    label: 'Sales',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'createdAt', label: 'Created', type: 'date' },
      { id: 'shippedAt', label: 'Shipped', type: 'date' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    rows: twoDateRows,
  } as unknown as StudioDataSource;

  it('repro 2: the sparkline and the fixed-period trend use the SAME date field', () => {
    // Pre-fix the sparkline took the filter's field (`shippedAt`) while the trend preferred
    // `kpiSparklineField` and then fell back to the FIRST date column (`createdAt`) — two
    // different date columns driving one card.
    rowsHolder.current = twoDateRows;
    const shippedFilter: StudioFilterState = {
      id: 'f-shipped',
      field: 'shippedAt',
      fieldType: 'date',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'greater_than_or_equal',
      // Wide enough to keep every row, so the filter only names the field.
      value: '2020-01-01',
    } as unknown as StudioFilterState;
    const widget = makeWidget(
      {
        kpiValueField: 'amount',
        kpiAggregation: 'sum',
        kpiSparkline: true,
        kpiSparklineGranularity: 'month',
        kpiTrend: true,
        kpiTrendFixedPeriod: 'month',
      },
      'sales2',
    );
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales2: twoDateSource },
      filters: [shippedFilter],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, twoDateSource);

    // Sparkline bucketed by month on `shippedAt`: May → 100 (r1), June → 300 (r2).
    // Bucketing on `createdAt` would have produced the reversed [300, 100].
    expect(lastSparkline()?.data).toEqual([100, 300]);
    // Trend windowed on `shippedAt`: current = r2 (300), previous = r1 (100) → +200%.
    // Windowing on `createdAt` would have produced ≈ −66.7%.
    const trend = lastTrend();
    expect(trend).not.toBeNull();
    expect(trend!.delta).toBeCloseTo(2);
    expect(trend!.previousValue).toBe(100);
  });
});

// ─── M6: every filter derivation follows the rows, not the live store ─────────
describe('<StudioKpiWidget /> deferred filter snapshot consistency (M6)', () => {
  beforeEach(() => {
    trendSpy.mockClear();
    valueSpy.mockClear();
    sparklineSpy.mockClear();
  });

  afterEach(() => {
    rowsHolder.deferredFilters = null;
    vi.clearAllMocks();
  });

  const dateFilterJustAdded: StudioFilterState = {
    id: 'f-just-added',
    field: 'saleDate',
    fieldType: 'date',
    scope: { kind: 'page', pageId: 'page-1' },
    operator: 'greater_than_or_equal',
    value: '2026-06-08',
    operator2: 'less_than_or_equal',
    value2: '2026-07-07',
    conjunction: 'and',
  } as unknown as StudioFilterState;

  // The filter the DEFERRED snapshot still holds — on a differently-labelled field ('Amount'
  // vs 'Date') so the subtitle test below can tell the two snapshots apart by rendered text.
  const amountFilterAlreadySettled: StudioFilterState = {
    id: 'f-settled',
    field: 'amount',
    fieldType: 'number',
    scope: { kind: 'page', pageId: 'page-1' },
    operator: 'greater_than',
    value: 0,
  } as unknown as StudioFilterState;

  it('does not compute a trend from a date filter the rendered rows have not caught up to', () => {
    // A date filter has just been added to the store, but React is still inside the deferred
    // window: `useWidgetRows` reports the PREVIOUS (empty) filter snapshot together with the
    // still-unfiltered rows. Re-deriving the filter set from the live `selectFilters` array —
    // which the trend, sparkline and hover subtitle all used to do — made
    // `computeFilterBasedTrend` compare a previous-period value computed under the NEW filter
    // against a `currentValue` computed from the OLD rows. Consuming `useWidgetRows`' exposed
    // sets instead means the trend simply reports "needs a date filter" for this one frame.
    rowsHolder.current = salesRows;
    rowsHolder.deferredFilters = [];
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', kpiTrend: true },
      'sales',
    );
    const salesWithRows = { ...salesSource, rows: salesRows } as StudioDataSource;
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesWithRows },
      filters: [dateFilterJustAdded],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesWithRows);

    expect(lastTrend()).toBeNull();
    expect(lastTrendNeedsDateFilter()).toBe(true);
  });

  it('computes the trend from that same filter once the snapshot has caught up (contrast case)', () => {
    // Identical setup except the deferred snapshot now matches the store — proving the test
    // above pins the SNAPSHOT, not merely "this filter never produces a trend".
    rowsHolder.current = salesRows;
    rowsHolder.deferredFilters = null;
    const widget = makeWidget(
      { kpiValueField: 'amount', kpiAggregation: 'sum', kpiTrend: true },
      'sales',
    );
    const salesWithRows = { ...salesSource, rows: salesRows } as StudioDataSource;
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesWithRows },
      filters: [dateFilterJustAdded],
    });
    configureStudioContextMock({ getState: () => mockState });

    renderKpi(widget, salesWithRows);

    expect(lastTrendNeedsDateFilter()).toBe(false);
    expect(lastTrend()).not.toBeNull();
  });

  it('lists the deferred snapshot — not the live store — in the hover filter subtitle', async () => {
    // The hover subtitle was the third re-derivation site (`filterSubtitle`). It must describe
    // the filters the displayed value was actually computed under; during a deferred window
    // the live array names one the rendered rows do not yet reflect.
    //
    // Both snapshots are deliberately NON-EMPTY and name DIFFERENT fields. An earlier version
    // of this test paired an empty deferred snapshot against a populated live store and
    // asserted only that no tooltip opened — which distinguishes "empty subtitle" from
    // "non-empty subtitle" but passes just as happily on a subtitle listing the WRONG filters,
    // the actual failure mode. Asserting on the rendered text, with a live filter on a
    // differently-labelled field, is what makes the live-array regression visible.
    rowsHolder.current = salesRows;
    rowsHolder.deferredFilters = [amountFilterAlreadySettled];
    const widget = makeWidget({ kpiValueField: 'amount', kpiAggregation: 'sum' }, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [dateFilterJustAdded],
    });
    configureStudioContextMock({ getState: () => mockState });

    const { container, user } = renderKpi(widget, salesSource);
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);
    const tooltip = await screen.findByRole('tooltip');
    // 'Amount' = the deferred snapshot's filter (the one the rows came from).
    expect(tooltip.textContent).toContain('Amount');
    // 'Date' = `dateFilterJustAdded`, live in the store but not yet reflected in the rows.
    expect(tooltip.textContent).not.toContain('Date');
  });

  it('lists the live store filter once the deferred snapshot has caught up (contrast case)', async () => {
    // Same setup with the deferred window closed, proving the assertion above pins the
    // SNAPSHOT rather than merely "this filter never reaches the subtitle".
    rowsHolder.current = salesRows;
    rowsHolder.deferredFilters = null;
    const widget = makeWidget({ kpiValueField: 'amount', kpiAggregation: 'sum' }, 'sales');
    mockState = createState({
      widgets: { 'kpi-1': widget },
      dataSources: { sales: salesSource },
      filters: [dateFilterJustAdded],
    });
    configureStudioContextMock({ getState: () => mockState });

    const { container, user } = renderKpi(widget, salesSource);
    // eslint-disable-next-line testing-library/no-container -- no accessible role/text on the empty ValueSpy-wrapped span
    const wrapperSpan = container.querySelector('span')!;
    await user.hover(wrapperSpan);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Date');
  });
});
