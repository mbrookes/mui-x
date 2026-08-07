import { describe, expect, it } from 'vitest';

import { buildGroupedGridRows } from './gridGrouping';
import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../models';

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

  // ─── Relationship shapes other than "many-to-one declared from the widget source" ──────
  //
  // Every cross-source case in this file used that one shape, so the old
  // `buildManyToOneRelationshipIndex`'s narrowness was invisible here. A missed index entry
  // hits a `continue`, silently degrading the cross-source aggregate to a plain per-row reduce
  // over a field the widget rows don't carry — i.e. `null` — while a chart on the same field
  // and relationship aggregated it fine (finding M2).

  it('aggregates a cross-source column over a REVERSE-declared many-to-one relationship', () => {
    // Identical topology to the fan-out test above, declared from the "one" side instead.
    const orderItems = [
      { id: 'i1', orderId: 'ord1', category: 'Electronics', qty: 2 },
      { id: 'i2', orderId: 'ord1', category: 'Electronics', qty: 3 }, // same order → fan-out
      { id: 'i3', orderId: 'ord2', category: 'Electronics', qty: 1 },
    ];
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
      orders: {
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
      },
    };
    const reversed: StudioRelationship[] = [
      {
        id: 'rel1',
        type: 'many-to-one',
        sourceId: 'orders',
        sourceField: 'id',
        targetId: 'order_items',
        targetField: 'orderId',
      },
    ];

    const result = buildGroupedGridRows(
      orderItems,
      'category',
      ['category', 'qty', 'total'],
      { qty: 'sum', total: 'sum' },
      'widget-reverse',
      [{ fieldId: 'category' }, { fieldId: 'qty' }, { fieldId: 'total', sourceId: 'orders' }],
      dataSources,
      reversed,
      'order_items',
    );

    expect(result).toHaveLength(1);
    expect(result[0].qty).toBe(6);
    // Fan-out dedup still applies through the reversed declaration: 100 + 50, not 250.
    expect(result[0].total).toBe(150);
  });

  it('aggregates a cross-source column over a one-to-one relationship', () => {
    const orders = [
      { id: 'ord1', region: 'EU' },
      { id: 'ord2', region: 'EU' },
    ];
    const dataSources: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'region', label: 'Region', type: 'string' },
        ],
      },
      order_details: {
        id: 'order_details',
        label: 'Order details',
        fields: [
          { id: 'orderId', label: 'Order', type: 'string' },
          { id: 'shippingCost', label: 'Shipping', type: 'number' },
        ],
        rows: [
          { orderId: 'ord1', shippingCost: 7 },
          { orderId: 'ord2', shippingCost: 13 },
        ],
      },
    };
    const oneToOne: StudioRelationship[] = [
      {
        id: 'rel-details',
        type: 'one-to-one',
        sourceId: 'orders',
        sourceField: 'id',
        targetId: 'order_details',
        targetField: 'orderId',
      },
    ];

    const result = buildGroupedGridRows(
      orders,
      'region',
      ['region', 'shippingCost'],
      { shippingCost: 'sum' },
      'widget-1to1',
      [{ fieldId: 'region' }, { fieldId: 'shippingCost', sourceId: 'order_details' }],
      dataSources,
      oneToOne,
      'orders',
    );

    expect(result).toHaveLength(1);
    expect(result[0].shippingCost).toBe(20);
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

  // ─── Related-source EXPRESSION (calculated) cross-source column (finding 2.3) ───
  //
  // A cross-source column that is the related source's calculated column has no value on
  // the raw related rows; it must be L2-enriched before the per-PK lookup map is built.
  // `order_items` grouped by category, summing `orders.bonus` (bonus = total * 2).

  it('aggregates a related-source calculated cross-source column after L2-enriching it', () => {
    const orderItems = [
      { id: 'i1', orderId: 'ord1', category: 'Electronics' },
      { id: 'i2', orderId: 'ord1', category: 'Electronics' }, // same order → fan-out
      { id: 'i3', orderId: 'ord2', category: 'Electronics' },
    ];
    const dataSources: Record<string, StudioDataSource> = {
      order_items: {
        id: 'order_items',
        label: 'Order Items',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'orderId', label: 'Order', type: 'string' },
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
          { id: 'ord1', total: 100 },
          { id: 'ord2', total: 50 },
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
    // bonus = total * 2 — a calculated column owned by the ORDERS (related) source.
    const bonusExpr: StudioExpressionField = {
      id: 'bonus',
      label: 'Bonus',
      sourceId: 'orders',
      isMeasure: false,
      expression: {
        operator: 'multiply',
        inputs: [{ id: 'total' }, { type: 'number', value: 2 }],
      },
    } as unknown as StudioExpressionField;

    const columns = [{ fieldId: 'category' }, { fieldId: 'bonus', sourceId: 'orders' }];

    // Without expressionFields the related expression column resolves to nothing.
    const blank = buildGroupedGridRows(
      orderItems,
      'category',
      ['category', 'bonus'],
      { bonus: 'sum' },
      'widget-1',
      columns,
      dataSources,
      relationships,
      'order_items',
    );
    expect(blank[0].bonus).toBe(0); // no numeric values → sum of empty = 0

    // With expressionFields the related source is L2-enriched first, then FK-deduped:
    // bonus ord1 = 200 (once), ord2 = 100 → 300.
    const result = buildGroupedGridRows(
      orderItems,
      'category',
      ['category', 'bonus'],
      { bonus: 'sum' },
      'widget-1',
      columns,
      dataSources,
      relationships,
      'order_items',
      [bonusExpr],
    );
    expect(result[0].bonus).toBe(300);
  });

  // ─── Related-source rows are L1-normalized before indexing ─────────────────────
  //
  // Every cross-source reader routes the related source's rows through
  // `getCachedNormalizedDataSource` first. Reading `dataSources[id].rows` raw left `Date`
  // objects in place, so a `count_distinct` over a related `date` column counted OBJECT
  // references instead of calendar days.

  it('count_distinct over a related-source date column counts calendar days, not Date instances', () => {
    const orderItems = [
      { id: 'i1', customerId: 'c1', category: 'Electronics' },
      { id: 'i2', customerId: 'c2', category: 'Electronics' },
      { id: 'i3', customerId: 'c3', category: 'Electronics' },
    ];
    const dataSources: Record<string, StudioDataSource> = {
      order_items: {
        id: 'order_items',
        label: 'Order Items',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'customerId', label: 'Customer', type: 'string' },
          { id: 'category', label: 'Category', type: 'string' },
        ],
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'signupDate', label: 'Signup', type: 'date' },
        ],
        rows: [
          // Two DISTINCT Date instances for the same calendar day, plus a third day.
          // Local-midnight construction keeps the calendar day timezone-independent.
          { id: 'c1', signupDate: new Date(2024, 0, 15) },
          { id: 'c2', signupDate: new Date(2024, 0, 15) },
          { id: 'c3', signupDate: new Date(2024, 1, 20) },
        ],
      },
    };
    const relationships: StudioRelationship[] = [
      {
        id: 'rel1',
        type: 'many-to-one',
        sourceId: 'order_items',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
      },
    ];

    const result = buildGroupedGridRows(
      orderItems,
      'category',
      ['category', 'signupDate'],
      { signupDate: 'count_distinct' },
      'widget-1',
      [{ fieldId: 'category' }, { fieldId: 'signupDate', sourceId: 'customers' }],
      dataSources,
      relationships,
      'order_items',
    );

    // Raw `Date` objects would give 3 (one Set entry per object reference); normalized
    // `'YYYY-MM-DD'` strings collapse the two same-day signups to 2 distinct days — the same
    // value the cells beside this total already render.
    expect(result[0].signupDate).toBe(2);
  });

  it('L2-enriches a related-source calculated column over NORMALIZED dates', () => {
    // The related expression reads the date column; it must see the canonical string the
    // display path sees, not a raw `Date`. Same rows/enrichment inputs as
    // `crossSourceEnrichment`, so both share one `enrichedRowsCache` slot.
    const orderItems = [{ id: 'i1', customerId: 'c1', category: 'Electronics' }];
    const dataSources: Record<string, StudioDataSource> = {
      order_items: {
        id: 'order_items',
        label: 'Order Items',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'customerId', label: 'Customer', type: 'string' },
          { id: 'category', label: 'Category', type: 'string' },
        ],
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'signupDate', label: 'Signup', type: 'date' },
        ],
        rows: [{ id: 'c1', signupDate: new Date(2024, 0, 15) }], // local midnight
      },
    };
    const relationships: StudioRelationship[] = [
      {
        id: 'rel1',
        type: 'many-to-one',
        sourceId: 'order_items',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
      },
    ];
    // isJan15 = signupDate == '2024-01-15' — a calculated column owned by the CUSTOMERS
    // source that compares the date against its CANONICAL string form. A raw `Date` stringifies
    // to `'Mon Jan 15 2024 …'` and never matches; the normalized `'2024-01-15'` does.
    const isJan15: StudioExpressionField = {
      id: 'isJan15',
      label: 'Signed up Jan 15',
      sourceId: 'customers',
      isMeasure: false,
      expression: {
        operator: 'equals',
        inputs: [{ id: 'signupDate' }, { type: 'string', value: '2024-01-15' }],
      },
    } as unknown as StudioExpressionField;

    const result = buildGroupedGridRows(
      orderItems,
      'category',
      ['category', 'isJan15'],
      { isJan15: 'sum' }, // booleans coerce to 0/1
      'widget-1',
      [{ fieldId: 'category' }, { fieldId: 'isJan15', sourceId: 'customers' }],
      dataSources,
      relationships,
      'order_items',
      [isJan15],
    );

    expect(result[0].isJan15).toBe(1);
  });
});
