/**
 * Security-aware, deterministic cache key generator.
 *
 * The client-computed `cacheKey` from StudioQueryDescriptor is NOT used for
 * server-side caching because it contains no security dimensions. This function
 * generates a server-side key that is:
 *
 * 1. Tenant-isolated: different tenants never share cache entries
 * 2. Security-hash-scoped: different row-level permissions produce different keys
 * 3. Deterministic: same query + same security context → same key (no clock drift)
 * 4. Opaque to the client: HMAC prevents clients from guessing other users' keys
 *
 * Key format: `studio:v1:<tenantId>:<securityHash>:<queryHash>`
 */
import { createHmac, createHash } from 'node:crypto';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from './types';

/**
 * Generate a HMAC-SHA256 security hash from the user's row-level claims.
 * Two users with identical row-level permissions will share the same hash
 * (and thus share cache entries) — intentionally, for cache efficiency.
 *
 * Result is memoized: the security profile only changes when tenantId,
 * regionIds, or department change, so repeated calls for the same user
 * within a request (or across requests from the same user) pay the HMAC
 * cost at most once per unique permission set per process lifetime.
 * The memo map is bounded to MAX_MEMO_SIZE entries to prevent unbounded growth.
 */
const securityHashMemo = new Map<string, string>();
const MAX_MEMO_SIZE = 1_000;

function computeSecurityHash(claims: JwtSecurityClaims, hmacSecret: string): string {
  const securityProfile = sortedStringify({
    tenantId: claims.tenantId,
    regionIds: claims.regionIds ? [...claims.regionIds].sort((a, b) => a - b) : undefined,
    department: claims.department,
  });

  const memoKey = `${hmacSecret}::${securityProfile}`;
  const cached = securityHashMemo.get(memoKey);
  if (cached !== undefined) {
    return cached;
  }

  const hash = createHmac('sha256', hmacSecret).update(securityProfile).digest('hex').slice(0, 16);

  if (securityHashMemo.size >= MAX_MEMO_SIZE) {
    // Evict the oldest entry (Map insertion order).
    securityHashMemo.delete(securityHashMemo.keys().next().value as string);
  }
  securityHashMemo.set(memoKey, hash);
  return hash;
}

/**
 * Generate a deterministic hash from a widget descriptor (the "query shape").
 * The widget `id` is excluded so two widgets with identical table/columns/filters
 * share the same cache entry — enabling cross-widget deduplication.
 * Keys are recursively sorted so filter order never affects the hash.
 */
function computeQueryHash(descriptor: BatchWidgetDescriptor): string {
  const { id: _id, ...queryShape } = descriptor;
  return createHash('sha256').update(sortedStringify(queryShape)).digest('hex').slice(0, 16);
}

/**
 * Recursively serialize an object with keys sorted alphabetically.
 * This ensures deterministic JSON regardless of property insertion order.
 */
function sortedStringify(obj: unknown): string {
  if (Array.isArray(obj)) {
    return `[${obj.map(sortedStringify).join(',')}]`;
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedStringify((obj as Record<string, unknown>)[k])}`);
    return `{${sorted.join(',')}}`;
  }
  return JSON.stringify(obj);
}

/**
 * Generate the final server-side cache key for a widget query.
 *
 * @param claims - Verified security claims from extractSecurityClaims()
 * @param descriptor - The widget query descriptor from the batch request
 * @param hmacSecret - Server-side HMAC secret (from environment, never from client)
 */
export function generateCacheKey(
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  hmacSecret: string = process.env.CACHE_HMAC_SECRET ?? process.env.JWT_SECRET ?? '',
): string {
  const securityHash = computeSecurityHash(claims, hmacSecret);
  const queryHash = computeQueryHash(descriptor);
  return `studio:v1:${claims.tenantId}:${securityHash}:${queryHash}`;
}
