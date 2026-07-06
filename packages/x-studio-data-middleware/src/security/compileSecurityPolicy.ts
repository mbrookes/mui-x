/**
 * Compile the row-level-security policy ONCE per request.
 *
 * Gap A (see the retrofit plan): the `(tenantColumn, securityColumns)` fallback
 * chain — `perTable[table]?.X ?? config?.X ?? hardcodedDefault` — was executed
 * fresh at every enforcement site (`buildSecureQuery`, and four sites in
 * `mutationBuilder.ts`), with the raw option pair threaded as loose arguments and
 * no single "compiled" object anywhere. This module centralizes the resolution
 * into one boundary object:
 *
 *   - `forPrimaryTable(table)` / `forJoinedTable(table)` resolve the security
 *     columns for a table using the EXACT same fallback chain as before (they
 *     delegate to `resolvePrimarySecurityColumns` / `resolveJoinSecurityColumns`
 *     in `shared/predicates.ts`), so centralizing changes WHERE the chain runs,
 *     never WHAT it resolves to for a given input.
 *   - `digest` is a stable hash of the resolved policy inputs, computed ONCE at
 *     compile time and folded into the cache key so two nodes running different
 *     `securityColumns` config never serve one node's cached rows to the other
 *     node's differently-scoped requests (Gap B).
 *
 * SECURITY: this stage is behavior-preserving. `hasTenantScope` is informational
 * only — it does NOT gate enforcement. A future, separately-signed-off change may
 * make a missing tenant column an error; this stage must keep working for every
 * currently-valid configuration, including single-tenant deployments that never
 * configure a tenant column at all.
 */
import { createHash } from 'node:crypto';
import type { HandleBatchQueryOptions, SecurityColumns } from './types';
import { resolveJoinSecurityColumns, resolvePrimarySecurityColumns } from '../shared/predicates';

/**
 * The compiled row-level-security policy for one request.
 *
 * A single boundary object that resolves security columns per table (via the
 * shared fallback chain) and carries a stable `digest` of its inputs.
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
   * True iff ANY resolvable tenant column exists for this policy.
   *
   * INFORMATIONAL ONLY in this stage — do NOT change enforcement behavior based
   * on this value. `applySecurityPredicates` still skips the tenant dimension
   * when no tenant column resolves for a given table (behavior-preserving).
   */
  readonly hasTenantScope: boolean;
}

/** The security-relevant subset of the handler/mutation options. */
type SecurityPolicyOptions = Pick<HandleBatchQueryOptions, 'tenantColumn' | 'securityColumns'>;

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
 * Always builds the `{ tenantColumn, securityColumns }` pair from the options, so
 * `computePolicyDigest({})` and `computePolicyDigest({ tenantColumn: undefined,
 * securityColumns: undefined })` produce the identical digest — that identity is
 * what lets `EMPTY_POLICY_DIGEST` double as the default for direct
 * `generateCacheKey` callers.
 */
function computePolicyDigest(opts: SecurityPolicyOptions): string {
  const canonical = sortedStringify({
    tenantColumn: opts.tenantColumn,
    securityColumns: opts.securityColumns,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * The digest of the empty (fully-unconfigured) policy.
 *
 * Used as the default `policyDigest` for `generateCacheKey` callers that do not
 * supply one (e.g. direct unit tests), so their keys stay deterministic and
 * match what the handler stores for an unconfigured deployment.
 */
export const EMPTY_POLICY_DIGEST = computePolicyDigest({});

/**
 * Type guard: has this already been compiled into a `CompiledSecurityPolicy`?
 *
 * Lets the enforcement-path functions accept EITHER a compiled policy (threaded
 * once from the request handler) OR the legacy raw option pair (passed by direct
 * unit-test callers), without breaking either.
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
 * the returned object down in place of the raw `(tenantColumn, securityColumns)`
 * pair.
 */
export function compileSecurityPolicy(opts: SecurityPolicyOptions): CompiledSecurityPolicy {
  const { tenantColumn, securityColumns } = opts;

  const perTableTenant = Object.values(securityColumns?.perTable ?? {}).some(
    (entry) => entry != null && Boolean(entry.tenant),
  );
  const hasTenantScope =
    Boolean(tenantColumn) || Boolean(securityColumns?.tenant) || perTableTenant;

  return {
    forPrimaryTable(table: string): SecurityColumns {
      return resolvePrimarySecurityColumns(table, securityColumns, tenantColumn);
    },
    forJoinedTable(table: string): SecurityColumns | undefined {
      return resolveJoinSecurityColumns(table, securityColumns, tenantColumn);
    },
    digest: computePolicyDigest(opts),
    hasTenantScope,
  };
}

/**
 * Coerce an enforcement-path argument to a `CompiledSecurityPolicy`.
 *
 * - Already-compiled policy (the request path) → returned as-is (no recompile).
 * - Legacy raw option pair (direct unit-test callers) → compiled on the spot.
 */
export function toCompiledSecurityPolicy(
  value: CompiledSecurityPolicy | SecurityPolicyOptions | undefined,
): CompiledSecurityPolicy {
  if (isCompiledSecurityPolicy(value)) {
    return value;
  }
  return compileSecurityPolicy(value ?? {});
}
