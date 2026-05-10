/**
 * x-studio data pipeline benchmarks
 *
 * Each layer is measured independently:
 *   L1 – normalizeDataSourceRows
 *   L2 – enrichRowsWithExpressions
 *   L3 – resolveRows (cold)
 *   L3-cache – resolveRowsCached (cache hit)
 *   L4 – resolveChartRowsForAggregation (cold)
 *   L4-cache – resolveChartRowsForAggregation (cache hit via computedCache WeakMap)
 *   L5a – aggregateByField
 *   L5b – aggregateByTwoFields
 *   L5c – aggregateMultipleSeries
 *
 * Run:  pnpm bench  (from packages/x-studio)
 *
 * Data is built once per describe block in beforeAll (outside the timed loop).
 * Cache-hit benches prime the cache with a single cold call before benchmarking
 * the warm path.
 */

import { describe, bench, beforeAll } from 'vitest';
import {
  normalizeDataSourceRows,
  resolveRows,
  resolveChartRowsForAggregation,
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
} from '../internals/chartUtils';
import { resolveRowsCached } from '../internals/resolvedRowsCache';
import { getCachedEnrichedRows } from '../internals/enrichedRowsCache';
import { getCachedNormalizedDataSource } from '../internals/normalizedRowsCache';
import { enrichRowsWithExpressions } from '../utils/expressionEvaluator';
import { buildQueryDescriptor } from '../internals/queryDescriptor';
import { StudioRequestCache } from '../internals/StudioRequestCache';
import { buildScenario } from './syntheticData';
import type { StudioDataSource, StudioFilterState, StudioWidget } from '../models';

// ─── Shared bench helper ──────────────────────────────────────────────────────

/**
 * Builds a bench group that measures the given `fn` at `10_000` and `100_000`
 * orders.  The scenario is built once in `beforeAll`; only `fn` is timed.
 * @param {ReturnType<typeof buildScenario>} scenario - The pre-built benchmark scenario.
 * @param {number} orderCount - Number of synthetic orders in the scenario.
 */
function layerBench(
  layerName: string,
  fn: (scenario: ReturnType<typeof buildScenario>, orderCount: number) => void,
) {
  describe(layerName, () => {
    for (const orderCount of [10_000, 100_000]) {
      describe(`${orderCount.toLocaleString()} rows`, () => {
        let scenario: ReturnType<typeof buildScenario>;

        beforeAll(() => {
          scenario = buildScenario(orderCount);
        });

        bench(layerName, () => {
          fn(scenario, orderCount);
        });
      });
    }
  });
}

// ─── L1: normalizeDataSourceRows ─────────────────────────────────────────────
// Normalises date strings → Date objects and builds fieldDistinctValues index.
// Input: raw StudioDataSource with string-valued date fields.

layerBench('L1 normalizeDataSourceRows', ({ dataSources }) => {
  // Build a fresh source object each iteration (without pre-built fieldDistinctValues)
  // so the full normalisation path is exercised every time.
  const raw: StudioDataSource = { ...dataSources.orders, fieldDistinctValues: undefined };
  normalizeDataSourceRows(raw);
});

// ─── L1-cache: getCachedNormalizedDataSource (cache hit) ──────────────────────
// Same normalisation after the cache is warm — O(1) WeakMap + ref check.

describe('L1-cache getCachedNormalizedDataSource (warm hit)', () => {
  for (const orderCount of [10_000, 100_000]) {
    describe(`${orderCount.toLocaleString()} rows`, () => {
      let scenario: ReturnType<typeof buildScenario>;

      beforeAll(() => {
        scenario = buildScenario(orderCount);
        // Prime the cache with one cold call.
        getCachedNormalizedDataSource(scenario.dataSources.orders);
      });

      bench('L1-cache getCachedNormalizedDataSource (warm hit)', () => {
        // Same rows + fields refs → O(1) WeakMap lookup, no recomputation.
        getCachedNormalizedDataSource(scenario.dataSources.orders);
      });
    });
  }
});

// ─── L2: enrichRowsWithExpressions ───────────────────────────────────────────
// Adds per-row computed columns:
//   expr-revenue-adj  = orders.total * 1.1    (arithmetic)
//   expr-country      = customers.country      (join lookup)

layerBench('L2 enrichRowsWithExpressions', ({ dataSources, relationships, expressionFields }) => {
  enrichRowsWithExpressions(
    dataSources.orders.rows!,
    expressionFields,
    'orders',
    dataSources,
    relationships,
  );
});

// ─── L2-cache: getCachedEnrichedRows (cache hit) ──────────────────────────────
// Same enrichment after the enrichedRowsCache is warm.
// Primed with one cold call in beforeAll; warm calls are O(1) ref-equality checks.

