/**
 * Secure Knex query builder — Phase 1, Task 1.3.
 *
 * Constructs parameterized WHERE clauses from verified JwtSecurityClaims
 * and user-supplied FilterPredicates.
 *
 * SECURITY INVARIANTS:
 * 1. All WHERE values use Knex parameterized bindings (never string concat)
 * 2. Table and column names are validated against the caller's allowlists
 *    BEFORE this function is called — see handler.ts `validateColumns()`.
 *    This function trusts the descriptor has already been vetted.
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

// Allowlist of operators that may be used in user-supplied filters
const SAFE_OPERATORS = new Set<FilterPredicate['operator']>([
  'eq',
  'neq',
  'in',
  'lt',
  'lte',
  'gt',
  'gte',
  'like',
  'between',
]);

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
  options?: Pick<HandleBatchQueryOptions, 'tenantColumn'>,
): any {
  const query = db(descriptor.table);

  // ── Joins (Phase 7) ────────────────────────────────────────────────────────
  // Applied before WHERE predicates so joined columns are available to filters.
  for (const join of descriptor.joins ?? []) {
    let joinMethod: string;
    if (join.type === 'left') {
      joinMethod = 'leftJoin';
    } else if (join.type === 'right') {
      joinMethod = 'rightJoin';
    } else {
      joinMethod = 'join';
    }
    for (const [left, right] of join.on) {
      query[joinMethod](join.table, left, '=', right);
    }
  }

  // ── Phase 1: Security predicates (applied unconditionally) ────────────────
  // These use Knex parameterized bindings — never raw values in SQL strings.
  if (options?.tenantColumn) {
    query.where(`${descriptor.table}.${options.tenantColumn}`, '=', claims.tenantId);
  }

  if (claims.regionIds && claims.regionIds.length > 0) {
    query.whereIn(`${descriptor.table}.region_id`, claims.regionIds);
  }

  if (claims.department) {
    query.where(`${descriptor.table}.department`, '=', claims.department);
  }

  // ── Phase 2: User-supplied filter predicates ────────────────────────────
  for (const predicate of descriptor.filters ?? []) {
    applyPredicate(query, predicate);
  }

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

/**
 * Apply a single structured filter predicate to a Knex query.
 * Column names are bound via `??` (identifier escaping); values via `?` (value binding).
 */

function applyPredicate(query: any, predicate: FilterPredicate): void {
  if (!SAFE_OPERATORS.has(predicate.operator)) {
    throw new Error(
      `MUI X Studio Server: Unsupported filter operator "${predicate.operator}". ` +
        `Allowed: ${[...SAFE_OPERATORS].join(', ')}`,
    );
  }

  const { column, operator, value } = predicate;

  switch (operator) {
    case 'eq':
      query.where(column, '=', value);
      break;
    case 'neq':
      query.where(column, '!=', value);
      break;
    case 'in':
      // Skip empty IN lists — `WHERE x IN ()` is a SQL error in MySQL/SQLite
      // and semantically means "match nothing" (no rows pass). Dropping the
      // predicate here is the autoRemove pattern: a no-op filter that would
      // produce zero results is omitted rather than forwarded to the DB.
      if (value.length === 0) {
        break;
      }
      query.whereIn(column, value);
      break;
    case 'lt':
      query.where(column, '<', value);
      break;
    case 'lte':
      query.where(column, '<=', value);
      break;
    case 'gt':
      query.where(column, '>', value);
      break;
    case 'gte':
      query.where(column, '>=', value);
      break;
    case 'like':
      query.whereLike(column, value);
      break;
    case 'between': {
      const [lo, hi] = value;
      query.whereBetween(column, [lo, hi]);
      break;
    }
    default:
      break;
  }
}
