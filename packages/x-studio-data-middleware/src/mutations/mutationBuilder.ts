/**
 * Secure Knex mutation builder for @mui/x-studio-data-middleware.
 *
 * Applies the same security invariants as `buildSecureQuery` to write operations:
 *   1. Tenant column is set unconditionally on INSERT and scoped unconditionally
 *      on UPDATE/DELETE — clients cannot override or remove it. The tenant column
 *      is resolved via `resolvePrimarySecurityColumns` (the newer `securityColumns`
 *      shape OR the legacy `tenantColumn`), exactly as the read/update/delete
 *      paths do — so an INSERT is stamped even when tenancy is configured only via
 *      `securityColumns`.
 *   2. Column values are bound via Knex parameterized bindings (never string concat).
 *   3. Table and column names are validated against caller-supplied allowlists
 *      BEFORE reaching these functions (see `validateMutation` below).
 *   4. UPDATE and DELETE require at least one `where` predicate to prevent
 *      accidental full-table mutations.
 *   5. The tenant column is stripped from client-supplied `values` for updates —
 *      a client can never move a row to a different tenant.
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
  SecurityColumnsConfig,
} from '../security/types';
import {
  applyPredicates,
  applySecurityPredicates,
  resolvePrimarySecurityColumns,
} from '../shared/predicates';
import { checkColumnAgainstAllowlist } from '../shared/columnValidation';

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

  if (
    cols.region &&
    claims.regionIds &&
    claims.regionIds.length > 0 &&
    Object.prototype.hasOwnProperty.call(values, cols.region)
  ) {
    const region = values[cols.region] as number;
    if (!claims.regionIds.includes(region)) {
      throw new Error(
        `MUI X Studio Server: Column "${cols.region}" value "${String(region)}" is outside the caller's permitted regions. ` +
          `A mutation cannot write a row into a region the caller cannot access. ` +
          `Permitted region(s): ${claims.regionIds.join(', ')}.`,
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
  options: Pick<
    HandleMutationOptions,
    'writableColumns' | 'tenantColumn' | 'columnAllowlist' | 'securityColumns'
  >,
): void {
  // Require WHERE for update/delete — prevents full-table mutations.
  if (descriptor.operation !== 'insert' && (!descriptor.where || descriptor.where.length === 0)) {
    throw new Error(
      `MUI X Studio Server: "${descriptor.operation}" mutation on table "${descriptor.table}" ` +
        `requires at least one "where" predicate to prevent unscoped mutations.`,
    );
  }

  // Resolve the security columns for this table once — the same resolution the
  // read/update/delete paths use (newer `securityColumns` OR legacy `tenantColumn`).
  const cols = resolvePrimarySecurityColumns(
    descriptor.table,
    options.securityColumns,
    options.tenantColumn,
  );

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
 * The tenant column (resolved from `securityColumns` or the legacy `tenantColumn`)
 * is unconditionally injected from `claims`, overriding any client-supplied value.
 *
 * Returns a Knex query builder — await the result to execute and get the
 * inserted row ID(s) or row count.
 */
export function buildInsertMutation(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: MutationDescriptor,
  tenantColumn?: string,
  securityColumns?: SecurityColumnsConfig,
): any {
  const values: Record<string, unknown> = { ...descriptor.values };
  const cols = resolvePrimarySecurityColumns(descriptor.table, securityColumns, tenantColumn);

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
  tenantColumn?: string,
  securityColumns?: SecurityColumnsConfig,
): any {
  const query = db(descriptor.table);
  const cols = resolvePrimarySecurityColumns(descriptor.table, securityColumns, tenantColumn);

  // Unconditional security scope — applied first so it cannot be AND-ed away.
  applySecurityPredicates(query, descriptor.table, claims, cols);

  // 'write' mode: an empty `in` list or an unknown operator throws rather than
  // silently widening the mutation to the whole tenant table.
  applyPredicates(query, descriptor.where, 'write');

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
  tenantColumn?: string,
  securityColumns?: SecurityColumnsConfig,
): any {
  const query = db(descriptor.table);
  const cols = resolvePrimarySecurityColumns(descriptor.table, securityColumns, tenantColumn);

  applySecurityPredicates(query, descriptor.table, claims, cols);

  // 'write' mode: an empty `in` list or an unknown operator throws rather than
  // silently widening the mutation to the whole tenant table.
  applyPredicates(query, descriptor.where, 'write');

  return query.delete();
}
