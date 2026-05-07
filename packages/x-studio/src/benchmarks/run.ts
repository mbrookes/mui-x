/**
 * x-studio pipeline benchmarks — standalone runner
 *
 * Outputs a console.table with Hz, mean (ms), p75 (ms), p99 (ms) for each
 * pipeline layer at two scales (10k / 100k rows).
 *
 * Run:  pnpm bench
 */

import { performance } from 'node:perf_hooks';
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
import { buildQueryDescriptor } from '../internals/queryDescriptor';
import { StudioRequestCache } from '../internals/StudioRequestCache';
import { buildScenario } from './syntheticData';
import type { StudioDataSource, StudioFilterState, StudioWidget } from '../models/index';

// ─── Timing utility ───────────────────────────────────────────────────────────

interface BenchResult {
  layer: string;
  rows: string;
  'hz (ops/s)': string;
  'mean (ms)': string;
  'p75 (ms)': string;
  'p99 (ms)': string;
}

function runBench(name: string, fn: () => void, warmup = 5, iterations = 50): BenchResult {
  // Warmup
  for (let i = 0; i < warmup; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }

  times.sort((a, b) => a - b);
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const p75 = times[Math.floor(times.length * 0.75)];
  const p99 = times[Math.floor(times.length * 0.99)];
  const hz = mean > 0 ? Math.round(1000 / mean) : Infinity;

  const [layer, rows] = name.split(' @ ');
  return {
    layer,
    rows,
    'hz (ops/s)': hz.toLocaleString(),
    'mean (ms)': mean.toFixed(3),
    'p75 (ms)': p75.toFixed(3),
    'p99 (ms)': p99.toFixed(3),
  };
}

// ─── Build scenarios ──────────────────────────────────────────────────────────

const SCALES = [10_000, 100_000] as const;

const scenarios = new Map(SCALES.map((n) => [n, buildScenario(n)]));

// ─── Benchmarks ───────────────────────────────────────────────────────────────

const results: BenchResult[] = [];

for (const n of SCALES) {
  const scale = n.toLocaleString();
  const { dataSources, relationships, expressionFields } = scenarios.get(n)!;

  // L1 — normalizeDataSourceRows
  results.push(
    runBench(`L1 normalizeDataSourceRows @ ${scale}`, () => {
      const raw: StudioDataSource = { ...dataSources.orders, fieldDistinctValues: undefined };
      normalizeDataSourceRows(raw);
    }),
  );

  // L2 — enrichRowsWithExpressions
  results.push(
    runBench(`L2 enrichRowsWithExpressions @ ${scale}`, () => {
      enrichRowsWithExpressions(
        dataSources.orders.rows!,
        expressionFields,
        'orders',
        dataSources,
        relationships,
      );
    }),
  );

  // L3 cold — resolveRows with 1 filter
  results.push(
    runBench(`L3 resolveRows (cold) @ ${scale}`, () => {
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
    }),
  );

  // L3 cache hit — resolveRowsCached (same stable refs every call)
  {
    const stableFilter: StudioFilterState = {
      id: 'f-cache',
      scope: 'page',
      field: 'status',
      fieldType: 'string',
      operator: 'equals',
      value: 'completed',
    };
    const resolvedFilters: StudioFilterState[] = [stableFilter];
    // Prime the cache
    resolveRowsCached(
      dataSources.orders.rows!,
      'orders',
      resolvedFilters,
      dataSources,
      relationships,
      expressionFields,
    );
    results.push(
      runBench(`L3 resolveRowsCached (warm) @ ${scale}`, () => {
        resolveRowsCached(
          dataSources.orders.rows!,
          'orders',
          resolvedFilters,
          dataSources,
          relationships,
          expressionFields,
        );
      }),
    );
  }

  // L4 cold — resolveChartRowsForAggregation
  results.push(
    runBench(`L4 resolveChartRows (cold) @ ${scale}`, () => {
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
    }),
  );

  // L4 cache hit — same stable args each call so WeakMap key is stable
  {
    // Prime the WeakMap cache
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
    results.push(
      runBench(`L4 resolveChartRows (warm) @ ${scale}`, () => {
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
      }),
    );
  }

  // L5a — aggregateByField
  results.push(
    runBench(`L5a aggregateByField @ ${scale}`, () => {
      aggregateByField(dataSources.orders.rows!, 'category', 'total');
    }),
  );

  // L5b — aggregateByTwoFields
  results.push(
    runBench(`L5b aggregateByTwoFields @ ${scale}`, () => {
      aggregateByTwoFields(dataSources.orders.rows!, 'category', 'status', 'total');
    }),
  );

  // L5c — aggregateMultipleSeries
  results.push(
    runBench(`L5c aggregateMultipleSeries @ ${scale}`, () => {
      aggregateMultipleSeries(dataSources.orders.rows!, 'category', ['total', 'quantity']);
    }),
  );
}

