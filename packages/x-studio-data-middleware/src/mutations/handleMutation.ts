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
 *    — the DEFAULT. Opt into all-or-nothing semantics with `atomic: true` (see
 *    `AtomicMutationOptions` below).
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
 *   Under `atomic: true` the invalidation instead runs ONCE per distinct table
 *   AFTER the transaction commits — evicting mid-transaction would let a
 *   concurrent read re-populate the cache with rows that are about to roll back.
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
import {
  MAX_ARRAY_ITEMS_PER_DESCRIPTOR,
  MAX_PREDICATE_VALUES_PER_DESCRIPTOR,
  MAX_STRING_LENGTH,
  MAX_STRING_VALUE_LENGTH,
} from '../shared/limits';
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
 * Opt-in transactional semantics for a mutation batch (finding M3).
 *
 * Declared here rather than on `HandleMutationOptions` (`security/mutationTypes.ts`)
 * because that file is outside this change's boundary; it is an intersection on
 * `handleMutation`'s `options` parameter, so callers pass it inline alongside the
 * other options exactly as if it were declared there. Folding it into
 * `HandleMutationOptions` proper is a follow-up.
 */
export interface AtomicMutationOptions {
  /**
   * Run the whole batch inside ONE database transaction, all-or-nothing.
   *
   * Default (`false` / omitted): every mutation is applied independently and in
   * order, and a failure is isolated to its own `MutationResult` while its
   * siblings still commit. That isolation is deliberate — but it left a host with
   * NO way to get atomicity even when it explicitly wanted it. A batch such as
   * `[insert parent, insert child-referencing-parent]` whose second item fails
   * validation committed the parent and returned `[{ok:true}, {ok:false}]`, with
   * no mechanism for the client to undo the orphan.
   *
   * With `atomic: true`, the batch runs inside `db.transaction(...)`; the
   * transaction handle is passed to the builders in place of `db`, and the FIRST
   * failure rolls everything back. The response then reports `ok: false` for
   * EVERY item: the failing one carries its own error, and the rest carry a
   * "rolled back" message — no mutation in the batch was applied. Requires the
   * injected `db` to expose Knex's `transaction(callback)`.
   *
   * @default false
   */
  atomic?: boolean;
}

/**
 * Internal sentinel thrown out of the `db.transaction` callback to trigger a
 * ROLLBACK once a mutation in an atomic batch has failed. Never surfaced to the
 * client — it CARRIES the per-item results `runAtomicBatch` had already
 * assembled by the time it was thrown, and those are returned instead.
 *
 * WHY THE PAYLOAD LIVES ON THE ERROR (correctness, not style): `runAtomicBatch`
 * used to throw a plain `Error` with a fixed message and then discriminate in its
 * `catch` on `results !== undefined` — a variable that the SUCCESS path assigns
 * too, from inside the very same callback. Anything the transaction machinery
 * raises AFTER the callback resolves — a Postgres `40001` serialization failure
 * or deferred-constraint violation at COMMIT, a lost connection, a MySQL deadlock
 * surfacing at commit — therefore landed in the catch with `results` already
 * holding the fully-assembled, all-`ok: true` per-item results, was misread as
 * "our own rollback sentinel", and was returned verbatim. The client was told
 * every write succeeded while the database had committed nothing; the early
 * `return` also skipped the post-commit cache invalidation gate below.
 *
 * Carrying the results ON the sentinel makes that misclassification
 * unrepresentable: `err instanceof AtomicRollback` is true for exactly the throw
 * that assembled them, and for nothing else.
 */
class AtomicRollback extends Error {
  readonly results: MutationResult[];

