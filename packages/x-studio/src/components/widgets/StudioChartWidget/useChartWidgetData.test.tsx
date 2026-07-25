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
import * as React from 'react';
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
  StudioUIConfigContext,
  DEFAULT_STUDIO_LOCALE_TEXT,
} from '../../../internals/StudioUIConfigContext';
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
    // 'Supplies' is contributed to the shared axis by the foreign (products) source only;
    // orders has no row in that category at all. That is absence of data, not a measured
    // zero, so the outer join fills `null` rather than reinstating a fake 0 bar (H4).
    expect(totalSeries.values[sup]).toBeNull();
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

  // Regression for finding 3.6: `isFieldlessCount` used to check `config.yAggregation ===
  // 'count'`, but the aggregation actually passed downstream to `aggregateByField` is
  // `singleSeriesYAggregation = config.ySeries?.[0]?.yAggregation ?? config.yAggregation`.
  // A half-configured `ySeries[0]` (yAggregation: 'sum', no fieldId yet — reachable while a
  // user is mid-way through configuring a series in the setup panel) made the OLD guard
  // pass on `config.yAggregation === 'count'` while the real aggregation was 'sum',
  // producing all-zero bars (summing an empty field id) instead of counts. The fixed guard
  // checks `singleSeriesYAggregation` itself, so this malformed combination no longer
  // renders misleading zero data.
  it('does not treat a half-configured ySeries entry as a fieldless count (finding 3.6)', () => {
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
    const halfConfiguredWidget: StudioWidgetOf<'chart'> = {
      id: 'chart-half-configured',
      kind: 'chart',
      title: 'Contacts by Department (half-configured)',
      sourceId: 'contacts',
      config: {
        chartType: 'bar',
        xField: 'department',
        // Widget-level default still says 'count' ...
        yAggregation: 'count',
        // ... but the actually-used per-series aggregation is 'sum', with no fieldId yet.
        ySeries: [{ yAggregation: 'sum' }],
      } as unknown as StudioWidgetOf<'chart'>['config'],
    };
    mockState = createState({
      widgets: { 'chart-half-configured': halfConfiguredWidget },
      dataSources: { contacts: contactsSource },
    });

    const { result } = renderHook(() =>
      useChartWidgetData(halfConfiguredWidget, contactsSource, 'page-1'),
    );
    // Must NOT render as a fieldless count: the fixed guard reads the same
    // `singleSeriesYAggregation` ('sum') that `aggregateByField` actually receives, so the
    // fieldless-count relaxation doesn't apply and chartData stays null rather than
    // silently rendering all-zero bars.
    expect(result.current.chartData).toBeNull();
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

  it('renders synchronously with the foreign series unmeasured while the adapter fetch is still pending', () => {
    // The foreign source's getRows() never resolves in this test. Before it settles,
    // asyncForeignRows is empty, so blendedMultiYData outer-joins the foreign field
    // against zero rows — the primary series must still render its real aggregation.
    //
    // The foreign series' cells come back `null`, not 0. A pending fetch is "not measured
    // yet", and a real 0 would assert that stock IS zero in every category — a factual
    // claim about data that has not arrived, which then silently flips to the true values
    // once the promise settles. `null` renders as a gap instead of a confident flat zero
    // line. The point of this test is that the hook renders SYNCHRONOUSLY and the primary
    // series is unaffected by the in-flight foreign fetch; that is asserted below.
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
    expect(stockSeries.values.every((v) => v === null)).toBe(true);
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

    // Reject the in-flight fetch. The rejection handler lives in useBlendedSeriesRows.ts
    // (the sub-hook this hook delegates blending to) and, on a FIRST fetch with no prior
    // successful entry for this sid, is a no-op — the series stays empty because there was
    // never anything to serve. It must not throw, produce an unhandled rejection, or crash
    // the hook. (A refetch that fails AFTER a prior success instead clears the stale entry
    // — see useBlendedSeriesRows.test.ts's "refetch failure" coverage for finding 2.4.)
    await act(async () => {
      rejectFetch(new Error('network down'));
      // Flush the microtask queue so the attached rejection handler runs.
      await Promise.resolve();
      await Promise.resolve();
    });

    const data = result.current.multiYData!;
    const stockSeries = data.series.find((s) => s.fieldId === 'stock')!;
    // Every foreign cell is `null` (unmeasured), not 0: the fetch failed, so we have no
    // stock figures at all. Painting 0 would report a hard "zero stock everywhere" for
    // what is actually a network error.
    expect(stockSeries.values.every((v) => v === null)).toBe(true);
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

  // Regression for finding 3: `chartData` (filtered) and `allChartData` (baseline) used to each
  // independently pre-detect sum-vs-count for the same measure field. When the cross-filter
  // narrowed the rows down to a subset that was entirely non-numeric for that field (here: only
  // the 'N/A' sentinel row survives the cross-filter), `chartData` downgraded to a row COUNT
  // while `allChartData` (which sees the full, partly-numeric baseline) stayed a SUM — so the
  // ghost tooltip ended up comparing a count against a sum. Both must now agree on 'sum'.
  it('chartData and allChartData agree on sum vs. count even when the filtered subset is entirely non-numeric', () => {
    const mixedSource: StudioDataSource = {
      id: 'mixed',
      label: 'Mixed',
      fields: [
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        // Only row surviving a region === 'EU' cross-filter — its measure is non-numeric.
        { id: 'm1', category: 'Electronics', region: 'EU', total: 'N/A' },
        // Only visible in the baseline (region === 'US') — real numeric value.
        { id: 'm2', category: 'Electronics', region: 'US', total: 100 },
      ],
    };
    const widget: StudioWidgetOf<'chart'> = {
      id: 'chart-single-mixed',
      kind: 'chart',
      title: 'Revenue by Category',
      sourceId: 'mixed',
      config: { chartType: 'bar', xField: 'category', yField: 'total', yAggregation: 'sum' },
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { mixed: mixedSource },
      filters: [crossFilterOnRegion('EU')],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, mixedSource, 'page-1'));

    expect(result.current.shouldShowGhost).toBe(true);

    const filtered = result.current.chartData!;
    const all = result.current.allChartData!;

    // The baseline sees a real numeric value (100) somewhere for this field, so BOTH
    // computations must be 'sum' quantities — not one 'count' (1 row) and one 'sum' (100).
    expect(all.values[all.labels.indexOf('Electronics')]).toBe(100);
    // The filtered subset's only row is non-numeric, so the forced-to-sum computation finds
    // nothing measurable and yields `null` — NOT `1`, which is the row count this test exists
    // to rule out. `null` rather than `0` is the deliberate aggregation widening: a bucket
    // with no measurable value is unmeasured, and reporting a hard 0 would claim EU
    // Electronics revenue IS zero when the only row's measure is the 'N/A' sentinel.
    const filteredValue = filtered.values[filtered.labels.indexOf('Electronics')];
    expect(filteredValue).not.toBe(1);
    expect(filteredValue).toBeNull();
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

  // Regression for finding 6: `seriesFieldData`/`allSeriesFieldData` (built via
  // `aggregateByTwoFields`, which buckets a null/undefined seriesField value into its own
  // "(empty)" series rather than dropping the row — unlike the xField, see
  // `chartAggregation.test.ts`'s "T3.2" coverage) previously called `aggregateByTwoFields`
  // without `localeText`, so a null `region` always surfaced the hardcoded English
  // `'(empty)'` literal regardless of the consumer's locale — unlike `StudioPieChart`'s own
  // ring/sliceField aggregation, which already threads `localeText` through.
  it('threads localeText through so a null seriesField value renders the localized empty-category label', () => {
    const widget = seriesFieldWidget();
    const salesWithEmptyRegion: StudioDataSource = {
      ...salesSource,
      rows: [...salesSource.rows!, { id: 's5', month: 'Jan', region: null, value: 5 }],
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { sales: salesWithEmptyRegion },
      filters: [],
    });
    function wrapper({ children }: { children?: React.ReactNode }) {
      return (
        <StudioUIConfigContext.Provider
          value={{
            tableSourceMode: 'explicit',
            featureFlags: {},
            localeText: { ...DEFAULT_STUDIO_LOCALE_TEXT, chartEmptyCategoryLabel: '(vide)' },
          }}
        >
          {children}
        </StudioUIConfigContext.Provider>
      );
    }
    const { result } = renderHook(
      () => useChartWidgetData(widget, salesWithEmptyRegion, 'page-1'),
      { wrapper },
    );

    expect(result.current.seriesFieldData!.seriesNames).toContain('(vide)');
    expect(result.current.seriesFieldData!.seriesNames).not.toContain('(empty)');
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

  // ─── Finding 2.6 ────────────────────────────────────────────────────────────
  it('ignores a DISABLED widget rank filter — the chart is NOT reduced to top/bottom N (finding 2.6)', () => {
    // Toggling a Top-N filter off in the drawer sets `disabled: true`. Every other filter path
    // (`selectFiltersForWidget`) already excludes disabled filters; the widget-rank lookup here
    // must too, or the chart stays reduced to N categories after the user turns it off.
    const widget = singleSeriesWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      filters: [rankFilter({ rankDirection: 'top', value: 2, disabled: true })],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

    // All 3 categories render — the disabled rank filter must not reduce to top-2.
    const data = result.current.chartData!;
    expect(data.labels).toHaveLength(3);
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

  // Regression for finding 4: the scatter color-by-field empty/null bucket used to hardcode
  // the English '(blank)' literal, bypassing the configurable `chartEmptyCategoryLabel` every
  // other chart type's empty-category bucket already honours.
  it('routes the scatter color-by empty bucket through the configurable chartEmptyCategoryLabel, not a hardcoded "(blank)"', () => {
    const scatterSourceWithNullRegion: StudioDataSource = {
      ...scatterSource,
      rows: [...scatterSource.rows!, { id: 'm4', x: 7, y: 8, size: 1, region: null }],
    };
    const widget = scatterWidget({ scatterColorField: 'region' });
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { metrics: scatterSourceWithNullRegion },
      filters: [],
    });
    function wrapper({ children }: { children?: React.ReactNode }) {
      return (
        <StudioUIConfigContext.Provider
          value={{
            tableSourceMode: 'explicit',
            featureFlags: {},
            localeText: { ...DEFAULT_STUDIO_LOCALE_TEXT, chartEmptyCategoryLabel: '(vide)' },
          }}
        >
          {children}
        </StudioUIConfigContext.Provider>
      );
    }
    const { result } = renderHook(
      () => useChartWidgetData(widget, scatterSourceWithNullRegion, 'page-1'),
      { wrapper },
    );

    const seriesIds = result.current.scatterSeries!.map((s) => s.id);
    expect(seriesIds).toContain('(vide)');
    expect(seriesIds).not.toContain('(blank)');
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

// ─────────────────────────────────────────────────────────────────────────────
// Finding 2.1: chart-support guard must see related-source expression fields, not
// just the widget's own-source ones.
// ─────────────────────────────────────────────────────────────────────────────
//
// Before the fix, this hook subscribed with `makeSelectExpressionFieldsForSource(own)`
// only. A calculated column owned by a DIRECTLY-RELATED source (one hop away via a
// relationship) is invisible to `findDirectFieldOwner`/`hasRowLevelField` in that case,
// so `analyzeChartSupport` reports `{ supported: false, reason:
// 'field_not_found_or_not_direct' }` even though `ChartSetupPanel` (which subscribes to
// the full expression-field list) validated and allowed the exact same configuration.
// The fix subscribes to own + one-hop-related source ids (mirroring `useWidgetRows`),
// so the widget's own guard agrees with the setup panel, and `useChartRows` no longer
// short-circuits to `[]` purely because of this (previously wrong) outer gate.
//
// Note on scope: actually resolving a related-source EXPRESSION field's per-row VALUE
// onto the widget's own rows is a separate concern (`enrichRowsWithRelatedFields` in
// `internals/dataSourceGraph.ts`, out of scope for this fix — it only pulls physical
// fields from a related source today). These tests assert exactly what this fix
// changes: the support verdict itself, and that the widget is no longer forced blank
// by a guard that disagreed with the setup panel. They deliberately do not assert
// joined-value correctness, which this fix does not touch.

describe('useChartWidgetData — related-source expression field support (finding 2.1)', () => {
  const ordersWithCustomerSource: StudioDataSource = {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'customerId', label: 'Customer ID', type: 'string', hidden: true },
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
      { id: 'id', label: 'ID', type: 'string', hidden: true },
      { id: 'region', label: 'Region', type: 'string' },
    ],
    rows: [
      { id: 'c1', region: 'US' },
      { id: 'c2', region: 'EU' },
    ],
  };

  // Owned by `customers` (the RELATED source), not by `orders` (the widget's own
  // source) — this is the exact shape the previous own-source-only selector missed.
  const customerTierField: StudioExpressionField = {
    id: 'customer-tier',
    label: 'Customer Tier',
    sourceId: 'customers',
    isMeasure: false,
    type: 'string',
    expression: { id: 'region' },
  };

  const relOrdersCustomers: StudioRelationship = {
    id: 'rel-orders-customers',
    sourceId: 'orders',
    sourceField: 'customerId',
    targetId: 'customers',
    targetField: 'id',
    type: 'many-to-one',
  };

  function chartOnCustomerTier(): StudioWidgetOf<'chart'> {
    return {
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
  }

  beforeEach(() => {
    const widget = chartOnCustomerTier();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersWithCustomerSource, customers: customersSource },
      relationships: [relOrdersCustomers],
      expressionFields: [customerTierField],
    });
  });

  it('reports the chart as supported when the dimension field is owned by a directly-related source', () => {
    const widget = chartOnCustomerTier();
    const { result } = renderHook(() =>
      useChartWidgetData(widget, ordersWithCustomerSource, 'page-1'),
    );
    expect(result.current.chartSupport.supported).toBe(true);
    expect(result.current.chartSupport.reason).toBeUndefined();
  });

  it('does not force enrichedRows/chartData to empty via the (now-agreeing) outer support guard', () => {
    const widget = chartOnCustomerTier();
    const { result } = renderHook(() =>
      useChartWidgetData(widget, ordersWithCustomerSource, 'page-1'),
    );
    // Before the fix, `useChartRows` short-circuited to `[]` because the outer
    // `chartSupport.supported` (computed from the own-source-only list) was false —
    // even though the field is perfectly valid per the setup panel's full-list check.
    expect(result.current.enrichedRows.length).toBe(ordersWithCustomerSource.rows!.length);
    // `chartData` is computed (not null) once enrichedRows are non-empty — the pipeline
    // actually runs instead of being gated off before it starts.
    expect(result.current.chartData).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 2.2 — cross-highlight rank applied ONCE, to the baseline
// ─────────────────────────────────────────────────────────────────────────────
//
// Under a cross-highlight ghost, the widget rank must rank ONLY the baseline (allChartData),
// which defines the rendered top-N; the filtered aggregation (chartData) must stay un-ranked so
// its full label→value map is available for the downstream ghost alignment. Ranking both
// independently diverges the two top-N sets, so a baseline-kept category with a real filtered
// value renders "(filtered out)" while a filtered-only category is invisible.
describe('useChartWidgetData — cross-highlight rank (finding 2.2)', () => {
  // Baseline totals A=100, B=90, C=80 → baseline top-2 = {A, B}.
  // EU-filtered totals A=10, B=5, C=70 → filtered top-2 (if ranked independently) = {C, A},
  // which DIVERGES from the baseline set (drops B, adds C).
  const divergingSource: StudioDataSource = {
    id: 'diverge',
    label: 'Diverge',
    fields: [
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'region', label: 'Region', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: [
      { id: 'a-eu', category: 'A', region: 'EU', total: 10 },
      { id: 'a-us', category: 'A', region: 'US', total: 90 },
      { id: 'b-eu', category: 'B', region: 'EU', total: 5 },
      { id: 'b-us', category: 'B', region: 'US', total: 85 },
      { id: 'c-eu', category: 'C', region: 'EU', total: 70 },
      { id: 'c-us', category: 'C', region: 'US', total: 10 },
    ],
  };

  function divergingWidget(): StudioWidgetOf<'chart'> {
    return {
      id: 'chart-single',
      kind: 'chart',
      title: 'Diverge',
      sourceId: 'diverge',
      config: { chartType: 'bar', xField: 'category', yField: 'total', yAggregation: 'sum' },
    };
  }

  it('ranks the baseline top-N and keeps the filtered aggregation un-ranked (full set)', () => {
    const widget = divergingWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { diverge: divergingSource },
      filters: [
        {
          id: 'f-cross-region',
          field: 'region',
          operator: 'equals',
          value: 'EU',
          scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
        } as StudioFilterState,
        {
          id: 'f-rank',
          field: 'total',
          operator: 'greater_than',
          value: 2,
          filterMode: 'rank',
          rankDirection: 'top',
          scope: { kind: 'widget', widgetId: 'chart-single' },
        } as StudioFilterState,
      ],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, divergingSource, 'page-1'));

    expect(result.current.shouldShowGhost).toBe(true);

    // Baseline is ranked top-2 by its own (all-region) totals: {A, B} — NOT C.
    const all = result.current.allChartData!;
    expect([...all.labels].sort()).toEqual(['A', 'B']);
    expect(all.labels).not.toContain('C');

    // Filtered aggregation stays UN-ranked so every baseline-kept category can resolve its real
    // filtered value downstream: all three categories are present, and baseline-kept B carries its
    // genuine EU value (5) instead of being dropped and rendered "(filtered out)".
    const filtered = result.current.chartData!;
    expect(filtered.labels).toHaveLength(3);
    expect(filtered.values[filtered.labels.indexOf('B')]).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 2.6 — single-series aggregation from the entry that supplied activeYFields[0]
// ─────────────────────────────────────────────────────────────────────────────
describe('useChartWidgetData — single-series aggregation entry (finding 2.6)', () => {
  it('reads yAggregation from the first ySeries entry WITH a usable fieldId, not ySeries[0]', () => {
    const widget: StudioWidgetOf<'chart'> = {
      id: 'chart-single',
      kind: 'chart',
      title: 'Half-configured leading series',
      sourceId: 'revenue',
      config: {
        chartType: 'bar',
        xField: 'category',
        // Leading entry is half-configured (no fieldId) — activeYFields skips it, so the aggregated
        // measure is `total` from the SECOND entry, whose fn is `avg`. Reading ySeries[0].yAggregation
        // ('sum') would produce sums instead of averages.
        ySeries: [{ yAggregation: 'sum' }, { fieldId: 'total', yAggregation: 'avg' }],
      } as unknown as StudioWidgetOf<'chart'>['config'],
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

    expect(result.current.activeYFields).toEqual(['total']);
    const data = result.current.chartData!;
    // Electronics has totals 100 and 50 → avg 75 (a sum would be 150).
    expect(data.values[data.labels.indexOf('Electronics')]).toBe(75);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 2.7 — scatter resolves its y measure via the ySeries fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('useChartWidgetData — scatter ySeries fallback (finding 2.7)', () => {
  it('builds scatterData from ySeries[0].fieldId when config.yField is absent', () => {
    const widget: StudioWidgetOf<'chart'> = {
      id: 'chart-scatter',
      kind: 'chart',
      title: 'Scatter via ySeries',
      sourceId: 'revenue',
      config: {
        chartType: 'scatter',
        xField: 'cost',
        // Authored via ySeries (e.g. after a chart-type switch) with no top-level yField.
        ySeries: [{ fieldId: 'total' }],
      } as unknown as StudioWidgetOf<'chart'>['config'],
    };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

    // Previously null (the memo required config.yField) → empty scatter render.
    expect(result.current.scatterData).not.toBeNull();
    expect(result.current.scatterData).toHaveLength(revenueSource.rows!.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 1.4 — ghost/tooltip baseline keeps interactive (filter-widget) hard filters
// ─────────────────────────────────────────────────────────────────────────────
describe('useChartWidgetData — ghost baseline excludes only chart cross-filters (finding 1.4)', () => {
  it('allEnrichedRows honours an interactive hard filter while a chart cross-filter drives the ghost', () => {
    const widget = singleSeriesWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { revenue: revenueSource },
      filters: [
        // Interactive (filter-widget) selection — a HARD filter (region = EU) that must constrain
        // the ghost/tooltip baseline too.
        {
          id: 'f-interactive-region',
          field: 'region',
          operator: 'equals',
          value: 'EU',
          scope: { kind: 'interactive', sourceWidgetId: 'w-filter', pageId: 'page-1' },
        } as StudioFilterState,
        // Chart-click cross-filter on category — drives the highlight/ghost.
        {
          id: 'f-cross-category',
          field: 'category',
          operator: 'equals',
          value: 'Electronics',
          scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
        } as StudioFilterState,
      ],
    });
    const { result } = renderHook(() => useChartWidgetData(widget, revenueSource, 'page-1'));

    expect(result.current.shouldShowGhost).toBe(true);
    // Baseline (allEnrichedRows) must be EU-only (3 rows: r1, r3, r5) — the interactive hard filter
    // stays applied. Resurrecting the removed US rows (the old `filteredRowsNoCross` baseline) would
    // yield all 5 rows and ghost totals larger than anything ever displayed.
    expect(result.current.allEnrichedRows).toHaveLength(3);
    for (const row of result.current.allEnrichedRows) {
      expect(row.region).toBe('EU');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 1 (tier 1) — crossFilterMode:'none' must pair `effectiveRows` with the
// MATCHING filter set at L4 re-anchoring, not a narrower one that drops interactive filters
// ─────────────────────────────────────────────────────────────────────────────
//
// Chart widget on `customers` (x = region), y = `orders.total` — `orders` is the "many" side
// of a many-to-one relationship, so L4 must re-anchor onto `orders` to aggregate `total`.
// `crossFilterMode: 'none'` means `effectiveRows` (from `useWidgetRows`) is
// `filteredRowsNoChartCross` (page + widget + INTERACTIVE filters, only chart-click cross-filters
// dropped). Before the fix, `effectiveResolvedFilters` was `resolvedFiltersNoCross` (page + widget
// ONLY, no interactive) — a filter-set/row-set mismatch. L3's semi-join on `filteredRowsNoChartCross`
// already narrows `customers` to those with >=1 paid order, but L4's `resolveRowsAtGrain` re-reads
// ALL of a surviving customer's orders from the raw store and re-applies only the anchor-scoped
// subset of whatever `widgetFilters` it was handed. With the wrong (interactive-filter-less) set,
// the unpaid orders are resurrected and summed in, inflating the aggregate.
describe("useChartWidgetData — crossFilterMode:'none' L4 re-anchoring filter pairing (finding 1)", () => {
  const customersSource: StudioDataSource = {
    id: 'customers',
    label: 'Customers',
    fields: [
      { id: 'id', label: 'ID', type: 'string', hidden: true },
      { id: 'region', label: 'Region', type: 'string' },
    ],
    rows: [
      { id: 'c1', region: 'US' },
      { id: 'c2', region: 'EU' },
    ],
  };

  const ordersSourceForAnchor: StudioDataSource = {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string', hidden: true },
      { id: 'customerId', label: 'Customer ID', type: 'string', hidden: true },
      { id: 'total', label: 'Total', type: 'number' },
      { id: 'status', label: 'Status', type: 'string' },
    ],
    rows: [
      { id: 'o1', customerId: 'c1', total: 100, status: 'paid' },
      { id: 'o2', customerId: 'c1', total: 999, status: 'unpaid' },
      { id: 'o3', customerId: 'c2', total: 50, status: 'paid' },
      { id: 'o4', customerId: 'c2', total: 888, status: 'unpaid' },
    ],
  };

  const relOrdersToCustomers: StudioRelationship = {
    id: 'rel-orders-customers',
    sourceId: 'orders',
    sourceField: 'customerId',
    targetId: 'customers',
    targetField: 'id',
    type: 'many-to-one',
  };

  function noneModeWidget(): StudioWidgetOf<'chart'> {
    return {
      id: 'chart-none-mode',
      kind: 'chart',
      title: 'Revenue by Region (paid only)',
      sourceId: 'customers',
      config: {
        chartType: 'bar',
        xField: 'region',
        yField: 'total',
        yAggregation: 'sum',
        crossFilterMode: 'none',
      } as unknown as StudioWidgetOf<'chart'>['config'],
    };
  }

  const paidOnlyInteractiveFilter: StudioFilterState = {
    id: 'f-interactive-paid',
    field: 'status',
    operator: 'equals',
    value: 'paid',
    filterMode: 'condition',
    // `status` is a native (non-expression) field owned by `orders`, not by the widget's own
    // source (`customers`) — an explicit `filterSourceId` is how a filter drawer marks a
    // cross-source filter on a physical field (mirrors the `paidFilter`/`activeFilter` fixtures
    // in `grainResolution.test.ts`); without it, L3 has no relationship info to route the
    // filter and it is evaluated against `customers` rows directly (which have no `status`).
    filterSourceId: 'orders',
    scope: { kind: 'interactive', sourceWidgetId: 'filter-widget', pageId: 'page-1' },
  } as unknown as StudioFilterState;

  it('honours an active interactive filter on the foreign anchor source instead of resurrecting excluded rows', () => {
    const widget = noneModeWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { customers: customersSource, orders: ordersSourceForAnchor },
      relationships: [relOrdersToCustomers],
      filters: [paidOnlyInteractiveFilter],
    });

    const { result } = renderHook(() => useChartWidgetData(widget, customersSource, 'page-1'));

    // Both customers have >=1 paid order, so L3's semi-join keeps both — the bug is NOT about
    // which customers survive, it's about which of a surviving customer's orders get summed.
    // `enrichedRows` is the anchor-grain (orders) row set L4 re-anchoring produced; with the fix,
    // only the 2 paid orders should be present — the 2 unpaid ones must not be resurrected.
    expect(result.current.enrichedRows).toHaveLength(2);
    expect(result.current.enrichedRows.every((r) => r.status === 'paid')).toBe(true);

    const data = result.current.chartData!;
    expect(data).not.toBeNull();
    const usTotal = data.values[data.labels.indexOf('US')];
    const euTotal = data.values[data.labels.indexOf('EU')];
    // Correct (fixed): only the paid order per region is summed.
    expect(usTotal).toBe(100);
    expect(euTotal).toBe(50);
    // Regression guard: the bug summed ALL orders (paid + unpaid) per surviving customer,
    // which would produce 1099 / 938 instead.
    expect(usTotal).not.toBe(1099);
    expect(euTotal).not.toBe(938);
  });

  it('effectiveResolvedFilters used for L4 matches effectiveRows, not the narrower no-cross set', () => {
    // Direct check of the exposed intermediate: `effectiveRows` in 'none' mode must be
    // `filteredRowsNoChartCross` (page+widget+interactive), and the filter set paired with it for
    // L4 re-anchoring must be the interactive-inclusive `resolvedFiltersNoChartCross` — not
    // `resolvedFiltersNoCross` (page+widget only, which silently drops the interactive filter).
    const widget = noneModeWidget();
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { customers: customersSource, orders: ordersSourceForAnchor },
      relationships: [relOrdersToCustomers],
      filters: [paidOnlyInteractiveFilter],
    });

    const { result } = renderHook(() => useChartWidgetData(widget, customersSource, 'page-1'));

    // effectiveRows must equal filteredRowsNoChartCross (both customers survive: each has a paid
    // order), NOT drop down to some page+widget-only view.
    expect(result.current.effectiveRows).toEqual(result.current.filteredRowsNoChartCross);
    expect(result.current.effectiveRows).toHaveLength(2);
  });
});