describe('L2-cache getCachedEnrichedRows (warm hit)', () => {
  for (const orderCount of [10_000, 100_000]) {
    describe(`${orderCount.toLocaleString()} rows`, () => {
      let scenario: ReturnType<typeof buildScenario>;

      beforeAll(() => {
        scenario = buildScenario(orderCount);
        const { dataSources, relationships, expressionFields } = scenario;
        // Prime the enrichedRowsCache with one cold call.
        getCachedEnrichedRows(
          dataSources.orders.rows!,
          'orders',
          expressionFields,
          dataSources,
          relationships,
        );
      });

      bench('L2-cache getCachedEnrichedRows (warm hit)', () => {
        const { dataSources, relationships, expressionFields } = scenario;
        // Same rows/expressionFields/dataSources refs → cache hit, no recompute.
        getCachedEnrichedRows(
          dataSources.orders.rows!,
          'orders',
          expressionFields,
          dataSources,
          relationships,
        );
      });
    });
  }
});

// ─── L3: resolveRows (cold) ───────────────────────────────────────────────────
// Full filter + semi-join pipeline without caching.
// Filter: orders.status === 'completed'

layerBench(
  'L3 resolveRows (cold, 1 filter)',
  ({ dataSources, relationships, expressionFields }) => {
    const filter: StudioFilterState = {
      id: 'f1',
      scope: 'page',
      field: 'status',
      fieldType: 'string',
      operator: 'equals',
      value: 'completed',
    };
    resolveRows(
      dataSources.orders.rows!,
      'orders',
      [filter],
      dataSources,
      relationships,
      expressionFields,
    );
  },
);

// ─── L3-cache: resolveRowsCached (cache hit) ──────────────────────────────────
// The same call after the cache is warm — should be an O(1) Map lookup.

describe('L3-cache resolveRowsCached (warm hit)', () => {
  for (const orderCount of [10_000, 100_000]) {
    describe(`${orderCount.toLocaleString()} rows`, () => {
      let scenario: ReturnType<typeof buildScenario>;
      // stable filter and globalFilters references — same object on every call
      // so resolvedRowsCache treats this as a cache-valid state
      const filter: StudioFilterState = {
        id: 'f-cache',
        scope: 'page',
        field: 'status',
        fieldType: 'string',
        operator: 'equals',
        value: 'completed',
      };
      const resolvedFilters: StudioFilterState[] = [filter];

      beforeAll(() => {
        scenario = buildScenario(orderCount);
        const { dataSources, relationships, expressionFields } = scenario;
        // Prime the cache: first call computes and stores the entry
        resolveRowsCached(
          dataSources.orders.rows!,
          'orders',
          resolvedFilters,
          dataSources,
          relationships,
          expressionFields,
        );
      });

      bench('L3-cache resolveRowsCached (warm hit)', () => {
        const { dataSources, relationships, expressionFields } = scenario;
        // Same widgetRows WeakMap key + same filterKey → O(1) cache hit
        resolveRowsCached(
          dataSources.orders.rows!,
          'orders',
          resolvedFilters,
          dataSources,
          relationships,
          expressionFields,
        );
      });
    });
  }
});

// ─── L4: resolveChartRowsForAggregation (cold) ────────────────────────────────
// Grain re-anchor: chart on customers source, Y = orders.total, X = country.
// This exercises the O(N_orders + N_customers) join path.

layerBench(
  'L4 resolveChartRowsForAggregation (cold)',
  ({ dataSources, relationships, expressionFields }) => {
    resolveChartRowsForAggregation(
      dataSources.customers.rows!,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      expressionFields,
    );
  },
);

// ─── L4-cache: resolveChartRowsForAggregation (warm hit) ─────────────────────
// Same call after the WeakMap cache is warm — O(1) WeakMap + Map lookup.

describe('L4-cache resolveChartRowsForAggregation (warm hit)', () => {
  for (const orderCount of [10_000, 100_000]) {
    describe(`${orderCount.toLocaleString()} rows`, () => {
      let scenario: ReturnType<typeof buildScenario>;

      beforeAll(() => {
        scenario = buildScenario(orderCount);
        // Prime the WeakMap cache with one cold call
        resolveChartRowsForAggregation(
          scenario.dataSources.customers.rows!,
          'customers',
          'country',
          ['total'],
          undefined,
          scenario.dataSources,
          scenario.relationships,
          scenario.expressionFields,
        );
      });

      bench('L4-cache resolveChartRowsForAggregation (warm hit)', () => {
        resolveChartRowsForAggregation(
          scenario.dataSources.customers.rows!,
          'customers',
          'country',
          ['total'],
          undefined,
          scenario.dataSources,
          scenario.relationships,
          scenario.expressionFields,
        );
      });
    });
  }
});

// ─── L5a: aggregateByField ───────────────────────────────────────────────────
// Group orders by category, sum total.

layerBench('L5a aggregateByField', ({ dataSources }) => {
  aggregateByField(dataSources.orders.rows!, 'category', 'total');
});

// ─── L5b: aggregateByTwoFields ────────────────────────────────────────────────
// Group orders by category × status, sum total (series breakdown).

layerBench('L5b aggregateByTwoFields', ({ dataSources }) => {
  aggregateByTwoFields(dataSources.orders.rows!, 'category', 'status', 'total');
});

