/**
 * Tests for useChartWidgetData.
 *
 * Covers: cross-source blending (mixed charts whose ySeries reference different data
 * sources, aligned on a shared categorical xField), cross-filter ghost baseline memos
 * (allChartData/allSeriesFieldData/allMultiYData), rank-filter separation (row-level
 * vs. post-aggregation), stable series-color assignment (allSeriesNames/resolvedChartColors),
 * scatter series computation, and adapter-backed foreign-source fetch promise plumbing
 * (loading / success / rejection).
 *
 * Context is mocked via vi.mock so useStudioSelector resolves against a mutable
 * `mockState` — matching the pattern used by the other widget/hook tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@mui/internal-test-utils';
import { blueberryTwilightPalette } from '@mui/x-charts/colorPalettes';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioRelationship,
  StudioExpressionField,
  StudioState,
  StudioWidgetConfigForKind,
  StudioWidgetOf,
} from '../../../models';
import { studioRequestCache } from '../../../internals/StudioRequestCache';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
// Static import is safe here: vitest hoists vi.mock() above all imports, and the
// mock factory reads `mockState` lazily via closure (resolved at selector-call time).
// Matches the sibling StudioChartWidget.test.tsx; avoids the per-test dynamic import
// whose heavy module graph could exceed the hook timeout under parallel load.
import { useChartWidgetData } from './useChartWidgetData';

let mockState: StudioState;

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

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

function createState(overrides: StateOverrides = {}): StudioState {
  return {
    doc: {
      schemaVersion: 1,
      dashboard: {
        id: 'dash-1',
        title: 'Dashboard',
        activePageId: 'page-1',
        ...overrides.dashboard,
      },
      pages: {
        'page-1': { id: 'page-1', title: 'Overview', widgetRows: [] },
        ...overrides.pages,
      },
      widgets: overrides.widgets ?? {},
      relationships: overrides.relationships ?? [],
      filters: overrides.filters ?? [],
      expressionFields: overrides.expressionFields ?? [],
    },
    session: {
      mode: overrides.mode ?? 'view',
      shell: {
        openDrawers: { data: true, compose: true, filters: false },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
        ...overrides.shell,
      },
    },
    runtime: {
      dataSources: overrides.dataSources ?? {},
    },
  };
}

// Orders: revenue (`total`) by `category`. Products: inventory (`stock`) by `category`.
// A relationship orders.productId → products.id makes `stock` a *reachable* related
// field — which previously caused analyzeChartSupport to mark the chart unsupported
// and blank the primary series. The blend path must aggregate each source independently.
const ordersSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'productId', label: 'Product ID', type: 'string', hidden: true },
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'total', label: 'Total', type: 'number' },
  ],
  rows: [
    { id: 'o1', productId: 'p1', category: 'Electronics', total: 100 },
    { id: 'o2', productId: 'p1', category: 'Electronics', total: 50 },
    { id: 'o3', productId: 'p2', category: 'Furniture', total: 30 },
  ],
};

const productsSource: StudioDataSource = {
  id: 'products',
  label: 'Products',
  fields: [
    { id: 'id', label: 'ID', type: 'string', hidden: true },
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'stock', label: 'Stock', type: 'number' },
  ],
  rows: [
    { id: 'p1', category: 'Electronics', stock: 5 },
    { id: 'p2', category: 'Electronics', stock: 7 },
    { id: 'p3', category: 'Supplies', stock: 9 },
  ],
};

function blendedWidget(): StudioWidgetOf<'chart'> {
  return {
    id: 'chart-blend',
    kind: 'chart',
    title: 'Revenue vs Stock by Category',
    sourceId: 'orders',
    config: {
      chartType: 'mixed',
      xField: 'category',
      dualYAxis: true,
      ySeries: [
        { fieldId: 'total', sourceId: 'orders', type: 'bar', yAggregation: 'sum' },
        { fieldId: 'stock', sourceId: 'products', type: 'line', yAggregation: 'sum' },
      ],
    },
  };
}

beforeEach(() => {
  studioRequestCache.clear();
  mockState = createState({
    widgets: { 'chart-blend': blendedWidget() },
    dataSources: { orders: ordersSource, products: productsSource },
    relationships: [
      {
        id: 'rel-orders-products',
        sourceId: 'orders',
        sourceField: 'productId',
        targetId: 'products',
        targetField: 'id',
        type: 'many-to-one',
      },
    ],
  });
  // The getter reads the live `mockState`, so the mid-test reassignment in the
  // fieldless-count test below is reflected without re-configuring.
  configureStudioContextMock({ getState: () => mockState });
});

afterEach(() => {
  studioRequestCache.clear();
  vi.restoreAllMocks();
});

describe('useChartWidgetData — cross-source blending', () => {
  it('flags the chart as blended', () => {
    const widget = blendedWidget();
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource, 'page-1'));
    expect(result.current.isBlended).toBe(true);
  });

  it('aggregates the primary series from its own source despite a related foreign field', () => {
    const widget = blendedWidget();
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource, 'page-1'));
    const data = result.current.multiYData!;
    const totalSeries = data.series.find((s) => s.fieldId === 'total')!;
    const ent = data.labels.indexOf('Electronics');
    const fur = data.labels.indexOf('Furniture');
    // Regression: this used to be 0 because enrichedRows was blanked when the
    // foreign `stock` field made analyzeChartSupport report mixed_cross_source_fields.
    expect(totalSeries.values[ent]).toBe(150); // 100 + 50 from orders
    expect(totalSeries.values[fur]).toBe(30);
  });

  it('aggregates the foreign series from its own source and outer-joins categories', () => {
    const widget = blendedWidget();
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource, 'page-1'));
    const data = result.current.multiYData!;
    const stockSeries = data.series.find((s) => s.fieldId === 'stock')!;
    const totalSeries = data.series.find((s) => s.fieldId === 'total')!;
    expect([...data.labels].sort()).toEqual(['Electronics', 'Furniture', 'Supplies']);
    const ent = data.labels.indexOf('Electronics');
    const sup = data.labels.indexOf('Supplies');
    expect(stockSeries.values[ent]).toBe(12); // 5 + 7 from products
    expect(stockSeries.values[sup]).toBe(9); // Supplies only exists in products
    expect(totalSeries.values[sup]).toBe(0); // no orders revenue for Supplies
  });

  it('renders a fieldless row count: count chart with an X field but no Y field (BL-186)', () => {
    // Reproduces "contacts by department" on a source with no visible numeric field: the
    // config is xField + yAggregation:'count' with no yField/ySeries. aggregateByField tallies
    // rows, so chartData must produce a per-category count even with no measure field.
    const contactsSource: StudioDataSource = {
      id: 'contacts',
      label: 'Contacts',
      fields: [
        { id: 'id', label: 'ID', type: 'string', hidden: true },
        { id: 'department', label: 'Department', type: 'string' },
      ],
      rows: [
        { id: 'c1', department: 'Sales' },
        { id: 'c2', department: 'Sales' },
        { id: 'c3', department: 'Sales' },
        { id: 'c4', department: 'Engineering' },
      ],
    };
    const countWidget: StudioWidgetOf<'chart'> = {
      id: 'chart-count',
      kind: 'chart',
      title: 'Contacts by Department',
      sourceId: 'contacts',
      config: { chartType: 'bar', xField: 'department', yAggregation: 'count' },
    };
    mockState = createState({
      widgets: { 'chart-count': countWidget },
      dataSources: { contacts: contactsSource },
    });

    const { result } = renderHook(() => useChartWidgetData(countWidget, contactsSource, 'page-1'));
    const data = result.current.chartData!;
    expect(data).not.toBeNull();
    const sales = data.labels.indexOf('Sales');
    const eng = data.labels.indexOf('Engineering');
    expect(data.values[sales]).toBe(3);
    expect(data.values[eng]).toBe(1);
  });

  it('fetches a foreign series from its own adapter when the source is adapter-backed', async () => {
    // Products is adapter-backed (server/adapter mode): its rows are fetched via getRows,
    // not read from in-memory `rows`. The blend must still resolve the foreign series.
    const getRows = vi.fn().mockResolvedValue({
      rows: [
        { category: 'Electronics', stock: 12 },
        { category: 'Supplies', stock: 9 },
      ],
    });
    const adapterProducts: StudioDataSource = {
      ...productsSource,
      rows: undefined,
      adapter: { getRows },
    };
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, products: adapterProducts },
    });

    const widget = blendedWidget();
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource, 'page-1'));

    await waitFor(() => {
      const stockSeries = result.current.multiYData?.series.find((s) => s.fieldId === 'stock');
      const ent = result.current.multiYData?.labels.indexOf('Electronics') ?? -1;
      expect(stockSeries?.values[ent]).toBe(12);
    });
    expect(getRows).toHaveBeenCalled();
    // The foreign source must be queried on its own (no cross-source JOIN on the widget).
    expect(getRows.mock.calls[0][0].sourceId).toBe('products');
  });

  it('renders synchronously with foreign series at 0 while the adapter fetch is still pending', () => {
    // The foreign source's getRows() never resolves in this test. Before it settles,
    // asyncForeignRows is empty, so blendedMultiYData outer-joins the foreign field
    // against zero rows — the primary series must still render its real aggregation.
    const getRows = vi.fn(() => new Promise<{ rows: Record<string, unknown>[] }>(() => {}));
    const adapterProducts: StudioDataSource = {
      ...productsSource,
      rows: undefined,
      adapter: { getRows },
    };
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, products: adapterProducts },
    });

    const widget = blendedWidget();
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource, 'page-1'));

    expect(getRows).toHaveBeenCalled();
    const data = result.current.multiYData!;
    const stockSeries = data.series.find((s) => s.fieldId === 'stock')!;
    expect(stockSeries.values.every((v) => v === 0)).toBe(true);
    const totalSeries = data.series.find((s) => s.fieldId === 'total')!;
    const ent = data.labels.indexOf('Electronics');
    expect(totalSeries.values[ent]).toBe(150); // primary series unaffected by the pending fetch
  });

  it('leaves the foreign series empty and does not crash the hook when the adapter fetch rejects', async () => {
    let rejectFetch: (err: unknown) => void = () => {};
    const getRows = vi.fn(
      () =>
        new Promise<{ rows: Record<string, unknown>[] }>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const adapterProducts: StudioDataSource = {
      ...productsSource,
      rows: undefined,
      adapter: { getRows },
    };
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, products: adapterProducts },
    });

    const widget = blendedWidget();
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource, 'page-1'));
    expect(getRows).toHaveBeenCalled();

    // Reject the in-flight fetch. The hook's rejection handler is a documented no-op
    // (see the comment above `promise.then(...)` in useChartWidgetData.ts: "errors leave
    // the series empty; the primary chart still renders") — it must not throw, produce an
    // unhandled rejection, or crash the hook.
    await act(async () => {
      rejectFetch(new Error('network down'));
      // Flush the microtask queue so the attached rejection handler runs.
      await Promise.resolve();
      await Promise.resolve();
    });

    const data = result.current.multiYData!;
    const stockSeries = data.series.find((s) => s.fieldId === 'stock')!;
    expect(stockSeries.values.every((v) => v === 0)).toBe(true);
    const totalSeries = data.series.find((s) => s.fieldId === 'total')!;
    const ent = data.labels.indexOf('Electronics');
    expect(totalSeries.values[ent]).toBe(150); // primary chart still renders after the error
  });

  it('propagates a page filter on a foreign-source field into the foreign series aggregation', () => {
    // A page-scoped filter applies across the whole dashboard, so it must also constrain
    // the independently-aggregated foreign (products) series. `category` exists in products,
    // so filtering to 'Electronics' drops the Supplies row (p3) from the foreign aggregation.
    const pageFilter: StudioFilterState = {
      id: 'f-page-category',
      field: 'category',
      operator: 'equals',
      value: 'Electronics',
      scope: { kind: 'page', pageId: 'page-1' },
    } as StudioFilterState;
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, products: productsSource },
      filters: [pageFilter],
    });

    const widget = blendedWidget();
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource, 'page-1'));

    const data = result.current.multiYData!;
    const stockSeries = data.series.find((s) => s.fieldId === 'stock')!;
    // Supplies (products-only category) is filtered out of the foreign source entirely.
    expect(data.labels).not.toContain('Supplies');
    expect(stockSeries.values[data.labels.indexOf('Electronics')]).toBe(12); // p1(5) + p2(7)
  });

  it('does not apply a page filter on an orders-only field to the foreign source', () => {
    // `total` exists only in orders — it is not an applicable filter for the products
    // aggregation, so the foreign stock series must stay fully unconstrained.
    const pageFilter: StudioFilterState = {
      id: 'f-page-total',
      field: 'total',
      operator: 'greater_than',
      value: 40,
      scope: { kind: 'page', pageId: 'page-1' },
    } as StudioFilterState;
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, products: productsSource },
      filters: [pageFilter],
    });

    const widget = blendedWidget();
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource, 'page-1'));

    const data = result.current.multiYData!;
    const stockSeries = data.series.find((s) => s.fieldId === 'stock')!;
    // Both foreign categories survive because the orders-only filter never reaches products.
    expect(stockSeries.values[data.labels.indexOf('Electronics')]).toBe(12); // p1(5) + p2(7)
    expect(stockSeries.values[data.labels.indexOf('Supplies')]).toBe(9); // p3
  });

  it('includes an applicable page filter in the descriptor sent to the foreign adapter', async () => {
    const getRows = vi.fn().mockResolvedValue({
      rows: [{ category: 'Electronics', stock: 12 }],
    });
    const adapterProducts: StudioDataSource = {
      ...productsSource,
      rows: undefined,
      adapter: { getRows },
    };
    const pageFilter: StudioFilterState = {
      id: 'f-page-category',
      field: 'category',
      operator: 'equals',
      value: 'Electronics',
      scope: { kind: 'page', pageId: 'page-1' },
    } as StudioFilterState;
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, products: adapterProducts },
      filters: [pageFilter],
    });

    const widget = blendedWidget();
    renderHook(() => useChartWidgetData(widget, ordersSource, 'page-1'));

    await waitFor(() => {
      expect(getRows).toHaveBeenCalled();
    });
    const descriptor = getRows.mock.calls[0][0];
    expect(descriptor.sourceId).toBe('products');
    // The applicable page filter must be pushed into the foreign source's own query.
    expect(descriptor.filter).toMatchObject({ field: 'category', value: 'Electronics' });
  });

  it('resolves a foreign adapter series from a warm request cache without re-fetching', async () => {
    const getRows = vi.fn().mockResolvedValue({
      rows: [
        { category: 'Electronics', stock: 12 },
        { category: 'Supplies', stock: 9 },
      ],
    });
    const adapterProducts: StudioDataSource = {
      ...productsSource,
      rows: undefined,
      adapter: { getRows },
    };
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, products: adapterProducts },
    });

    // First render performs the cold fetch, populating studioRequestCache on resolve.
    const widget = blendedWidget();
    const { result: firstResult, unmount: unmountFirst } = renderHook(() =>
      useChartWidgetData(widget, ordersSource, 'page-1'),
    );
    await waitFor(() => {
      const stock = firstResult.current.multiYData?.series.find((s) => s.fieldId === 'stock');
      const ent = firstResult.current.multiYData?.labels.indexOf('Electronics') ?? -1;
      expect(stock?.values[ent]).toBe(12);
    });
    expect(getRows).toHaveBeenCalledTimes(1);
    unmountFirst();

    // Second render must hit the warm cache (same descriptor cacheKey) — no second getRows.
    const { result: secondResult } = renderHook(() =>
      useChartWidgetData(widget, ordersSource, 'page-1'),
    );
    await waitFor(() => {
      const stock = secondResult.current.multiYData?.series.find((s) => s.fieldId === 'stock');
      const ent = secondResult.current.multiYData?.labels.indexOf('Electronics') ?? -1;
      expect(stock?.values[ent]).toBe(12);
    });
    expect(getRows).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-filter ghost baseline memos: allChartData / allSeriesFieldData / allMultiYData
// ─────────────────────────────────────────────────────────────────────────────
//
// These memos recompute from `allEnrichedRows` (derived from `filteredRowsNoCross`,
// i.e. page + widget filters only — no cross-filters) so a chart can render a dimmed
// "all data" ghost baseline behind the actively cross-filtered series. They are only
// computed when `shouldShowGhost` is true (crossFilterMode 'cross-highlight' + an
// incoming chart-click cross-filter from another widget).

const revenueSource: StudioDataSource = {
  id: 'revenue',
  label: 'Revenue',
  fields: [
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'region', label: 'Region', type: 'string' },
    { id: 'total', label: 'Total', type: 'number' },
    { id: 'cost', label: 'Cost', type: 'number' },
  ],
  rows: [
    { id: 'r1', category: 'Electronics', region: 'EU', total: 100, cost: 40 },
    { id: 'r2', category: 'Electronics', region: 'US', total: 50, cost: 20 },
    { id: 'r3', category: 'Furniture', region: 'EU', total: 30, cost: 10 },
    { id: 'r4', category: 'Furniture', region: 'US', total: 20, cost: 5 },
    { id: 'r5', category: 'Office', region: 'EU', total: 10, cost: 3 },
  ],
};

function crossFilterOnRegion(value: string): StudioFilterState {
  return {
    id: 'f-cross-region',
    field: 'region',
    operator: 'equals',
    value,
    scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
  } as StudioFilterState;
}

function singleSeriesWidget(): StudioWidgetOf<'chart'> {
  return {
    id: 'chart-single',
    kind: 'chart',
    title: 'Revenue by Category',
    sourceId: 'revenue',
    config: { chartType: 'bar', xField: 'category', yField: 'total', yAggregation: 'sum' },
  };
}

function multiYWidget(): StudioWidgetOf<'chart'> {
  return {
    id: 'chart-multi',
    kind: 'chart',
    title: 'Total & Cost by Category',
    sourceId: 'revenue',
    config: {
      chartType: 'bar',
      xField: 'category',
      ySeries: [
        { fieldId: 'total', yAggregation: 'sum' },
        { fieldId: 'cost', yAggregation: 'sum' },
      ],
    },
  };
}

const salesSource: StudioDataSource = {
  id: 'sales',
  label: 'Sales',
  fields: [
    { id: 'month', label: 'Month', type: 'string' },
    { id: 'region', label: 'Region', type: 'string' },
    { id: 'value', label: 'Value', type: 'number' },
  ],
  rows: [
    { id: 's1', month: 'Jan', region: 'EU', value: 10 },
    { id: 's2', month: 'Jan', region: 'US', value: 20 },
    { id: 's3', month: 'Feb', region: 'EU', value: 15 },
    { id: 's4', month: 'Feb', region: 'US', value: 25 },
  ],
};

function seriesFieldWidget(): StudioWidgetOf<'chart'> {
  return {
    id: 'chart-series',
    kind: 'chart',
    title: 'Value by Month/Region',
    sourceId: 'sales',
    config: { chartType: 'line', xField: 'month', seriesField: 'region', yField: 'value' },
  };
}

describe('useChartWidgetData — cross-filter ghost baseline memos', () => {
  it('allChartData is the full unfiltered aggregation while chartData reflects the active cross-filter', () => {
    const widget = singleSeriesWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      filters: [crossFilterOnRegion('EU')],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

    expect(result.current.shouldShowGhost).toBe(true);

    const filtered = result.current.chartData!;
    expect(filtered.values[filtered.labels.indexOf('Electronics')]).toBe(100); // EU only
    expect(filtered.values[filtered.labels.indexOf('Furniture')]).toBe(30);
    expect(filtered.values[filtered.labels.indexOf('Office')]).toBe(10);

    const all = result.current.allChartData!;
    expect(all.values[all.labels.indexOf('Electronics')]).toBe(150); // 100 + 50, all regions
    expect(all.values[all.labels.indexOf('Furniture')]).toBe(50); // 30 + 20
    expect(all.values[all.labels.indexOf('Office')]).toBe(10);
  });

  it('allMultiYData is the full unfiltered multi-series aggregation while multiYData reflects the active cross-filter', () => {
    const widget = multiYWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      filters: [crossFilterOnRegion('EU')],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

    expect(result.current.shouldShowGhost).toBe(true);

    const filtered = result.current.multiYData!;
    const totalFiltered = filtered.series.find((s) => s.fieldId === 'total')!;
    const costFiltered = filtered.series.find((s) => s.fieldId === 'cost')!;
    const elFiltered = filtered.labels.indexOf('Electronics');
    expect(totalFiltered.values[elFiltered]).toBe(100);
    expect(costFiltered.values[elFiltered]).toBe(40);

    const all = result.current.allMultiYData!;
    const totalAll = all.series.find((s) => s.fieldId === 'total')!;
    const costAll = all.series.find((s) => s.fieldId === 'cost')!;
    const elAll = all.labels.indexOf('Electronics');
    expect(totalAll.values[elAll]).toBe(150);
    expect(costAll.values[elAll]).toBe(60);
  });

  it('allSeriesFieldData is the full unfiltered two-field aggregation while seriesFieldData reflects the active cross-filter', () => {
    const widget = seriesFieldWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { sales: salesSource },
      filters: [crossFilterOnRegion('EU')],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, salesSource, 'page-1'));

    expect(result.current.shouldShowGhost).toBe(true);

    // Only EU rows are visible post-cross-filter, so the US series disappears entirely.
    const filtered = result.current.seriesFieldData!;
    expect(filtered.seriesNames).toEqual(['EU']);

    const all = result.current.allSeriesFieldData!;
    expect(all.seriesNames).toEqual(['EU', 'US']);
    const jan = all.labels.indexOf('Jan');
    const feb = all.labels.indexOf('Feb');
    expect(all.seriesData.EU[jan]).toBe(10);
    expect(all.seriesData.US[jan]).toBe(20);
    expect(all.seriesData.EU[feb]).toBe(15);
    expect(all.seriesData.US[feb]).toBe(25);
  });

  it('ghost memos are null when there is no incoming cross-filter (shouldShowGhost false)', () => {
    const widget = singleSeriesWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      filters: [],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

    expect(result.current.shouldShowGhost).toBe(false);
    expect(result.current.allChartData).toBeNull();
    expect(result.current.chartData).not.toBeNull();
  });

  it('keeps allChartData referentially stable across a cross-filter-only change, but recomputes when the underlying rows change', () => {
    // Stable (never replaced) relationships/expressionFields references: the underlying
    // content-based row-resolution caches gate on `relationships`/expression-field object
    // identity, so a fresh [] on every mockState reassignment would defeat the very
    // cache hit this test is trying to observe.
    const stableRelationships: StudioRelationship[] = [];
    const stableExpressionFields: StudioExpressionField[] = [];
    const widget = singleSeriesWidget();

    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      relationships: stableRelationships,
      expressionFields: stableExpressionFields,
      filters: [crossFilterOnRegion('EU')],
    });
    // `dataSource` is passed to the hook directly (not read from context), so it must be
    // threaded through renderHook's props to actually change on rerender — reusing the
    // same closure-captured value across `rerender()` calls would never update it.
    const { result, rerender } = renderHook(
      ({ dataSource }) => useChartWidgetData(widget, dataSource, 'page-1'),
      { initialProps: { dataSource: revenueSource } },
    );
    const firstAllChartData = result.current.allChartData;
    expect(firstAllChartData).not.toBeNull();

    // Change only which value the incoming cross-filter selects. The "no-cross" baseline
    // (page + widget filters only, which are empty here) is untouched by this change, so
    // allEnrichedRows — and therefore allChartData — must not be recomputed.
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      relationships: stableRelationships,
      expressionFields: stableExpressionFields,
      filters: [crossFilterOnRegion('US')],
    });
    rerender({ dataSource: revenueSource });

    expect(result.current.allChartData).toBe(firstAllChartData);
    // Sanity check: the filtered (non-ghost) data DID change with the new cross-filter value.
    const filteredAfter = result.current.chartData!;
    expect(filteredAfter.values[filteredAfter.labels.indexOf('Electronics')]).toBe(50); // US only now

    // Now change the underlying data itself (new rows array reference with a changed
    // value) — this must invalidate the "no-cross" baseline and force a recompute.
    const updatedRevenueSource: StudioDataSource = {
      ...revenueSource,
      rows: [
        ...revenueSource.rows!.slice(0, -1),
        { id: 'r5', category: 'Office', region: 'EU', total: 999, cost: 3 },
      ],
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: updatedRevenueSource },
      relationships: stableRelationships,
      expressionFields: stableExpressionFields,
      filters: [crossFilterOnRegion('US')],
    });
    rerender({ dataSource: updatedRevenueSource });

    expect(result.current.allChartData).not.toBe(firstAllChartData);
    expect(
      result.current.allChartData!.values[result.current.allChartData!.labels.indexOf('Office')],
    ).toBe(999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rank-filter separation: row-level filtering vs. post-aggregation ranking
// ─────────────────────────────────────────────────────────────────────────────
//
// A widget-scoped filter with filterMode:'rank' (top/bottom-N) must NOT reduce the
// row set the chart aggregates over (per ARCHITECTURE.md's L3 filter layer: rank
// filters are excluded from row-level filtering and applied after aggregation). See
// `selectFiltersForWidget` (filterScoping.ts:49): a widget-scope filter is only
// included in the row-level filter set when `filterMode !== 'rank'`.

function rankFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'f-rank',
    field: 'total',
    operator: 'greater_than',
    value: 2,
    filterMode: 'rank',
    rankDirection: 'top',
    scope: { kind: 'widget', widgetId: 'chart-single' },
    ...overrides,
  } as StudioFilterState;
}

describe('useChartWidgetData — rank-filter separation', () => {
  it('excludes the widget rank filter from row-level filtering (all rows still reach aggregation)', () => {
    const widget = singleSeriesWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      filters: [rankFilter({ value: 2 })],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

    // All 5 rows across all 3 categories reach the chart-grain/enrichment layer —
    // the rank filter must not have removed any rows at the filter layer.
    expect(result.current.filteredRows).toHaveLength(5);
    expect(result.current.enrichedRows).toHaveLength(5);
  });

  it.each([
    { rankDirection: 'top' as const, value: 2, expectedLabels: ['Electronics', 'Furniture'] },
    { rankDirection: 'bottom' as const, value: 1, expectedLabels: ['Office'] },
    { rankDirection: 'bottom' as const, value: 2, expectedLabels: ['Furniture', 'Office'] },
  ])(
    'applies rank ($rankDirection $value) post-aggregation to chartData',
    ({ rankDirection, value, expectedLabels }) => {
      const widget = singleSeriesWidget();
      mockState = createState({
        widgets: { [widget.id]: widget },
        dataSources: { revenue: revenueSource },
        filters: [rankFilter({ rankDirection, value })],
      });
      const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

      const data = result.current.chartData!;
      expect([...data.labels].sort()).toEqual([...expectedLabels].sort());
      expect(data.labels).toHaveLength(expectedLabels.length);
    },
  );

  it('applies rank post-aggregation to multiYData (ranking by the summed series values)', () => {
    const widget = multiYWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      filters: [
        rankFilter({
          scope: { kind: 'widget', widgetId: widget.id },
          rankDirection: 'top',
          value: 1,
        }),
      ],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

    // Electronics has the highest combined total+cost (150 + 60), so top-1 keeps only it.
    const data = result.current.multiYData!;
    expect(data.labels).toEqual(['Electronics']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stable color assignment: allSeriesNames / resolvedChartColors
// ─────────────────────────────────────────────────────────────────────────────
//
// `allSeriesNames` is computed from `allEnrichedRows` (the non-cross-filtered baseline)
// so the consuming component can assign each series a color by its index in this list —
// a series doesn't change color just because an active cross-filter temporarily hides it.

describe('useChartWidgetData — stable color assignment', () => {
  it('computes allSeriesNames (sorted) from the unfiltered rows', () => {
    const widget = seriesFieldWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { sales: salesSource },
      filters: [],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, salesSource, 'page-1'));

    expect(result.current.allSeriesNames).toEqual(['EU', 'US']);
  });

  it('keeps allSeriesNames unaffected when a cross-filter narrows the visible series', () => {
    const widget = seriesFieldWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { sales: salesSource },
      filters: [crossFilterOnRegion('EU')],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, salesSource, 'page-1'));

    // The currently-visible series collapses to just 'EU' ...
    expect(result.current.seriesFieldData!.seriesNames).toEqual(['EU']);
    // ... but the stable color-assignment list still reports both series, at their
    // original indices, so a series doesn't jump to a different color when it reappears.
    expect(result.current.allSeriesNames).toEqual(['EU', 'US']);
  });

  it('appends a newly-appearing label without disturbing earlier indices when it sorts after existing labels', () => {
    const widget = seriesFieldWidget();
    const extendedSales: StudioDataSource = {
      ...salesSource,
      rows: [...salesSource.rows!, { id: 's5', month: 'Mar', region: 'ZZ-APAC', value: 5 }],
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { sales: extendedSales },
      filters: [],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, extendedSales, 'page-1'));

    expect(result.current.allSeriesNames).toEqual(['EU', 'US', 'ZZ-APAC']);
    expect(result.current.allSeriesNames.indexOf('EU')).toBe(0);
    expect(result.current.allSeriesNames.indexOf('US')).toBe(1);
  });

  it('documents actual behavior: a new label that sorts BEFORE existing labels shifts their indices', () => {
    // allSeriesNames is alphabetically sorted (sortLabels), not insertion-ordered. A
    // series-color assignment keyed by `allSeriesNames.indexOf(name)` (as the consuming
    // StudioChartWidget component does) is therefore only index-stable for existing
    // series when new categories happen to sort AFTER them. A category that sorts
    // earlier (e.g. 'AA' before 'EU') shifts every later index. This is current,
    // intentional-looking behavior — documented here rather than "fixed" by this
    // test-only change.
    const widget = seriesFieldWidget();
    const extendedSales: StudioDataSource = {
      ...salesSource,
      rows: [...salesSource.rows!, { id: 's5', month: 'Mar', region: 'AA-EMEA', value: 5 }],
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { sales: extendedSales },
      filters: [],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, extendedSales, 'page-1'));

    expect(result.current.allSeriesNames).toEqual(['AA-EMEA', 'EU', 'US']);
    // EU shifted from index 0 -> 1, US from index 1 -> 2.
    expect(result.current.allSeriesNames.indexOf('EU')).toBe(1);
    expect(result.current.allSeriesNames.indexOf('US')).toBe(2);
  });

  it('resolvedChartColors falls back to the theme palette when no page chart-color override is configured', () => {
    const widget = singleSeriesWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      filters: [],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

    // usePageChartColors() currently always returns undefined (colors are theme-driven),
    // so resolvedChartColors falls back to blueberryTwilightPalette for the resolved mode.
    // Without a ThemeProvider/CssVarsProvider the resolved mode defaults to 'light'.
    expect(result.current.chartColors).toBeUndefined();
    expect(result.current.resolvedChartColors).toEqual(blueberryTwilightPalette('light'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scatter series computation
// ─────────────────────────────────────────────────────────────────────────────

const scatterSource: StudioDataSource = {
  id: 'metrics',
  label: 'Metrics',
  fields: [
    { id: 'x', label: 'X', type: 'number' },
    { id: 'y', label: 'Y', type: 'number' },
    { id: 'size', label: 'Size', type: 'number' },
    { id: 'region', label: 'Region', type: 'string' },
  ],
  rows: [
    { id: 'm1', x: 1, y: 2, size: 5, region: 'A' },
    { id: 'm2', x: 3, y: 4, size: 9, region: 'B' },
    { id: 'm3', x: 5, y: 6, region: 'A' }, // no size value
  ],
};

function scatterWidget(
  overrides: Partial<StudioWidgetConfigForKind<'chart'>> = {},
): StudioWidgetOf<'chart'> {
  return {
    id: 'chart-scatter',
    kind: 'chart',
    title: 'Scatter',
    sourceId: 'metrics',
    config: {
      chartType: 'scatter',
      xField: 'x',
      yField: 'y',
      scatterSizeField: 'size',
      ...overrides,
    },
  };
}

describe('useChartWidgetData — scatter series computation', () => {
  it('prepares scatterData points (x/y pairing, index ids, bubble sizing via the size field)', () => {
    const widget = scatterWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { metrics: scatterSource },
      filters: [],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, scatterSource, 'page-1'));

    expect(result.current.scatterData).toEqual([
      { x: 1, y: 2, id: 0, sizeValue: 5 },
      { x: 3, y: 4, id: 1, sizeValue: 9 },
      { x: 5, y: 6, id: 2, sizeValue: 0 }, // missing size defaults to 0
    ]);
  });

  it('groups rows into one scatter series per color-by category, dropping empty categories', () => {
    const widget = scatterWidget({ scatterColorField: 'region' });
    // Cross-filter hides region 'B' entirely from the current (filtered) rows, but the
    // stable category order is still derived from ALL rows (allEnrichedRows).
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { metrics: scatterSource },
      filters: [crossFilterOnRegion('A')],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, scatterSource, 'page-1'));

    expect(result.current.scatterSeries).toHaveLength(1);
    expect(result.current.scatterSeries![0].id).toBe('A');
    // `id` is the point's index within the CURRENT (already cross-filtered) row set, not
    // the original unfiltered row array — so m3 (originally index 2) becomes index 1 here.
    expect(result.current.scatterSeries![0].data).toEqual([
      { x: 1, y: 2, id: 0, sizeValue: 5 },
      { x: 5, y: 6, id: 1, sizeValue: 0 },
    ]);

    // Ghost (ALL rows, ignoring the cross-filter) still includes both categories.
    expect(result.current.shouldShowGhost).toBe(true);
    expect(result.current.allScatterSeries!.map((s) => s.id).sort()).toEqual(['A', 'B']);
  });

  it('ghost scatter data (allScatterData/allScatterSeries) is null without an active cross-filter', () => {
    const widget = scatterWidget({ scatterColorField: 'region' });
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { metrics: scatterSource },
      filters: [],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, scatterSource, 'page-1'));

    expect(result.current.shouldShowGhost).toBe(false);
    expect(result.current.allScatterData).toBeNull();
    expect(result.current.allScatterSeries).toBeNull();
    // Non-ghost scatter data is still computed from the (unfiltered, in this case) rows.
    expect(result.current.scatterData).toHaveLength(3);
  });
});

// ─── per-series yAggregation precedence (finding 1.12) ────────────────────────
//
// The single-series (`chartData`) and split-by (`seriesFieldData`) client paths must
// honour `ySeries[0].yAggregation` with precedence over the widget-level `yAggregation`
// default, matching the server/adapter push-down precedence in `chartTypeRegistry`.

describe('useChartWidgetData — per-series yAggregation precedence (finding 1.12)', () => {
  it('single-series chartData honours ySeries[0].yAggregation over config.yAggregation', () => {
    const widget: StudioWidgetOf<'chart'> = {
      id: 'chart-avg-single',
      kind: 'chart',
      title: 'Avg total by category',
      sourceId: 'revenue',
      config: {
        chartType: 'bar',
        xField: 'category',
        yField: 'total',
        yAggregation: 'sum', // widget-level default
        ySeries: [{ fieldId: 'total', yAggregation: 'avg' }], // per-series wins
      },
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      filters: [],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));
    const data = result.current.chartData!;
    // Electronics has total 100 and 50 → avg 75 (sum would be 150).
    expect(data.values[data.labels.indexOf('Electronics')]).toBe(75);
    // Furniture has total 30 and 20 → avg 25 (sum would be 50).
    expect(data.values[data.labels.indexOf('Furniture')]).toBe(25);
  });

  it('split-by seriesFieldData honours ySeries[0].yAggregation over config.yAggregation', () => {
    const splitSource: StudioDataSource = {
      id: 'split',
      label: 'Split',
      fields: [
        { id: 'month', label: 'Month', type: 'string' },
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'value', label: 'Value', type: 'number' },
      ],
      rows: [
        { id: 'a', month: 'Jan', region: 'EU', value: 10 },
        { id: 'b', month: 'Jan', region: 'EU', value: 20 }, // Jan/EU has two rows
        { id: 'c', month: 'Jan', region: 'US', value: 40 },
      ],
    };
    const widget: StudioWidgetOf<'chart'> = {
      id: 'chart-avg-split',
      kind: 'chart',
      title: 'Avg value by month/region',
      sourceId: 'split',
      config: {
        chartType: 'line',
        xField: 'month',
        seriesField: 'region',
        yField: 'value',
        yAggregation: 'sum', // widget-level default
        ySeries: [{ fieldId: 'value', yAggregation: 'avg' }], // per-series wins
      },
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { split: splitSource },
      filters: [],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, splitSource, 'page-1'));
    const data = result.current.seriesFieldData!;
    const janIdx = data.labels.indexOf('Jan');
    // Jan/EU has values 10 and 20 → avg 15 (sum would be 30).
    expect(data.seriesData.EU[janIdx]).toBe(15);
    expect(data.seriesData.US[janIdx]).toBe(40);
  });
});
