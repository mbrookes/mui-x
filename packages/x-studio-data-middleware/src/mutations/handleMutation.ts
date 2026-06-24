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
 * 3. UPDATE/DELETE require at least one WHERE predicate
 * 4. One failed mutation does not abort the rest of the batch (per-item isolation)
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
  const invalidTables = body.mutations
    .map((m) => m.table)
    .filter((t) => !schemaAllowlist.includes(t));

  if (invalidTables.length > 0) {
    throw new Error(
      `MUI X Studio Server: Requested table(s) not in schema allowlist: ${invalidTables.join(', ')}. ` +
        `Allowed tables: ${schemaAllowlist.join(', ')}`,
    );
  }

  // ── Per-mutation processing with error isolation ──────────────────────────
  const results = await Promise.all(
    body.mutations.map((descriptor) => processMutation(descriptor, claims, options)),
  );

  return { results };
}

async function processMutation(
  descriptor: MutationDescriptor,
  claims: JwtSecurityClaims,
  options: HandleMutationOptions,
): Promise<MutationResult> {
  const { db, writableColumns, tenantColumn, cacheProvider } = options;

  try {
    // Validate operation type
    if (!['insert', 'update', 'delete'].includes(descriptor.operation)) {
      throw new Error(
        `MUI X Studio Server: Unknown mutation operation "${descriptor.operation}". Allowed: insert, update, delete`,
      );
    }

    // Validate invariants (writable columns, required WHERE) before building query
    validateMutation(descriptor, { writableColumns, tenantColumn });

    let rowsAffected: number;

    switch (descriptor.operation) {
      case 'insert': {
        const result = await buildInsertMutation(db, claims, descriptor, tenantColumn);
        // Knex INSERT returns [lastInsertId] for SQLite/MySQL, or a count for others
        rowsAffected = Array.isArray(result)
          ? result.length
          : typeof result === 'number'
            ? result
            : 1;
        break;
      }
      case 'update': {
        const result = await buildUpdateMutation(db, claims, descriptor, tenantColumn);
        rowsAffected = typeof result === 'number' ? result : 0;
        break;
      }
      case 'delete': {
        const result = await buildDeleteMutation(db, claims, descriptor, tenantColumn);
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
