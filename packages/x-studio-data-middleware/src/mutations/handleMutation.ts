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
 * 1b. Every table-QUALIFIED `where[].column` (e.g. "other_table.secret") is also
 *     validated against schemaAllowlist, UNCONDITIONALLY — independent of whether
 *     columnAllowlist is configured — via `assertQualifiedWhereColumnsAllowed`,
 *     mirroring the read path's unconditional `assertQualifiedColumnsAllowed`.
 * 2. Column values validated against writableColumns per table
 * 3. WHERE-predicate columns validated against columnAllowlist per table
 * 4. UPDATE/DELETE require at least one WHERE predicate
 * 5. One failed mutation does not abort the rest of the batch (per-item isolation)
 *
 * READ vs WRITE isolation asymmetry: the read path (`handleBatchQuery`) reports a
 * failing widget as its own per-widget `{ error }` while its siblings still
 * succeed. The write path is only per-item isolated for errors surfaced by the
 * per-mutation builder (invariants 2-4, unknown operation); a table-allowlist
 * violation (invariant 1, including its qualified-where-column extension 1b) is
 * validated up front and throws, deliberately aborting the WHOLE batch
 * all-or-nothing (pinned by the "table allowlist rejection" test) — a batch that
 * references a disallowed table is treated as malformed rather than partially
 * applied.
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
import {
  assertTablesAllowed,
  assertQualifiedWhereColumnsAllowed,
} from '../shared/assertTablesAllowed';
import { sanitizeBoundaryError } from '../shared/sanitizeError';
import { MAX_ARRAY_ITEMS_PER_DESCRIPTOR } from '../shared/limits';
import {
  compileSecurityPolicy,
  type CompiledSecurityPolicy,
} from '../security/compileSecurityPolicy';
import { getDefaultCache } from '../cache/defaultProviders';

/**
 * Hard ceiling on the number of mutations a single batch request may contain.
 * Mirrors `handler.ts`'s `MAX_WIDGETS_PER_BATCH` (finding T3 — unbounded
 * fan-out) for the write path: mutations run SEQUENTIALLY (not concurrently,
 * see the loop in `handleMutation` below), so an unbounded batch does not fan
 * out concurrent queries the way an unbounded `widgets` array does, but it is
 * still unbounded DB write work and response-payload size driven entirely by
 * client input — "batch sizes are small" was previously an assumption, not an
 * enforced limit. Exceeded requests are rejected outright (see
 * `assertValidBatchMutationRequest`) rather than silently truncated.
 */
export const MAX_MUTATIONS_PER_BATCH = 50;

/**
 * Validate the shape of a batch mutation request body before touching it.
 *
 * A malformed body (`{}`, `null`, `{ mutations: 42 }`, ...) used to reach
 * `body.mutations.map(...)` directly below and throw a raw, unsanitized
 * `TypeError` (e.g. "Cannot read properties of undefined (reading 'map')")
 * instead of one of this package's own `MUI X`-prefixed, actionable errors.
 * Mirrors `handler.ts`'s `assertValidBatchQueryRequest` for the write path.
 *
 * This also rejects a batch that exceeds `MAX_MUTATIONS_PER_BATCH`, and a
 * malformed ELEMENT (e.g. `mutations: [null]`) up front — `handleMutation`
 * runs `body.mutations.map((m) => m.table)` for the upfront table-allowlist
 * check BEFORE any try/catch, so a `null`/non-object mutation descriptor used
 * to throw a raw, unguarded `TypeError` immediately, exactly the failure mode
 * this function otherwise exists to prevent. There is no `id` to isolate a
 * per-mutation error onto, so — like the missing/mistyped `mutations` field —
 * this is a defect in the request shape itself and the whole batch is
 * rejected rather than patched per-mutation.
 */
