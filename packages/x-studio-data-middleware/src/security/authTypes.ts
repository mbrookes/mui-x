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
 *     // a shared lookup table with no tenant column — opt out of scoping
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
   * - An object overrides individual security-column names for that table.
   * - `null` marks a shared/lookup table that has no tenant column and must join
   *   unscoped (the only way to opt a joined table OUT of the default inheritance).
   */
  perTable?: Record<string, SecurityColumns | null>;
}
