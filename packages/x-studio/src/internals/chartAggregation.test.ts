import { describe, expect, it } from 'vitest';
import {
  aggregateBlendedSeries,
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
  aggregateSankey,
  analyzeChartSupport,
  applyRankToAggregated,
  applyRankToMultiSeries,
  applyRankToSeriesFieldData,
  getChartSupportMessage,
  prepareScatterData,
  resolveChartRowsForAggregation,
} from './chartAggregation';
import type { MultiYSeriesData } from './chartAggregation';
import { enrichRowsWithRelatedFields } from './dataSourceGraph';
import type { StudioDataSource, StudioFilterState, StudioRelationship } from '../models';

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

// ─── applyRankToAggregated ────────────────────────────────────────────────────

describe('applyRankToAggregated', () => {
  const data = {
    labels: ['A', 'B', 'C', 'D', 'E'],
    values: [10, 50, 30, 80, 20],
  };

  it('top 3 returns highest 3 values', () => {
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 3, rankDirection: 'top' }),
    );
    expect(result.labels).toEqual(['D', 'B', 'C']);
    expect(result.values).toEqual([80, 50, 30]);
  });

  it('bottom 2 returns lowest 2 values', () => {
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'bottom' }),
    );
    expect(result.labels).toEqual(['A', 'E']);
    expect(result.values).toEqual([10, 20]);
  });

  it('N >= length returns all data', () => {
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 10, rankDirection: 'top' }),
    );
    expect(result.labels).toHaveLength(5);
  });

  it('null filter returns original data', () => {
    const result = applyRankToAggregated(data, null);
    expect(result).toBe(data);
  });

  it('invalid N (zero) returns original data', () => {
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 0, rankDirection: 'top' }),
    );
    expect(result).toBe(data);
  });

  it('labels and values stay in sync after ranking', () => {
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top' }),
    );
    expect(result.labels.length).toBe(result.values.length);
    result.labels.forEach((label, i) => {
      const originalIndex = data.labels.indexOf(label as string);
      expect(result.values[i]).toBe(data.values[originalIndex]);
    });
  });
});

// ─── applyRankToMultiSeries ───────────────────────────────────────────────────

describe('applyRankToMultiSeries', () => {
  const data: MultiYSeriesData = {
    labels: ['A', 'B', 'C', 'D'],
    series: [
      { fieldId: 'S1', values: [10, 30, 20, 5] },
      { fieldId: 'S2', values: [20, 10, 30, 45] },
    ],
  };
  // Totals: A=30, B=40, C=50, D=50

  it('top 2 keeps labels with highest combined values', () => {
    const result = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top' }),
    );
    // C and D are tied at 50 — both should be in top 2
    expect(result.labels).toHaveLength(2);
    expect(result.labels.every((l) => ['C', 'D'].includes(l as string))).toBe(true);
  });

  it('bottom 1 returns label with lowest combined total', () => {
    const result = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom' }),
    );
    expect(result.labels).toEqual(['A']); // A has total 30
  });

  it('null filter returns original data', () => {
    const result = applyRankToMultiSeries(data, null);
    expect(result).toBe(data);
  });

  it('all series values are filtered consistently with labels', () => {
    const result = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }),
    );
    expect(result.series[0].values).toHaveLength(result.labels.length);
    expect(result.series[1].values).toHaveLength(result.labels.length);
  });

  it('N >= labels.length returns all data', () => {
    const result = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 10, rankDirection: 'top' }),
    );
    expect(result.labels).toHaveLength(4);
  });

  // ── rankMultiSeriesBy: aggregation modes ──────────────────────────────────

  it('__sum is the default (same as omitting rankMultiSeriesBy)', () => {
    // Totals: A=30, B=40, C=50, D=50
    const explicit = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 1,
        rankDirection: 'bottom',
        rankMultiSeriesBy: '__sum',
      }),
    );
    const implicit = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom' }),
    );
    expect(explicit.labels).toEqual(implicit.labels);
  });

  it('__avg: ranks by average of all series per label', () => {
    // Averages: A=(10+20)/2=15, B=(30+10)/2=20, C=(20+30)/2=25, D=(5+45)/2=25
    // Top 1 by avg: C or D (tied), bottom 1 by avg: A
    const bottom = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 1,
        rankDirection: 'bottom',
        rankMultiSeriesBy: '__avg',
      }),
    );
    expect(bottom.labels).toEqual(['A']);

    const top = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 2,
        rankDirection: 'top',
        rankMultiSeriesBy: '__avg',
      }),
    );
    expect(top.labels).toHaveLength(2);
    expect(top.labels.every((l) => ['C', 'D'].includes(l as string))).toBe(true);
  });

  it('__max: ranks by maximum series value per label', () => {
    // Max values: A=max(10,20)=20, B=max(30,10)=30, C=max(20,30)=30, D=max(5,45)=45
    // Top 1 by max: D
    const top = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 1,
        rankDirection: 'top',
        rankMultiSeriesBy: '__max',
      }),
    );
    expect(top.labels).toEqual(['D']);
  });

  it('__min: ranks by minimum series value per label', () => {
    // Min values: A=min(10,20)=10, B=min(30,10)=10, C=min(20,30)=20, D=min(5,45)=5
    // Bottom 1 by min: D (min=5)
    const bottom = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 1,
        rankDirection: 'bottom',
        rankMultiSeriesBy: '__min',
      }),
    );
    expect(bottom.labels).toEqual(['D']);
  });

  it('specific fieldId: ranks by that series only', () => {
    // S1 values: A=10, B=30, C=20, D=5 — top 1 = B
    const topByS1 = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top', rankMultiSeriesBy: 'S1' }),
    );
    expect(topByS1.labels).toEqual(['B']);

    // S2 values: A=20, B=10, C=30, D=45 — top 1 = D
    const topByS2 = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top', rankMultiSeriesBy: 'S2' }),
    );
    expect(topByS2.labels).toEqual(['D']);
  });

  it('specific fieldId: both series values are kept in sync with ranked labels', () => {
    // Rank top 2 by S2 (values: A=20, B=10, C=30, D=45) → D and C
    const result = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top', rankMultiSeriesBy: 'S2' }),
    );
    expect(result.labels.sort()).toEqual(['C', 'D']);
    // S1 values should correspond: C=20, D=5
    const labelIdx = (l: string) => result.labels.indexOf(l);
    const s1 = result.series.find((s) => s.fieldId === 'S1')!;
    expect(s1.values[labelIdx('C')]).toBe(20);
    expect(s1.values[labelIdx('D')]).toBe(5);
  });

  it('unknown fieldId falls back to 0 score (treats all labels as equal)', () => {
    // All scores = 0, so top 1 returns whichever has index 0 after stable sort
    const result = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 1,
        rankDirection: 'top',
        rankMultiSeriesBy: 'nonexistent',
      }),
    );
    expect(result.labels).toHaveLength(1);
  });
});