  constructor(results: MutationResult[]) {
    super('MUI X: Atomic mutation batch rolled back');
    this.name = 'AtomicRollback';
    this.results = results;
  }
}

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
    // Length cap on "id"/"table" (Tier2 finding — resource exhaustion). Both are
    // confirmed strings above, but neither had a bound on how long that string
    // could be, mirroring the read path's identical cap in `handler.ts`.
    for (const [field, value] of [
      ['id', mutation.id],
      ['table', mutation.table],
    ] as const) {
      if (value.length > MAX_STRING_LENGTH) {
        throw new Error(
          `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — "${field}" is ${value.length} ` +
            `characters long, which exceeds the maximum of ${MAX_STRING_LENGTH} allowed. ` +
            `An unbounded "${field}" string is expensive to validate and serialize repeatedly across a batch. ` +
            `Shorten "${field}" to at most ${MAX_STRING_LENGTH} characters.`,
        );
      }
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
      // Aggregate cap on the TOTAL comparison values across every predicate in
      // this mutation — the per-predicate cap below bounds each `in`-list
      // independently, but not its PRODUCT with the `where` array's own length
      // cap. 200 predicates × 200 values each passes both individual caps yet
      // still means 40,000 bound parameters for ONE mutation (and 2,000,000 for a
      // `MAX_MUTATIONS_PER_BATCH`-sized batch). Mirrors the read path's identical
      // `totalPredicateValues` accumulator on `filters[].value` in `handler.ts`.
      let totalPredicateValues = 0;
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
        // Count real comparison values: every element of an `in` list, or one for
        // a present scalar. An absent `value` contributes nothing.
        if (Array.isArray(predicateValue)) {
          totalPredicateValues += predicateValue.length;
        } else if (predicateValue !== undefined) {
          totalPredicateValues += 1;
        }
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
        // Length cap on a scalar/"in"-element STRING value (Tier2 finding —
        // resource exhaustion), mirroring the read path's identical cap on
        // `filters[].value` in `handler.ts`. Uses the larger
        // `MAX_STRING_VALUE_LENGTH` bound — a where-predicate value is business
        // data, not an identifier. Only PRESENT string values are checked; full
        // shape validation still happens later inside `validateMutation`.
        const whereStringValues = Array.isArray(predicateValue) ? predicateValue : [predicateValue];
        whereStringValues.forEach((v) => {
          if (typeof v === 'string' && v.length > MAX_STRING_VALUE_LENGTH) {
            throw new Error(
              `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — "where[${predicateIndex}].value" ` +
                `contains a string ${v.length} characters long, which exceeds the maximum of ${MAX_STRING_VALUE_LENGTH} ` +
                `allowed. An unbounded value string is expensive to hash and, once queried, expensive for the database ` +
                `to scan/index as a bound parameter. Shorten the value to at most ${MAX_STRING_VALUE_LENGTH} characters.`,
            );
          }
        });
      });
      if (totalPredicateValues > MAX_PREDICATE_VALUES_PER_DESCRIPTOR) {
        throw new Error(
          `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — "where[].value" contains ` +
            `${totalPredicateValues} comparison values in total across all predicates, which exceeds the maximum of ` +
            `${MAX_PREDICATE_VALUES_PER_DESCRIPTOR} allowed per mutation. Each predicate may individually stay under ` +
            `its own per-predicate cap yet still sum to an unbounded number of bound parameters to build and send to ` +
            `the database for a single mutation. Reduce the total number of where-predicate values to at most ` +
            `${MAX_PREDICATE_VALUES_PER_DESCRIPTOR}.`,
        );
      }
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
    // Length cap on each "values" KEY and, separately, each STRING value (Tier2
    // finding — resource exhaustion). The key-COUNT cap above bounds how many
    // column-value pairs "values" may hold, but not how long any one key (a
    // column name — an identifier) or string value (business data being
    // written) may be. Keys use the smaller `MAX_STRING_LENGTH` identifier
    // bound; string values use the larger `MAX_STRING_VALUE_LENGTH` bound,
    // mirroring the identifier-vs-value distinction used throughout this fix.
    if (
      values !== undefined &&
      typeof values === 'object' &&
      values !== null &&
      !Array.isArray(values)
    ) {
      for (const [key, value] of Object.entries(values)) {
        if (key.length > MAX_STRING_LENGTH) {
          throw new Error(
            `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — a "values" key is ` +
              `${key.length} characters long, which exceeds the maximum of ${MAX_STRING_LENGTH} allowed for an ` +
              `identifier. An unbounded key is expensive to validate repeatedly across a batch. Shorten the ` +
              `"values" key to at most ${MAX_STRING_LENGTH} characters.`,
          );
        }
        if (typeof value === 'string' && value.length > MAX_STRING_VALUE_LENGTH) {
          throw new Error(
            `MUI X Studio Server: Malformed mutation descriptor at mutations[${index}] — "values" value for key ` +
              `"${key.slice(0, 80)}…" is ${value.length} characters long, which exceeds the maximum of ` +
              `${MAX_STRING_VALUE_LENGTH} allowed. An unbounded value string is expensive for the database to store ` +
              `and index. Shorten the "values" value for "${key}" to at most ${MAX_STRING_VALUE_LENGTH} characters.`,
          );
        }
      }
    }
  });
}

