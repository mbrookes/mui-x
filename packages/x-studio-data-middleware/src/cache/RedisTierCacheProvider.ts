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
 * For a fully shared multi-node cache stack, use both:
 * ```ts
 * const dataCache  = new RedisCacheProvider(redis, { defaultTtlSeconds: 30 });
 * const tierCache  = new RedisTierCacheProvider(redis, { defaultTtlSeconds: 300 });
 *
 * await handleBatchQuery(payload, {
 *   db,
 *   allowedTables: [...],
 *   cacheProvider:     dataCache,
 *   tierCacheProvider: tierCache,
 * });
 * ```
 *
 * ## Key format
 *
 * Tier cache keys are derived from `generateCacheKey` output (already HMAC-scoped
 * for tenant/user context). Use `keyPrefix` when sharing one Redis instance
 * across multiple deployments.
 */

import { detectClientStyle, type RedisClient } from './RedisCacheProvider';
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
    if (this.clientStyle === 'node-redis') {
      await this.redis.set(prefixedKey, payload, { EX: ttlSeconds });
    } else {
      await this.redis.set(prefixedKey, payload, 'EX', ttlSeconds);
    }
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    const pattern = `${this.prefix}${prefix}*`;
    const keys = await this.scanKeys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  /** SCAN-based key iteration (never the O(N) blocking KEYS command). */
  private async scanKeys(pattern: string): Promise<string[]> {
    if (typeof this.redis.scan !== 'function') {
      // Fallback for minimal clients that only implement KEYS.
      if (typeof this.redis.keys === 'function') {
        return this.redis.keys(pattern);
      }
      return [];
    }

    const results: string[] = [];
    let cursor = '0';
    // SCAN cursor iteration is inherently sequential — each call's cursor
    // depends on the previous call's reply, so this cannot be parallelized.
    do {
      let reply: [string, string[]] | { cursor: string | number; keys: string[] };
      if (this.clientStyle === 'node-redis') {
        // eslint-disable-next-line no-await-in-loop
        reply = await this.redis.scan(cursor, { MATCH: pattern, COUNT: this.scanCount });
      } else {
        // eslint-disable-next-line no-await-in-loop
        reply = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount);
      }
      if (Array.isArray(reply)) {
        [cursor] = reply;
        results.push(...reply[1]);
      } else {
        cursor = String(reply.cursor);
        results.push(...reply.keys);
      }
    } while (cursor !== '0');
    return results;
  }
}
