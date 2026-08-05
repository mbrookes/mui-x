/**
 * Pre-flight cost evaluator — Phase 3 of the adaptive routing pipeline.
 *
 * Runs a low-cost COUNT(*) query with the full security + user filter predicates
 * applied. This determines which routing tier to use for the actual query.
 *
 * Expected timings (SQLite WAL, covering indexes):
 *   10k rows tenant slice: ~0.1–0.3ms
 *   100k rows tenant slice: ~0.2–0.5ms
 *   1M rows tenant slice:  ~0.5–1ms
 *
 * This is consistently 5–20× faster than the full aggregation query, making
 * it a safe pre-flight check even for the smallest tier.
 *
 * The tier execution engine (projection / GROUP BY / aggregation / ORDER BY /
 * LIMIT) lives in the sibling `execute.ts` — this file is only the COUNT(*).
 */
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../security/types';
import { buildSecureQuery } from './queryBuilder';
import type {
  CompiledSecurityPolicy,
  SecurityPolicyOptions,
} from '../security/compileSecurityPolicy';
import type { ValidatedQueryPlan } from '../security/validateQueryPlan';
import { DEFAULT_QUERY_TIMEOUT_MS, applyQueryTimeout } from '../shared/queryTimeout';

interface PreflightResult {
  rowCount: number;
}

/**
 * Run a COUNT(*) pre-flight and return the row count.
 *
 * This is a pure COUNT(*) runner. Aggregation detection, threshold-to-tier
 * mapping, and tier-cache lookups all live in `tierDecision.ts` (the single
 * source of truth for `DEFAULT_THRESHOLDS` / `tierFromRowCount`); this function
 * only executes the count so callers can feed it into that decision.
 *
 * @param db - Knex instance (provided by host app)
 * @param claims - Verified security claims
 * @param descriptor - Widget query descriptor
 * @param options - Compiled security policy or raw `SecurityPolicyOptions`, forwarded to
 *   `buildSecureQuery`. REQUIRED — an explicit tenancy decision is always threaded through.
 * @param plan - Pre-compiled `ValidatedQueryPlan` (request path). Omitted by direct callers, in which case
 *   `buildSecureQuery` resolves one from `descriptor`.
 * @param queryTimeoutMs - Per-query statement timeout in milliseconds, resolved once per request from
 *   `HandleBatchQueryOptions.queryTimeoutMs`. This round-trip needs it MORE than the data query does: the
 *   count deliberately carries no LIMIT, so its cost is unbounded by construction and a slow one pins a
 *   pooled connection for as long as the database takes. Omitted by direct callers, who get
 *   `DEFAULT_QUERY_TIMEOUT_MS`; `0` opts out.
 */
export async function runPreflight(
  db: any, // Knex.Knex
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  options: CompiledSecurityPolicy | SecurityPolicyOptions,
  plan?: ValidatedQueryPlan,
  queryTimeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS,
): Promise<PreflightResult> {
  // JOIN ROW-MULTIPLICATION (Tier3, iter24 finding, evaluated/not fixed) — for a
  // descriptor with a 1:many `join` (e.g. one `sales` row matching several
  // `orders` rows), `COUNT(*)` here counts the JOINED, possibly row-multiplied
  // result, not distinct primary-table rows. That can mis-route the tier
  // decision (`tierFromRowCount` in `tierDecision.ts`) — e.g. tripping the
  // `serverMemoryTier` threshold on join fan-out alone, when the actual primary
  // rows in play are far fewer.
  //
  // This is ROUTING/PERF ONLY, never a correctness bug: whichever tier gets
  // picked, `execute.ts` still applies the same security predicates, user
  // filters and `effectiveLimit` cap — the returned rows are always correct and
  // bounded, just possibly served by a heavier tier than the "true" primary-row
  // count would have picked (and a heavier tier is the safe direction to be
  // wrong in — it never risks an under-provisioned client/server tier choking
  // on more rows than it expected).
  //
  // A distinct-row correction was considered and rejected as not low-risk
  // enough to apply here: `BatchWidgetDescriptor` declares no primary-key
  // column, so there is no cheap, generic `COUNT(DISTINCT <pk>)` to fall back
  // to; the only column-agnostic alternative — wrapping the whole query in
  // `SELECT COUNT(*) FROM (SELECT DISTINCT <primary_table>.* ...) sub` — adds a
  // DISTINCT-over-every-column subquery to EXACTLY the join-heavy queries where
  // this preflight's cost matters most, undermining the "5-20x faster than the
  // full query" fast-path this file's own docblock promises. Left as-is;
  // revisit if a descriptor-level primary-key declaration is ever added for
  // other reasons, which would make an exact `COUNT(DISTINCT ??)` cheap.
  //
  // Build the query without column selection — only security + user filters
  const query = buildSecureQuery(db, claims, descriptor, options, plan).count('* as row_count');
  // Applied here, not by the caller, for the same reason `runBounded` owns the
  // LIMIT: this is the single site that executes the preflight, so no caller
  // can issue an untimed COUNT(*). See `shared/queryTimeout.ts`.
  applyQueryTimeout(query, queryTimeoutMs);

  const result = (await query.first()) as { row_count: number | string } | undefined;
  const rowCount = Number(result?.row_count ?? 0);

  return { rowCount };
}
