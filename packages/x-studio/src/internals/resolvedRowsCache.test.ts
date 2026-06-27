import { describe, it, expect } from 'vitest';
import { resolveRowsCached } from './resolvedRowsCache';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioRelationship,
  StudioExpressionField,
} from '../models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'region',
    operator: 'equals',
    value: 'EU',
    scope: { kind: 'page' as const },
    ...overrides,
  } as StudioFilterState;
}

function makeDataSources(
  ownRows: Record<string, unknown>[],
  extra?: Record<string, Record<string, unknown>[]>,
): Record<string, StudioDataSource> {
  const sources: Record<string, StudioDataSource> = {
    orders: { id: 'orders', label: 'Orders', fields: [], rows: ownRows },
  };
  if (extra) {
    for (const [key, extraRows] of Object.entries(extra)) {
      sources[key] = { id: key, label: key, fields: [], rows: extraRows };
    }
  }
  return sources;
}

const rows = [
  { id: '1', region: 'EU', amount: 100 },
  { id: '2', region: 'US', amount: 200 },
  { id: '3', region: 'EU', amount: 300 },
];

const relationships: StudioRelationship[] = [];
const expressionFields: StudioExpressionField[] = [];

// ─── Cache correctness ────────────────────────────────────────────────────────

describe('resolveRowsCached', () => {
  // Each test uses a fresh rows array so WeakMap outer keys don't collide.

  it('returns correct filtered rows', () => {
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const filters = [makeFilter({ id: 'f1', field: 'region', operator: 'equals', value: 'EU' })];
    const result = resolveRowsCached(
      ownRows,
      'orders',
      filters,
      dataSources,
      relationships,
      expressionFields,
    );
    expect(result.map((r) => r.id)).toEqual(['1', '3']);
  });

  it('returns the same Row[] reference for two calls with identical (source, filters)', () => {
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const filters = [makeFilter({ id: 'f-shared', value: 'EU' })];

    const result1 = resolveRowsCached(
      ownRows,
      'orders',
      filters,
      dataSources,
      relationships,
      expressionFields,
    );
    const result2 = resolveRowsCached(
      ownRows,
      'orders',
      filters,
      dataSources,
      relationships,
      expressionFields,
    );

    expect(result2).toBe(result1);
  });

  it('returns different Row[] for different filter values', () => {
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const filtersEU = [makeFilter({ id: 'f1', value: 'EU' })];
    const filtersUS = [makeFilter({ id: 'f1', value: 'US' })];

    const result1 = resolveRowsCached(
      ownRows,
      'orders',
      filtersEU,
      dataSources,
      relationships,
      expressionFields,
    );
    const result2 = resolveRowsCached(
      ownRows,
      'orders',
      filtersUS,
      dataSources,
      relationships,
      expressionFields,
    );

    expect(result1).not.toBe(result2);
    expect(result1.map((r) => r.id)).toEqual(['1', '3']);
    expect(result2.map((r) => r.id)).toEqual(['2']);
  });

  it('reuses the cached entry when filter ref changes but content is the same', () => {
    // Key insight: the new cache uses content-based filterKey, not filter refs as sentinels.
    // A new StudioFilterState[] with identical values produces the same filterKey → cache hit.
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const filters1 = [makeFilter({ id: 'f1', value: 'EU' })];
    const result1 = resolveRowsCached(
      ownRows,
      'orders',
      filters1,
      dataSources,
      relationships,
      expressionFields,
    );

    // New array ref, same content — simulates another widget passing the same page filter
    const filters2 = [makeFilter({ id: 'f1', value: 'EU' })];
    const result2 = resolveRowsCached(
      ownRows,
      'orders',
      filters2,
      dataSources,
      relationships,
      expressionFields,
    );

    // Same content → same cache key → same Row[] reference returned
    expect(result2).toBe(result1);
  });

  it('invalidates the cache when own rows reference changes', () => {
    const ownRows1 = [...rows];
    const dataSources1 = makeDataSources(ownRows1);
    const filters = [makeFilter({ id: 'f1', scope: { kind: 'page' }, value: 'EU' })];
    const result1 = resolveRowsCached(
      ownRows1,
      'orders',
      filters,
      dataSources1,
      relationships,
      expressionFields,
    );

    // New rows array (simulates data source refresh)
    const ownRows2 = [...rows];
    const dataSources2 = makeDataSources(ownRows2);
    const result2 = resolveRowsCached(
      ownRows2,
      'orders',
      filters,
      dataSources2,
      relationships,
      expressionFields,
    );

    // Different WeakMap key → cache miss → new result
    expect(result2).not.toBe(result1);
    expect(result2.map((r) => r.id)).toEqual(['1', '3']);
  });

  it('does NOT invalidate cache when an unrelated source rows reference changes', () => {
    // orders.rows is unchanged; only customers.rows gets a new ref.
    // This should NOT invalidate the orders cache entry.
    const ownRows = [...rows];
    const customersV1 = [{ id: 'c1', name: 'Alice' }];
    const dataSources1 = makeDataSources(ownRows, { customers: customersV1 });
    const filters = [makeFilter({ id: 'f1', scope: { kind: 'page' }, value: 'EU' })];
    const result1 = resolveRowsCached(
      ownRows,
      'orders',
      filters,
      dataSources1,
      relationships,
      expressionFields,
    );

    // customers gets a new rows ref; orders rows unchanged
    const customersV2 = [
      { id: 'c1', name: 'Alice' },
      { id: 'c2', name: 'Bob' },
    ];
    const dataSources2 = makeDataSources(ownRows, { customers: customersV2 });
    const result2 = resolveRowsCached(
      ownRows,
      'orders',
      filters,
      dataSources2,
      relationships,
      expressionFields,
    );

    // orders WeakMap key (ownRows) is unchanged → same inner Map → same entry
    expect(result2).toBe(result1);
  });

  it('invalidates the cache when cross-filter foreign source rows change', () => {
    // Set up orders + customers with a real relationship so the cross-filter
    // actually produces different results when customers rows change.
    const ordersRows = [
      { id: 'o1', customerId: 'c1' },
      { id: 'o2', customerId: 'c2' },
      { id: 'o3', customerId: 'c3' },
    ];
    const customersV1 = [
      { id: 'c1', region: 'EU' },
      { id: 'c2', region: 'EU' },
    ];
    const customersV2 = [
      { id: 'c1', region: 'EU' },
      // c2 removed → only o1 should survive
    ];
    const rel: StudioRelationship = {
      id: 'rel-orders-customers',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    };
    const rels = [rel];

    // Same filter in both calls — same filterKey — only the foreign source rows differ
    const crossFilter = makeFilter({
      id: 'cf1',
      scope: { kind: 'cross-filter', sourceWidgetId: 'some-widget', pageId: 'p1' },
      filterSourceId: 'customers',
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });

    const dataSources1: Record<string, StudioDataSource> = {
      orders: { id: 'orders', label: 'Orders', fields: [], rows: ordersRows },
      customers: { id: 'customers', label: 'Customers', fields: [], rows: customersV1 },
    };

    const result1 = resolveRowsCached(
      ordersRows,
      'orders',
      [crossFilter],
      dataSources1,
      rels,
      expressionFields,
    );
    // Cross-filter: customers in EU = c1, c2 → orders with customerId in {c1, c2} → o1, o2
    expect(result1.map((r) => r.id)).toEqual(['o1', 'o2']);

    // customers rows get a new reference (c2 removed) — per-entry check should fail
    const dataSources2: Record<string, StudioDataSource> = {
      orders: { id: 'orders', label: 'Orders', fields: [], rows: ordersRows },
      customers: { id: 'customers', label: 'Customers', fields: [], rows: customersV2 },
    };

    const result2 = resolveRowsCached(
      ordersRows,
      'orders',
      [crossFilter],
      dataSources2,
      rels,
      expressionFields,
    );
    // Now only c1 matches → only o1 survives
    expect(result2.map((r) => r.id)).toEqual(['o1']);
    expect(result2).not.toBe(result1);
  });

  it('returns unfiltered rows when resolvedFilters is empty', () => {
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const result = resolveRowsCached(
      ownRows,
      'orders',
      [],
      dataSources,
      relationships,
      expressionFields,
    );
    expect(result).toHaveLength(3);
  });

  it('falls through to resolveRows when widgetSourceId is undefined', () => {
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const filters = [makeFilter({ id: 'f1', scope: { kind: 'page' }, value: 'EU' })];
    const result = resolveRowsCached(
      ownRows,
      undefined,
      filters,
      dataSources,
      relationships,
      expressionFields,
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it('shares cached results across different widgets with same source and effective filters', () => {
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const pageFilter = makeFilter({ id: 'page-filter', scope: { kind: 'page' }, value: 'EU' });

    // Widget A: page filter only
    const widget1Filters = [pageFilter];
    // Widget B: different array instance, same content
    const widget2Filters = [{ ...pageFilter }];

    const result1 = resolveRowsCached(
      ownRows,
      'orders',
      widget1Filters,
      dataSources,
      relationships,
      expressionFields,
    );
    const result2 = resolveRowsCached(
      ownRows,
      'orders',
      widget2Filters,
      dataSources,
      relationships,
      expressionFields,
    );

    // Same content → same filterKey → same WeakMap entry → same Row[] reference
    expect(result2).toBe(result1);
  });
});
