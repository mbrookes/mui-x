import { describe, expect, it } from 'vitest';
import { getReachableSourceIds, enrichRowsWithRelatedFields, resolveRows } from './dataSourceGraph';
import { analyzeChartSupport, resolveChartRowsForAggregation } from './chartAggregation';
import type {
  StudioDataField,
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
} from '../models';

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    value: '',
    scope: 'widget',
    ...overrides,
  };
}

function makeSource(rows: Record<string, unknown>[]): StudioDataSource {
  return { id: 'src', label: 'Source', fields: [], rows };
}

// ─── resolveRows — cross-source filtering ─────────────────────────────────────

describe('resolveRows', () => {
  const orders = [
    { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
    { id: 'ORD-2', customerId: 'CUS-2', total: 200 },
    { id: 'ORD-3', customerId: 'CUS-1', total: 300 },
  ];

  const customers = [
    { id: 'CUS-1', country: 'Germany' },
    { id: 'CUS-2', country: 'France' },
  ];

  const dataSources: Record<string, StudioDataSource> = {
    orders: makeSource(orders),
    customers: makeSource(customers),
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-1',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  it('native filter applied directly to widget rows', () => {
    const result = resolveRows(
      orders,
      'orders',
      [makeFilter({ field: 'total', operator: 'greater_than', value: 150, fieldType: 'number' })],
      dataSources,
      relationships,
    );
    expect(result.map((r) => r.id)).toEqual(['ORD-2', 'ORD-3']);
  });

  it('cross-source filter: filter customers by country, semi-join to orders', () => {
    const result = resolveRows(
      orders,
      'orders',
      [
        makeFilter({
          field: 'country',
          operator: 'equals',
          value: 'Germany',
          filterSourceId: 'customers',
        }),
      ],
      dataSources,
      relationships,
    );
    // CUS-1 is German → ORD-1 and ORD-3
    expect(result.map((r) => r.id).sort()).toEqual(['ORD-1', 'ORD-3']);
  });

  it('cross-source filter with no matching relationship is silently skipped', () => {
    const result = resolveRows(
      orders,
      'orders',
      [
        makeFilter({
          field: 'country',
          operator: 'equals',
          value: 'Germany',
          filterSourceId: 'unrelated-source',
        }),
      ],
      dataSources,
      relationships,
    );
    // No relationship found → filter ignored → all rows returned
    expect(result).toHaveLength(3);
  });

  it('cross-source filter: join works from the "one" side too', () => {
    // Filter orders by customer (one→many traversal)
    const result = resolveRows(
      customers,
      'customers',
      [
        makeFilter({
          field: 'total',
          operator: 'greater_than',
          value: 150,
          fieldType: 'number',
          filterSourceId: 'orders',
        }),
      ],
      dataSources,
      relationships,
    );
    // Orders > 150: ORD-2 (CUS-2), ORD-3 (CUS-1) → both customers
    expect(result.map((r) => r.id).sort()).toEqual(['CUS-1', 'CUS-2']);
  });

  it('cross-source + native filter together', () => {
    const result = resolveRows(
      orders,
      'orders',
      [
        makeFilter({
          field: 'country',
          operator: 'equals',
          value: 'Germany',
          filterSourceId: 'customers',
        }),
        makeFilter({
          id: 'f2',
          field: 'total',
          operator: 'greater_than',
          value: 150,
          fieldType: 'number',
        }),
      ],
      dataSources,
      relationships,
    );
    // German customers → ORD-1 (100), ORD-3 (300); then total > 150 → ORD-3
    expect(result.map((r) => r.id)).toEqual(['ORD-3']);
  });

  it('returns all rows when no filters active', () => {
    const result = resolveRows(orders, 'orders', [], dataSources, relationships);
    expect(result).toHaveLength(3);
  });
});

// ─── resolveRows — cross-filter regression (ORDER_ITEMS → ORDERS) ─────────────
//
// Mirrors the real bug: a "Revenue by Category" chart (ORDER_ITEMS source) emits
// a cross-filter. A "Revenue by Country" chart (ORDERS source) receives it.
// Without filterSourceId the filter was treated as native → ORDERS has no
// "category" field → undefined == "Electronics" is false → 0 rows → blank chart.

