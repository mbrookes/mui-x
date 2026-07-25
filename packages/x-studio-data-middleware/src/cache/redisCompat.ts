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
 * Maximum number of keys passed to a SINGLE variadic `DEL` call.
 *
 * `redis.del(...keys)` spreads the array into the argument list, and V8 caps how
 * many arguments a spread/`apply` call may carry (~64k–125k, engine- and
 * stack-dependent). Past that ceiling the call throws
 * `RangeError: Maximum call stack size exceeded` *before Redis is ever
 * contacted* — so an invalidation that looks like it ran actually deleted
 * nothing. That ceiling is reachable in practice: `handleBatchQuery` tags every
 * cached entry with its primary table AND every joined table, so a busy
 * multi-tenant deployment accumulates one forward-index member per
 * (tenant × security profile × query shape) inside a single tag's TTL window,
 * and `handleMutation` swallows the resulting `RangeError` as a best-effort
 * `console.warn` while still reporting `ok: true` — every subsequent read then
 * serves pre-mutation rows for the full TTL.
 *
 * 500 keys per round-trip is well inside every client's argument limit while
 * keeping the number of round-trips (and each command's payload) modest.
 */
export const DEL_BATCH_SIZE = 500;

/**
 * `DEL key [key ...]` over an arbitrarily large key list, issued in fixed-size
 * batches so the variadic call can never exceed the engine's argument limit
 * (see `DEL_BATCH_SIZE`). An empty list issues no command at all — `DEL` with
 * no arguments is a Redis syntax error.
 */
export async function delKeys(
  redis: RedisClient,
  keys: readonly string[],
  batchSize: number = DEL_BATCH_SIZE,
): Promise<void> {
  const size = Math.max(1, batchSize);
  // Batches are inherently sequential here: issuing them concurrently would
  // multiply the in-flight command payload for no correctness gain, and DEL is
  // cheap relative to the round-trip.
  for (let i = 0; i < keys.length; i += size) {
    // eslint-disable-next-line no-await-in-loop
    await redis.del(...keys.slice(i, i + size));
  }
}

/**
 * SCAN-based key iteration (never the O(N) blocking KEYS command), adapted to
 * the given client convention, yielding ONE SCAN page at a time.
 *
 * Streaming rather than accumulating is deliberate: a caller that only wants to
 * delete the matched keys never has to hold the entire matching key set in
 * memory, and it can act on (and free) each page as it arrives. Deleting keys
 * while a SCAN is in flight is safe — Redis's cursor guarantees that every key
 * present for the whole iteration is returned at least once; keys removed
 * mid-iteration simply stop being returned.
 *
 * Falls back to a single `KEYS` page for minimal clients that don't implement
 * `scan`, and yields nothing if neither command is available.
 */
export async function* scanKeyPages(
  redis: RedisClient,
  style: RedisClientStyle,
  pattern: string,
  count: number,
): AsyncGenerator<string[], void, undefined> {
  if (typeof redis.scan !== 'function') {
    if (typeof redis.keys === 'function') {
      // Legacy fallback: `KEYS` has no cursor, so its whole reply is one page.
      yield await redis.keys(pattern);
    }
    return;
  }

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
    let page: string[];
    if (Array.isArray(reply)) {
      [cursor] = reply;
      page = reply[1];
    } else {
      cursor = String(reply.cursor);
      page = reply.keys;
    }
    if (page.length > 0) {
      yield page;
    }
  } while (cursor !== '0');
}

/**
 * Accumulating wrapper over `scanKeyPages` — returns EVERY matching key in one
 * array.
 *
 * Prefer `scanKeyPages` for anything driven by client input or by cache
 * population: the matched set is unbounded, so materializing it whole is a
 * memory spike proportional to the keyspace. This wrapper exists for callers
 * that genuinely need the complete list (and know it is small).
 */
export async function scanKeys(
  redis: RedisClient,
  style: RedisClientStyle,
  pattern: string,
  count: number,
): Promise<string[]> {
  const results: string[] = [];
  for await (const page of scanKeyPages(redis, style, pattern, count)) {
    // `push(...page)` would spread a page (sized by the caller's `scanCount`)
    // into an argument list — the same unbounded-spread class this module exists
    // to avoid. A plain loop has no argument-count ceiling.
    for (const key of page) {
      results.push(key);
    }
  }
  return results;
}
