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
 * The comparison operators that reach Knex's `.where(column, op, value)` with a
 * single scalar value. Their `value` shape is runtime-guarded in `applyPredicate`
 * (finding 3.1), mirroring the existing `in` (array) and `between` (2-tuple) guards.
 */
const SCALAR_COMPARISON_OPERATORS = new Set<FilterPredicate['operator']>([
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
]);

/**
 * Is `value` a legitimate scalar for a comparison predicate?
 *
 * `FilterPredicate`'s TS types allow only `string | number | boolean` for these
 * operators; `Date` is additionally accepted because a date-typed column value
 * legitimately flows through the pipeline as a `Date` and must compare, not throw.
 * `null` is also allowed: the `eq`/`neq` cases in `applyPredicate` special-case it
 * to `whereNull`/`whereNotNull` (Knex's 3-arg `.where(col, '=', null)` renders the
 * never-true `col = NULL`, NOT `col IS NULL` — only the 2-arg / `'is'` forms get
 * the null→whereNull conversion), a supported filter — rejecting it would regress
 * that behavior. Only a non-null object / array / `undefined` (which have no
 * meaningful single-value SQL comparison) are rejected fail-closed.
 */
function isScalarComparisonValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  );
}

/**
 * Look up a table's per-table security-column override, own-property-gated.
 *
 * SECURITY (finding 2.2) — `table` is client JSON (`descriptor.table` /
 * `joins[].table`). A bare `config.perTable[table]` reads the prototype chain, so a
 * table named like an `Object.prototype` member (`constructor`, `toString`,
 * `hasOwnProperty`, `__proto__`, …) would resolve `override` to a truthy INHERITED
 * object instead of `undefined` — the one client-keyed lookup shape in the package
 * that was not `hasOwnProperty`-gated like every sibling
 * (`columnValidation`, `mutationBuilder`, `queryBuilder`, `validateQueryPlan`).
 * Gating with `Object.prototype.hasOwnProperty.call` makes such a table fall through
 * to the "no per-table override" default (own properties only), and also makes the
 * lookup immune to host-side prototype pollution.
 */
function lookupPerTableOverride(
  config: SecurityColumnsConfig | undefined,
  table: string,
): SecurityColumnOverride | null | undefined {
  if (config?.perTable && Object.prototype.hasOwnProperty.call(config.perTable, table)) {
    return config.perTable[table];
  }
  return undefined;
}

/**
 * Resolve the security column names for the PRIMARY table of a query/mutation.
 *
 * The tenant column is `perTable[table]?.tenant ?? resolvedTenantColumn`, where
 * `resolvedTenantColumn` is derived from the caller's `TenancyConfig`
 * (`tenancy.tenantColumn` for multi-tenant, `undefined` for single-tenant) — a
 * per-table override still wins for a table using a different tenant-column name.
 * The region/department names fall back to the historical hardcoded defaults
 * (`region_id`, `department`).
 *
 * WHOLE-TABLE OPT-OUT (finding 2.3) — `perTable[table] = null` returns an empty
 * `SecurityColumns` (no predicates), so a host-declared shared/lookup table behaves
 * identically whether it is the PRIMARY table or a JOINED one. See the resolver body
 * and `resolveJoinSecurityColumns`.
 */
export function resolvePrimarySecurityColumns(
  table: string,
  config: SecurityColumnsConfig | undefined,
  resolvedTenantColumn: string | undefined,
): SecurityColumns {
  const override: SecurityColumnOverride | null | undefined = lookupPerTableOverride(config, table);
  // Whole-table opt-out (finding 2.3): `perTable[table] = null` is the host's
  // explicit "shared/lookup table with no security columns" sentinel. The joined
  // resolver already honors it; the primary resolver MUST too, or a shared table
  // (e.g. `country_codes`) queried AS the primary table — or mutated — emits a
  // predicate on a non-existent tenant/region/department column and fails every
  // such request forever. This mirrors `resolveJoinSecurityColumns`'s `null` branch:
  // the config is host-authored and already means "no security columns". An empty
  // `SecurityColumns` drops every predicate (via the downstream truthiness gates)
  // while keeping the object shape the mutation/predicate sites read (`cols.tenant`,
  // `cols.region`, `cols.department`) — the write path resolves through this same
  // function via `forPrimaryTable`, so it is aligned automatically.
  if (override === null) {
    return {};
  }
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
  const override: SecurityColumnOverride | null | undefined = lookupPerTableOverride(config, table);
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
  emitSecurityPredicates(
    table,
    claims,
    securityColumns,
    mode,
    (column, value) => query.where(column, '=', value),
    (column, values) => query.whereIn(column, values),
  );
}

/**
 * Apply the row-level security predicates for one table INSIDE a Knex JOIN's ON
 * clause (rather than the WHERE clause).
 *
 * OUTER-JOIN CORRECTNESS (finding 2.3) — a joined table's security predicate in
 * the WHERE clause silently degrades a LEFT/RIGHT JOIN to an INNER JOIN: for a
 * `LEFT JOIN customers`, an `orders` row with no matching customer produces a
 * NULL-extended row whose `customers.tenant_id` is NULL, so a
 * `WHERE customers.tenant_id = :tenant` predicate is false and the row the caller
 * explicitly asked to keep is dropped. Emitting the SAME predicate in the JOIN's
 * ON clause instead scopes which rows JOIN (a matched joined row is still
 * tenant-checked — no cross-tenant fan-out) while leaving genuinely-unmatched
 * outer rows NULL-extended and present. `buildSecureQuery` uses this for the
 * nullable side of each outer join and keeps WHERE placement for inner joins
 * (equivalent) and the non-nullable primary table.
 *
 * Uses Knex's `andOnVal`/`andOnIn` — the ON-clause analogues of `where`/`whereIn`
 * that bind the third argument as a VALUE (not an identifier), so the tenant/
 * region/department values stay parameterized exactly as on the WHERE path.
 */
