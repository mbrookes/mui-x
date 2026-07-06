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
import { LRUCacheProvider } from './cache/LRUCacheProvider';
import { MapTierCacheProvider } from './cache/MapTierCacheProvider';
import { runPreflight } from './router/preflight';
import { executeForTier } from './router/execute';
import { decideTierWithCache, DEFAULT_THRESHOLDS } from './router/tierDecision';
import { assertTablesAllowed } from './shared/assertTablesAllowed';
import type { CacheProvider, TierCacheProvider } from './cache/types';

const DEFAULT_TIER_CACHE_TTL_MS = 30_000; // 30 seconds — aligned with data cache default

let defaultCache: CacheProvider | undefined;
let defaultTierCache: TierCacheProvider | undefined;

function getDefaultCache(): CacheProvider {
  if (!defaultCache) {
    defaultCache = new LRUCacheProvider();
  }
  return defaultCache;
}

function getDefaultTierCache(): TierCacheProvider {
  if (!defaultTierCache) {
    defaultTierCache = new MapTierCacheProvider();
  }
  return defaultTierCache;
}

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
  const { db, schemaAllowlist, columnAllowlist, thresholds, tenantColumn, securityColumns } =
    options;
  // ── Compile the row-level-security policy ONCE for the whole request ───────
  // The single compiled object is threaded down in place of the raw
  // `(tenantColumn, securityColumns)` pair: the fallback chain now runs once here
  // instead of fresh at every enforcement site, and `policy.digest` folds the
  // resolved policy into the cache key so differently-scoped nodes never share
  // cache entries (Gap B).
  const policy = compileSecurityPolicy({ tenantColumn, securityColumns });
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
  // Fold the compiled policy's digest into the cache key so a policy change (e.g.
  // tightening a `perTable` scope mid-rollout) invalidates stale-scope entries
  // instead of a differently-scoped node serving them (Gap B).
  const cacheKey = generateCacheKey(claims, descriptor, undefined, policy.digest);
  const queryOptions = policy;

  try {
    // ── 1. Data cache check ────────────────────────────────────────────────
    const cached = await cacheProvider.get(cacheKey);
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
      cacheKey,
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

    // ── 5. Populate data cache for client + server tiers ──────────────────
    // DB push-down returns aggregated rows — not suitable for re-filtering.
    // Tag with the primary table AND every joined table so a mutation to any of
    // them invalidates this cached (joined) result — tagging only the primary
    // table would leave joined rows stale until TTL. Persist `rowCount` so a
    // later cache hit reports the same total as the cold miss.
    if (tier !== 'db') {
      await cacheProvider.set(
        cacheKey,
        { rows, cachedAt: Date.now(), tier, rowCount },
        { tags: [descriptor.table, ...(descriptor.joins?.map((j) => j.table) ?? [])] },
      );
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
