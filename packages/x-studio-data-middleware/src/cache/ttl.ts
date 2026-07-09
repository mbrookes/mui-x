/**
 * Shared TTL-flooring helper for the in-process cache providers.
 *
 * `lru-cache` treats `{ ttl: 0 }` as "no TTL" — the entry never expires. That is
 * the OPPOSITE of what `ttlMs: 0` means on the Redis-backed providers
 * (`RedisCacheProvider` / `RedisTierCacheProvider`), which floor a `ttlMs: 0`
 * write to a 1-second expiry (`Math.max(1, Math.ceil(ttlMs / 1000))`) rather
 * than send Redis an invalid `EX 0` or treat it as "never expires" — see the
 * "ttlMs: 0" parity test in `RedisCacheProvider.test.ts`.
 *
 * Left unguarded, `LRUCacheProvider` and `MapTierCacheProvider` silently
 * disagreed with their Redis siblings: an entry written with `ttlMs: 0` was
 * IMMORTAL in-process but expired in ~1s against Redis — a footgun for a host
 * that swaps a single-node deployment for a multi-node one (finding 2.1 /
 * ARCHITECTURE_REVIEW.md). `MIN_TTL_MS` matches the Redis floor (1 second) so
 * all four shipped providers agree on what `ttlMs: 0` means.
 */

/** The floor applied to an explicit `ttlMs: 0`, matching the Redis providers' 1-second floor. */
export const MIN_TTL_MS = 1000;

/**
 * Floor an explicit `ttlMs: 0` to `MIN_TTL_MS`.
 *
 * Any other value — including `undefined`, which means "use the provider's
 * configured default", and any non-zero TTL (even sub-second) — passes through
 * unchanged. This only closes the `0` footgun; it does not force a 1-second
 * minimum on a legitimate short TTL.
 */
export function floorTtlMs(ttlMs: number): number;
export function floorTtlMs(ttlMs: number | undefined): number | undefined;
export function floorTtlMs(ttlMs: number | undefined): number | undefined {
  return ttlMs === 0 ? MIN_TTL_MS : ttlMs;
}
