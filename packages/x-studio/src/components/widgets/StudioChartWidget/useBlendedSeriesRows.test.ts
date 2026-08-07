/**
 * Tests for useBlendedSeriesRows.
 *
 * Focused regression coverage for the `addInflight` call at the adapter-backed foreign
 * source fetch site (see the `studioRequestCache.addInflight` call below): it must pass
 * `descriptor.sourceId` as the third argument, matching the pattern already used in
 * `useAdapterRows.ts`. Omitting it made `StudioRequestCache` fall back to its legacy
 * first-colon parse of the cacheKey to resolve the entry's sourceId — which truncates a
 * sourceId that itself contains a ':' (e.g. `db:public.products`), so the entry gets
 * filed under the wrong reverse-index bucket and `invalidateSource(realSourceId)` can
 * never find it.
 *
 * Context is mocked via vi.mock so useStudioSelector resolves against a mutable
 * `mockState` — matching the pattern used by the other widget/hook tests (see
 * test/studioContextMock.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@mui/internal-test-utils';
import { studioRequestCache, resolveRows } from '@mui/x-studio-core/engine';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
  StudioState,
  StudioWidgetOf,
} from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { useBlendedSeriesRows } from './useBlendedSeriesRows';

let mockState: StudioState;

vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

interface StateOverrides {
  widgets?: StudioState['doc']['widgets'];
  dataSources?: StudioState['runtime']['dataSources'];
}

function createState(overrides: StateOverrides = {}): StudioState {
  return {
    doc: {
      schemaVersion: 1,
      dashboard: { id: 'dash-1', title: 'Dashboard', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'Overview', widgetRows: [] } },
      widgets: overrides.widgets ?? {},
      relationships: [],
      filters: [],
      expressionFields: [],
    },
    session: {
      mode: 'view',
      shell: {
        openDrawers: { data: true, compose: true, filters: false },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
      },
    },
    runtime: {
      dataSources: overrides.dataSources ?? {},
    },
  };
}

const ordersSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'total', label: 'Total', type: 'number' },
  ],
  rows: [
    { id: 'o1', category: 'Electronics', total: 100 },
    { id: 'o2', category: 'Furniture', total: 30 },
  ],
};

// Deliberately contains a ':' — the exact class of sourceId the legacy cacheKey parse
// (`cacheKey.split(':')[0]`) truncates.
const COLON_SOURCE_ID = 'db:public.products';

// A second in-memory (no adapter) foreign source, used by the finding 2.2 regression
// tests below (cross-page leak, preset date range, calculated foreign field).
const inventorySource: StudioDataSource = {
  id: 'inventory',
  label: 'Inventory',
  fields: [
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'stock', label: 'Stock', type: 'number' },
    { id: 'unitPrice', label: 'Unit Price', type: 'number' },
    { id: 'restockedAt', label: 'Restocked At', type: 'date' },
  ],
  rows: [
    { id: 'i1', category: 'Electronics', stock: 12, unitPrice: 5 },
    { id: 'i2', category: 'Furniture', stock: 40, unitPrice: 20 },
  ],
};

function inventoryBlendedWidget(fieldId: string): StudioWidgetOf<'chart'> {
  return {
    id: 'chart-blend-inventory',
    kind: 'chart',
    title: 'Revenue vs Inventory by Category',
    sourceId: 'orders',
    config: {
      chartType: 'mixed',
      xField: 'category',
      ySeries: [
        { fieldId: 'total', sourceId: 'orders', type: 'bar', yAggregation: 'sum' },
        { fieldId, sourceId: 'inventory', type: 'line', yAggregation: 'sum' },
      ],
    },
  };
}

function blendedWidget(): StudioWidgetOf<'chart'> {
  return {
    id: 'chart-blend',
    kind: 'chart',
    title: 'Revenue vs Stock by Category',
    sourceId: 'orders',
    config: {
      chartType: 'mixed',
      xField: 'category',
      ySeries: [
        { fieldId: 'total', sourceId: 'orders', type: 'bar', yAggregation: 'sum' },
        { fieldId: 'stock', sourceId: COLON_SOURCE_ID, type: 'line', yAggregation: 'sum' },
      ],
    },
  };
}

beforeEach(() => {
  studioRequestCache.clear();
});

afterEach(() => {
  studioRequestCache.clear();
  vi.restoreAllMocks();
});

describe('useBlendedSeriesRows — adapter-backed foreign source caching', () => {
  it('invalidates the foreign-source cache entry via invalidateSource when the sourceId contains a colon', async () => {
    const getRows = vi.fn().mockResolvedValue({
      rows: [{ category: 'Electronics', stock: 12 }],
    });
    const colonSource: StudioDataSource = {
      id: COLON_SOURCE_ID,
      label: 'Products (external db)',
      fields: [
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'stock', label: 'Stock', type: 'number' },
      ],
      rows: undefined,
      adapter: { getRows },
    };
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, [COLON_SOURCE_ID]: colonSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    const widget = blendedWidget();
    renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    await waitFor(() => {
      expect(getRows).toHaveBeenCalled();
    });

    const cacheKey: string = getRows.mock.calls[0][0].cacheKey;
    // Sanity check: the descriptor's sourceId is the full colon-containing id, and the
    // cacheKey is prefixed with it (`${sourceId}:${queryShape}`).
    expect(getRows.mock.calls[0][0].sourceId).toBe(COLON_SOURCE_ID);
    expect(cacheKey.startsWith(`${COLON_SOURCE_ID}:`)).toBe(true);

    // The entry is namespaced to `colonSource.adapter` (the live adapter instance
    // `useBlendedSeriesRows` reads off `dataSources[sid]`), matching the Tier2 adapter-
    // isolation fix — an un-namespaced `get` would miss it entirely.
    await waitFor(() => {
      expect(studioRequestCache.get(cacheKey, colonSource.adapter)).toBeDefined();
    });

    // Invalidate using the TRUE (colon-containing) sourceId, as a host would after
    // `upsertDataSource` updates this source. If `addInflight` had not been given
    // `descriptor.sourceId`, the entry would have been filed under the legacy
    // first-colon-parsed bucket ('db') instead, and this invalidation would silently
    // miss it — leaving the stale entry cached.
    studioRequestCache.invalidateSource(COLON_SOURCE_ID);

    expect(studioRequestCache.get(cacheKey, colonSource.adapter)).toBeUndefined();
  });
});

describe('useBlendedSeriesRows — adapter-instance cache isolation (Tier2 fix)', () => {
  // Two `<Studio>` instances mounted in the same process (e.g. a multi-tenant admin console)
  // can be configured with the SAME sourceId string ("inventory") but DIFFERENT host adapters
  // (different tenant/auth/backend). `studioRequestCache` is a module-level singleton whose
  // cacheKey has no adapter-identity component, so without threading the live `adapter` object
  // through to `get`/`getInflight`/`addInflight`, the second instance would get a cache HIT on
  // the first instance's rows for an identical descriptor — a cross-tenant data leak.
  it('does not serve a different adapter instance the previous adapter instance rows for the same sourceId', async () => {
    const getRowsA = vi.fn().mockResolvedValue({
      rows: [{ category: 'Electronics', stock: 111 }],
    });
    const adapterA = { getRows: getRowsA };
    const widget = inventoryBlendedWidget('stock');

    // Instance A: mounts with adapterA.
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: {
        orders: ordersSource,
        inventory: { ...inventorySource, rows: undefined, adapter: adapterA },
      },
    });
    configureStudioContextMock({ getState: () => mockState });

    const { result: resultA, unmount: unmountA } = renderHook(() =>
      useBlendedSeriesRows(widget, 'page-1'),
    );
    await waitFor(() => {
      expect(getRowsA).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(resultA.current.foreignRowsBySource.get('inventory')).toEqual([
        { category: 'Electronics', stock: 111 },
      ]);
    });
    unmountA();

    // Instance B: a SEPARATE `<Studio>` instance, same sourceId string ("inventory") and the
    // SAME query shape (so the legacy un-namespaced cacheKey would be identical), but backed by
    // a DIFFERENT adapter object returning different rows (e.g. a different tenant's backend).
    const getRowsB = vi.fn().mockResolvedValue({
      rows: [{ category: 'Electronics', stock: 999 }],
    });
    const adapterB = { getRows: getRowsB };
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: {
        orders: ordersSource,
        inventory: { ...inventorySource, rows: undefined, adapter: adapterB },
      },
    });
    configureStudioContextMock({ getState: () => mockState });

    const { result: resultB, unmount: unmountB } = renderHook(() =>
      useBlendedSeriesRows(widget, 'page-1'),
    );

    // Before the fix: this would be a cache HIT on instance A's un-namespaced entry, so
    // `getRowsB` would never be called and instance B would render instance A's tenant's rows.
    await waitFor(() => {
      expect(getRowsB).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(resultB.current.foreignRowsBySource.get('inventory')).toEqual([
        { category: 'Electronics', stock: 999 },
      ]);
    });
    unmountB();
  });
});

describe('useBlendedSeriesRows — refetch failure must not serve stale rows (finding 2.4)', () => {
  it('clears the stale asyncForeignRows entry for a sid when its refetch fails', async () => {
    const getRows = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ category: 'Electronics', stock: 12 }] })
      .mockRejectedValueOnce(new Error('network error'));
    const colonSource: StudioDataSource = {
      id: COLON_SOURCE_ID,
      label: 'Products (external db)',
      fields: [
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'stock', label: 'Stock', type: 'number' },
      ],
      rows: undefined,
      adapter: { getRows },
    };
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, [COLON_SOURCE_ID]: colonSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    const widget = blendedWidget();
    const { result, rerender } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    // First fetch succeeds — the foreign source's rows are populated.
    await waitFor(() => {
      expect(result.current.foreignRowsBySource.get(COLON_SOURCE_ID)).toEqual([
        { category: 'Electronics', stock: 12 },
      ]);
    });

    // Add a page filter that applies to the foreign source's field — this changes the
    // per-source query descriptor (and its cacheKey), forcing a refetch. This time the
    // adapter's promise rejects.
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        filters: [
          {
            id: 'f1',
            field: 'category',
            operator: 'equals',
            value: 'Electronics',
            filterSourceId: COLON_SOURCE_ID,
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      },
    };
    rerender();

    await waitFor(() => {
      expect(getRows).toHaveBeenCalledTimes(2);
    });

    // The failed refetch must NOT leave the previous (pre-filter) rows serving
    // indefinitely — the stale entry for this sid is cleared rather than kept.
    await waitFor(() => {
      expect(result.current.foreignRowsBySource.has(COLON_SOURCE_ID)).toBe(false);
    });
  });
});

describe('useBlendedSeriesRows — a source that drops its adapter must not keep serving stale async rows (finding 2.2)', () => {
  it('prunes the stale asyncForeignRows entry once a foreign source is no longer adapter-backed', async () => {
    const getRows = vi.fn().mockResolvedValue({
      rows: [{ category: 'Electronics', stock: 999 }],
    });
    const adapterInventory: StudioDataSource = {
      ...inventorySource,
      rows: undefined,
      adapter: { getRows },
    };
    const widget = inventoryBlendedWidget('stock');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, inventory: adapterInventory },
    });
    configureStudioContextMock({ getState: () => mockState });

    const { result, rerender } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    // The adapter fetch resolves — the foreign rows come from the server (marked stock: 999).
    await waitFor(() => {
      expect(result.current.foreignRowsBySource.get('inventory')).toEqual([
        { category: 'Electronics', stock: 999 },
      ]);
    });

    // The host drops the adapter (e.g. `setDataSourceAdapter('inventory', undefined)` or a
    // `dataAdapters` swap): the source becomes plain in-memory again, with its own fresh rows.
    mockState = {
      ...mockState,
      runtime: {
        ...mockState.runtime,
        dataSources: { orders: ordersSource, inventory: inventorySource },
      },
    };
    rerender();

    // Without the prune, the last-fetched async rows (stock: 999) would linger in
    // `asyncForeignRows` forever and — since the merge applies async AFTER sync — permanently
    // shadow the freshly-resolved in-memory rows. After the fix the in-memory rows win.
    await waitFor(() => {
      const current = result.current.foreignRowsBySource.get('inventory');
      expect(current?.some((r) => r.stock === 999)).toBe(false);
    });
    const rows = result.current.foreignRowsBySource.get('inventory');
    expect(rows?.map((r) => r.stock).sort((a, b) => (a as number) - (b as number))).toEqual([
      12, 40,
    ]);
  });
});

describe('useBlendedSeriesRows — page-scoped filters must not leak across pages (finding 2.2, facet a)', () => {
  it('does not apply a page filter scoped to a DIFFERENT page to a foreign sync source', () => {
    const widget = inventoryBlendedWidget('stock');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, inventory: inventorySource },
    });
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        filters: [
          {
            id: 'f-other-page',
            field: 'category',
            operator: 'equals',
            value: 'Electronics',
            filterSourceId: 'inventory',
            scope: { kind: 'page', pageId: 'page-2' },
          },
        ],
      },
    };
    configureStudioContextMock({ getState: () => mockState });

    // The chart lives on page-1 — a filter scoped to page-2 must not constrain it.
    const { result } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    // Before the fix, `pageFilters` kept every `scope.kind === 'page'` filter without
    // checking `scope.pageId`, so this page-2 filter incorrectly narrowed the foreign
    // series down to the single 'Electronics' row.
    expect(result.current.foreignRowsBySource.get('inventory')).toHaveLength(2);
  });

  it('DOES apply a page filter scoped to the same page as the chart (contrast case)', () => {
    const widget = inventoryBlendedWidget('stock');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, inventory: inventorySource },
    });
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        filters: [
          {
            id: 'f-same-page',
            field: 'category',
            operator: 'equals',
            value: 'Electronics',
            filterSourceId: 'inventory',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      },
    };
    configureStudioContextMock({ getState: () => mockState });

    const { result } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    const rows = result.current.foreignRowsBySource.get('inventory');
    expect(rows).toHaveLength(1);
    expect(rows?.[0].category).toBe('Electronics');
  });
});

describe('useBlendedSeriesRows — a filterSourceId-scoped filter must not apply by field-name collision (finding 2.4)', () => {
  it('does NOT apply a filter with filterSourceId pointing at a DIFFERENT source to a foreign series sharing the same field name', () => {
    // Both `orders` and `inventory` have a field literally named `category` — a filter
    // authored against `orders` (filterSourceId: 'orders') must stay unconstrained on
    // the foreign `inventory` series, even though `category` also exists there.
    const widget = inventoryBlendedWidget('stock');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, inventory: inventorySource },
    });
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        filters: [
          {
            id: 'f-orders-scoped',
            field: 'category',
            operator: 'equals',
            value: 'Electronics',
            filterSourceId: 'orders',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      },
    };
    configureStudioContextMock({ getState: () => mockState });

    const { result } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    // Before the fix, the gate matched purely by field-name existence on `inventory`, so
    // this orders-scoped filter incorrectly hard-filtered the foreign series down to a
    // single row. After the fix it stays fully unconstrained (both inventory rows).
    expect(result.current.foreignRowsBySource.get('inventory')).toHaveLength(2);
  });

  it('DOES apply a filter whose filterSourceId matches the foreign source (contrast case)', () => {
    const widget = inventoryBlendedWidget('stock');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, inventory: inventorySource },
    });
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        filters: [
          {
            id: 'f-inventory-scoped',
            field: 'category',
            operator: 'equals',
            value: 'Electronics',
            filterSourceId: 'inventory',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      },
    };
    configureStudioContextMock({ getState: () => mockState });

    const { result } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    const rows = result.current.foreignRowsBySource.get('inventory');
    expect(rows).toHaveLength(1);
    expect(rows?.[0].category).toBe('Electronics');
  });

  it('DOES apply a filter with no filterSourceId at all to a foreign series matching by field name (unscoped filters still apply)', () => {
    const widget = inventoryBlendedWidget('stock');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, inventory: inventorySource },
    });
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        filters: [
          {
            id: 'f-unscoped',
            field: 'category',
            operator: 'equals',
            value: 'Electronics',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      },
    };
    configureStudioContextMock({ getState: () => mockState });

    const { result } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    const rows = result.current.foreignRowsBySource.get('inventory');
    expect(rows).toHaveLength(1);
    expect(rows?.[0].category).toBe('Electronics');
  });
});

describe('useBlendedSeriesRows — dashboard date-range presets must be resolved, not skipped (finding 2.2, facet b)', () => {
  it('resolves a dashboard-date-range preset filter and applies it to a foreign sync source', () => {
    const today = new Date().toISOString().slice(0, 10);
    const fiveYearsAgo = `${new Date().getFullYear() - 5}-01-01`;
    const dateScopedInventory: StudioDataSource = {
      ...inventorySource,
      rows: [
        { id: 'i1', category: 'Electronics', stock: 12, unitPrice: 5, restockedAt: today },
        { id: 'i2', category: 'Furniture', stock: 40, unitPrice: 20, restockedAt: fiveYearsAgo },
      ],
    };
    const widget = inventoryBlendedWidget('stock');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, inventory: dateScopedInventory },
    });
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        filters: [
          {
            id: 'f-date-range',
            field: 'restockedAt',
            fieldType: 'date',
            operator: 'between',
            // A preset filter's value stays `null` until resolved at query time — see
            // `resolveDateRangePresets`.
            value: null,
            dateRangePreset: 'last_3_months',
            scope: { kind: 'dashboard-date-range', sourceId: 'inventory', pageId: 'page-1' },
          },
        ],
      },
    };
    configureStudioContextMock({ getState: () => mockState });

    const { result } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    const rows = result.current.foreignRowsBySource.get('inventory');
    // Before the fix, `isConditionComplete('between', null)` was `false`, so the whole
    // filter was treated as incomplete and skipped — both the recent AND the
    // 5-year-old row would render (unfiltered, all-time), instead of only the row
    // within the "last 3 months" window.
    expect(rows).toHaveLength(1);
    expect(rows?.[0].id).toBe('i1');
  });
});

describe('useBlendedSeriesRows — a foreign calculated field must be enriched, not render as zero (finding 2.2, facet c)', () => {
  const stockValueExpr: StudioExpressionField = {
    id: 'stockValue',
    label: 'Stock Value',
    sourceId: 'inventory',
    isMeasure: false,
    expression: {
      operator: 'multiply',
      inputs: [{ id: 'stock' }, { id: 'unitPrice' }],
    },
  };

  it('enriches a calculated field used as a foreign blended series on the sync (in-memory) path', () => {
    const widget = inventoryBlendedWidget('stockValue');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, inventory: inventorySource },
    });
    mockState = {
      ...mockState,
      doc: { ...mockState.doc, expressionFields: [stockValueExpr] },
    };
    configureStudioContextMock({ getState: () => mockState });

    const { result } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    const rows = result.current.foreignRowsBySource.get('inventory');
    // Before the fix, `expressionFields: []` was passed to `resolveRowsCached`, so
    // `stockValue` was never L2-enriched — every row's value was `undefined`, which
    // renders as zero after aggregation.
    expect(rows?.find((r) => r.id === 'i1')?.stockValue).toBe(60);
    expect(rows?.find((r) => r.id === 'i2')?.stockValue).toBe(800);
  });

  it('enriches a calculated field used as a foreign blended series on the adapter path', async () => {
    const getRows = vi.fn().mockResolvedValue({
      rows: [
        { category: 'Electronics', stock: 12, unitPrice: 5 },
        { category: 'Furniture', stock: 40, unitPrice: 20 },
      ],
    });
    const adapterInventory: StudioDataSource = {
      ...inventorySource,
      rows: undefined,
      adapter: { getRows },
    };
    const widget = inventoryBlendedWidget('stockValue');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, inventory: adapterInventory },
    });
    mockState = {
      ...mockState,
      doc: { ...mockState.doc, expressionFields: [stockValueExpr] },
    };
    configureStudioContextMock({ getState: () => mockState });

    const { result } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    await waitFor(() => {
      expect(getRows).toHaveBeenCalled();
    });

    // Before the fix, the adapter path never enriched the returned rows (no
    // `getCachedEnrichedRows` pass), so `stockValue` would be `undefined` on every row.
    await waitFor(() => {
      const rows = result.current.foreignRowsBySource.get('inventory');
      expect(rows?.find((r) => r.category === 'Electronics')?.stockValue).toBe(60);
    });
    const rows = result.current.foreignRowsBySource.get('inventory');
    expect(rows?.find((r) => r.category === 'Furniture')?.stockValue).toBe(800);
  });
});

describe("useBlendedSeriesRows — a filter on the foreign source's OWN expression field must apply (finding 2.3)", () => {
  // stockValue = stock * unitPrice: i1 (Electronics) = 12*5 = 60, i2 (Furniture) = 40*20 = 800.
  const stockValueExpr: StudioExpressionField = {
    id: 'stockValue',
    label: 'Stock Value',
    sourceId: 'inventory',
    isMeasure: false,
    expression: {
      operator: 'multiply',
      inputs: [{ id: 'stock' }, { id: 'unitPrice' }],
    },
  };

  // A page filter authored against `inventory.stockValue` (a calculated column owned by
  // the foreign source, not a native field) — no `filterSourceId` set, matching how the
  // Filters Drawer emits page filters on expression fields (L3 derives ownership on the
  // fly; this hook must do the same for its independent in-source evaluation).
  const stockValueFilter: StudioFilterState = {
    id: 'f-stockvalue',
    field: 'stockValue',
    operator: 'greater_than',
    value: 100,
    scope: { kind: 'page', pageId: 'page-1' },
  } as StudioFilterState;

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-orders-inventory',
      sourceId: 'orders',
      sourceField: 'category',
      targetId: 'inventory',
      targetField: 'category',
      type: 'many-to-one',
    },
  ];

  it("applies a filter on the foreign source's own (non-measure) expression field to its blended series rows", () => {
    const widget = inventoryBlendedWidget('stockValue');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources: { orders: ordersSource, inventory: inventorySource },
    });
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        relationships,
        expressionFields: [stockValueExpr],
        filters: [stockValueFilter],
      },
    };
    configureStudioContextMock({ getState: () => mockState });

    const { result } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    // Before the fix, the applicability gate only matched `src.fields` (native fields),
    // so a filter on the calculated `stockValue` column was dropped entirely and BOTH
    // inventory rows (Electronics stockValue=60, Furniture stockValue=800) would render
    // unfiltered. After the fix, only the row whose calculated value clears the
    // threshold survives.
    const rows = result.current.foreignRowsBySource.get('inventory');
    expect(rows).toHaveLength(1);
    expect(rows?.[0].category).toBe('Furniture');
  });

  it("agrees with the primary series' own L3 filter evaluation of the same expression-field filter", () => {
    // The primary series (widget source = orders) honours this exact filter shape via
    // `resolveRows`'s derived-ownership cross-filter routing (a page filter on an
    // expression field owned by another source becomes a semi-join): only orders rows
    // whose related inventory row's `stockValue` clears the threshold survive.
    const dataSources = { orders: ordersSource, inventory: inventorySource };
    const primaryRows = resolveRows(
      ordersSource.rows!,
      'orders',
      [stockValueFilter],
      dataSources,
      relationships,
      [stockValueExpr],
    );
    // Only the Furniture order survives the semi-join (its related inventory.stockValue
    // is 800 > 100); the Electronics order's related inventory.stockValue is 60, so it
    // is dropped.
    expect(primaryRows.map((r) => r.category)).toEqual(['Furniture']);

    // The foreign blended series (source = inventory) evaluates the SAME filter
    // directly in-source (now that the applicability gate recognizes the foreign
    // source's own expression fields, per the fix above).
    const widget = inventoryBlendedWidget('stockValue');
    mockState = createState({
      widgets: { [widget.id]: widget },
      dataSources,
    });
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        relationships,
        expressionFields: [stockValueExpr],
        filters: [stockValueFilter],
      },
    };
    configureStudioContextMock({ getState: () => mockState });

    const { result } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));
    const foreignRows = result.current.foreignRowsBySource.get('inventory');

    // Both series agree: only the 'Furniture' category clears the filter on either side.
    expect(foreignRows?.map((r) => r.category)).toEqual(primaryRows.map((r) => r.category));
  });
});