// ─── L5c: aggregateMultipleSeries ────────────────────────────────────────────
// Group orders by category, aggregate both total and quantity.

layerBench('L5c aggregateMultipleSeries', ({ dataSources }) => {
  aggregateMultipleSeries(dataSources.orders.rows!, 'category', ['total', 'quantity']);
});

// ── Async adapter path ────────────────────────────────────────────────────────
//
// These benchmarks measure the synchronous CPU work on the async path:
//
//   A1  buildQueryDescriptor — builds filter tree + stable cacheKey from widget
//       + active filters. Varies filter count to capture hashing cost at scale.
//
//   A2  StudioRequestCache.get — warm Map lookup (the hot path executed on every
//       React render when an adapter source is present).
//
//   A3  StudioRequestCache.set + get — round-trip write then read (simulates the
//       first fetch completing and subsequent renders reading from cache).
//
//   A4  StudioRequestCache.invalidateSource — prefix scan over N cached entries.
//       Called each time upsertDataSource() updates a source that has an adapter.

// ── A1: buildQueryDescriptor ──────────────────────────────────────────────────

function makeKpiWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w-bench',
    type: 'kpi',
    sourceId: 'orders',
    title: 'Bench Widget',
    pageId: 'page-1',
    ...overrides,
  } as StudioWidget;
}

function makePageFilter(id: string): StudioFilterState {
  return {
    id,
    scope: 'page',
    field: 'status',
    fieldType: 'string',
    operator: 'equals',
    value: 'completed',
  };
}

describe('A1 buildQueryDescriptor', () => {
  const widget = makeKpiWidget();

  bench('A1 buildQueryDescriptor (1 filter)', () => {
    buildQueryDescriptor(widget, [makePageFilter('f1')], 'page-1');
  });

  bench('A1 buildQueryDescriptor (10 filters)', () => {
    const filters = Array.from({ length: 10 }, (_, i) => makePageFilter(`f${i}`));
    buildQueryDescriptor(widget, filters, 'page-1');
  });

  bench('A1 buildQueryDescriptor (50 filters)', () => {
    const filters = Array.from({ length: 50 }, (_, i) => makePageFilter(`f${i}`));
    buildQueryDescriptor(widget, filters, 'page-1');
  });
});

// ── A2: StudioRequestCache.get (warm Map lookup) ──────────────────────────────

describe('A2 StudioRequestCache.get (warm hit)', () => {
  let cache: StudioRequestCache;
  let cacheKey: string;

  beforeAll(() => {
    cache = new StudioRequestCache();
    const widget = makeKpiWidget();
    cacheKey = buildQueryDescriptor(widget, [makePageFilter('f1')], 'page-1').cacheKey;
    cache.set(cacheKey, { rows: [{ id: 1 }] });
  });

  bench('A2 cache.get (hit)', () => {
    cache.get(cacheKey);
  });

  bench('A2 cache.get (miss)', () => {
    cache.get('nonexistent-key');
  });
});

// ── A3: StudioRequestCache set + get round-trip ───────────────────────────────

describe('A3 StudioRequestCache set+get round-trip', () => {
  let cache: StudioRequestCache;
  let keys: string[];

  beforeAll(() => {
    cache = new StudioRequestCache();
    const widget = makeKpiWidget();
    // Pre-build 100 unique cache keys (vary filter values)
    keys = Array.from({ length: 100 }, (_, i) => {
      const f: StudioFilterState = {
        id: 'f1',
        scope: 'page',
        field: 'status',
        fieldType: 'string',
        operator: 'equals',
        value: `value-${i}`,
      };
      return buildQueryDescriptor(widget, [f], 'page-1').cacheKey;
    });
  });

  let i = 0;
  bench('A3 set+get (rotating keys)', () => {
    const key = keys[i % keys.length];
    cache.set(key, { rows: [{ id: i }] });
    cache.get(key);
    i += 1;
  });
});

// ── A4: StudioRequestCache.invalidateSource (N entries) ──────────────────────

describe('A4 StudioRequestCache.invalidateSource', () => {
  for (const entryCount of [10, 100, 1_000]) {
    describe(`${entryCount} entries`, () => {
      let cache: StudioRequestCache;
      const widget = makeKpiWidget();

      beforeAll(() => {
        // A4 mutates the cache, so we rebuild it before each describe block.
        // The bench loop re-populates before each invalidate to keep work constant.
        cache = new StudioRequestCache();
      });

      bench(`A4 invalidateSource (${entryCount} entries)`, () => {
        // Repopulate so each iteration exercises the same scan length.
        for (let i = 0; i < entryCount; i += 1) {
          const f: StudioFilterState = {
            id: 'f1',
            scope: 'page',
            field: 'status',
            fieldType: 'string',
            operator: 'equals',
            value: `v${i}`,
          };
          const key = buildQueryDescriptor(widget, [f], 'page-1').cacheKey;
          cache.set(key, { rows: [] });
        }
        cache.invalidateSource('orders');
      });
    });
  }
});

