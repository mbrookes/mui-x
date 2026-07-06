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
 */
export async function runPreflight(
  db: any, // Knex.Knex
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  options: CompiledSecurityPolicy | SecurityPolicyOptions,
  plan?: ValidatedQueryPlan,
): Promise<PreflightResult> {
  // Build the query without column selection — only security + user filters
  const query = buildSecureQuery(db, claims, descriptor, options, plan).count('* as row_count');

  const result = (await query.first()) as { row_count: number | string } | undefined;
  const rowCount = Number(result?.row_count ?? 0);

  return { rowCount };
}
