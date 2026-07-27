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
 * The memo map is bounded to MAX_MEMO_SIZE entries to prevent unbounded growth,
 * and evicts least-RECENTLY-USED rather than least-recently-INSERTED — see
 * `touchMemoEntry` (finding L4).
 */
const securityHashMemo = new Map<string, string>();

/**
 * DOMAIN SEPARATION TAG for the cache-key HMAC.
 *
 * The HMAC key defaults to `CACHE_HMAC_SECRET ?? JWT_SECRET`, so in the common
 * zero-extra-config deployment the SAME key that authenticates bearer tokens also
 * derives cache keys — and those keys are written to Redis, appear in logs, and
 * are visible to anyone with cache read access. Prefixing the HMAC input with a
 * fixed, NUL-terminated tag means a cache-key digest and a JWT signature are
 * computed over provably disjoint input spaces, so neither can be used as an
 * oracle for the other under the shared key. The NUL byte cannot appear in the
 * JSON `securityProfile`, so the tag is unambiguous rather than merely a prefix.
 *
 * Changing this string (or the `:v1` suffix) invalidates every existing cache
 * entry — deliberately, since the derivation itself has changed.
 */
const CACHE_KEY_HMAC_DOMAIN = 'mui-x-studio-cache-key:v1\0';

/**
 * Warn ONCE per process when the cache-key HMAC falls back to reusing
 * `JWT_SECRET` (the convenient path — no extra env var to set).
 *
 * Not practically exploitable given the domain separation above, but a key with
 * two purposes is a key whose blast radius on disclosure is two systems, and the
 * fallback is silent. One warning at first use is enough to surface it without
 * becoming log noise.
 */
let warnedAboutJwtSecretReuse = false;

/**
 * Entry ceiling for `securityHashMemo`. Exported for tests only — it is not
 * re-exported from the package root, so it is not public API.
 */
export const SECURITY_HASH_MEMO_MAX_SIZE = 1_000;

/**
 * Move `memoKey` to the END of the memo's insertion order, making it the LAST
 * candidate for eviction (finding L4).
 *
 * Eviction picks `securityHashMemo.keys().next().value` — the oldest-INSERTED
 * key. A `Map` only updates a key's position on insertion, never on a `get`, so
 * without this the memo evicted FIFO, not LRU: once full, a stream of cold
 * one-off security profiles evicted the HOTTEST tenant's entry on every miss
 * (its insertion is by definition the oldest), so the HMAC was recomputed on
 * essentially every request while the memo stayed full of cold entries.
 * Deleting and re-setting on a HIT re-appends the key, so the eviction order
 * tracks recency of USE. Performance only — the computed hash is identical
 * either way.
 */
function touchMemoEntry(memoKey: string, hash: string): void {
  securityHashMemo.delete(memoKey);
  securityHashMemo.set(memoKey, hash);
}

