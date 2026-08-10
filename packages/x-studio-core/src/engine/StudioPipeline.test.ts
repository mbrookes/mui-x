import { describe, it, expect } from 'vitest';
import { createDefaultSemanticModel } from '@mui/x-studio-schema';
import { createStudioPipeline, shouldApplyWidgetRankAtL3 } from './StudioPipeline';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
  StudioState,
  StudioWidget,
  StudioWidgetConfig,
} from '../models';
import type { StudioPipeline, StudioPipelineState } from './StudioPipeline';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<StudioPipelineState> = {}): StudioPipelineState {
  return {
    dataSources: {},
    relationships: [],
    expressionFields: [],
    filters: [],
    ...overrides,
  };
}

function makeSource(id: string, rows: Record<string, unknown>[]): StudioDataSource {
  return { id, label: id, fields: [], rows };
}

function makeFilter(
  overrides: Partial<StudioFilterState> & { scope: StudioFilterState['scope'] },
): StudioFilterState {
  return {
    id: 'f1',
    field: 'region',
    operator: 'equals',
    value: 'EU',
    ...overrides,
  } as StudioFilterState;
}

function makeWidget(kind: string, config: StudioWidgetConfig = {}): StudioWidget {
  return { id: 'w1', kind, title: 'Widget', sourceId: 'orders', config } as StudioWidget;
}

const ROWS = [
  { id: '1', region: 'EU', amount: 100 },
  { id: '2', region: 'US', amount: 200 },
  { id: '3', region: 'EU', amount: 300 },
];

// ─── createStudioPipeline ────────────────────────────────────────────────────