// ─── aggregateByField with xGroupBy ──────────────────────────────────────────

describe('aggregateByField with xGroupBy', () => {
  const rows = [
    { date: '2024-01-05', revenue: 100 },
    { date: '2024-01-20', revenue: 200 },
    { date: '2024-02-10', revenue: 300 },
    { date: '2024-02-25', revenue: 150 },
    { date: '2024-03-01', revenue: 50 },
  ];

  it('groups by month', () => {
    const result = aggregateByField(rows, 'date', 'revenue', 'month');
    expect(result.labels).toEqual(['2024-01', '2024-02', '2024-03']);
    expect(result.values).toEqual([300, 450, 50]);
  });

  it('groups by year', () => {
    const result = aggregateByField(rows, 'date', 'revenue', 'year');
    expect(result.labels).toEqual(['2024']);
    expect(result.values).toEqual([800]);
  });

  it('groups by quarter', () => {
    const result = aggregateByField(rows, 'date', 'revenue', 'quarter');
    expect(result.labels).toEqual(['2024-Q1']);
    expect(result.values).toEqual([800]);
  });

  it('no grouping: raw values remain separate', () => {
    const result = aggregateByField(rows, 'date', 'revenue');
    expect(result.labels).toHaveLength(5);
  });
});

// ─── resolveChartRowsForAggregation ──────────────────────────────────────────

