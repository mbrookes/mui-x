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
import { enrichRowsWithExpressions } from '../utils/expressionEvaluator';
import { buildScenario } from './syntheticData';
import type { StudioDataSource, StudioFilterState } from '../models';

// ─── Shared bench helper ──────────────────────────────────────────────────────

/**
 * Builds a bench group that measures the given `fn` at `10_000` and `100_000`
 * orders.  The scenario is built once in `beforeAll`; only `fn` is timed.
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

// ─── L3: resolveRows (cold) ───────────────────────────────────────────────────
// Full filter + semi-join pipeline without caching.
// Filter: orders.status === 'completed'

layerBench('L3 resolveRows (cold, 1 filter)', ({ dataSources, relationships, expressionFields }) => {
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
});

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

layerBench('L4 resolveChartRowsForAggregation (cold)', ({ dataSources, relationships, expressionFields }) => {
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
});

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
