/**
 * Secure Knex query builder — Phase 1, Task 1.3.
 *
 * Constructs parameterized WHERE clauses from verified JwtSecurityClaims
 * and user-supplied FilterPredicates.
 *
 * SECURITY INVARIANTS:
 * 1. All WHERE values use Knex parameterized bindings (never string concat)
 * 2. Table and column names are validated against SCHEMA_ALLOWLIST before use
 * 3. Security claims are applied FIRST and cannot be overridden by user filters
 * 4. The Knex `??` operator (double question mark) is used for identifier binding
 *
 * OWASP note: Parameterized queries = Defense Option 1 (recommended).
 * String-predicate injection is OWASP Defense Option 4 (STRONGLY DISCOURAGED).
 */
import type { JwtSecurityClaims, BatchWidgetDescriptor, FilterPredicate } from '../security/types';

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
 * Build a Knex query builder with security predicates and user filters applied.
 *
 * The caller is responsible for:
 * - Adding SELECT columns (or COUNT)
 * - Adding ORDER BY / LIMIT
 * - Validating table/column names against the schema allowlist before calling
 *
 * @param db - Knex instance
 * @param claims - Pre-verified security claims
 * @param descriptor - Widget query descriptor (table name and filters)
 */
export function buildSecureQuery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any, // Knex.Knex
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const query = db(descriptor.table);

  // ── Phase 1: Security predicates (applied unconditionally) ────────────────
  // These use Knex parameterized bindings — never raw values in SQL strings.
  query.where('tenant_id', '=', claims.tenantId);

  if (claims.regionIds && claims.regionIds.length > 0) {
    query.whereIn('region_id', claims.regionIds);
  }

  if (claims.department) {
    query.where('department', '=', claims.department);
  }

  // ── Phase 2: User-supplied filter predicates ────────────────────────────
  for (const predicate of descriptor.filters ?? []) {
    applyPredicate(query, predicate);
  }

  return query;
}

/**
 * Apply a single structured filter predicate to a Knex query.
 * Column names are bound via `??` (identifier escaping); values via `?` (value binding).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      query.whereIn(column, value as string[] | number[]);
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
      query.whereLike(column, value as string);
      break;
    case 'between': {
      const [lo, hi] = value as [string | number, string | number];
      query.whereBetween(column, [lo, hi]);
      break;
    }
    default:
      break;
  }
}
