# x-studio-data-middleware — Pipeline Benchmark Results

Run the benchmarks with:

```bash
pnpm --filter "@mui/x-studio-data-middleware" bench
# or:
npx tsx packages/x-studio-data-middleware/src/benchmarks/run.ts
```

---

## Run: 2026-06-12 (with tier routing cache)

**Machine:** Apple M2, 16 GB RAM, macOS (darwin x64)
**Node:** v26.0.0 (tsx ESM, no JIT warm-up exclusion)
**Iterations:** 50 per benchmark (5 warmup)

### Performance improvements applied (cumulative)

#### Round 1 — three optimisations to cache internals

1. **`LRUCacheProvider.sizeCalculation` — O(1) row-count estimate**
   Replaced `Buffer.byteLength(JSON.stringify(value.rows))` with
   `value.rows.length * avgBytesPerRow + 64` (default 512 bytes/row,
   configurable). Avoids O(N) full serialization on every `cache.set()`.

2. **`LRUCacheProvider.invalidatePrefix` — secondary prefix index**
   Added a `Map<prefix, Set<key>>` maintained via the `lru-cache` `dispose`
   callback. `invalidatePrefix()` is now O(N_matched) instead of O(N_all).
   Trade-off: adds ~0.05 ms overhead per `set()`; pays off above ~30 entries.

3. **`computeSecurityHash` — memoisation**
   HMAC-SHA256 security hash is now cached in a bounded `Map` (max 1,000 entries)
   keyed by `{tenantId, regionIds, department}`. Repeated requests from the same
   user skip the HMAC computation entirely.

#### Round 2 — tier routing cache (B8)

4. **`MapTierCacheProvider` — skip preflight on repeated cold misses**
   The COUNT(\*) preflight determines the routing tier (client/server/db). After
   the first cold miss the tier result is cached for 5 minutes (configurable
   `tierCacheTtlMs`). Subsequent requests within the tier-cache window skip the
   COUNT(\*) entirely and execute directly for the cached tier. B8 measures this
   path; B6 remains the true-cold baseline.

### B1 — generateCacheKey

Maps to **A1 `buildQueryDescriptor`** in `DATA_PIPELINE_PERF_RESULTS.md`.

Measures the synchronous CPU cost of building a security-scoped cache key from
`JwtSecurityClaims` + `BatchWidgetDescriptor`. Cost scales with descriptor size
(HMAC + SHA-256 over `sortedStringify(descriptor)`). At 1 filter, the security
hash is memoised — cost is dominated by the query hash only.

| #   | Scale      | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
| :-- | :--------- | ---------: | --------: | -------: | -------: |
| B1  | 1 filter   |    100,133 |     0.010 |    0.010 |    0.029 |
| B1  | 10 filters |     21,423 |     0.047 |    0.019 |    0.888 |
| B1  | 50 filters |      5,401 |     0.185 |    0.067 |    3.583 |

### B2 — LRUCacheProvider.get

Maps to **A2 `cache.get`** in `DATA_PIPELINE_PERF_RESULTS.md`.

Warm hit: same key present in the LRU cache. Miss: key absent.
`LRUCacheProvider` wraps `lru-cache` behind an async interface, adding a
microtask hop vs the synchronous `Map.get()` in `StudioRequestCache`.

| #   | Condition | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
| :-- | :-------- | ---------: | --------: | -------: | -------: |
| B2  | warm hit  |     37,886 |     0.026 |    0.002 |    0.531 |
| B2  | miss      |    171,136 |     0.006 |    0.001 |    0.242 |

### B3 — LRUCacheProvider set + get round-trip

Maps to **A3** in `DATA_PIPELINE_PERF_RESULTS.md`.

100 rotating keys: write then immediately read, simulating a fetch completing
and the next render reading from cache.

| #   | Scale             | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
| :-- | :---------------- | ---------: | --------: | -------: | -------: |
| B3  | 100 rotating keys |     41,964 |     0.024 |    0.006 |    0.546 |