describe('resolveChartRowsForAggregation', () => {
  const customers = [
    { id: 'CUS-1', country: 'Germany' },
    { id: 'CUS-2', country: 'France' },
  ];
  const orders = [
    { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
    { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
    { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
  ];

  const dataSources: Record<string, StudioDataSource> = {
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
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-orders-customers',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  it('anchors aggregation rows on the many-side when Y is on the many-side and X is native', () => {
    const resolvedRows = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );

    expect(resolvedRows).toHaveLength(3);
    expect(resolvedRows.map((row) => row.country)).toEqual(['Germany', 'Germany', 'France']);
    expect(aggregateByField(resolvedRows, 'country', 'total')).toEqual({
      labels: ['France', 'Germany'],
      values: [70, 150],
    });
  });

  it('matches the direct orders-grain aggregation for the same country totals', () => {
    const joinedRows = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    const directRows = enrichRowsWithRelatedFields(
      orders,
      'orders',
      ['country'],
      dataSources,
      relationships,
    );

    expect(aggregateByField(joinedRows, 'country', 'total')).toEqual(
      aggregateByField(directRows, 'country', 'total'),
    );
  });

  it('resolves a series field from the widget source onto many-side anchor rows', () => {
    const resolvedRows = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      'country',
      dataSources,
      relationships,
      [],
    );

    expect(aggregateByTwoFields(resolvedRows, 'country', 'country', 'total')).toEqual({
      labels: ['France', 'Germany'],
      seriesNames: ['France', 'Germany'],
      seriesData: {
        Germany: [null, 150],
        France: [70, null],
      },
    });
  });

  it('returns the same Row[] reference on a second call with the same inputs (cache hit)', () => {
    const result1 = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    const result2 = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    expect(result1).toBe(result2);
  });

  it('returns a different Row[] reference when the rows input changes', () => {
    const rows1 = [{ id: 'CUS-1', country: 'Germany' }];
    const rows2 = [{ id: 'CUS-1', country: 'Germany' }]; // same values, different reference
    const result1 = resolveChartRowsForAggregation(
      rows1,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    const result2 = resolveChartRowsForAggregation(
      rows2,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    expect(result1).not.toBe(result2);
  });

  it('recomputes when the cross-source anchor rows change independently of widgetRows', () => {
    // Chart on customers (widget source), Y = orders.total (cross-source — orders is anchor).
    // Simulate: orders data is refreshed but customer rows are unchanged.
    // With the two-level WeakMap, orders.rows changing should invalidate the cache.
    const widgetRows = [...customers]; // stable customer rows ref

    const ordersV1 = [
      { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
      { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
      { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
    ];
    const ds1: Record<string, StudioDataSource> = {
      ...dataSources,
      orders: { ...dataSources.orders, rows: ordersV1 },
    };

    const result1 = resolveChartRowsForAggregation(
      widgetRows,
      'customers',
      'country',
      ['total'],
      undefined,
      ds1,
      relationships,
      [],
    );
    expect(result1.map((r) => r.total)).toEqual([100, 50, 70]);

    // orders gets a new rows ref with updated totals
    const ordersV2 = [
      { id: 'ORD-1', customerId: 'CUS-1', total: 999 }, // changed
      { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
      { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
    ];
    const ds2: Record<string, StudioDataSource> = {
      ...dataSources,
      orders: { ...dataSources.orders, rows: ordersV2 },
    };

    const result2 = resolveChartRowsForAggregation(
      widgetRows, // same customer rows ref
      'customers',
      'country',
      ['total'],
      undefined,
      ds2,
      relationships,
      [],
    );
    // anchorRows (orders.rows) changed → inner WeakMap miss → recomputed ✓
    expect(result2).not.toBe(result1);
    expect(result2.map((r) => r.total)).toEqual([999, 50, 70]);
  });

  it('returns a cache hit when an unrelated source changes (neither widgetRows nor anchorRows)', () => {
    // Unrelated source 'products' is added — should not invalidate orders/customers chart cache.
    const widgetRows = [...customers];
    const ordersRows = [...orders];

    const ds1: Record<string, StudioDataSource> = {
      customers: { ...dataSources.customers, rows: widgetRows },
      orders: { ...dataSources.orders, rows: ordersRows },
    };

    const result1 = resolveChartRowsForAggregation(
      widgetRows,
      'customers',
      'country',
      ['total'],
      undefined,
      ds1,
      relationships,
      [],
    );

    // 'products' source added — neither widgetRows nor anchorRows changed
    const ds2: Record<string, StudioDataSource> = {
      ...ds1,
      products: { id: 'products', label: 'Products', fields: [], rows: [{ id: 'P1' }] },
    };

    const result2 = resolveChartRowsForAggregation(
      widgetRows,
      'customers',
      'country',
      ['total'],
      undefined,
      ds2,
      relationships,
      [],
    );
    // Neither WeakMap key changed → cache hit → same reference ✓
    expect(result2).toBe(result1);
  });

  it('evaluates expression fields on the same source (fixes blank charts with expr yField)', () => {
    const products = [
      { id: 'P1', category: 'Electronics', price: 100, cost: 60 },
      { id: 'P2', category: 'Electronics', price: 200, cost: 120 },
      { id: 'P3', category: 'Office', price: 50, cost: 40 },
    ];
    const productsSource: StudioDataSource = {
      id: 'products',
      label: 'Products',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'price', label: 'Price', type: 'number' },
        { id: 'cost', label: 'Cost', type: 'number' },
      ],
      rows: products,
    };
    const expressionFields: import('../models/expressionTypes').StudioExpressionField[] = [
      {
        id: 'expr-margin',
        label: 'Unit Margin',
        sourceId: 'products',
        type: 'number',
        isMeasure: false,
        expression: {
          operator: 'subtract',
          inputs: [{ id: 'price' }, { id: 'cost' }],
        },
      },
    ];

    const resolved = resolveChartRowsForAggregation(
      products,
      'products',
      'category',
      ['expr-margin'],
      undefined,
      { products: productsSource },
      [],
      expressionFields,
    );

    // Expression field must be evaluated — not undefined/0
    expect(resolved[0]['expr-margin']).toBe(40); // 100 - 60
    expect(resolved[1]['expr-margin']).toBe(80); // 200 - 120
    expect(resolved[2]['expr-margin']).toBe(10); // 50 - 40

    // Chart aggregation on the expression field should produce correct values
    const agg = aggregateByField(resolved, 'category', 'expr-margin', undefined, 'avg');
    expect(agg.labels).toContain('Electronics');
    const elecIdx = agg.labels.indexOf('Electronics');
    expect(agg.values[elecIdx]).toBe(60); // avg of 40 and 80
  });
});

describe('analyzeChartSupport', () => {
  const customers = [
    { id: 'CUS-1', country: 'Germany' },
    { id: 'CUS-2', country: 'France' },
  ];
  const orders = [
    { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
    { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
    { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
  ];

  const dataSources: Record<string, StudioDataSource> = {
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
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-orders-customers',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  it('supports the direct one-to-many chart case already implemented', () => {
    expect(
      analyzeChartSupport(
        'customers',
        'country',
        ['total'],
        undefined,
        'pie',
        dataSources,
        relationships,
        [],
      ),
    ).toMatchObject({ supported: true });
  });

  it('flags scatter cross-source combinations as unsupported', () => {
    expect(
      analyzeChartSupport(
        'customers',
        'country',
        ['total'],
        undefined,
        'scatter',
        dataSources,
        relationships,
        [],
      ),
    ).toEqual({ supported: false, reason: 'scatter_cross_source_not_supported' });
  });

  it('flags unresolved fields as unsupported', () => {
    expect(
      analyzeChartSupport(
        'customers',
        'region',
        ['total'],
        undefined,
        'pie',
        dataSources,
        relationships,
        [],
      ),
    ).toEqual({ supported: false, reason: 'field_not_found_or_not_direct' });
  });

  it('returns stable message copy for reason codes', () => {
    expect(getChartSupportMessage('mixed_cross_source_fields')).toMatch(
      'single safe aggregation grain',
    );
  });

  it('supports bridging many-side Y through the widget source to a safe one-side dimension source', () => {
    expect(
      analyzeChartSupport(
        'orders',
        'country',
        ['total'],
        undefined,
        'pie',
        {
          customers: dataSources.customers,
          orders: dataSources.orders,
          orderItems: {
            id: 'orderItems',
            label: 'Order Items',
            fields: [
              { id: 'id', label: 'Order Item ID', type: 'string' },
              { id: 'orderId', label: 'Order ID', type: 'string' },
              { id: 'total', label: 'Total', type: 'number' },
            ],
            rows: [
              { id: 'OI-1', orderId: 'ORD-1', total: 30 },
              { id: 'OI-2', orderId: 'ORD-1', total: 70 },
              { id: 'OI-3', orderId: 'ORD-2', total: 50 },
              { id: 'OI-4', orderId: 'ORD-3', total: 70 },
            ],
          },
        },
        [
          ...relationships,
          {
            id: 'rel-orderitems-orders',
            sourceId: 'orderItems',
            sourceField: 'orderId',
            targetId: 'orders',
            targetField: 'id',
            type: 'many-to-one',
          },
        ],
        [],
      ),
    ).toMatchObject({ supported: true });
  });

  it('returns precomputed fieldOwners and anchorSourceId when supported', () => {
    const result = analyzeChartSupport(
      'customers',
      'country',
      ['total'],
      undefined,
      'pie',
      dataSources,
      relationships,
      [],
    );
    expect(result.supported).toBe(true);
    expect(result.fieldOwners).toBeInstanceOf(Map);
    expect(result.fieldOwners?.get('country')).toBe('customers');
    expect(result.fieldOwners?.get('total')).toBe('orders');
    expect(result.anchorSourceId).toBe('orders');
  });

  it('rejects bridging through another many-side source as unsupported', () => {
    expect(
      analyzeChartSupport(
        'orders',
        'status',
        ['total'],
        undefined,
        'pie',
        {
          customers: dataSources.customers,
          orders: dataSources.orders,
          shipments: {
            id: 'shipments',
            label: 'Shipments',
            fields: [
              { id: 'id', label: 'Shipment ID', type: 'string' },
              { id: 'orderId', label: 'Order ID', type: 'string' },
              { id: 'status', label: 'Status', type: 'string' },
            ],
            rows: [
              { id: 'S-1', orderId: 'ORD-1', status: 'Packed' },
              { id: 'S-2', orderId: 'ORD-1', status: 'Shipped' },
            ],
          },
          orderItems: {
            id: 'orderItems',
            label: 'Order Items',
            fields: [
              { id: 'id', label: 'Order Item ID', type: 'string' },
              { id: 'orderId', label: 'Order ID', type: 'string' },
              { id: 'total', label: 'Total', type: 'number' },
            ],
            rows: [{ id: 'OI-1', orderId: 'ORD-1', total: 30 }],
          },
        },
        [
          ...relationships,
          {
            id: 'rel-orderitems-orders',
            sourceId: 'orderItems',
            sourceField: 'orderId',
            targetId: 'orders',
            targetField: 'id',
            type: 'many-to-one',
          },
          {
            id: 'rel-shipments-orders',
            sourceId: 'shipments',
            sourceField: 'orderId',
            targetId: 'orders',
            targetField: 'id',
            type: 'many-to-one',
          },
        ],
        [],
      ),
    ).toEqual({ supported: false, reason: 'mixed_cross_source_fields' });
  });
});

describe('resolveChartRowsForAggregation bridge case', () => {
  const customers = [
    { id: 'CUS-1', country: 'Germany' },
    { id: 'CUS-2', country: 'France' },
  ];
  const orders = [
    { id: 'ORD-1', customerId: 'CUS-1' },
    { id: 'ORD-2', customerId: 'CUS-1' },
    { id: 'ORD-3', customerId: 'CUS-2' },
  ];
  const orderItems = [
    { id: 'OI-1', orderId: 'ORD-1', total: 30 },
    { id: 'OI-2', orderId: 'ORD-1', total: 70 },
    { id: 'OI-3', orderId: 'ORD-2', total: 50 },
    { id: 'OI-4', orderId: 'ORD-3', total: 70 },
  ];

  const dataSources: Record<string, StudioDataSource> = {
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
      ],
      rows: orders,
    },
    orderItems: {
      id: 'orderItems',
      label: 'Order Items',
      fields: [
        { id: 'id', label: 'Order Item ID', type: 'string' },
        { id: 'orderId', label: 'Order ID', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: orderItems,
    },
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-orders-customers',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
    {
      id: 'rel-orderitems-orders',
      sourceId: 'orderItems',
      sourceField: 'orderId',
      targetId: 'orders',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  it('aggregates many-side rows by a one-side field bridged through the widget source', () => {
    const resolvedRows = resolveChartRowsForAggregation(
      orders,
      'orders',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );

    expect(aggregateByField(resolvedRows, 'country', 'total')).toEqual({
      labels: ['France', 'Germany'],
      values: [70, 150],
    });
  });

  it('supports a bridged seriesField from the widget source onto many-side anchor rows', () => {
    const resolvedRows = resolveChartRowsForAggregation(
      orders,
      'orders',
      'country',
      ['total'],
      'customerId',
      dataSources,
      relationships,
      [],
    );

    expect(aggregateByTwoFields(resolvedRows, 'country', 'customerId', 'total')).toEqual({
      labels: ['France', 'Germany'],
      seriesNames: ['CUS-1', 'CUS-2'],
      seriesData: {
        'CUS-1': [null, 150],
        'CUS-2': [70, null],
      },
    });
  });
});

// ─── applyRankToSeriesFieldData ───────────────────────────────────────────────

describe('applyRankToSeriesFieldData', () => {
  const data = {
    labels: ['Q1', 'Q2', 'Q3'],
    seriesNames: ['Alpha', 'Beta', 'Gamma'],
    seriesData: {
      Alpha: [10, 20, 30], // total 60
      Beta: [50, 10, 10], // total 70
      Gamma: [5, 5, 5], // total 15
    },
  };

  function makeLocalFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
    return {
      id: 'f1',
      field: '',
      operator: 'equals',
      value: 3,
      scope: 'widget',
      ...overrides,
    };
  }

  it('null filter returns original data unchanged', () => {
    expect(applyRankToSeriesFieldData(data, null)).toBe(data);
  });

  it('top 2 keeps the 2 series with highest total', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 2, rankDirection: 'top' }),
    );
    expect(result.seriesNames).toHaveLength(2);
    expect(result.seriesNames).toContain('Beta'); // 70
    expect(result.seriesNames).toContain('Alpha'); // 60
    expect(result.seriesNames).not.toContain('Gamma');
  });

  it('bottom 1 keeps the series with lowest total', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom' }),
    );
    expect(result.seriesNames).toEqual(['Gamma']);
  });

  it('removes excluded series from seriesData as well', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }),
    );
    expect(Object.keys(result.seriesData)).not.toContain('Alpha');
    expect(Object.keys(result.seriesData)).not.toContain('Gamma');
    expect(Object.keys(result.seriesData)).toContain('Beta');
  });

  it('preserves labels unchanged', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }),
    );
    expect(result.labels).toEqual(data.labels);
  });

  it('N=0 is a no-op', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 0, rankDirection: 'top' }),
    );
    expect(result).toBe(data);
  });

  it('N >= length returns all series', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 99, rankDirection: 'top' }),
    );
    expect(result.seriesNames).toHaveLength(3);
  });
});

