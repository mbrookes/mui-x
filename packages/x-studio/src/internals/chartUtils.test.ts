import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import {
  applyFilters,
  applyRankToAggregated,
  applyRankToMultiSeries,
  applyRankToSeriesFieldData,
  formatTemporalAxisLabel,
  getTemporalAxisData,
  resolveMetricRef,
  resolveMetricRefs,
  resolveRows,
  normalizeToDate,
  normalizeDataSourceRows,
  truncateToGranularity,
  formatPeriodLabel,
  fillTemporalLabelGaps,
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
  enrichRowsWithRelatedFields,
  getReachableSourceIds,
  getChartSupportMessage,
  prepareScatterData,
  analyzeChartSupport,
  resolveChartRowsForAggregation,
} from './chartUtils';
import type {
  StudioDataField,
  StudioDataSource,
  StudioFilterState,
  StudioRelationship,
} from '../models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── String operators ─────────────────────────────────────────────────────────

describe('applyFilters — string operators', () => {
  const rows = [
    { id: 1, name: 'Apple' },
    { id: 2, name: 'Banana' },
    { id: 3, name: 'Cherry' },
    { id: 4, name: '' },
    { id: 5, name: null },
  ];

  it('equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'equals', value: 'Banana' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('not_equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'not_equals', value: 'Apple' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });

  it('contains — case insensitive', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'contains', value: 'an' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]); // Banana
  });

  it('does_not_contain', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'does_not_contain', value: 'a' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3, 4, 5]); // Cherry, '', null
  });

  it('starts_with', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'starts_with', value: 'ba' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('not_starts_with', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'not_starts_with', value: 'A' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });

  it('ends_with', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'ends_with', value: 'ry' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('not_ends_with', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'not_ends_with', value: 'e' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });

  it('is_empty — matches empty string and null', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'is_empty', value: '' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([4, 5]);
  });

  it('is_not_empty', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'is_not_empty', value: '' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('in — matches any of the array values', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'in', value: ['Apple', 'Cherry'] }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 3]);
  });
});

// ─── Numeric operators ────────────────────────────────────────────────────────

describe('applyFilters — numeric operators', () => {
  const rows = [
    { id: 1, score: 10 },
    { id: 2, score: 20 },
    { id: 3, score: 30 },
    { id: 4, score: 20 },
  ];

  it('equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'equals', value: 20, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 4]);
  });

  it('not_equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'not_equals', value: 20, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 3]);
  });

  it('greater_than', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'greater_than', value: 20, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('less_than', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'less_than', value: 20, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it('greater_than_or_equal', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'greater_than_or_equal',
        value: 20,
        fieldType: 'number',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it('less_than_or_equal', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'less_than_or_equal',
        value: 20,
        fieldType: 'number',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 2, 4]);
  });

  it('between — inclusive', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'between',
        value: { from: 15, to: 25 },
        fieldType: 'number',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 4]);
  });

  it('between — from only', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'between', value: { from: 25 }, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('between — to only', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'between', value: { to: 15 }, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it('between — null range passes all', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'between', value: null, fieldType: 'number' }),
    ]);
    expect(result).toHaveLength(4);
  });

  it('string "20" coerces to number for comparison', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'equals', value: '20', fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 4]);
  });
});

// ─── Boolean operators ────────────────────────────────────────────────────────

describe('applyFilters — boolean operators', () => {
  const rows = [
    { id: 1, active: true },
    { id: 2, active: false },
    { id: 3, active: true },
  ];

  it('equals true', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'active', operator: 'equals', value: 'true', fieldType: 'boolean' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 3]);
  });

  it('equals false', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'active', operator: 'equals', value: 'false', fieldType: 'boolean' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('not_equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'active', operator: 'not_equals', value: 'true', fieldType: 'boolean' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });
});

// ─── Date operators ───────────────────────────────────────────────────────────

