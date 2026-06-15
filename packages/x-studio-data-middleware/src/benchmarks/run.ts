/* eslint-disable no-plusplus, no-console */
/**
 * x-studio-data-middleware pipeline benchmarks — standalone runner
 *
 * Mirrors the methodology of packages/x-studio/src/benchmarks/run.ts:
 *   5 warmup iterations  +  50 timed iterations per bench
 *   Outputs hz (ops/s), mean (ms), p75 (ms), p99 (ms)
 *
 * Layers benchmarked
 * ──────────────────
 *  B1  generateCacheKey          — security-scoped cache key construction
 *                                  (maps to A1 buildQueryDescriptor)
 *  B2  LRUCacheProvider.get      — warm hit + miss
 *                                  (maps to A2 cache.get)
 *  B3  LRUCacheProvider set+get  — round-trip write then read (100 rotating keys)
 *                                  (maps to A3)
 *  B4  LRUCacheProvider.invalidatePrefix — N entries (10 / 100 / 1,000)
 *                                  (maps to A4 invalidateSource)
 *  B5  runPreflight              — COUNT(*) + tier-routing at 10k / 100k rows
 *                                  (new; matches server-middleware timing notes)
 *  B6  handleBatchQuery (cold)   — full pipeline, no cache, at 10k / 100k rows
 *                                  (maps to L3 cold + L5 combined)
 *  B7  handleBatchQuery (warm)   — full pipeline, cache hit, at 10k / 100k rows
 *                                  (maps to L3 warm)
 *  B8  handleBatchQuery (tier-cache cold) — data cache expired, tier cache hit,
 *                                  no COUNT(*) preflight, at 10k / 100k rows
 *
 * Run:  tsx packages/x-studio-data-middleware/src/benchmarks/run.ts
 *   or:  pnpm --filter "@mui/x-studio-data-middleware" bench
 */

import { performance } from 'node:perf_hooks';
import { generateCacheKey } from '../security/cacheKey';
import { LRUCacheProvider } from '../cache/LRUCacheProvider';
import { MapTierCacheProvider } from '../cache/MapTierCacheProvider';
import { handleBatchQuery } from '../handler';
import { runPreflight } from '../router/preflight';
import type {
  JwtSecurityClaims,
  BatchWidgetDescriptor,
  BatchQueryRequest,
} from '../security/types';
import { buildScenario } from './syntheticData';
import { createMockDb } from '../__tests__/mockDb';

// ─── Timing utility ───────────────────────────────────────────────────────────

interface BenchResult {
  layer: string;
  scale: string;
  'hz (ops/s)': string;
  'mean (ms)': string;
  'p75 (ms)': string;
  'p99 (ms)': string;
}

function runBench(
  name: string,
  scale: string,
  fn: () => void | Promise<void>,
  warmup = 5,
  iterations = 50,
): BenchResult {
  const isAsync = fn.constructor.name === 'AsyncFunction';

  // Sync path — fast iterations benefit from sync measurement
  if (!isAsync) {
    for (let i = 0; i < warmup; i++) {
      (fn as () => void)();
    }
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      (fn as () => void)();
      times.push(performance.now() - t0);
    }
    return computeStats(name, scale, times);
  }

  throw new Error(`runBench called with async fn for "${name}" — use runBenchAsync instead`);
}

async function runBenchAsync(
  name: string,
  scale: string,
  fn: () => Promise<void>,
  warmup = 5,
  iterations = 50,
): Promise<BenchResult> {
  for (let i = 0; i < warmup; i++) {
    // eslint-disable-next-line no-await-in-loop
    await fn();
  }
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    await fn();
    times.push(performance.now() - t0);
  }
  return computeStats(name, scale, times);
}