// ─── aggregateByTwoFields ─────────────────────────────────────────────────────

describe('aggregateByTwoFields', () => {
  const rows = [
    { region: 'North', product: 'A', revenue: 100 },
    { region: 'South', product: 'A', revenue: 50 },
    { region: 'North', product: 'B', revenue: 200 },
    { region: 'North', product: 'A', revenue: 75 }, // second North/A row → sum 175
    { region: 'South', product: 'B', revenue: 30 },
  ];

  it('produces one label per unique x value', () => {
    const result = aggregateByTwoFields(rows, 'region', 'product', 'revenue');
    expect(result.labels.sort()).toEqual(['North', 'South']);
  });

  it('produces one series name per unique series field value', () => {
    const result = aggregateByTwoFields(rows, 'region', 'product', 'revenue');
    expect(result.seriesNames.sort()).toEqual(['A', 'B']);
  });

  it('sums values for the same x+series combination', () => {
    const result = aggregateByTwoFields(rows, 'region', 'product', 'revenue');
    const northIdx = result.labels.indexOf('North');
    // North/A: 100 + 75 = 175
    expect(result.seriesData.A[northIdx]).toBe(175);
  });

  it('fills missing x+series combinations with null', () => {
    // There is no South/B row in the original data — wait, there is. Let me use a sparser set.
    const sparse = [
      { region: 'North', product: 'A', revenue: 100 },
      { region: 'South', product: 'B', revenue: 50 },
    ];
    const result = aggregateByTwoFields(sparse, 'region', 'product', 'revenue');
    const northIdx = result.labels.indexOf('North');
    const southIdx = result.labels.indexOf('South');
    expect(result.seriesData.B[northIdx]).toBeNull(); // North has no product B
    expect(result.seriesData.A[southIdx]).toBeNull(); // South has no product A
  });
});

