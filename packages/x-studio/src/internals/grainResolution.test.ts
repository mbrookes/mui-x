import { describe, expect, it } from 'vitest';
import { resolveRowsAtGrain } from './grainResolution';
import { resolveChartRowsForAggregation, aggregateByField } from './chartAggregation';
import type { StudioDataSource, StudioRelationship } from '../models';

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
});