/**
 * Handle a batch of mutation operations from a Studio client.
 *
 * @param body - Parsed request body (BatchMutationRequest)
 * @param claims - Verified JWT security claims from extractSecurityClaims()
 * @param options - Knex instance, allowlists, optional cache provider, optional
 *   `atomic` flag (see `AtomicMutationOptions`)
 */
export async function handleMutation(
  body: BatchMutationRequest,
  claims: JwtSecurityClaims,
  options: HandleMutationOptions & AtomicMutationOptions,
): Promise<BatchMutationResponse> {
  assertValidBatchMutationRequest(body);
  const { schemaAllowlist, tenancy, securityColumns, columnAllowlist, writableColumns } = options;

  // ── Compile the row-level-security policy ONCE for the whole batch ─────────
  // The single compiled object is threaded into every mutation builder in place
  // of the raw `(tenancy, securityColumns)` pair, so the resolution chain runs
  // once here instead of fresh at each of the four builder call sites. The
  // `columnAllowlist` is folded into `policy.digest` so tightening column
  // visibility invalidates cache entries computed under a looser allowlist.
  //
  // `schemaAllowlist` is folded in for the same reason `handleBatchQuery` folds
  // it in (finding L2 — the two calls used to differ): per
  // `SecurityPolicyOptions.schemaAllowlist`'s own contract it is THE zero-config
  // data-source separator, so a digest computed without it does not identify the
  // data source at all. Inert today — the write path never consumes
  // `policy.digest` (invalidation is by table tag, not by key) — but a digest
  // that means one thing on the read path and another on the write path is a
  // trap for the next person to compare them, and any future write-path use
  // would silently fail to separate two databases exposing the same tables.
  //
  // `writableColumns` is passed for RUNTIME SHAPE VALIDATION only (it is not
  // folded into the digest): it is the write path's third compile-time-only
  // allowlist, and it reaches the same `Array.prototype.includes` membership
  // check — which fails OPEN by substring-matching a string — via
  // `mutationBuilder`'s `checkColumnAgainstAllowlist` call. Validating it here
  // means the whole batch is rejected before ANY mutation runs, rather than each
  // mutation quietly writing a column the host never made writable.
  const policy = compileSecurityPolicy({
    tenancy,
    securityColumns,
    columnAllowlist,
    schemaAllowlist,
    writableColumns,
  });

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

  // ── Opt-in all-or-nothing batch (finding M3) ──────────────────────────────
  if (options.atomic) {
    return { results: await runAtomicBatch(body.mutations, claims, options, policy) };
  }

  // ── Per-mutation processing — SEQUENTIAL with error isolation ─────────────
  // Mutations run in array order (not concurrently) so a batch like
  // `[insert row, update that row]` is deterministic: the update observes the
  // insert's effect instead of racing it. Batch sizes are small, so correctness
  // beats the marginal latency of `Promise.all`.
  const results: MutationResult[] = [];
  for (const descriptor of body.mutations) {
    results.push(
      // Mutations are applied SEQUENTIALLY by design: each item's outcome is reported
      // independently and, in atomic mode, a failure must roll back before any later item
      // runs. Parallelising would break both.
      // eslint-disable-next-line no-await-in-loop
      await processMutation(descriptor, claims, options, policy, {
        db: options.db,
        invalidateCache: true,
      }),
    );
  }

  return { results };
}

