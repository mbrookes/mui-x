/**
 * handleBatchQuery — the core pure function of x-studio-data-middleware.
 *
 * This function:
 * 1. Validates all requested tables against the schema allowlist
 * 2. Validates HAVING aliases (unconditionally) and column references
 *    (when a column allowlist is configured) for every widget
 * 3. For each widget in the batch:
 *    a. Checks the server-side cache (security-scoped key)
 *    b. Runs a COUNT(*) pre-flight to determine routing tier
 *    c. Executes the query via the appropriate tier
 *    d. Populates the cache for server/client tiers
 * 4. Returns a BatchQueryResponse with all results
 *
 * PURE FUNCTION GUARANTEE:
 * - No HTTP imports (no express, fastify, koa, etc.)
 * - No process.exit()
 * - No global state mutation
 * - All dependencies injected via options parameter
 *
 * The host app is responsible for:
 * - Parsing the HTTP request body
 * - Calling extractSecurityClaims() to get JwtSecurityClaims
 * - Providing a configured Knex instance
 * - Writing the response to the HTTP response object
 */
import type {
  JwtSecurityClaims,
  BatchQueryRequest,
  BatchQueryResponse,
  BatchWidgetDescriptor,
  WidgetQueryResult,
  HandleBatchQueryOptions,
} from './security/types';
import { generateCacheKey } from './security/cacheKey';
import {
  compileSecurityPolicy,
  type CompiledSecurityPolicy,
} from './security/compileSecurityPolicy';
import { validateQueryPlan, type ValidatedQueryPlan } from './security/validateQueryPlan';
import { getDefaultCache, getDefaultTierCache } from './cache/defaultProviders';
import { runPreflight } from './router/preflight';
import { executeForTier } from './router/execute';
import {
  decideTierWithCache,
  DEFAULT_THRESHOLDS,
  TIER_CACHE_KEY_PREFIX,
} from './router/tierDecision';
import { assertTablesAllowed } from './shared/assertTablesAllowed';
import type { CacheEntry, CacheProvider, TierCacheProvider } from './cache/types';

const DEFAULT_TIER_CACHE_TTL_MS = 30_000; // 30 seconds — aligned with data cache default

/**
 * Handle a batch query request from a Studio dashboard.
 *
 * @param body - Parsed request body (BatchQueryRequest)
 * @param claims - Verified JWT security claims from extractSecurityClaims()
 * @param options - Knex instance, optional cache provider, schema allowlist
 */
export async function handleBatchQuery(
  body: BatchQueryRequest,
  claims: JwtSecurityClaims,
  options: HandleBatchQueryOptions,
): Promise<BatchQueryResponse> {
  const { db, schemaAllowlist, columnAllowlist, thresholds, tenancy, securityColumns } = options;
  // ── Compile the row-level-security policy ONCE for the whole request ───────
  // The single compiled object is threaded down in place of the raw
  // `(tenancy, securityColumns)` pair: the resolution chain now runs once here
  // instead of fresh at every enforcement site, and `policy.digest` folds the
  // resolved policy into the cache key so differently-scoped nodes never share
  // cache entries (Gap B).
  const policy = compileSecurityPolicy({ tenancy, securityColumns, columnAllowlist });
  const cacheProvider = options.cacheProvider ?? getDefaultCache();
  const tierCacheTtlMs = options.tierCacheTtlMs ?? DEFAULT_TIER_CACHE_TTL_MS;
  const tierCacheProvider =
    tierCacheTtlMs > 0 ? (options.tierCacheProvider ?? getDefaultTierCache()) : null;

  // ── Validate all requested tables upfront (Zero-Knowledge Rule) ────────────
  assertTablesAllowed(
    body.widgets.flatMap((w: BatchWidgetDescriptor) => [
      w.table,
      ...(w.joins?.map((j) => j.table) ?? []),
    ]),
    schemaAllowlist,
  );

  // ── Compile + validate the column-reference plan ONCE per widget ───────────
  // `validateQueryPlan` runs the unconditional HAVING/aggregation-alias validators
  // and, when a `columnAllowlist` is configured, the fail-closed column-allowlist
  // check — reusing the same single-source-of-truth validators as before — then
  // resolves every column reference into a `ValidatedQueryPlan` whose fields are
  // already-resolved `ColumnRef`s. The plan is threaded down in place of the raw
  // descriptor's logical column names + `columnAliases` map, so `buildSecureQuery`
  // / `executeForTier` no longer re-derive alias resolution at their own call
  // sites. Compiled synchronously (before Promise.all) so a validation error still
  // rejects the whole batch, exactly as the previous validation loops did.
  const plans: ValidatedQueryPlan[] = body.widgets.map((descriptor: BatchWidgetDescriptor) =>
    validateQueryPlan(descriptor, columnAllowlist),
  );

  const results: WidgetQueryResult[] = await Promise.all(
    body.widgets.map((descriptor: BatchWidgetDescriptor, index: number) =>
      processWidget(
        db,
        claims,
        descriptor,
        cacheProvider,
        tierCacheProvider,
        tierCacheTtlMs,
        thresholds,
        policy,
        plans[index],
      ),
    ),
  );

  return {
    pageId: body.pageId,
    results,
  };
}

