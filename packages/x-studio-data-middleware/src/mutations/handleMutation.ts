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
 * - cacheProvider.deleteByTag(table) is called automatically to evict stale
 *   query results for the affected table. The host app does not need to call
 *   /api/invalidate manually when using handleMutation.
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
  const { schemaAllowlist } = options;

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
    results.push(await processMutation(descriptor, claims, options));
  }

  return { results };
}

async function processMutation(
  descriptor: MutationDescriptor,
  claims: JwtSecurityClaims,
  options: HandleMutationOptions,
): Promise<MutationResult> {
  const { db, writableColumns, tenantColumn, cacheProvider, columnAllowlist, securityColumns } =
    options;

  try {
    // Validate operation type
    if (!['insert', 'update', 'delete'].includes(descriptor.operation)) {
      throw new Error(
        `MUI X Studio Server: Unknown mutation operation "${descriptor.operation}". Allowed: insert, update, delete`,
      );
    }

    // Validate invariants (writable columns, required WHERE, tenant/region/
    // department scope on values) before building query
    validateMutation(descriptor, claims, {
      writableColumns,
      tenantColumn,
      columnAllowlist,
      securityColumns,
    });

    let rowsAffected: number;

    switch (descriptor.operation) {
      case 'insert': {
        const result = await buildInsertMutation(
          db,
          claims,
          descriptor,
          tenantColumn,
          securityColumns,
        );
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
        const result = await buildUpdateMutation(
          db,
          claims,
          descriptor,
          tenantColumn,
          securityColumns,
        );
        rowsAffected = typeof result === 'number' ? result : 0;
        break;
      }
      case 'delete': {
        const result = await buildDeleteMutation(
          db,
          claims,
          descriptor,
          tenantColumn,
          securityColumns,
        );
        rowsAffected = typeof result === 'number' ? result : 0;
        break;
      }
      default:
        rowsAffected = 0;
    }

    // ── Post-mutation cache invalidation ──────────────────────────────────
    // Evict all cached query results tagged with this table so the next read
    // fetches fresh rows from the DB — no manual /api/invalidate call needed.
    if (cacheProvider) {
      await cacheProvider.deleteByTag(descriptor.table);
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
