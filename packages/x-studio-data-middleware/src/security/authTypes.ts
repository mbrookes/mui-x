/**
 * Security types for @mui/x-studio-data-middleware.
 *
 * The host application extracts these from its auth middleware (JWT, session,
 * OAuth token, etc.) and passes them to handleBatchQuery(). The server package
 * never performs authentication itself — it only consumes pre-verified claims.
 *
 * SECURITY: All claim values MUST be pre-verified before construction.
 * Values are injected as Knex parameterized bindings (never string-concatenated).
 */
export interface JwtSecurityClaims {
  /** Tenant (organization) identifier — primary isolation boundary */
  tenantId: string;
  /** Authenticated user ID */
  userId: string;
  /** Role IDs the user holds */
  roleIds: string[];
  /**
   * Optional row-level access: regions the user may see.
   * When present, queries are restricted to these regions.
   * When undefined, no region restriction is applied.
   */
  regionIds?: number[];
  /**
   * Optional row-level access: department the user belongs to.
   * When present, queries are restricted to this department.
   * When undefined, no department restriction is applied.
   */
  department?: string;
}

/**
 * Column names used to apply row-level security predicates to a table.
 *
 * All three are optional. A missing name means that dimension is not scoped for
 * the table in question:
 *   - `tenant` — the multi-tenancy column (`WHERE table.tenant = claims.tenantId`)
 *   - `region` — restricted to `claims.regionIds` via `WHERE table.region IN (...)`
 *   - `department` — restricted to `claims.department`
 */
export interface SecurityColumns {
  /** Column used for tenant isolation. */
  tenant?: string;
  /** Column checked against `claims.regionIds`. */
  region?: string;
  /** Column checked against `claims.department`. */
  department?: string;
}

/**
 * A per-table security-column override entry (the value of a `perTable[table]`).
 *
 * Distinct from the RESOLVED `SecurityColumns` (which only ever carries the final
 * string column names or `undefined`) because an override must express THREE
 * intents per dimension, not two:
 *
 *   - a `string` — this table uses a different column NAME for the dimension;
 *   - `undefined` / key absent — INHERIT the default (the primary table's resolved
 *     column name for the dimension);
 *   - `null` — DROP this one dimension for this table while keeping the others.
 *
 * The per-dimension `null` (finding 2.1) is what lets a joined table stay
 * tenant-scoped while dropping region/department — e.g. `{ region: null }` keeps
 * the inherited tenant predicate but emits no `region_id IN (...)` clause, for a
 * table (audit log, line-item) that carries `tenant_id` but has no region column.
 * Previously the only way to suppress the region predicate was `perTable[table] =
 * null`, which also dropped the tenant predicate (re-opening the cross-tenant
 * fan-out). A whole-entry `null` still opts the ENTIRE table out of scoping (a
 * genuinely shared/lookup table); a per-dimension `null` drops only that dimension.
 */
export interface SecurityColumnOverride {
  /** Tenant column name, `null` to drop tenant scoping for this table, or absent to inherit. */
  tenant?: string | null;
  /** Region column name, `null` to drop region scoping for this table, or absent to inherit. */
  region?: string | null;
  /** Department column name, `null` to drop department scoping for this table, or absent to inherit. */
  department?: string | null;
}

/**
 * Tenancy posture — REQUIRED on HandleBatchQueryOptions / HandleMutationOptions.
 * There is no default: a deployment must explicitly declare single-tenant.
 */
export type TenancyConfig =
  | {
      mode: 'multi-tenant';
      /**
       * Default tenant-isolation column for every table.
       * `securityColumns.perTable[t].tenant` overrides the name per table;
       * `securityColumns.perTable[t] = null` opts a shared/lookup table out entirely.
       */
      tenantColumn: string;
    }
  | { mode: 'single-tenant' };

/**
 * Row-level-security column configuration.
 *
 * The top-level `region` / `department` names act as defaults for the primary
 * table (they default to `'region_id'` and `'department'` respectively). The
 * global tenant column is declared in exactly one place — `tenancy.tenantColumn`
 * — never here. Per-table overrides — and the explicit opt-out that marks a
 * **joined** table as an unscoped shared/lookup table — go in `perTable`.
 *
 * SECURITY — joined tables are scoped by DEFAULT (fail-closed). A joined table
 * with no `perTable` entry inherits the primary table's resolved
 * tenant/region/department column names, so an unregistered join can no longer
 * silently fan out to every tenant's rows. A per-table entry overrides the
 * column names for a table using a different convention.
 *
 * OPT-OUT — a genuinely shared/lookup table with no tenant column (e.g. a
 * country-codes table) opts out with `perTable[table] = null`, which joins it
 * unscoped. A table joins unscoped ONLY when explicitly declared shared.
 *
 * @example
 * securityColumns: {
 *   // primary table uses a non-default region column
 *   region: 'sales_region',
 *   perTable: {
 *     // a joined table that uses a different tenant column name
 *     customers: { tenant: 'org_id', region: 'region_id' },
 *     // a joined table that carries tenant_id but has NO region/department column:
 *     // keep tenant scoping, drop region/department (per-dimension opt-out)
 *     audit_log: { region: null, department: null },
 *     // a shared lookup table with no tenant column — opt out of scoping entirely
 *     country_codes: null,
 *   },
 * }
 */
export interface SecurityColumnsConfig {
  /** Column checked against `claims.regionIds` for the primary table (default `region_id`). */
  region?: string;
  /** Column checked against `claims.department` for the primary table (default `department`). */
  department?: string;
  /**
   * Per-table column overrides.
   *
   * - An object (`SecurityColumnOverride`) overrides individual security-column
   *   names for that table. A `string` renames the dimension's column; `null` for
   *   a single dimension DROPS just that dimension (keeping the others — e.g.
   *   `{ region: null }` stays tenant-scoped but emits no region predicate).
   * - `null` for the whole entry marks a shared/lookup table that has no tenant
   *   column and must join unscoped (opts the table OUT of the default inheritance
   *   entirely).
   */
  perTable?: Record<string, SecurityColumnOverride | null>;
}