describe('resolveRows — cross-filter via ORDER_ITEMS → ORDERS join', () => {
  const orders = [
    { id: 'ORD-1', country: 'Germany', total: 100 },
    { id: 'ORD-2', country: 'France', total: 200 },
    { id: 'ORD-3', country: 'Germany', total: 300 },
  ];

  const orderItems = [
    { id: 'ITEM-1', orderId: 'ORD-1', category: 'Electronics', amount: 50 },
    { id: 'ITEM-2', orderId: 'ORD-1', category: 'Clothing', amount: 50 },
    { id: 'ITEM-3', orderId: 'ORD-2', category: 'Electronics', amount: 200 },
    { id: 'ITEM-4', orderId: 'ORD-3', category: 'Clothing', amount: 300 },
  ];

  const dataSources: Record<string, StudioDataSource> = {
    orders: makeSource(orders),
    orderItems: makeSource(orderItems),
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-orderitems-orders',
      sourceId: 'orderItems',
      sourceField: 'orderId',
      targetId: 'orders',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  it('with filterSourceId: filters ORDERS to those with an Electronics item', () => {
    const result = resolveRows(
      orders,
      'orders',
      [
        makeFilter({
          field: 'category',
          operator: 'equals',
          value: 'Electronics',
          filterSourceId: 'orderItems',
        }),
      ],
      dataSources,
      relationships,
    );
    // ORD-1 has an Electronics item; ORD-2 has an Electronics item; ORD-3 does not
    expect(result.map((r) => r.id).sort()).toEqual(['ORD-1', 'ORD-2']);
  });

  it('regression: without filterSourceId the filter is applied natively and returns no rows', () => {
    // This demonstrates the bug that was fixed: when applyCrossFilter did not
    // attach filterSourceId, the filter landed as a native ORDERS filter.
    // ORDERS rows have no "category" field, so "category == Electronics" is
    // undefined == "Electronics" → false for every row → empty result.
    const result = resolveRows(
      orders,
      'orders',
      [
        makeFilter({
          field: 'category',
          operator: 'equals',
          value: 'Electronics',
          // no filterSourceId — treated as native filter on ORDERS
        }),
      ],
      dataSources,
      relationships,
    );
    expect(result).toHaveLength(0);
  });

  it('with filterSourceId: cross-filter on orderItems combined with native filter on orders', () => {
    const result = resolveRows(
      orders,
      'orders',
      [
        makeFilter({
          field: 'category',
          operator: 'equals',
          value: 'Electronics',
          filterSourceId: 'orderItems',
        }),
        makeFilter({ id: 'f2', field: 'country', operator: 'equals', value: 'Germany' }),
      ],
      dataSources,
      relationships,
    );
    // Electronics orders: ORD-1 and ORD-2; German orders: ORD-1 and ORD-3 → intersection: ORD-1
    expect(result.map((r) => r.id)).toEqual(['ORD-1']);
  });

  it('with filterSourceId: multiple cross-filters from the same source are ANDed', () => {
    const result = resolveRows(
      orders,
      'orders',
      [
        makeFilter({
          id: 'cf1',
          field: 'category',
          operator: 'equals',
          value: 'Electronics',
          filterSourceId: 'orderItems',
        }),
        makeFilter({
          id: 'cf2',
          field: 'amount',
          operator: 'greater_than',
          value: 100,
          fieldType: 'number',
          filterSourceId: 'orderItems',
        }),
      ],
      dataSources,
      relationships,
    );
    // Electronics items: ITEM-1 (amount 50, ORD-1), ITEM-3 (amount 200, ORD-2)
    // amount > 100: ITEM-3 (ORD-2)
    // Cross-filters are applied sequentially, so only ORD-2 survives both
    expect(result.map((r) => r.id)).toEqual(['ORD-2']);
  });
});

// ─── dual cross-filter: category (ORDER_ITEMS) + date between (ORDERS) ────────
//
// Mirrors the real bug: clicking Category=Supplies on "Revenue by Category" AND
// Q1 2024 on "Quarterly Revenue by Category" simultaneously. Both cross-filters
// must propagate correctly to downstream widgets on both ORDER_ITEMS and ORDERS.

describe('resolveRows — dual cross-filter: category on ORDER_ITEMS + date between on ORDERS', () => {
  const orders: Record<string, unknown>[] = [
    { id: 'o1', date: '2024-01-15', total: 100 }, // Q1 2024
    { id: 'o2', date: '2024-04-15', total: 200 }, // Q2 2024
    { id: 'o3', date: '2024-02-10', total: 150 }, // Q1 2024
  ];

  const orderItems: Record<string, unknown>[] = [
    { id: 'i1', orderId: 'o1', category: 'Supplies', total: 60 },
    { id: 'i2', orderId: 'o1', category: 'Electronics', total: 40 },
    { id: 'i3', orderId: 'o2', category: 'Supplies', total: 200 },
    { id: 'i4', orderId: 'o3', category: 'Supplies', total: 150 },
  ];

  const ordersSource: StudioDataSource = {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'date', label: 'Date', type: 'date' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: orders,
  };

  const orderItemsSource: StudioDataSource = {
    id: 'orderItems',
    label: 'Order Items',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'orderId', label: 'Order ID', type: 'string' },
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: orderItems,
  };

  const dataSources: Record<string, StudioDataSource> = {
    orders: ordersSource,
    orderItems: orderItemsSource,
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-orderitems-orders',
      sourceId: 'orderItems',
      sourceField: 'orderId',
      targetId: 'orders',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  // Cross-filter 1: "Revenue by Category" chart emits category=Supplies
  const categoryCrossFilter = makeFilter({
    id: 'cf-category',
    field: 'category',
    operator: 'equals',
    value: 'Supplies',
    filterSourceId: 'orderItems',
  });

  // Cross-filter 2: "Quarterly Revenue by Category" chart emits date between Q1 2024
  const dateCrossFilter = makeFilter({
    id: 'cf-date',
    field: 'date',
    operator: 'between',
    value: { from: '2024-01-01', to: '2024-03-31' },
    fieldType: 'date',
    filterSourceId: 'orders',
  });

  it('analyzeChartSupport: date field on ORDER_ITEMS widget owned by ORDERS', () => {
    // Verify that "Quarterly Revenue by Category" correctly identifies 'date' as owned by ORDERS.
    // This is the source of filterSourceId used when emitting the date cross-filter.
    const support = analyzeChartSupport(
      'orderItems',
      'date',
      ['total'],
      'category',
      'bar-stacked',
      dataSources,
      relationships,
    );
    expect(support.supported).toBe(true);
    expect(support.fieldOwners?.get('date')).toBe('orders');
    expect(support.fieldOwners?.get('total')).toBe('orderItems');
    expect(support.fieldOwners?.get('category')).toBe('orderItems');
  });

  it('ORDER_ITEMS widget receiving date cross-filter (filterSourceId=orders) returns Q1 items', () => {
    // "Revenue by Category" (ORDER_ITEMS) receiving the date cross-filter only.
    // Expected: i1, i2, i4 (the items belonging to Q1 2024 orders o1 and o3).
    const result = resolveRows(
      orderItems,
      'orderItems',
      [dateCrossFilter],
      dataSources,
      relationships,
    );
    expect(result.map((r) => r.id).sort()).toEqual(['i1', 'i2', 'i4']);
  });

  it('ORDERS widget receiving both cross-filters returns Q1 orders with Supplies items', () => {
    // "Revenue by Country" or "Recent Orders" (ORDERS) receiving both cross-filters:
    //   - category=Supplies (filterSourceId=orderItems) → semi-join
    //   - date between Q1 2024 (filterSourceId=orders = widgetSourceId) → native filter
    // Expected: o1 and o3 both have Supplies items and fall in Q1 2024.
    const result = resolveRows(
      orders,
      'orders',
      [categoryCrossFilter, dateCrossFilter],
      dataSources,
      relationships,
    );
    expect(result.map((r) => r.id).sort()).toEqual(['o1', 'o3']);
  });

  it('ORDER_ITEMS widget receiving both cross-filters from other widgets', () => {
    // A second ORDER_ITEMS widget receiving both cross-filters (neither is its own):
    //   - category=Supplies (filterSourceId=orderItems = widgetSourceId) → native filter
    //   - date between Q1 2024 (filterSourceId=orders ≠ widgetSourceId) → cross-filter
    // Expected: Q1 2024 items (i1, i2, i4) that are also Supplies (i1, i4).
    const result = resolveRows(
      orderItems,
      'orderItems',
      [categoryCrossFilter, dateCrossFilter],
      dataSources,
      relationships,
    );
    expect(result.map((r) => r.id).sort()).toEqual(['i1', 'i4']);
  });
});

// ─── getReachableSourceIds ────────────────────────────────────────────────────

describe('getReachableSourceIds', () => {
  const relationships: StudioRelationship[] = [
    {
      id: 'r1',
      sourceId: 'orderItems',
      sourceField: 'orderId',
      targetId: 'orders',
      targetField: 'id',
      type: 'many-to-one',
    },
    {
      id: 'r2',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  it('always includes the sourceId itself', () => {
    const result = getReachableSourceIds('orders', relationships);
    expect(result.has('orders')).toBe(true);
  });

  it('includes targets of outgoing relationships', () => {
    const result = getReachableSourceIds('orders', relationships);
    expect(result.has('customers')).toBe(true);
  });

  it('includes sources of incoming relationships (reverse hop)', () => {
    const result = getReachableSourceIds('orders', relationships);
    expect(result.has('orderItems')).toBe(true);
  });

  it('returns only the source itself when no relationships exist', () => {
    const result = getReachableSourceIds('orphan', []);
    expect(result.size).toBe(1);
    expect(result.has('orphan')).toBe(true);
  });

  it('handles unrelated sources being absent from the result', () => {
    const result = getReachableSourceIds('orderItems', relationships);
    expect(result.has('customers')).toBe(false); // customers is not directly related to orderItems
    expect(result.has('orders')).toBe(true);
  });
});

// ─── enrichRowsWithRelatedFields ─────────────────────────────────────────────

describe('enrichRowsWithRelatedFields', () => {
  const orders = [
    { id: 'ORD-1', customerId: 'CUS-1' },
    { id: 'ORD-2', customerId: 'CUS-2' },
    { id: 'ORD-3', customerId: 'CUS-1' },
  ];
  const customers = [
    { id: 'CUS-1', country: 'Germany', tier: 'gold' },
    { id: 'CUS-2', country: 'France', tier: 'silver' },
  ];

  const dataSources: Record<string, StudioDataSource> = {
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'customerId', label: 'Customer ID', type: 'string' },
      ],
      rows: orders,
    },
    customers: {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'country', label: 'Country', type: 'string' },
        { id: 'tier', label: 'Tier', type: 'string' },
      ],
      rows: customers,
    },
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'r1',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  it('enriches rows with a field from a related source via a one-hop join', () => {
    const result = enrichRowsWithRelatedFields(
      orders,
      'orders',
      ['country'],
      dataSources,
      relationships,
    );
    expect(result[0].country).toBe('Germany'); // ORD-1 → CUS-1
    expect(result[1].country).toBe('France'); // ORD-2 → CUS-2
    expect(result[2].country).toBe('Germany'); // ORD-3 → CUS-1
  });

  it('enriches multiple fields in a single call', () => {
    const result = enrichRowsWithRelatedFields(
      orders,
      'orders',
      ['country', 'tier'],
      dataSources,
      relationships,
    );
    expect(result[0].country).toBe('Germany');
    expect(result[0].tier).toBe('gold');
  });

  it('leaves rows unchanged when the field already exists on the native source', () => {
    const result = enrichRowsWithRelatedFields(
      orders,
      'orders',
      ['id'],
      dataSources,
      relationships,
    );
    // 'id' is already in the orders schema; rows should be the same references
    expect(result).toBe(orders);
  });

  it('skips unknown fields with no matching relationship and returns rows unchanged', () => {
    const result = enrichRowsWithRelatedFields(
      orders,
      'orders',
      ['nonExistentField'],
      dataSources,
      relationships,
    );
    expect(result).toBe(orders);
  });

  it('returns rows unchanged for an empty fieldIds array', () => {
    const result = enrichRowsWithRelatedFields(orders, 'orders', [], dataSources, relationships);
    expect(result).toBe(orders);
  });

  it('returns rows unchanged for an empty rows array', () => {
    const result = enrichRowsWithRelatedFields(
      [],
      'orders',
      ['country'],
      dataSources,
      relationships,
    );
    expect(result).toEqual([]);
  });

  it('does not mutate the original row objects', () => {
    const origCountry = (orders[0] as Record<string, unknown>).country; // undefined
    enrichRowsWithRelatedFields(orders, 'orders', ['country'], dataSources, relationships);
    expect((orders[0] as Record<string, unknown>).country).toBe(origCountry);
  });

  it('skips a field when no related source has it registered in its fields', () => {
    // 'nonExistentField' is not in any source's fields[] declaration, so it should be skipped
    const result = enrichRowsWithRelatedFields(
      [{ id: 'CUS-1', country: 'Germany' }],
      'customers',
      ['nonExistentField'],
      dataSources,
      relationships,
    );
    // No enrichment possible → same reference returned
    expect(result).toEqual([{ id: 'CUS-1', country: 'Germany' }]);
  });
});