function computeSecurityHash(
  claims: JwtSecurityClaims,
  hmacSecret: string,
  policyDigest: string,
  cacheScope: string | undefined,
): string {
  const securityProfile = sortedStringify({
    tenantId: claims.tenantId,
    regionIds: claims.regionIds ? [...claims.regionIds].sort((a, b) => a - b) : undefined,
    department: claims.department,
    // `policyDigest` also carries the request's `schemaAllowlist` (finding 3), so
    // two option sets pointed at different logical databases separate on their table
    // sets alone — no host configuration required for the common case.
    policyDigest,
    // Fold in the host-provided cache scope (finding 2.4) for the case the table
    // sets do NOT distinguish: two databases with identical schemas in ONE process
    // would otherwise collide on the same (claims, policy, query) key and serve
    // DB-A's rows for DB-B. Included via a conditional spread so an omitted scope
    // keeps the profile — and therefore every existing key — byte-identical
    // (fully backward compatible).
    ...(cacheScope !== undefined && { cacheScope }),
  });

  const memoKey = `${hmacSecret}::${securityProfile}`;
  const cached = securityHashMemo.get(memoKey);
  if (cached !== undefined) {
    // Re-append on a HIT so this key becomes the most-recently-USED, not merely
    // the most-recently-inserted (finding L4) — otherwise eviction is FIFO and
    // repeatedly discards the hottest profile.
    touchMemoEntry(memoKey, cached);
    return cached;
  }

  // Domain-separate the derivation — see `CACHE_KEY_HMAC_DOMAIN`.
  const hash = createHmac('sha256', hmacSecret)
    .update(CACHE_KEY_HMAC_DOMAIN + securityProfile)
    .digest('hex')
    .slice(0, 16);

  if (securityHashMemo.size >= SECURITY_HASH_MEMO_MAX_SIZE) {
    // Evict the LEAST-RECENTLY-USED entry — the first key in insertion order,
    // which `touchMemoEntry` keeps in sync with recency of use.
    securityHashMemo.delete(securityHashMemo.keys().next().value as string);
  }
  touchMemoEntry(memoKey, hash);
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
  // Canonicalize the case-insensitive SQL tokens that `buildPlan` lowercases onto the
  // PLAN — `join[].type` and `orderBy[].direction` — so a case-varying-but-equivalent
  // descriptor (`LEFT`/`left`, `ASC`/`asc`) hashes to the SAME key instead of
  // fragmenting the cache (finding T3.4). Both are normalized on hash-input COPIES so
  // the host-owned descriptor is never mutated (the validators are pure). A non-string
  // token is left as-is — the per-widget validators reject it before it is queried.
  if (Array.isArray(descriptor.joins)) {
    queryShape.joins = descriptor.joins.map((join) =>
      typeof join.type === 'string' ? { ...join, type: join.type.toLowerCase() } : join,
    );
  }
  if (Array.isArray(descriptor.orderBy)) {
    queryShape.orderBy = descriptor.orderBy.map((ob) =>
      typeof ob.direction === 'string' ? { ...ob, direction: ob.direction.toLowerCase() } : ob,
    );
  }
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
 *   share cache entries. It also folds in the request's `schemaAllowlist`
 *   (finding 3), which is what gives two option sets in one process that expose
 *   DIFFERENT tables automatically distinct keys even when neither sets a
 *   `cacheScope`. Defaults to the single-tenant policy digest so direct callers
 *   (e.g. unit tests) that don't pass one stay deterministic and match a
 *   single-tenant deployment.
 * @param cacheScope - Optional host-provided identity for the DATA SOURCE behind
 *   this request (`HandleBatchQueryOptions.cacheScope`, finding 2.4). Beyond the
 *   table-set separation the policy digest now provides, this is what separates two
 *   data sources that expose the SAME table names (e.g. one database per region with
 *   an identical schema): without it they produce identical keys for the same
 *   (claims, policy, descriptor) and one DB's rows are served for the other. Supply
 *   a stable per-database string. Omitted → byte-identical to the pre-2.4 key
 *   (backward compatible).
 */
export function generateCacheKey(
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  hmacSecret: string = process.env.CACHE_HMAC_SECRET ?? process.env.JWT_SECRET ?? '',
  policyDigest: string = SINGLE_TENANT_POLICY_DIGEST,
  cacheScope?: string,
): string {
  if (!hmacSecret) {
    throw new Error(
      'MUI X Studio Server: No cache HMAC secret is configured. ' +
        'With an empty key the security hash is guessable, breaking the "a client cannot forge another tenant\'s cache key" guarantee. ' +
        'Set CACHE_HMAC_SECRET (or JWT_SECRET) or pass an explicit secret to generateCacheKey().',
    );
  }
  // CROSS-PURPOSE KEY REUSE (hygiene): surface the `JWT_SECRET` fallback once per
  // process. Only when the DEFAULT was actually taken — an explicitly passed
  // secret, or a configured `CACHE_HMAC_SECRET`, is the intended configuration and
  // must stay silent.
  if (
    !warnedAboutJwtSecretReuse &&
    !process.env.CACHE_HMAC_SECRET &&
    process.env.JWT_SECRET &&
    hmacSecret === process.env.JWT_SECRET
  ) {
    warnedAboutJwtSecretReuse = true;
    console.warn(
      'MUI X Studio Server: CACHE_HMAC_SECRET is not set, so cache keys are derived from JWT_SECRET — ' +
        'the same key that authenticates bearer tokens. The derivation is domain-separated, so this is not ' +
        'directly exploitable, but cache keys are written to the cache backend and logs, which widens the blast ' +
        'radius of that one secret. Set CACHE_HMAC_SECRET to a distinct random value.',
    );
  }
  const securityHash = computeSecurityHash(claims, hmacSecret, policyDigest, cacheScope);
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
