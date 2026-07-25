/**
 * Compile the row-level-security policy ONCE per request.
 *
 * Gap A (see the retrofit plan): the `(tenancy, securityColumns)` resolution
 * chain — `perTable[table]?.X ?? default` — was executed fresh at every
 * enforcement site (`buildSecureQuery`, and four sites in `mutationBuilder.ts`),
 * with the raw options threaded as loose arguments and no single "compiled"
 * object anywhere. This module centralizes the resolution into one boundary
 * object:
 *
 *   - `forPrimaryTable(table)` / `forJoinedTable(table)` resolve the security
 *     columns for a table (they delegate to `resolvePrimarySecurityColumns` /
 *     `resolveJoinSecurityColumns` in `shared/predicates.ts`), so centralizing
 *     changes WHERE the chain runs, never WHAT it resolves to for a given input.
 *   - `digest` is a stable hash of the resolved policy inputs — `tenancy`,
 *     `securityColumns`, and (when supplied) the `columnAllowlist` and
 *     `schemaAllowlist` — computed ONCE at compile time and folded into the cache
 *     key so two nodes running different config never serve one node's cached rows
 *     to the other node's differently-scoped requests (Gap B), and so two option
 *     sets in ONE process that expose different tables do not collide on the same
 *     shared cache (finding 3).
 *
 * SECURITY: tenancy is now an EXPLICIT, REQUIRED decision. A deployment declares
 * either `{ mode: 'multi-tenant', tenantColumn }` or `{ mode: 'single-tenant' }`
 * — there is no "forgot to configure a tenant column" state that silently
 * resolves to an unscoped, cross-tenant-leaking query. This is the previously
 * deferred, now separately-signed-off follow-up that makes a missing tenant
 * decision impossible to express by omission. `policy.tenancy.mode ===
 * 'multi-tenant'` is the single unambiguous tenancy check, and it can never drift
 * from enforcement because it comes from the same required input the resolvers use.
 */
import { createHash } from 'node:crypto';
import type { SecurityColumns, SecurityColumnsConfig, TenancyConfig } from './types';
import { resolveJoinSecurityColumns, resolvePrimarySecurityColumns } from '../shared/predicates';
import { sortedStringify } from './canonicalize';

/** The security-relevant subset of the handler/mutation options. */
export interface SecurityPolicyOptions {
  /** Tenancy posture — REQUIRED. Declares single-tenant or multi-tenant explicitly. */
  tenancy: TenancyConfig;
  /** Optional region/department + per-table row-level-security column overrides. */
  securityColumns?: SecurityColumnsConfig;
  /**
   * Per-table column allowlist (table name → allowed columns), mirroring
   * `HandleBatchQueryOptions.columnAllowlist` / `HandleMutationOptions.columnAllowlist`.
   *
   * Folded into `digest` so that tightening the allowlist (which columns a client
   * may see) produces a DIFFERENT cache key: previously-cached results computed
   * under a looser allowlist can no longer be served stale after the host locks
   * down column visibility. Omitting it is fully backward compatible — the digest
   * is byte-identical to one computed before this field existed.
   */
  columnAllowlist?: Record<string, string[]>;
  /**
   * Allowlist of tables this deployment may query, mirroring
   * `HandleBatchQueryOptions.schemaAllowlist`.
   *
   * Folded into `digest` — and therefore into the cache key — so that the set of
   * tables a request may reach is part of the cached result's identity (finding 3).
   * That gives the common multi-database deployment automatic cache separation at
   * zero configuration: the cache key is otherwise derived only from
   * `(claims, policy, descriptor)` and carries no data-source dimension, so one
   * process serving two logical databases through the module-singleton default
   * cache produced byte-identical keys and served DB-A's rows for DB-B. Two data
   * sources that expose different tables now key differently on their own.
   *
   * NOT a substitute for `HandleBatchQueryOptions.cacheScope`: two data sources
   * with the SAME table names (e.g. one database per region, identical schema)
   * still collide, and only an explicit `cacheScope` separates them. Omitting it
   * is fully backward compatible — the digest is byte-identical to one computed
   * before this field existed.
   */
  schemaAllowlist?: string[];
}

/**
 * The compiled row-level-security policy for one request.
 *
 * A single boundary object that resolves security columns per table (via the
 * shared resolvers) and carries a stable `digest` of its inputs.
 */
export interface CompiledSecurityPolicy {
  /** Resolve the security columns for the PRIMARY table of a query/mutation. */
  forPrimaryTable(table: string): SecurityColumns;
  /**
   * Resolve the security columns for a JOINED table. Returns `undefined` only
   * when the table is explicitly opted out (`perTable[table] = null` — a shared
   * or lookup table that joins unscoped).
   */
  forJoinedTable(table: string): SecurityColumns | undefined;
  /** Stable hash of the resolved policy inputs, computed ONCE at compile time. */
  readonly digest: string;
  /**
   * The declared tenancy posture, echoed back from the input.
   *
   * `tenancy.mode === 'multi-tenant'` is the single unambiguous check for whether
   * tenant scoping is in force; it can never drift from enforcement because the
   * resolvers derive the tenant column from this very value.
   */
  readonly tenancy: TenancyConfig;
}