// ─── aggregateMultipleSeries ──────────────────────────────────────────────────

describe('aggregateMultipleSeries', () => {
  const rows = [
    { month: '2024-01', revenue: 100, cost: 60 },
    { month: '2024-02', revenue: 200, cost: 90 },
    { month: '2024-01', revenue: 50, cost: 30 }, // second Jan row
  ];

  it('returns one series entry per yField', () => {
    const result = aggregateMultipleSeries(rows, 'month', ['revenue', 'cost']);
    expect(result.series).toHaveLength(2);
    expect(result.series.map((s) => s.fieldId).sort()).toEqual(['cost', 'revenue']);
  });

  it('produces one label per unique x value', () => {
    const result = aggregateMultipleSeries(rows, 'month', ['revenue', 'cost']);
    expect(result.labels.sort()).toEqual(['2024-01', '2024-02']);
  });

  it('sums values for duplicate x rows within each series', () => {
    const result = aggregateMultipleSeries(rows, 'month', ['revenue', 'cost']);
    const janIdx = result.labels.indexOf('2024-01');
    const revSeries = result.series.find((s) => s.fieldId === 'revenue')!;
    expect(revSeries.values[janIdx]).toBe(150); // 100 + 50
  });

  it('fills 0 for a missing y value', () => {
    const sparse = [
      { month: '2024-01', revenue: 100 }, // no 'cost' field
    ];
    const result = aggregateMultipleSeries(sparse, 'month', ['revenue', 'cost']);
    const costSeries = result.series.find((s) => s.fieldId === 'cost')!;
    expect(costSeries.values[0]).toBe(0);
  });

  it('returns empty series when yFields is empty', () => {
    const result = aggregateMultipleSeries(rows, 'month', []);
    expect(result.series).toHaveLength(0);
    expect(result.labels.length).toBeGreaterThan(0); // labels still computed
  });

  it('applies xGroupBy date truncation', () => {
    const dated = [
      { date: '2024-03-15', revenue: 100 },
      { date: '2024-03-28', revenue: 200 },
      { date: '2024-04-05', revenue: 50 },
    ];
    const result = aggregateMultipleSeries(dated, 'date', ['revenue'], 'month');
    expect(result.labels).toContain('2024-03');
    expect(result.labels).toContain('2024-04');
    const marIdx = result.labels.indexOf('2024-03');
    expect(result.series[0].values[marIdx]).toBe(300); // 100 + 200
  });

  it('auto-promotes to count when yField is a string (avoids NaN)', () => {
    const stringRows = [
      { category: 'A', id: 'contact-1' },
      { category: 'A', id: 'contact-2' },
      { category: 'B', id: 'contact-3' },
    ];
    const result = aggregateMultipleSeries(stringRows, 'category', ['id']);
    const idSeries = result.series.find((s) => s.fieldId === 'id')!;
    // Should count occurrences, not produce NaN
    const aIdx = result.labels.indexOf('A');
    const bIdx = result.labels.indexOf('B');
    expect(idSeries.values[aIdx]).toBe(2);
    expect(idSeries.values[bIdx]).toBe(1);
    idSeries.values.forEach((v) => expect(Number.isNaN(v)).toBe(false));
  });

  it('counts string fields and sums numeric fields in the same call', () => {
    const mixed = [
      { dept: 'Eng', employee_id: 'e-1', salary: 80000 },
      { dept: 'Eng', employee_id: 'e-2', salary: 90000 },
      { dept: 'HR', employee_id: 'e-3', salary: 70000 },
    ];
    const result = aggregateMultipleSeries(mixed, 'dept', ['employee_id', 'salary']);
    const idSeries = result.series.find((s) => s.fieldId === 'employee_id')!;
    const salSeries = result.series.find((s) => s.fieldId === 'salary')!;
    const engIdx = result.labels.indexOf('Eng');
    // employee_id is a string → counted
    expect(idSeries.values[engIdx]).toBe(2);
    // salary is numeric → summed
    expect(salSeries.values[engIdx]).toBe(170000);
  });
});

