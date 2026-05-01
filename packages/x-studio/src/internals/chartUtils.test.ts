import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import {
  applyFilters,
  applyRankToAggregated,
  applyRankToMultiSeries,
  resolveMetricRef,
  resolveMetricRefs,
  resolveRows,
  normalizeToDate,
  truncateToGranularity,
  formatPeriodLabel,
  aggregateByField,
} from './chartUtils';
import type { StudioDataSource, StudioFilterState, StudioRelationship } from '../models';

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
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'equals', value: 'Banana' })]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('not_equals', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'not_equals', value: 'Apple' })]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });

  it('contains — case insensitive', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'contains', value: 'an' })]);
    expect(result.map((r) => r.id)).toEqual([2]); // Banana
  });

  it('does_not_contain', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'does_not_contain', value: 'a' })]);
    expect(result.map((r) => r.id)).toEqual([3, 4, 5]); // Cherry, '', null
  });

  it('starts_with', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'starts_with', value: 'ba' })]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('not_starts_with', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'not_starts_with', value: 'A' })]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });

  it('ends_with', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'ends_with', value: 'ry' })]);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('not_ends_with', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'not_ends_with', value: 'e' })]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });

  it('is_empty — matches empty string and null', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'is_empty', value: '' })]);
    expect(result.map((r) => r.id)).toEqual([4, 5]);
  });

  it('is_not_empty', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'is_not_empty', value: '' })]);
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
      makeFilter({ field: 'score', operator: 'greater_than_or_equal', value: 20, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it('less_than_or_equal', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'less_than_or_equal', value: 20, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 2, 4]);
  });

  it('between — inclusive', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'between', value: { from: 15, to: 25 }, fieldType: 'number' }),
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
      makeFilter({ field: 'date', operator: 'greater_than', value: '2024-06-15', fieldType: 'date' }),
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
      makeFilter({ field: 'date', operator: 'greater_than_or_equal', value: '2024-06-15', fieldType: 'date' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3]);
  });

  it('less_than_or_equal', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'date', operator: 'less_than_or_equal', value: '2024-06-15', fieldType: 'date' }),
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
      makeFilter({ field: 'revenue', filterMode: 'rank', operator: 'equals', value: 3, rankDirection: 'top' }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['e', 'b', 'c']);
  });

  it('bottom N by numeric field (direct)', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'revenue', filterMode: 'rank', operator: 'equals', value: 2, rankDirection: 'bottom' }),
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
      makeFilter({ field: 'revenue', filterMode: 'rank', operator: 'equals', value: 0, rankDirection: 'top' }),
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
        value2: '',        // incomplete
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
  const rows = [{ id: 1, name: 'test' }, { id: 2, name: 'other' }];

  it('filter with empty value is skipped', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'equals', value: '' })]);
    expect(result).toHaveLength(2);
  });

  it('filter with null value is skipped', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'equals', value: null })]);
    expect(result).toHaveLength(2);
  });

  it('filter with no field is skipped', () => {
    const result = applyFilters(rows, [makeFilter({ field: '', operator: 'equals', value: 'test' })]);
    expect(result).toHaveLength(2);
  });

  it('is_empty and is_not_empty are always complete (no value needed)', () => {
    const result = applyFilters(rows, [makeFilter({ field: 'name', operator: 'is_empty', value: '' })]);
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
        makeFilter({ id: 'f2', field: 'total', operator: 'greater_than', value: 150, fieldType: 'number' }),
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
    expect(resolveMetricRef({ sourceId: 'metrics', rowId: 'BM-001', field: 'value' }, dataSources)).toBe(6);
  });

  it('returns undefined for unknown source', () => {
    expect(resolveMetricRef({ sourceId: 'unknown', rowId: 'BM-001', field: 'value' }, dataSources)).toBeUndefined();
  });

  it('returns undefined for unknown row ID', () => {
    expect(resolveMetricRef({ sourceId: 'metrics', rowId: 'BM-999', field: 'value' }, dataSources)).toBeUndefined();
  });

  it('returns undefined for unknown field', () => {
    expect(resolveMetricRef({ sourceId: 'metrics', rowId: 'BM-001', field: 'nonexistent' }, dataSources)).toBeUndefined();
  });

  it('returns undefined when source has no rows', () => {
    const emptySources = { metrics: { ...dataSources.metrics, rows: undefined } };
    expect(resolveMetricRef({ sourceId: 'metrics', rowId: 'BM-001', field: 'value' }, emptySources as any)).toBeUndefined();
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
    const rows = [{ id: 1, months: 3 }, { id: 2, months: 7 }, { id: 3, months: 6 }];
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
    const result = applyRankToAggregated(data, makeFilter({ filterMode: 'rank', value: 3, rankDirection: 'top' }));
    expect(result.labels).toEqual(['D', 'B', 'C']);
    expect(result.values).toEqual([80, 50, 30]);
  });

  it('bottom 2 returns lowest 2 values', () => {
    const result = applyRankToAggregated(data, makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'bottom' }));
    expect(result.labels).toEqual(['A', 'E']);
    expect(result.values).toEqual([10, 20]);
  });

  it('N >= length returns all data', () => {
    const result = applyRankToAggregated(data, makeFilter({ filterMode: 'rank', value: 10, rankDirection: 'top' }));
    expect(result.labels).toHaveLength(5);
  });

  it('null filter returns original data', () => {
    const result = applyRankToAggregated(data, null);
    expect(result).toBe(data);
  });

  it('invalid N (zero) returns original data', () => {
    const result = applyRankToAggregated(data, makeFilter({ filterMode: 'rank', value: 0, rankDirection: 'top' }));
    expect(result).toBe(data);
  });

  it('labels and values stay in sync after ranking', () => {
    const result = applyRankToAggregated(data, makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top' }));
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
    const result = applyRankToMultiSeries(data, makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top' }));
    // C and D are tied at 50 — both should be in top 2
    expect(result.labels).toHaveLength(2);
    expect(result.labels.every((l) => ['C', 'D'].includes(l as string))).toBe(true);
  });

  it('bottom 1 returns label with lowest combined total', () => {
    const result = applyRankToMultiSeries(data, makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom' }));
    expect(result.labels).toEqual(['A']); // A has total 30
  });

  it('null filter returns original data', () => {
    const result = applyRankToMultiSeries(data, null);
    expect(result).toBe(data);
  });

  it('all series values are filtered consistently with labels', () => {
    const result = applyRankToMultiSeries(data, makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }));
    expect(result.series[0].values).toHaveLength(result.labels.length);
    expect(result.series[1].values).toHaveLength(result.labels.length);
  });

  it('N >= labels.length returns all data', () => {
    const result = applyRankToMultiSeries(data, makeFilter({ filterMode: 'rank', value: 10, rankDirection: 'top' }));
    expect(result.labels).toHaveLength(4);
  });

  // ── rankMultiSeriesBy: aggregation modes ──────────────────────────────────

  it('__sum is the default (same as omitting rankMultiSeriesBy)', () => {
    // Totals: A=30, B=40, C=50, D=50
    const explicit = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom', rankMultiSeriesBy: '__sum' }),
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
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom', rankMultiSeriesBy: '__avg' }),
    );
    expect(bottom.labels).toEqual(['A']);

    const top = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top', rankMultiSeriesBy: '__avg' }),
    );
    expect(top.labels).toHaveLength(2);
    expect(top.labels.every((l) => ['C', 'D'].includes(l as string))).toBe(true);
  });

  it('__max: ranks by maximum series value per label', () => {
    // Max values: A=max(10,20)=20, B=max(30,10)=30, C=max(20,30)=30, D=max(5,45)=45
    // Top 1 by max: D
    const top = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top', rankMultiSeriesBy: '__max' }),
    );
    expect(top.labels).toEqual(['D']);
  });

  it('__min: ranks by minimum series value per label', () => {
    // Min values: A=min(10,20)=10, B=min(30,10)=10, C=min(20,30)=20, D=min(5,45)=5
    // Bottom 1 by min: D (min=5)
    const bottom = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom', rankMultiSeriesBy: '__min' }),
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
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top', rankMultiSeriesBy: 'nonexistent' }),
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
