/**
 * handleMutation — framework-agnostic mutation handler for @mui/x-studio-data-middleware.
 *
 * PURE FUNCTION GUARANTEE:
 * - No HTTP imports
 * - No process.exit()
 * - No global state mutation
 * - All dependencies injected via options
 *
 * Security invariants enforced here (before reaching the builder):
 * 1. All tables validated against schemaAllowlist (Zero-Knowledge Rule)
 * 2. Column values validated against writableColumns per table
 * 3. WHERE-predicate columns validated against columnAllowlist per table
 * 4. UPDATE/DELETE require at least one WHERE predicate
 * 5. One failed mutation does not abort the rest of the batch (per-item isolation)
 *
 * After each successful mutation:
 * - deleteByTag(table) is called automatically to evict stale query results for
 *   the affected table. The host app does not need to call /api/invalidate
 *   manually when using handleMutation. When no `cacheProvider` is supplied, the
 *   invalidation runs against the SAME process-wide default cache that
 *   `handleBatchQuery` populates by default (finding 2.2) — so a zero-config host
 *   that reads and writes through both handlers still observes its own writes,
 *   instead of the read path caching into a singleton the write path could not
 *   reach.
 * - The cache side-effect is best-effort: a throwing `deleteByTag` (e.g. Redis
 *   down) is caught and logged, and the mutation still reports `ok: true`. A
 *   committed write reported as failed would prompt a client retry that inserts a
 *   duplicate row — strictly worse than a cache stale for ≤ its TTL (finding 2.6).
 */
import type {
  JwtSecurityClaims,
  BatchMutationRequest,
  BatchMutationResponse,
  MutationDescriptor,
  MutationResult,
  HandleMutationOptions,
} from '../security/types';
import {
  validateMutation,
  buildInsertMutation,
  buildUpdateMutation,
  buildDeleteMutation,
} from './mutationBuilder';
import { assertTablesAllowed } from '../shared/assertTablesAllowed';
import {
  compileSecurityPolicy,
  type CompiledSecurityPolicy,
} from '../security/compileSecurityPolicy';
import { getDefaultCache } from '../cache/defaultProviders';

/**
 * Handle a batch of mutation operations from a Studio client.
 *
 * @param body - Parsed request body (BatchMutationRequest)
 * @param claims - Verified JWT security claims from extractSecurityClaims()
 * @param options - Knex instance, allowlists, optional cache provider
 */
export async function handleMutation(
  body: BatchMutationRequest,
  claims: JwtSecurityClaims,
  options: HandleMutationOptions,
): Promise<BatchMutationResponse> {
  const { schemaAllowlist, tenancy, securityColumns, columnAllowlist } = options;

  // ── Compile the row-level-security policy ONCE for the whole batch ─────────
  // The single compiled object is threaded into every mutation builder in place
  // of the raw `(tenancy, securityColumns)` pair, so the resolution chain runs
  // once here instead of fresh at each of the four builder call sites. The
  // `columnAllowlist` is folded into `policy.digest` so tightening column
  // visibility invalidates cache entries computed under a looser allowlist.
  const policy = compileSecurityPolicy({ tenancy, securityColumns, columnAllowlist });

  // ── Upfront table validation (Zero-Knowledge Rule) ────────────────────────
  assertTablesAllowed(
    body.mutations.map((m) => m.table),
    schemaAllowlist,
  );

  // ── Per-mutation processing — SEQUENTIAL with error isolation ─────────────
  // Mutations run in array order (not concurrently) so a batch like
  // `[insert row, update that row]` is deterministic: the update observes the
  // insert's effect instead of racing it. Batch sizes are small, so correctness
  // beats the marginal latency of `Promise.all`.
  const results: MutationResult[] = [];
  for (const descriptor of body.mutations) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await processMutation(descriptor, claims, options, policy));
  }

  return { results };
}

async function processMutation(
  descriptor: MutationDescriptor,
  claims: JwtSecurityClaims,
  options: HandleMutationOptions,
  policy: CompiledSecurityPolicy,
): Promise<MutationResult> {
  const { db, writableColumns, columnAllowlist } = options;
  // Fall back to the SAME process-wide default cache `handleBatchQuery` uses when
  // no `cacheProvider` is passed, so a zero-config host still invalidates the read
  // path's default cache after a write (finding 2.2).
  const cacheProvider = options.cacheProvider ?? getDefaultCache();

  try {
    // Validate operation type
    if (!['insert', 'update', 'delete'].includes(descriptor.operation)) {
      throw new Error(
        `MUI X Studio Server: Unknown mutation operation "${descriptor.operation}". Allowed: insert, update, delete`,
      );
    }

    // Validate invariants (writable columns, required WHERE, tenant/region/
    // department scope on values) before building query — using the compiled
    // policy so resolution matches the builders exactly.
    validateMutation(descriptor, claims, {
      writableColumns,
      columnAllowlist,
      policy,
    });

    let rowsAffected: number;

    switch (descriptor.operation) {
      case 'insert': {
        const result = await buildInsertMutation(db, claims, descriptor, policy);
        // Knex INSERT returns [lastInsertId] for SQLite/MySQL, or a count for others.
        if (Array.isArray(result)) {
          rowsAffected = result.length;
        } else if (typeof result === 'number') {
          rowsAffected = result;
        } else {
          rowsAffected = 1;
        }
        break;
      }
      case 'update': {
        const result = await buildUpdateMutation(db, claims, descriptor, policy);
        rowsAffected = typeof result === 'number' ? result : 0;
        break;
      }
      case 'delete': {
        const result = await buildDeleteMutation(db, claims, descriptor, policy);
        rowsAffected = typeof result === 'number' ? result : 0;
        break;
      }
      default: {
        // Unreachable: `descriptor.operation` is validated against exactly
        // ['insert', 'update', 'delete'] above, before this switch is ever
        // reached (an unknown operation throws and returns early via the
        // catch block below). This exhaustiveness check (rather than a
        // dead-code default arm, finding 3.5) fails to compile if a new
        // operation is ever added to the union without a case here.
        const exhaustiveCheck: never = descriptor.operation;
        throw /* minify-error-disabled */ new Error(
          `MUI X: Unreachable mutation operation: ${exhaustiveCheck}`,
        );
      }
    }

    // ── Post-mutation cache invalidation ──────────────────────────────────
    // Evict all cached query results tagged with this table so the next read
    // fetches fresh rows from the DB — no manual /api/invalidate call needed.
    // The write already committed, so a cache-backend failure here must NOT flip
    // the result to `ok: false` (a client retry would duplicate the row). Catch
    // and degrade to a logged warning; the cache is stale for ≤ its TTL, which is
    // strictly better than reporting a committed write as failed (finding 2.6).
    try {
      await cacheProvider.deleteByTag(descriptor.table);
    } catch (cacheErr) {
      console.warn(
        `MUI X Studio Server: post-mutation cache invalidation failed for table "${descriptor.table}"; ` +
          `the mutation committed successfully and is reported as such. Cached reads for this table may be ` +
          `stale until their TTL expires — check the cache backend. ` +
          `Cause: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
      );
    }

    return { id: descriptor.id, ok: true, rowsAffected };
  } catch (err) {
    return {
      id: descriptor.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
