/**
 * Secure Knex mutation builder for @mui/x-studio-data-middleware.
 *
 * Applies the same security invariants as `buildSecureQuery` to write operations:
 *   1. Tenant column is set unconditionally on INSERT and scoped unconditionally
 *      on UPDATE/DELETE — clients cannot override or remove it. The tenant column
 *      is resolved via `resolvePrimarySecurityColumns` from the required
 *      `TenancyConfig` (multi-tenant → `tenancy.tenantColumn`, with an optional
 *      `securityColumns.perTable[t].tenant` override; single-tenant → no tenant
 *      column), exactly as the read/update/delete paths do.
 *   2. Column values are bound via Knex parameterized bindings (never string concat).
 *   3. Table and column names are validated against caller-supplied allowlists
 *      BEFORE reaching these functions (see `validateMutation` below).
 *   4. UPDATE and DELETE require at least one `where` predicate to prevent
 *      accidental full-table mutations.
 *   5. The tenant column is stripped from client-supplied `values` for updates —
 *      a client can never move a row to a different tenant. Table-qualified
 *      `values` keys (`table.column`) are rejected outright: mutation values
 *      always target exactly one table, so a qualified key is malformed input and
 *      would otherwise bypass the row-level-security scope check below (which
 *      matches on bare column names).
 *   6. Region/department scope is validated on INSERT/UPDATE values so a caller
 *      restricted to a region/department cannot write outside it.
 *
 * OWASP note: Parameterized queries (Defense Option 1) are used throughout.
 * No raw SQL strings are constructed from user input.
 */
import type {
  JwtSecurityClaims,
  MutationDescriptor,
  HandleMutationOptions,
  SecurityColumns,
} from '../security/types';
import { applyPredicates, applySecurityPredicates } from '../shared/predicates';
import { checkColumnAgainstAllowlist } from '../shared/columnValidation';
import {
  toCompiledSecurityPolicy,
  type CompiledSecurityPolicy,
  type SecurityPolicyOptions,
} from '../security/compileSecurityPolicy';

/**
 * Resolve the PRIMARY-table security columns through a `CompiledSecurityPolicy`.
 *
 * - Compiled policy (the request path) → used as-is (no recompile).
 * - Raw `SecurityPolicyOptions` (direct callers) → compiled on the spot, so the
 *   resolution chain runs inside `compileSecurityPolicy` and never inline here.
 *
 * There is no legacy string arm: the ONLY way to configure tenancy is the
 * `tenancy` field inside a `SecurityPolicyOptions` / `CompiledSecurityPolicy`.
 */
function resolvePrimaryCols(
  table: string,
  policy: CompiledSecurityPolicy | SecurityPolicyOptions,
): SecurityColumns {
  return toCompiledSecurityPolicy(policy).forPrimaryTable(table);
}

/**
 * Reject any table-qualified key (`table.column`) in a mutation's `values`.
 *
 * Mutation `values` always target exactly ONE table, so keys must be bare column
 * names. A qualified key is malformed input on two counts: Knex would render it as
 * a qualified identifier in an INSERT column list / UPDATE SET clause (invalid SQL
 * on mainstream databases), and — more importantly — it would slip past the
 * row-level-security scope checks in `validateSecurityColumnValues`, which match on
 * bare column names, letting a caller stamp e.g. `'orders.region_id'` outside their
 * scope. We mirror the `indexOf('.')` convention used by `checkColumnAgainstAllowlist`.
 */
function rejectQualifiedValueKeys(values: Record<string, unknown>, table: string): void {
  for (const key of Object.keys(values)) {
    if (key.includes('.')) {
      throw new Error(
        `MUI X Studio Server: Mutation value key "${key}" is table-qualified. ` +
          `Mutation values always target exactly one table ("${table}"), so keys must be bare column names — ` +
          `a qualified key would bypass row-level-security scope validation. ` +
          `Use the bare column name instead.`,
      );
    }
  }
}

/**
 * Validate the row-level-security scope carried in a mutation's `values`.
 *
 * - The tenant column may never be client-supplied (the server sets it).
 * - When the caller is region/department restricted, any region/department value
 *   present in `values` must fall inside the caller's scope — otherwise a
 *   region-5 user could stamp a row into region 6.
 */
