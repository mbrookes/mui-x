/**
 * handleBatchQuery — the core pure function of x-studio-server.
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
  const { db, schemaAllowlist, thresholds } = options;
  const cacheProvider = options.cacheProvider ?? getDefaultCache();

  // Validate all requested tables upfront (Zero-Knowledge Rule)
  const invalidTables = body.widgets
    .map((w: BatchWidgetDescriptor) => w.table)
    .filter((t: string) => !schemaAllowlist.includes(t));

  if (invalidTables.length > 0) {
    throw new Error(
      `MUI X Studio Server: Requested table(s) not in schema allowlist: ${invalidTables.join(', ')}. ` +
        `Allowed tables: ${schemaAllowlist.join(', ')}`,
    );
  }

  const results: WidgetQueryResult[] = await Promise.all(
    body.widgets.map((descriptor: BatchWidgetDescriptor) =>
      processWidget(db, claims, descriptor, cacheProvider, thresholds),
    ),
  );

  return {
    pageId: body.pageId,
    results,
  };
}

async function processWidget(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  cacheProvider: CacheProvider,
  thresholds: HandleBatchQueryOptions['thresholds'],
): Promise<WidgetQueryResult> {
  const cacheKey = generateCacheKey(claims, descriptor);

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
    const { rowCount, tier } = await runPreflight(db, claims, descriptor, thresholds);

    // ── 3. Execute query for the selected tier ─────────────────────────────
    const rows = await executeForTier(db, claims, descriptor, tier);

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
