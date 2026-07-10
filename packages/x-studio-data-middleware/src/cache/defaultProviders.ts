/**
 * Lazily-instantiated, module-singleton default cache providers.
 *
 * Shared by BOTH `handleBatchQuery` (read path) and `handleMutation` (write path)
 * so a zero-config host — one that passes no `cacheProvider` to either handler —
 * gets a single, consistent data cache: reads populate it and writes invalidate
 * it (finding 2.2). Previously `getDefaultCache` lived module-private inside
 * `handler.ts`, unreachable from `handleMutation`, so a default-config deployment
 * cached reads but never invalidated them after a mutation — guaranteed staleness
 * for ≤ the data-cache TTL. Centralizing the singletons here makes the two
 * handlers share the exact same instance.
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
