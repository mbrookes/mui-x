/**
 * Tests for useChartWidgetData's cross-source blending path (mixed charts whose
 * ySeries reference different data sources, aligned on a shared categorical xField).
 *
 * Context is mocked via vi.mock so useStudioSelector resolves against a mutable
 * `mockState` — matching the pattern used by the other widget/hook tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@mui/internal-test-utils';
import type { StudioDataSource, StudioState, StudioWidget } from '../../../models';
import { studioRequestCache } from '../../../internals/StudioRequestCache';
// Static import is safe here: vitest hoists vi.mock() above all imports, and the
// mock factory reads `mockState` lazily via closure (resolved at selector-call time).
// Matches the sibling StudioChartWidget.test.tsx; avoids the per-test dynamic import
// whose heavy module graph could exceed the hook timeout under parallel load.
import { useChartWidgetData } from './useChartWidgetData';

let mockState: StudioState;

vi.mock('../../../context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../context')>();
  return {
    ...actual,
    useStudioSelector: (selector: (state: StudioState) => unknown) => selector(mockState),
  };
});

function createState(overrides: Partial<StudioState> = {}): StudioState {
  return {
    schemaVersion: 1,
    mode: 'view',
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
    dataSources: overrides.dataSources ?? {},
    relationships: overrides.relationships ?? [],
    filters: overrides.filters ?? [],
    expressionFields: overrides.expressionFields ?? [],
    shell: {
      openDrawers: { data: true, compose: true, filters: false },
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
      ...overrides.shell,
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

function blendedWidget(): StudioWidget {
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
});

afterEach(() => {
  studioRequestCache.clear();
  vi.restoreAllMocks();
});

describe('useChartWidgetData — cross-source blending', () => {
  it('flags the chart as blended', () => {
    const widget = blendedWidget();
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource));
    expect(result.current.isBlended).toBe(true);
  });

  it('aggregates the primary series from its own source despite a related foreign field', () => {
    const widget = blendedWidget();
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource));
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
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource));
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
    const countWidget: StudioWidget = {
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

    const { result } = renderHook(() => useChartWidgetData(countWidget, contactsSource));
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
    const { result } = renderHook(() => useChartWidgetData(widget, ordersSource));

    await waitFor(() => {
      const stockSeries = result.current.multiYData?.series.find((s) => s.fieldId === 'stock');
      const ent = result.current.multiYData?.labels.indexOf('Electronics') ?? -1;
      expect(stockSeries?.values[ent]).toBe(12);
    });
    expect(getRows).toHaveBeenCalled();
    // The foreign source must be queried on its own (no cross-source JOIN on the widget).
    expect(getRows.mock.calls[0][0].sourceId).toBe('products');
  });
});