// ─── aggregateBlendedSeries (cross-source blending) ────────────────────────────

describe('aggregateBlendedSeries', () => {
  // Two independent fact tables sharing only the categorical "segment" axis.
  const deals = [
    { segment: 'Enterprise', pipeline: 500 },
    { segment: 'SMB', pipeline: 200 },
    { segment: 'Enterprise', pipeline: 300 },
  ];
  const orders = [
    { segment: 'Enterprise', revenue: 1000 },
    { segment: 'Mid-Market', revenue: 400 },
  ];

  it('aggregates each series within its own rows and aligns on the shared axis', () => {
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'pipeline', rows: deals },
        { fieldId: 'revenue', rows: orders },
      ],
      'segment',
    );
    const ent = result.labels.indexOf('Enterprise');
    const pipeline = result.series[0];
    const revenue = result.series[1];
    expect(pipeline.values[ent]).toBe(800); // 500 + 300, from deals
    expect(revenue.values[ent]).toBe(1000); // from orders
  });

  it('outer-joins labels across sources, filling 0 for missing combinations', () => {
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'pipeline', rows: deals },
        { fieldId: 'revenue', rows: orders },
      ],
      'segment',
    );
    // Union of segments: Enterprise, SMB (deals only), Mid-Market (orders only)
    expect([...result.labels].sort()).toEqual(['Enterprise', 'Mid-Market', 'SMB']);
    const smb = result.labels.indexOf('SMB');
    const mid = result.labels.indexOf('Mid-Market');
    expect(result.series[1].values[smb]).toBe(0); // no revenue for SMB
    expect(result.series[0].values[mid]).toBe(0); // no pipeline for Mid-Market
  });

  it('preserves series order and count 1:1 even with a shared field id', () => {
    const a = [{ segment: 'X', amount: 10 }];
    const b = [{ segment: 'X', amount: 25 }];
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'amount', rows: a },
        { fieldId: 'amount', rows: b },
      ],
      'segment',
    );
    expect(result.series).toHaveLength(2);
    const x = result.labels.indexOf('X');
    expect(result.series[0].values[x]).toBe(10);
    expect(result.series[1].values[x]).toBe(25);
  });

  it('honours per-series yAggregation independently', () => {
    const rows = [
      { segment: 'A', v: 10 },
      { segment: 'A', v: 30 },
    ];
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'v', rows, yAggregation: 'sum' },
        { fieldId: 'v', rows, yAggregation: 'avg' },
      ],
      'segment',
    );
    const a = result.labels.indexOf('A');
    expect(result.series[0].values[a]).toBe(40); // sum
    expect(result.series[1].values[a]).toBe(20); // avg
  });

  it('sorts labels by total value across series when sortBy is "value"', () => {
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'pipeline', rows: deals },
        { fieldId: 'revenue', rows: orders },
      ],
      'segment',
      undefined,
      'value',
      'desc',
    );
    // Enterprise has the largest combined total (800 + 1000) → first.
    expect(result.labels[0]).toBe('Enterprise');
  });
});

