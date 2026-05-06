import { describe, it, expect } from 'vitest';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../models';

type Row = Record<string, unknown>;

// ─── Minimal fixtures ─────────────────────────────────────────────────────────

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, value: i * 10 }));
}

function makeDataSources(
  ordersRows: Row[],
  customersRows?: Row[],
): Record<string, StudioDataSource> {
  const sources: Record<string, StudioDataSource> = {
    orders: {
      id: 'orders',
      label: 'Orders',
      rows: ordersRows,
      fields: [{ id: 'id', label: 'ID', type: 'number' }],
    } as unknown as StudioDataSource,
  };
  if (customersRows) {
    sources.customers = {
      id: 'customers',
      label: 'Customers',
      rows: customersRows,
      fields: [{ id: 'id', label: 'ID', type: 'number' }, { id: 'country', label: 'Country', type: 'string' }],
    } as unknown as StudioDataSource;
  }
  return sources;
}

/** Arithmetic expression field for orders source */
function makeOrdersExprField(): StudioExpressionField {
  return {
    id: 'expr-double',
    label: 'Double',
    sourceId: 'orders',
    isMeasure: false,
    expression: { type: 'arithmetic', left: { type: 'field', fieldId: 'value' }, op: '*', right: { type: 'literal', value: 2 } },
  } as unknown as StudioExpressionField;
}

/** Arithmetic expression field for customers source */
function makeCustomersExprField(): StudioExpressionField {
  return {
    id: 'expr-customers-triple',
    label: 'Triple',
    sourceId: 'customers',
    isMeasure: false,
    expression: { type: 'arithmetic', left: { type: 'field', fieldId: 'value' }, op: '*', right: { type: 'literal', value: 3 } },
  } as unknown as StudioExpressionField;
}