/**
 * Run every mutation in the batch inside ONE `db.transaction`, rolling back on
 * the first failure (finding M3 — `atomic: true`).
 *
 * The transaction handle replaces `db` for every builder call, so the whole
 * batch commits or none of it does. On failure the returned results report
 * `ok: false` for EVERY item — the failing one keeps its own (already
 * sanitized) error, the others say the batch was rolled back — because after a
 * rollback no mutation in the batch was applied, and reporting an item as
 * `ok: true` when its row no longer exists would be a lie the client acts on.
 *
 * A failure raised by the transaction machinery ITSELF — including one that only
 * surfaces at COMMIT, after the callback has already resolved with a full set of
 * `ok: true` results — is reported as an all-items-failed batch, never as those
 * results. See `AtomicRollback` for why the two are discriminated by the sentinel
 * TYPE rather than by whether the results happen to have been assembled.
 *
 * Cache invalidation is deliberately deferred to AFTER the commit: evicting
 * mid-transaction would let a concurrent read re-populate the cache with rows
 * that are about to disappear.
 */
async function runAtomicBatch(
  mutations: MutationDescriptor[],
  claims: JwtSecurityClaims,
  options: HandleMutationOptions & AtomicMutationOptions,
  policy: CompiledSecurityPolicy,
): Promise<MutationResult[]> {
  if (typeof options.db?.transaction !== 'function') {
    throw new Error(
      `MUI X Studio Server: "atomic: true" was requested, but the injected "db" does not expose a "transaction" method. ` +
        `Without a transaction the batch cannot be rolled back, so running it would silently give per-item semantics ` +
        `under a flag that promises all-or-nothing. ` +
        `Pass a Knex instance (or any db object exposing "transaction(callback)"), or omit "atomic".`,
    );
  }

  // Assembled inside the transaction callback and read back afterwards, because
  // the callback must THROW to make the driver roll back. It is deliberately NOT
  // what the catch below discriminates on — see `AtomicRollback`.
  let applied: MutationResult[] | undefined;

  try {
    await options.db.transaction(async (trx: unknown) => {
      const running: MutationResult[] = [];
      for (const descriptor of mutations) {
        // eslint-disable-next-line no-await-in-loop
        const result = await processMutation(descriptor, claims, options, policy, {
          db: trx,
          invalidateCache: false,
        });
        running.push(result);
        if (!result.ok) {
          throw new AtomicRollback(
            mutations.map((m, index) =>
              index === running.length - 1
                ? result
                : {
                    id: m.id,
                    ok: false,
                    error:
                      `MUI X Studio Server: This mutation was rolled back because another mutation in the same ` +
                      `"atomic" batch failed. No mutation in the batch was applied. ` +
                      `Fix the failing mutation (see its own error) and resend the batch.`,
                  },
            ),
          );
        }
      }
      applied = running;
    });
  } catch (err) {
    if (err instanceof AtomicRollback) {
      // Our own rollback sentinel — it carries the per-item results assembled at
      // the moment the failing mutation was detected.
      return err.results;
    }
    // ANY other throw means the transaction machinery itself failed — including,
    // critically, a failure raised AFTER the callback resolved: a serialization
    // failure or deferred-constraint violation at COMMIT, a lost connection, a
    // deadlock surfacing at commit. `applied` is fully populated in exactly that
    // case, which is why it must not be what this branch keys off. Nothing was
    // committed, so every item reports failure with a sanitized message.
    const error = sanitizeBoundaryError(
      err,
      `MUI X Studio Server: The atomic mutation batch could not be committed and was rolled back. ` +
        `The underlying cause has been logged server-side; inspect the server logs to diagnose it. ` +
        `If it persists, verify the database connection and the mutations' table, column, and where-predicate configuration.`,
    );
    return mutations.map((m) => ({ id: m.id, ok: false, error }));
  }

  if (applied === undefined) {
    // Defensive: a host `transaction()` that RESOLVED without ever running (or
    // without awaiting) the callback. Nothing ran, so nothing committed — report
    // every item as failed rather than returning an empty `results` array that
    // silently drops every mutation the client asked about.
    return mutations.map((m) => ({
      id: m.id,
      ok: false,
      error:
        `MUI X Studio Server: The atomic mutation batch was not applied — the injected "db.transaction" ` +
        `resolved without running the batch callback to completion. No mutation in the batch was applied, and ` +
        `reporting them as succeeded would tell the client a write landed when it did not. ` +
        `Ensure "db.transaction(callback)" awaits the callback and rejects when it throws (Knex's own behavior).`,
    }));
  }

  const committed = applied;

  // Post-commit cache invalidation — once per DISTINCT table, not once per
  // mutation, since `deleteByTag` already evicts every entry for that table.
  // Reached ONLY when the transaction resolved AND every mutation succeeded:
  // the callback throws `AtomicRollback` on the first failure (so `applied` is
  // never assigned), and any commit-time failure is caught above. The `every`
  // check is a redundant belt-and-braces assertion of that invariant — nothing
  // changed in the database on a rollback, so there is nothing to evict.
  if (committed.every((result) => result.ok)) {
    const cacheProvider = options.cacheProvider ?? getDefaultCache();
    for (const table of new Set(mutations.map((m) => m.table))) {
      // eslint-disable-next-line no-await-in-loop
      await invalidateTableCache(table, cacheProvider);
    }
  }

  return committed;
}