function assertValidBatchMutationRequest(body: BatchMutationRequest): void {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Partial<BatchMutationRequest>).mutations)
  ) {
    throw new Error(
      `MUI X Studio Server: Malformed batch mutation request — expected an object with a "mutations" array. ` +
        `A missing or non-array "mutations" field cannot be turned into mutation results, and would otherwise throw a confusing internal error. ` +
        `Send a body shaped like { mutations: MutationDescriptor[] }.`,
    );
  }
  if (body.mutations.length > MAX_MUTATIONS_PER_BATCH) {
    throw new Error(
      `MUI X Studio Server: Batch mutation request contains ${body.mutations.length} mutations, which exceeds the maximum of ${MAX_MUTATIONS_PER_BATCH} allowed per request. ` +
        `An unbounded batch is unbounded DB write work driven entirely by client input. ` +
        `Split the mutations across multiple requests so each batch stays at or below ${MAX_MUTATIONS_PER_BATCH} mutations.`,
    );
  }
  body.mutations.forEach((mutation: MutationDescriptor, index: number) => {
    if (
      typeof mutation !== 'object' ||
      mutation === null ||
      typeof (mutation as Partial<MutationDescriptor>).id !== 'string' ||
      typeof (mutation as Partial<MutationDescriptor>).table !== 'string'
    ) {
      throw new Error(
        `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — expected an object with ` +
          `string "id" and "table" fields, but received ${JSON.stringify(mutation)}. ` +
          `A null or malformed mutation descriptor has no "id" to isolate a per-mutation error onto, and would ` +
          `otherwise throw a confusing internal error instead of a clean validation failure. ` +
          `Ensure every entry in "mutations" is a MutationDescriptor with at least an "id", "operation", and "table".`,
      );
    }
    // A "where" field that is present but not an array (Tier3 iter26 finding 1)
    // — e.g. `where: {}` — passes the checks above (which only look at "id"/
    // "table") and previously reached the upfront
    // `assertQualifiedWhereColumnsAllowed(mutation.where, schemaAllowlist)` loop
    // below, which iterates `where ?? []` with `for...of`: a non-array,
    // non-iterable "where" (a plain object) threw a raw, unguarded
    // `TypeError: where is not iterable` instead of one of this package's own
    // `MUI X`-prefixed errors, with no error boundary at all around this
    // upfront (pre-try/catch) validation step. Reject it here, fail closed,
    // before that loop ever runs.
    const { where } = mutation as Partial<MutationDescriptor>;
    if (where !== undefined && !Array.isArray(where)) {
      throw new Error(
        `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — "where" must be an array of ` +
          `predicates when present, but received ${JSON.stringify(where)}. ` +
          `A non-array "where" cannot be iterated to build WHERE predicates, and would otherwise throw a confusing ` +
          `internal error instead of a clean validation failure. ` +
          `Set "where" to an array of { column, operator, value } predicates, or omit it entirely.`,
      );
    }
    // A `null`/`undefined` (or otherwise non-object) ELEMENT inside the "where"
    // array (e.g. `where: [null]`) passes the `Array.isArray(where)` check above
    // but used to reach the upfront `assertQualifiedWhereColumnsAllowed` loop
    // BELOW — which runs BEFORE any per-mutation try/catch — where
    // `checkQualifiedColumn(predicate.column, …)` dereferences `.column` on the
    // element itself: `null.column` throws a raw, unguarded `TypeError` with no
    // error boundary at all around this pre-try validation step. (iter26 caught a
    // non-array `where`; iter27 gave a non-string `where[].column` a clean throw
    // — this closes the one level deeper: the array's individual ELEMENTS.) A
    // well-formed non-null object element (even `{}` or `{ column: 5 }`) is left
    // to `checkQualifiedColumn`'s own clean "column must be a string" throw; only
    // the elements that would crash the `.column` dereference itself — a null,
    // undefined, or primitive entry — are rejected here, fail closed, before that
    // loop ever runs.
    if (Array.isArray(where)) {
      // Size cap on the "where" array itself (finding Tier3 — resource exhaustion,
      // mirrors the read path's per-array caps in `handler.ts`). Mutations run
      // sequentially, not concurrently, but an unbounded predicate array is still
      // unbounded query-building work driven entirely by client input.
      if (where.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) {
        throw new Error(
          `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — "where" contains ` +
            `${where.length} predicates, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} allowed per ` +
            `mutation. An unbounded array is unbounded query-building work driven entirely by client input. ` +
            `Reduce the number of entries in "where" to at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
        );
      }
      where.forEach((predicate, predicateIndex) => {
        if (typeof predicate !== 'object' || predicate === null) {
          throw new Error(
            `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — "where[${predicateIndex}]" must ` +
              `be a predicate object with a "column" field, but received ${JSON.stringify(predicate)}. ` +
              `A null or non-object where-predicate has no "column" to validate and would otherwise throw a confusing ` +
              `internal error instead of a clean validation failure. ` +
              `Ensure every entry in "where" is a { column, operator, value } predicate.`,
          );
        }
        // Size cap for an `in`-predicate's value list — only a PRESENT array value
        // is length-capped here, regardless of operator (shape validation for
        // `value` happens later, per mutation, inside `validateMutation`).
        const predicateValue = (predicate as { value?: unknown }).value;
        if (
          Array.isArray(predicateValue) &&
          predicateValue.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR
        ) {
          throw new Error(
            `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — "where[${predicateIndex}].value" ` +
              `contains ${predicateValue.length} entries, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} ` +
              `allowed per predicate. An unbounded "in" value list is unbounded query-building work driven entirely by ` +
              `client input. Reduce the number of entries to at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
          );
        }
      });
    }
    // A "values" field that is present but not a plain object — e.g. `values: []`,
    // `values: "oops"`, `values: 42`, `values: null` — passes the checks above
    // (which only look at "id"/"table"/"where") and previously reached
    // `validateMutation`/`buildInsertMutation`/`buildUpdateMutation` downstream
    // (`mutationBuilder.ts`), which do `descriptor.values ?? {}`, `{ ...descriptor.values }`,
    // `Object.keys(values)` — none of which throw for a non-object "values": an
    // array indexes as '0', '1', ...; a string indexes by character; `null`/a
    // number silently becomes `{}`. That produced a silently degraded insert/update
    // (or an opaque downstream DB error) instead of a clean validation failure.
    // Mirrors the "where" array-shape check above exactly, for the object shape.
    const { values } = mutation as Partial<MutationDescriptor>;
    if (
      values !== undefined &&
      (typeof values !== 'object' || values === null || Array.isArray(values))
    ) {
      throw new Error(
        `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — "values" must be a plain ` +
          `object of column-value pairs when present, but received ${JSON.stringify(values)}. ` +
          `A non-object "values" cannot be safely mapped to column-value pairs, and would otherwise silently ` +
          `produce a degraded insert/update, or an opaque downstream database error, instead of a clean ` +
          `validation failure. Set "values" to a { column: value, ... } object, or omit it entirely.`,
      );
    }
    // Size cap on the "values" object's key count (finding Tier3 — resource
    // exhaustion), mirroring the array-length caps above for the one mutation
    // field that isn't an array.
    if (
      values !== undefined &&
      typeof values === 'object' &&
      values !== null &&
      !Array.isArray(values) &&
      Object.keys(values).length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR
    ) {
      throw new Error(
        `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — "values" contains ` +
          `${Object.keys(values).length} keys, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} ` +
          `allowed per mutation. An unbounded object is unbounded query-building work driven entirely by client ` +
          `input. Reduce the number of keys in "values" to at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
      );
    }
  });
}

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
  assertValidBatchMutationRequest(body);
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

  // ── Upfront qualified WHERE-column validation (Zero-Knowledge Rule, parity
  // with the read path's `assertQualifiedColumnsAllowed`) ───────────────────
  // A mutation never joins, so `assertTablesAllowed` above only ever sees
  // `descriptor.table` — a qualified `where[].column` (e.g. `"other_table.secret"`)
  // names a table that check can't see at all. This runs UNCONDITIONALLY,
  // independent of whether `columnAllowlist` is configured, mirroring the read
  // path's unconditional `assertQualifiedColumnsAllowed` call. Grouped with the
  // table-allowlist check above (same upfront, whole-batch-aborting posture) since
  // it is the identical Zero-Knowledge Rule applied to one more reference shape.
  for (const mutation of body.mutations) {
    assertQualifiedWhereColumnsAllowed(mutation.where, schemaAllowlist);
  }

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
        // Knex INSERT's return shape is driver-dependent and does NOT reliably
        // carry a row count (Tier3 iter26 finding 3, correcting the previous
        // comment here): SQLite/MySQL resolve to `[lastInsertId]` (length 1,
        // which happens to look like a row count only by coincidence), while
        // PostgreSQL resolves to `[]` UNLESS `.returning(...)` is used — so
        // `result.length` reported `0` for a successfully COMMITTED single-row
        // insert on pg. A `MutationDescriptor` insert always writes exactly ONE
        // row (one `values` object), so treat ANY array result — regardless of
        // its length — as "one row inserted" rather than trusting `.length` as
        // a row count.
        if (Array.isArray(result)) {
          rowsAffected = 1;
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
      // Never return a raw DB-driver error verbatim (finding T3.5): our own
      // validation messages pass through, but a driver error (e.g. a constraint or
      // `no such column` message) is a schema oracle, so it is logged server-side
      // and replaced with a generic message here.
      error: sanitizeBoundaryError(
        err,
        `MUI X Studio Server: The mutation could not be completed. ` +
          `The underlying cause has been logged server-side; inspect the server logs to diagnose it. ` +
          `If it persists, verify the mutation's table, column, and where-predicate configuration.`,
      ),
    };
  }
}
