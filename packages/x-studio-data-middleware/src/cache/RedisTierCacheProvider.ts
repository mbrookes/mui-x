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
 * The default TTL is 5 minutes (300 s). Override per-call via the `ttlMs`
 * argument on `set()`, or set a different default in the constructor options.
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

import type { RedisClient } from './RedisCacheProvider';
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
}

export class RedisTierCacheProvider implements TierCacheProvider {
  private readonly redis: RedisClient;
  private readonly defaultTtl: number;
  private readonly prefix: string;

  constructor(redis: RedisClient, options: RedisTierCacheProviderOptions = {}) {
    this.redis = redis;
    this.defaultTtl = options.defaultTtlSeconds ?? 300;
    this.prefix = options.keyPrefix ?? '';
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
    await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    const pattern = `${this.prefix}${prefix}*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