const NO_RELATIONSHIPS: StudioRelationship[] = [];

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
    const exprFields = [makeOrdersExprField()];
    const result = getCachedEnrichedRows(rows, undefined, exprFields, dataSources, NO_RELATIONSHIPS);
    expect(result).toBe(rows);
  });

  it('returns raw rows unchanged when no expression fields target this source', () => {
    const rows = makeRows(5);
    const customersRows = makeRows(3);
    const dataSources = makeDataSources(rows, customersRows);
    // Only a customers field — orders source has nothing to enrich
    const exprFields = [makeCustomersExprField()];
    const result = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);
    expect(result).toBe(rows);
  });

  it('returns enriched rows (new reference) when expression fields exist', () => {
    const rows = makeRows(5);
    const dataSources = makeDataSources(rows);
    const exprFields = [makeOrdersExprField()];
    const result = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);
    expect(result).not.toBe(rows);
    expect(result).toHaveLength(rows.length);
  });

  it('returns the same Row[] reference on a cache hit (same deps)', () => {
    const rows = makeRows(10);
    const dataSources = makeDataSources(rows);
    const ordersField = makeOrdersExprField();
    const exprFields = [ordersField];
    const first = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);
    const second = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);
    expect(second).toBe(first);
  });

  // ─── Filter independence ──────────────────────────────────────────────────

  it('stays warm when only globalFilters would change (filter-independence)', () => {
    // In the real app, filter changes produce a new globalFilters ref but do NOT
    // change dataSources, expressionFields, relationships, or rows.
    // The enrich cache must stay warm.
    const rows = makeRows(10);
    const dataSources = makeDataSources(rows);
    const ordersField = makeOrdersExprField();
    const exprFields = [ordersField];

    const before = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);
    // "Filter changes" — none of the actual enrich dependencies change
    const after = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);

    expect(after).toBe(before);
  });

  // ─── Per-source invalidation ──────────────────────────────────────────────

  it('invalidates when own rows ref changes', () => {
    const rows1 = makeRows(10);
    const rows2 = makeRows(10); // same content, different reference
    const ordersField = makeOrdersExprField();
    const exprFields = [ordersField];
    const dataSources1 = makeDataSources(rows1);
    const dataSources2 = makeDataSources(rows2);

    const result1 = getCachedEnrichedRows(rows1, 'orders', exprFields, dataSources1, NO_RELATIONSHIPS);
    const result2 = getCachedEnrichedRows(rows2, 'orders', exprFields, dataSources2, NO_RELATIONSHIPS);

    expect(result2).not.toBe(result1);
  });

  it('invalidates when a relevant expression field object changes', () => {
    const rows = makeRows(10);
    const dataSources = makeDataSources(rows);
    // Two different objects representing the same field (simulates store update)
    const field1 = makeOrdersExprField();
    const field2 = makeOrdersExprField(); // same content, different object ref

    const result1 = getCachedEnrichedRows(rows, 'orders', [field1], dataSources, NO_RELATIONSHIPS);
    const result2 = getCachedEnrichedRows(rows, 'orders', [field2], dataSources, NO_RELATIONSHIPS);

    expect(result2).not.toBe(result1);
  });

  it('invalidates when a relevant relationship object changes', () => {
    const rows = makeRows(5);
    const customersRows = makeRows(3);
    const dataSources = makeDataSources(rows, customersRows);

    // Expression field using a join to customers
    const joinField: StudioExpressionField = {
      id: 'expr-country',
      label: 'Country',
      sourceId: 'orders',
      isMeasure: false,
      expression: { joinSourceId: 'customers', fieldId: 'country' },
    } as unknown as StudioExpressionField;
    const exprFields = [joinField];

    const rel1: StudioRelationship = { sourceId: 'orders', targetId: 'customers', sourceField: 'customerId', targetField: 'id' } as StudioRelationship;
    const rel2: StudioRelationship = { sourceId: 'orders', targetId: 'customers', sourceField: 'customerId', targetField: 'id' } as StudioRelationship;

    const result1 = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, [rel1]);
    const result2 = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, [rel2]);

    // Different relationship object ref → cache miss
    expect(result2).not.toBe(result1);
  });

  // ─── Cross-source isolation ───────────────────────────────────────────────

  it('does NOT invalidate orders cache when customers rows change', () => {
    const ordersRows = makeRows(10);
    const customersRows1 = makeRows(5);
    const customersRows2 = makeRows(5); // new ref — simulates customers data reload
    const ordersField = makeOrdersExprField();
    const customersField = makeCustomersExprField();
    const exprFields = [ordersField, customersField];

    const dataSources1 = makeDataSources(ordersRows, customersRows1);
    const dataSources2 = makeDataSources(ordersRows, customersRows2); // orders rows SAME, customers CHANGED

    const result1 = getCachedEnrichedRows(ordersRows, 'orders', exprFields, dataSources1, NO_RELATIONSHIPS);
    // customers rows changed (dataSources2) — orders cache should still be warm
    const result2 = getCachedEnrichedRows(ordersRows, 'orders', exprFields, dataSources2, NO_RELATIONSHIPS);

    expect(result2).toBe(result1); // cache hit — customers change is irrelevant to orders
  });

  it('does NOT invalidate orders cache when an unrelated expression field changes', () => {
    const ordersRows = makeRows(10);
    const customersRows = makeRows(5);
    const dataSources = makeDataSources(ordersRows, customersRows);
    const ordersField = makeOrdersExprField();

    // First call: ordersField + a customers field
    const customersField1 = makeCustomersExprField();
    const result1 = getCachedEnrichedRows(ordersRows, 'orders', [ordersField, customersField1], dataSources, NO_RELATIONSHIPS);

    // Second call: ordersField unchanged, but customers field is a new object (simulates modification)
    const customersField2 = makeCustomersExprField(); // new object ref
    const result2 = getCachedEnrichedRows(ordersRows, 'orders', [ordersField, customersField2], dataSources, NO_RELATIONSHIPS);

    // Only ordersField matters for orders enrichment — cache hit
    expect(result2).toBe(result1);
  });

  it('does NOT invalidate orders cache when an unrelated relationship changes', () => {
    const ordersRows = makeRows(10);
    const dataSources = makeDataSources(ordersRows);
    const ordersField = makeOrdersExprField(); // arithmetic — no join
    const exprFields = [ordersField];

    // First call with an empty relationships array
    const result1 = getCachedEnrichedRows(ordersRows, 'orders', exprFields, dataSources, []);

    // Add a completely unrelated relationship (products → suppliers)
    const unrelatedRel: StudioRelationship = { sourceId: 'products', targetId: 'suppliers', sourceField: 'supplierId', targetField: 'id' } as StudioRelationship;
    const result2 = getCachedEnrichedRows(ordersRows, 'orders', exprFields, dataSources, [unrelatedRel]);

    // The unrelated relationship doesn't affect orders enrichment → cache hit
    expect(result2).toBe(result1);
  });

  // ─── Multi-source caching ─────────────────────────────────────────────────

  it('caches independently per sourceId', () => {
    const ordersRows = makeRows(5);
    const customersRows = makeRows(3);
    const dataSources = makeDataSources(ordersRows, customersRows);
    const ordersField = makeOrdersExprField();
    const customersField = makeCustomersExprField();
    const exprFields = [ordersField, customersField];

    const enrichedOrders = getCachedEnrichedRows(ordersRows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS);
    const enrichedCustomers = getCachedEnrichedRows(customersRows, 'customers', exprFields, dataSources, NO_RELATIONSHIPS);

    expect(enrichedOrders).not.toBe(enrichedCustomers);
    expect(enrichedOrders).toHaveLength(ordersRows.length);
    expect(enrichedCustomers).toHaveLength(customersRows.length);

    // Repeat calls return same references (cache hits)
    expect(getCachedEnrichedRows(ordersRows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS)).toBe(enrichedOrders);
    expect(getCachedEnrichedRows(customersRows, 'customers', exprFields, dataSources, NO_RELATIONSHIPS)).toBe(enrichedCustomers);
  });
});
