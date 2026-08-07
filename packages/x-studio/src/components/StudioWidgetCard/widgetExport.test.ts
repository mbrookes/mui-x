import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
import {
  buildQueryDescriptor,
  buildWidgetQueryDescriptor,
  studioRequestCache,
  DEFAULT_STUDIO_LOCALE_TEXT,
} from '@mui/x-studio-core/engine';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
  StudioWidget,
  StudioWidgetConfig,
} from '../../models';
import { exportChartToPng, exportGridToCsv, downloadCsv } from '../../internals/widgetPresentation';
import {
  setGridViewSortModel,
  clearGridViewSortModel,
} from '../widgets/StudioGridWidget/gridViewSortRegistry';
import { runWidgetExport } from './widgetExport';

// `exportGridToCsv`/`downloadCsv` need a DOM, so they live in `widgetPresentation.tsx` alongside
// `exportChartToPng` rather than in the engine's pure `widgetUtils.ts`.
// `exportChartToPng` needs a live DOM node, so it lives in `widgetPresentation.tsx` with the
// other React-dependent helpers rather than in the pure `widgetUtils.ts`.
vi.mock('../../internals/widgetPresentation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../internals/widgetPresentation')>();
  return { ...actual, exportChartToPng: vi.fn(), exportGridToCsv: vi.fn(), downloadCsv: vi.fn() };
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
    // `exportChartToPng` reports whether it found a chart surface to rasterize; the default
    // for these tests is "yes, it exported".
    vi.mocked(exportChartToPng).mockReset().mockReturnValue(true);
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
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });

    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [passedWidget, passedSource, rows] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(passedWidget).toBe(widget);
    expect(passedSource).toBe(source);
    expect(rows).toEqual([{ status: 'active' }, { status: 'inactive' }]);
    expect(exportChartToPng).not.toHaveBeenCalled();
  });

  // The grid has no post-aggregation rank path, so a widget-scoped Top-N must be reduced at L3
  // or the CSV would export every row while the on-screen grid shows only the top N. That rule
  // is no longer hardcoded here — `resolveWidgetRows` resolves `shouldApplyWidgetRankAtL3` from
  // the widget object this path now passes it.
  it('applies a widget-scoped Top-N rank filter to the exported rows', () => {
    const rankSource: StudioDataSource = {
      id: 's1',
      label: 'Source',
      fields: [
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number' },
      ],
      rows: [
        { region: 'EU', amount: 100 },
        { region: 'US', amount: 300 },
        { region: 'APAC', amount: 200 },
      ],
    };
    const widget: StudioWidget = {
      id: 'w-rank',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };
    const rankFilter = {
      id: 'f-rank',
      field: 'amount',
      // `operator` is REQUIRED on every `StudioFilterState`, rank-mode entries included: the
      // drawer stamps `equals` when a filter is created and `buildModeReset` never clears it,
      // so a rank filter with no operator is a shape production never produces. The doc screen
      // drops it (matching the wire boundary), which silently disabled the rank this test is
      // about.
      operator: 'equals',
      filterMode: 'rank',
      value: 2,
      rankDirection: 'top',
      scope: { kind: 'widget', widgetId: 'w-rank' },
    } as unknown as StudioFilterState;
    const controller = new StudioController({
      doc: { widgets: { [widget.id]: widget }, filters: [rankFilter] },
      runtime: { dataSources: { s1: rankSource } },
    });

    runWidgetExport({
      widget,
      source: rankSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });

    const rows = vi.mocked(exportGridToCsv).mock.calls[0][2];
    // Top 2 by amount: US (300) and APAC (200).
    expect(rows.map((r) => r.region).sort()).toEqual(['APAC', 'US']);
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
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
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
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
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
    // Namespaced to `adapterSource.adapter` — the live adapter instance `runWidgetExport`
    // reads off `source?.adapter` — matching the Tier2 adapter-isolation fix.
    studioRequestCache.set(
      descriptor.cacheKey,
      { rows: [{ status: 'active' }] },
      's1',
      adapterSource.adapter,
    );

    runWidgetExport({
      widget,
      source: adapterSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
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
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
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
    studioRequestCache.set(descriptor.cacheKey, { rows: [] }, 's1', adapterSource.adapter);

    runWidgetExport({
      widget,
      source: adapterSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
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
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
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
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
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
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
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

    // Seed the cache exactly as the on-screen grid would have (via `useAdapterRows`),
    // namespaced to `ordersSource.adapter` — the live adapter instance `runWidgetExport`
    // reads off `source?.adapter` — matching the Tier2 adapter-isolation fix.
    const cachedRows = [{ category: 'Electronics', total: 500 }];
    studioRequestCache.set(
      liveRenderDescriptor.cacheKey,
      { rows: cachedRows },
      'orders',
      ordersSource.adapter,
    );

    runWidgetExport({
      widget,
      source: ordersSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });

    // Cache HIT: the export must not fall back to the "no data" placeholder.
    expect(downloadCsv).not.toHaveBeenCalled();
    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
  });

  // ─── Adapter-instance cache isolation (Tier2 fix) ──────────────────────────────
  //
  // Two `<Studio>` instances sharing a `sourceId` string but backed by DIFFERENT host
  // adapters must not export each other's cached rows. `runWidgetExport` must pass the
  // live `source.adapter` through to `studioRequestCache.get`, matching the on-screen
  // grid's `useAdapterRows` call site.

  it('does not export a DIFFERENT adapter instance rows cached under the same cacheKey', () => {
    const widget: StudioWidget = {
      id: 'w12',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };
    const adapterA = { getRows: vi.fn() };
    const adapterASource: StudioDataSource = {
      id: 's1',
      label: 'Source',
      fields: [{ id: 'status', label: 'Status', type: 'string' }],
      adapter: adapterA,
    };
    const controllerA = makeController(widget, { s1: adapterASource });
    const stateA = controllerA.getState();
    const descriptorA = buildWidgetQueryDescriptor(widget, 'page-1', undefined, {
      filters: stateA.doc.filters,
      expressionFields: stateA.doc.expressionFields,
      relationships: stateA.doc.relationships,
      crossFilterAllPages: stateA.doc.dashboard.crossFilterAllPages ?? false,
    });
    // Instance A's cache entry, namespaced to adapterA.
    studioRequestCache.set(
      descriptorA.cacheKey,
      { rows: [{ status: 'tenant-a-row' }] },
      's1',
      adapterA,
    );

    // Instance B: same sourceId string ("s1") and identical query shape (so the legacy
    // un-namespaced cacheKey would be identical), but a DIFFERENT adapter instance that has
    // NOT populated any cache entry of its own — a cold cache for this tenant.
    const adapterB = { getRows: vi.fn() };
    const adapterBSource: StudioDataSource = {
      id: 's1',
      label: 'Source',
      fields: [{ id: 'status', label: 'Status', type: 'string' }],
      adapter: adapterB,
    };
    const controllerB = makeController(widget, { s1: adapterBSource });

    runWidgetExport({
      widget,
      source: adapterBSource,
      controller: controllerB,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });

    // Before the fix: this would be a cache HIT on adapterA's entry (same un-namespaced
    // cacheKey), silently exporting tenant A's rows into tenant B's CSV. After the fix,
    // adapterB's cache is cold, so the export falls back to the "no data" message instead of
    // ever reading adapterA's rows.
    expect(exportGridToCsv).not.toHaveBeenCalled();
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [message] = vi.mocked(downloadCsv).mock.calls[0];
    expect(message).toMatch(/no data available/i);
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
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });
    expect(imperativeExport).toHaveBeenCalledTimes(1);
    expect(exportGridToCsv).not.toHaveBeenCalled();
    expect(exportChartToPng).not.toHaveBeenCalled();
  });
});