describe('applyFilters — date operators', () => {
  const rows = [
    { id: 1, date: '2024-01-01' },
    { id: 2, date: '2024-06-15' },
    { id: 3, date: '2024-12-31' },
  ];

  it('equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'date', operator: 'equals', value: '2024-06-15', fieldType: 'date' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('greater_than', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'greater_than',
        value: '2024-06-15',
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('less_than', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'date', operator: 'less_than', value: '2024-06-15', fieldType: 'date' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it('greater_than_or_equal', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'greater_than_or_equal',
        value: '2024-06-15',
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3]);
  });

  it('less_than_or_equal', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'less_than_or_equal',
        value: '2024-06-15',
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 2]);
  });

  it('between dates', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'between',
        value: { from: '2024-01-02', to: '2024-12-30' },
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });
});

// ─── Relative date values ─────────────────────────────────────────────────────

describe('applyFilters — relative date values', () => {
  it('greater_than relative past: old rows are excluded', () => {
    // "date must be after 10 years ago" — 1990 row should be excluded, this year should pass
    const rows = [
      { id: 'old', date: '1990-01-01' },
      { id: 'recent', date: dayjs().subtract(1, 'month').format('YYYY-MM-DD') },
    ];
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'greater_than',
        value: { relative: true, amount: 10, unit: 'year', direction: 'past' },
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['recent']);
  });

  it('less_than relative future: far-future row excluded, nearby row passes', () => {
    const rows = [
      { id: 'near', date: dayjs().add(1, 'month').format('YYYY-MM-DD') },
      { id: 'far', date: '2099-12-31' },
    ];
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'less_than',
        value: { relative: true, amount: 1, unit: 'year', direction: 'next' },
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['near']);
  });
});

// ─── Selection mode ───────────────────────────────────────────────────────────

describe('applyFilters — selection mode', () => {
  const rows = [
    { id: 1, status: 'active' },
    { id: 2, status: 'inactive' },
    { id: 3, status: 'pending' },
    { id: 4, status: 'active' },
  ];

  it('matches rows in the selected set', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'status',
        filterMode: 'selection',
        operator: 'equals',
        value: ['active', 'pending'],
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 3, 4]);
  });

  it('empty selection passes all rows (filter considered incomplete)', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'status', filterMode: 'selection', operator: 'equals', value: [] }),
    ]);
    expect(result).toHaveLength(4);
  });
});

// ─── Rank mode ────────────────────────────────────────────────────────────────

describe('applyFilters — rank mode', () => {
  const rows = [
    { id: 'a', revenue: 100, category: 'X' },
    { id: 'b', revenue: 300, category: 'Y' },
    { id: 'c', revenue: 200, category: 'X' },
    { id: 'd', revenue: 50, category: 'Z' },
    { id: 'e', revenue: 400, category: 'Y' },
  ];

  it('top N by numeric field (direct)', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'revenue',
        filterMode: 'rank',
        operator: 'equals',
        value: 3,
        rankDirection: 'top',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['e', 'b', 'c']);
  });

  it('bottom N by numeric field (direct)', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'revenue',
        filterMode: 'rank',
        operator: 'equals',
        value: 2,
        rankDirection: 'bottom',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['d', 'a']);
  });

  it('top N by aggregate rankByField — keeps all rows belonging to top groups', () => {
    // Top 1 category by total revenue: Y = 700, X = 300, Z = 50 → only Y rows kept
    const result = applyFilters(rows, [
      makeFilter({
        field: 'category',
        filterMode: 'rank',
        operator: 'equals',
        value: 1,
        rankDirection: 'top',
        rankByField: 'revenue',
      }),
    ]);
    expect(result.map((r) => r.id).sort()).toEqual(['b', 'e']);
  });

  it('bottom N by aggregate rankByField', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'category',
        filterMode: 'rank',
        operator: 'equals',
        value: 2,
        rankDirection: 'bottom',
        rankByField: 'revenue',
      }),
    ]);
    // Bottom 2 categories: Z (50) and X (300)
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'c', 'd']);
  });

  it('rank N=0 is treated as incomplete and skipped', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'revenue',
        filterMode: 'rank',
        operator: 'equals',
        value: 0,
        rankDirection: 'top',
      }),
    ]);
    expect(result).toHaveLength(5);
  });
});

