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
  SecurityColumnOverride,
  SecurityColumnsConfig,
} from '../security/types';

/**
 * Resolve ONE security dimension's column name from a per-table override.
 *
 * Three-way semantics (finding 2.1) — an override value distinguishes THREE
 * intents, which a plain `?? fallback` cannot:
 *   - a `string`    → this table renames the dimension's column; use it.
 *   - `null`        → DROP this dimension for this table (no predicate emitted) —
 *                     returns `undefined`, so the caller keeps its OTHER dimensions
 *                     (e.g. tenant) while suppressing this one. This is what lets a
 *                     joined table stay tenant-scoped without a region/department
 *                     column, instead of collapsing to a fully-unscoped `null`.
 *   - `undefined`   → INHERIT the supplied `fallback` default.
 */
function resolveDimension(
  overrideValue: string | null | undefined,
  fallback: string | undefined,
): string | undefined {
  if (overrideValue === null) {
    return undefined;
  }
  return overrideValue ?? fallback;
}

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
 * The tenant column is `perTable[table]?.tenant ?? resolvedTenantColumn`, where
 * `resolvedTenantColumn` is derived from the caller's `TenancyConfig`
 * (`tenancy.tenantColumn` for multi-tenant, `undefined` for single-tenant) — a
 * per-table override still wins for a table using a different tenant-column name.
 * The region/department names fall back to the historical hardcoded defaults
 * (`region_id`, `department`).
 */
export function resolvePrimarySecurityColumns(
  table: string,
  config: SecurityColumnsConfig | undefined,
  resolvedTenantColumn: string | undefined,
): SecurityColumns {
  const override: SecurityColumnOverride | null | undefined = config?.perTable?.[table];
  return {
    tenant: resolveDimension(override?.tenant, resolvedTenantColumn),
    region: resolveDimension(override?.region, config?.region ?? 'region_id'),
    department: resolveDimension(override?.department, config?.department ?? 'department'),
  };
}

/**
 * Resolve the security column names for a JOINED table.
 *
 * SECURITY — joined tables are scoped by DEFAULT (fail-closed). A joined table
 * with no `perTable` entry INHERITS the same resolved tenant/region/department
 * column names as the primary table (most multi-tenant schemas share one
 * tenant-column-name convention across every table). This closes the
 * cross-tenant fan-out leak where a tenant-filtered primary table `LEFT JOIN`s
 * an unregistered table on a non-unique key (e.g. `region_id`) and pulls in
 * every other tenant's rows that share that key.
 *
 * A per-table entry may override individual column names for a joined table that
 * uses a different convention (e.g. `perTable: { customers: { tenant: 'org_id' } }`).
 * The inherited tenant column is `perTable[table]?.tenant ?? resolvedTenantColumn`
 * (the tenant column derived from the caller's `TenancyConfig`, matching the
 * primary table).
 *
 * PER-DIMENSION OPT-OUT (finding 2.1) — a joined table that carries `tenant_id`
 * but has NO region/department column (e.g. an audit-log or line-item table) sets
 * an individual dimension to `null` — `perTable[table] = { region: null,
 * department: null }` — to KEEP tenant scoping while dropping the region/department
 * predicates that would otherwise reference a non-existent column. This is distinct
 * from the whole-entry opt-out below: it drops only the named dimension(s), never
 * the tenant predicate, so a region/department-restricted caller can still join the
 * table (tenant-scoped) instead of being forced onto the fully-unscoped `null`
 * escape hatch (which re-opens the cross-tenant fan-out on a non-unique join key).
 *
 * WHOLE-TABLE OPT-OUT — a genuinely shared/lookup table that has no tenant column
 * (e.g. a country-codes table) opts out of ALL scoping with an explicit
 * `perTable[table] = null` sentinel, which returns `undefined` (no predicate). This
 * is deliberate: a table joins unscoped ONLY when the host explicitly declares it
 * shared, never merely because the host forgot to register it.
 *
 * Returns `undefined` only when the table is explicitly opted out (shared lookup).
 */
export function resolveJoinSecurityColumns(
  table: string,
  config: SecurityColumnsConfig | undefined,
  resolvedTenantColumn: string | undefined,
): SecurityColumns | undefined {
  const override: SecurityColumnOverride | null | undefined = config?.perTable?.[table];
  // Whole-table opt-out: this joined table is a shared/lookup table with no tenant
  // column and must join unscoped.
  if (override === null) {
    return undefined;
  }
  // Default: inherit the primary table's resolved security columns (fail-closed),
  // letting an explicit per-table entry rename individual columns or drop an
  // individual dimension via a per-dimension `null` (see `resolveDimension`).
  return {
    tenant: resolveDimension(override?.tenant, resolvedTenantColumn),
    region: resolveDimension(override?.region, config?.region ?? 'region_id'),
    department: resolveDimension(override?.department, config?.department ?? 'department'),
  };
}