// `canExport` is kind-derived — every chart widget advertises `export: 'png'` — so the export
// button is offered in states with no chart surface at all (an unconfigured chart renders a
// plain Box + Typography, a no-data/errored chart renders a status overlay). The chart branch
// used to be a bare passthrough to `exportChartToPng`, which returned silently on both of its
// guards, so the click did literally nothing: indistinguishable from a failed download, and the
// only export branch that broke the module's own "the export button never does nothing" rule.
describe('runWidgetExport chart with nothing to export', () => {
  beforeEach(() => {
    vi.mocked(exportGridToCsv).mockClear();
    vi.mocked(exportChartToPng).mockReset().mockReturnValue(false);
    vi.mocked(downloadCsv).mockClear();
    studioRequestCache.clear();
  });

  const chartWidget: StudioWidget = {
    id: 'w2',
    kind: 'chart',
    title: 'Chart',
    sourceId: 's1',
    config: { chartType: 'bar' } as StudioWidgetConfig,
  };

  it('downloads the unavailable message when there is no chart surface to rasterize', () => {
    runWidgetExport({
      widget: chartWidget,
      source,
      controller: makeController(chartWidget, { s1: source }),
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: document.createElement('div'),
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });

    expect(exportChartToPng).toHaveBeenCalledTimes(1);
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [message, filename] = vi.mocked(downloadCsv).mock.calls[0];
    expect(message).toBe(DEFAULT_STUDIO_LOCALE_TEXT.widgetExportUnavailableMessage);
    expect(filename).toBe('Chart_export.csv');
  });

  it('downloads nothing extra once the PNG export succeeds', () => {
    vi.mocked(exportChartToPng).mockReturnValue(true);
    runWidgetExport({
      widget: chartWidget,
      source,
      controller: makeController(chartWidget, { s1: source }),
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: document.createElement('div'),
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });

    expect(downloadCsv).not.toHaveBeenCalled();
  });
});

