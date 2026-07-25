import { describe, it, expect } from 'vitest';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { MAX_ENTRIES_PER_ROWS } from './rowCacheLru';
import { evaluateMeasure } from '../utils/expressionEvaluator';
import type {
  StudioDataField,
  StudioDataSource,
  StudioExpressionField,
  StudioRelationship,
} from '../models';

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
      fields: [
        { id: 'id', label: 'ID', type: 'number' },
        { id: 'country', label: 'Country', type: 'string' },
      ],
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
    expression: {
      type: 'arithmetic',
      left: { type: 'field', fieldId: 'value' },
      op: '*',
      right: { type: 'literal', value: 2 },
    },
  } as unknown as StudioExpressionField;
}

/** Arithmetic expression field for customers source */
function makeCustomersExprField(): StudioExpressionField {
  return {
    id: 'expr-customers-triple',
    label: 'Triple',
    sourceId: 'customers',
    isMeasure: false,
    expression: {
      type: 'arithmetic',
      left: { type: 'field', fieldId: 'value' },
      op: '*',
      right: { type: 'literal', value: 3 },
    },
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
    const result = getCachedEnrichedRows(
      rows,
      undefined,
      exprFields,
      dataSources,
      NO_RELATIONSHIPS,
    );
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

    const result1 = getCachedEnrichedRows(
      rows1,
      'orders',
      exprFields,
      dataSources1,
      NO_RELATIONSHIPS,
    );
    const result2 = getCachedEnrichedRows(
      rows2,
      'orders',
      exprFields,
      dataSources2,
      NO_RELATIONSHIPS,
    );

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

    const rel1: StudioRelationship = {
      sourceId: 'orders',
      targetId: 'customers',
      sourceField: 'customerId',
      targetField: 'id',
    } as StudioRelationship;
    const rel2: StudioRelationship = {
      sourceId: 'orders',
      targetId: 'customers',
      sourceField: 'customerId',
      targetField: 'id',
    } as StudioRelationship;

    const result1 = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, [rel1]);
    const result2 = getCachedEnrichedRows(rows, 'orders', exprFields, dataSources, [rel2]);

    // Different relationship object ref → cache miss
    expect(result2).not.toBe(result1);
  });

  it('tracks a join source nested inside a function expression (finding 2.18)', () => {
    const ordersRows = makeRows(3).map((r, i) => ({ ...r, customerId: i }));
    const customersV1 = [
      { id: 0, country: 'US' },
      { id: 1, country: 'DE' },
      { id: 2, country: 'US' },
    ];
    const customersV2 = [
      { id: 0, country: 'FR' }, // changed value, new array ref
      { id: 1, country: 'DE' },
      { id: 2, country: 'US' },
    ];
    // A join nested INSIDE a function expression: if(customers.country, 1, 0). The top-level node
    // is a FunctionExpression, not a JoinFieldExpression, so the previous top-level-only check
    // missed the `customers` dependency entirely.
    const nestedJoinField: StudioExpressionField = {
      id: 'expr-flag',
      label: 'Flag',
      sourceId: 'orders',
      isMeasure: false,
      expression: {
        operator: 'if',
        inputs: [
          { joinSourceId: 'customers', fieldId: 'country' },
          { type: 'number', value: 1 },
          { type: 'number', value: 0 },
        ],
      },
    } as unknown as StudioExpressionField;
    const rel: StudioRelationship = {
      sourceId: 'orders',
      targetId: 'customers',
      sourceField: 'customerId',
      targetField: 'id',
    } as StudioRelationship;

    const ds1 = makeDataSources(ordersRows, customersV1);
    const ds2 = makeDataSources(ordersRows, customersV2); // orders SAME ref, customers CHANGED

    const r1 = getCachedEnrichedRows(ordersRows, 'orders', [nestedJoinField], ds1, [rel]);
    const r2 = getCachedEnrichedRows(ordersRows, 'orders', [nestedJoinField], ds2, [rel]);

    // The nested join source is now tracked → a customers rows change invalidates the entry.
    expect(r2).not.toBe(r1);
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

    const result1 = getCachedEnrichedRows(
      ordersRows,
      'orders',
      exprFields,
      dataSources1,
      NO_RELATIONSHIPS,
    );
    // customers rows changed (dataSources2) — orders cache should still be warm
    const result2 = getCachedEnrichedRows(
      ordersRows,
      'orders',
      exprFields,
      dataSources2,
      NO_RELATIONSHIPS,
    );

    expect(result2).toBe(result1); // cache hit — customers change is irrelevant to orders
  });

  it('does NOT invalidate orders cache when an unrelated expression field changes', () => {
    const ordersRows = makeRows(10);
    const customersRows = makeRows(5);
    const dataSources = makeDataSources(ordersRows, customersRows);
    const ordersField = makeOrdersExprField();

    // First call: ordersField + a customers field
    const customersField1 = makeCustomersExprField();
    const result1 = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [ordersField, customersField1],
      dataSources,
      NO_RELATIONSHIPS,
    );

    // Second call: ordersField unchanged, but customers field is a new object (simulates modification)
    const customersField2 = makeCustomersExprField(); // new object ref
    const result2 = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [ordersField, customersField2],
      dataSources,
      NO_RELATIONSHIPS,
    );

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
    const unrelatedRel: StudioRelationship = {
      sourceId: 'products',
      targetId: 'suppliers',
      sourceField: 'supplierId',
      targetField: 'id',
    } as StudioRelationship;
    const result2 = getCachedEnrichedRows(ordersRows, 'orders', exprFields, dataSources, [
      unrelatedRel,
    ]);

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

    const enrichedOrders = getCachedEnrichedRows(
      ordersRows,
      'orders',
      exprFields,
      dataSources,
      NO_RELATIONSHIPS,
    );
    const enrichedCustomers = getCachedEnrichedRows(
      customersRows,
      'customers',
      exprFields,
      dataSources,
      NO_RELATIONSHIPS,
    );

    expect(enrichedOrders).not.toBe(enrichedCustomers);
    expect(enrichedOrders).toHaveLength(ordersRows.length);
    expect(enrichedCustomers).toHaveLength(customersRows.length);

    // Repeat calls return same references (cache hits)
    expect(
      getCachedEnrichedRows(ordersRows, 'orders', exprFields, dataSources, NO_RELATIONSHIPS),
    ).toBe(enrichedOrders);
    expect(
      getCachedEnrichedRows(customersRows, 'customers', exprFields, dataSources, NO_RELATIONSHIPS),
    ).toBe(enrichedCustomers);
  });

  it('without usedFieldIds (source-scoped): unused same-source expression causes recompute', () => {
    // Backward-compat: when usedFieldIds is not passed, ALL non-measure expressions
    // for the source are enriched together.  Adding a second expression causes a miss.
    const ordersRows = makeRows(5);
    const dataSources = makeDataSources(ordersRows);

    const exprA = makeOrdersExprField(); // id: 'expr-double'

    // Prime cache with exprA only.
    const firstResult = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [exprA],
      dataSources,
      NO_RELATIONSHIPS,
    );

    // Add a second expression for the same source (unused by any widget).
    const exprB: StudioExpressionField = {
      id: 'expr-triple',
      label: 'Triple (unused)',
      sourceId: 'orders',
      isMeasure: false,
      expression: {
        type: 'arithmetic',
        left: { type: 'field', fieldId: 'value' },
        op: '*',
        right: { type: 'literal', value: 3 },
      },
    } as unknown as StudioExpressionField;

    // Cache miss: relevantFields now has 2 entries → different from cached 1.
    const secondResult = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [exprA, exprB],
      dataSources,
      NO_RELATIONSHIPS,
    );

    // Different object → recomputed (one-time cost).
    expect(secondResult).not.toBe(firstResult);
    // Both expressions were computed.
    expect(secondResult[0]['expr-double']).toBeDefined();
    expect(secondResult[0]['expr-triple']).toBeDefined();

    // Subsequent call with the same two-expression set is cached again (O(1)).
    expect(
      getCachedEnrichedRows(ordersRows, 'orders', [exprA, exprB], dataSources, NO_RELATIONSHIPS),
    ).toBe(secondResult);
  });

  it('with usedFieldIds (widget-scoped): unused same-source expression does NOT cause recompute', () => {
    // With lazy-by-widget enrichment, each widget passes the field IDs it actually
    // uses.  Adding an expression the widget doesn't use doesn't invalidate its slot.
    const ordersRows = makeRows(5);
    const dataSources = makeDataSources(ordersRows);

    const exprA = makeOrdersExprField(); // id: 'expr-double'
    const widgetUsedIds = new Set(['expr-double']); // widget only uses exprA

    // Prime cache: widget uses only exprA.
    const firstResult = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [exprA],
      dataSources,
      NO_RELATIONSHIPS,
      widgetUsedIds,
    );

    // Add exprB for the same source — but the widget still only uses exprA.
    const exprB: StudioExpressionField = {
      id: 'expr-triple',
      label: 'Triple (unused)',
      sourceId: 'orders',
      isMeasure: false,
      expression: {
        type: 'arithmetic',
        left: { type: 'field', fieldId: 'value' },
        op: '*',
        right: { type: 'literal', value: 3 },
      },
    } as unknown as StudioExpressionField;

    const secondResult = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [exprA, exprB],
      dataSources,
      NO_RELATIONSHIPS,
      widgetUsedIds, // same usedFieldIds — exprB is not in the set
    );

    // Cache hit: the widget's field set hasn't changed → same object reference.
    expect(secondResult).toBe(firstResult);
    // Only exprA was enriched.
    expect(secondResult[0]['expr-double']).toBeDefined();
    expect((secondResult[0] as Record<string, unknown>)['expr-triple']).toBeUndefined();
  });

  it('with usedFieldIds: different widgets get independent cache slots for the same source', () => {
    // Widget A uses expr-double; Widget B uses expr-double AND expr-triple.
    // Each widget gets its own cache slot keyed on its specific field set.
    const ordersRows = makeRows(5);
    const dataSources = makeDataSources(ordersRows);

    const exprA = makeOrdersExprField(); // id: 'expr-double'
    const exprB: StudioExpressionField = {
      id: 'expr-triple',
      label: 'Triple',
      sourceId: 'orders',
      isMeasure: false,
      expression: {
        type: 'arithmetic',
        left: { type: 'field', fieldId: 'value' },
        op: '*',
        right: { type: 'literal', value: 3 },
      },
    } as unknown as StudioExpressionField;
    const allExprs = [exprA, exprB];

    const widgetAIds = new Set(['expr-double']);
    const widgetBIds = new Set(['expr-double', 'expr-triple']);

    const resultA = getCachedEnrichedRows(
      ordersRows,
      'orders',
      allExprs,
      dataSources,
      NO_RELATIONSHIPS,
      widgetAIds,
    );
    const resultB = getCachedEnrichedRows(
      ordersRows,
      'orders',
      allExprs,
      dataSources,
      NO_RELATIONSHIPS,
      widgetBIds,
    );

    // Different cache slots → different result objects.
    expect(resultA).not.toBe(resultB);
    // Widget A's result has only expr-double.
    expect(resultA[0]['expr-double']).toBeDefined();
    expect((resultA[0] as Record<string, unknown>)['expr-triple']).toBeUndefined();
    // Widget B's result has both.
    expect(resultB[0]['expr-double']).toBeDefined();
    expect(resultB[0]['expr-triple']).toBeDefined();

    // Each widget's slot stays warm independently.
    expect(
      getCachedEnrichedRows(
        ordersRows,
        'orders',
        allExprs,
        dataSources,
        NO_RELATIONSHIPS,
        widgetAIds,
      ),
    ).toBe(resultA);
    expect(
      getCachedEnrichedRows(
        ordersRows,
        'orders',
        allExprs,
        dataSources,
        NO_RELATIONSHIPS,
        widgetBIds,
      ),
    ).toBe(resultB);
  });

  it("expression on an unrelated source has zero effect on this source's cache", () => {
    const ordersRows = makeRows(5);
    const customersRows = makeRows(3);
    const dataSources = makeDataSources(ordersRows, customersRows);

    const exprOrders = makeOrdersExprField();

    // Prime cache for orders.
    const firstResult = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [exprOrders],
      dataSources,
      NO_RELATIONSHIPS,
    );

    // Add a new expression for 'customers' (unrelated to 'orders').
    const exprCustomers = makeCustomersExprField();

    // Orders cache entry is unaffected — relevantFields for 'orders' is unchanged.
    const secondResult = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [exprOrders, exprCustomers],
      dataSources,
      NO_RELATIONSHIPS,
    );

    // Same object reference — no recompute.
    expect(secondResult).toBe(firstResult);
  });

  // ─── WeakMap-by-rows keying (Part A item 4) ─────────────────────────────────

  it('keeps independent cache slots for two distinct rows arrays of the same source', () => {
    // Two <Studio> instances inject same-named sources with DISTINCT rows arrays.
    // Under the old sourceId-keyed Map, the second instance's call evicted the
    // first's entry (thrash). With WeakMap-by-rows keying, each stays warm.
    const rowsA = makeRows(5);
    const rowsB = makeRows(5); // different array reference, same sourceId 'orders'
    const expr = makeOrdersExprField();
    const dsA = makeDataSources(rowsA);
    const dsB = makeDataSources(rowsB);

    const a1 = getCachedEnrichedRows(rowsA, 'orders', [expr], dsA, NO_RELATIONSHIPS);
    const b1 = getCachedEnrichedRows(rowsB, 'orders', [expr], dsB, NO_RELATIONSHIPS);
    expect(a1).not.toBe(b1);

    // Re-request each: both slots must still be warm (independent entries).
    const a2 = getCachedEnrichedRows(rowsA, 'orders', [expr], dsA, NO_RELATIONSHIPS);
    const b2 = getCachedEnrichedRows(rowsB, 'orders', [expr], dsB, NO_RELATIONSHIPS);
    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
  });

  it('shares one entry when two calls pass the SAME rows reference', () => {
    // Two instances that legitimately share a rows reference should share the entry.
    const shared = makeRows(8);
    const expr = makeOrdersExprField();
    const ds = makeDataSources(shared);

    const first = getCachedEnrichedRows(shared, 'orders', [expr], ds, NO_RELATIONSHIPS);
    const second = getCachedEnrichedRows(shared, 'orders', [expr], ds, NO_RELATIONSHIPS);
    expect(second).toBe(first);
  });

  // ─── Inner-map LRU cap (M2) ────────────────────────────────────────────────

  it('caps the per-rows field-set map and evicts the least-recently-used entry', () => {
    // `usedFieldIds` derives from widget config + reachable filter fields, so adding grid
    // columns one at a time mints a new fieldSetKey per column. Without a cap, every
    // historical field set retained a full enriched clone of the rows array for as long as
    // that rows array lived — and the outer WeakMap key IS that rows array, so it never helped.
    const rows = makeRows(4);
    const dataSources = makeDataSources(rows);
    // One expression field per distinct slot, so each usedFieldIds set produces its own key.
    const exprFields = Array.from(
      { length: MAX_ENTRIES_PER_ROWS + 2 },
      (_, i) =>
        ({
          id: `expr-${i}`,
          label: `Expr ${i}`,
          sourceId: 'orders',
          isMeasure: false,
          expression: { operator: 'add', inputs: [{ id: 'value' }, { type: 'number', value: i }] },
        }) as unknown as StudioExpressionField,
    );

    const first = getCachedEnrichedRows(
      rows,
      'orders',
      exprFields,
      dataSources,
      NO_RELATIONSHIPS,
      new Set(['expr-0']),
    );

    // Fill past capacity with distinct field sets.
    for (let i = 1; i < exprFields.length; i += 1) {
      getCachedEnrichedRows(
        rows,
        'orders',
        exprFields,
        dataSources,
        NO_RELATIONSHIPS,
        new Set([`expr-${i}`]),
      );
    }

    // The oldest slot was evicted → recomputed (new reference) rather than served.
    const firstAgain = getCachedEnrichedRows(
      rows,
      'orders',
      exprFields,
      dataSources,
      NO_RELATIONSHIPS,
      new Set(['expr-0']),
    );
    expect(firstAgain).not.toBe(first);
    // ...but it is still correct.
    expect(firstAgain[1]['expr-0']).toBe(10);
  });

  it('keeps a repeatedly-used field set warm while others churn (read refreshes recency)', () => {
    const rows = makeRows(4);
    const dataSources = makeDataSources(rows);
    const hotField = makeOrdersExprField(); // id: 'expr-double'
    // Comfortably past the cap so evictions genuinely happen during the loop.
    const churnFields = Array.from(
      { length: MAX_ENTRIES_PER_ROWS * 2 },
      (_, i) =>
        ({
          id: `churn-${i}`,
          label: `Churn ${i}`,
          sourceId: 'orders',
          isMeasure: false,
          expression: { operator: 'add', inputs: [{ id: 'value' }, { type: 'number', value: i }] },
        }) as unknown as StudioExpressionField,
    );
    const allFields = [hotField, ...churnFields];
    const hotIds = new Set(['expr-double']);

    const hot = getCachedEnrichedRows(
      rows,
      'orders',
      allFields,
      dataSources,
      NO_RELATIONSHIPS,
      hotIds,
    );

    for (let i = 0; i < churnFields.length; i += 1) {
      getCachedEnrichedRows(
        rows,
        'orders',
        allFields,
        dataSources,
        NO_RELATIONSHIPS,
        new Set([`churn-${i}`]),
      );
      // Re-read the hot slot between churn inserts — this must move it back to newest.
      expect(
        getCachedEnrichedRows(rows, 'orders', allFields, dataSources, NO_RELATIONSHIPS, hotIds),
      ).toBe(hot);
    }
  });
});

