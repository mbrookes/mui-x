import { describe, expect, it } from 'vitest';
import { resolveRowsAtGrain } from './grainResolution';
import { resolveChartRowsForAggregation, aggregateByField } from './chartAggregation';
import type { StudioDataSource, StudioFilterState, StudioRelationship } from '../models';

type Row = Record<string, unknown>;

describe('resolveRowsAtGrain', () => {
  it('same-source anchor: enriches display columns from a related source without re-anchoring', () => {
    const orderItems: Row[] = [
      { id: 'i1', orderId: 'o1', qty: 2 },
      { id: 'i2', orderId: 'o2', qty: 5 },
    ];
    const rel: StudioRelationship = {
      id: 'r',
      type: 'many-to-one',
      sourceId: 'order_items',
      sourceField: 'orderId',
      targetId: 'orders',
      targetField: 'id',
    };
    const dataSources: Record<string, StudioDataSource> = {
      order_items: {
        id: 'order_items',
        label: 'Items',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'orderId', label: 'Order', type: 'string' },
          { id: 'qty', label: 'Qty', type: 'number' },
        ],
        rows: orderItems,
      },
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'region', label: 'Region', type: 'string' },
        ],
        rows: [
          { id: 'o1', region: 'EU' },
          { id: 'o2', region: 'US' },
        ],
      },
    };

    const result = resolveRowsAtGrain(
      orderItems,
      'order_items',
      'order_items',
      ['region', 'qty'],
      new Map([
        ['region', 'orders'],
        ['qty', 'order_items'],
      ]),
      dataSources,
      [rel],
      [],
    );
    // One row per item (no re-anchor), each enriched with its order's region.
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.region)).toEqual(['EU', 'US']);
  });

  it('many-to-one anchor switch joins a numeric PK against a string FK (regression: raw-key mismatch dropped every row)', () => {
    // widget = customers (the "one" side, numeric id); orders = the "many" side whose
    // string customerId references it. Chart measure lives on the many side.
    const customers: Row[] = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ];
    const orders: Row[] = [
      { customerId: '1', amount: 100 },
      { customerId: '1', amount: 50 },
      { customerId: '2', amount: 20 },
    ];
    const rel: StudioRelationship = {
      id: 'r',
      type: 'many-to-one',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
    };
    const dataSources: Record<string, StudioDataSource> = {
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'number' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: customers,
      },
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'customerId', label: 'Customer', type: 'string' },
          { id: 'amount', label: 'Amount', type: 'number' },
        ],
        rows: orders,
      },
    };

    // Full path: analyzeChartSupport switches the anchor to `orders`, resolveRowsAtGrain
    // re-anchors to the order grain and enriches each order with its customer name.
    const resolved = resolveChartRowsForAggregation(
      customers,
      'customers',
      'name',
      ['amount'],
      undefined,
      dataSources,
      [rel],
      [],
    );
    expect(resolved).toHaveLength(3); // three orders, not zero (the bug) and not two
    const agg = aggregateByField(resolved, 'name', 'amount');
    expect(agg.values[agg.labels.indexOf('Alice')]).toBe(150);
    expect(agg.values[agg.labels.indexOf('Bob')]).toBe(20);
  });

  it('many-to-many junction anchor joins numeric/string keys and does not double-count (regression + fan-out safety)', () => {
    const products: Row[] = [
      { id: 1, name: 'Widget' },
      { id: 2, name: 'Gadget' },
    ];
    const tags: Row[] = [{ id: 't1' }, { id: 't2' }];
    // junction pid is a STRING referencing numeric products.id
    const junction: Row[] = [
      { pid: '1', tid: 't1', weight: 10 },
      { pid: '1', tid: 't2', weight: 20 },
      { pid: '2', tid: 't1', weight: 5 },
    ];
    const m2mRel = {
      id: 'r',
      type: 'many-to-many',
      sourceId: 'products',
      sourceField: 'id',
      targetId: 'tags',
      targetField: 'id',
      junctionSourceId: 'product_tags',
      junctionSourceField: 'pid',
      junctionTargetField: 'tid',
    } as unknown as StudioRelationship;
    const dataSources: Record<string, StudioDataSource> = {
      products: {
        id: 'products',
        label: 'Products',
        fields: [
          { id: 'id', label: 'ID', type: 'number' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: products,
      },
      tags: {
        id: 'tags',
        label: 'Tags',
        fields: [{ id: 'id', label: 'ID', type: 'string' }],
        rows: tags,
      },
      product_tags: {
        id: 'product_tags',
        label: 'PT',
        fields: [
          { id: 'pid', label: 'PID', type: 'string' },
          { id: 'tid', label: 'TID', type: 'string' },
          { id: 'weight', label: 'Weight', type: 'number' },
        ],
        rows: junction,
      },
    };

    const resolved = resolveChartRowsForAggregation(
      products,
      'products',
      'name',
      ['weight'],
      undefined,
      dataSources,
      [m2mRel],
      [],
    );
    expect(resolved).toHaveLength(3);
    const agg = aggregateByField(resolved, 'name', 'weight');
    expect(agg.values[agg.labels.indexOf('Widget')]).toBe(30);
    expect(agg.values[agg.labels.indexOf('Gadget')]).toBe(5);
  });

  // ─── Finding 1.3 ────────────────────────────────────────────────────────────
  it('many-to-many anchor enriches a THIRD-source dimension field owned by a source reachable many-to-one from the widget source (finding 1.3)', () => {
    // orders <-> products via order_products (M:N, anchor = junction). y = order_products.quantity
    // (junction-owned). x = customers.segment, a THIRD source reachable many-to-one from `orders`
    // (the widget source) — distinct from both the junction and the M:N remote endpoint
    // (products). analyzeChartSupport reports this as supported; resolveRowsAtGrain's M:N branch
    // must actually enrich `segment` onto the output rows instead of leaving it `undefined`.
    const orders: Row[] = [
      { id: 'o1', customerId: 'c1' },
      { id: 'o2', customerId: 'c2' },
    ];
    const customers: Row[] = [
      { id: 'c1', segment: 'Enterprise' },
      { id: 'c2', segment: 'SMB' },
    ];
    const products: Row[] = [{ id: 'p1', name: 'Widget' }];
    const orderProducts: Row[] = [
      { orderId: 'o1', productId: 'p1', quantity: 5 },
      { orderId: 'o2', productId: 'p1', quantity: 3 },
    ];
    const m2mRel: StudioRelationship = {
      id: 'r-m2m',
      type: 'many-to-many',
      sourceId: 'orders',
      sourceField: 'id',
      targetId: 'products',
      targetField: 'id',
      junctionSourceId: 'order_products',
      junctionSourceField: 'orderId',
      junctionTargetField: 'productId',
    } as unknown as StudioRelationship;
    const customersRel: StudioRelationship = {
      id: 'r-customers',
      type: 'many-to-one',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
    };
    const dataSources: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'customerId', label: 'Customer', type: 'string' },
        ],
        rows: orders,
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'segment', label: 'Segment', type: 'string' },
        ],
        rows: customers,
      },
      products: {
        id: 'products',
        label: 'Products',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: products,
      },
      order_products: {
        id: 'order_products',
        label: 'Order Products',
        fields: [
          { id: 'orderId', label: 'Order', type: 'string' },
          { id: 'productId', label: 'Product', type: 'string' },
          { id: 'quantity', label: 'Quantity', type: 'number' },
        ],
        rows: orderProducts,
      },
    };

    const resolved = resolveChartRowsForAggregation(
      orders,
      'orders',
      'segment',
      ['quantity'],
      undefined,
      dataSources,
      [m2mRel, customersRel],
      [],
    );

    expect(resolved).toHaveLength(2);
    // Every row must carry its customer's segment — not undefined (the bug: only
    // `{...widgetRow, ...remoteRow, ...jRow}` was merged, never enriching the third source).
    expect(resolved.every((r) => r.segment !== undefined)).toBe(true);
    const agg = aggregateByField(resolved, 'segment', 'quantity');
    expect(agg.values[agg.labels.indexOf('Enterprise')]).toBe(5);
    expect(agg.values[agg.labels.indexOf('SMB')]).toBe(3);
  });

  // ─── Finding 1.4 ────────────────────────────────────────────────────────────
  it('applies an anchor-source-scoped filter to the many-to-one anchor rows before the expansion join (finding 1.4)', () => {
    // Chart on customers (x=segment, y=orders.amount, anchor=orders). A filter
    // `orders.status = 'paid'` was already enforced at L3 as a semi-join (kept customers with
    // >=1 paid order). Without re-applying it here, the expansion join reads ALL of a surviving
    // customer's orders — paid and unpaid — from the raw store, summing both instead of just
    // the paid ones.
    const customers: Row[] = [{ id: 'c1', segment: 'Enterprise' }];
    const orders: Row[] = [
      { id: 'o1', customerId: 'c1', amount: 100, status: 'paid' },
      { id: 'o2', customerId: 'c1', amount: 999, status: 'unpaid' },
    ];
    const rel: StudioRelationship = {
      id: 'r',
      type: 'many-to-one',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
    };
    const dataSources: Record<string, StudioDataSource> = {
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'segment', label: 'Segment', type: 'string' },
        ],
        rows: customers,
      },
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'customerId', label: 'Customer', type: 'string' },
          { id: 'amount', label: 'Amount', type: 'number' },
          { id: 'status', label: 'Status', type: 'string' },
        ],
        rows: orders,
      },
    };
    const paidFilter = {
      id: 'f-paid',
      field: 'status',
      operator: 'equals' as const,
      value: 'paid',
      scope: { kind: 'cross-filter' as const, sourceWidgetId: 'w2', pageId: 'p1' },
      filterSourceId: 'orders',
    } as unknown as StudioFilterState;

    // Anchor-scoped filter NOT threaded through → resurrects the unpaid order (the bug).
    const withoutFix = resolveRowsAtGrain(
      customers,
      'customers',
      'orders',
      ['segment', 'amount'],
      new Map([
        ['segment', 'customers'],
        ['amount', 'orders'],
      ]),
      dataSources,
      [rel],
      [],
      undefined,
      [],
    );
    expect(withoutFix.map((r) => r.amount).sort()).toEqual([100, 999]);

    // With the anchor-scoped filter threaded through, only the paid order survives.
    const withFix = resolveRowsAtGrain(
      customers,
      'customers',
      'orders',
      ['segment', 'amount'],
      new Map([
        ['segment', 'customers'],
        ['amount', 'orders'],
      ]),
      dataSources,
      [rel],
      [],
      undefined,
      [paidFilter],
    );
    expect(withFix.map((r) => r.amount)).toEqual([100]);
  });

  it('applies an anchor-source-scoped filter to the many-to-many junction rows before the expansion join (finding 1.4)', () => {
    const products: Row[] = [{ id: 'p1', name: 'Widget' }];
    const tags: Row[] = [{ id: 't1' }];
    const junction: Row[] = [
      { pid: 'p1', tid: 't1', weight: 10, active: true },
      { pid: 'p1', tid: 't1', weight: 999, active: false },
    ];
    const m2mRel = {
      id: 'r',
      type: 'many-to-many',
      sourceId: 'products',
      sourceField: 'id',
      targetId: 'tags',
      targetField: 'id',
      junctionSourceId: 'product_tags',
      junctionSourceField: 'pid',
      junctionTargetField: 'tid',
    } as unknown as StudioRelationship;
    const dataSources: Record<string, StudioDataSource> = {
      products: {
        id: 'products',
        label: 'Products',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: products,
      },
      tags: {
        id: 'tags',
        label: 'Tags',
        fields: [{ id: 'id', label: 'ID', type: 'string' }],
        rows: tags,
      },
      product_tags: {
        id: 'product_tags',
        label: 'PT',
        fields: [
          { id: 'pid', label: 'PID', type: 'string' },
          { id: 'tid', label: 'TID', type: 'string' },
          { id: 'weight', label: 'Weight', type: 'number' },
          { id: 'active', label: 'Active', type: 'boolean' },
        ],
        rows: junction,
      },
    };
    const activeFilter = {
      id: 'f-active',
      field: 'active',
      operator: 'equals' as const,
      value: true,
      scope: { kind: 'cross-filter' as const, sourceWidgetId: 'w2', pageId: 'p1' },
      filterSourceId: 'product_tags',
    } as unknown as StudioFilterState;

    const resolved = resolveRowsAtGrain(
      products,
      'products',
      'product_tags',
      ['name', 'weight'],
      new Map([
        ['name', 'products'],
        ['weight', 'product_tags'],
      ]),
      dataSources,
      [m2mRel],
      [],
      undefined,
      [activeFilter],
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].weight).toBe(10);
  });
});