// ─── resolveRows — page filter on expression field (no filterSourceId) ───────
//
// Bug: Filters Drawer creates page filters with scope:'page' but no filterSourceId.
// When the filtered field is an expression field owned by a different source, the
// rows are silently filtered out (the field is undefined on the widget's rows).
// Fix: auto-route such filters as cross-filters using the expression field's sourceId.

describe('resolveRows — page filter on expression field without filterSourceId', () => {
  const orders: Record<string, unknown>[] = [
    { id: 'o1', country: 'Germany', total: 100 },
    { id: 'o2', country: 'France', total: 200 },
    { id: 'o3', country: 'Germany', total: 150 },
  ];

  const orderItems: Record<string, unknown>[] = [
    { id: 'i1', orderId: 'o1', category: 'Supplies', total: 60 },
    { id: 'i2', orderId: 'o2', category: 'Electronics', total: 200 },
    { id: 'i3', orderId: 'o3', category: 'Supplies', total: 150 },
  ];

  const ordersSource: StudioDataSource = {
    id: 'source-orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'country', label: 'Country', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: orders,
  };

  const orderItemsSource: StudioDataSource = {
    id: 'source-order-items',
    label: 'Order Items',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'orderId', label: 'Order ID', type: 'string' },
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: orderItems,
  };

  const dataSources: Record<string, StudioDataSource> = {
    'source-orders': ordersSource,
    'source-order-items': orderItemsSource,
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-items-orders',
      sourceId: 'source-order-items',
      sourceField: 'orderId',
      targetId: 'source-orders',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  // An expression field that lives on ORDERS (e.g. "Country" derived from orders)
  const exprCountry: StudioExpressionField = {
    id: 'expr-order-country',
    label: 'Country',
    type: 'string',
    sourceId: 'source-orders',
    isMeasure: false,
    expression: { id: 'country' },
  };

  const expressionFields: StudioExpressionField[] = [exprCountry];

  it('page filter on expr-order-country (no filterSourceId) returns ORDER_ITEMS for Germany', () => {
    // Simulates Filters Drawer: country=Germany, no filterSourceId
    const pageFilter = makeFilter({
      id: 'pf-country',
      field: 'expr-order-country',
      operator: 'equals',
      value: 'Germany',
      scope: 'page',
      filterSourceId: undefined,
    });

    const result = resolveRows(
      orderItems,
      'source-order-items',
      [pageFilter],
      dataSources,
      relationships,
      expressionFields,
    );
    // o1 and o3 are Germany → i1 and i3
    expect(result.map((r) => r.id).sort()).toEqual(['i1', 'i3']);
  });

  it('page filter on expr-order-country does NOT blank out an ORDERS widget (native path)', () => {
    // For an ORDERS widget: expr-order-country.sourceId === widgetSourceId → native filter
    // The expression is enriched onto ORDERS rows → should work without cross-filter routing
    const pageFilter = makeFilter({
      id: 'pf-country',
      field: 'expr-order-country',
      operator: 'equals',
      value: 'Germany',
      scope: 'page',
      filterSourceId: undefined,
    });

    // Enrich the orders rows with the expression field value (country is a plain field here)
    const enrichedOrders = orders.map((r) => ({ ...r, 'expr-order-country': r.country }));
    const enrichedOrdersSource = { ...ordersSource, rows: enrichedOrders };

    const result = resolveRows(
      enrichedOrders,
      'source-orders',
      [pageFilter],
      { ...dataSources, 'source-orders': enrichedOrdersSource },
      relationships,
      expressionFields,
    );
    expect(result.map((r) => r.id).sort()).toEqual(['o1', 'o3']);
  });

  it('page filter on a native field (no filterSourceId) still applies as native filter', () => {
    // category is owned by source-order-items → no cross-filter routing
    const pageFilter = makeFilter({
      id: 'pf-category',
      field: 'category',
      operator: 'equals',
      value: 'Supplies',
      scope: 'page',
      filterSourceId: undefined,
    });

    const result = resolveRows(
      orderItems,
      'source-order-items',
      [pageFilter],
      dataSources,
      relationships,
      expressionFields,
    );
    expect(result.map((r) => r.id).sort()).toEqual(['i1', 'i3']);
  });
});

