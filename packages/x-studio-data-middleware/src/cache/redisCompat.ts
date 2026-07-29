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
 * their own byte-identical copies of both normalizations (finding 2.1). This
 * module is the single shared implementation; a future client-quirk fix only
 * needs to land here.
 *
 * The two providers' `get()` methods went through the same consolidation
 * (Tier2 finding): fetch the raw string, treat a falsy reply as a miss,
 * `JSON.parse` it (treating a parse failure as a miss too), shape-guard the
 * parsed value, and warn once when the shape guard rejects it. `readShapedEntry`
 * below is that shared SEQUENCE; each provider still supplies its own shape
 * guard (`isCacheEntryShape` / `isTierEntryShape`) and its own warn-once
 * callback, since the warning's wording and per-instance "have I already
 * warned" state are provider-specific, not part of the shared algorithm.
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
 * Read one Redis key and decode it into a shape-checked `T`, or `undefined` on
 * any of: a missing/empty reply, a JSON parse failure, or a value that parses
 * but fails `guard` — the shared parse+shape-check+dispatch sequence
 * `RedisCacheProvider.get` and `RedisTierCacheProvider.get` used to each
 * reimplement (Tier2 finding).
 *
 * A structurally invalid stored value (a keyspace collision with another
 * writer, a partially-written entry, …) is deliberately treated the SAME as a
 * cache miss rather than surfaced as an error — both callers degrade to
 * re-fetching from the source of truth (the database) on a miss, which is
 * exactly the right behavior for a value this provider cannot trust.
 * `warnOnce` is called so the condition is still observable, but only once per
 * caller-defined scope (each provider tracks that per its own instance).
 *
 * @param redis - The Redis client to read from.
 * @param prefix - The provider's configured key prefix, prepended to `key`
 *   before the read (mirrors both providers' own `this.prefix + key`).
 * @param key - The UNPREFIXED cache key, also passed to `warnOnce` unprefixed
 *   so each provider's own warning can format it (with its own prefix) however
 *   it already does.
 * @param guard - The provider's own shape predicate (`isCacheEntryShape` /
 *   `isTierEntryShape`), deciding whether the parsed value is a `T`.
 * @param warnOnce - The provider's own once-per-instance warning callback,
 *   invoked with `key` when `guard` rejects a parsed value. Never called for a
 *   missing reply or a JSON parse failure — only a value that WAS valid JSON
 *   but the wrong shape is worth flagging as a likely keyspace collision.
 */
export async function readShapedEntry<T>(
  redis: RedisClient,
  prefix: string,
  key: string,
  guard: (value: unknown) => value is T,
  warnOnce: (key: string) => void,
): Promise<T | undefined> {
  const raw = await redis.get(prefix + key);
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!guard(parsed)) {
    warnOnce(key);
    return undefined;
  }
  return parsed;
}