// ─── Compound conditions (AND / OR) ───────────────────────────────────────────

describe('applyFilters — compound conditions', () => {
  const rows = [
    { id: 1, score: 10, tag: 'alpha' },
    { id: 2, score: 25, tag: 'beta' },
    { id: 3, score: 50, tag: 'alpha' },
    { id: 4, score: 75, tag: 'beta' },
  ];

  it('AND: both conditions must match', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'greater_than',
        value: 20,
        fieldType: 'number',
        operator2: 'less_than',
        value2: 60,
        conjunction: 'and',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3]);
  });

  it('OR: either condition matches', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'less_than',
        value: 15,
        fieldType: 'number',
        operator2: 'greater_than',
        value2: 60,
        conjunction: 'or',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 4]);
  });

  it('incomplete second condition is ignored', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'greater_than',
        value: 40,
        fieldType: 'number',
        operator2: 'less_than',
        value2: '', // incomplete
        conjunction: 'and',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3, 4]);
  });
});

// ─── Multiple filters (all must pass) ─────────────────────────────────────────

describe('applyFilters — multiple simultaneous filters', () => {
  const rows = [
    { id: 1, score: 50, tag: 'alpha' },
    { id: 2, score: 50, tag: 'beta' },
    { id: 3, score: 10, tag: 'alpha' },
  ];

  it('all filters must pass (implicit AND across filters)', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'equals', value: 50, fieldType: 'number' }),
      makeFilter({ id: 'f2', field: 'tag', operator: 'equals', value: 'alpha' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1]);
  });
});

// ─── Incomplete filter handling ───────────────────────────────────────────────