// Shared reset for the suites below, mirroring the `runWidgetExport` suite's own.
function resetExportMocks() {
  vi.mocked(exportGridToCsv).mockClear();
  vi.mocked(exportChartToPng).mockReset().mockReturnValue(true);
  vi.mocked(downloadCsv).mockClear();
  studioRequestCache.clear();
}

// M1a: the CSV must be ordered the way the grid on screen is ordered.
//
// The export mapped rows in raw source order and read no sort model at all, so a grid sorted
// by Revenue desc exported in ingestion order — the file and the screen disagreed about the
// most visible property of a table.
describe('runWidgetExport grid sort model (M1a)', () => {
  beforeEach(resetExportMocks);

  const sortSource: StudioDataSource = {
    id: 's1',
    label: 'Source',
    fields: [
      { id: 'region', label: 'Region', type: 'string' },
      { id: 'revenue', label: 'Revenue', type: 'number' },
    ],
    rows: [
      { region: 'EU', revenue: 100 },
      { region: 'US', revenue: 300 },
      { region: 'APAC', revenue: 200 },
    ],
  };

  function exportedRegions(config: StudioWidgetConfig) {
    const widget: StudioWidget = {
      id: 'w-sort',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config,
    };
    runWidgetExport({
      widget,
      source: sortSource,
      controller: makeController(widget, { s1: sortSource }),
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });
    const [, , rows] = vi.mocked(exportGridToCsv).mock.calls[0];
    return (rows as Record<string, unknown>[]).map((r) => r.region);
  }

  it('exports in the authored descending sort order, not source order', () => {
    expect(
      exportedRegions({
        gridSortField: 'revenue',
        gridSortDirection: 'desc',
      } as StudioWidgetConfig),
    ).toEqual(['US', 'APAC', 'EU']);
  });

  it('exports in the authored ascending sort order', () => {
    expect(
      exportedRegions({ gridSortField: 'revenue', gridSortDirection: 'asc' } as StudioWidgetConfig),
    ).toEqual(['EU', 'APAC', 'US']);
  });

  it('defaults an authored sort field with no direction to ascending, matching the grid', () => {
    expect(exportedRegions({ gridSortField: 'revenue' } as StudioWidgetConfig)).toEqual([
      'EU',
      'APAC',
      'US',
    ]);
  });

  it('leaves rows in source order when nothing is sorted', () => {
    expect(exportedRegions({} as StudioWidgetConfig)).toEqual(['EU', 'US', 'APAC']);
  });

  it("honours a view-mode viewer's sort, which lives outside the doc", () => {
    // A view-mode header click is deliberately NOT written to `doc` (a read-only viewer must
    // not rewrite the authored dashboard), so it reaches this export through the registry the
    // grid publishes it on.
    setGridViewSortModel('w-sort', [{ field: 'region', sort: 'asc' }]);
    try {
      // The authored config says revenue-desc; the viewer's own sort must win, exactly as it
      // does on screen.
      expect(
        exportedRegions({
          gridSortField: 'revenue',
          gridSortDirection: 'desc',
        } as StudioWidgetConfig),
      ).toEqual(['APAC', 'EU', 'US']);
    } finally {
      clearGridViewSortModel('w-sort');
    }
  });
});

