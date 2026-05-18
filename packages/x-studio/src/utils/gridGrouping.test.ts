import { describe, expect, it } from 'vitest';

import { buildGroupedGridRows } from './gridGrouping';
import type { StudioDataSource, StudioRelationship } from '../models/studio';

describe('buildGroupedGridRows', () => {
  it('returns one row per group with aggregated numeric fields', () => {
    const rows = [
      { id: 'o1', company: 'Alpha', country: 'US', total: 10 },
      { id: 'o2', company: 'Alpha', country: 'US', total: 15 },
      { id: 'o3', company: 'Beta', country: 'DE', total: 25 },
    ];

    const result = buildGroupedGridRows(
      rows,
      'company',
      ['company', 'country', 'id', 'total'],
      { id: 'count', total: 'sum' },
      'widget-1',
    );

    expect(result).toEqual([
      {
        __rowId: 'group-widget-1-0',
        company: 'Alpha',
        country: 'US',
        id: 2,
        total: 25,
      },
      {
        __rowId: 'group-widget-1-1',
        company: 'Beta',
        country: 'DE',
        id: 1,
        total: 25,
      },
    ]);
  });

  it('preserves a representative value for non-aggregated fields', () => {
    const rows = [
      { id: 'o1', company: 'Alpha', segment: 'Enterprise', total: 10 },
      { id: 'o2', company: 'Alpha', segment: 'Enterprise', total: 15 },
    ];

    const result = buildGroupedGridRows(
      rows,
      'company',
      ['company', 'segment', 'total'],
      { total: 'sum' },
      'widget-1',
    );

    expect(result[0]).toMatchObject({
      company: 'Alpha',
      segment: 'Enterprise',
      total: 25,
    });
  });

  it('avoids fan-out double-counting for cross-source many-to-one columns', () => {
    // Scenario: order_items grouped by category; each item has orderId (FK to orders).
    // We want `orders.total` summed — but each order spans many items.
    // Without symmetricAggregate, SUM(orders.total) would count each order once per item.
    const orderItems = [
      { id: 'i1', orderId: 'ord1', category: 'Electronics', qty: 2 },
      { id: 'i2', orderId: 'ord1', category: 'Electronics', qty: 3 }, // same order → fan-out
      { id: 'i3', orderId: 'ord2', category: 'Electronics', qty: 1 },
    ];

    const orders: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'id', label: 'ID', type: 'string' }, { id: 'total', label: 'Total', type: 'number' }],
      rows: [
        { id: 'ord1', total: 100 },
        { id: 'ord2', total: 50 },
      ],
    };

    const dataSources: Record<string, StudioDataSource> = {
      order_items: {
        id: 'order_items',
        label: 'Order Items',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'orderId', label: 'Order', type: 'string' },
          { id: 'category', label: 'Category', type: 'string' },
          { id: 'qty', label: 'Qty', type: 'number' },
        ],
      },
      orders,
    };

    const relationships: StudioRelationship[] = [
      {
        id: 'rel1',
        type: 'many-to-one',
        sourceId: 'order_items',
        sourceField: 'orderId',
        targetId: 'orders',
        targetField: 'id',
      },
    ];

    const columns = [
      { fieldId: 'category' },
      { fieldId: 'qty' },
      { fieldId: 'total', sourceId: 'orders' }, // cross-source
    ];

    const result = buildGroupedGridRows(
      orderItems,
      'category',
      ['category', 'qty', 'total'],
      { qty: 'sum', total: 'sum' },
      'widget-1',
      columns,
      dataSources,
      relationships,
      'order_items',
    );

    expect(result).toHaveLength(1);
    expect(result[0].qty).toBe(6); // 2 + 3 + 1 = 6 (items qty sums correctly)
    // Without fan-out fix this would be 100+100+50=250; with fix: 100+50=150
    expect(result[0].total).toBe(150);
  });
});