describe('applyFilters — incomplete filters are skipped', () => {
  const rows = [
    { id: 1, name: 'test' },
    { id: 2, name: 'other' },
  ];

  it('filter with empty value is skipped', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'equals', value: '' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('filter with null value is skipped', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'equals', value: null }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('filter with no field is skipped', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: '', operator: 'equals', value: 'test' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('is_empty and is_not_empty are always complete (no value needed)', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'is_empty', value: '' }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('empty filter array returns all rows', () => {
    const result = applyFilters(rows, []);
    expect(result).toHaveLength(2);
  });
});

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

// ─── resolveMetricRef ─────────────────────────────────────────────────────────

describe('resolveMetricRef', () => {
  const dataSources: Record<string, StudioDataSource> = {
    metrics: {
      id: 'metrics',
      label: 'Business Metrics',
      fields: [{ id: 'value', label: 'Value', type: 'number' }],
      rows: [
        { id: 'BM-001', name: 'Threshold', value: 6 },
        { id: 'BM-002', name: 'Limit', value: 100 },
      ],
    },
  };

  it('resolves to the field value of the matching row', () => {
    expect(
      resolveMetricRef({ sourceId: 'metrics', rowId: 'BM-001', field: 'value' }, dataSources),
    ).toBe(6);
  });

  it('returns undefined for unknown source', () => {
    expect(
      resolveMetricRef({ sourceId: 'unknown', rowId: 'BM-001', field: 'value' }, dataSources),
    ).toBeUndefined();
  });

  it('returns undefined for unknown row ID', () => {
    expect(
      resolveMetricRef({ sourceId: 'metrics', rowId: 'BM-999', field: 'value' }, dataSources),
    ).toBeUndefined();
  });

  it('returns undefined for unknown field', () => {
    expect(
      resolveMetricRef({ sourceId: 'metrics', rowId: 'BM-001', field: 'nonexistent' }, dataSources),
    ).toBeUndefined();
  });

  it('returns undefined when source has no rows', () => {
    const emptySources = { metrics: { ...dataSources.metrics, rows: undefined } };
    expect(
      resolveMetricRef(
        { sourceId: 'metrics', rowId: 'BM-001', field: 'value' },
        emptySources as any,
      ),
    ).toBeUndefined();
  });
});

// ─── resolveMetricRefs ────────────────────────────────────────────────────────

describe('resolveMetricRefs', () => {
  const dataSources: Record<string, StudioDataSource> = {
    metrics: {
      id: 'metrics',
      label: 'Business Metrics',
      fields: [{ id: 'value', label: 'Value', type: 'number' }],
      rows: [{ id: 'BM-012', name: 'Active Months', value: 6 }],
    },
  };

  it('returns filters unchanged when no refs present', () => {
    const filters = [makeFilter({ value: 42 })];
    const result = resolveMetricRefs(filters, dataSources);
    expect(result[0]).toBe(filters[0]); // same reference
  });

  it('replaces value with resolved metric ref', () => {
    const filters = [
      makeFilter({
        value: '',
        valueRef: { sourceId: 'metrics', rowId: 'BM-012', field: 'value' },
      }),
    ];
    const result = resolveMetricRefs(filters, dataSources);
    expect(result[0].value).toBe(6);
    expect(result[0].valueRef).toEqual({ sourceId: 'metrics', rowId: 'BM-012', field: 'value' });
  });

  it('replaces value2 with resolved metric ref', () => {
    const filters = [
      makeFilter({
        value: 0,
        operator2: 'less_than',
        value2: '',
        value2Ref: { sourceId: 'metrics', rowId: 'BM-012', field: 'value' },
      }),
    ];
    const result = resolveMetricRefs(filters, dataSources);
    expect(result[0].value2).toBe(6);
  });

  it('falls back to original value if ref resolves to undefined', () => {
    const filters = [
      makeFilter({
        value: 99,
        valueRef: { sourceId: 'metrics', rowId: 'BM-MISSING', field: 'value' },
      }),
    ];
    const result = resolveMetricRefs(filters, dataSources);
    expect(result[0].value).toBe(99);
  });

  it('resolved value is used in applyFilters', () => {
    const rows = [
      { id: 1, months: 3 },
      { id: 2, months: 7 },
      { id: 3, months: 6 },
    ];
    const filters = resolveMetricRefs(
      [
        makeFilter({
          field: 'months',
          operator: 'greater_than',
          value: '',
          fieldType: 'number',
          valueRef: { sourceId: 'metrics', rowId: 'BM-012', field: 'value' },
        }),
      ],
      dataSources,
    );
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id)).toEqual([2]); // only months > 6
  });

  it('resolves relative date metric refs into the amount while preserving the relative value object', () => {
    const filters = [
      makeFilter({
        field: 'lastOrderDate',
        fieldType: 'date',
        operator: 'greater_than',
        value: { relative: true, amount: 1, unit: 'month', direction: 'past' },
        valueRef: { sourceId: 'metrics', rowId: 'BM-012', field: 'value' },
      }),
    ];

    const result = resolveMetricRefs(filters, dataSources);

    expect(result[0].value).toEqual({
      relative: true,
      amount: 6,
      unit: 'month',
      direction: 'past',
    });
    expect(result[0].valueRef).toEqual({ sourceId: 'metrics', rowId: 'BM-012', field: 'value' });
  });
});

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
  const data: import('./chartUtils').MultiYSeriesData = {
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

// ─── normalizeToDate ──────────────────────────────────────────────────────────

describe('normalizeToDate', () => {
  it('passes through a Date object unchanged', () => {
    const d = new Date('2024-03-15');
    expect(normalizeToDate(d)).toBe(d);
  });

  it('converts a numeric ms timestamp to Date', () => {
    const ms = new Date('2024-03-15').getTime();
    const result = normalizeToDate(ms);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getFullYear()).toBe(2024);
    expect((result as Date).getMonth()).toBe(2); // March = 2
  });

  it('converts an ISO date string to Date', () => {
    const result = normalizeToDate('2024-06-01');
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getFullYear()).toBe(2024);
  });

  it('returns null for unparseable string', () => {
    const result = normalizeToDate('not-a-date');
    expect(result).toBeNull();
  });
});