/**
 * Canonicalize a column allowlist for hashing: sort the column list within each
 * table so the digest never depends on array element order. Table-name keys are
 * sorted by `sortedStringify` itself, so only the arrays need normalizing here.
 */
function canonicalizeColumnAllowlist(
  columnAllowlist: Record<string, string[]>,
): Record<string, string[]> {
  const canonical: Record<string, string[]> = {};
  for (const table of Object.keys(columnAllowlist)) {
    canonical[table] = [...columnAllowlist[table]].sort();
  }
  return canonical;
}

/**
 * Compute the stable digest of a policy's resolved inputs.
 *
 * Builds the `{ tenancy, securityColumns }` pair from the options so the digest
 * reflects both the tenancy posture and the row-level-security column config, and
 * — when supplied — the `columnAllowlist` so tightening column visibility yields a
 * different cache key, plus the `schemaAllowlist` so two option sets exposing
 * different TABLES (the ordinary shape of "one process, two logical databases")
 * key differently without any explicit `cacheScope` (finding 3). Both allowlists
 * are sorted before hashing so array order never changes the digest, and each key
 * is only present in the hashed input when supplied, so an omitted allowlist stays
 * byte-identical to a digest computed before it was folded in (backward
 * compatible).
 */
function computePolicyDigest(opts: SecurityPolicyOptions): string {
  const canonical = sortedStringify({
    tenancy: opts.tenancy,
    securityColumns: opts.securityColumns,
    ...(opts.columnAllowlist !== undefined && {
      columnAllowlist: canonicalizeColumnAllowlist(opts.columnAllowlist),
    }),
    ...(opts.schemaAllowlist !== undefined && {
      schemaAllowlist: [...opts.schemaAllowlist].sort(),
    }),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * The digest of the single-tenant (no row-level-security column) policy.
 *
 * Used as the default `policyDigest` for `generateCacheKey` callers that do not
 * supply one (e.g. direct unit tests), so their keys stay deterministic and
 * match what the handler stores for a single-tenant deployment.
 */
export const SINGLE_TENANT_POLICY_DIGEST = computePolicyDigest({
  tenancy: { mode: 'single-tenant' },
});

/**
 * Type guard: has this already been compiled into a `CompiledSecurityPolicy`?
 *
 * Lets the enforcement-path functions accept EITHER a compiled policy (threaded
 * once from the request handler) OR the raw `SecurityPolicyOptions` (passed by
 * direct unit-test callers), without breaking either.
 */
export function isCompiledSecurityPolicy(value: unknown): value is CompiledSecurityPolicy {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as CompiledSecurityPolicy).forPrimaryTable === 'function' &&
    typeof (value as CompiledSecurityPolicy).digest === 'string'
  );
}

/**
 * Is `value` a usable SQL column-name identifier at RUNTIME?
 *
 * A non-empty, non-whitespace-only string. `TenancyConfig.tenantColumn: string`
 * and the `SecurityColumnOverride` field types are compile-time only — the
 * realistic misconfiguration is a column name wired to an unset environment
 * variable (`undefined`) or an empty string, which this package's downstream
 * truthiness gates (`predicates.ts` `if (securityColumns.tenant)`, the
 * `mutationBuilder.ts` force-stamp / client-tenant-rejection sites) silently
 * treat as "this dimension is not scoped".
 */
function isUsableColumnName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Describe an invalid column-name value for a config-error message. */
function describeColumnValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined (e.g. an unset environment variable)';
  }
  if (value === null) {
    return 'null';
  }
  if (value === '') {
    return 'an empty string';
  }
  if (typeof value === 'string') {
    return 'a whitespace-only string';
  }
  return `a ${typeof value}`;
}

/**
 * Validate an OPTIONAL security-column override value (finding 2.1).
 *
 * `undefined` (inherit the default) and `null` (the documented drop / whole-entry
 * opt-out sentinel) are both legitimate. Any OTHER value must be a usable column
 * name: an empty / whitespace-only / non-string value is neither a rename nor the
 * `null` drop sentinel, and — because `resolveDimension('')` returns `''`, which
 * the downstream truthiness gate silently skips — it acts as an UNDOCUMENTED third
 * sentinel that quietly opts the dimension out of scoping (and, for `perTable.tenant`,
 * dodges the single-tenant contradiction check, which gates on `Boolean(entry.tenant)`).
 * Fail closed here at the single config choke point.
 */
function assertOptionalColumnName(value: unknown, label: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!isUsableColumnName(value)) {
    throw new Error(
      `MUI X Studio Server: ${label} is ${describeColumnValue(value)}, which is not a valid column name. ` +
        `An empty, whitespace-only, or non-string override silently disables that security dimension — it is neither a ` +
        `column rename (a non-empty string) nor the documented drop sentinel (null), so a scoped read/write would run ` +
        `unscoped. Use a real column name to rename the dimension, null to explicitly drop it, or omit the field to inherit the default.`,
    );
  }
}

