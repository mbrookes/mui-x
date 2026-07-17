/**
 * handleBatchQuery — the core pure function of x-studio-data-middleware.
 *
 * This function, for each widget in the batch — with per-widget error isolation:
 * one widget's failure produces that widget's `{ error }` result, never a
 * whole-batch `Promise.all` rejection. This isolation now covers the client-input
 * validation stage too (table allowlist + query-plan validation), not just
 * cache/preflight/execute — see the `processWidget` body:
 * 1. Validates the widget's tables against the schema allowlist
 * 2. Validates HAVING aliases (unconditionally) and column references
 *    (when a column allowlist is configured)
 * 3. Checks the server-side cache (security-scoped key)
 * 4. Runs a COUNT(*) pre-flight to determine routing tier
 * 5. Executes the query via the appropriate tier
 * 6. Populates the cache for server/client tiers, and for non-aggregation
 *    db-tier results (see the `tier !== 'db' || !hasAggregations` gate below)
 * and returns a BatchQueryResponse with all results.
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
import { validateQueryPlan } from './security/validateQueryPlan';
import { getDefaultCache, getDefaultTierCache } from './cache/defaultProviders';
import { runPreflight } from './router/preflight';
import { executeForTier } from './router/execute';
import {
  decideTierWithCache,
  DEFAULT_THRESHOLDS,
  TIER_CACHE_KEY_PREFIX,
} from './router/tierDecision';
import { assertTablesAllowed } from './shared/assertTablesAllowed';
import { sanitizeBoundaryError } from './shared/sanitizeError';
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
  const { db, schemaAllowlist, columnAllowlist, thresholds, tenancy, securityColumns, cacheScope } =
    options;
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

  // Table-allowlist validation and column-reference plan compilation are NOT
  // precomputed here before `Promise.all` — they run per widget INSIDE
  // `processWidget`'s try block (below), so a single widget's invalid table /
  // HAVING alias / unsafe agg-or-output alias / non-asc|desc ORDER BY direction /
  // column-allowlist violation becomes THAT widget's `{ error }` result instead of
  // rejecting the whole batch's `Promise.all`. This makes the validation stage
  // honor the same per-widget error-isolation invariant the cache/preflight/execute
  // stages and the unsupported-operator/func throws in `executeForTier` already do.
  const results: WidgetQueryResult[] = await Promise.all(
    body.widgets.map((descriptor: BatchWidgetDescriptor) =>
      processWidget(
        db,
        claims,
        descriptor,
        cacheProvider,
        tierCacheProvider,
        tierCacheTtlMs,
        thresholds,
        policy,
        schemaAllowlist,
        columnAllowlist,
        cacheScope,
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
  schemaAllowlist: HandleBatchQueryOptions['schemaAllowlist'],
  columnAllowlist: HandleBatchQueryOptions['columnAllowlist'],
  cacheScope: HandleBatchQueryOptions['cacheScope'],
): Promise<WidgetQueryResult> {
  const queryOptions = policy;

  try {
    // ── 0. Per-widget input validation (inside the try for error isolation) ──
    // Both classes of client-input validation run HERE, per widget, rather than
    // synchronously before `Promise.all`, so a validation throw becomes this
    // widget's `{ error }` result via the catch below instead of rejecting every
    // well-formed sibling widget too. Ordering is preserved exactly as when these
    // ran up front: the widget's tables (primary + joins) are validated BEFORE its
    // column-reference plan, and both BEFORE cache/preflight/execute.
    //
    // `assertTablesAllowed` enforces the Zero-Knowledge Rule (a table not in the
    // allowlist is rejected before any query is built). `validateQueryPlan` runs
    // the unconditional HAVING/aggregation-alias/output-alias/ORDER-BY-direction
    // validators and, when a `columnAllowlist` is configured, the fail-closed
    // column-allowlist check — then resolves every column reference into a
    // `ValidatedQueryPlan` whose fields are already-resolved `ColumnRef`s, threaded
    // down in place of the raw descriptor's logical column names + `columnAliases`
    // map so `runPreflight` / `executeForTier` never re-derive alias resolution.
    assertTablesAllowed(
      [descriptor.table, ...(descriptor.joins?.map((j) => j.table) ?? [])],
      schemaAllowlist,
    );
    const plan = validateQueryPlan(descriptor, columnAllowlist);

    // Fold the compiled policy's digest into the cache key so a policy change (e.g.
    // tightening a `perTable` scope mid-rollout) invalidates stale-scope entries
    // instead of a differently-scoped node serving them (Gap B).
    // Generated INSIDE the try block (finding 2.3): `generateCacheKey` throws when
    // no HMAC secret is configured (`CACHE_HMAC_SECRET` / `JWT_SECRET` both unset),
    // and every widget-scoped operation must honor the per-widget error-isolation
    // invariant — a throw here must produce this widget's `{ error }` result, not
    // reject the whole batch's `Promise.all`.
    const cacheKey = generateCacheKey(claims, descriptor, undefined, policy.digest, cacheScope);

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
    // NOTE (finding 3.2 — best-effort `rowCount`): for a NON-aggregation widget
    // served from a tier-cache HIT, `tierDecision.rowCount` is the preflight
    // COUNT(*) captured when the tier entry was written, up to the tier TTL ago
    // (`DEFAULT_TIER_CACHE_TTL_MS`, 30s). A mutation invalidates the DATA cache by
    // tag (`handleMutation` → `deleteByTag`), but the `TierCacheProvider` interface
    // exposes only `get`/`set`/`invalidatePrefix` — no tag-based invalidation — so
    // the tier entry (and its `rowCount`) is NOT evicted on a write and can lag a
    // just-committed insert/delete by ≤ the tier TTL. The returned ROWS are always
    // fresh (re-read from the DB on this request, or from the freshly-invalidated
    // data cache); only this reported total is best-effort within the tier window.
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
      // Never return a raw DB-driver error verbatim (finding T3.5): our own
      // validation messages pass through, but a driver error (e.g. `no such column`)
      // is a schema oracle, so it is logged server-side and replaced with a generic
      // message here — even when no `columnAllowlist` is configured.
      error: sanitizeBoundaryError(
        err,
        `MUI X Studio Server: The query for this widget could not be completed. ` +
          `The underlying cause has been logged server-side; inspect the server logs to diagnose it. ` +
          `If it persists, verify the widget's table, column, and filter configuration.`,
      ),
    };
  }
}
