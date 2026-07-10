import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StudioController } from '../../store/StudioController';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
  StudioWidget,
  StudioWidgetConfig,
} from '../../models';
import { exportGridToCsv, exportChartToPng, downloadCsv } from '../../internals/widgetUtils';
import { buildQueryDescriptor, buildWidgetQueryDescriptor } from '../../internals/queryDescriptor';
import { studioRequestCache } from '../../internals/StudioRequestCache';
import { runWidgetExport } from './widgetExport';

vi.mock('../../internals/widgetUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../internals/widgetUtils')>();
  return { ...actual, exportGridToCsv: vi.fn(), exportChartToPng: vi.fn(), downloadCsv: vi.fn() };
});

const source: StudioDataSource = {
  id: 's1',
  label: 'Source',
  fields: [{ id: 'status', label: 'Status', type: 'string' }],
  rows: [{ status: 'active' }, { status: 'inactive' }],
};

function makeController(widget: StudioWidget, dataSources: Record<string, StudioDataSource> = {}) {
  return new StudioController({
    doc: { widgets: { [widget.id]: widget } },
    runtime: { dataSources },
  });
}

describe('runWidgetExport', () => {
  beforeEach(() => {
    vi.mocked(exportGridToCsv).mockClear();
    vi.mocked(exportChartToPng).mockClear();
    vi.mocked(downloadCsv).mockClear();
    studioRequestCache.clear();
  });

  it('dispatches a grid widget to CSV export with cross-filter-resolved rows', () => {
    const widget: StudioWidget = {
      id: 'w1',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };
    const controller = makeController(widget, { s1: source });

    runWidgetExport({
      widget,
      source,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [passedWidget, passedSource, rows] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(passedWidget).toBe(widget);
    expect(passedSource).toBe(source);
    expect(rows).toEqual([{ status: 'active' }, { status: 'inactive' }]);
    expect(exportChartToPng).not.toHaveBeenCalled();
  });

  it('dispatches a chart widget to PNG export with its container and background colour', () => {
    const widget: StudioWidget = {
      id: 'w2',
      kind: 'chart',
      title: 'Chart',
      sourceId: 's1',
      config: { chartType: 'bar' } as StudioWidgetConfig,
    };
    const controller = makeController(widget, { s1: source });
    const container = document.createElement('div');

    runWidgetExport({
      widget,
      source,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: container,
      imperativeExport: null,
      chartBackgroundColor: '#fff',
    });

    expect(exportChartToPng).toHaveBeenCalledTimes(1);
    expect(vi.mocked(exportChartToPng).mock.calls[0]).toEqual([widget, container, '#fff']);
    expect(exportGridToCsv).not.toHaveBeenCalled();
  });

  // Regression coverage for finding 2.19: a cross-source display column (a grid column whose
  // `sourceId` differs from the widget's primary source) is joined onto rows for DISPLAY by
  // `useWidgetRows.ts`'s `enrichWithCrossSourceFields`, but the export path used to call
  // `pipeline.resolveWidgetRows` directly and hand the (un-enriched) rows straight to
  // `exportGridToCsv` — so a cross-source column rendered correctly on screen but exported as
  // an empty column. Assert the exported rows now carry the joined value.
  it('enriches cross-source display columns in the exported rows, matching what the grid displays', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'customerId', label: 'Customer', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: 'o1', customerId: 'c1', total: 100 },
        { id: 'o2', customerId: 'c2', total: 50 },
      ],
    };
    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'company', label: 'Company', type: 'string' },
      ],
      rows: [
        { id: 'c1', company: 'Acme' },
        { id: 'c2', company: 'Globex' },
      ],
    };
    const relationships: StudioRelationship[] = [
      {
        id: 'rel-orders-customers',
        type: 'many-to-one',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
      },
    ];
    const widget: StudioWidget = {
      id: 'w4',
      kind: 'grid',
      title: 'Orders',
      sourceId: 'orders',
      config: {
        columns: [
          { fieldId: 'total' },
          // Cross-source display column — `sourceId` differs from the widget's own source.
          { fieldId: 'company', sourceId: 'customers' },
        ],
      } as StudioWidgetConfig,
    };
    const controller = new StudioController({
      doc: {
        widgets: { [widget.id]: widget },
        relationships,
      },
      runtime: { dataSources: { orders: ordersSource, customers: customersSource } },
    });

    runWidgetExport({
      widget,
      source: ordersSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [, , rows] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(rows).toHaveLength(2);
    // `toMatchObject` (rather than `toEqual`) sidesteps the enumerable row-identity symbol
    // that cross-source enrichment stamps onto each row (see internals/rowIdentity.ts) —
    // irrelevant to this assertion, which only cares about the joined `company` value.
    expect(rows[0]).toMatchObject({ id: 'o1', customerId: 'c1', total: 100, company: 'Acme' });
    expect(rows[1]).toMatchObject({ id: 'o2', customerId: 'c2', total: 50, company: 'Globex' });
  });

  // ─── Adapter-backed grid CSV export (finding 2.9) ─────────────────────────────
  //
  // An adapter-backed source never populates `source.rows` — fetched rows live only
  // in the on-screen grid's local `useAdapterRows` state, seeded from (and written
  // back to) the module-singleton `studioRequestCache`. `runWidgetExport` must read
  // from that same cache entry instead of unconditionally reading `source.rows` (an
  // always-empty array for an adapter source).

  it('reads adapter-backed rows from the request cache instead of exporting an empty file', () => {
    const adapterSource: StudioDataSource = {
      id: 's1',
      label: 'Source',
      fields: [{ id: 'status', label: 'Status', type: 'string' }],
      // No `rows` — adapter-backed sources never populate this in-memory.
      adapter: { getRows: vi.fn() },
    };
    const widget: StudioWidget = {
      id: 'w5',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };
    const controller = makeController(widget, { s1: adapterSource });
    const state = controller.getState();
    const descriptor = buildQueryDescriptor(widget, state.doc.filters, 'page-1', undefined, []);
    studioRequestCache.set(descriptor.cacheKey, { rows: [{ status: 'active' }] }, 's1');

    runWidgetExport({
      widget,
      source: adapterSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    expect(downloadCsv).not.toHaveBeenCalled();
    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [, , rows] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(rows).toEqual([{ status: 'active' }]);
  });

  it('downloads an explanatory message instead of a silently empty file on an adapter cache miss', () => {
    const adapterSource: StudioDataSource = {
      id: 's1',
      label: 'Source',
      fields: [{ id: 'status', label: 'Status', type: 'string' }],
      adapter: { getRows: vi.fn() },
    };
    const widget: StudioWidget = {
      id: 'w6',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };
    const controller = makeController(widget, { s1: adapterSource });

    runWidgetExport({
      widget,
      source: adapterSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    // No cached rows yet (cold cache) — must not silently export an empty CSV.
    expect(exportGridToCsv).not.toHaveBeenCalled();
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [message, filename] = vi.mocked(downloadCsv).mock.calls[0];
    expect(message).toMatch(/no data available/i);
    expect(filename).toBe('Grid_export.csv');
  });

  it('a genuinely empty query result (cache hit, zero rows) still exports normally, not the cache-miss message', () => {
    const adapterSource: StudioDataSource = {
      id: 's1',
      label: 'Source',
      fields: [{ id: 'status', label: 'Status', type: 'string' }],
      adapter: { getRows: vi.fn() },
    };
    const widget: StudioWidget = {
      id: 'w7',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };
    const controller = makeController(widget, { s1: adapterSource });
    const state = controller.getState();
    const descriptor = buildQueryDescriptor(widget, state.doc.filters, 'page-1', undefined, []);
    studioRequestCache.set(descriptor.cacheKey, { rows: [] }, 's1');

    runWidgetExport({
      widget,
      source: adapterSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    expect(downloadCsv).not.toHaveBeenCalled();
    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [, , rows] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(rows).toEqual([]);
  });

  // ─── CSV export folds in own-source expression fields (grid CSV header/format drift) ──

  it("passes the widget's own-source expression fields through to exportGridToCsv", () => {
    const widget: StudioWidget = {
      id: 'w8',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };
    const ownField: StudioExpressionField = {
      id: 'margin',
      label: 'Margin',
      sourceId: 's1',
      isMeasure: false,
      expression: { type: 'number', value: 0 },
      format: 'currency',
    };
    const otherSourceField: StudioExpressionField = {
      id: 'unrelated',
      label: 'Unrelated',
      sourceId: 'other-source',
      isMeasure: false,
      expression: { type: 'number', value: 0 },
    };
    const controller = new StudioController({
      doc: {
        widgets: { [widget.id]: widget },
        expressionFields: [ownField, otherSourceField],
      },
      runtime: { dataSources: { s1: source } },
    });

    runWidgetExport({
      widget,
      source,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [, , , passedExpressionFields] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(passedExpressionFields).toEqual([ownField]);
  });

  // ─── Cross-source column defs + related-source calculated columns (findings 2.6, 2.3) ──

  it('passes resolved cross-source field defs to exportGridToCsv so the CSV header/format matches the grid (2.6)', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'customerId', label: 'Customer', type: 'string' },
      ],
      rows: [{ id: 'o1', customerId: 'c1' }],
    };
    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        {
          id: 'lifetimeValue',
          label: 'Lifetime Value',
          type: 'number',
          format: 'currency',
          currencyCode: 'USD',
        },
      ],
      rows: [{ id: 'c1', lifetimeValue: 999 }],
    };
    const relationships: StudioRelationship[] = [
      {
        id: 'rel-orders-customers',
        type: 'many-to-one',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
      },
    ];
    const widget: StudioWidget = {
      id: 'w9',
      kind: 'grid',
      title: 'Orders',
      sourceId: 'orders',
      config: {
        columns: [{ fieldId: 'id' }, { fieldId: 'lifetimeValue', sourceId: 'customers' }],
      } as StudioWidgetConfig,
    };
    const controller = new StudioController({
      doc: { widgets: { [widget.id]: widget }, relationships },
      runtime: { dataSources: { orders: ordersSource, customers: customersSource } },
    });

    runWidgetExport({
      widget,
      source: ordersSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [, , rows, , crossSourceFieldDefs] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(rows[0]).toMatchObject({ id: 'o1', lifetimeValue: 999 });
    // The resolved def (the related source's physical field) is threaded through so the CSV
    // header uses "Lifetime Value" and the value gets currency formatting.
    expect(crossSourceFieldDefs).toEqual([
      {
        id: 'lifetimeValue',
        label: 'Lifetime Value',
        type: 'number',
        format: 'currency',
        currencyCode: 'USD',
      },
    ]);
  });

  it('resolves a related-source calculated cross-source column value + def in the export (2.3)', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'customerId', label: 'Customer', type: 'string' },
      ],
      rows: [{ id: 'o1', customerId: 'c1' }],
    };
    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'spend', label: 'Spend', type: 'number' },
      ],
      rows: [{ id: 'c1', spend: 100 }],
    };
    const relationships: StudioRelationship[] = [
      {
        id: 'rel-orders-customers',
        type: 'many-to-one',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
      },
    ];
    // customers.bonus = spend * 2 — a related-source calculated column.
    const bonusExpr: StudioExpressionField = {
      id: 'bonus',
      label: 'Bonus',
      sourceId: 'customers',
      isMeasure: false,
      expression: {
        operator: 'multiply',
        inputs: [{ id: 'spend' }, { type: 'number', value: 2 }],
      },
    } as unknown as StudioExpressionField;
    const widget: StudioWidget = {
      id: 'w10',
      kind: 'grid',
      title: 'Orders',
      sourceId: 'orders',
      config: {
        columns: [{ fieldId: 'id' }, { fieldId: 'bonus', sourceId: 'customers' }],
      } as StudioWidgetConfig,
    };
    const controller = new StudioController({
      doc: {
        widgets: { [widget.id]: widget },
        relationships,
        expressionFields: [bonusExpr],
      },
      runtime: { dataSources: { orders: ordersSource, customers: customersSource } },
    });

    runWidgetExport({
      widget,
      source: ordersSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [, , rows, , crossSourceFieldDefs] = vi.mocked(exportGridToCsv).mock.calls[0];
    // Value resolved via the L2 pass over the related source (bonus = 100 * 2 = 200)...
    expect(rows[0]).toMatchObject({ id: 'o1', bonus: 200 });
    // ...and its def resolved from the related source's expression field.
    expect(crossSourceFieldDefs).toEqual([{ id: 'bonus', label: 'Bonus', type: 'number' }]);
  });

  // ─── Descriptor-signature drift regression (finding 2.3) ──────────────────────
  //
  // The CSV export path used to rebuild the adapter descriptor via
  // `buildQueryDescriptor(widget, filters, pageId, tableName, expressionFields)` — omitting
  // `relationships` and `crossFilterAllPages`, both of which feed `cacheKey`. For a grouped
  // grid with cross-source relationships and `crossFilterAllPages` enabled, that produced a
  // DIFFERENT cacheKey than the live grid's `useAdapterRows` descriptor, so the export's cache
  // lookup missed an entry the on-screen grid had already populated and fell back to the
  // "No data available to export yet" message even though the grid was showing data. Both call
  // sites now go through the shared `buildWidgetQueryDescriptor` helper, which requires the
  // full state object (no defaults to silently fall back to).
  it('hits the SAME cache entry the live grid populated for a grouped grid with cross-source relationships + crossFilterAllPages (finding 2.3)', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
        { id: 'customerId', label: 'Customer', type: 'string' },
      ],
      // No `rows` — adapter-backed source; fetched rows only ever live in the request cache.
      adapter: { getRows: vi.fn() },
    };
    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [{ id: 'id', label: 'ID', type: 'string' }],
      rows: [{ id: 'c1' }],
    };
    const relationships: StudioRelationship[] = [
      {
        id: 'rel-orders-customers',
        type: 'many-to-one',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
      },
    ];
    const widget: StudioWidget = {
      id: 'w11',
      kind: 'grid',
      title: 'Orders',
      sourceId: 'orders',
      config: {
        gridGroupByField: 'category',
        columns: [{ fieldId: 'category' }, { fieldId: 'total', aggregationFn: 'sum' }],
      } as StudioWidgetConfig,
    };
    // A cross-page cross-filter: only counts as "incoming" — and therefore only perturbs the
    // cacheKey, since this grouped grid has a server-side aggregation to strip — when
    // `crossFilterAllPages` is threaded through. This is exactly the flag the pre-fix export
    // descriptor dropped.
    const crossPageCrossFilter: StudioFilterState = {
      id: 'cf1',
      field: 'category',
      operator: 'equals',
      value: 'Electronics',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'other-page' },
    };
    const controller = new StudioController({
      doc: {
        widgets: { [widget.id]: widget },
        relationships,
        filters: [crossPageCrossFilter],
      },
      runtime: { dataSources: { orders: ordersSource, customers: customersSource } },
    });
    controller.setCrossFilterAllPages(true);
    const state = controller.getState();

    // Build the descriptor the SAME way the live-render path (`useAdapterRows`) does, and
    // assert its cacheKey is identical to the one the export path computes — the direct
    // equality assertion the regression is about.
    const liveRenderDescriptor = buildWidgetQueryDescriptor(widget, 'page-1', 'orders', {
      filters: state.doc.filters,
      expressionFields: state.doc.expressionFields,
      relationships: state.doc.relationships,
      crossFilterAllPages: state.doc.dashboard.crossFilterAllPages ?? false,
    });
    expect(liveRenderDescriptor.hasIncomingCrossOrInteractiveFilters).toBe(true);

    // Seed the cache exactly as the on-screen grid would have (via `useAdapterRows`).
    const cachedRows = [{ category: 'Electronics', total: 500 }];
    studioRequestCache.set(liveRenderDescriptor.cacheKey, { rows: cachedRows }, 'orders');

    runWidgetExport({
      widget,
      source: ordersSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    // Cache HIT: the export must not fall back to the "no data" placeholder.
    expect(downloadCsv).not.toHaveBeenCalled();
    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
  });

  it('delegates pivot and custom-kind widgets to their imperative export handler', () => {
    const pivot: StudioWidget = {
      id: 'w3',
      kind: 'pivot',
      title: 'Pivot',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };
    const imperativeExport = vi.fn();
    runWidgetExport({
      widget: pivot,
      source,
      controller: makeController(pivot, { s1: source }),
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport,
    });
    expect(imperativeExport).toHaveBeenCalledTimes(1);
    expect(exportGridToCsv).not.toHaveBeenCalled();
    expect(exportChartToPng).not.toHaveBeenCalled();
  });
});
