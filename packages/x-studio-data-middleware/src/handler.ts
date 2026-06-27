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
import { decideTierWithCache, DEFAULT_THRESHOLDS } from './router/tierDecision';
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

  // Validate HAVING aliases against declared aggregation aliases (SECURITY INVARIANT).
  // Prevents referencing arbitrary columns or injecting identifiers via the HAVING clause.
  if (descriptor.having && descriptor.having.length > 0) {
    const aggAliases = new Set((descriptor.aggregations ?? []).map((a) => a.alias));
    for (const h of descriptor.having) {
      if (!aggAliases.has(h.alias)) {
        throw new Error(
          `MUI X Studio Server: HAVING alias "${h.alias}" does not match any aggregation alias. ` +
            `Declared aliases: ${[...aggAliases].join(', ') || '(none)'}. ` +
            `Only aggregation aliases may be used in HAVING predicates.`,
        );
      }
    }
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

    // ── 2 & 3. Tier decision: aggregation check → tier cache → COUNT(*) ───
    const hasAggregations = (descriptor.aggregations?.length ?? 0) > 0;
    const resolvedThresholds = {
      client: thresholds?.clientTier ?? DEFAULT_THRESHOLDS.client,
      server: thresholds?.serverMemoryTier ?? DEFAULT_THRESHOLDS.server,
    };

    const tierDecision = await decideTierWithCache(
      hasAggregations,
      cacheKey,
      () => runPreflight(db, claims, descriptor, thresholds, queryOptions).then((p) => p.rowCount),
      tierCacheProvider,
      resolvedThresholds,
      tierCacheTtlMs,
    );
    const tier: 'client' | 'server' | 'db' = tierDecision.tier;
    let rowCount: number = tierDecision.rowCount;

    // ── 4. Execute query for the selected tier ─────────────────────────────
    const rows = await executeForTier(db, claims, descriptor, tier, queryOptions);

    // For aggregation queries decideTier returns rowCount=0 (bypassed);
    // use the actual number of result groups instead.
    if (hasAggregations) {
      rowCount = rows.length;
    }

    // ── 5. Populate data cache for client + server tiers ──────────────────
    // DB push-down returns aggregated rows — not suitable for re-filtering.
    // Tag with the primary table so host apps can call deleteByTag(table) after a write.
    if (tier !== 'db') {
      await cacheProvider.set(
        cacheKey,
        { rows, cachedAt: Date.now() },
        { tags: [descriptor.table] },
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