describe('createStudioPipeline', () => {
  describe('resolveWidgetRows', () => {
    it('returns all rows when there are no filters', () => {
      const rows = [...ROWS];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
      });
      const pipeline = createStudioPipeline(state);
      const result = pipeline.resolveWidgetRows('w1', 'orders', rows);
      expect(result).toHaveLength(3);
    });

    it('applies a page-scoped filter', () => {
      const rows = [...ROWS];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
        filters: [
          makeFilter({
            id: 'f1',
            scope: { kind: 'page' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
      const pipeline = createStudioPipeline(state);
      const result = pipeline.resolveWidgetRows('w1', 'orders', rows);
      expect(result.map((r) => r.id)).toEqual(['1', '3']);
    });

    it('applies a widget-scoped filter only for the matching widgetId', () => {
      const rows = [...ROWS];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
        filters: [
          makeFilter({
            id: 'f1',
            scope: { kind: 'widget', widgetId: 'w1' },
            field: 'region',
            operator: 'equals',
            value: 'US',
          }),
        ],
      });
      const pipeline = createStudioPipeline(state);

      // w1 gets the filter applied
      const resultW1 = pipeline.resolveWidgetRows('w1', 'orders', rows);
      expect(resultW1.map((r) => r.id)).toEqual(['2']);

      // w2 does NOT get the w1 filter applied
      const resultW2 = pipeline.resolveWidgetRows('w2', 'orders', rows);
      expect(resultW2).toHaveLength(3);
    });

    it('applies cross-filter from another widget on the same page', () => {
      const rows = [...ROWS];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
        filters: [
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-chart', pageId: 'page-1' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
      const pipeline = createStudioPipeline(state);

      // w-grid receives the cross-filter (not from itself)
      const result = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'page-1');
      expect(result.map((r) => r.id)).toEqual(['1', '3']);
    });

    it('does not apply cross-filter from a different page', () => {
      const rows = [...ROWS];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
        filters: [
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-chart', pageId: 'page-2' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
      const pipeline = createStudioPipeline(state);

      // page-1 widget should not receive the page-2 cross-filter
      const result = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'page-1');
      expect(result).toHaveLength(3);
    });

    it('excludes rank-mode widget filters from row-level filtering', () => {
      const rows = [...ROWS];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
        filters: [
          makeFilter({
            id: 'f-rank',
            scope: { kind: 'widget', widgetId: 'w1' },
            filterMode: 'rank',
            field: 'amount',
            operator: 'equals',
            value: 1,
          }),
        ],
      });
      const pipeline = createStudioPipeline(state);
      // Rank filter should not reduce rows at this layer
      const result = pipeline.resolveWidgetRows('w1', 'orders', rows);
      expect(result).toHaveLength(3);
    });

    it('applies a widget-scoped rank filter when includeWidgetRank is set (finding 2.1)', () => {
      const rows = [...ROWS];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
        filters: [
          makeFilter({
            id: 'f-rank',
            scope: { kind: 'widget', widgetId: 'w1' },
            filterMode: 'rank',
            rankDirection: 'top',
            field: 'amount',
            value: 1,
          }),
        ],
      });
      const pipeline = createStudioPipeline(state);
      // Non-chart callers opt in — the widget-scoped Top-1 rank reduces to the highest-amount row.
      const result = pipeline.resolveWidgetRows('w1', 'orders', rows, undefined, {
        includeWidgetRank: true,
      });
      expect(result.map((r) => r.id)).toEqual(['3']);
    });

    it('returns an empty array when rows is empty', () => {
      const state = makeState({
        dataSources: { orders: makeSource('orders', []) },
      });
      const pipeline = createStudioPipeline(state);
      const result = pipeline.resolveWidgetRows('w1', 'orders', []);
      expect(result).toHaveLength(0);
    });

    it('returns the same reference for two identical calls (cache hit)', () => {
      const rows = [...ROWS];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
        filters: [
          makeFilter({
            id: 'f1',
            scope: { kind: 'page' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
      const pipeline = createStudioPipeline(state);
      const r1 = pipeline.resolveWidgetRows('w1', 'orders', rows);
      const r2 = pipeline.resolveWidgetRows('w1', 'orders', rows);
      expect(r2).toBe(r1);
    });

    // ── Widget-object overload: `shouldApplyWidgetRankAtL3` resolves itself ────────────
    //
    // Passing the widget OBJECT is the supported way to get widget-rank handling right without
    // the caller knowing the rule. These lock the default in for both directions so a new
    // caller can never silently double-reduce (or never reduce) a Top-N.
    describe('widget-rank default when a widget object is passed', () => {
      const rankState = () =>
        makeState({
          dataSources: { orders: makeSource('orders', ROWS) },
          filters: [
            makeFilter({
              id: 'f-rank',
              scope: { kind: 'widget', widgetId: 'w1' },
              filterMode: 'rank',
              rankDirection: 'top',
              field: 'amount',
              value: 1,
            }),
          ],
        });

      it('applies the widget rank at L3 for a non-chart widget with no explicit flag', () => {
        const pipeline = createStudioPipeline(rankState());
        const result = pipeline.resolveWidgetRows(makeWidget('grid'), 'orders', [...ROWS]);
        expect(result.map((r) => r.id)).toEqual(['3']);
      });

      it('applies the widget rank at L3 for a heatmap chart (no post-aggregation re-rank path)', () => {
        const pipeline = createStudioPipeline(rankState());
        const result = pipeline.resolveWidgetRows(
          makeWidget('chart', { chartType: 'heatmap' }),
          'orders',
          [...ROWS],
        );
        expect(result.map((r) => r.id)).toEqual(['3']);
      });

      it('does NOT apply the widget rank at L3 for a bar chart (it re-ranks post-aggregation)', () => {
        const pipeline = createStudioPipeline(rankState());
        const result = pipeline.resolveWidgetRows(
          makeWidget('chart', { chartType: 'bar' }),
          'orders',
          [...ROWS],
        );
        expect(result).toHaveLength(3);
      });

      it('treats a chart with no chartType as bar (the rendered default)', () => {
        const pipeline = createStudioPipeline(rankState());
        const result = pipeline.resolveWidgetRows(makeWidget('chart'), 'orders', [...ROWS]);
        expect(result).toHaveLength(3);
      });

      it('lets an explicit includeWidgetRank override the resolved default', () => {
        const pipeline = createStudioPipeline(rankState());
        const result = pipeline.resolveWidgetRows(
          makeWidget('chart', { chartType: 'bar' }),
          'orders',
          [...ROWS],
          undefined,
          { includeWidgetRank: true },
        );
        expect(result.map((r) => r.id)).toEqual(['3']);
      });

      it('keeps the legacy `false` default for the bare-ID form', () => {
        const pipeline = createStudioPipeline(rankState());
        // A bare ID carries no `kind`/`config`, so the rule cannot be resolved — documented as
        // the legacy form for callers with no widget object (e.g. `richContext`'s synthetic id).
        const result = pipeline.resolveWidgetRows('w1', 'orders', [...ROWS]);
        expect(result).toHaveLength(3);
      });
    });
  });

  // ── shouldApplyWidgetRankAtL3 ──────────────────────────────────────────────────────
  //
  // The single rule deciding whether a widget-scoped Top-N is reduced at L3 or by the chart's
  // own post-aggregation pass. The invariant: applied exactly once, never twice, never zero
  // times. `useWidgetRows`, `widgetExport` and `generateInsight` all route through this.
  describe('shouldApplyWidgetRankAtL3', () => {
    it.each(['grid', 'kpi', 'map', 'pivot', 'filter', 'text', 'my-custom-kind'])(
      'returns true for the non-chart kind %s',
      (kind) => {
        expect(shouldApplyWidgetRankAtL3(makeWidget(kind))).toBe(true);
      },
    );

    it.each(['heatmap', 'funnel', 'sankey', 'gantt', 'scatter', 'gauge'] as const)(
      'returns true for a %s chart (aggregates rows directly, never re-ranks)',
      (chartType) => {
        expect(shouldApplyWidgetRankAtL3(makeWidget('chart', { chartType }))).toBe(true);
      },
    );

    it.each([
      'bar',
      'bar-stacked',
      'bar-100',
      'line',
      'area',
      'area-stacked',
      'area-100',
      'pie',
      'donut',
      'mixed',
    ] as const)('returns false for a %s chart (re-ranks post-aggregation)', (chartType) => {
      expect(shouldApplyWidgetRankAtL3(makeWidget('chart', { chartType }))).toBe(false);
    });

    it('treats a chart with no chartType as bar', () => {
      expect(shouldApplyWidgetRankAtL3(makeWidget('chart'))).toBe(false);
    });
  });

  describe('getEnrichedRows', () => {
    it('returns rows unchanged when there are no expression fields', () => {
      const rows = [...ROWS];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
      });
      const pipeline = createStudioPipeline(state);
      const result = pipeline.getEnrichedRows(rows, 'orders');
      // No expression fields → rows should be identity
      expect(result).toHaveLength(rows.length);
    });

    it('adds computed expression fields to each row', () => {
      const rows = [
        { id: '1', amount: 100 },
        { id: '2', amount: 200 },
      ];
      const exprField: StudioExpressionField = {
        id: 'doubled',
        label: 'Doubled',
        type: 'number',
        isMeasure: false,
        sourceId: 'orders',
        expression: {
          operator: 'multiply',
          inputs: [{ id: 'amount' }, { type: 'number', value: 2 }],
        },
      };
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
        expressionFields: [exprField],
      });
      const pipeline = createStudioPipeline(state);
      const result = pipeline.getEnrichedRows(rows, 'orders');
      expect((result[0] as Record<string, unknown>).doubled).toBe(200);
      expect((result[1] as Record<string, unknown>).doubled).toBe(400);
    });
  });

  describe('resolveChartRows', () => {
    it('returns widgetRows unchanged when no fields are requested', () => {
      const rows = [
        { id: '1', date: '2024-01', total: 100 },
        { id: '2', date: '2024-02', total: 200 },
      ];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
      });
      const pipeline = createStudioPipeline(state);
      // When no xField/yFields are requested the pipeline has nothing to re-anchor;
      // it returns the input rows as-is (same reference).
      const result = pipeline.resolveChartRows(rows, 'orders', undefined, [], undefined);
      expect(result).toBe(rows);
    });

    it('re-anchors rows to the many-side for cross-source y-fields', () => {
      const customers = [
        { id: 'CUS-1', country: 'Germany' },
        { id: 'CUS-2', country: 'France' },
      ];
      const orders = [
        { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
        { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
        { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
      ];
      const rel: StudioRelationship = {
        id: 'r1',
        sourceId: 'orders',
        targetId: 'customers',
        sourceField: 'customerId',
        targetField: 'id',
        type: 'many-to-one',
      };
      const state = makeState({
        dataSources: {
          customers: {
            id: 'customers',
            label: 'Customers',
            fields: [
              { id: 'id', label: 'Customer ID', type: 'string' },
              { id: 'country', label: 'Country', type: 'string' },
            ],
            rows: customers,
          },
          orders: {
            id: 'orders',
            label: 'Orders',
            fields: [
              { id: 'id', label: 'Order ID', type: 'string' },
              { id: 'customerId', label: 'Customer ID', type: 'string' },
              { id: 'total', label: 'Total', type: 'number' },
            ],
            rows: orders,
          },
        },
        relationships: [rel],
      });
      const pipeline = createStudioPipeline(state);
      // Chart on customers source, y-field is total from related orders → re-anchor to orders grain
      const result = pipeline.resolveChartRows(
        customers,
        'customers',
        'country',
        ['total'],
        undefined,
      );
      // Should produce 3 rows (orders grain), one per order
      expect(result).toHaveLength(3);
    });

    // ─── Finding 2.2 regression coverage ─────────────────────────────────────
    //
    // Before the fix, the public `resolveChartRows` façade accepted neither `extraFields`
    // nor `widgetFilters`, so external callers (CSV export, benchmarks, tests) always got
    // the pre-fix L4 semantics that `resolveChartRowsForAggregation` itself had already
    // moved past internally (`useChartRows`/`useChartWidgetData`). These tests confirm the
    // new optional parameters are threaded through, and that omitting them preserves the
    // prior (unfiltered) behaviour for backward compatibility.
    describe('extraFields / widgetFilters (finding 2.2)', () => {
      const customers = [
        { id: 'CUS-1', country: 'Germany' },
        { id: 'CUS-2', country: 'France' },
      ];
      const orders = [
        { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
        { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
        { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
      ];
      const rel: StudioRelationship = {
        id: 'r1',
        sourceId: 'orders',
        targetId: 'customers',
        sourceField: 'customerId',
        targetField: 'id',
        type: 'many-to-one',
      };

      function makeCustomersOrdersState(filters: StudioFilterState[] = []): StudioPipelineState {
        return makeState({
          dataSources: {
            customers: {
              id: 'customers',
              label: 'Customers',
              fields: [
                { id: 'id', label: 'Customer ID', type: 'string' },
                { id: 'country', label: 'Country', type: 'string' },
              ],
              rows: customers,
            },
            orders: {
              id: 'orders',
              label: 'Orders',
              fields: [
                { id: 'id', label: 'Order ID', type: 'string' },
                { id: 'customerId', label: 'Customer ID', type: 'string' },
                { id: 'total', label: 'Total', type: 'number' },
              ],
              rows: orders,
            },
          },
          relationships: [rel],
          filters,
        });
      }

      it('omitting extraFields/widgetFilters preserves the prior (unfiltered) behaviour', () => {
        const pipeline = createStudioPipeline(makeCustomersOrdersState());
        // Same call as the pre-existing "re-anchors" test, with no new params — the anchor
        // join re-widens to ALL of each customer's orders (no anchor filter re-applied).
        const result = pipeline.resolveChartRows(
          customers,
          'customers',
          'country',
          ['total'],
          undefined,
        );
        expect(result).toHaveLength(3);
      });

      it('threads widgetFilters into the L4 anchor-scoped filter re-application', () => {
        const anchorFilter: StudioFilterState = {
          id: 'af1',
          field: 'total',
          operator: 'greater_than',
          value: 60,
          filterSourceId: 'orders',
          scope: { kind: 'page' },
        } as StudioFilterState;
        const pipeline = createStudioPipeline(makeCustomersOrdersState([anchorFilter]));

        // Without passing widgetFilters, the anchor join still resurrects every order
        // (backward-compatible default of `[]`).
        const withoutFilters = pipeline.resolveChartRows(
          customers,
          'customers',
          'country',
          ['total'],
          undefined,
        );
        expect(withoutFilters).toHaveLength(3);

        // Passing widgetFilters re-applies the anchor-scoped filter to the anchor (orders)
        // rows before the expansion join: only ORD-1 (100) and ORD-3 (70) satisfy
        // total > 60 — ORD-2 (50) is excluded, matching what L3 already enforced upstream.
        const withFilters = pipeline.resolveChartRows(
          customers,
          'customers',
          'country',
          ['total'],
          undefined,
          [],
          [anchorFilter],
        );
        expect(withFilters).toHaveLength(2);
      });

      it('threads extraFields into the requested-field set used by chart-support analysis', () => {
        const pipeline = createStudioPipeline(makeCustomersOrdersState());

        // xField-only chart on customers (no yFields) is trivially supported — no
        // cross-source fields are requested at all.
        const withoutExtra = pipeline.resolveChartRows(
          customers,
          'customers',
          'country',
          [],
          undefined,
        );
        expect(withoutExtra).toHaveLength(2);

        // Passing 'total' (owned by the related `orders` source) via `extraFields`, with no
        // matching yField to anchor on, makes the configuration an unsupported cross-source
        // dimension mix (mirroring `resolveChartRowsForAggregation`'s own `extraFields`
        // semantics) — proving the façade now feeds `extraFields` into support analysis
        // instead of silently ignoring them.
        const withExtra = pipeline.resolveChartRows(
          customers,
          'customers',
          'country',
          [],
          undefined,
          ['total'],
        );
        expect(withExtra).toHaveLength(0);
      });
    });
  });

  describe('pipeline accepts StudioState (full store state)', () => {
    // Builds a real partitioned StudioState (doc/session/runtime) so the `'doc' in state`
    // branch is actually exercised — including the new dashboard cross-filter settings.
    function makeFullState(
      rows: Record<string, unknown>[],
      overrides: {
        filters?: StudioFilterState[];
        crossFilterAllPages?: boolean;
        globalCrossFilterMode?: StudioState['doc']['dashboard']['globalCrossFilterMode'];
      } = {},
    ): StudioState {
      return {
        doc: {
          semanticModel: {
            ...createDefaultSemanticModel(),
            relationships: [],
            expressionFields: [],
          },

          schemaVersion: 1,
          dashboard: {
            id: 'd1',
            title: 'T',
            activePageId: 'p1',
            crossFilterAllPages: overrides.crossFilterAllPages,
            globalCrossFilterMode: overrides.globalCrossFilterMode,
          },
          pages: {},
          widgets: {},
          filters: overrides.filters ?? [],
        },
        session: {
          mode: 'view',
          shell: {
            openDrawers: { data: false, compose: false, filters: false },
            selectedWidgetId: null,
            selectedFieldId: null,
            selectedSourceId: null,
          },
        },
        runtime: {
          dataSources: { orders: makeSource('orders', rows) },
        },
      } as StudioState;
    }

    it('accepts a full StudioState object and exercises the doc branch', () => {
      const rows = [...ROWS];
      const fullState = makeFullState(rows, {
        filters: [
          makeFilter({
            id: 'f1',
            scope: { kind: 'page' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
      const pipeline = createStudioPipeline(fullState);
      const result = pipeline.resolveWidgetRows('w1', 'orders', rows);
      expect(result.map((r) => r.id)).toEqual(['1', '3']);
    });

    it('honors crossFilterAllPages WITHOUT options (the corrected behaviour is the default)', () => {
      // The dashboard's cross-filter settings used to be read only when the caller passed
      // `options`, which left the wrong branch as the default every new caller inherits.
      // A cross-filter from another page must apply on a `crossFilterAllPages` dashboard
      // whether or not the caller has a per-widget override to pass.
      const rows = [...ROWS];
      const fullState = makeFullState(rows, {
        crossFilterAllPages: true,
        filters: [
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'other-page' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
      const pipeline = createStudioPipeline(fullState);
      const result = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'p1');
      expect(result.map((r) => r.id)).toEqual(['1', '3']);
    });

    it("honors globalCrossFilterMode 'none' WITHOUT options", () => {
      // Same class as above: a dashboard that has switched cross-filtering off must not have
      // its chart cross-filters silently re-applied just because the caller had no per-widget
      // mode to pass. The interactive hard-filter invariant still holds ('no-chart-cross').
      const rows = [...ROWS];
      const fullState = makeFullState(rows, {
        globalCrossFilterMode: 'none',
        filters: [
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'p1' },
            field: 'amount',
            operator: 'greater_than',
            value: 150,
          }),
          makeFilter({
            id: 'if1',
            scope: { kind: 'interactive', sourceWidgetId: 'w-filter', pageId: 'p1' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
      const pipeline = createStudioPipeline(fullState);
      // Cross-filter (amount>150) dropped, interactive (region=EU) kept → rows 1 and 3.
      const result = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'p1');
      expect(result.map((r) => r.id)).toEqual(['1', '3']);
    });

    // Precedence, not just "each one works on its own": `globalCrossFilterMode ??
    // options?.widgetCrossFilterMode ?? 'cross-highlight'`. Every existing case here sets
    // exactly ONE of the two, so the operands could be swapped with the suite green — and a
    // swapped order inverts the meaning of the dashboard-wide setting: a dashboard switched
    // to `'none'` would be overruled by any widget that carries its own `crossFilterMode`,
    // which is the one thing a DASHBOARD-WIDE override exists to prevent.
    it("a dashboard-wide 'none' overrules a widget's own cross-filter mode", () => {
      const rows = [...ROWS];
      const fullState = makeFullState(rows, {
        globalCrossFilterMode: 'none',
        filters: [
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'p1' },
            field: 'amount',
            operator: 'greater_than',
            value: 150,
          }),
        ],
      });
      const pipeline = createStudioPipeline(fullState);

      // The widget asks for cross-filtering; the dashboard says no. The dashboard wins, so
      // the cross-filter is dropped and every row survives.
      const result = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'p1', {
        widgetCrossFilterMode: 'cross-filter',
      });
      expect(result.map((r) => r.id)).toEqual(['1', '2', '3']);
    });

    it("a dashboard-wide 'cross-filter' overrules a widget's own 'none'", () => {
      const rows = [...ROWS];
      const fullState = makeFullState(rows, {
        globalCrossFilterMode: 'cross-filter',
        filters: [
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'p1' },
            field: 'amount',
            operator: 'greater_than',
            value: 150,
          }),
        ],
      });
      const pipeline = createStudioPipeline(fullState);

      // The mirror image, so the pair cannot be satisfied by "the dashboard setting is simply
      // ignored": here the dashboard turns cross-filtering ON over a widget's 'none', and the
      // cross-filter DOES apply.
      const result = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'p1', {
        widgetCrossFilterMode: 'none',
      });
      expect(result.map((r) => r.id)).toEqual(['2', '3']);
    });

    it("a widget's own mode still wins when the dashboard has no global override", () => {
      const rows = [...ROWS];
      const fullState = makeFullState(rows, {
        // No `globalCrossFilterMode` → the widget's own config is the next operand.
        filters: [
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'p1' },
            field: 'amount',
            operator: 'greater_than',
            value: 150,
          }),
        ],
      });
      const pipeline = createStudioPipeline(fullState);
      const result = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'p1', {
        widgetCrossFilterMode: 'none',
      });
      expect(result.map((r) => r.id)).toEqual(['1', '2', '3']);
    });

    it('passing options changes nothing about how the dashboard settings are read', () => {
      const rows = [...ROWS];
      const fullState = makeFullState(rows, {
        crossFilterAllPages: true,
        filters: [
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'other-page' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
      const pipeline = createStudioPipeline(fullState);
      // `{}` carries no override, so it must produce exactly the no-options result above.
      const result = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'p1', {});
      expect(result.map((r) => r.id)).toEqual(['1', '3']);
    });

    it("globalCrossFilterMode 'none' excludes cross-filters but keeps page filters", () => {
      const rows = [...ROWS];
      const fullState = makeFullState(rows, {
        globalCrossFilterMode: 'none',
        filters: [
          makeFilter({
            id: 'pf1',
            scope: { kind: 'page' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'p1' },
            field: 'amount',
            operator: 'greater_than',
            value: 150,
          }),
        ],
      });
      const pipeline = createStudioPipeline(fullState);
      // 'none' → include coerced to 'no-cross': page filter (region=EU) applies, the
      // cross-filter (amount>150) is dropped → rows 1 and 3 (both EU) survive.
      const result = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'p1', {});
      expect(result.map((r) => r.id)).toEqual(['1', '3']);
    });

    it("globalCrossFilterMode 'none' still applies an active INTERACTIVE filter (hard-filter invariant)", () => {
      // `crossFilterMode: 'none'` only opts a widget out of CHART cross-filters — an
      // interactive (filter-widget) selection is a hard filter that always applies,
      // regardless of the target widget's cross-filter mode (documented in
      // `useWidgetRows.ts`'s `shouldShowGhost`/`effectiveRows` doc comments). Before the
      // fix, `'none'` was wrongly coerced to `include: 'no-cross'`, which also drops
      // interactive filters — this regression test pins `'no-chart-cross'` instead.
      const rows = [...ROWS];
      const fullState = makeFullState(rows, {
        globalCrossFilterMode: 'none',
        filters: [
          makeFilter({
            id: 'if1',
            scope: { kind: 'interactive', sourceWidgetId: 'w-filter', pageId: 'p1' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
      const pipeline = createStudioPipeline(fullState);
      const result = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'p1', {});
      expect(result.map((r) => r.id)).toEqual(['1', '3']);
    });

    it('bare StudioPipelineState without the new fields behaves identically with and without options', () => {
      const rows = [...ROWS];
      // A same-page cross-filter: with default crossFilterAllPages (undefined→false) and no
      // global mode, opting in resolves to include:'all' on the active page — same as the
      // default path for a same-page cross-filter.
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
        filters: [
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'p1' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
      const pipeline = createStudioPipeline(state);
      const withoutOptions = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'p1');
      const withOptions = pipeline.resolveWidgetRows('w-grid', 'orders', rows, 'p1', {});
      expect(withoutOptions.map((r) => r.id)).toEqual(['1', '3']);
      expect(withOptions.map((r) => r.id)).toEqual(['1', '3']);
    });
  });

  describe('type contract', () => {
    it('createStudioPipeline returns a StudioPipeline object', () => {
      const pipeline: StudioPipeline = createStudioPipeline(makeState());
      expect(typeof pipeline.resolveWidgetRows).toBe('function');
      expect(typeof pipeline.resolveChartRows).toBe('function');
      expect(typeof pipeline.getEnrichedRows).toBe('function');
    });
  });
});
