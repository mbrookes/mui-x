/**
 * Shared Redis wire-shape compatibility helpers for `RedisCacheProvider` and
 * `RedisTierCacheProvider`.
 *
 * Both providers accept either `ioredis` or `node-redis` (v4+) clients
 * without depending on either as a peer dependency (see `RedisClient` in
 * `./RedisCacheProvider`). The two client families disagree on the exact call
 * shape for a couple of commands this package cares about:
 *
 *   - `SET key value EX seconds` — ioredis takes positional args
 *     (`set(key, value, 'EX', seconds)`); node-redis v4 takes an options
 *     object (`set(key, value, { EX: seconds })`).
 *   - `SCAN cursor MATCH pattern COUNT count` — ioredis returns a
 *     `[cursor, keys]` tuple; node-redis v4 returns `{ cursor, keys }`.
 *
 * `RedisCacheProvider` and `RedisTierCacheProvider` used to each implement
 * their own byte-identical copies of both normalizations (finding 2.1 in
 * `ARCHITECTURE_REVIEW.md`). This module is the single shared implementation;
 * a future client-quirk fix only needs to land here.
 */

import type { RedisClient } from './RedisCacheProvider';

export type RedisClientStyle = 'ioredis' | 'node-redis';

/** `SET key value EX seconds`, adapted to the given client convention. */
export async function setEx(
  redis: RedisClient,
  style: RedisClientStyle,
  key: string,
  value: string,
  seconds: number,
): Promise<void> {
  if (style === 'node-redis') {
    await redis.set(key, value, { EX: seconds });
  } else {
    await redis.set(key, value, 'EX', seconds);
  }
}

/**
 * SCAN-based key iteration (never the O(N) blocking KEYS command), adapted to
 * the given client convention. Falls back to `KEYS` for minimal clients that
 * don't implement `scan`, and to `[]` if neither is available.
 */
export async function scanKeys(
  redis: RedisClient,
  style: RedisClientStyle,
  pattern: string,
  count: number,
): Promise<string[]> {
  if (typeof redis.scan !== 'function') {
    if (typeof redis.keys === 'function') {
      return redis.keys(pattern);
    }
    return [];
  }

  const results: string[] = [];
  let cursor = '0';
  // SCAN cursor iteration is inherently sequential — each call's cursor
  // depends on the previous call's reply, so this cannot be parallelized.
  do {
    let reply: [string, string[]] | { cursor: string | number; keys: string[] };
    if (style === 'node-redis') {
      // eslint-disable-next-line no-await-in-loop
      reply = await redis.scan(cursor, { MATCH: pattern, COUNT: count });
    } else {
      // eslint-disable-next-line no-await-in-loop
      reply = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
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