/**
 * Best-effort post-mutation cache eviction for one table.
 *
 * The write already committed by the time this runs, so a cache-backend failure
 * must NOT flip the result to `ok: false` (a client retry would duplicate the
 * row). Degrade to a logged warning: the cache is stale for ≤ its TTL, which is
 * strictly better than reporting a committed write as failed (finding 2.6).
 */
async function invalidateTableCache(
  table: string,
  cacheProvider: NonNullable<HandleMutationOptions['cacheProvider']>,
): Promise<void> {
  try {
    await cacheProvider.deleteByTag(table);
  } catch (cacheErr) {
    console.warn(
      `MUI X Studio Server: post-mutation cache invalidation failed for table "${table}"; ` +
        `the mutation committed successfully and is reported as such. Cached reads for this table may be ` +
        `stale until their TTL expires — check the cache backend. ` +
        `Cause: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
    );
  }
}

/**
 * Execution context for a single mutation — the connection it runs on, and
 * whether it owns its own cache invalidation.
 */
interface ProcessMutationContext {
  /**
   * Knex instance OR transaction handle the builders must run against. Under
   * `atomic: true` this is the `trx` handle, so the mutation joins the batch's
   * transaction instead of auto-committing on its own connection.
   */
  db: any;
  /**
   * Whether this call performs its own post-mutation `deleteByTag`. False for an
   * atomic batch, which invalidates once per table AFTER the commit — evicting
   * inside the transaction would let a concurrent read re-cache rows that are
   * about to roll back.
   */
  invalidateCache: boolean;
}

async function processMutation(
  descriptor: MutationDescriptor,
  claims: JwtSecurityClaims,
  options: HandleMutationOptions,
  policy: CompiledSecurityPolicy,
  context: ProcessMutationContext,
): Promise<MutationResult> {
  const { writableColumns, columnAllowlist } = options;
  const { db } = context;

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
    // Skipped inside an atomic batch, which invalidates after COMMIT instead
    // (see `runAtomicBatch`). Falls back to the SAME process-wide default cache
    // `handleBatchQuery` uses when no `cacheProvider` is passed, so a zero-config
    // host still invalidates the read path's default cache (finding 2.2).
    if (context.invalidateCache) {
      await invalidateTableCache(descriptor.table, options.cacheProvider ?? getDefaultCache());
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
