import { describe, it, expect, beforeEach } from 'vitest';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../models';

type Row = Record<string, unknown>;

// ─── Minimal fixtures ─────────────────────────────────────────────────────────

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, value: i * 10 }));
}

function makeDataSources(rows: Row[]): Record<string, StudioDataSource> {
  return {
    orders: {
      id: 'orders',
      label: 'Orders',
      rows,
      fields: [{ id: 'id', label: 'ID', type: 'number' }],
    } as unknown as StudioDataSource,
  };
}

function makeExpressionFields(): StudioExpressionField[] {
  return [
    {
      id: 'expr-double',
      label: 'Double',
      sourceId: 'orders',
      isMeasure: false,
      expression: { type: 'arithmetic', left: { type: 'field', fieldId: 'value' }, op: '*', right: { type: 'literal', value: 2 } },
    } as unknown as StudioExpressionField,
  ];
}

const NO_RELATIONSHIPS: StudioRelationship[] = [];

// Force cache invalidation before each test by using fresh sentinel refs.
// The cache module uses module-level state — new ref objects trigger a clear.
beforeEach(() => {
  // Fresh refs on every test to avoid inter-test state leakage
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getCachedEnrichedRows', () => {
  it('returns raw rows unchanged when there are no expression fields', () => {
    const rows = makeRows(5);
    const dataSources = makeDataSources(rows);
    const result = getCachedEnrichedRows(rows, 'orders', [], dataSources, NO_RELATIONSHIPS);
    expect(result).toBe(rows);
  });

  it('returns raw rows unchanged when sourceId is undefined', () => {
    const rows = makeRows(5);
    const dataSources = makeDataSources(rows);
    const exprFields = makeExpressionFields();
    const result = getCachedEnrichedRows(rows, undefined, exprFields, dataSources, NO_RELATIONSHIPS);
    expect(result).toBe(rows);
  });

  it('returns enriched rows (different reference) when expression fields exist', () => {
    const rows = makeRows(5);
    const dataSources = makeDataSources(rows);
    const exprFields = makeExpressionFields();
    const result = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);
    // getCachedEnrichedRows should return a new array with computed columns
    expect(result).not.toBe(rows);
    expect(result).toHaveLength(rows.length);
  });

  it('returns the same Row[] reference on a cache hit (same sentinel refs)', () => {
    const rows = makeRows(10);
    const dataSources = makeDataSources(rows);
    const exprFields = makeExpressionFields();
    const first = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);
    const second = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);
    expect(second).toBe(first);
  });

  it('does NOT invalidate when only globalFilters would change (filter-independence)', () => {
    // Simulate what happens when a user changes a filter:
    // dataSources, expressionFields, relationships all keep the SAME reference.
    // The enrich cache should stay warm (same result, same reference).
    const rows = makeRows(10);
    const dataSources = makeDataSources(rows);
    const exprFields = makeExpressionFields();

    const before = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);

    // "Filter changes" — but none of the three sentinels change
    // (in the real app, globalFilters changes but dataSources/expressionFields/relationships do not)
    const after = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);

    expect(after).toBe(before); // cache must still be warm
  });

  it('invalidates when expressionFields ref changes', () => {
    const rows = makeRows(10);
    const dataSources = makeDataSources(rows);
    const exprFields1 = makeExpressionFields();
    const exprFields2 = makeExpressionFields(); // same content, different reference

    const result1 = getCachedEnrichedRows(rows, 'orders', exprFields1, dataSources, NO_RELATIONSHIPS);
    const result2 = getCachedEnrichedRows(rows, 'orders', exprFields2, dataSources, NO_RELATIONSHIPS);

    // Different expressionFields ref → cache cleared → new enrichment run
    // The content is the same but the reference must be a new object.
    expect(result2).not.toBe(result1);
  });

  it('invalidates when dataSources ref changes', () => {
    const rows = makeRows(10);
    const dataSources1 = makeDataSources(rows);
    const dataSources2 = makeDataSources(rows); // same content, different reference
    const exprFields = makeExpressionFields();

    const result1 = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources1, NO_RELATIONSHIPS);
    const result2 = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources2, NO_RELATIONSHIPS);

    expect(result2).not.toBe(result1);
  });

  it('invalidates when relationships ref changes', () => {
    const rows = makeRows(10);
    const dataSources = makeDataSources(rows);
    const exprFields = makeExpressionFields();
    const rel1: StudioRelationship[] = [];
    const rel2: StudioRelationship[] = []; // different reference

    const result1 = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, rel1);
    const result2 = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, rel2);

    expect(result2).not.toBe(result1);
  });

  it('caches independently per sourceId within the same sentinel state', () => {
    const ordersRows = makeRows(5);
    const customersRows = makeRows(3);
    const dataSources: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        rows: ordersRows,
        fields: [{ id: 'id', label: 'ID', type: 'number' }],
      } as unknown as StudioDataSource,
      customers: {
        id: 'customers',
        label: 'Customers',
        rows: customersRows,
        fields: [{ id: 'id', label: 'ID', type: 'number' }],
      } as unknown as StudioDataSource,
    };
    const exprFields: StudioExpressionField[] = [
      {
        id: 'expr-orders',
        label: 'Orders double',
        sourceId: 'orders',
        isMeasure: false,
        expression: { type: 'arithmetic', left: { type: 'field', fieldId: 'value' }, op: '*', right: { type: 'literal', value: 2 } },
      } as unknown as StudioExpressionField,
      {
        id: 'expr-customers',
        label: 'Customers triple',
        sourceId: 'customers',
        isMeasure: false,
        expression: { type: 'arithmetic', left: { type: 'field', fieldId: 'value' }, op: '*', right: { type: 'literal', value: 3 } },
      } as unknown as StudioExpressionField,
    ];

    const enrichedOrders = getCachedEnrichedRows(ordersRows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);
    const enrichedCustomers = getCachedEnrichedRows(customersRows, 'customers', exprFields, dataSources, NO_RELATIONSHIPS);

    // Each source has its own cache entry
    expect(enrichedOrders).not.toBe(enrichedCustomers);
    expect(enrichedOrders).toHaveLength(ordersRows.length);
    expect(enrichedCustomers).toHaveLength(customersRows.length);

    // Repeat calls return the same references (cache hits)
    expect(getCachedEnrichedRows(ordersRows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS)).toBe(enrichedOrders);
    expect(getCachedEnrichedRows(customersRows, 'customers', exprFields, dataSources, NO_RELATIONSHIPS)).toBe(enrichedCustomers);
  });
});