export function applySecurityPredicatesToJoinOn(
  onBuilder: any,
  table: string,
  claims: JwtSecurityClaims,
  securityColumns: SecurityColumns | undefined,
  mode: 'read' | 'write',
): void {
  emitSecurityPredicates(
    table,
    claims,
    securityColumns,
    mode,
    (column, value) => onBuilder.andOnVal(column, '=', value),
    (column, values) => onBuilder.andOnIn(column, values),
  );
}

// Single source of truth for WHICH row-level security predicates a table gets and
// on which columns/values — shared by the WHERE-clause (`applySecurityPredicates`)
// and ON-clause (`applySecurityPredicatesToJoinOn`) emitters so the two can never
// drift on which dimensions are scoped, the `undefined`-vs-`[]` region semantics,
// the empty-string department distinction, or the numeric+string region matching.
// The callers (`emitEq`/`emitIn`) supply only the two Knex primitives — `.where`/
// `.andOnVal` and `.whereIn`/`.andOnIn` respectively — that differ between clauses.
function emitSecurityPredicates(
  table: string,
  claims: JwtSecurityClaims,
  securityColumns: SecurityColumns | undefined,
  mode: 'read' | 'write',
  emitEq: (column: string, value: unknown) => void,
  emitIn: (column: string, values: unknown[]) => void,
): void {
  if (!securityColumns) {
    return;
  }

  if (securityColumns.tenant) {
    emitEq(`${table}.${securityColumns.tenant}`, claims.tenantId);
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
    emitIn(`${table}.${securityColumns.region}`, regionMatchValues);
  }

  // `!== undefined` (not truthiness) — finding 3.3. `claims.department === ''`
  // used to be indistinguishable from "no department scoping" (both falsy),
  // silently FAILING OPEN: a caller whose department claim happened to be an
  // empty string saw/affected every department in its tenant, the opposite of
  // what a department-restricted claim should mean. Mirroring the region
  // dimension's `undefined`-vs-`[]` distinction above, only `undefined` means
  // "not department-scoped" now; a defined (even empty-string) department
  // always emits a real predicate, which — for a table with no literal
  // empty-string department value — matches no rows rather than every row.
  if (securityColumns.department && claims.department !== undefined) {
    emitEq(`${table}.${securityColumns.department}`, claims.department);
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

  // Runtime-guard the scalar shape (finding 3.1) for the comparison operators that
  // reach `.where(column, op, value)`. `FilterPredicate.value` is client JSON, so
  // its TS type is not a runtime guarantee: an array reaches Knex as an unexpected
  // multi-binding, and an object/undefined as a confusing DB error. These operators
  // compare against exactly ONE value, so require a scalar — mirroring the `in`
  // (array) and `between` (2-tuple) guards below. The value still stays parameterized.
  if (SCALAR_COMPARISON_OPERATORS.has(operator) && !isScalarComparisonValue(value)) {
    throw new Error(
      `MUI X Studio Server: "${operator}" predicate on column "${column}" requires a scalar value (string, number, boolean, or date), but received ${
        Array.isArray(value) ? 'an array' : typeof value
      }. ` +
        `A comparison filter compares against a single value, so a non-scalar value cannot be translated to a valid SQL comparison. ` +
        `Provide a single scalar value (e.g. { operator: "${operator}", value: 42 }).`,
    );
  }

  switch (operator) {
    case 'eq':
      // `null` must render as `IS NULL`, not the never-true `col = NULL`. Knex's
      // 3-arg `.where(col, '=', null)` emits `col = NULL` (matches no row); only
      // `.whereNull` produces the correct `col IS NULL`. Guarding here makes an
      // `eq null` filter return the rows whose column IS NULL instead of zero rows.
      if (value === null) {
        query.whereNull(column);
      } else {
        query.where(column, '=', value);
      }
      break;
    case 'neq':
      // Symmetric to `eq null`: `neq null` must render as `IS NOT NULL`, not the
      // never-true `col != NULL`.
      if (value === null) {
        query.whereNotNull(column);
      } else {
        query.where(column, '!=', value);
      }
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
      // Runtime-guard the string shape (finding 3.1). `query.whereLike` expects a
      // text pattern; a non-string (`['a','b']`, an object, a number) reaches Knex
      // as a confusing DB error. Fail closed with a clear message, mirroring the
      // `in`/`between` guards. The pattern still stays parameterized.
      if (typeof value !== 'string') {
        throw new Error(
          `MUI X Studio Server: "like" predicate on column "${column}" requires a string value, but received ${
            Array.isArray(value) ? 'an array' : typeof value
          }. ` +
            `A "like" filter matches a text pattern, so a non-string value cannot be translated to a valid SQL "LIKE" clause. ` +
            `Provide a string pattern (e.g. { operator: "like", value: "%abc%" }).`,
        );
      }
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
