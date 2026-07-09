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
 * Key format: `studio:v1:<encodeURIComponent(tenantId)>:<securityHash>:<queryHash>`
 * (the tenant segment is URL-encoded so a colon in the id cannot shift the segment
 * boundaries — see finding 3.2 in `generateCacheKey`).
 */
import { createHmac, createHash } from 'node:crypto';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from './types';
import { SINGLE_TENANT_POLICY_DIGEST } from './compileSecurityPolicy';
import { sortedStringify } from './canonicalize';

/**
 * Generate a HMAC-SHA256 security hash from the user's row-level claims AND the
 * compiled security-policy digest.
 *
 * Two users with identical row-level permissions served by nodes running the
 * identical security policy share the same hash (and thus share cache entries) —
 * intentionally, for cache efficiency. Folding the `policyDigest` in means two
 * nodes running DIFFERENT `securityColumns` config (e.g. mid-rollout, tightening
 * a `perTable` scope) produce different hashes, so one node can never serve its
 * cached rows to the other node's differently-scoped requests (Gap B).
 *
 * Result is memoized: the security profile only changes when tenantId,
 * regionIds, department, or the policy digest change, so repeated calls for the
 * same user within a request (or across requests from the same user) pay the
 * HMAC cost at most once per unique permission set per process lifetime.
 * The memo map is bounded to MAX_MEMO_SIZE entries to prevent unbounded growth.
 */
const securityHashMemo = new Map<string, string>();
const MAX_MEMO_SIZE = 1_000;

function computeSecurityHash(
  claims: JwtSecurityClaims,
  hmacSecret: string,
  policyDigest: string,
): string {
  const securityProfile = sortedStringify({
    tenantId: claims.tenantId,
    regionIds: claims.regionIds ? [...claims.regionIds].sort((a, b) => a - b) : undefined,
    department: claims.department,
    policyDigest,
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
 *
 * Object keys are recursively sorted so property insertion order never affects
 * the hash. Array element order is preserved and therefore IS significant — two
 * descriptors whose `filters` differ only in order produce different keys.
 */
function computeQueryHash(descriptor: BatchWidgetDescriptor): string {
  // Exclude the widget `id` so two widgets with an identical query shape share a key.
  const queryShape: Record<string, unknown> = { ...descriptor };
  delete queryShape.id;
  return createHash('sha256').update(sortedStringify(queryShape)).digest('hex').slice(0, 16);
}

/**
 * Generate the final server-side cache key for a widget query.
 *
 * @param claims - Verified security claims from extractSecurityClaims()
 * @param descriptor - The widget query descriptor from the batch request
 * @param hmacSecret - Server-side HMAC secret (from environment, never from client)
 * @param policyDigest - Digest of the compiled security policy in force
 *   (`CompiledSecurityPolicy.digest`). Folds the row-level-security POLICY — not
 *   just the caller's claims — into the key so differently-scoped nodes never
 *   share cache entries. Defaults to the single-tenant policy digest so direct
 *   callers (e.g. unit tests) that don't pass one stay deterministic and match a
 *   single-tenant deployment.
 */
export function generateCacheKey(
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  hmacSecret: string = process.env.CACHE_HMAC_SECRET ?? process.env.JWT_SECRET ?? '',
  policyDigest: string = SINGLE_TENANT_POLICY_DIGEST,
): string {
  if (!hmacSecret) {
    throw new Error(
      'MUI X Studio Server: No cache HMAC secret is configured. ' +
        'With an empty key the security hash is guessable, breaking the "a client cannot forge another tenant\'s cache key" guarantee. ' +
        'Set CACHE_HMAC_SECRET (or JWT_SECRET) or pass an explicit secret to generateCacheKey().',
    );
  }
  const securityHash = computeSecurityHash(claims, hmacSecret, policyDigest);
  const queryHash = computeQueryHash(descriptor);
  // Encode the tenant segment so a `tenantId` containing ':' cannot corrupt the
  // segment boundaries that prefix-based invalidation relies on (finding 3.2).
  // `LRUCacheProvider.extractPrefix` recovers the tenant-scoped invalidation
  // prefix by scanning to the 3rd colon; a raw `org:1234` would shift every
  // boundary (deriving `studio:v1:org:` instead of `studio:v1:org:1234:`) and
  // collapse distinct colon-prefixed tenants into ONE eviction bucket.
  // `encodeURIComponent` maps ':' to '%3A', keeping the tenant a single colon-free
  // segment so the boundary scan stays exact. Tenant ids without a colon (the
  // common case, e.g. `acme`) are unchanged, so existing keys are byte-identical.
  const tenantSegment = encodeURIComponent(claims.tenantId);
  return `studio:v1:${tenantSegment}:${securityHash}:${queryHash}`;
}
