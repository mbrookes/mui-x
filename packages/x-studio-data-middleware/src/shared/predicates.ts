/**
 * Shared predicate helpers for @mui/x-studio-data-middleware.
 *
 * A single source of truth for:
 *   - Row-level security predicates (tenant / region / department), applied
 *     unconditionally to both the read path (`buildSecureQuery`) and the write
 *     path (`buildUpdateMutation` / `buildDeleteMutation`).
 *   - Structured user filter predicates, with a shared `SAFE_OPERATORS`
 *     allowlist so an unrecognized operator is always rejected — on reads AND
 *     writes — instead of being silently dropped.
 *
 * SECURITY: values are always bound via Knex parameterized bindings (`.where`,
 * `.whereIn`, …) — never string-concatenated into SQL.
 *
 * Read vs write divergence (deliberate):
 *   - An empty `in` list means "match nothing". On READS that is a no-op filter
 *     and is dropped (mirrors the client's empty-selection semantics). On WRITES
 *     dropping it would silently widen a scoped UPDATE/DELETE into a full-tenant
 *     mutation, so it THROWS instead.
 */
import type {
  FilterPredicate,
  JwtSecurityClaims,
  SecurityColumns,
  SecurityColumnsConfig,
} from '../security/types';

/** Allowlist of operators that may be used in user-supplied filters / where-clauses. */
export const SAFE_OPERATORS = new Set<FilterPredicate['operator']>([
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
 * Resolve the security column names for the PRIMARY table of a query/mutation.
 *
 * Falls back to the historical hardcoded names (`region_id`, `department`) and
 * to `tenantColumnFallback` (the legacy `tenantColumn` option) for the tenant
 * column so existing deployments keep working without configuring anything.
 */
export function resolvePrimarySecurityColumns(
  table: string,
  config: SecurityColumnsConfig | undefined,
  tenantColumnFallback: string | undefined,
): SecurityColumns {
  const override = config?.perTable?.[table];
  return {
    tenant: override?.tenant ?? config?.tenant ?? tenantColumnFallback,
    region: override?.region ?? config?.region ?? 'region_id',
    department: override?.department ?? config?.department ?? 'department',
  };
}

/**
 * Resolve the security column names for a JOINED table.
 *
 * A joined table is only scoped when it has an explicit `perTable` entry with a
 * `tenant` column — tables without one are treated as shared lookup tables and
 * receive no predicate. Region/department are opt-in per joined table (no
 * defaults) because we cannot assume an arbitrary joined table has those columns.
 *
 * Returns `undefined` when the table should not be scoped.
 */
export function resolveJoinSecurityColumns(
  table: string,
  config: SecurityColumnsConfig | undefined,
): SecurityColumns | undefined {
  const override = config?.perTable?.[table];
  if (!override?.tenant) {
    return undefined;
  }
  return {
    tenant: override.tenant,
    region: override.region,
    department: override.department,
  };
}

/**
 * Apply the row-level security predicates for one table to a Knex query.
 *
 * Applied FIRST (before user filters) so they can never be overridden or
 * AND-ed away. Only the dimensions with a configured column name AND a matching
 * claim are emitted.
 */
export function applySecurityPredicates(
  query: any,
  table: string,
  claims: JwtSecurityClaims,
  securityColumns: SecurityColumns | undefined,
): void {
  if (!securityColumns) {
    return;
  }

  if (securityColumns.tenant) {
    query.where(`${table}.${securityColumns.tenant}`, '=', claims.tenantId);
  }

  if (securityColumns.region && claims.regionIds && claims.regionIds.length > 0) {
    query.whereIn(`${table}.${securityColumns.region}`, claims.regionIds);
  }

  if (securityColumns.department && claims.department) {
    query.where(`${table}.${securityColumns.department}`, '=', claims.department);
  }
}

/**
 * Apply a list of structured filter predicates to a Knex query.
 *
 * @param mode - `'read'` drops an empty `in` list (match-nothing no-op);
 *   `'write'` throws for an empty `in` list (dropping it would make the mutation
 *   unscoped). Unrecognized operators always throw in both modes.
 */
export function applyPredicates(
  query: any,
  predicates: FilterPredicate[] | undefined,
  mode: 'read' | 'write',
): void {
  for (const predicate of predicates ?? []) {
    applyPredicate(query, predicate, mode);
  }
}

/**
 * Column names are bound via Knex identifier escaping; values via `?` bindings.
 */
function applyPredicate(query: any, predicate: FilterPredicate, mode: 'read' | 'write'): void {
  if (!SAFE_OPERATORS.has(predicate.operator)) {
    throw new Error(
      `MUI X Studio Server: Unsupported filter operator "${predicate.operator}". ` +
        `The operator is not in the allowlist, so the predicate cannot be safely translated to SQL. ` +
        `Use one of: ${[...SAFE_OPERATORS].join(', ')}.`,
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
      if (value.length === 0) {
        if (mode === 'write') {
          throw new Error(
            `MUI X Studio Server: "in" predicate with an empty value list would make the mutation unscoped and is not allowed. ` +
              `An empty "in" matches no rows, so dropping it would widen the UPDATE/DELETE to the whole tenant table. ` +
              `Provide at least one value, or omit the predicate intentionally.`,
          );
        }
        // Read path: empty IN means "match nothing" — drop it (autoRemove).
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
