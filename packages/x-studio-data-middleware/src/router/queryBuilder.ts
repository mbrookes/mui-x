/**
 * Secure Knex query builder — Phase 1, Task 1.3.
 *
 * Constructs parameterized WHERE clauses from verified JwtSecurityClaims
 * and user-supplied FilterPredicates.
 *
 * SECURITY INVARIANTS:
 * 1. All WHERE values use Knex parameterized bindings (never string concat)
 * 2. Table and column names are validated against the caller's allowlists
 *    BEFORE this function is called — see `shared/columnValidation.ts`
 *    (`validateDescriptorColumns`). This function trusts the descriptor has
 *    already been vetted.
 * 3. Security claims are applied FIRST and cannot be overridden by user filters
 * 4. The Knex `??` operator (double question mark) is used for identifier binding
 *
 * OWASP note: Parameterized queries = Defense Option 1 (recommended).
 * String-predicate injection is OWASP Defense Option 4 (STRONGLY DISCOURAGED).
 */
import type {
  JwtSecurityClaims,
  BatchWidgetDescriptor,
  FilterPredicate,
  HavingPredicate,
  HandleBatchQueryOptions,
} from '../security/types';
import { applyPredicates, applySecurityPredicates } from '../shared/predicates';
import {
  toCompiledSecurityPolicy,
  type CompiledSecurityPolicy,
} from '../security/compileSecurityPolicy';
import { toValidatedQueryPlan, type ValidatedQueryPlan } from '../security/validateQueryPlan';

/**
 * Build a Knex query builder with security predicates, joins, and user filters applied.
 *
 * The caller is responsible for:
 * - Adding SELECT columns (or COUNT)
 * - Adding ORDER BY / LIMIT
 * - Validating table and column names against the allowlists (done in handler.ts)
 *
 * @param db - Knex instance
 * @param claims - Pre-verified security claims
 * @param descriptor - Widget query descriptor (validated before calling)
 * @param options - Compiled security policy (request path) or the legacy raw option pair (direct callers)
 * @param plan - Pre-compiled `ValidatedQueryPlan` (request path). Direct callers omit it; a plan is then
 *   resolved on the spot from `descriptor`, reproducing the pre-refactor inline `resolveAlias` behavior.
 */
export function buildSecureQuery(
  db: any, // Knex.Knex
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  options?:
    | CompiledSecurityPolicy
    | Pick<HandleBatchQueryOptions, 'tenantColumn' | 'securityColumns'>,
  plan?: ValidatedQueryPlan,
): any {
  // Resolve the validated query plan ONCE. In the request path this is the plan
  // already compiled + threaded from the handler (returned as-is, no re-resolution);
  // direct callers (unit tests) pass only the descriptor, from which a plan is
  // resolved on the spot. Every column reference below reads a pre-resolved
  // `ColumnRef` off the plan — this function never calls `resolveAlias` itself, so
  // the ambiguous logical form is structurally unreachable here.
  const queryPlan = plan ?? toValidatedQueryPlan(descriptor);

  const query = db(queryPlan.table);

  // Resolve the security policy ONCE. In the request path this is the compiled
  // policy already threaded from the handler (returned as-is, no recompile);
  // direct callers (unit tests) may still pass the legacy raw option pair, which
  // is compiled on the spot. Enforcement then goes through the policy's
  // `forPrimaryTable` / `forJoinedTable` — never the fallback chain inline.
  const policy = toCompiledSecurityPolicy(options);

  // ── Joins (Phase 7) ────────────────────────────────────────────────────────
  // Applied before WHERE predicates so joined columns are available to filters.
  // Each join uses the Knex callback form so ALL `on` pairs become `.on()`
  // conditions within a SINGLE join — a per-pair call would join the same table
  // once per pair, producing invalid SQL ("table name not unique") for composite
  // keys.
  //
  // The `on` pairs are already alias-resolved on the plan (`ResolvedJoin.on`
  // carries physical `ColumnRef`s on both sides — the SAME resolution
  // `validateDescriptorColumns` checked against the allowlist), so execution can
  // never target a different physical column than validation approved.
  for (const join of queryPlan.joins) {
    let joinMethod: string;
    if (join.type === 'left') {
      joinMethod = 'leftJoin';
    } else if (join.type === 'right') {
      joinMethod = 'rightJoin';
    } else {
      joinMethod = 'join';
    }
    query[joinMethod](join.table, function joinOn(this: any) {
      for (const [left, right] of join.on) {
        this.on(left, '=', right);
      }
    });
  }

  // ── Phase 1: Security predicates (applied unconditionally) ────────────────
  // Applied to the primary table and, by default, to every joined table — a
  // joined table inherits the primary table's resolved security columns unless
  // the host explicitly opts it out as a shared/lookup table (`perTable[table] =
  // null`). See `resolveJoinSecurityColumns`.
  applySecurityPredicates(
    query,
    queryPlan.table,
    claims,
    policy.forPrimaryTable(queryPlan.table),
    'read',
  );

  for (const join of queryPlan.joins) {
    applySecurityPredicates(query, join.table, claims, policy.forJoinedTable(join.table), 'read');
  }

  // ── Phase 2: User-supplied filter predicates ────────────────────────────
  // The filter columns are already alias-resolved on the plan (`plan.filters`
  // carry physical `ColumnRef`s — the same resolution `validateDescriptorColumns`
  // checked against `columnAllowlist`), so execution can never target a different
  // physical column than validation approved.
  applyPredicates(query, queryPlan.filters as FilterPredicate[], 'read');

  // ── Phase 3: Post-aggregation HAVING predicates ──────────────────────────
  // Only allowed against aggregation aliases (validated by handler.ts before
  // this function is called). Uses Knex parameterized havingRaw to prevent injection.
  for (const h of queryPlan.having) {
    applyHaving(query, h);
  }

  return query;
}

/**
 * Apply a HAVING predicate to a Knex query.
 * The alias is already validated against aggregations by the caller (handler.ts).
 * Uses havingRaw with Knex bindings to prevent injection.
 */
function applyHaving(query: any, h: HavingPredicate): void {
  const opMap: Record<HavingPredicate['operator'], string> = {
    eq: '=',
    gt: '>',
    lt: '<',
    gte: '>=',
    lte: '<=',
  };
  const op = opMap[h.operator];
  if (!op) {
    throw new Error(
      `MUI X Studio Server: Unsupported HAVING operator "${h.operator}". Allowed: eq, gt, lt, gte, lte.`,
    );
  }
  // havingRaw with ?? binding for the alias identifier, ? for the value
  query.havingRaw(`?? ${op} ?`, [h.alias, h.value]);
}