// ─── Measure dependency expansion (C1) ────────────────────────────────────────
//
// A widget's `usedFieldIds` is `collectSelectFields(widget)`, which for a KPI is the
// MEASURE's id. Expansion used to run against a map built from `!ef.isMeasure` fields only,
// so `fieldById.get(measureId)` missed, the transitive walk returned immediately,
// `relevantFields` came back empty and `getCachedEnrichedRows` handed back the RAW rows. The
// measure then aggregated a calculated column that was never computed and read 0 — on the
// canvas — while the data drawer's source-scoped preview of the SAME measure read the right
// number.

describe('getCachedEnrichedRows — measure dependency expansion (C1)', () => {
  const revenueField: StudioDataField = { id: 'revenue', label: 'Revenue', type: 'number' };
  const costField: StudioDataField = { id: 'cost', label: 'Cost', type: 'number' };

  function makeSalesRows(): Row[] {
    return [
      { revenue: 100, cost: 60 },
      { revenue: 200, cost: 120 },
    ];
  }

  function makeSalesSources(rows: Row[]): Record<string, StudioDataSource> {
    return {
      sales: { id: 'sales', label: 'Sales', rows, fields: [revenueField, costField] },
    };
  }

  /** Calculated column: `revenue - cost`. */
  const profitColumn: StudioExpressionField = {
    id: 'profit',
    label: 'Profit',
    sourceId: 'sales',
    isMeasure: false,
    expression: { operator: 'subtract', inputs: [{ id: 'revenue' }, { id: 'cost' }] },
  } as unknown as StudioExpressionField;

  /** Measure: `sum(profit)` — references the calculated column above. */
  const totalProfitMeasure: StudioExpressionField = {
    id: 'm-total-profit',
    label: 'Total profit',
    sourceId: 'sales',
    isMeasure: true,
    expression: { id: 'profit', aggregation: 'sum' },
  } as unknown as StudioExpressionField;

  const salesFields = [profitColumn, totalProfitMeasure];

  it('enriches the calculated column a requested MEASURE depends on', () => {
    const rows = makeSalesRows();
    const enriched = getCachedEnrichedRows(
      rows,
      'sales',
      salesFields,
      makeSalesSources(rows),
      NO_RELATIONSHIPS,
      new Set(['m-total-profit']), // the widget only names the measure
    );

    // Before the fix this was the RAW rows array, with no `profit` key at all.
    expect(enriched).not.toBe(rows);
    expect(enriched[0].profit).toBe(40);
    expect(enriched[1].profit).toBe(80);
  });

  it('produces the same measure value on the widget path and the source path', () => {
    // Distinct (structurally identical) rows arrays so the two paths compute independently
    // instead of one serving the other's cache entry.
    const widgetRows = makeSalesRows();
    const sourceRows = makeSalesRows();

    const widgetEnriched = getCachedEnrichedRows(
      widgetRows,
      'sales',
      salesFields,
      makeSalesSources(widgetRows),
      NO_RELATIONSHIPS,
      new Set(['m-total-profit']), // widget path (KPI tile on the canvas)
    );
    const sourceEnriched = getCachedEnrichedRows(
      sourceRows,
      'sales',
      salesFields,
      makeSalesSources(sourceRows),
      NO_RELATIONSHIPS,
      // source path (data-drawer preview) — no usedFieldIds
    );

    const widgetValue = evaluateMeasure(totalProfitMeasure, widgetEnriched, salesFields);
    const sourceValue = evaluateMeasure(totalProfitMeasure, sourceEnriched, salesFields);

    // Before the fix: widgetValue === 0, sourceValue === 120.
    expect(widgetValue).toBe(120);
    expect(sourceValue).toBe(120);
    expect(widgetValue).toBe(sourceValue);
  });

  it('never writes the measure itself onto a row', () => {
    const rows = makeSalesRows();
    const enriched = getCachedEnrichedRows(
      rows,
      'sales',
      salesFields,
      makeSalesSources(rows),
      NO_RELATIONSHIPS,
      new Set(['m-total-profit']),
    );
    // Measures are dropped AFTER the closure — they have no per-row value.
    expect('m-total-profit' in enriched[0]).toBe(false);
  });

  it('expands transitively through a chain of calculated columns behind a measure', () => {
    const rows = makeSalesRows();
    // margin = profit * 2; measure = sum(margin) → must pull in BOTH margin and profit.
    const marginColumn: StudioExpressionField = {
      id: 'margin',
      label: 'Margin',
      sourceId: 'sales',
      isMeasure: false,
      expression: {
        operator: 'multiply',
        inputs: [{ id: 'profit' }, { type: 'number', value: 2 }],
      },
    } as unknown as StudioExpressionField;
    const marginMeasure: StudioExpressionField = {
      id: 'm-total-margin',
      label: 'Total margin',
      sourceId: 'sales',
      isMeasure: true,
      expression: { id: 'margin', aggregation: 'sum' },
    } as unknown as StudioExpressionField;
    const fields = [profitColumn, marginColumn, marginMeasure];

    const enriched = getCachedEnrichedRows(
      rows,
      'sales',
      fields,
      makeSalesSources(rows),
      NO_RELATIONSHIPS,
      new Set(['m-total-margin']),
    );

    expect(enriched[0].profit).toBe(40);
    expect(enriched[0].margin).toBe(80);
    expect(evaluateMeasure(marginMeasure, enriched, fields)).toBe(240);
  });

  it('still enriches nothing when the requested set names only unrelated fields', () => {
    // Guard against over-widening: a widget that uses no expression field at all must still
    // short-circuit to the raw rows.
    const rows = makeSalesRows();
    const enriched = getCachedEnrichedRows(
      rows,
      'sales',
      salesFields,
      makeSalesSources(rows),
      NO_RELATIONSHIPS,
      new Set(['revenue']), // a physical column
    );
    expect(enriched).toBe(rows);
  });
});