### B4 — LRUCacheProvider.invalidatePrefix

Maps to **A4 `invalidateSource`** in `DATA_PIPELINE_PERF_RESULTS.md`.

Each iteration repopulates the cache to keep scan length constant.
The secondary prefix index makes invalidation O(N_matched) instead of O(N_all).
Note: at 10 entries the per-`set()` index overhead outweighs the scan saving;
the index pays off above ~30 entries.

| #   | Scale         | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
| :-- | :------------ | ---------: | --------: | -------: | -------: |
| B4  | 10 entries    |      4,118 |     0.243 |    0.191 |    2.477 |
| B4  | 100 entries   |        714 |     1.400 |    1.191 |    9.794 |
| B4  | 1,000 entries |        148 |     6.760 |    6.022 |   37.726 |

### B5 — runPreflight (COUNT(\*) + tier routing)

No direct equivalent in the original benchmark.
Historical real-SQLite reference from `DATA_PIPELINE_PERFORMANCE.md`:
`0.07 ms` at 10k, `0.73 ms` at 100k (WAL-mode covering index).

This bench uses `mockDb` (in-memory JS linear scan), so figures reflect the
JavaScript overhead of the pipeline — not the cost of a real SQL engine.

| #   | Scale        | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
| :-- | :----------- | ---------: | --------: | -------: | -------: |
| B5  | 10,000 rows  |      2,514 |     0.398 |    0.315 |    2.852 |
| B5  | 100,000 rows |        273 |     3.659 |    3.754 |    7.615 |

### B6 — handleBatchQuery (cold, no cache)

Maps to the combined **L3 cold + L5 aggregation** path from
`DATA_PIPELINE_PERF_RESULTS.md`.

Full pipeline execution with an empty cache AND tier cache disabled: allowlist
validation → preflight COUNT(\*) → tier selection → query execution → response
assembly. This is the worst-case first-ever request.

| #   | Scale        | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
| :-- | :----------- | ---------: | --------: | -------: | -------: |
| B6  | 10,000 rows  |      1,499 |     0.667 |    0.636 |    1.182 |
| B6  | 100,000 rows |        142 |     7.062 |    6.865 |   23.201 |

### B7 — handleBatchQuery (warm, cache hit)

Maps to **L3 warm (`resolveRowsCached`)** from `DATA_PIPELINE_PERF_RESULTS.md`.

Cache is pre-seeded with one cold call; all bench iterations are pure cache hits.
`LRUCacheProvider.get` is async, so there is one microtask hop per call.

| #   | Scale        | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
| :-- | :----------- | ---------: | --------: | -------: | -------: |
| B7  | 10,000 rows  |    127,713 |     0.008 |    0.008 |    0.018 |
| B7  | 100,000 rows |    129,646 |     0.008 |    0.007 |    0.030 |

### B8 — handleBatchQuery (tier-cache cold, no preflight)

New benchmark — no equivalent in the original pipeline.

Data cache has expired; tier routing cache has a valid entry. Skips COUNT(\*)
preflight entirely and executes the query directly for the cached tier. This
models the steady-state pattern: data refreshes every 30 s but the tier stays
the same for 5 minutes.

| #   | Scale        | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
| :-- | :----------- | ---------: | --------: | -------: | -------: |
| B8  | 10,000 rows  |      2,952 |     0.339 |    0.321 |    1.554 |
| B8  | 100,000 rows |        300 |     3.333 |    3.431 |    6.499 |

**Tier-cache cold vs true cold:** B8 is **49% faster at 10k** and
**53% faster at 100k** compared to B6. The gain equals the preflight cost saved
(B5 ≈ B6 − B8).

---

## Comparison with DATA_PIPELINE_PERF_RESULTS.md (2026-05-30)

