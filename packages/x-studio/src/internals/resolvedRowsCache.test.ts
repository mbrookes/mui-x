import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveRowsCached, filterFingerprint } from './resolvedRowsCache';
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

  // ─── Fingerprint id-independence + bounded inner map (finding 1.9) ───────────

  it('two filters with identical content but different ids share one cache entry', () => {
    // Interactive / cross-filter ids carry a `Date.now()` suffix. Filters identical in
    // every behavioral field must hit the same entry regardless of id — otherwise every
    // re-application is a guaranteed miss.
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const f1 = [
      makeFilter({ id: 'interactive-w-111', field: 'region', operator: 'equals', value: 'EU' }),
    ];
    const f2 = [
      makeFilter({ id: 'interactive-w-222', field: 'region', operator: 'equals', value: 'EU' }),
    ];
    const r1 = resolveRowsCached(
      ownRows,
      'orders',
      f1,
      dataSources,
      relationships,
      expressionFields,
    );
    const r2 = resolveRowsCached(
      ownRows,
      'orders',
      f2,
      dataSources,
      relationships,
      expressionFields,
    );
    expect(r2).toBe(r1);
  });

  it('bounds the inner cache under filter-value churn (LRU eviction)', () => {
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const filterFor = (v: string) => [
      makeFilter({ id: 'f', field: 'region', operator: 'equals', value: v }),
    ];
    const seedResult = resolveRowsCached(
      ownRows,
      'orders',
      filterFor('seed'),
      dataSources,
      relationships,
      expressionFields,
    );
    // Immediate re-request is a hit (same reference) — the entry is cached.
    expect(
      resolveRowsCached(
        ownRows,
        'orders',
        filterFor('seed'),
        dataSources,
        relationships,
        expressionFields,
      ),
    ).toBe(seedResult);
    // Churn 20 new distinct filter values → evicts the least-recently-used ('seed').
    for (let i = 0; i < 20; i += 1) {
      resolveRowsCached(
        ownRows,
        'orders',
        filterFor(`v${i}`),
        dataSources,
        relationships,
        expressionFields,
      );
    }
    // 'seed' was evicted → recompute yields a fresh reference (cache miss).
    const seedAgain = resolveRowsCached(
      ownRows,
      'orders',
      filterFor('seed'),
      dataSources,
      relationships,
      expressionFields,
    );
    expect(seedAgain).not.toBe(seedResult);
  });

  it('keeps a recently-touched entry alive under churn (LRU recency)', () => {
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const filterFor = (v: string) => [
      makeFilter({ id: 'f', field: 'region', operator: 'equals', value: v }),
    ];
    const keepResult = resolveRowsCached(
      ownRows,
      'orders',
      filterFor('keep'),
      dataSources,
      relationships,
      expressionFields,
    );
    // Insert far more than the cap, touching 'keep' after each insert so it stays newest
    // and never becomes the eviction candidate.
    for (let i = 0; i < 30; i += 1) {
      resolveRowsCached(
        ownRows,
        'orders',
        filterFor(`v${i}`),
        dataSources,
        relationships,
        expressionFields,
      );
      const touched = resolveRowsCached(
        ownRows,
        'orders',
        filterFor('keep'),
        dataSources,
        relationships,
        expressionFields,
      );
      expect(touched).toBe(keepResult);
    }
  });

  // ─── Fingerprint: operator/field/mode changes (Part A item 1) ────────────────

  it('invalidates the cache when a filter operator changes (same id and value)', () => {
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const equalsFilter = [
      makeFilter({ id: 'f1', field: 'region', operator: 'equals', value: 'EU' }),
    ];
    const notEqualsFilter = [
      makeFilter({ id: 'f1', field: 'region', operator: 'not_equals', value: 'EU' }),
    ];

    const result1 = resolveRowsCached(
      ownRows,
      'orders',
      equalsFilter,
      dataSources,
      relationships,
      expressionFields,
    );
    const result2 = resolveRowsCached(
      ownRows,
      'orders',
      notEqualsFilter,
      dataSources,
      relationships,
      expressionFields,
    );

    // Old cache keyed only on id:value → would have served the stale `equals` result.
    expect(result1.map((r) => r.id)).toEqual(['1', '3']);
    expect(result2.map((r) => r.id)).toEqual(['2']);
    expect(result2).not.toBe(result1);
  });

  it('invalidates the cache when a filter second condition changes (same id/operator/value)', () => {
    const ownRows = [
      { id: '1', region: 'EU', amount: 100 },
      { id: '2', region: 'US', amount: 200 },
      { id: '3', region: 'EU', amount: 300 },
    ];
    const dataSources = makeDataSources(ownRows);
    const base = {
      id: 'f1',
      field: 'amount',
      operator: 'greater_than' as const,
      value: 250,
      conjunction: 'or' as const,
      operator2: 'less_than' as const,
    };
    const v1 = [makeFilter({ ...base, value2: 50 })]; // amount>250 OR amount<50 → id 3
    const v2 = [makeFilter({ ...base, value2: 150 })]; // amount>250 OR amount<150 → ids 1,3

    const result1 = resolveRowsCached(ownRows, 'orders', v1, dataSources, relationships, []);
    const result2 = resolveRowsCached(ownRows, 'orders', v2, dataSources, relationships, []);

    expect(result1.map((r) => r.id)).toEqual(['3']);
    expect(result2.map((r) => r.id)).toEqual(['1', '3']);
    expect(result2).not.toBe(result1);
  });

  // ─── Derived cross-filter dependency (Part A item 2a) ────────────────────────

  it('invalidates when the foreign rows of a DERIVED cross-filter source change', () => {
    // A page filter (no filterSourceId) whose field is an expression owned by
    // another source is rerouted internally as a cross-filter with a derived
    // filterSourceId. The cache must track that derived source's rows.
    const ordersRows = [
      { id: 'o1', customerId: 'c1' },
      { id: 'o2', customerId: 'c2' },
      { id: 'o3', customerId: 'c3' },
    ];
    const customersV1 = [
      { id: 'c1', score: 10 },
      { id: 'c2', score: 10 },
      { id: 'c3', score: 1 },
    ];
    const customersV2 = [
      { id: 'c1', score: 10 },
      { id: 'c2', score: 1 }, // c2 no longer matches
      { id: 'c3', score: 1 },
    ];
    const rel: StudioRelationship = {
      id: 'rel-orders-customers',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    };
    const scoreExpr = {
      id: 'scoreDup',
      label: 'Score',
      sourceId: 'customers',
      isMeasure: false,
      expression: { operator: 'multiply', inputs: [{ id: 'score' }, { type: 'number', value: 1 }] },
    } as unknown as StudioExpressionField;
    const exprFields = [scoreExpr];

    const pageFilter = makeFilter({
      id: 'pf1',
      scope: { kind: 'page' },
      field: 'scoreDup',
      operator: 'equals',
      value: 10,
    });

    const dataSources1: Record<string, StudioDataSource> = {
      orders: { id: 'orders', label: 'Orders', fields: [], rows: ordersRows },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [{ id: 'score', label: 'Score', type: 'number' }],
        rows: customersV1,
      } as unknown as StudioDataSource,
    };

    const result1 = resolveRowsCached(
      ordersRows,
      'orders',
      [pageFilter],
      dataSources1,
      [rel],
      exprFields,
    );
    expect(result1.map((r) => r.id)).toEqual(['o1', 'o2']);

    const dataSources2: Record<string, StudioDataSource> = {
      orders: dataSources1.orders,
      customers: { ...dataSources1.customers, rows: customersV2 } as StudioDataSource,
    };
    const result2 = resolveRowsCached(
      ordersRows,
      'orders',
      [pageFilter],
      dataSources2,
      [rel],
      exprFields,
    );
    // Without derived-source tracking this would still show o1,o2 (stale).
    expect(result2.map((r) => r.id)).toEqual(['o1']);
    expect(result2).not.toBe(result1);
  });

  // ─── Absent-foreign-source invalidation (finding 1.2) ────────────────────────

  it("invalidates when a cross-filter's foreign source gains rows AFTER the entry was computed", () => {
    // The foreign source is ABSENT at first compute (no rows) → the cross-filter can't
    // join → all rows pass. When customers later loads, the entry MUST invalidate so the
    // cross-filter is finally enforced (the 1.2 bug served the stale unfiltered result).
    const ordersRows = [
      { id: 'o1', customerId: 'c1' },
      { id: 'o2', customerId: 'c2' },
    ];
    const rels: StudioRelationship[] = [
      {
        id: 'rel-orders-customers',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
        type: 'many-to-one',
      },
    ];
    const crossFilter = makeFilter({
      id: 'cf1',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w', pageId: 'p1' },
      filterSourceId: 'customers',
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });

    // customers entirely absent from dataSources at compute time.
    const dsAbsent: Record<string, StudioDataSource> = {
      orders: { id: 'orders', label: 'Orders', fields: [], rows: ordersRows },
    };
    const result1 = resolveRowsCached(
      ordersRows,
      'orders',
      [crossFilter],
      dsAbsent,
      rels,
      expressionFields,
    );
    // No foreign rows → cross-filter cannot apply → all orders returned.
    expect(result1.map((r) => r.id)).toEqual(['o1', 'o2']);

    // customers loads: only c1 is in EU.
    const dsLoaded: Record<string, StudioDataSource> = {
      orders: dsAbsent.orders,
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [],
        rows: [{ id: 'c1', region: 'EU' }],
      },
    };
    const result2 = resolveRowsCached(
      ordersRows,
      'orders',
      [crossFilter],
      dsLoaded,
      rels,
      expressionFields,
    );
    // Entry invalidated → cross-filter now enforced → only o1 survives.
    expect(result2).not.toBe(result1);
    expect(result2.map((r) => r.id)).toEqual(['o1']);
  });

  it('invalidates when a DERIVED cross-filter foreign source gains rows after compute', () => {
    // A page filter on an expression field owned by another source is rerouted internally
    // as a cross-filter with a derived filterSourceId. Absence of that source at compute
    // time must still be recorded so a later data load invalidates.
    const ordersRows = [
      { id: 'o1', customerId: 'c1' },
      { id: 'o2', customerId: 'c2' },
    ];
    const rels: StudioRelationship[] = [
      {
        id: 'rel-orders-customers',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
        type: 'many-to-one',
      },
    ];
    const scoreExpr = {
      id: 'scoreDup',
      label: 'Score',
      sourceId: 'customers',
      isMeasure: false,
      expression: { operator: 'multiply', inputs: [{ id: 'score' }, { type: 'number', value: 1 }] },
    } as unknown as StudioExpressionField;
    const pageFilter = makeFilter({
      id: 'pf1',
      scope: { kind: 'page' },
      field: 'scoreDup',
      operator: 'equals',
      value: 10,
    });

    const dsAbsent: Record<string, StudioDataSource> = {
      orders: { id: 'orders', label: 'Orders', fields: [], rows: ordersRows },
    };
    const result1 = resolveRowsCached(ordersRows, 'orders', [pageFilter], dsAbsent, rels, [
      scoreExpr,
    ]);
    // No customers rows → derived cross-filter can't apply → all orders returned.
    expect(result1.map((r) => r.id)).toEqual(['o1', 'o2']);

    const dsLoaded: Record<string, StudioDataSource> = {
      orders: dsAbsent.orders,
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [{ id: 'score', label: 'Score', type: 'number' }],
        rows: [{ id: 'c1', score: 10 }],
      } as unknown as StudioDataSource,
    };
    const result2 = resolveRowsCached(ordersRows, 'orders', [pageFilter], dsLoaded, rels, [
      scoreExpr,
    ]);
    expect(result2).not.toBe(result1);
    expect(result2.map((r) => r.id)).toEqual(['o1']);
  });

  it('does NOT thrash when a foreign source is absent at compute AND still absent on recompute', () => {
    // Negative guard: absent → recorded as null; still absent on the second call → the
    // null-vs-null check matches → same cached reference (no needless recompute).
    const ordersRows = [
      { id: 'o1', customerId: 'c1' },
      { id: 'o2', customerId: 'c2' },
    ];
    const rels: StudioRelationship[] = [
      {
        id: 'rel-orders-customers',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
        type: 'many-to-one',
      },
    ];
    const crossFilter = makeFilter({
      id: 'cf1',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w', pageId: 'p1' },
      filterSourceId: 'customers',
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });
    const dsAbsent: Record<string, StudioDataSource> = {
      orders: { id: 'orders', label: 'Orders', fields: [], rows: ordersRows },
    };
    const result1 = resolveRowsCached(
      ordersRows,
      'orders',
      [crossFilter],
      dsAbsent,
      rels,
      expressionFields,
    );
    const result2 = resolveRowsCached(
      ordersRows,
      'orders',
      [crossFilter],
      dsAbsent,
      rels,
      expressionFields,
    );
    expect(result2).toBe(result1);
  });

  // ─── Junction rows dependency (Part A item 2b) ───────────────────────────────

  it('invalidates when a many-to-many junction source rows change', () => {
    const productsRows = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    const tagsRows = [
      { id: 't1', name: 'sale' },
      { id: 't2', name: 'new' },
    ];
    const junctionV1 = [
      { pid: 'p1', tid: 't1' },
      { pid: 'p2', tid: 't1' },
      { pid: 'p3', tid: 't2' },
    ];
    const junctionV2 = [
      { pid: 'p1', tid: 't1' },
      { pid: 'p2', tid: 't2' }, // p2 now links to t2 instead of t1
      { pid: 'p3', tid: 't2' },
    ];
    const rel: StudioRelationship = {
      id: 'rel-m2m',
      type: 'many-to-many',
      sourceId: 'products',
      sourceField: 'id',
      targetId: 'tags',
      targetField: 'id',
      junctionSourceId: 'product_tags',
      junctionSourceField: 'pid',
      junctionTargetField: 'tid',
    } as unknown as StudioRelationship;

    const crossFilter = makeFilter({
      id: 'cf-tags',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w', pageId: 'p1' },
      filterSourceId: 'tags',
      field: 'name',
      operator: 'equals',
      value: 'sale',
    });

    const makeDs = (junction: Record<string, unknown>[]): Record<string, StudioDataSource> => ({
      products: { id: 'products', label: 'Products', fields: [], rows: productsRows },
      tags: { id: 'tags', label: 'Tags', fields: [], rows: tagsRows },
      product_tags: { id: 'product_tags', label: 'PT', fields: [], rows: junction },
    });

    const result1 = resolveRowsCached(
      productsRows,
      'products',
      [crossFilter],
      makeDs(junctionV1),
      [rel],
      [],
    );
    expect(result1.map((r) => r.id)).toEqual(['p1', 'p2']);

    const result2 = resolveRowsCached(
      productsRows,
      'products',
      [crossFilter],
      makeDs(junctionV2),
      [rel],
      [],
    );
    // Junction changed (tags unchanged) → only p1 links to 'sale' now.
    expect(result2.map((r) => r.id)).toEqual(['p1']);
    expect(result2).not.toBe(result1);
  });

  // ─── Expression-formula / relationship edits (Part A item 3) ─────────────────

  it('invalidates when a widget-source expression formula changes (rows unchanged)', () => {
    const ownRows = [...rows];
    const dataSources = makeDataSources(ownRows);
    const exprV1 = {
      id: 'doubled',
      label: 'Doubled',
      sourceId: 'orders',
      isMeasure: false,
      expression: {
        operator: 'multiply',
        inputs: [{ id: 'amount' }, { type: 'number', value: 2 }],
      },
    } as unknown as StudioExpressionField;
    const exprV2 = {
      id: 'doubled',
      label: 'Doubled',
      sourceId: 'orders',
      isMeasure: false,
      expression: {
        operator: 'multiply',
        inputs: [{ id: 'amount' }, { type: 'number', value: 3 }],
      },
    } as unknown as StudioExpressionField;

    const result1 = resolveRowsCached(ownRows, 'orders', [], dataSources, relationships, [exprV1]);
    const result2 = resolveRowsCached(ownRows, 'orders', [], dataSources, relationships, [exprV2]);

    expect(result1[0].doubled).toBe(200); // amount 100 * 2
    expect(result2[0].doubled).toBe(300); // amount 100 * 3 — must reflect the edit
    expect(result2).not.toBe(result1);
  });

  it('invalidates when the relationships array reference changes', () => {
    const ordersRows = [
      { id: 'o1', customerId: 'c1' },
      { id: 'o2', customerId: 'c2' },
    ];
    const customers = [
      { id: 'c1', region: 'EU' },
      { id: 'c2', region: 'EU' },
    ];
    const crossFilter = makeFilter({
      id: 'cf1',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w', pageId: 'p1' },
      filterSourceId: 'customers',
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });
    const ds: Record<string, StudioDataSource> = {
      orders: { id: 'orders', label: 'Orders', fields: [], rows: ordersRows },
      customers: { id: 'customers', label: 'Customers', fields: [], rows: customers },
    };
    const rel1: StudioRelationship[] = [
      {
        id: 'r',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
        type: 'many-to-one',
      },
    ];
    const rel2: StudioRelationship[] = [{ ...rel1[0] }]; // new array + object ref

    const result1 = resolveRowsCached(ordersRows, 'orders', [crossFilter], ds, rel1, []);
    const result2 = resolveRowsCached(ordersRows, 'orders', [crossFilter], ds, rel2, []);
    expect(result2).not.toBe(result1);
  });

  // ─── Finding 1.2 ────────────────────────────────────────────────────────────
  // L3 must track the joined-source-rows dependency of L2 (expression-field) enrichment, not
  // just declared cross-filter sources — a widget-source expression column that JOINs a foreign
  // source makes that foreign source's rows a real dependency of the resolved result, even with
  // no cross-filter present at all.
  it('invalidates when a joined source (via a widget-source JoinFieldExpression column) refreshes its rows, with no cross-filter present (finding 1.2)', () => {
    // Widget on `orders`, with an expression column `customer_name = join(customers.name)`.
    // No filter targets `customers` at all — the only dependency is L2 enrichment.
    const ordersRows = [
      { id: 'o1', customerId: 'c1' },
      { id: 'o2', customerId: 'c2' },
    ];
    const customersV1 = [
      { id: 'c1', name: 'Alice' },
      { id: 'c2', name: 'Bob' },
    ];
    const relationships: StudioRelationship[] = [
      {
        id: 'r',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
        type: 'many-to-one',
      },
    ];
    const customerNameExpr: StudioExpressionField = {
      id: 'customer_name',
      label: 'Customer name',
      type: 'string',
      sourceId: 'orders',
      isMeasure: false,
      expression: { joinSourceId: 'customers', fieldId: 'name' },
    };
    const dsV1: Record<string, StudioDataSource> = {
      orders: { id: 'orders', label: 'Orders', fields: [], rows: ordersRows },
      customers: { id: 'customers', label: 'Customers', fields: [], rows: customersV1 },
    };

    // No filters at all — a widget just displaying the joined column, e.g. a grid.
    const filters: StudioFilterState[] = [];
    const result1 = resolveRowsCached(
      ordersRows,
      'orders',
      filters,
      dsV1,
      relationships,
      [customerNameExpr],
      new Set(['customer_name']),
    );
    expect(result1.find((r) => r.id === 'o1')?.customer_name).toBe('Alice');

    // Host refreshes `customers` rows via a new array reference — `orders` rows (the outer
    // WeakMap key) are UNCHANGED, so without threading L2's join dependency into L3's own
    // tracking, the cache would keep serving the stale `customerNameV1`-baked entry forever.
    const customersV2 = [
      { id: 'c1', name: 'Alice Renamed' },
      { id: 'c2', name: 'Bob Renamed' },
    ];
    const dsV2: Record<string, StudioDataSource> = {
      ...dsV1,
      customers: { id: 'customers', label: 'Customers', fields: [], rows: customersV2 },
    };
    const result2 = resolveRowsCached(
      ordersRows,
      'orders',
      filters,
      dsV2,
      relationships,
      [customerNameExpr],
      new Set(['customer_name']),
    );
    expect(result2).not.toBe(result1);
    expect(result2.find((r) => r.id === 'o1')?.customer_name).toBe('Alice Renamed');
  });

  it('invalidates a filter ON the joined expression column itself when the foreign source refreshes (finding 1.2)', () => {
    // Same setup, but this time there's a PAGE FILTER on the joined expression column
    // (`customer_name = 'Alice'`) — the exact repro the review calls out: "filters on that
    // expression column keep matching stale values too".
    const ordersRows = [
      { id: 'o1', customerId: 'c1' },
      { id: 'o2', customerId: 'c2' },
    ];
    const customersV1 = [
      { id: 'c1', name: 'Alice' },
      { id: 'c2', name: 'Bob' },
    ];
    const relationships: StudioRelationship[] = [
      {
        id: 'r',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
        type: 'many-to-one',
      },
    ];
    const customerNameExpr: StudioExpressionField = {
      id: 'customer_name',
      label: 'Customer name',
      type: 'string',
      sourceId: 'orders',
      isMeasure: false,
      expression: { joinSourceId: 'customers', fieldId: 'name' },
    };
    const dsV1: Record<string, StudioDataSource> = {
      orders: { id: 'orders', label: 'Orders', fields: [], rows: ordersRows },
      customers: { id: 'customers', label: 'Customers', fields: [], rows: customersV1 },
    };
    const nameFilter = makeFilter({
      id: 'f-name',
      scope: { kind: 'page' as const },
      field: 'customer_name',
      operator: 'equals',
      value: 'Alice',
    });

    const result1 = resolveRowsCached(
      ordersRows,
      'orders',
      [nameFilter],
      dsV1,
      relationships,
      [customerNameExpr],
      new Set(['customer_name']),
    );
    expect(result1.map((r) => r.id)).toEqual(['o1']);

    // Customer "Bob" is renamed to "Alice" — a fresh customers rows array (setDataSourceRows).
    const customersV2 = [
      { id: 'c1', name: 'Charlie' }, // Alice renamed away
      { id: 'c2', name: 'Alice' }, // Bob renamed to Alice
    ];
    const dsV2: Record<string, StudioDataSource> = {
      ...dsV1,
      customers: { id: 'customers', label: 'Customers', fields: [], rows: customersV2 },
    };
    const result2 = resolveRowsCached(
      ordersRows,
      'orders',
      [nameFilter],
      dsV2,
      relationships,
      [customerNameExpr],
      new Set(['customer_name']),
    );
    // Without the fix, this would still return ['o1'] (stale) instead of ['o2'].
    expect(result2.map((r) => r.id)).toEqual(['o2']);
  });
});