function validateSecurityColumnValues(
  values: Record<string, unknown>,
  claims: JwtSecurityClaims,
  cols: SecurityColumns,
): void {
  if (cols.tenant && Object.prototype.hasOwnProperty.call(values, cols.tenant)) {
    throw new Error(
      `MUI X Studio Server: Column "${cols.tenant}" cannot be set by client mutations ` +
        `(it is the tenant isolation column and is controlled by the server).`,
    );
  }

  // Distinguish "no region scoping" (`regionIds === undefined`) from "authorized
  // for zero regions" (`regionIds === []`). With `[]`, `[].includes(region)` is
  // always false, so ANY region value in `values` is (correctly) rejected — a
  // caller scoped to zero regions must not be able to stamp a row into any region.
  if (
    cols.region &&
    claims.regionIds !== undefined &&
    Object.prototype.hasOwnProperty.call(values, cols.region)
  ) {
    const region = values[cols.region];
    // Compare as strings on both sides. `claims.regionIds` is typed `number[]`,
    // but a deployment whose region column is TEXT-typed sends a string region
    // value; a strict `Array.prototype.includes` (SameValueZero) comparison would
    // then never match `"5"` against `[5]` and reject a legitimate scoped write
    // with a confusing "outside the caller's permitted regions" error. Normalizing
    // both sides keeps this direction fail-closed (a value not in the permitted set
    // still throws) while tolerating a numeric/string type mismatch.
    if (!claims.regionIds.some((id) => String(id) === String(region))) {
      throw new Error(
        `MUI X Studio Server: Column "${cols.region}" value "${String(region)}" is outside the caller's permitted regions. ` +
          `A mutation cannot write a row into a region the caller cannot access. ` +
          `Permitted region(s): ${claims.regionIds.join(', ') || '(none)'}.`,
      );
    }
  }

  if (
    cols.department &&
    claims.department &&
    Object.prototype.hasOwnProperty.call(values, cols.department) &&
    values[cols.department] !== claims.department
  ) {
    throw new Error(
      `MUI X Studio Server: Column "${cols.department}" value "${String(values[cols.department])}" is outside the caller's department. ` +
        `A mutation cannot write a row into a department the caller does not belong to. ` +
        `Caller department: "${claims.department}".`,
    );
  }
}

/**
 * Validate a mutation descriptor before building the query.
 * Throws with a descriptive message on any security or invariant violation.
 */
export function validateMutation(
  descriptor: MutationDescriptor,
  claims: JwtSecurityClaims,
  options: Pick<HandleMutationOptions, 'writableColumns' | 'columnAllowlist'> & {
    /**
     * Security policy governing tenant/region/department scope for this table.
     * Either the pre-compiled policy threaded once from `handleMutation`, or raw
     * `SecurityPolicyOptions` (direct callers). REQUIRED — an explicit tenancy
     * decision is never optional at an enforcement site.
     */
    policy: CompiledSecurityPolicy | SecurityPolicyOptions;
  },
): void {
  // Require WHERE for update/delete — prevents full-table mutations.
  if (descriptor.operation !== 'insert' && (!descriptor.where || descriptor.where.length === 0)) {
    throw new Error(
      `MUI X Studio Server: "${descriptor.operation}" mutation on table "${descriptor.table}" ` +
        `requires at least one "where" predicate to prevent unscoped mutations.`,
    );
  }

  // Resolve the security columns for this table once, through the compiled
  // policy — the same resolution the read/update/delete paths use.
  const cols = resolvePrimaryCols(descriptor.table, options.policy);

  // Validate where-predicate columns against the column allowlist — mirrors the
  // read path so a client cannot reference arbitrary columns (e.g. to probe rows
  // by hidden columns via the affected-row count). Fail-closed + `'*'`-aware via
  // the shared helper.
  if (options.columnAllowlist && descriptor.where) {
    for (const pred of descriptor.where) {
      checkColumnAgainstAllowlist(pred.column, descriptor.table, options.columnAllowlist, 'where');
    }
  }

  // Enforce row-level-security scope carried in `values` (tenant / region /
  // department) — independent of the writable-columns allowlist.
  const values = descriptor.values ?? {};
  // Qualified keys (`table.column`) are rejected before any scope check — they
  // are malformed input and would otherwise dodge the bare-name scope matching.
  rejectQualifiedValueKeys(values, descriptor.table);
  validateSecurityColumnValues(values, claims, cols);

  // Validate value keys against the writable columns allowlist. Fail-closed +
  // `'*'`-aware via the shared helper (a table with no entry is rejected).
  if (options.writableColumns) {
    for (const col of Object.keys(values)) {
      checkColumnAgainstAllowlist(col, descriptor.table, options.writableColumns, 'values');
    }
  }
}