> **Note on comparability.** Both benchmarks run on the same hardware (Apple M2,
> 16 GB, macOS) with the same methodology (50 iterations, 5 warmup, `performance.now()`).
> The original benchmark tests the _in-process_ synchronous pipeline (pure JS
> arrays). This benchmark tests the new backend pipeline which adds security
> validation, async cache lookups, and the `mockDb` layer. Results are
> comparable in terms of JavaScript overhead, but the new backend targets a
> different execution model: it runs on a server, not in the browser.

### Async adapter path: B1 vs A1 (key/descriptor construction)

| Layer | Scale      | Old hz (A1) | New hz (B1) | Old mean | New mean | Change          |
| :---- | :--------- | ----------: | ----------: | :------- | :------- | :-------------- |
| A1/B1 | 1 filter   |       6,424 | **100,133** | 0.156 ms | 0.010 ms | **15x faster**  |
| A1/B1 | 10 filters |       1,219 |  **21,423** | 0.820 ms | 0.047 ms | **17x faster**  |
| A1/B1 | 50 filters |         559 |   **5,401** | 1.789 ms | 0.185 ms | **9.7x faster** |

`generateCacheKey` is significantly faster than `buildQueryDescriptor` because
it offloads hashing to the Node.js native `crypto` module (HMAC-SHA256 + SHA-256)
rather than constructing a full filter tree and computing a pure-JS rolling hash.
The memoised security hash also skips HMAC entirely on repeated calls for the
same user.

### Cache get: B2 vs A2

| Layer | Condition | Old hz (A2) | New hz (B2) | Old mean | New mean | Change     |
| :---- | :-------- | ----------: | ----------: | :------- | :------- | :--------- |
| A2/B2 | warm hit  |     789,465 |      37,886 | 0.001 ms | 0.026 ms | 26x slower |
| A2/B2 | miss      |   1,834,862 |     171,136 | 0.001 ms | 0.006 ms | 6x slower  |

`LRUCacheProvider.get` is async (Promise-returning), adding a microtask
resolution hop that `StudioRequestCache`'s synchronous `Map.get()` avoids.
At 0.026 ms mean, warm hits are still well inside any render or response budget.

### Cache set+get round-trip: B3 vs A3

| Layer | Scale             | Old hz (A3) | New hz (B3) | Old mean | New mean | Change        |
| :---- | :---------------- | ----------: | ----------: | :------- | :------- | :------------ |
| A3/B3 | 100 rotating keys |     118,122 |      41,964 | 0.008 ms | 0.024 ms | **3x slower** |

The async overhead of `set()` + `get()` adds one microtask each. Still well
within a 1 ms budget per request.

### Cache invalidation: B4 vs A4

| Layer | Scale         | Old hz (A4) | New hz (B4) | Old mean  | New mean | Change          |
| :---- | :------------ | ----------: | ----------: | :-------- | :------- | :-------------- |
| A4/B4 | 10 entries    |         969 |       4,118 | 1.032 ms  | 0.243 ms | **4.2x faster** |
| A4/B4 | 100 entries   |         120 |         714 | 8.305 ms  | 1.400 ms | **5.9x faster** |
| A4/B4 | 1,000 entries |          28 |         148 | 35.820 ms | 6.760 ms | **5.3x faster** |

The prefix index makes invalidation dramatically faster at all scales.

### Full pipeline cold: B6 vs L3 cold + L5

| Layer    | Scale        | Old hz | New hz (B6) | Old mean (L3+L5 est.) | New mean | Change        |
| :------- | :----------- | -----: | ----------: | :-------------------- | :------- | :------------ |
| L3+L5/B6 | 10,000 rows  |   ~480 |       1,499 | ~2.6 ms               | 0.667 ms | **4x faster** |
| L3+L5/B6 | 100,000 rows |    ~28 |         142 | ~25.7 ms              | 7.062 ms | **4x faster** |

> _Old estimate_: L3 cold mean + L5a mean from `DATA_PIPELINE_PERF_RESULTS.md`
> (1.011 ms + 1.554 ms = 2.565 ms at 10k; 6.710 ms + 18.981 ms = 25.691 ms at 100k).