// ─── filterFingerprint — relative date detection (finding 5) ──────────────────
//
// The cache key computed by `filterFingerprint` previously only detected a relative date value
// sitting at the TOP level of `f.value`/`f.value2` (`isRelativeDateValue(f.value)`). A `between`
// filter's `f.value` is itself a stable `{ from, to }` object — never a `RelativeDateValue` — so
// a relative bound NESTED inside it (`{ from: <relative>, to: <relative> }`) went completely
// undetected: the fingerprint stayed identical across a midnight crossing even though the
// resolved date window shifted, serving a STALE window from `resolveRowsCached`'s cache for the
// remainder of a long-lived session.
describe('filterFingerprint — relative date detection (finding 5)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function betweenRelativeFilter(): StudioFilterState {
    return {
      id: 'f1',
      field: 'orderDate',
      fieldType: 'date',
      operator: 'between',
      value: {
        from: { relative: true, amount: 30, unit: 'day', direction: 'past' },
        to: { relative: true, amount: 0, unit: 'day', direction: 'past' },
      },
      scope: { kind: 'page' as const },
    } as StudioFilterState;
  }

  it('changes when a relative bound NESTED in a `between` filter crosses a day boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
    const fingerprintDay1 = filterFingerprint(betweenRelativeFilter());

    vi.setSystemTime(new Date('2024-06-16T12:00:00Z'));
    const fingerprintDay2 = filterFingerprint(betweenRelativeFilter());

    // Before the fix these were IDENTICAL (the raw `{from,to}` object never changes), so
    // `resolveRowsCached` kept serving yesterday's resolved window forever.
    expect(fingerprintDay1).not.toBe(fingerprintDay2);
  });

  it('a `between` filter with only ONE relative bound (the other absolute) still changes across a day boundary', () => {
    const filter: StudioFilterState = {
      id: 'f1',
      field: 'orderDate',
      fieldType: 'date',
      operator: 'between',
      value: {
        from: { relative: true, amount: 7, unit: 'day', direction: 'past' },
        to: '2024-12-31',
      },
      scope: { kind: 'page' as const },
    } as StudioFilterState;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
    const fingerprintDay1 = filterFingerprint(filter);

    vi.setSystemTime(new Date('2024-06-16T12:00:00Z'));
    const fingerprintDay2 = filterFingerprint(filter);

    expect(fingerprintDay1).not.toBe(fingerprintDay2);
  });

  it('a top-level relative value (not nested in `between`) still changes across a day boundary (regression guard)', () => {
    const filter: StudioFilterState = {
      id: 'f1',
      field: 'orderDate',
      fieldType: 'date',
      operator: 'greater_than_or_equal',
      value: { relative: true, amount: 7, unit: 'day', direction: 'past' },
      scope: { kind: 'page' as const },
    } as StudioFilterState;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
    const fingerprintDay1 = filterFingerprint(filter);

    vi.setSystemTime(new Date('2024-06-16T12:00:00Z'));
    const fingerprintDay2 = filterFingerprint(filter);

    expect(fingerprintDay1).not.toBe(fingerprintDay2);
  });

  it('a `between` filter with only absolute bounds is unaffected by the day (no spurious cache misses)', () => {
    const filter: StudioFilterState = {
      id: 'f1',
      field: 'orderDate',
      fieldType: 'date',
      operator: 'between',
      value: { from: '2024-01-01', to: '2024-01-31' },
      scope: { kind: 'page' as const },
    } as StudioFilterState;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
    const fingerprintDay1 = filterFingerprint(filter);

    vi.setSystemTime(new Date('2024-06-16T12:00:00Z'));
    const fingerprintDay2 = filterFingerprint(filter);

    expect(fingerprintDay1).toBe(fingerprintDay2);
  });
});