// ─── Async adapter path benchmarks ───────────────────────────────────────────
//
// These measure the synchronous CPU work on the async path:
//   A1  buildQueryDescriptor — filter tree + stable cacheKey construction
//   A2  StudioRequestCache.get — warm Map lookup (hot path on every render)
//   A3  StudioRequestCache set+get — round-trip (simulates fetch completing)
//   A4  StudioRequestCache.invalidateSource — prefix scan over N entries

function makeKpiWidget(): StudioWidget {
  return {
    id: 'w-bench',
    type: 'kpi',
    sourceId: 'orders',
    title: 'Bench Widget',
    pageId: 'page-1',
  } as unknown as StudioWidget;
}

function makePageFilter(id: string, value = 'completed'): StudioFilterState {
  return {
    id,
    scope: 'page',
    field: 'status',
    fieldType: 'string',
    operator: 'equals',
    value,
  };
}

const asyncWidget = makeKpiWidget();

// A1 — buildQueryDescriptor at 1 / 10 / 50 filters
for (const filterCount of [1, 10, 50]) {
  const filters = Array.from({ length: filterCount }, (_, i) => makePageFilter(`f${i}`));
  results.push(
    runBench(`A1 buildQueryDescriptor @ ${filterCount} filters`, () => {
      buildQueryDescriptor(asyncWidget, filters, 'page-1');
    }),
  );
}

// A2 — cache.get (warm hit / miss)
{
  const cache = new StudioRequestCache();
  const warmKey = buildQueryDescriptor(asyncWidget, [makePageFilter('f1')], 'page-1').cacheKey;
  cache.set(warmKey, { rows: [{ id: 1 }] });
  results.push(
    runBench('A2 cache.get (warm hit) @ N/A', () => {
      cache.get(warmKey);
    }),
  );
  results.push(
    runBench('A2 cache.get (miss) @ N/A', () => {
      cache.get('no-such-key');
    }),
  );
}

// A3 — set+get round-trip with 100 rotating keys
{
  const cache = new StudioRequestCache();
  const keys = Array.from({ length: 100 }, (_, i) => {
    return buildQueryDescriptor(asyncWidget, [makePageFilter('f1', `v${i}`)], 'page-1').cacheKey;
  });
  let idx = 0;
  results.push(
    runBench('A3 cache set+get (100 rotating keys) @ N/A', () => {
      const key = keys[idx % keys.length];
      cache.set(key, { rows: [{ id: idx }] });
      cache.get(key);
      idx += 1;
    }),
  );
}

// A4 — invalidateSource with 10 / 100 / 1 000 entries
for (const entryCount of [10, 100, 1_000]) {
  results.push(
    runBench(`A4 invalidateSource @ ${entryCount} entries`, () => {
      const cache = new StudioRequestCache();
      for (let i = 0; i < entryCount; i++) {
        const key = buildQueryDescriptor(asyncWidget, [makePageFilter('f1', `v${i}`)], 'page-1').cacheKey;
        cache.set(key, { rows: [] });
      }
      cache.invalidateSource('orders');
    }),
  );
}

// ─── Output ───────────────────────────────────────────────────────────────────

console.log('\nx-studio pipeline benchmarks\n');
console.table(results);