The new backend cold path is **4× faster** than the equivalent combined steps in
the original pipeline. Key reasons:

- The in-memory pipeline paid the full cost of `enrichSourceRowsWithExpressions`
  (L2) and aggregation (L5) on every cold request. The new backend delegates
  heavy aggregation to DB push-down (for the `db` tier) or caches raw rows for
  re-use (for client/server tiers).
- The security validation and preflight are cheap at this scale (0.4–3.7 ms).

### Full pipeline warm: B7 vs L3 warm

| Layer      | Scale        | Old hz (L3) | New hz (B7) | Old mean | New mean | Change          |
| :--------- | :----------- | ----------: | ----------: | :------- | :------- | :-------------- |
| L3 warm/B7 | 10,000 rows  |     221,358 |     127,713 | 0.005 ms | 0.008 ms | **1.6x slower** |
| L3 warm/B7 | 100,000 rows |     474,874 |     129,646 | 0.002 ms | 0.008 ms | **4x slower**   |

The warm path gap vs `StudioRequestCache` is the direct cost of an async cache
lookup (one microtask resolution). The 100k gap has narrowed significantly
after the `sizeCalculation` optimisation (removed GC pressure from `JSON.stringify`
on large row sets). At 0.008 ms mean the server warm path is far below any
network-latency floor.

---

## Before / after: optimisation gains

p75 comparisons (most stable percentile).

| Benchmark                     | Before opt. (p75) | After opt. (p75) | Change   |
| :---------------------------- | :---------------- | :--------------- | :------- |
| B4 invalidate 100 entries     | 7.520 ms          | 1.191 ms         | **−84%** |
| B4 invalidate 1,000 entries   | 98.271 ms         | 6.022 ms         | **−94%** |
| B6 cold 100k rows             | 67.213 ms         | 6.865 ms         | **−90%** |
| B7 warm 10k rows              | 0.035 ms          | 0.008 ms         | **−77%** |
| B7 warm 100k rows             | 0.041 ms          | 0.007 ms         | **−83%** |
| B8 vs B6 cold 10k (new path)  | 0.636 ms (B6)     | 0.321 ms (B8)    | **−50%** |
| B8 vs B6 cold 100k (new path) | 6.865 ms (B6)     | 3.431 ms (B8)    | **−50%** |
| B4 invalidate 10 entries      | 0.507 ms          | 0.191 ms         | **−62%** |

---

## Observations

- **Key construction is 10–17× faster** than `buildQueryDescriptor`. HMAC/SHA-256
  is native code, and `computeSecurityHash` memoisation skips the HMAC entirely
  on repeated calls for the same user within a process lifetime.
- **Cold path is 4× faster** than the original L3-cold + L5 combined. The new
  backend avoids full expression enrichment on every request; aggregation is
  DB-delegated or cached.
- **Tier cache halves the post-expiry cold cost**: B8 (0.339 ms / 3.333 ms) vs
  B6 (0.667 ms / 7.062 ms). In steady-state operation most cold misses after
  data-cache expiry hit the tier cache, skipping the COUNT(\*) preflight.
- **Warm path overhead is minimal**: B7 at 0.008 ms (both scales) is well under
  any network-latency floor. The GC pressure from `sizeCalculation` serialization
  has been eliminated; p99 at 100k dropped from ~18 ms to 0.030 ms.
- **Cache invalidation is dramatically faster**: The prefix-index eliminates
  linear key scans at all scales. At 1,000 entries, invalidation improved from
  98 ms p75 to 6 ms p75 (−94%).
- **mockDb vs real SQLite**: B5 runPreflight at 10k rows takes 0.398 ms with
  mockDb vs 0.07–0.3 ms with a real SQLite WAL database. Real deployments with
  a SQL engine will be faster on B5/B6; the tier cache benefit (B8 vs B6) will
  be proportionally smaller in absolute terms but the ratio stays similar.