// ─── truncateToGranularity ────────────────────────────────────────────────────

describe('truncateToGranularity', () => {
  const d = new Date('2024-03-15');

  it('day: returns YYYY-MM-DD', () => {
    expect(truncateToGranularity(d, 'day')).toBe('2024-03-15');
  });

  it('month: returns YYYY-MM', () => {
    expect(truncateToGranularity(d, 'month')).toBe('2024-03');
  });

  it('quarter: returns YYYY-QN', () => {
    expect(truncateToGranularity(d, 'quarter')).toBe('2024-Q1');
    expect(truncateToGranularity(new Date('2024-07-20'), 'quarter')).toBe('2024-Q3');
  });

  it('year: returns YYYY', () => {
    expect(truncateToGranularity(d, 'year')).toBe('2024');
  });

  it('week: returns YYYY-WNN (ISO week)', () => {
    const key = truncateToGranularity(new Date('2024-01-08'), 'week');
    expect(key).toMatch(/^\d{4}-W\d{2}$/);
    expect(key).toBe('2024-W02');
  });

  it('returns null for non-date input', () => {
    expect(truncateToGranularity('not-a-date', 'month')).toBeNull();
  });

  it('accepts ISO string input', () => {
    expect(truncateToGranularity('2024-06-20', 'month')).toBe('2024-06');
  });
});

// ─── formatPeriodLabel ────────────────────────────────────────────────────────

describe('formatPeriodLabel', () => {
  it('formats YYYY-MM as "Mon YYYY"', () => {
    expect(formatPeriodLabel('2024-01')).toBe('Jan 2024');
    expect(formatPeriodLabel('2024-12')).toBe('Dec 2024');
  });

  it('formats YYYY-QN as "QN YYYY"', () => {
    expect(formatPeriodLabel('2024-Q1')).toBe('Q1 2024');
    expect(formatPeriodLabel('2024-Q4')).toBe('Q4 2024');
  });

  it('formats YYYY as itself', () => {
    expect(formatPeriodLabel('2024')).toBe('2024');
  });

  it('formats YYYY-WNN as "Week N YYYY"', () => {
    expect(formatPeriodLabel('2024-W03')).toBe('Week 3 2024');
    expect(formatPeriodLabel('2024-W12')).toBe('Week 12 2024');
  });

  it('formats YYYY-MM-DD as locale day string', () => {
    const label = formatPeriodLabel('2024-03-15');
    expect(label).toMatch(/2024/);
    expect(label).toMatch(/15|Mar|March/);
  });

  it('returns unknown keys as-is', () => {
    expect(formatPeriodLabel('foo')).toBe('foo');
  });
});

describe('fillTemporalLabelGaps', () => {
  it('fills missing day buckets for date labels', () => {
    expect(fillTemporalLabelGaps(['2024-01-01', '2024-01-03'])).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
    ]);
  });

  it('fills missing month buckets for grouped month labels', () => {
    expect(fillTemporalLabelGaps(['2024-01', '2024-03'])).toEqual([
      '2024-01',
      '2024-02',
      '2024-03',
    ]);
  });

  it('preserves non-temporal labels unchanged', () => {
    const labels = ['North', 'South'];
    expect(fillTemporalLabelGaps(labels)).toBe(labels);
  });
});