// M1b: an adapter response must not be re-filtered by filters the server already applied.
//
// The export ran the FULL filter scope over adapter rows, but those rows were already reduced
// server-side AND only carry `descriptor.select`'s projected columns. A dashboard date range on
// `order_date` — a column a grid rarely displays, so rarely projected — therefore evaluated
// against rows with no `order_date` key and rejected every one of them: a headers-only CSV
// beside a populated grid.
describe('runWidgetExport adapter residual filter scope (M1b)', () => {
  beforeEach(resetExportMocks);

  const adapterSource: StudioDataSource = {
    id: 's1',
    label: 'Source',
    fields: [
      { id: 'status', label: 'Status', type: 'string' },
      { id: 'order_date', label: 'Order date', type: 'date' },
    ],
    adapter: { getRows: vi.fn() },
  };

  // Rows exactly as the server projects them: only the grid's own column, no `order_date`.
  const projectedRows = [{ status: 'active' }, { status: 'inactive' }];

  function seedCache(widget: StudioWidget, controller: StudioController) {
    const state = controller.getState();
    const descriptor = buildWidgetQueryDescriptor(widget, 'page-1', undefined, {
      filters: state.doc.filters,
      expressionFields: state.doc.expressionFields,
      relationships: state.doc.relationships,
      crossFilterAllPages: false,
    });
    studioRequestCache.set(
      descriptor.cacheKey,
      { rows: projectedRows },
      's1',
      adapterSource.adapter,
    );
  }

  it('does not drop every row when a dashboard date range targets an unprojected column', () => {
    const widget: StudioWidget = {
      id: 'w-range',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config: { columns: [{ fieldId: 'status' }] } as StudioWidgetConfig,
    };
    const dateRangeFilter = {
      id: 'f-range',
      field: 'order_date',
      operator: 'between',
      value: { from: '2024-01-01', to: '2024-12-31' },
      scope: { kind: 'dashboard-date-range', sourceId: 's1', pageId: 'page-1' },
    } as unknown as StudioFilterState;
    const controller = new StudioController({
      doc: { widgets: { [widget.id]: widget }, filters: [dateRangeFilter] },
      runtime: { dataSources: { s1: adapterSource } },
    });
    seedCache(widget, controller);

    runWidgetExport({
      widget,
      source: adapterSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });

    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [, , rows] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(rows).toEqual(projectedRows);
  });

  it('still applies a cross-filter, which the server descriptor deliberately excludes', () => {
    const widget: StudioWidget = {
      id: 'w-cross',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config: { columns: [{ fieldId: 'status' }] } as StudioWidgetConfig,
    };
    const crossFilter = {
      id: 'f-cross',
      field: 'status',
      operator: 'equals',
      value: 'active',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other', pageId: 'page-1' },
    } as unknown as StudioFilterState;
    const controller = new StudioController({
      doc: { widgets: { [widget.id]: widget }, filters: [crossFilter] },
      runtime: { dataSources: { s1: adapterSource } },
    });
    seedCache(widget, controller);

    runWidgetExport({
      widget,
      source: adapterSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });

    const [, , rows] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(rows).toEqual([{ status: 'active' }]);
  });
});

// M12: the export button must never do nothing at all.
describe('runWidgetExport surfaces an unexportable widget (M12)', () => {
  beforeEach(resetExportMocks);

  it('explains itself instead of returning silently for a grid with no data source', () => {
    const widget: StudioWidget = {
      id: 'w-nosource',
      kind: 'grid',
      title: 'Grid',
      config: {} as StudioWidgetConfig,
    };

    runWidgetExport({
      widget,
      source: undefined,
      controller: makeController(widget),
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });

    expect(downloadCsv).toHaveBeenCalledTimes(1);
    expect(vi.mocked(downloadCsv).mock.calls[0][0]).toBe(
      DEFAULT_STUDIO_LOCALE_TEXT.widgetExportUnavailableMessage,
    );
    expect(exportGridToCsv).not.toHaveBeenCalled();
  });

  it('explains itself when a pivot has registered no imperative export handler', () => {
    const widget: StudioWidget = {
      id: 'w-pivot-noexport',
      kind: 'pivot',
      title: 'Pivot',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };

    runWidgetExport({
      widget,
      source,
      controller: makeController(widget, { s1: source }),
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    });

    expect(downloadCsv).toHaveBeenCalledTimes(1);
    expect(vi.mocked(downloadCsv).mock.calls[0][0]).toBe(
      DEFAULT_STUDIO_LOCALE_TEXT.widgetExportUnavailableMessage,
    );
  });
});