/**
 * Compile the row-level-security policy from the handler/mutation options.
 *
 * Call this ONCE at the top of `handleBatchQuery` / `handleMutation` and thread
 * the returned object down in place of the raw `(tenancy, securityColumns)` pair.
 *
 * Fail-closed tenant-column validation (finding 2.1): a `multi-tenant` deployment
 * whose `tenantColumn` is empty / whitespace-only / non-string (the realistic
 * `tenantColumn: process.env.TENANT_COLUMN!`-is-unset path) THROWS here. Without
 * this guard the downstream truthiness gates silently emit NO tenant predicate on
 * any read or write, skip the insert force-stamp, and skip the client-supplied-tenant
 * rejection — a deployment that BELIEVES it is multi-tenant runs fully cross-tenant
 * unscoped. The unsafe state must be reachable only by an explicit `single-tenant`
 * declaration, enforced at RUNTIME (not just in the types).
 *
 * Fail-closed contradiction check: a `single-tenant` deployment that ALSO carries
 * a `perTable[table].tenant` override is a configuration contradiction ("no
 * tenancy, but scope this table by tenant") and THROWS — silently ignoring it
 * would reintroduce a silent-omission bug, while silently enforcing it would
 * contradict the declared mode.
 */
export function compileSecurityPolicy(opts: SecurityPolicyOptions): CompiledSecurityPolicy {
  const { tenancy, securityColumns } = opts;

  // Fail closed: multi-tenant REQUIRES a real tenant column at runtime (finding 2.1).
  if (tenancy.mode === 'multi-tenant' && !isUsableColumnName(tenancy.tenantColumn)) {
    throw new Error(
      `MUI X Studio Server: tenancy.mode is "multi-tenant" but tenancy.tenantColumn is ` +
        `${describeColumnValue((tenancy as { tenantColumn?: unknown }).tenantColumn)}. ` +
        `A multi-tenant deployment MUST declare a non-empty tenant-isolation column — without it every read would run ` +
        `fully unscoped across all tenants, inserts would never be tenant-stamped, and a client could write the tenant ` +
        `column itself (a cross-tenant data leak). This commonly happens when tenantColumn is wired to an unset ` +
        `environment variable. Provide a real column name, or declare { mode: 'single-tenant' } if this deployment is not multi-tenant.`,
    );
  }

  // Fail closed: an empty-string override must not silently opt a table/dimension
  // out of scoping (finding 2.1). Applies to the top-level region/department
  // defaults and every per-table dimension override.
  if (securityColumns) {
    assertOptionalColumnName(securityColumns.region, 'securityColumns.region');
    assertOptionalColumnName(securityColumns.department, 'securityColumns.department');
    for (const [table, entry] of Object.entries(securityColumns.perTable ?? {})) {
      if (entry == null) {
        continue;
      }
      assertOptionalColumnName(entry.tenant, `securityColumns.perTable["${table}"].tenant`);
      assertOptionalColumnName(entry.region, `securityColumns.perTable["${table}"].region`);
      assertOptionalColumnName(entry.department, `securityColumns.perTable["${table}"].department`);
    }
  }

  const resolvedTenantColumn = tenancy.mode === 'multi-tenant' ? tenancy.tenantColumn : undefined;

  if (tenancy.mode === 'single-tenant') {
    const scopedTable = Object.entries(securityColumns?.perTable ?? {}).find(
      ([, entry]) => entry != null && Boolean(entry.tenant),
    )?.[0];
    if (scopedTable !== undefined) {
      throw new Error(
        `MUI X Studio Server: Tenancy is declared single-tenant, but securityColumns.perTable["${scopedTable}"] ` +
          `sets a "tenant" column. This is contradictory — a single-tenant deployment applies no tenant predicate, ` +
          `so the per-table tenant scope would either be silently ignored (reintroducing a cross-tenant leak) or ` +
          `silently contradict the declared mode. ` +
          `Either switch tenancy to { mode: 'multi-tenant', tenantColumn }, or remove the "tenant" field from the per-table override.`,
      );
    }
  }

  return {
    forPrimaryTable(table: string): SecurityColumns {
      return resolvePrimarySecurityColumns(table, securityColumns, resolvedTenantColumn);
    },
    forJoinedTable(table: string): SecurityColumns | undefined {
      return resolveJoinSecurityColumns(table, securityColumns, resolvedTenantColumn);
    },
    digest: computePolicyDigest(opts),
    tenancy,
  };
}

/**
 * Coerce an enforcement-path argument to a `CompiledSecurityPolicy`.
 *
 * - Already-compiled policy (the request path) → returned as-is (no recompile).
 * - Raw `SecurityPolicyOptions` (direct unit-test callers) → compiled on the spot.
 */
export function toCompiledSecurityPolicy(
  value: CompiledSecurityPolicy | SecurityPolicyOptions,
): CompiledSecurityPolicy {
  if (isCompiledSecurityPolicy(value)) {
    return value;
  }
  return compileSecurityPolicy(value);
}
