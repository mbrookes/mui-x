# x-studio Pipeline Benchmark Results

Run the benchmarks with:

```bash
pnpm --filter "@mui/x-studio" bench
```

---

## Run: 2026-05-30

**Machine:** Apple M2, 16 GB RAM, macOS (darwin x64)  
**Node:** tsx (ESM, no JIT warm-up exclusion)  
**Iterations:** 50 per benchmark (5 warmup)

### Pipeline layers — 10 k rows

| # | Layer | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
|---|-------|-----------|-----------|----------|----------|
| L1 | normalizeDataSourceRows | 82 | 12.147 | 11.941 | 60.609 |
| L1 | getCachedNormalizedDataSource (warm) | 501,902 | 0.002 | 0.001 | 0.014 |
| L2 | enrichRowsWithExpressions | 34 | 29.848 | 33.904 | 87.080 |
| L2 | getCachedEnrichedRows (warm) | 118,320 | 0.008 | 0.005 | 0.072 |
| L3 | resolveRows (cold) | 989 | 1.011 | 1.116 | 7.086 |
| L3 | resolveRowsCached (warm) | 221,358 | 0.005 | 0.003 | 0.022 |
| L4 | resolveChartRows (cold) | 76,263 | 0.013 | 0.011 | 0.061 |
| L4 | resolveChartRows (warm) | 25,503 | 0.039 | 0.011 | 1.214 |
| L5a | aggregateByField | 643 | 1.554 | 1.381 | 6.063 |
| L5b | aggregateByTwoFields | 309 | 3.241 | 3.324 | 21.083 |
| L5c | aggregateMultipleSeries | 321 | 3.116 | 3.548 | 14.589 |

### Pipeline layers — 100 k rows

| # | Layer | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
|---|-------|-----------|-----------|----------|----------|
| L1 | normalizeDataSourceRows | 6 | 161.903 | 185.915 | 509.340 |
| L1 | getCachedNormalizedDataSource (warm) | 2,146,844 | 0.000 | 0.000 | 0.002 |
| L2 | enrichRowsWithExpressions | 3 | 381.110 | 401.069 | 1293.253 |
| L2 | getCachedEnrichedRows (warm) | 394,086 | 0.003 | 0.003 | 0.004 |
| L3 | resolveRows (cold) | 149 | 6.710 | 8.099 | 23.739 |
| L3 | resolveRowsCached (warm) | 474,874 | 0.002 | 0.002 | 0.003 |
| L4 | resolveChartRows (cold) | 128,151 | 0.008 | 0.007 | 0.060 |
| L4 | resolveChartRows (warm) | 155,582 | 0.006 | 0.006 | 0.008 |
| L5a | aggregateByField | 53 | 18.981 | 17.237 | 112.776 |
| L5b | aggregateByTwoFields | 43 | 22.997 | 25.680 | 89.385 |
| L5c | aggregateMultipleSeries | 38 | 26.442 | 30.559 | 49.764 |

### Async adapter path

| # | Layer | Scale | hz (ops/s) | mean (ms) | p75 (ms) | p99 (ms) |
|---|-------|-------|-----------|-----------|----------|----------|
| A1 | buildQueryDescriptor | 1 filter | 6,424 | 0.156 | 0.029 | 6.105 |
| A1 | buildQueryDescriptor | 10 filters | 1,219 | 0.820 | 0.126 | 34.499 |
| A1 | buildQueryDescriptor | 50 filters | 559 | 1.789 | 0.851 | 20.165 |
| A2 | cache.get (warm hit) | N/A | 789,465 | 0.001 | 0.001 | 0.014 |
| A2 | cache.get (miss) | N/A | 1,834,862 | 0.001 | 0.000 | 0.003 |
| A3 | cache set+get (100 rotating keys) | N/A | 118,122 | 0.008 | 0.008 | 0.032 |
| A4 | invalidateSource | 10 entries | 969 | 1.032 | 0.292 | 18.245 |
| A4 | invalidateSource | 100 entries | 120 | 8.305 | 7.637 | 98.174 |
| A4 | invalidateSource | 1,000 entries | 28 | 35.820 | 35.647 | 167.773 |

### Observations

- **Caches are effective**: All cached layers (L1–L3 warm) are 1000–100,000× faster than cold. The caching strategy is working well.
- **L2 enrichRowsWithExpressions is the bottleneck** at 100 k rows (381 ms cold, but 0.003 ms warm — cache hit rate in practice is very high since expression fields rarely change).
- **L5 aggregation** scales linearly: ~19 ms at 100 k rows for a single-field group-by. Typical dashboards have 20–50 k rows so this is comfortably under the 50 ms frame budget.
- **A4 invalidateSource** at 1,000 cache entries takes ~36 ms — acceptable since invalidation is rare (data reload events), but worth monitoring if cache entry counts grow.
- **A1 buildQueryDescriptor** stays under 2 ms even with 50 filters — well within the synchronous render budget.