// ─── prepareScatterData ───────────────────────────────────────────────────────

describe('prepareScatterData', () => {
  it('maps rows to {x, y, id} objects', () => {
    const rows = [
      { sales: 10, profit: 3 },
      { sales: 20, profit: 7 },
    ];
    const result = prepareScatterData(rows, 'sales', 'profit');
    expect(result).toEqual([
      { x: 10, y: 3, id: 0 },
      { x: 20, y: 7, id: 1 },
    ]);
  });

  it('defaults null/undefined x and y to 0', () => {
    const result = prepareScatterData([{ sales: null, profit: undefined }], 'sales', 'profit');
    expect(result[0]).toEqual({ x: 0, y: 0, id: 0 });
  });

  it('coerces string numbers to numeric values', () => {
    const result = prepareScatterData([{ x: '5', y: '3.5' }], 'x', 'y');
    expect(result[0].x).toBe(5);
    expect(result[0].y).toBe(3.5);
  });

  it('uses the row index as id', () => {
    const rows = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ];
    const result = prepareScatterData(rows, 'x', 'y');
    expect(result.map((p) => p.id)).toEqual([0, 1, 2]);
  });

  it('returns empty array for empty rows', () => {
    expect(prepareScatterData([], 'x', 'y')).toEqual([]);
  });
});

