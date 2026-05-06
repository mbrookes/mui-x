import { describe, it, expect } from 'vitest';
import { createStudioPipeline } from './StudioPipeline';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
} from '../models';
import type { StudioPipelineState } from './StudioPipeline';

// Re-export the interface for TS coverage
import type { StudioPipeline } from './StudioPipeline';

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

function makeSource(
  id: string,
  rows: Record<string, unknown>[],
): StudioDataSource {
  return { id, label: id, fields: [], rows };
}

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'region',
    operator: 'equals',
    value: 'EU',
    scope: 'page',
    ...overrides,
  };
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
        filters: [makeFilter({ id: 'f1', scope: 'page', field: 'region', operator: 'equals', value: 'EU' })],
      });
      const pipeline = createStudioPipeline(state);
      const result = pipeline.resolveWidgetRows('w1', 'orders', rows);
      expect(result.map((r) => r.id)).toEqual(['1', '3']);
    });

    it('applies a widget-scoped filter only for the matching widgetId', () => {
      const rows = [...ROWS];
      const state = makeState({
        dataSources: { orders: makeSource('orders', rows) },
        filters: [makeFilter({ id: 'f1', scope: 'widget', widgetId: 'w1', field: 'region', operator: 'equals', value: 'US' })],
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
        filters: [makeFilter({
          id: 'cf1',
          scope: 'cross-filter',
          sourceWidgetId: 'w-chart',
          pageId: 'page-1',
          field: 'region',
          operator: 'equals',
          value: 'EU',
        })],
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
        filters: [makeFilter({
          id: 'cf1',
          scope: 'cross-filter',
          sourceWidgetId: 'w-chart',
          pageId: 'page-2',
          field: 'region',
          operator: 'equals',
          value: 'EU',
        })],
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
        filters: [makeFilter({
          id: 'f-rank',
          scope: 'widget',
          widgetId: 'w1',
          filterMode: 'rank',
          field: 'amount',
          operator: 'top-n',
          value: 1,
        })],
      });
      const pipeline = createStudioPipeline(state);
      // Rank filter should not reduce rows at this layer
      const result = pipeline.resolveWidgetRows('w1', 'orders', rows);
      expect(result).toHaveLength(3);
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
        filters: [makeFilter({ id: 'f1', scope: 'page', field: 'region', operator: 'equals', value: 'EU' })],
      });
      const pipeline = createStudioPipeline(state);
      const r1 = pipeline.resolveWidgetRows('w1', 'orders', rows);
      const r2 = pipeline.resolveWidgetRows('w1', 'orders', rows);
      expect(r2).toBe(r1);
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
      const rows = [{ id: '1', amount: 100 }, { id: '2', amount: 200 }];
      const exprField: StudioExpressionField = {
        id: 'doubled',
        label: 'Doubled',
        type: 'number',
        isMeasure: false,
        sourceId: 'orders',
        expression: {
          operator: 'multiply',
          inputs: [
            { id: 'amount' },
            { type: 'number', value: 2 },
          ],
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
      const result = pipeline.resolveChartRows(customers, 'customers', 'country', ['total'], undefined);
      // Should produce 3 rows (orders grain), one per order
      expect(result).toHaveLength(3);
    });
  });

  describe('pipeline accepts StudioState (full store state)', () => {
    it('accepts a full StudioState object (superset of StudioPipelineState)', () => {
      const rows = [...ROWS];
      // createDefaultStudioState would create the full state, but we construct a minimal one here
      const fullState = {
        schemaVersion: 1 as const,
        mode: 'view' as const,
        dashboard: { id: 'd1', title: 'T', activePageId: 'p1' },
        pages: {},
        widgets: {},
        dataSources: { orders: makeSource('orders', rows) },
        relationships: [] as StudioRelationship[],
        expressionFields: [] as StudioExpressionField[],
        filters: [makeFilter({ id: 'f1', scope: 'page', field: 'region', operator: 'equals', value: 'EU' })] as StudioFilterState[],
        shell: { openDrawer: null },
      };
      const pipeline = createStudioPipeline(fullState);
      const result = pipeline.resolveWidgetRows('w1', 'orders', rows);
      expect(result.map((r) => r.id)).toEqual(['1', '3']);
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
