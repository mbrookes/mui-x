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
import { resolveAlias } from '../shared/columnValidation';
import {
  toCompiledSecurityPolicy,
  type CompiledSecurityPolicy,
} from '../security/compileSecurityPolicy';

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
 */
export function buildSecureQuery(
  db: any, // Knex.Knex
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  options?:
    | CompiledSecurityPolicy
    | Pick<HandleBatchQueryOptions, 'tenantColumn' | 'securityColumns'>,
): any {
  const query = db(descriptor.table);

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
  // Resolve every `on` pair through the shared `resolveAlias` — the SAME function
  // `validateDescriptorColumns` already used to check both sides against the
  // allowlist — so execution can never target a different physical column than
  // validation approved. (One shared resolver, not an independent inline lookup,
  // is what makes that guarantee structural rather than something to re-verify
  // at every new call site — see `resolveAlias`'s doc comment.)
  for (const join of descriptor.joins ?? []) {
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
        this.on(resolveAlias(descriptor, left), '=', resolveAlias(descriptor, right));
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
    descriptor.table,
    claims,
    policy.forPrimaryTable(descriptor.table),
    'read',
  );

  for (const join of descriptor.joins ?? []) {
    applySecurityPredicates(query, join.table, claims, policy.forJoinedTable(join.table), 'read');
  }

  // ── Phase 2: User-supplied filter predicates ────────────────────────────
  // Resolve every filter column through the shared `resolveAlias` before
  // building the WHERE clause — the same resolver `validateDescriptorColumns`
  // used to check filter columns against `columnAllowlist`, so execution can
  // never target a different physical column than validation approved.
  const resolvedFilters = descriptor.filters?.map((predicate): FilterPredicate => {
    const physical = resolveAlias(descriptor, predicate.column);
    return physical !== predicate.column ? { ...predicate, column: physical } : predicate;
  });
  applyPredicates(query, resolvedFilters, 'read');

  // ── Phase 3: Post-aggregation HAVING predicates ──────────────────────────
  // Only allowed against aggregation aliases (validated by handler.ts before
  // this function is called). Uses Knex parameterized havingRaw to prevent injection.
  for (const h of descriptor.having ?? []) {
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