/**
 * Apply the row-level security predicates for one table to a Knex query.
 *
 * Applied FIRST (before user filters) so they can never be overridden or
 * AND-ed away. Only the dimensions with a configured column name AND a present
 * claim are emitted.
 *
 * Region scope — `undefined` vs empty array are DIFFERENT claims and must not be
 * conflated:
 *   - `regionIds === undefined` → this deployment does not do region scoping;
 *     no region predicate is emitted (correctly unrestricted).
 *   - `regionIds === []` → the caller is authorized for ZERO regions and must
 *     see/affect zero region-scoped rows. This mirrors the empty-`in` convention
 *     in `applyPredicate`:
 *       - `mode: 'read'`  → emit `whereIn(col, [])`; Knex renders this as
 *         `1 = 0` (matches no rows) — NOT dropped, which would fail OPEN.
 *       - `mode: 'write'` → throw; silently dropping the scope would widen the
 *         UPDATE/DELETE beyond the caller's (empty) region set.
 *
 * Region VALUE type (finding 2.1) — `claims.regionIds` is typed `number[]`, but
 * `validateSecurityColumnValues` (`mutations/mutationBuilder.ts`) already treats
 * a TEXT-typed region column as a supported deployment shape: it compares a
 * client-supplied region value to `claims.regionIds` as strings so a legitimate
 * `"5"` isn't rejected against `[5]`. This predicate — the actual row-level-
 * security WHERE clause, shared by reads AND writes — used to `whereIn` the raw
 * numbers only, so that same TEXT-typed deployment would error (PostgreSQL:
 * `operator does not exist: text = integer`) or coerce inconsistently
 * (MySQL/SQLite) at the enforcement site even though the value-validator
 * explicitly accommodates it. Both the number and its string form are now
 * included in the `whereIn` list so a NUMERIC region column matches exactly as
 * before (the original numbers are still present) while a TEXT-typed one also
 * matches, reconciling this predicate with the value-validator's existing,
 * already-tested tolerance rather than picking one type and rejecting the
 * other's deployment shape.
 */
export function applySecurityPredicates(
  query: any,
  table: string,
  claims: JwtSecurityClaims,
  securityColumns: SecurityColumns | undefined,
  mode: 'read' | 'write',
): void {
  if (!securityColumns) {
    return;
  }

  if (securityColumns.tenant) {
    query.where(`${table}.${securityColumns.tenant}`, '=', claims.tenantId);
  }

  // Distinguish "no region scoping" (undefined) from "authorized for zero
  // regions" ([]). Only `undefined` skips the predicate.
  if (securityColumns.region && claims.regionIds !== undefined) {
    if (mode === 'write' && claims.regionIds.length === 0) {
      throw new Error(
        `MUI X Studio Server: The caller is authorized for zero regions (regionIds: []), ` +
          `so a region-scoped mutation on table "${table}" can match no row and is rejected. ` +
          `Silently dropping an empty region scope would widen the UPDATE/DELETE beyond the caller's regions. ` +
          `Grant at least one region, or use "regionIds: undefined" if this deployment is not region-scoped.`,
      );
    }
    // Read path (or write with a non-empty set): an empty list renders as
    // `1 = 0` in Knex, matching zero rows instead of failing open.
    //
    // Include both the numeric claim and its string form (finding 2.1) so this
    // predicate matches a TEXT-typed region column exactly the way
    // `validateSecurityColumnValues` already does for mutation `values` — see
    // the doc comment above. `[].flatMap(...)` stays `[]`, so the empty-scope
    // `1 = 0` behavior above is unaffected.
    const regionMatchValues = claims.regionIds.flatMap((id) => [id, String(id)]);
    query.whereIn(`${table}.${securityColumns.region}`, regionMatchValues);
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
      // Runtime-guard the array shape (finding 3.1). `FilterPredicate.value` is
      // client JSON, so its TS type is not a runtime guarantee: a bare string
      // (`"abc"`) has a truthy non-zero `.length` and would reach `whereIn` as a
      // non-array, and a number/object has no meaningful `.length` at all. Fail
      // closed with a clear message rather than emitting malformed SQL / a
      // confusing DB error. Values still stay parameterized either way.
      if (!Array.isArray(value)) {
        throw new Error(
          `MUI X Studio Server: "in" predicate on column "${column}" requires an array value, but received ${typeof value}. ` +
            `An "in" filter matches against a list, so a non-array value cannot be translated to a valid SQL "IN (...)" clause. ` +
            `Provide the values as an array (e.g. { operator: "in", value: [1, 2, 3] }).`,
        );
      }
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
      // Runtime-guard the array shape (finding 3.1). A `between` needs exactly two
      // bounds `[lo, hi]`; a non-array (or a short array) destructures to
      // `undefined` bounds and emits malformed SQL. Fail closed with a clear
      // message. Bounds still stay parameterized.
      if (!Array.isArray(value) || value.length !== 2) {
        throw new Error(
          `MUI X Studio Server: "between" predicate on column "${column}" requires a two-element [low, high] array, but received ${
            Array.isArray(value) ? `an array of length ${value.length}` : typeof value
          }. ` +
            `A "between" filter compares against an inclusive lower and upper bound, so it cannot be translated without exactly two values. ` +
            `Provide the bounds as a two-element array (e.g. { operator: "between", value: [10, 20] }).`,
        );
      }
      const [lo, hi] = value;
      query.whereBetween(column, [lo, hi]);
      break;
    }
    // Every reachable `operator` is a member of `SAFE_OPERATORS` (checked above,
    // throwing otherwise) and has an explicit `case` here, so this arm is
    // unreachable in practice (finding 3.2). Kept only to satisfy the `eslint`
    // `default-case` rule, which requires an explicit default.
    default:
      break;
  }
}
