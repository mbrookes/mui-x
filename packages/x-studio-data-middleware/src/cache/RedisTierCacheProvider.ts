/**
 * Redis-backed tier cache provider for @mui/x-studio-data-middleware.
 *
 * Implements `TierCacheProvider` using any Redis-compatible client.
 * Use this in multi-node or serverless deployments where `MapTierCacheProvider`
 * (in-process only) would give each node an isolated tier cache, meaning every
 * node would still run a COUNT(*) preflight after the data cache expires.
 *
 * ## Supported clients
 *
 * Accepts any object that conforms to the minimal `RedisClient` interface
 * (same interface used by `RedisCacheProvider`) — compatible with both
 * `ioredis` and `node-redis` (v4+) without requiring either as a peer dep.
 * As with `RedisCacheProvider`, the constructor detects (or accepts an
 * explicit `clientStyle` override for) which `SET key value EX seconds` shape
 * the client expects: ioredis's positional form vs node-redis v4's
 * `{ EX: seconds }` options object.
 *
 * ### ioredis
 * ```ts
 * import Redis from 'ioredis';
 * import { RedisTierCacheProvider } from '@mui/x-studio-data-middleware';
 *
 * const redis = new Redis({ host: 'localhost', port: 6379 });
 * const tierCache = new RedisTierCacheProvider(redis);
 * ```
 *
 * ### node-redis (v4+)
 * ```ts
 * import { createClient } from 'redis';
 * import { RedisTierCacheProvider } from '@mui/x-studio-data-middleware';
 *
 * const redis = await createClient({ url: 'redis://localhost:6379' }).connect();
 * const tierCache = new RedisTierCacheProvider(redis);
 * ```
 *
 * ## TTL
 *
 * This provider's own default, when `set()` is called without an explicit
 * `ttlMs`, is 5 minutes (300 s) — see `defaultTtlSeconds` below. In production
 * this default is rarely exercised: `handler.ts` always calls `set()` with an
 * explicit TTL (its own default is `DEFAULT_TIER_CACHE_TTL_MS`, currently 30
 * seconds, aligned with the data cache). `MapTierCacheProvider`'s in-process
 * equivalent also defaults to 300 s for the same "standalone usage" case.
 * These are three independent knobs (this class's default, the handler's
 * default, `MapTierCacheProvider`'s default) that happen to disagree on paper
 * but rarely matter in practice because the handler's explicit TTL wins.
 *
 * ## Combining with RedisCacheProvider
 *
 * For a fully shared multi-node cache stack, use both — safely, EVEN on one
 * shared Redis client with no `keyPrefix` on either provider:
 * ```ts
 * const dataCache  = new RedisCacheProvider(redis, { defaultTtlSeconds: 30 });
 * const tierCache  = new RedisTierCacheProvider(redis, { defaultTtlSeconds: 300 });
 *
 * await handleBatchQuery(body, claims, {
 *   db,
 *   schemaAllowlist: [...],
 *   cacheProvider:     dataCache,
 *   tierCacheProvider: tierCache,
 * });
 * ```
 * `handleBatchQuery` (`handler.ts`) namespaces the tier plane's key with
 * `TIER_CACHE_KEY_PREFIX` (`'tier:'`, exported from `router/tierDecision.ts`)
 * before ever calling into this provider, so the data-cache entry (key
 * `studio:v1:<tenant>:<sec>:<query>`) and the tier-cache entry (key
 * `tier:studio:v1:<tenant>:<sec>:<query>`) never collide — even sharing one
 * Redis client with no `keyPrefix` on either provider, as above. Without this
 * prefix, an identical key string would let the two planes silently overwrite
 * each other (a `RedisTierCacheProvider` write clobbering the data cache's
 * `CacheEntry`, or vice-versa, and a concurrent reader misparsing one shape as
 * the other). A host that calls THIS provider directly (bypassing `handler.ts`)
 * and shares a Redis client with a `RedisCacheProvider` should still apply a
 * distinguishing `keyPrefix` to one of the two, since the namespacing above is
 * only applied by `handler.ts`, not by this class itself.
 *
 * ## Key format
 *
 * Tier cache keys are derived from `generateCacheKey` output (already HMAC-scoped
 * for tenant/user context). Use `keyPrefix` when sharing one Redis instance
 * across multiple deployments.
 */

import { detectClientStyle, escapeRedisGlob, type RedisClient } from './RedisCacheProvider';
import { scanKeys as scanKeysCompat, setEx } from './redisCompat';
import type { TierCacheProvider, TierEntry } from './types';

export interface RedisTierCacheProviderOptions {
  /**
   * Default TTL in seconds for `set()` calls that don't specify one.
   * Should be longer than the data cache TTL so that cold data-cache misses
   * within the tier window skip the COUNT(*) preflight.
   * @default 300
   */
  defaultTtlSeconds?: number;
  /**
   * Optional key prefix applied to every Redis key.
   * Useful when sharing one Redis instance across multiple deployments.
   * @example 'studio:prod:tier:'
   */
  keyPrefix?: string;
  /**
   * Force a specific client wire convention instead of auto-detecting it from
   * the shape of the injected client (see `RedisCacheProvider`'s option of the
   * same name for details).
   */
  clientStyle?: 'ioredis' | 'node-redis';
  /** Number of keys requested per SCAN iteration. @default 1000 */
  scanCount?: number;
}

export class RedisTierCacheProvider implements TierCacheProvider {
  private readonly redis: RedisClient;

  private readonly defaultTtl: number;

  private readonly prefix: string;

  private readonly clientStyle: 'ioredis' | 'node-redis';

  private readonly scanCount: number;

  constructor(redis: RedisClient, options: RedisTierCacheProviderOptions = {}) {
    this.redis = redis;
    this.defaultTtl = options.defaultTtlSeconds ?? 300;
    this.prefix = options.keyPrefix ?? '';
    this.clientStyle = options.clientStyle ?? detectClientStyle(redis);
    this.scanCount = options.scanCount ?? 1000;
  }

  async get(key: string): Promise<TierEntry | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as TierEntry;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: TierEntry, ttlMs?: number): Promise<void> {
    // TierCacheProvider interface uses ttlMs; Redis EX uses seconds.
    const ttlSeconds = ttlMs !== undefined ? Math.max(1, Math.ceil(ttlMs / 1000)) : this.defaultTtl;
    const prefixedKey = this.prefix + key;
    const payload = JSON.stringify(value);
    await setEx(this.redis, this.clientStyle, prefixedKey, payload, ttlSeconds);
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    // Escape Redis glob metacharacters in the literal prefix so a tenant id containing
    // `*`/`?`/`[` can't widen the SCAN glob into a cross-tenant over-eviction — the same
    // fix applied to the data-plane `RedisCacheProvider.invalidatePrefix` (finding 3.1
    // sibling site). The trailing `*` stays the only wildcard; stored key format unchanged.
    const pattern = `${escapeRedisGlob(this.prefix)}${escapeRedisGlob(prefix)}*`;
    const keys = await this.scanKeys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  /** SCAN-based key iteration (never the O(N) blocking KEYS command). */
  private async scanKeys(pattern: string): Promise<string[]> {
    return scanKeysCompat(this.redis, this.clientStyle, pattern, this.scanCount);
  }
}
