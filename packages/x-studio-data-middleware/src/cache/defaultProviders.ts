/**
 * Lazily-instantiated, module-singleton default cache providers.
 *
 * Shared by BOTH `handleBatchQuery` (read path) and `handleMutation` (write path)
 * so a zero-config host — one that passes no `cacheProvider` to either handler —
 * gets a single, consistent data cache: reads populate it and writes invalidate
 * it. Previously `getDefaultCache` lived module-private inside
 * `handler.ts`, unreachable from `handleMutation`, so a default-config deployment
 * cached reads but never invalidated them after a mutation — guaranteed staleness
 * for ≤ the data-cache TTL. Centralizing the singletons here makes the two
 * handlers share the exact same instance.
 *
 * PROCESS-WIDE, ACROSS OPTION SETS. "Zero-config" is per CALL, not per
 * data source: every `handleBatchQuery`/`handleMutation` invocation in the process
 * that omits `cacheProvider` lands on this ONE `LRUCacheProvider`, including calls
 * made with different `db` connections. Separation therefore has to come from the
 * KEY, not from the instance. It does, on two axes: the compiled policy digest
 * folded into every key now includes the request's `schemaAllowlist`, so two option
 * sets exposing different tables never collide; and `HandleBatchQueryOptions.cacheScope`
 * separates the remaining case of two data sources with identical schemas. A host
 * that wants hard isolation (separate memory budgets, independent eviction) still
 * passes its own provider per data source.
 */
import { LRUCacheProvider } from './LRUCacheProvider';
import { MapTierCacheProvider } from './MapTierCacheProvider';
import type { CacheProvider, TierCacheProvider } from './types';

let defaultCache: CacheProvider | undefined;
let defaultTierCache: TierCacheProvider | undefined;

/** The process-wide default data cache used when a host passes no `cacheProvider`. */
export function getDefaultCache(): CacheProvider {
  if (!defaultCache) {
    defaultCache = new LRUCacheProvider();
  }
  return defaultCache;
}

/** The process-wide default tier cache used when a host passes no `tierCacheProvider`. */
export function getDefaultTierCache(): TierCacheProvider {
  if (!defaultTierCache) {
    defaultTierCache = new MapTierCacheProvider();
  }
  return defaultTierCache;
}
