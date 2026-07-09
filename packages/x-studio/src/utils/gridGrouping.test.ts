import { describe, expect, it } from 'vitest';

import { buildGroupedGridRows } from './gridGrouping';
import type { StudioDataSource, StudioRelationship } from '../models';

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
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
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

  it('dedupes a cross-source many-to-one column across a numeric-vs-string FK/PK mismatch', () => {
    // order_items.orderId is numeric; orders.id is a string. The shared normalizeJoinKey
    // policy (internals/joinKeys.ts) makes the grid dedup match the chart/filter paths.
    const orderItems = [
      { id: 'i1', orderId: 1, category: 'Electronics' },
      { id: 'i2', orderId: 1, category: 'Electronics' }, // same order, numeric FK
      { id: 'i3', orderId: 2, category: 'Electronics' },
    ];
    const dataSources: Record<string, StudioDataSource> = {
      order_items: {
        id: 'order_items',
        label: 'Order Items',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'orderId', label: 'Order', type: 'number' },
          { id: 'category', label: 'Category', type: 'string' },
        ],
      },
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
        rows: [
          { id: '1', total: 100 },
          { id: '2', total: 50 },
        ],
      },
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

    const result = buildGroupedGridRows(
      orderItems,
      'category',
      ['category', 'total'],
      { total: 'sum' },
      'widget-1',
      [{ fieldId: 'category' }, { fieldId: 'total', sourceId: 'orders' }],
      dataSources,
      relationships,
      'order_items',
    );
    expect(result[0].total).toBe(150); // 100 (order 1, once) + 50 (order 2)
  });

  // ─── Shared `coerceAggregateValue` policy (finding 2.13) ───────────────────────

  it('coerces numeric strings and booleans instead of silently excluding them from the aggregate', () => {
    // A raw `typeof v === 'number'` check drops numeric strings ("12") and booleans
    // entirely, undercounting sum/skewing avg's denominator — coerceAggregateValue
    // parses/coerces them instead, matching KPI/Chart/Pivot over the same field.
    const rows = [
      { company: 'Alpha', total: '10' },
      { company: 'Alpha', total: 20 },
      { company: 'Alpha', total: true }, // boolean → 1
    ];

    const result = buildGroupedGridRows(
      rows,
      'company',
      ['company', 'total'],
      { total: 'sum' },
      'widget-1',
    );

    // Old behaviour (raw typeof check) would sum only the plain `20` -> 20.
    expect(result[0].total).toBe(31);
  });

  it('avg over an all-null/non-numeric group returns null, not 0 (matches min/max and gridSummary)', () => {
    const rows = [
      { company: 'Alpha', total: null },
      { company: 'Alpha', total: 'not-a-number' },
    ];

    const result = buildGroupedGridRows(
      rows,
      'company',
      ['company', 'total'],
      { total: 'avg' },
      'widget-1',
    );

    expect(result[0].total).toBe(null);
  });

  // ─── count_distinct: null-excluding, raw-value distinctness (finding 2.23) ─────

  it('count_distinct over a string field excludes null/undefined and counts raw values', () => {
    const rows = [
      { company: 'Alpha', region: 'US' },
      { company: 'Alpha', region: 'US' },
      { company: 'Alpha', region: 'EU' },
      { company: 'Alpha', region: null },
      { company: 'Alpha', region: undefined },
      { company: 'Alpha' }, // missing key
    ];

    const result = buildGroupedGridRows(
      rows,
      'company',
      ['company', 'region'],
      { region: 'count_distinct' },
      'widget-1',
    );

    // 2 distinct non-null regions (US, EU) — matches the KPI and measure paths.
    expect(result[0].region).toBe(2);
  });

  // ─── `min`/`max` reduce loop instead of argument-spread (finding 2.17) ─────────

  it('computes min/max over a large group without a RangeError (argument-spread crash)', () => {
    const LARGE = 150_000;
    const rows = Array.from({ length: LARGE }, (_, i) => ({
      company: 'Alpha',
      total: i, // 0..LARGE-1
    }));

    const result = buildGroupedGridRows(
      rows,
      'company',
      ['company', 'total'],
      { total: 'min' },
      'widget-1',
    );

    expect(result[0].total).toBe(0);

    const resultMax = buildGroupedGridRows(
      rows,
      'company',
      ['company', 'total'],
      { total: 'max' },
      'widget-1',
    );

    expect(resultMax[0].total).toBe(LARGE - 1);
  });
});