// ─── Performance: Fix 1 — resolveRows cross-filter short-circuit ──────────────

describe('resolveRows — perf: foreign enrichment cache', () => {
  // Arrange a scenario with TWO cross-filters targeting the SAME foreign source.
  // Both filters should share the enriched foreign rows, not re-compute them.
  const orders = [
    { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
    { id: 'ORD-2', customerId: 'CUS-2', total: 200 },
    { id: 'ORD-3', customerId: 'CUS-3', total: 300 },
  ];

  const customers = [
    { id: 'CUS-1', country: 'Germany', tier: 'gold' },
    { id: 'CUS-2', country: 'Germany', tier: 'silver' },
    { id: 'CUS-3', country: 'France', tier: 'gold' },
  ];

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-1',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  const dataSources: Record<string, StudioDataSource> = {
    orders: { id: 'orders', label: 'Orders', fields: [], rows: orders },
    customers: { id: 'customers', label: 'Customers', fields: [], rows: customers },
  };

  it('two cross-filters on same foreign source both apply correctly', () => {
    // country = Germany AND tier = gold → only CUS-1 → only ORD-1
    const result = resolveRows(
      orders,
      'orders',
      [
        makeFilter({
          id: 'cf1',
          field: 'country',
          operator: 'equals',
          value: 'Germany',
          filterSourceId: 'customers',
        }),
        makeFilter({
          id: 'cf2',
          field: 'tier',
          operator: 'equals',
          value: 'gold',
          filterSourceId: 'customers',
        }),
      ],
      dataSources,
      relationships,
    );
    expect(result.map((r) => r.id)).toEqual(['ORD-1']);
  });

  it('two cross-filters on same foreign source with no overlap returns empty', () => {
    // country = Germany AND country = France → no customer matches both → no orders
    const result = resolveRows(
      orders,
      'orders',
      [
        makeFilter({
          id: 'cf1',
          field: 'country',
          operator: 'equals',
          value: 'Germany',
          filterSourceId: 'customers',
        }),
        makeFilter({
          id: 'cf2',
          field: 'country',
          operator: 'equals',
          value: 'France',
          filterSourceId: 'customers',
        }),
      ],
      dataSources,
      relationships,
    );
    // After first pass: CUS-1, CUS-2 (Germany). After second pass: CUS-3 (France).
    // Intersection of join keys is empty.
    expect(result).toHaveLength(0);
  });
});

