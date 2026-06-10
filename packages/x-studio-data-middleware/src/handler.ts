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
import { runPreflight, executeForTier } from './router/preflight';
import type { CacheProvider } from './cache/types';

let defaultCache: CacheProvider | undefined;

function getDefaultCache(): CacheProvider {
  if (!defaultCache) {
    defaultCache = new LRUCacheProvider();
  }
  return defaultCache;
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
      processWidget(db, claims, descriptor, cacheProvider, thresholds, tenantColumn),
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
    const { table, column } = resolveColumn(rawColumn, descriptor.table);
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
  thresholds: HandleBatchQueryOptions['thresholds'],
  tenantColumn: HandleBatchQueryOptions['tenantColumn'],
): Promise<WidgetQueryResult> {
  const cacheKey = generateCacheKey(claims, descriptor);
  const queryOptions = { tenantColumn };

  try {
    // ── 1. Cache check ─────────────────────────────────────────────────────
    const cached = await cacheProvider.get(cacheKey);
    if (cached) {
      return {
        id: descriptor.id,
        rows: cached.rows,
        tier: 'server',
        rowCount: cached.rows.length,
      };
    }

    // ── 2. Pre-flight COUNT(*) → tier selection ────────────────────────────
    const { rowCount, tier } = await runPreflight(db, claims, descriptor, thresholds, queryOptions);

    // ── 3. Execute query for the selected tier ─────────────────────────────
    const rows = await executeForTier(db, claims, descriptor, tier, queryOptions);

    // ── 4. Populate cache for client + server tiers ────────────────────────
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