/**
 * Build a parameterized INSERT query.
 *
 * The tenant column (resolved from the required `TenancyConfig`, with an optional
 * `securityColumns.perTable` override) is unconditionally injected from `claims`,
 * overriding any client-supplied value.
 *
 * Returns a Knex query builder — await the result to execute and get the
 * inserted row ID(s) or row count.
 */
export function buildInsertMutation(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: MutationDescriptor,
  policy: CompiledSecurityPolicy | SecurityPolicyOptions,
): any {
  // Defense-in-depth: reject qualified keys even for direct callers that skip
  // `validateMutation`, so a dotted key can never reach the Knex insert payload.
  rejectQualifiedValueKeys(descriptor.values ?? {}, descriptor.table);
  const values: Record<string, unknown> = { ...descriptor.values };
  const cols = resolvePrimaryCols(descriptor.table, policy);

  // Unconditionally set the tenant column — clients cannot set it to another tenant.
  if (cols.tenant) {
    values[cols.tenant] = claims.tenantId;
  }

  return db(descriptor.table).insert(values);
}

/**
 * Build a parameterized UPDATE query.
 *
 * Row-level security predicates (tenant + region + department) are added
 * unconditionally before user-supplied WHERE predicates — the same set enforced
 * on reads, so a user restricted to region 5 cannot UPDATE rows in other regions.
 * The tenant column is stripped from the values being updated so a client cannot
 * re-assign a row to a different tenant.
 *
 * Returns a Knex query builder — await to get the number of rows updated.
 */
export function buildUpdateMutation(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: MutationDescriptor,
  policy: CompiledSecurityPolicy | SecurityPolicyOptions,
): any {
  const query = db(descriptor.table);
  const cols = resolvePrimaryCols(descriptor.table, policy);

  // Unconditional security scope — applied first so it cannot be AND-ed away.
  // 'write' mode: an empty region scope (`regionIds: []`) throws rather than
  // silently dropping the region predicate and widening the mutation.
  applySecurityPredicates(query, descriptor.table, claims, cols, 'write');

  // 'write' mode: an empty `in` list or an unknown operator throws rather than
  // silently widening the mutation to the whole tenant table.
  applyPredicates(query, descriptor.where, 'write');

  // Defense-in-depth: reject qualified keys even for direct callers that skip
  // `validateMutation`, so a dotted key can never reach the Knex update payload.
  rejectQualifiedValueKeys(descriptor.values ?? {}, descriptor.table);

  // Strip tenant column from update values — never let a client move a row
  // from one tenant to another.
  const values: Record<string, unknown> = { ...descriptor.values };
  if (cols.tenant) {
    delete values[cols.tenant];
  }

  return query.update(values);
}

/**
 * Build a parameterized DELETE query.
 *
 * Row-level security predicates (tenant + region + department) are unconditional.
 * User-supplied WHERE predicates are applied after the security scope predicates.
 *
 * Returns a Knex query builder — await to get the number of rows deleted.
 */
export function buildDeleteMutation(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: MutationDescriptor,
  policy: CompiledSecurityPolicy | SecurityPolicyOptions,
): any {
  const query = db(descriptor.table);
  const cols = resolvePrimaryCols(descriptor.table, policy);

  applySecurityPredicates(query, descriptor.table, claims, cols, 'write');

  // 'write' mode: an empty `in` list or an unknown operator throws rather than
  // silently widening the mutation to the whole tenant table.
  applyPredicates(query, descriptor.where, 'write');

  return query.delete();
}