// ─── Performance: Batch 2 — resolveRows skipEnrichment option ─────────────────

describe('resolveRows — perf: skipEnrichment option', () => {
  const sourceField: StudioDataField = {
    id: 'revenue',
    label: 'Revenue',
    type: 'number',
  };
  const source: StudioDataSource = {
    id: 'sales',
    label: 'Sales',
    fields: [sourceField],
    rows: [
      { id: 'r1', region: 'EU', revenue: 100 },
      { id: 'r2', region: 'US', revenue: 200 },
    ],
  };
  const dataSources: Record<string, StudioDataSource> = { sales: source };

  it('produces the same rows with skipEnrichment: true when no expressionFields', () => {
    const filters = [makeFilter({ field: 'region', operator: 'equals', value: 'EU' })];
    const normal = resolveRows(source.rows!, 'sales', filters, dataSources);
    const skipped = resolveRows(source.rows!, 'sales', filters, dataSources, [], [], {
      skipEnrichment: true,
    });
    expect(skipped).toEqual(normal);
  });

  it('skipEnrichment: true returns pre-enriched rows unchanged when no filters', () => {
    // Caller simulates pre-enrichment by adding a computed field manually
    const preEnriched = source.rows!.map((r) => ({ ...r, doubled: (r.revenue as number) * 2 }));
    const result = resolveRows(preEnriched, 'sales', [], dataSources, [], [], {
      skipEnrichment: true,
    });
    expect(result).toBe(preEnriched); // same reference — no copy made
  });
});

