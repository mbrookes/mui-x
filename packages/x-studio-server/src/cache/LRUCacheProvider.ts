/**
 * In-process LRU cache provider using the `lru-cache` package.
 *
 * Suitable for single-node deployments. For multi-node (horizontally scaled)
 * deployments, use a Redis-backed provider instead.
 *
 * lru-cache v10+ API note:
 *   - Named export: `import { LRUCache } from 'lru-cache'` (NOT default export)
 *   - Size-based eviction: `maxSize` in bytes + `sizeCalculation` callback
 */
import { LRUCache } from 'lru-cache';
import type { CacheEntry, CacheProvider } from './types';

export interface LRUCacheProviderOptions {
  /**
   * Maximum total cache size in bytes.
   * Default: 128 MB. Tune based on available server memory.
   */
  maxSizeBytes?: number;
  /**
   * Default TTL in milliseconds.
   * Default: 30,000ms (30s — matches StudioRequestCache client TTL).
   */
  ttlMs?: number;
}

export class LRUCacheProvider implements CacheProvider {
  private cache: LRUCache<string, CacheEntry>;

  constructor(options: LRUCacheProviderOptions = {}) {
    const { maxSizeBytes = 128 * 1024 * 1024, ttlMs = 30_000 } = options;

    this.cache = new LRUCache<string, CacheEntry>({
      maxSize: maxSizeBytes,
      ttl: ttlMs,
      allowStale: false,
      updateAgeOnGet: true,
      sizeCalculation: (value: CacheEntry) => {
        // Approximate serialized byte size of the cached rows
        return Buffer.byteLength(JSON.stringify(value.rows));
      },
    });
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    return this.cache.get(key);
  }

  async set(key: string, value: CacheEntry, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds !== undefined ? ttlSeconds * 1000 : undefined;
    this.cache.set(key, value, ttl !== undefined ? { ttl } : undefined);
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }
}