async function processWidget(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  cacheProvider: CacheProvider,
  tierCacheProvider: TierCacheProvider | null,
  tierCacheTtlMs: number,
  thresholds: HandleBatchQueryOptions['thresholds'],
  policy: CompiledSecurityPolicy,
  plan: ValidatedQueryPlan,
): Promise<WidgetQueryResult> {
  const queryOptions = policy;

  try {
    // Fold the compiled policy's digest into the cache key so a policy change (e.g.
    // tightening a `perTable` scope mid-rollout) invalidates stale-scope entries
    // instead of a differently-scoped node serving them (Gap B).
    // Generated INSIDE the try block (finding 2.3): `generateCacheKey` throws when
    // no HMAC secret is configured (`CACHE_HMAC_SECRET` / `JWT_SECRET` both unset),
    // and every widget-scoped operation must honor the per-widget error-isolation
    // invariant — a throw here must produce this widget's `{ error }` result, not
    // reject the whole batch's `Promise.all`.
    const cacheKey = generateCacheKey(claims, descriptor, undefined, policy.digest);

    // ── 1. Data cache check ────────────────────────────────────────────────
    // The cache is a best-effort layer in FRONT of the authoritative DB: a cache
    // read failure (e.g. Redis down) must degrade to a fresh DB fetch, not fail
    // the widget. Catch here and treat the error as a miss (finding 2.6).
    let cached: CacheEntry | undefined;
    try {
      cached = await cacheProvider.get(cacheKey);
    } catch (cacheErr) {
      cached = undefined;
      console.warn(
        `MUI X Studio Server: cache read failed for a widget; falling back to the database. ` +
          `The result is still served from the DB, but the cache backend should be checked. ` +
          `Cause: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
      );
    }
    if (cached) {
      return {
        id: descriptor.id,
        rows: cached.rows,
        // Echo the tier that actually produced the cached rows (defaults to
        // 'server' for entries written before tier was persisted). Reporting a
        // 'client'-tier result as 'server' would change client-side behavior.
        tier: cached.tier ?? 'server',
        // Echo the ORIGINATING rowCount (the preflight COUNT(*)) — not
        // `cached.rows.length`, which is the (possibly limit-truncated) row
        // count and would flip the reported total between the cold-miss and
        // cache-hit responses. Falls back to the row length for entries written
        // before rowCount was persisted.
        rowCount: cached.rowCount ?? cached.rows.length,
      };
    }

    // ── 2 & 3. Tier decision: aggregation check → tier cache → COUNT(*) ───
    const hasAggregations = (descriptor.aggregations?.length ?? 0) > 0;
    const resolvedThresholds = {
      client: thresholds?.clientTier ?? DEFAULT_THRESHOLDS.client,
      server: thresholds?.serverMemoryTier ?? DEFAULT_THRESHOLDS.server,
    };

    const tierDecision = await decideTierWithCache(
      hasAggregations,
      // Namespace the tier plane's key so it can never collide with the data
      // plane's entry for the same widget on a shared Redis client (finding 2.1).
      TIER_CACHE_KEY_PREFIX + cacheKey,
      () => runPreflight(db, claims, descriptor, queryOptions, plan).then((p) => p.rowCount),
      tierCacheProvider,
      resolvedThresholds,
      tierCacheTtlMs,
    );
    const tier: 'client' | 'server' | 'db' = tierDecision.tier;
    let rowCount: number = tierDecision.rowCount;

    // ── 4. Execute query for the selected tier ─────────────────────────────
    const rows = await executeForTier(db, claims, descriptor, tier, queryOptions, plan);

    // For aggregation queries decideTier returns rowCount=0 (bypassed);
    // use the actual number of result groups instead.
    if (hasAggregations) {
      rowCount = rows.length;
    }

    // ── 5. Populate data cache ──────────────────────────────────────────────
    // Aggregation queries are ALWAYS routed to the 'db' tier (step 2 above) and
    // return grouped/aggregated rows keyed by the aggregation shape — left
    // uncached here (unchanged, historical behavior). A NON-aggregation 'db'-tier
    // result (finding 3.2), in contrast, is a plain RAW row slice — the exact
    // same shape `executeForTier` returns for 'client'/'server' — routed to 'db'
    // only because its preflight COUNT(*) exceeded `serverMemoryTier`. It is just
    // as reusable as a 'client'/'server' result, so it is cached the same way;
    // leaving it uncached (the historical behavior, and what the stale comment
    // here used to claim for ALL 'db'-tier results) meant a query too large for
    // the server tier re-ran on every request and re-shipped a potentially
    // >100k-row slice on every hit.
    // Tag with the primary table AND every joined table so a mutation to any of
    // them invalidates this cached (joined) result — tagging only the primary
    // table would leave joined rows stale until TTL. Persist `rowCount` so a
    // later cache hit reports the same total as the cold miss.
    if (tier !== 'db' || !hasAggregations) {
      // The rows are already in hand from the DB — a cache WRITE failure must not
      // discard them. Catch and degrade to "served, uncached" (finding 2.6).
      try {
        await cacheProvider.set(
          cacheKey,
          { rows, cachedAt: Date.now(), tier, rowCount },
          { tags: [descriptor.table, ...(descriptor.joins?.map((j) => j.table) ?? [])] },
        );
      } catch (cacheErr) {
        console.warn(
          `MUI X Studio Server: cache write failed for a widget; the result is still returned. ` +
            `Subsequent requests will re-query the DB until the cache backend recovers. ` +
            `Cause: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
        );
      }
    }

    return {
      id: descriptor.id,
      rows,
      tier,
      rowCount,
    };
  } catch (err) {
    return {
      id: descriptor.id,
      rows: [],
      tier: 'db',
      rowCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
