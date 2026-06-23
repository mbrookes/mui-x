/**
 * In-process LRU cache provider using the `lru-cache` package.
 *
 * Suitable for single-node deployments. For multi-node (horizontally scaled)
 * deployments, use a Redis-backed provider instead.
 *
 * lru-cache v10+ API note:
 *   - Named export: `import { LRUCache } from 'lru-cache'` (NOT default export)
 *   - Size-based eviction: `maxSize` in bytes + `sizeCalculation` callback
 *
 * Performance notes:
 *   - sizeCalculation uses a fast per-row byte estimate instead of JSON.stringify
 *     to avoid O(N) serialization on every cache write.
 *   - A secondary prefix index keeps invalidatePrefix() at O(N_matched) instead
 *     of scanning all keys. The index is kept in sync via the `dispose` callback.
 */
import { LRUCache } from 'lru-cache';
import type { CacheEntry, CacheProvider, CacheSetOpts } from './types';

interface LRUCacheProviderOptions {
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
  /**
   * Average serialized byte size per row, used for fast size estimation.
   * Default: 512. Tune upward for schemas with large text/blob columns.
   */
  avgBytesPerRow?: number;
}

export class LRUCacheProvider implements CacheProvider {
  private cache: LRUCache<string, CacheEntry>;

  /**
   * Secondary index for fast prefix invalidation.
   * Maps the tenant-scoped key prefix (e.g. "studio:v1:acme:") to the set
   * of full cache keys that share it. Kept in sync via the `dispose` callback.
   */
  private prefixIndex = new Map<string, Set<string>>();

  /**
   * Tag-based invalidation index (tag → Set<cacheKey>).
   * Populated at write time when `opts.tags` is provided.
   * Enables O(tagged entries) bulk eviction via `deleteByTag`.
   */
  private tagIndex = new Map<string, Set<string>>();

  /**
   * Reverse tag index (cacheKey → Set<tag>).
   * Used by the `dispose` callback to clean up `tagIndex` on eviction without
   * scanning every tag — O(tags on this key) instead of O(all tags).
   */
  private keyTags = new Map<string, Set<string>>();

  constructor(options: LRUCacheProviderOptions = {}) {
    const { maxSizeBytes = 128 * 1024 * 1024, ttlMs = 30_000, avgBytesPerRow = 512 } = options;

    this.cache = new LRUCache<string, CacheEntry>({
      maxSize: maxSizeBytes,
      ttl: ttlMs,
      allowStale: false,
      updateAgeOnGet: true,
      // Fast O(1) size estimate — avoids full JSON.stringify on every write.
      // Accurate enough for LRU eviction purposes; tune avgBytesPerRow if needed.
      sizeCalculation: (value: CacheEntry) => value.rows.length * avgBytesPerRow + 64,
      // Keep all secondary indexes in sync when LRU evicts or deletes entries.
      dispose: (_, key) => {
        // Prefix index cleanup
        const prefix = this.extractPrefix(key);
        const prefixKeys = this.prefixIndex.get(prefix);
        if (prefixKeys) {
          prefixKeys.delete(key);
          if (prefixKeys.size === 0) {
            this.prefixIndex.delete(prefix);
          }
        }
        // Tag index cleanup — O(tags on this key), not O(all tags)
        const ownTags = this.keyTags.get(key);
        if (ownTags) {
          for (const tag of ownTags) {
            const tagKeys = this.tagIndex.get(tag);
            if (tagKeys) {
              tagKeys.delete(key);
              if (tagKeys.size === 0) {
                this.tagIndex.delete(tag);
              }
            }
          }
          this.keyTags.delete(key);
        }
      },
    });
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    return this.cache.get(key);
  }

  async set(key: string, value: CacheEntry, opts?: CacheSetOpts): Promise<void> {
    this.cache.set(key, value, opts?.ttlMs !== undefined ? { ttl: opts.ttlMs } : undefined);

    // Register in prefix index
    const prefix = this.extractPrefix(key);
    let prefixKeys = this.prefixIndex.get(prefix);
    if (!prefixKeys) {
      prefixKeys = new Set<string>();
      this.prefixIndex.set(prefix, prefixKeys);
    }
    prefixKeys.add(key);

    // Register in tag index (if tags were provided)
    const tags = opts?.tags;
    if (tags && tags.length > 0) {
      this.keyTags.set(key, new Set(tags));
      for (const tag of tags) {
        let tagKeys = this.tagIndex.get(tag);
        if (!tagKeys) {
          tagKeys = new Set<string>();
          this.tagIndex.set(tag, tagKeys);
        }
        tagKeys.add(key);
      }
    }
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    const indexed = this.prefixIndex.get(prefix);
    if (indexed) {
      // O(N_matched) — only visits keys that actually share this prefix.
      // The dispose callback keeps the index up to date, so this is safe.
      for (const key of [...indexed]) {
        this.cache.delete(key);
      }
    } else {
      // Fallback: prefix not in index (e.g. custom prefix that bypasses set()).
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    }
  }

  async deleteByTag(tag: string): Promise<void> {
    const keys = this.tagIndex.get(tag);
    if (!keys) {
      return;
    }
    // Snapshot before iterating — dispose modifies the set during delete
    for (const key of [...keys]) {
      this.cache.delete(key);
    }
    // tagIndex entry is cleaned up by dispose; force-clear in case of races
    this.tagIndex.delete(tag);
  }

  /**
   * Extract the prefix used for the secondary index.
   *
   * For Studio cache keys ("studio:v1:<tenantId>:<secHash>:<queryHash>") the
   * prefix is "studio:v1:<tenantId>:" — the tenant isolation boundary.
   * For any other key format, falls back to using the full key as its own prefix.
   */
  private extractPrefix(key: string): string {
    // Find the 4th colon (index after "studio:v1:<tenantId>:")
    let colons = 0;
    for (let i = 0; i < key.length; i += 1) {
      if (key[i] === ':') {
        colons += 1;
        if (colons === 3) {
          return key.slice(0, i + 1);
        }
      }
    }
    return key;
  }
}
