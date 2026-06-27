/**
 * Secure Knex mutation builder for @mui/x-studio-data-middleware.
 *
 * Applies the same security invariants as `buildSecureQuery` to write operations:
 *   1. Tenant column is set unconditionally on INSERT and scoped unconditionally
 *      on UPDATE/DELETE — clients cannot override or remove it.
 *   2. Column values are bound via Knex parameterized bindings (never string concat).
 *   3. Table and column names are validated against caller-supplied allowlists
 *      BEFORE reaching these functions (see `validateMutation` below).
 *   4. UPDATE and DELETE require at least one `where` predicate to prevent
 *      accidental full-table mutations.
 *   5. The tenant column is stripped from client-supplied `values` for updates —
 *      a client can never move a row to a different tenant.
 *
 * OWASP note: Parameterized queries (Defense Option 1) are used throughout.
 * No raw SQL strings are constructed from user input.
 */
import type {
  JwtSecurityClaims,
  MutationDescriptor,
  FilterPredicate,
  HandleMutationOptions,
} from '../security/types';

/**
 * Validate a mutation descriptor before building the query.
 * Throws with a descriptive message on any security or invariant violation.
 */
export function validateMutation(
  descriptor: MutationDescriptor,
  options: Pick<HandleMutationOptions, 'writableColumns' | 'tenantColumn' | 'columnAllowlist'>,
): void {
  // Require WHERE for update/delete — prevents full-table mutations.
  if (descriptor.operation !== 'insert' && (!descriptor.where || descriptor.where.length === 0)) {
    throw new Error(
      `MUI X Studio Server: "${descriptor.operation}" mutation on table "${descriptor.table}" ` +
        `requires at least one "where" predicate to prevent unscoped mutations.`,
    );
  }

  // Validate where-predicate columns against the column allowlist — mirrors the
  // read path (handler.ts validateColumns) so a client cannot reference arbitrary
  // columns (e.g. to probe rows by hidden columns via the affected-row count).
  if (options.columnAllowlist && descriptor.where) {
    for (const pred of descriptor.where) {
      const dotIdx = pred.column.indexOf('.');
      const table = dotIdx !== -1 ? pred.column.slice(0, dotIdx) : descriptor.table;
      const column = dotIdx !== -1 ? pred.column.slice(dotIdx + 1) : pred.column;
      const allowed = options.columnAllowlist[table];
      if (allowed && !allowed.includes(column)) {
        throw new Error(
          `MUI X Studio Server: Column "${column}" on table "${table}" is not in the column allowlist ` +
            `for "where" predicates. Allowed columns for "${table}": ${allowed.join(', ')}`,
        );
      }
    }
  }

  // Validate value keys against the writable columns allowlist.
  if (options.writableColumns) {
    const allowed = options.writableColumns[descriptor.table];
    if (allowed) {
      for (const col of Object.keys(descriptor.values ?? {})) {
        // Reject the tenant column from client values — the server always sets it.
        if (col === options.tenantColumn) {
          throw new Error(
            `MUI X Studio Server: Column "${col}" cannot be set by client mutations ` +
              `(it is the tenant isolation column and is controlled by the server).`,
          );
        }
        if (!allowed.includes(col)) {
          throw new Error(
            `MUI X Studio Server: Column "${col}" is not in the writable columns allowlist ` +
              `for table "${descriptor.table}". Allowed: ${allowed.join(', ')}`,
          );
        }
      }
    }
  }
}

/**
 * Build a parameterized INSERT query.
 *
 * The tenant column (if configured) is unconditionally injected from `claims`,
 * overriding any client-supplied value.
 *
 * Returns a Knex query builder — await the result to execute and get the
 * inserted row ID(s) or row count.
 */
export function buildInsertMutation(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: MutationDescriptor,
  tenantColumn?: string,
): any {
  const values: Record<string, unknown> = { ...descriptor.values };

  // Unconditionally set the tenant column — clients cannot set it to another tenant.
  if (tenantColumn) {
    values[tenantColumn] = claims.tenantId;
  }

  return db(descriptor.table).insert(values);
}

/**
 * Build a parameterized UPDATE query.
 *
 * Tenant isolation (`WHERE tenantColumn = claims.tenantId`) is added
 * unconditionally before user-supplied WHERE predicates. The tenant column is
 * stripped from the values being updated so a client cannot re-assign a row
 * to a different tenant.
 *
 * Returns a Knex query builder — await to get the number of rows updated.
 */
export function buildUpdateMutation(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: MutationDescriptor,
  tenantColumn?: string,
): any {
  const query = db(descriptor.table);

  // Unconditional tenant scope — must be first so it cannot be AND-ed away.
  if (tenantColumn) {
    query.where(`${descriptor.table}.${tenantColumn}`, '=', claims.tenantId);
  }

  for (const pred of descriptor.where ?? []) {
    applyMutationPredicate(query, pred);
  }

  // Strip tenant column from update values — never let a client move a row
  // from one tenant to another.
  const values: Record<string, unknown> = { ...descriptor.values };
  if (tenantColumn) {
    delete values[tenantColumn];
  }

  return query.update(values);
}

/**
 * Build a parameterized DELETE query.
 *
 * Tenant isolation is unconditional. User-supplied WHERE predicates are applied
 * after the tenant scope predicate.
 *
 * Returns a Knex query builder — await to get the number of rows deleted.
 */
export function buildDeleteMutation(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: MutationDescriptor,
  tenantColumn?: string,
): any {
  const query = db(descriptor.table);

  if (tenantColumn) {
    query.where(`${descriptor.table}.${tenantColumn}`, '=', claims.tenantId);
  }

  for (const pred of descriptor.where ?? []) {
    applyMutationPredicate(query, pred);
  }

  return query.delete();
}

/**
 * Apply a WHERE predicate to a Knex mutation query.
 * Reuses the same FilterPredicate type as read queries — same operators, same bindings.
 */
function applyMutationPredicate(query: any, predicate: FilterPredicate): void {
  const { column, operator, value } = predicate;
  switch (operator) {
    case 'eq':
      query.where(column, '=', value);
      break;
    case 'neq':
      query.where(column, '!=', value);
      break;
    case 'in':
      if ((value as unknown[]).length === 0) {
        break;
      }
      query.whereIn(column, value as unknown[]);
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
    case 'between': {
      const [lo, hi] = value;
      query.whereBetween(column, [lo, hi]);
      break;
    }
    case 'like':
      query.whereLike(column, value);
      break;
    default:
      break;
  }
}