function computeStats(name: string, scale: string, times: number[]): BenchResult {
  times.sort((a, b) => a - b);
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const p75 = times[Math.floor(times.length * 0.75)];
  const p99 = times[Math.floor(times.length * 0.99)];
  const hz = mean > 0 ? Math.round(1000 / mean) : Infinity;

  return {
    layer: name,
    scale,
    'hz (ops/s)': hz.toLocaleString(),
    'mean (ms)': mean.toFixed(3),
    'p75 (ms)': p75.toFixed(3),
    'p99 (ms)': p99.toFixed(3),
  };
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const HMAC_SECRET = 'bench-secret';

const ACME_CLAIMS: JwtSecurityClaims = {
  tenantId: 'acme',
  userId: 'bench-user',
  roleIds: ['analyst'],
};

function makeDescriptor(overrides: Partial<BatchWidgetDescriptor> = {}): BatchWidgetDescriptor {
  return {
    id: 'w-bench',
    table: 'sales',
    ...overrides,
  };
}

function makeFilter(value: string) {
  return { column: 'status', operator: 'eq' as const, value };
}

// ─── Results accumulator ──────────────────────────────────────────────────────

const results: BenchResult[] = [];

// ─── B1: generateCacheKey ─────────────────────────────────────────────────────
// Maps to A1 buildQueryDescriptor from DATA_PIPELINE_PERF_RESULTS.md.
// Varies descriptor complexity (1 / 10 / 50 filters) to capture hashing cost.

for (const filterCount of [1, 10, 50]) {
  const descriptor = makeDescriptor({
    filters: Array.from({ length: filterCount }, (_, i) => makeFilter(`v${i}`)),
  });
  results.push(
    runBench(`B1 generateCacheKey`, `${filterCount} filter(s)`, () => {
      generateCacheKey(ACME_CLAIMS, descriptor, HMAC_SECRET);
    }),
  );
}

// ─── B2: LRUCacheProvider.get ─────────────────────────────────────────────────
// Maps to A2 cache.get warm/miss from DATA_PIPELINE_PERF_RESULTS.md.

{
  const cache = new LRUCacheProvider({ ttlMs: 60_000 });
  const warmKey = generateCacheKey(ACME_CLAIMS, makeDescriptor(), HMAC_SECRET);

  // Seed the warm entry synchronously by calling the real set
  // (LRUCacheProvider.set is async but lru-cache writes synchronously under the hood)
  // We use an IIFE wrapper so we can await at module top level.
  await cache.set(warmKey, { rows: [{ id: 1 }], cachedAt: Date.now() });

  // B2 warm hit — O(1) Map lookup
  await runBenchAsync('B2 cache.get (warm hit)', 'N/A', async () => {
    await cache.get(warmKey);
  }).then((r) => results.push(r));

  // B2 miss — key not found
  await runBenchAsync('B2 cache.get (miss)', 'N/A', async () => {
    await cache.get('no-such-key-bench');
  }).then((r) => results.push(r));
}

// ─── B3: LRUCacheProvider set+get round-trip ─────────────────────────────────
// Maps to A3 cache set+get (100 rotating keys).

{
  const cache = new LRUCacheProvider({ ttlMs: 60_000 });
  const keys = Array.from({ length: 100 }, (_, i) => {
    return generateCacheKey(
      ACME_CLAIMS,
      makeDescriptor({ filters: [makeFilter(`v${i}`)] }),
      HMAC_SECRET,
    );
  });

  let idx = 0;
  await runBenchAsync('B3 set+get (100 rotating keys)', 'N/A', async () => {
    const key = keys[idx % keys.length];
    await cache.set(key, { rows: [{ id: idx }], cachedAt: Date.now() });
    await cache.get(key);
    idx += 1;
  }).then((r) => results.push(r));
}

// ─── B4: LRUCacheProvider.invalidatePrefix ────────────────────────────────────
// Maps to A4 invalidateSource (10 / 100 / 1,000 entries).

for (const entryCount of [10, 100, 1_000]) {
  const cache = new LRUCacheProvider({ ttlMs: 60_000 });

  // eslint-disable-next-line no-await-in-loop
  await runBenchAsync(`B4 invalidatePrefix`, `${entryCount} entries`, async () => {
    // Repopulate before each scan so work is constant across iterations.
    for (let i = 0; i < entryCount; i++) {
      const key = generateCacheKey(
        ACME_CLAIMS,
        makeDescriptor({ filters: [makeFilter(`v${i}`)] }),
        HMAC_SECRET,
      );
      // eslint-disable-next-line no-await-in-loop
      await cache.set(key, { rows: [], cachedAt: Date.now() });
    }
    await cache.invalidatePrefix(`studio:v1:acme:`);
  }).then((r) => results.push(r));
}

// ─── B5: runPreflight (COUNT(*) tier routing) ─────────────────────────────────
// No direct equivalent in original benchmark.
// Original DATA_PIPELINE_PERFORMANCE.md "Server middleware benchmark notes":
//   COUNT(*) preflight — 0.07 ms at 10k, 0.73 ms at 100k (real SQLite).
// This bench uses mockDb (in-memory JS), so results reflect JS overhead.

const SCALES = [10_000, 100_000] as const;

for (const scale of SCALES) {
  const { rows, tenantId, tableKey } = buildScenario(scale);
  const db = createMockDb({ [tableKey]: rows });
  const descriptor = makeDescriptor({ filters: [makeFilter('completed')] });

  // eslint-disable-next-line no-await-in-loop
  await runBenchAsync(
    'B5 runPreflight (COUNT(*) + tier routing)',
    `${scale.toLocaleString()} rows`,
    async () => {
      await runPreflight(
        db,
        { ...ACME_CLAIMS, tenantId },
        descriptor,
        { clientTier: 10_000, serverMemoryTier: 100_000 },
        { tenantColumn: 'tenant_id' },
      );
    },
  ).then((r) => results.push(r));
}

// ─── B6: handleBatchQuery (cold — no cache) ───────────────────────────────────
// Corresponds to L3 cold + L5 aggregation combined from the original pipeline.
// Uses a fresh LRUCacheProvider per iteration so cache is always empty.

for (const scale of SCALES) {
  const { rows, tenantId, tableKey } = buildScenario(scale);
  const db = createMockDb({ [tableKey]: rows });
  const body: BatchQueryRequest = {
    pageId: 'bench-page',
    widgets: [makeDescriptor({ filters: [makeFilter('completed')] })],
  };

  // eslint-disable-next-line no-await-in-loop
  await runBenchAsync(
    'B6 handleBatchQuery (cold, no cache)',
    `${scale.toLocaleString()} rows`,
    async () => {
      await handleBatchQuery(
        body,
        { ...ACME_CLAIMS, tenantId },
        {
          db,
          schemaAllowlist: [tableKey],
          tenantColumn: 'tenant_id',
          cacheProvider: new LRUCacheProvider({ ttlMs: 0 }), // TTL=0 → never caches
          tierCacheTtlMs: 0, // disable tier cache for a true cold measurement
        },
      );
    },
  ).then((r) => results.push(r));
}

// ─── B7: handleBatchQuery (warm — cache hit) ──────────────────────────────────
// Corresponds to L3 warm (resolveRowsCached) from the original pipeline.
// The cache is pre-seeded with one cold call; all iterations are cache hits.

for (const scale of SCALES) {
  const { rows, tenantId, tableKey } = buildScenario(scale);
  const db = createMockDb({ [tableKey]: rows });
  const body: BatchQueryRequest = {
    pageId: 'bench-page',
    widgets: [makeDescriptor({ filters: [makeFilter('completed')] })],
  };
  const warmCache = new LRUCacheProvider({ ttlMs: 60_000 });

  // Prime the cache with one cold call.
  // eslint-disable-next-line no-await-in-loop
  await handleBatchQuery(
    body,
    { ...ACME_CLAIMS, tenantId },
    {
      db,
      schemaAllowlist: [tableKey],
      tenantColumn: 'tenant_id',
      cacheProvider: warmCache,
    },
  );

  // eslint-disable-next-line no-await-in-loop
  await runBenchAsync(
    'B7 handleBatchQuery (warm, cache hit)',
    `${scale.toLocaleString()} rows`,
    async () => {
      await handleBatchQuery(
        body,
        { ...ACME_CLAIMS, tenantId },
        {
          db,
          schemaAllowlist: [tableKey],
          tenantColumn: 'tenant_id',
          cacheProvider: warmCache,
        },
      );
    },
  ).then((r) => results.push(r));
}

// ─── B8: handleBatchQuery (tier-cache cold) ───────────────────────────────────
// Data cache has expired / is empty, but the tier cache has a valid entry.
// Skips COUNT(*) preflight entirely — directly executes the query for the tier.
// Uses a very short-lived data cache (1ms TTL) and a long-lived tier cache to
// simulate the "post data-cache-expiry" repeated request pattern.

for (const scale of SCALES) {
  const { rows, tenantId, tableKey } = buildScenario(scale);
  const db = createMockDb({ [tableKey]: rows });
  const body: BatchQueryRequest = {
    pageId: 'bench-page',
    widgets: [makeDescriptor({ filters: [makeFilter('completed')] })],
  };

  // Pre-warm the tier cache with one cold call (full preflight run).
  const tierCache = new MapTierCacheProvider();
  // eslint-disable-next-line no-await-in-loop
  await handleBatchQuery(
    body,
    { ...ACME_CLAIMS, tenantId },
    {
      db,
      schemaAllowlist: [tableKey],
      tenantColumn: 'tenant_id',
      cacheProvider: new LRUCacheProvider({ ttlMs: 60_000 }),
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 300_000,
    },
  );

  // eslint-disable-next-line no-await-in-loop
  await runBenchAsync(
    'B8 handleBatchQuery (tier-cache cold, no preflight)',
    `${scale.toLocaleString()} rows`,
    async () => {
      await handleBatchQuery(
        body,
        { ...ACME_CLAIMS, tenantId },
        {
          db,
          schemaAllowlist: [tableKey],
          tenantColumn: 'tenant_id',
          // New data cache each iteration → always a cold data miss
          cacheProvider: new LRUCacheProvider({ ttlMs: 1 }),
          tierCacheProvider: tierCache,
          tierCacheTtlMs: 300_000,
        },
      );
    },
  ).then((r) => results.push(r));
}

// ─── Output ───────────────────────────────────────────────────────────────────

console.log('\nx-studio-data-middleware pipeline benchmarks\n');
console.table(results);