describe('getTemporalAxisData', () => {
  it('converts grouped month labels into UTC dates', () => {
    const result = getTemporalAxisData(['2024-01', '2024-03']);
    expect(result).toHaveLength(2);
    expect(result?.map((value) => value.toISOString())).toEqual([
      '2024-01-01T00:00:00.000Z',
      '2024-03-01T00:00:00.000Z',
    ]);
  });

  it('converts raw ISO dates into UTC dates', () => {
    const result = getTemporalAxisData(['2024-01-15', '2024-02-20']);
    expect(result).toHaveLength(2);
    expect(result?.[0].toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('returns null for non-temporal labels', () => {
    expect(getTemporalAxisData(['North', 'South'])).toBeNull();
  });
});

describe('formatTemporalAxisLabel', () => {
  it('formats grouped month dates using period labels', () => {
    expect(formatTemporalAxisLabel(new Date('2024-03-01T00:00:00.000Z'), 'month')).toBe('Mar 2024');
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
      seriesNames: ['Germany', 'France'],
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

  function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
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
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top' }),
    );
    expect(result.seriesNames).toHaveLength(2);
    expect(result.seriesNames).toContain('Beta'); // 70
    expect(result.seriesNames).toContain('Alpha'); // 60
    expect(result.seriesNames).not.toContain('Gamma');
  });

  it('bottom 1 keeps the series with lowest total', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom' }),
    );
    expect(result.seriesNames).toEqual(['Gamma']);
  });

  it('removes excluded series from seriesData as well', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }),
    );
    expect(Object.keys(result.seriesData)).not.toContain('Alpha');
    expect(Object.keys(result.seriesData)).not.toContain('Gamma');
    expect(Object.keys(result.seriesData)).toContain('Beta');
  });

  it('preserves labels unchanged', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }),
    );
    expect(result.labels).toEqual(data.labels);
  });

  it('N=0 is a no-op', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeFilter({ filterMode: 'rank', value: 0, rankDirection: 'top' }),
    );
    expect(result).toBe(data);
  });

  it('N >= length returns all series', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeFilter({ filterMode: 'rank', value: 99, rankDirection: 'top' }),
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
    const aIdx = result.seriesNames.indexOf('A');
    // North/A: 100 + 75 = 175
    expect(result.seriesData['A'][northIdx]).toBe(175);
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
    expect(result.seriesData['B'][northIdx]).toBeNull(); // North has no product B
    expect(result.seriesData['A'][southIdx]).toBeNull(); // South has no product A
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

describe('normalizeDataSourceRows', () => {
  const fields = [
    { id: 'id', label: 'ID', type: 'string' as const },
    { id: 'date', label: 'Date', type: 'date' as const },
    { id: 'ts', label: 'Timestamp', type: 'datetime' as const },
  ];

  const makeSource = (rows: Record<string, unknown>[]): StudioDataSource => ({
    id: 's1',
    label: 'Source',
    fields,
    rows,
  });

  it('converts Date objects to ISO strings', () => {
    const d = new Date('2024-03-15T12:00:00Z');
    const result = normalizeDataSourceRows(makeSource([{ id: 1, date: d, ts: d }]));
    expect(result.rows![0].date).toBe('2024-03-15');
    expect(result.rows![0].ts).toBe('2024-03-15T12:00:00.000Z');
  });

  it('converts millisecond timestamps to ISO strings', () => {
    const ms = new Date('2024-06-01T00:00:00Z').getTime();
    const result = normalizeDataSourceRows(makeSource([{ id: 1, date: ms, ts: ms }]));
    expect(result.rows![0].date).toBe('2024-06-01');
    expect(result.rows![0].ts).toBe('2024-06-01T00:00:00.000Z');
  });

  it('leaves already-canonical ISO strings untouched (returns same row reference)', () => {
    const row = { id: 1, date: '2024-01-01', ts: '2024-01-01T00:00:00.000Z' };
    const source = makeSource([row]);
    const result = normalizeDataSourceRows(source);
    expect(result.rows![0]).toBe(row); // same reference — no copy made
  });

  it('leaves null/undefined values untouched', () => {
    const result = normalizeDataSourceRows(makeSource([{ id: 1, date: null, ts: undefined }]));
    expect(result.rows![0].date).toBeNull();
    expect(result.rows![0].ts).toBeUndefined();
  });

  it('does not touch non-date fields', () => {
    const result = normalizeDataSourceRows(makeSource([{ id: 'abc', date: '2024-01-01' }]));
    expect(result.rows![0].id).toBe('abc');
  });

  it('returns original data source reference when there are no rows', () => {
    const source: StudioDataSource = { id: 's1', label: 'S', fields, rows: [] };
    expect(normalizeDataSourceRows(source)).toBe(source);
  });

  it('builds fieldDistinctValues for string fields even when no date fields require normalization', () => {
    const source: StudioDataSource = {
      id: 's1',
      label: 'S',
      fields: [{ id: 'name', label: 'Name', type: 'string' }],
      rows: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alice' }],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.fieldDistinctValues?.name).toEqual(['Alice', 'Bob']);
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
    const normal = resolveRows(source.rows, 'sales', filters, dataSources);
    const skipped = resolveRows(source.rows, 'sales', filters, dataSources, [], [], {
      skipEnrichment: true,
    });
    expect(skipped).toEqual(normal);
  });

  it('skipEnrichment: true returns pre-enriched rows unchanged when no filters', () => {
    // Caller simulates pre-enrichment by adding a computed field manually
    const preEnriched = source.rows.map((r) => ({ ...r, doubled: (r.revenue as number) * 2 }));
    const result = resolveRows(preEnriched, 'sales', [], dataSources, [], [], {
      skipEnrichment: true,
    });
    expect(result).toBe(preEnriched); // same reference — no copy made
  });
});

// ─── Performance: Batch 2 — resolveMetricRefs row index ──────────────────────

describe('resolveMetricRefs — perf: row index', () => {
  const dataSources: Record<string, StudioDataSource> = {
    kpis: {
      id: 'kpis',
      label: 'KPIs',
      fields: [],
      rows: [
        { id: 'metric-1', value: 42 },
        { id: 'metric-2', value: 99 },
      ],
    },
  };

  it('returns the input array unchanged when no filter has a ref (short-circuit)', () => {
    const filters = [makeFilter({ field: 'x', value: '10' })];
    const result = resolveMetricRefs(filters, dataSources);
    expect(result).toBe(filters); // exact same reference — no work done
  });

  it('resolves valueRef via row index to the correct scalar value', () => {
    const filters = [
      makeFilter({
        field: 'threshold',
        valueRef: { sourceId: 'kpis', rowId: 'metric-1', field: 'value' },
      }),
    ];
    const result = resolveMetricRefs(filters, dataSources);
    expect(result[0].value).toBe(42);
  });

  it('resolves value2Ref via row index', () => {
    const filters = [
      makeFilter({
        field: 'threshold',
        value: '0',
        value2Ref: { sourceId: 'kpis', rowId: 'metric-2', field: 'value' },
      }),
    ];
    const result = resolveMetricRefs(filters, dataSources);
    expect(result[0].value2).toBe(99);
  });

  it('falls back to original value for a ref pointing to a missing row', () => {
    const filters = [
      makeFilter({
        field: 'threshold',
        value: 'fallback',
        valueRef: { sourceId: 'kpis', rowId: 'does-not-exist', field: 'value' },
      }),
    ];
    const result = resolveMetricRefs(filters, dataSources);
    // Row not found → resolveRef returns undefined → original value is preserved
    expect(result[0].value).toBe('fallback');
  });

  it('does not mutate filters without refs when mixed with ref filters', () => {
    const plain = makeFilter({ id: 'plain', field: 'x', value: '5' });
    const withRef = makeFilter({
      id: 'with-ref',
      field: 'threshold',
      valueRef: { sourceId: 'kpis', rowId: 'metric-1', field: 'value' },
    });
    const result = resolveMetricRefs([plain, withRef], dataSources);
    expect(result[0]).toBe(plain); // plain filter returned by reference
    expect(result[1].value).toBe(42);
  });
});

// ─── Performance: Batch 3 — fillTemporalLabelGaps in-place Date mutation ──────

describe('fillTemporalLabelGaps — perf: in-place Date mutation', () => {
  it('fills daily gaps the same as the original allocation-per-step approach', () => {
    const result = fillTemporalLabelGaps(['2024-01-01', '2024-01-05']);
    expect(result).toEqual(['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05']);
  });

  it('fills monthly gaps correctly with in-place mutation', () => {
    const result = fillTemporalLabelGaps(['2024-01', '2024-04']);
    expect(result).toEqual(['2024-01', '2024-02', '2024-03', '2024-04']);
  });

  it('fills yearly gaps correctly', () => {
    const result = fillTemporalLabelGaps(['2021', '2024']);
    expect(result).toEqual(['2021', '2022', '2023', '2024']);
  });

  it('returns original labels when last label has a different kind than first', () => {
    // First label is year (2024), last is month (2024-03) — mixed kind, return original
    const labels = ['2024', '2024-03'];
    const result = fillTemporalLabelGaps(labels);
    expect(result).toBe(labels);
  });

  it('returns original labels when no gaps to fill', () => {
    const labels = ['2024-01', '2024-02', '2024-03'];
    const result = fillTemporalLabelGaps(labels);
    // No gaps — filled array would not be longer, so original is returned
    expect(result).toBe(labels);
  });

  it('fills weekly gaps correctly', () => {
    const result = fillTemporalLabelGaps(['2024-W01', '2024-W03']);
    expect(result).toEqual(['2024-W01', '2024-W02', '2024-W03']);
  });

  it('fills quarterly gaps correctly', () => {
    const result = fillTemporalLabelGaps(['2024-Q1', '2024-Q3']);
    expect(result).toEqual(['2024-Q1', '2024-Q2', '2024-Q3']);
  });
});

// ─── Performance: Batch 3 — normalizeDataSourceRows fieldDistinctValues ───────

describe('normalizeDataSourceRows — fieldDistinctValues', () => {
  it('builds sorted distinct values for string fields', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [{ id: 'country', label: 'Country', type: 'string' }],
      rows: [
        { country: 'Germany' },
        { country: 'France' },
        { country: 'Germany' },
        { country: 'US' },
      ],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.fieldDistinctValues?.country).toEqual(['France', 'Germany', 'US']);
  });

  it('builds distinct values for boolean fields', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [{ id: 'active', label: 'Active', type: 'boolean' }],
      rows: [{ active: true }, { active: false }, { active: true }],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.fieldDistinctValues?.active).toEqual(['false', 'true']);
  });

  it('excludes null and empty-string values from distinct index', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [{ id: 'tier', label: 'Tier', type: 'string' }],
      rows: [{ tier: 'gold' }, { tier: null }, { tier: '' }, { tier: 'silver' }],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.fieldDistinctValues?.tier).toEqual(['gold', 'silver']);
  });

  it('does not build index for number fields', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [{ amount: 10 }, { amount: 20 }],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.fieldDistinctValues?.amount).toBeUndefined();
  });

  it('returns source by reference when no rows', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [{ id: 'x', label: 'X', type: 'string' }],
      rows: [],
    };
    expect(normalizeDataSourceRows(source)).toBe(source);
  });

  it('combines date normalization and fieldDistinctValues in a single pass', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'date', label: 'Date', type: 'date' },
      ],
      rows: [
        { region: 'EU', date: new Date('2024-01-15') },
        { region: 'US', date: new Date('2024-02-20') },
      ],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.rows![0].date).toBe('2024-01-15');
    expect(result.fieldDistinctValues?.region).toEqual(['EU', 'US']);
  });
});