describe('aggregateSankey', () => {
  it('returns empty nodes and links for empty rows', () => {
    expect(aggregateSankey([], 'from', 'to', 'value')).toEqual({ nodes: [], links: [] });
  });

  it('builds a single link and its two nodes', () => {
    const rows = [{ from: 'A', to: 'B', value: 5 }];
    expect(aggregateSankey(rows, 'from', 'to', 'value')).toEqual({
      nodes: [{ id: 'A' }, { id: 'B' }],
      links: [{ source: 'A', target: 'B', value: 5 }],
    });
  });

  it('sums values for duplicate source→target pairs', () => {
    const rows = [
      { from: 'A', to: 'B', value: 5 },
      { from: 'A', to: 'B', value: 3 },
      { from: 'A', to: 'C', value: 2 },
    ];
    const result = aggregateSankey(rows, 'from', 'to', 'value');
    expect(result.nodes).toEqual([{ id: 'A' }, { id: 'B' }, { id: 'C' }]);
    expect(result.links).toEqual([
      { source: 'A', target: 'B', value: 8 },
      { source: 'A', target: 'C', value: 2 },
    ]);
  });

  it('preserves first-seen node order across multiple links', () => {
    const rows = [
      { from: 'B', to: 'C', value: 1 },
      { from: 'A', to: 'B', value: 1 },
    ];
    expect(aggregateSankey(rows, 'from', 'to', 'value').nodes).toEqual([
      { id: 'B' },
      { id: 'C' },
      { id: 'A' },
    ]);
  });

  it('skips self-loops, empty endpoints, and non-positive values', () => {
    const rows = [
      { from: 'A', to: 'A', value: 5 }, // self-loop
      { from: '', to: 'B', value: 5 }, // empty source
      { from: 'A', to: '', value: 5 }, // empty target
      { from: 'A', to: 'B', value: 0 }, // zero value
      { from: 'A', to: 'B', value: -4 }, // negative value
      { from: 'A', to: 'B', value: 7 }, // the only valid link
    ];
    expect(aggregateSankey(rows, 'from', 'to', 'value')).toEqual({
      nodes: [{ id: 'A' }, { id: 'B' }],
      links: [{ source: 'A', target: 'B', value: 7 }],
    });
  });

  it('coerces non-string node ids to strings', () => {
    const rows = [{ from: 2020, to: 2021, value: 10 }];
    const result = aggregateSankey(rows, 'from', 'to', 'value');
    expect(result.nodes).toEqual([{ id: '2020' }, { id: '2021' }]);
    expect(result.links).toEqual([{ source: '2020', target: '2021', value: 10 }]);
  });

  it('drops the back-edge of a direct cycle (A→B, B→A) to keep an acyclic graph', () => {
    const rows = [
      { from: 'A', to: 'B', value: 5 },
      { from: 'B', to: 'A', value: 3 },
    ];
    expect(aggregateSankey(rows, 'from', 'to', 'value')).toEqual({
      nodes: [{ id: 'A' }, { id: 'B' }],
      links: [{ source: 'A', target: 'B', value: 5 }],
    });
  });

  it('drops the closing edge of a longer cycle (A→B→C→A)', () => {
    const rows = [
      { from: 'A', to: 'B', value: 1 },
      { from: 'B', to: 'C', value: 1 },
      { from: 'C', to: 'A', value: 1 },
    ];
    const result = aggregateSankey(rows, 'from', 'to', 'value');
    expect(result.links).toEqual([
      { source: 'A', target: 'B', value: 1 },
      { source: 'B', target: 'C', value: 1 },
    ]);
    // Node 'A' still appears (as the source of A→B); no orphan nodes are emitted.
    expect(result.nodes).toEqual([{ id: 'A' }, { id: 'B' }, { id: 'C' }]);
  });
});