// ─── Joined-source `fields` tracking (M3) ─────────────────────────────────────

describe('getCachedEnrichedRows — joined source fields dependency (M3)', () => {
  it('invalidates when a JOINED source retypes a field without replacing its rows', () => {
    // The join reads the foreign source through `getCachedNormalizedDataSource`, which is
    // keyed on rows AND fields. `updateDataSourceField` patches `fields` only, keeping the
    // same `rows` reference — so tracking rows alone returned the stale enriched array by
    // reference, carrying the raw `Date` instead of the canonical 'YYYY-MM-DD'.
    const ordersRows: Row[] = [{ id: 0, customerId: 0 }];
    const customersRows: Row[] = [{ id: 0, signupDate: new Date('2024-01-15T12:00:00.000Z') }];

    const idField: StudioDataField = { id: 'id', label: 'ID', type: 'number' };
    const signupAsString: StudioDataField = { id: 'signupDate', label: 'Signup', type: 'string' };
    const signupAsDate: StudioDataField = { id: 'signupDate', label: 'Signup', type: 'date' };

    const makeSources = (customerFields: StudioDataField[]): Record<string, StudioDataSource> => ({
      orders: { id: 'orders', label: 'Orders', rows: ordersRows, fields: [idField] },
      // SAME rows reference in both variants — only `fields` differs.
      customers: {
        id: 'customers',
        label: 'Customers',
        rows: customersRows,
        fields: customerFields,
      },
    });

    const joinField: StudioExpressionField = {
      id: 'expr-signup',
      label: 'Signup',
      sourceId: 'orders',
      isMeasure: false,
      expression: { joinSourceId: 'customers', fieldId: 'signupDate' },
    } as unknown as StudioExpressionField;
    const rel: StudioRelationship = {
      id: 'rel-1',
      sourceId: 'orders',
      targetId: 'customers',
      sourceField: 'customerId',
      targetField: 'id',
    } as StudioRelationship;

    const before = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [joinField],
      makeSources([idField, signupAsString]),
      [rel],
    );
    const after = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [joinField],
      makeSources([idField, signupAsDate]),
      [rel],
    );

    // Before the fix these were the SAME array (fields were not part of the validity check).
    expect(after).not.toBe(before);
    // The retyped foreign column now arrives L1-normalized instead of as a raw Date.
    expect(before[0]['expr-signup']).toBeInstanceOf(Date);
    expect(after[0]['expr-signup']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('still hits the cache when an UNRELATED source retypes a field', () => {
    const ordersRows = makeRows(3);
    const dataSources1 = makeDataSources(ordersRows, makeRows(2));
    const expr = makeOrdersExprField(); // arithmetic — joins nothing

    const first = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [expr],
      dataSources1,
      NO_RELATIONSHIPS,
    );
    // Rebuild `customers` with a brand new fields array — orders joins nothing, so no effect.
    const dataSources2 = makeDataSources(ordersRows, dataSources1.customers.rows as Row[]);
    const second = getCachedEnrichedRows(
      ordersRows,
      'orders',
      [expr],
      dataSources2,
      NO_RELATIONSHIPS,
    );

    expect(second).toBe(first);
  });
});
