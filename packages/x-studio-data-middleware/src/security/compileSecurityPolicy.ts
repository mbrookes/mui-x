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
 *   - `digest` is a stable hash of the resolved policy inputs, computed ONCE at
 *     compile time and folded into the cache key so two nodes running different
 *     `tenancy` / `securityColumns` config never serve one node's cached rows to
 *     the other node's differently-scoped requests (Gap B).
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

/** The security-relevant subset of the handler/mutation options. */
export interface SecurityPolicyOptions {
  /** Tenancy posture — REQUIRED. Declares single-tenant or multi-tenant explicitly. */
  tenancy: TenancyConfig;
  /** Optional region/department + per-table row-level-security column overrides. */
  securityColumns?: SecurityColumnsConfig;
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
 * Recursively serialize a value with object keys sorted alphabetically, so the
 * digest is deterministic regardless of property insertion order.
 */
function sortedStringify(obj: unknown): string {
  if (Array.isArray(obj)) {
    return `[${obj.map(sortedStringify).join(',')}]`;
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedStringify((obj as Record<string, unknown>)[k])}`);
    return `{${sorted.join(',')}}`;
  }
  return JSON.stringify(obj);
}

/**
 * Compute the stable digest of a policy's resolved inputs.
 *
 * Builds the `{ tenancy, securityColumns }` pair from the options so the digest
 * reflects both the tenancy posture and the row-level-security column config.
 */
function computePolicyDigest(opts: SecurityPolicyOptions): string {
  const canonical = sortedStringify({
    tenancy: opts.tenancy,
    securityColumns: opts.securityColumns,
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
 * Compile the row-level-security policy from the handler/mutation options.
 *
 * Call this ONCE at the top of `handleBatchQuery` / `handleMutation` and thread
 * the returned object down in place of the raw `(tenancy, securityColumns)` pair.
 *
 * Fail-closed contradiction check: a `single-tenant` deployment that ALSO carries
 * a `perTable[table].tenant` override is a configuration contradiction ("no
 * tenancy, but scope this table by tenant") and THROWS — silently ignoring it
 * would reintroduce a silent-omission bug, while silently enforcing it would
 * contradict the declared mode.
 */
export function compileSecurityPolicy(opts: SecurityPolicyOptions): CompiledSecurityPolicy {
  const { tenancy, securityColumns } = opts;

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