// ─── Many-to-many relationship tests ─────────────────────────────────────────

describe('many-to-many relationships', () => {
  // Schema: products ↔ orders via order_items
  const products: StudioDataSource = {
    id: 'products',
    label: 'Products',
    fields: [
      { id: 'id', label: 'ID', type: 'number' },
      { id: 'name', label: 'Name', type: 'string' },
      { id: 'price', label: 'Price', type: 'number' },
    ],
    rows: [
      { id: 1, name: 'Widget', price: 10 },
      { id: 2, name: 'Gadget', price: 25 },
      { id: 3, name: 'Doohickey', price: 5 },
    ],
  };

  const orders: StudioDataSource = {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'number' },
      { id: 'customer', label: 'Customer', type: 'string' },
    ],
    rows: [
      { id: 10, customer: 'Alice' },
      { id: 11, customer: 'Bob' },
      { id: 12, customer: 'Carol' },
    ],
  };

  const orderItems: StudioDataSource = {
    id: 'order_items',
    label: 'Order Items',
    fields: [
      { id: 'product_id', label: 'Product ID', type: 'number' },
      { id: 'order_id', label: 'Order ID', type: 'number' },
      { id: 'qty', label: 'Quantity', type: 'number' },
    ],
    rows: [
      { product_id: 1, order_id: 10, qty: 2 }, // Widget in Alice's order
      { product_id: 2, order_id: 10, qty: 1 }, // Gadget in Alice's order
      { product_id: 1, order_id: 11, qty: 3 }, // Widget in Bob's order
      { product_id: 3, order_id: 12, qty: 1 }, // Doohickey in Carol's order
    ],
  };

  const dataSources: Record<string, StudioDataSource> = {
    products,
    orders,
    order_items: orderItems,
  };

  const manyToManyRel: StudioRelationship = {
    id: 'rel-p-o',
    type: 'many-to-many',
    sourceId: 'products',
    sourceField: 'id',
    targetId: 'orders',
    targetField: 'id',
    junctionSourceId: 'order_items',
    junctionSourceField: 'product_id',
    junctionTargetField: 'order_id',
  };

  const relationships = [manyToManyRel];

  describe('getReachableSourceIds', () => {
    it('includes junction and target as reachable from source', () => {
      const reachable = getReachableSourceIds('products', relationships);
      expect(reachable.has('products')).toBe(true);
      expect(reachable.has('orders')).toBe(true);
      expect(reachable.has('order_items')).toBe(true);
    });

    it('includes junction and source as reachable from target', () => {
      const reachable = getReachableSourceIds('orders', relationships);
      expect(reachable.has('products')).toBe(true);
      expect(reachable.has('order_items')).toBe(true);
    });
  });

  describe('resolveRows — M:N cross-filter semi-join', () => {
    it('filters products to those in Alice orders (order id 10)', () => {
      const filter: StudioFilterState = {
        id: 'f1',
        scope: 'page',
        field: 'customer',
        fieldType: 'string',
        operator: 'equals',
        value: 'Alice',
        filterSourceId: 'orders',
      };

      const result = resolveRows(products.rows!, 'products', [filter], dataSources, relationships);
      // Alice ordered Widget (1) and Gadget (2)
      expect(result.map((r) => r.id).sort()).toEqual([1, 2]);
    });

    it('returns empty when no matching cross-source rows', () => {
      const filter: StudioFilterState = {
        id: 'f1',
        scope: 'page',
        field: 'customer',
        fieldType: 'string',
        operator: 'equals',
        value: 'Nobody',
        filterSourceId: 'orders',
      };

      const result = resolveRows(products.rows!, 'products', [filter], dataSources, relationships);
      expect(result).toEqual([]);
    });

    it('filters in reverse direction: orders filtered by product name', () => {
      const filter: StudioFilterState = {
        id: 'f1',
        scope: 'page',
        field: 'name',
        fieldType: 'string',
        operator: 'equals',
        value: 'Widget',
        filterSourceId: 'products',
      };

      const result = resolveRows(orders.rows!, 'orders', [filter], dataSources, relationships);
      // Widget was ordered by Alice (10) and Bob (11)
      expect(result.map((r) => r.id).sort()).toEqual([10, 11]);
    });
  });

  describe('enrichRowsWithRelatedFields — M:N two-hop', () => {
    it('enriches product rows with the customer field via junction (first match)', () => {
      const enriched = enrichRowsWithRelatedFields(
        products.rows!,
        'products',
        ['customer'],
        dataSources,
        relationships,
      );
      // Product 1 (Widget) first appears in order 10 (Alice)
      expect(enriched[0].customer).toBe('Alice');
      // Product 2 (Gadget) first appears in order 10 (Alice)
      expect(enriched[1].customer).toBe('Alice');
      // Product 3 (Doohickey) first appears in order 12 (Carol)
      expect(enriched[2].customer).toBe('Carol');
    });

    it('does not overwrite existing fields on widget rows', () => {
      const rowsWithCustomer = products.rows!.map((r) => ({ ...r, customer: 'Existing' }));
      const enriched = enrichRowsWithRelatedFields(
        rowsWithCustomer,
        'products',
        ['customer'],
        dataSources,
        relationships,
      );
      expect(enriched[0].customer).toBe('Existing');
    });
  });

  describe('analyzeChartSupport — M:N anchor', () => {
    it('sets anchorSourceId to junction when y-field is on the remote endpoint', () => {
      const result = analyzeChartSupport(
        'products',
        'customer', // x-field from orders
        ['qty'], // y-field from junction (order_items)
        undefined,
        undefined,
        dataSources,
        relationships,
      );
      // qty is on order_items (the junction), so anchor = junction
      expect(result.supported).toBe(true);
      expect(result.anchorSourceId).toBe('order_items');
    });
  });

  describe('resolveChartRowsForAggregation — M:N junction anchor', () => {
    it('returns junction rows enriched with widget and remote fields', () => {
      const result = resolveChartRowsForAggregation(
        products.rows!,
        'products',
        'customer',
        ['qty'],
        undefined,
        dataSources,
        relationships,
      );
      // Junction has 4 rows; each should carry qty from junction, customer from orders, name from products
      expect(result).toHaveLength(4);
      const aliceWidget = result.find((r) => r.customer === 'Alice' && r.name === 'Widget');
      expect(aliceWidget?.qty).toBe(2);
    });
  });
});
