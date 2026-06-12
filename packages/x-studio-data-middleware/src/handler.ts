/**
 * handleBatchQuery — the core pure function of x-studio-data-middleware.
 *
 * This function:
 * 1. Validates all requested tables against the schema allowlist
 * 2. For each widget in the batch:
 *    a. Checks the server-side cache (security-scoped key)
 *    b. Runs a COUNT(*) pre-flight to determine routing tier
 *    c. Executes the query via the appropriate tier
 *    d. Populates the cache for server/client tiers
 * 3. Returns a BatchQueryResponse with all results
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
import { LRUCacheProvider } from './cache/LRUCacheProvider';
import { MapTierCacheProvider } from './cache/MapTierCacheProvider';
import { runPreflight, executeForTier } from './router/preflight';
import type { CacheProvider, TierCacheProvider } from './cache/types';

const DEFAULT_TIER_CACHE_TTL_MS = 300_000; // 5 minutes

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
  const { db, schemaAllowlist, columnAllowlist, thresholds, tenantColumn } = options;
  const cacheProvider = options.cacheProvider ?? getDefaultCache();
  const tierCacheTtlMs = options.tierCacheTtlMs ?? DEFAULT_TIER_CACHE_TTL_MS;
  const tierCacheProvider =
    tierCacheTtlMs > 0 ? (options.tierCacheProvider ?? getDefaultTierCache()) : null;

  // ── Phase 2: Validate all requested tables upfront (Zero-Knowledge Rule) ──
  const allTables = body.widgets.flatMap((w: BatchWidgetDescriptor) => [
    w.table,
    ...(w.joins?.map((j) => j.table) ?? []),
  ]);
  const invalidTables = allTables.filter((t: string) => !schemaAllowlist.includes(t));

  if (invalidTables.length > 0) {
    throw new Error(
      `MUI X Studio Server: Requested table(s) not in schema allowlist: ${invalidTables.join(', ')}. ` +
        `Allowed tables: ${schemaAllowlist.join(', ')}`,
    );
  }

  // ── Phase 2: Validate all column references (SECURITY INVARIANT #2) ────────
  if (columnAllowlist) {
    for (const descriptor of body.widgets) {
      validateColumns(descriptor, columnAllowlist);
    }
  }

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
        tenantColumn,
      ),
    ),
  );

  return {
    pageId: body.pageId,
    results,
  };
}

/**
 * Validate all column references in a descriptor against the column allowlist.
 * Throws if any column is not in the allowed list for its table.
 *
 * Qualified names (`table.column`) are split and checked against the allowlist
 * for the named table. Unqualified names are checked against the primary table.
 */
function validateColumns(
  descriptor: BatchWidgetDescriptor,
  columnAllowlist: Record<string, string[]>,
): void {
  const resolveColumn = (
    rawColumn: string,
    defaultTable: string,
  ): { table: string; column: string } => {
    const dotIdx = rawColumn.indexOf('.');
    if (dotIdx !== -1) {
      return { table: rawColumn.slice(0, dotIdx), column: rawColumn.slice(dotIdx + 1) };
    }
    return { table: defaultTable, column: rawColumn };
  };

  const check = (rawColumn: string, context: string): void => {
    // If the logical column ID has a physical alias, validate the physical column instead
    const physical = descriptor.columnAliases?.[rawColumn] ?? rawColumn;
    const { table, column } = resolveColumn(physical, descriptor.table);
    const allowed = columnAllowlist[table];
    if (allowed && !allowed.includes(column)) {
      throw new Error(
        `MUI X Studio Server: Column "${column}" on table "${table}" is not in the column allowlist (${context}). ` +
          `Allowed columns for "${table}": ${allowed.join(', ')}`,
      );
    }
  };

  for (const col of descriptor.columns ?? []) {
    check(col, 'columns');
  }
  for (const pred of descriptor.filters ?? []) {
    check(pred.column, 'filters');
  }
  for (const ob of descriptor.orderBy ?? []) {
    check(ob.column, 'orderBy');
  }
  for (const agg of descriptor.aggregations ?? []) {
    check(agg.column, 'aggregations');
  }
}

async function processWidget(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  cacheProvider: CacheProvider,
  tierCacheProvider: TierCacheProvider | null,
  tierCacheTtlMs: number,
  thresholds: HandleBatchQueryOptions['thresholds'],
  tenantColumn: HandleBatchQueryOptions['tenantColumn'],
): Promise<WidgetQueryResult> {
  const cacheKey = generateCacheKey(claims, descriptor);
  const queryOptions = { tenantColumn };

  try {
    // ── 1. Data cache check ────────────────────────────────────────────────
    const cached = await cacheProvider.get(cacheKey);
    if (cached) {
      return {
        id: descriptor.id,
        rows: cached.rows,
        tier: 'server',
        rowCount: cached.rows.length,
      };
    }

    // ── 2. Tier cache check — skip preflight on repeated cold misses ───────
    let tier: 'client' | 'server' | 'db';
    let rowCount: number;

    const cachedTier = tierCacheProvider ? await tierCacheProvider.get(cacheKey) : undefined;
    if (cachedTier) {
      tier = cachedTier.tier;
      rowCount = cachedTier.rowCount;
    } else {
      // ── 3. Pre-flight COUNT(*) → tier selection ────────────────────────
      const preflight = await runPreflight(db, claims, descriptor, thresholds, queryOptions);
      tier = preflight.tier;
      rowCount = preflight.rowCount;

      // Store tier result for future cold misses within the tier TTL window.
      if (tierCacheProvider) {
        await tierCacheProvider.set(cacheKey, { tier, rowCount }, tierCacheTtlMs);
      }
    }

    // ── 4. Execute query for the selected tier ─────────────────────────────
    const rows = await executeForTier(db, claims, descriptor, tier, queryOptions);

    // ── 5. Populate data cache for client + server tiers ──────────────────
    // DB push-down returns aggregated rows — not suitable for re-filtering
    if (tier !== 'db') {
      await cacheProvider.set(cacheKey, { rows, cachedAt: Date.now() });
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
