/**
 * handleBatchQuery — the core pure function of x-studio-data-middleware.
 *
 * This function, for each widget in the batch — with per-widget error isolation:
 * one widget's failure produces that widget's `{ error }` result, never a
 * whole-batch rejection. This isolation now covers the client-input validation
 * stage too (table allowlist + query-plan validation), not just
 * cache/preflight/execute — see the `processWidget` body:
 * 1. Validates the widget's tables against the schema allowlist
 * 2. Validates HAVING aliases (unconditionally) and column references
 *    (when a column allowlist is configured)
 * 3. Checks the server-side cache (security-scoped key)
 * 4. Runs a COUNT(*) pre-flight to determine routing tier
 * 5. Executes the query via the appropriate tier
 * 6. Populates the cache for server/client tiers, and for non-aggregation
 *    db-tier results (see the `tier !== 'db' || !hasAggregations` gate below)
 * and returns a BatchQueryResponse with all results.
 *
 * RESOURCE BOUNDS (finding H2) — the per-widget fan-out is governed by three
 * per-request limits that compose, rather than multiply, the individual caps:
 * a shared row budget (`RowBudget`, so `widgets × MAX_RESULT_ROWS` cannot OOM the
 * process), a bounded-concurrency worker pool (`MAX_CONCURRENT_WIDGET_QUERIES`,
 * so one request cannot drain the host's Knex pool), and single-flight dedup on
 * the cache key (so identical widgets in one batch share one pipeline).
 *
 * The row budget is charged at all THREE points where rows enter the response —
 * a fresh query (`runBounded`, `router/execute.ts`), a data-cache hit, and each
 * extra widget that attaches to another widget's single-flighted pipeline — so
 * `sum(results[].rows.length) <= MAX_ROWS_PER_REQUEST` holds no matter which path
 * served a widget. Charging only the fresh-query path left both other paths free:
 * N identical widgets shared one charge yet each serialized a full row array, and
 * a batch of pre-warmed cache hits was never charged at all.
 *
 * PURE FUNCTION GUARANTEE:
 * - No HTTP imports (no express, fastify, koa, etc.)
 * - No process.exit()
 * - No global state mutation
 * - All dependencies injected via options parameter
 *
 * The host app is responsible for:
 * - Parsing the HTTP request body
 * - Calling extractSecurityClaims() to get JwtSecurityClaims
 * - Providing a configured Knex instance
 * - Writing the response to the HTTP response object
 */
import type {
  JwtSecurityClaims,
  BatchQueryRequest,
  BatchQueryResponse,
  BatchWidgetDescriptor,
  WidgetQueryResult,
  HandleBatchQueryOptions,
} from './security/types';
import { generateCacheKey } from './security/cacheKey';
import {
  compileSecurityPolicy,
  type CompiledSecurityPolicy,
} from './security/compileSecurityPolicy';
import { validateQueryPlan } from './security/validateQueryPlan';
import { getDefaultCache, getDefaultTierCache } from './cache/defaultProviders';
import { runPreflight } from './router/preflight';
import {
  chargeRowBudgetOrThrow,
  createRowBudget,
  executeForTier,
  rowBudgetExhaustedError,
  type RowBudget,
} from './router/execute';
import {
  decideTierWithCache,
  DEFAULT_THRESHOLDS,
  tierFromRowCount,
  TIER_CACHE_KEY_PREFIX,
} from './router/tierDecision';
import {
  assertQualifiedColumnsAllowed,
  assertTablesAllowed,
  collectSemiJoinTables,
} from './shared/assertTablesAllowed';
import { describeCause } from './shared/describeCause';
import { resolveQueryTimeoutMs } from './shared/queryTimeout';
import { sanitizeBoundaryError } from './shared/sanitizeError';
import {
  MAX_ARRAY_ITEMS_PER_DESCRIPTOR,
  MAX_ITEMS_PER_BATCH,
  MAX_PREDICATE_VALUES_PER_DESCRIPTOR,
  MAX_STRING_LENGTH,
  MAX_STRING_VALUE_LENGTH,
} from './shared/limits';
import {
  assertBoundedObjectField,
  assertIdAndTableLength,
  checkPredicateValueBounds,
  type DescriptorRef,
} from './shared/requestShapeGuards';
import {
  isCacheEntryShape,
  type CacheEntry,
  type CacheProvider,
  type TierCacheProvider,
} from './cache/types';

const DEFAULT_TIER_CACHE_TTL_MS = 30_000; // 30 seconds — aligned with data cache default

/**
 * Hard ceiling on the number of widgets a single batch request may contain
 * (finding T3 — unbounded widget fan-out). Each widget triggers its own
 * preflight COUNT(*) plus query — with no cap, a single request could fan out an
 * arbitrary amount of database work. Exceeded requests are rejected outright
 * (see `assertValidBatchQueryRequest`) rather than silently truncated, so a
 * caller gets a clear signal instead of a partial, unexplained response.
 *
 * This bounds the COUNT of widgets only. How many of them run at once is bounded
 * separately by `MAX_CONCURRENT_WIDGET_QUERIES`, and how many rows they may
 * collectively materialize by the request's `RowBudget` (both finding H2).
 *
 * Re-exported from this package's `index.ts` so a host that batches on the client
 * side can chunk against the real bound instead of hard-coding 50. `@mui/x-studio`'s
 * `MAX_BATCH_WIDGETS_PER_REQUEST` cannot import it even so — that package must stay
 * free of a dependency on this Node-only, Knex-peered server package — and is
 * therefore a deliberate copy, pinned equal to this one by
 * `src/__tests__/clientWireSeam.test.ts` and by `x-studio`'s own
 * `src/server/createBatchingAdapter.test.ts`. Changing this value means changing
 * that one too.
 */
export const MAX_WIDGETS_PER_BATCH = MAX_ITEMS_PER_BATCH;

/**
 * Maximum number of widget pipelines (preflight `COUNT(*)` + data query) allowed
 * to be in flight at the same time within ONE batch request (finding H2).
 *
 * `MAX_WIDGETS_PER_BATCH` caps how many widgets a request may CONTAIN, but the
 * fan-out itself used to be a bare `Promise.all`, so all of them started at once
 * and the only thing bounding actual concurrency was the host's Knex pool — which
 * the host sizes for its whole application, not for one request. Draining the
 * pool from a single request starves every other request in the process. A small
 * worker pool keeps a batch's queries flowing without letting one caller occupy
 * the entire pool. Per-widget error isolation is unaffected: `processWidget`
 * still resolves with its own `{ error }` result rather than throwing.
 */
export const MAX_CONCURRENT_WIDGET_QUERIES = 6;

/**
 * Run `task` over `items` with at most `limit` concurrent invocations, preserving
 * input order in the returned array (finding H2 — the bounded-concurrency
 * replacement for the previous unbounded `Promise.all` fan-out).
 *
 * A fixed pool of workers pulls the next index off a shared cursor, so a slow
 * widget delays only itself rather than blocking a whole "chunk" the way a
 * chunked `Promise.all` loop would.
 * @param {T} item The next input pulled off the shared cursor.
 * @returns {Promise<R>} Resolves with that item's result, stored at its input index.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        // This IS the concurrency limiter: each worker must finish one item before pulling
        // the next, and `workerCount` workers run this loop in parallel. Awaiting in the
        // loop is the mechanism, not an oversight.
        // eslint-disable-next-line no-await-in-loop
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

/**
 * Widget-specific wording for the shared `checkPredicateValueBounds` (finding
 * Tier2 — this algorithm used to be reimplemented, inline and byte-identical
 * apart from these two details, by the write path's `assertValidBatchMutationRequest`).
 * A widget's `filters`/`semiJoins[].filters` values ARE folded into the query
 * cache key and feed both query building and execution — unlike a mutation's
 * `where` values, which are validated here before a builder ever runs and are
 * never cache-keyed at all (mutation results are invalidated by table tag).
 */
const FILTER_VALUE_BOUNDS_OPTIONS = {
  arrayLengthCostPhrase: 'query-building and execution work',
  maxStringValueLength: MAX_STRING_VALUE_LENGTH,
  valueEntersCacheKeyHash: true,
} as const;

/** Build the `DescriptorRef` a widget-descriptor error is reported against. */
function widgetRef(index: number): DescriptorRef {
  return { noun: 'widget', location: `widgets[${index}]` };
}

/**
 * Enforce the request-shape bounds on a `semiJoins` tree: the array shape, the
 * TOTAL number of semi-join entries across every nesting level, the shape and
 * bounds of each level's own `filters` ARRAY (both individually and summed
 * across the tree), and — via `checkPredicateValueBounds` — each level's own
 * subquery predicate VALUES.
 *
 * WHY THE TOTAL, NOT JUST THE PER-ARRAY LENGTH. `semiJoins` is the descriptor's
 * only RECURSIVE field, so the per-array cap every other collection relies on
 * bounds one level and says nothing about the tree: 200 top-level entries each
 * carrying 200 nested ones individually satisfies that cap while still demanding
 * 40,000 allowlist-checked table references and 40,000 subquery builders for ONE
 * widget. This is the same product gap `totalOnPairs` closes for `joins[].on` and
 * the summed predicate-value cap closes for `filters[].value`, applied to the two
 * dimensions this field opens: the number of semi-join entries (`entryCount`) and
 * — the gap this function also closes — the number of predicate OBJECTS each
 * entry's own `filters` array holds (`filterCount`). `validateSemiJoins`
 * separately caps the DEPTH (`MAX_SEMI_JOIN_DEPTH`), which is a different bound:
 * depth limits how far the recursion goes, this limits how wide the whole tree is.
 *
 * WHY A SEPARATE `filterCount` FROM `checkPredicateValueBounds`'s `valueCount`.
 * `checkPredicateValueBounds` only inspects each predicate's `.value` field — a
 * predicate object with no `value` key (no `operator` either, e.g.
 * `{ column: 'orders.status' }`) contributes 0 to that running total and is
 * invisible to it, so the number of predicate OBJECTS in `filters` was previously
 * unconstrained by any check. `assertTablesAllowed`'s `checkSemiJoinColumns` and
 * `columnValidation`'s `checkSemiJoins` then both do unbounded O(N) allowlist work
 * over that same array, and `computeQueryHash` unbounded O(N) hashing, before a
 * malformed predicate is ever rejected at query-build time — all driven entirely
 * by client input. Bounding the array's LENGTH here, independent of what any
 * element contains, closes that gap the way `entryCount` closes it for the
 * `semiJoins` array itself.
 *
 * Deliberately does NOT reject a malformed entry itself — a non-object entry, a
 * missing `table`, a bad qualification — beyond what it must to walk safely.
 * `assertQualifiedColumnsAllowed` and `validateSemiJoins` own those rejections and
 * report them precisely; duplicating them here would only make the caller's first
 * error message the vaguer of the two.
 *
 * @param semiJoins - The candidate `semiJoins` value at this level.
 * @param index - The widget's index in the batch, for the error message.
 * @param path - Where this array lives on the descriptor, for the error message.
 * @param valueCount - Shared, mutable running total of comparison values (see
 *   `checkPredicateValueBounds` in `shared/requestShapeGuards.ts`).
 * @param entryCount - Shared, mutable running total of semi-join entries.
 * @param filterCount - Shared, mutable running total of predicate OBJECTS across
 *   every semi-join's own `filters` array, at every nesting level.
 */
function checkSemiJoinBounds(
  semiJoins: unknown,
  index: number,
  path: string,
  valueCount: { total: number },
  entryCount: { total: number },
  filterCount: { total: number },
): void {
  if (semiJoins === undefined) {
    return;
  }
  if (!Array.isArray(semiJoins)) {
    throw new Error(
      `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "${path}" must be an array, ` +
        `but received ${JSON.stringify(semiJoins)}. A non-array value cannot be iterated to build the query's ` +
        `subquery predicates and would otherwise throw a confusing internal error instead of a clean ` +
        `validation failure. Ensure "${path}" is an array (or omit it) on every widget descriptor.`,
    );
  }
  entryCount.total += semiJoins.length;
  if (entryCount.total > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) {
    throw new Error(
      `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "semiJoins" contains ` +
        `${entryCount.total} entries in total across every nesting level, which exceeds the maximum of ` +
        `${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} allowed per widget. Each entry is a separate table reference to ` +
        `allowlist-check and a separate subquery to build, so a nested tree can stay under the per-array cap ` +
        `at every level and still sum to an unbounded amount of work for a single widget. Reduce the total ` +
        `number of semi-joins to at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
    );
  }
  semiJoins.forEach((semiJoin, semiJoinIndex) => {
    if (typeof semiJoin !== 'object' || semiJoin === null) {
      return;
    }
    const entryPath = `${path}[${semiJoinIndex}]`;
    // Per-array size cap on this semi-join's own "filters" (the resource-
    // exhaustion gap `checkPredicateValueBounds` cannot close on its own — it
    // only counts VALUES, so a predicate with no "operator"/"value" contributes
    // nothing to that count and left the number of predicate OBJECTS unbounded).
    // Mirrors the per-join "on" cap below and the per-array caps in
    // `assertValidBatchQueryRequest` above: checked BEFORE `checkPredicateValueBounds`
    // so an oversized array is rejected on its length alone, regardless of what
    // (if anything) any single predicate contains.
    const filters = (semiJoin as { filters?: unknown }).filters;
    if (Array.isArray(filters)) {
      if (filters.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) {
        throw new Error(
          `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "${entryPath}.filters" contains ` +
            `${filters.length} entries, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} allowed per ` +
            `semi-join. Each predicate is a separate table/column reference to allowlist-check, a separate cache-key ` +
            `hash input, and a separate subquery predicate to build — regardless of whether it carries an ` +
            `"operator"/"value" the comparison-value cap above can see — so an unbounded array is unbounded work ` +
            `driven entirely by client input. Reduce the number of entries in "${entryPath}.filters" to at most ` +
            `${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
        );
      }
      // Aggregate cap on the TOTAL predicate objects across every semi-join's own
      // "filters" array in this tree (the same product gap `entryCount` closes
      // for the "semiJoins" array itself and `totalOnPairs` closes for
      // `joins[].on`): each semi-join's own "filters" may individually stay
      // under the per-array cap above yet still sum to an unbounded number of
      // predicates to allowlist-check and hash for a single widget.
      filterCount.total += filters.length;
      if (filterCount.total > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) {
        throw new Error(
          `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "semiJoins[].filters" contains ` +
            `${filterCount.total} entries in total across every nesting level, which exceeds the maximum of ` +
            `${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} allowed per widget. Each semi-join's own "filters" array may ` +
            `individually stay under its per-array cap yet still sum to an unbounded number of predicates to ` +
            `allowlist-check, hash, and build for a single widget. Reduce the total number of semi-join filter ` +
            `entries to at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
        );
      }
    }
    checkPredicateValueBounds(
      (semiJoin as { filters?: unknown }).filters,
      widgetRef(index),
      `${entryPath}.filters`,
      valueCount,
      FILTER_VALUE_BOUNDS_OPTIONS,
    );
    checkSemiJoinBounds(
      (semiJoin as { semiJoins?: unknown }).semiJoins,
      index,
      `${entryPath}.semiJoins`,
      valueCount,
      entryCount,
      filterCount,
    );
  });
}

/**
 * Validate the shape of a batch query request body before touching it.
 *
 * A malformed body (`{}`, `null`, `{ widgets: 42 }`, ...) used to reach
 * `body.widgets.map(...)` directly below and throw a raw, unsanitized
 * `TypeError` (e.g. "Cannot read properties of undefined (reading 'map')")
 * instead of one of this package's own `MUI X`-prefixed, actionable errors.
 * This throws up front for the request as a whole — a missing/mistyped
 * `widgets` field (or a batch that fans out to too many widgets) is a defect
 * in the request itself, not a single widget's data, so there is no per-widget
 * `{ error }` result to isolate it into.
 *
 * This also rejects a malformed ELEMENT (e.g. `widgets: [null]`) up front, for
 * the same reason: `processWidget`'s try block dereferences `descriptor.table`
 * to build the query, but its own catch block dereferences `descriptor.id` to
 * report the error — so a `null`/non-object descriptor throws a SECOND,
 * unguarded `TypeError` from inside the catch, rejecting the whole batch's
 * `Promise.all` instead of producing that widget's isolated `{ error }`
 * result. There is no `id` to isolate the error onto, so — like the missing/
 * mistyped `widgets` field above — this is a defect in the request shape
 * itself and the whole request is rejected rather than patched per-widget.
 */
function assertValidBatchQueryRequest(body: BatchQueryRequest): void {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Partial<BatchQueryRequest>).widgets)
  ) {
    throw new Error(
      `MUI X Studio Server: Malformed batch query request — expected an object with a "widgets" array. ` +
        `A missing or non-array "widgets" field cannot be turned into query results, and would otherwise throw a confusing internal error. ` +
        `Send a body shaped like { pageId: string, widgets: BatchWidgetDescriptor[] }.`,
    );
  }
  if (body.widgets.length > MAX_WIDGETS_PER_BATCH) {
    throw new Error(
      `MUI X Studio Server: Batch query request contains ${body.widgets.length} widgets, which exceeds the maximum of ${MAX_WIDGETS_PER_BATCH} allowed per request. ` +
        `Each widget runs its own database query concurrently, so an unbounded batch can fan out an unbounded number of simultaneous queries and overload the database. ` +
        `Split the widgets across multiple requests (e.g. paginate by dashboard page) so each batch stays at or below ${MAX_WIDGETS_PER_BATCH} widgets.`,
    );
  }
  body.widgets.forEach((widget: BatchWidgetDescriptor, index: number) => {
    if (
      typeof widget !== 'object' ||
      widget === null ||
      typeof (widget as Partial<BatchWidgetDescriptor>).id !== 'string' ||
      typeof (widget as Partial<BatchWidgetDescriptor>).table !== 'string'
    ) {
      throw new Error(
        `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — expected an object with ` +
          `string "id" and "table" fields, but received ${JSON.stringify(widget)}. ` +
          `A null or malformed widget descriptor has no "id" to isolate a per-widget error onto, and would ` +
          `otherwise throw a confusing internal error instead of a clean validation failure. ` +
          `Ensure every entry in "widgets" is a BatchWidgetDescriptor with at least an "id" and "table".`,
      );
    }
    // Length cap on "id"/"table" (Tier2 finding — resource exhaustion). Both are
    // confirmed strings above, but neither had a bound on how long that string
    // could be — an oversized "table" is hashed into the query cache key
    // (`security/cacheKey.ts`) on every request and re-checked against the
    // schema allowlist per widget; an oversized "id" is echoed back into every
    // result and excluded from, but still present alongside, the same hash input.
    assertIdAndTableLength(
      widgetRef(index),
      [
        ['id', widget.id],
        ['table', widget.table],
      ],
      'hash',
    );
    // Array-shape guard for the descriptor's collection fields. These are typed
    // as arrays, but the wire value is client JSON — a non-array (e.g.
    // `filters: {}`) would reach a `for...of` deeper in and throw a raw
    // `TypeError` on a non-iterable. Rejecting them up front here — mirroring the
    // precise, up-front shape validation the write path's
    // `assertValidBatchMutationRequest` does — yields this package's own
    // `MUI X`-prefixed error instead of the generic per-widget fallback. Each
    // field is optional, so only a PRESENT non-array value is rejected.
    for (const field of [
      'filters',
      'orderBy',
      'aggregations',
      'joins',
      'columns',
      'having',
    ] as const) {
      const value = (widget as Partial<BatchWidgetDescriptor>)[field];
      if (value !== undefined && !Array.isArray(value)) {
        throw new Error(
          `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "${field}" must be an array, ` +
            `but received ${JSON.stringify(value)}. A non-array value cannot be iterated to build the query and ` +
            `would otherwise throw a confusing internal error instead of a clean validation failure. ` +
            `Ensure "${field}" is an array (or omit it) on every widget descriptor.`,
        );
      }
      // Per-array size cap (finding Tier3 — resource exhaustion). The widget-count
      // cap above (`MAX_WIDGETS_PER_BATCH`) does not bound the size of any ONE
      // widget's own collection fields — a single well-formed-looking widget can
      // still smuggle in an arbitrarily large `filters`/`joins`/`columns`/`orderBy`/
      // `aggregations`/`having` array, which is still unbounded work downstream
      // (query building, plan validation, execution) driven entirely by client input.
      if (Array.isArray(value) && value.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) {
        throw new Error(
          `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "${field}" contains ` +
            `${value.length} entries, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} allowed per ` +
            `widget. An unbounded array is unbounded query-building and execution work driven entirely by client ` +
            `input. Reduce the number of entries in "${field}" to at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
        );
      }
    }
    // Size cap for an `in`-predicate's value list, plus the aggregate cap on the
    // TOTAL comparison values a widget may carry. Both are counted across the
    // widget's OWN `filters` AND every `semiJoins[].filters` at every nesting
    // level (see `checkSemiJoinBounds`) through ONE shared accumulator — a
    // subquery predicate is a bound parameter and a cache-key hash input exactly
    // like a top-level one, so a per-array-only bound would let a descriptor
    // smuggle the whole budget again inside each semi-join.
    const predicateValueCount = { total: 0 };
    checkPredicateValueBounds(
      (widget as Partial<BatchWidgetDescriptor>).filters,
      widgetRef(index),
      'filters',
      predicateValueCount,
      FILTER_VALUE_BOUNDS_OPTIONS,
    );
    checkSemiJoinBounds(
      (widget as Partial<BatchWidgetDescriptor>).semiJoins,
      index,
      'semiJoins',
      predicateValueCount,
      { total: 0 },
      { total: 0 },
    );
    // Message kept byte-identical to the pre-semi-join one on purpose: a
    // subquery predicate value is counted as one of the widget's filter values,
    // not as a new class, so "across all filters" still describes it exactly and
    // the extracted error code stays the same.
    if (predicateValueCount.total > MAX_PREDICATE_VALUES_PER_DESCRIPTOR) {
      throw new Error(
        `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "filters[].value" contains ` +
          `${predicateValueCount.total} comparison values in total across all filters, which exceeds the maximum of ` +
          `${MAX_PREDICATE_VALUES_PER_DESCRIPTOR} allowed per widget. Each filter may individually stay under its ` +
          `own per-predicate cap yet still sum to an unbounded number of bound parameters to hash into the cache ` +
          `key and send to the database for a single widget. Reduce the total number of filter values to at most ` +
          `${MAX_PREDICATE_VALUES_PER_DESCRIPTOR}.`,
      );
    }
    // Size cap for each JOIN's own "on" sub-array (Tier2 finding — resource
    // exhaustion). `joins` is validated as an array (and length-capped as a
    // whole) above, but that cap bounds the NUMBER of joins, not the size of any
    // ONE join's own `on` list — a single join can still smuggle in an
    // arbitrarily large `on` array, which is unbounded schema-allowlist-check,
    // alias-resolution, and ON-clause-building work in `assertQualifiedColumnsAllowed`,
    // `validateJoinOnPairs`, and `buildSecureQuery`'s per-join Knex callback. Only a
    // PRESENT array value is length-capped here; shape validation (non-object join,
    // non-array `on`, malformed pair) happens later in `assertQualifiedColumnsAllowed`.
    const joins = (widget as Partial<BatchWidgetDescriptor>).joins;
    if (Array.isArray(joins)) {
      // Aggregate cap on the TOTAL "on"-pairs across every join in this widget
      // (Tier2 finding — the per-join cap above bounds each join independently,
      // but not their PRODUCT). A widget with, say, 200 joins × 200 "on" pairs
      // each passes the per-join cap individually yet still forces
      // building/allowlist-checking up to 40,000 join conditions for ONE widget
      // — and with up to `MAX_WIDGETS_PER_BATCH` widgets processed concurrently,
      // a single request could require millions of join-condition operations.
      // Summed IN ADDITION TO (not instead of) the per-join cap below, so both
      // an individual join and the aggregate total are bounded. The total is
      // capped at the same `MAX_ARRAY_ITEMS_PER_DESCRIPTOR` used for every other
      // per-widget collection, rather than a separate constant.
      let totalOnPairs = 0;
      joins.forEach((join, joinIndex) => {
        const on = (join as { on?: unknown } | null)?.on;
        if (Array.isArray(on)) {
          if (on.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) {
            throw new Error(
              `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "joins[${joinIndex}].on" ` +
                `contains ${on.length} entries, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} allowed ` +
                `per join. An unbounded "on" list is unbounded schema-allowlist-check, alias-resolution, and ` +
                `ON-clause-building work driven entirely by client input. Reduce the number of entries in ` +
                `"joins[${joinIndex}].on" to at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
            );
          }
          totalOnPairs += on.length;
        }
      });
      if (totalOnPairs > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) {
        throw new Error(
          `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "joins[].on" contains ` +
            `${totalOnPairs} entries in total across all joins, which exceeds the maximum of ` +
            `${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} allowed per widget. Each join may individually stay under its own ` +
            `per-join cap yet still sum to an unbounded number of join conditions to build and allowlist-check for ` +
            `a single widget. Reduce the total number of "on" pairs across every join to at most ` +
            `${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
        );
      }
    }
    // Shape guard + key-count cap for "columnAliases" (Tier2 + Tier3 findings).
    // Unlike `filters`/`orderBy`/`aggregations`/`joins`/`columns`/`having` above,
    // `columnAliases` is a plain `Record<string,string>`, not an array, so it falls
    // outside the `Array.isArray` shape-guard loop entirely and previously got no
    // shape check AND no size cap — even though it is exactly the same class of
    // client-controlled per-widget collection those caps exist for, and is hashed
    // unbounded in `computeQueryHash` (`security/cacheKey.ts`). This is not an
    // exploitable bypass on its own (`resolveAlias`'s own-property gate plus
    // downstream re-validation already contain a malformed value), but is worth
    // guarding explicitly for the same "clean MUI X error over a raw TypeError /
    // unbounded work" reasons as every other field here. Only a PRESENT value is
    // checked — the field is optional.
    const columnAliases = (widget as Partial<BatchWidgetDescriptor>).columnAliases;
    // Length cap on each key/value STRING (Tier2 finding — resource
    // exhaustion). The key-COUNT cap bounds how many entries "columnAliases"
    // may hold, but not how long any one key (the logical field id) or value
    // (the physical column reference) may be — both are hashed unbounded in
    // `computeQueryHash` (`security/cacheKey.ts`) and the value is
    // additionally re-validated as a column reference downstream.
    assertBoundedObjectField(columnAliases, {
      fieldName: 'columnAliases',
      ref: widgetRef(index),
      perDescriptorNoun: 'widget',
      requireStringValues: true,
      shapeDescription: 'object mapping logical field ids to string column references',
      invalidShapeConsequence:
        'A non-object value (or one with non-string values) cannot be safely resolved into column ' +
        'references and would otherwise throw a confusing internal error instead of a clean validation failure.',
      shapeCorrectiveInstruction:
        'Ensure "columnAliases" is a { [logicalId: string]: string } object (or omit it).',
      keyCountConsequence:
        'An unbounded number of column aliases is unbounded alias-resolution work (and an unbounded ' +
        'cache-key hash input) driven entirely by client input.',
      keyLengthConsequence:
        'An unbounded key is expensive to hash (it is folded into the query cache key) and to resolve ' +
        'repeatedly across a batch.',
      valueLengthLimit: MAX_STRING_LENGTH,
      valueLengthIsIdentifierBound: true,
      valueLengthConsequence:
        'An unbounded value is expensive to hash (it is folded into the query cache key) and to resolve ' +
        'repeatedly across a batch.',
      valueShortenMentionsKey: false,
    });
  });
}

/**
 * Handle a batch query request from a Studio dashboard.
 *
 * @param body - Parsed request body (BatchQueryRequest)
 * @param claims - Verified JWT security claims from extractSecurityClaims()
 * @param options - Knex instance, optional cache provider, schema allowlist
 */
export async function handleBatchQuery(
  body: BatchQueryRequest,
  claims: JwtSecurityClaims,
  options: HandleBatchQueryOptions,
): Promise<BatchQueryResponse> {
  assertValidBatchQueryRequest(body);
  const { db, schemaAllowlist, columnAllowlist, thresholds, tenancy, securityColumns, cacheScope } =
    options;
  // ── Compile the row-level-security policy ONCE for the whole request ───────
  // The single compiled object is threaded down in place of the raw
  // `(tenancy, securityColumns)` pair: the resolution chain now runs once here
  // instead of fresh at every enforcement site, and `policy.digest` folds the
  // resolved policy into the cache key so differently-scoped nodes never share
  // cache entries (Gap B).
  //
  // `schemaAllowlist` is folded in for the same reason it separates DATA SOURCES
  // (finding 3): two option sets in one process that expose different tables get
  // different digests, hence different cache keys, without the host having to
  // remember to set `cacheScope`.
  const policy = compileSecurityPolicy({
    tenancy,
    securityColumns,
    columnAllowlist,
    schemaAllowlist,
  });
  const cacheProvider = options.cacheProvider ?? getDefaultCache();
  // Validated ONCE, here at the option boundary, rather than at each query site
  // (F2): a bad `queryTimeoutMs` is a host misconfiguration, so it must reject the
  // whole request with one clear error instead of surfacing as the same
  // `{ error }` on all 50 widgets.
  const queryTimeoutMs = resolveQueryTimeoutMs(options.queryTimeoutMs);
  const tierCacheTtlMs = options.tierCacheTtlMs ?? DEFAULT_TIER_CACHE_TTL_MS;
  const tierCacheProvider =
    tierCacheTtlMs > 0 ? (options.tierCacheProvider ?? getDefaultTierCache()) : null;

  // Table-allowlist validation and column-reference plan compilation are NOT
  // precomputed here before the fan-out — they run per widget INSIDE
  // `processWidget`'s try block (below), so a single widget's invalid table /
  // HAVING alias / unsafe agg-or-output alias / non-asc|desc ORDER BY direction /
  // column-allowlist violation becomes THAT widget's `{ error }` result instead of
  // rejecting the whole batch. This makes the validation stage honor the same
  // per-widget error-isolation invariant the cache/preflight/execute stages and the
  // unsupported-operator/func throws in `executeForTier` already do.
  //
  // RESOURCE BOUNDS (finding H2) — the fan-out is no longer a bare `Promise.all`:
  //   - `context.rowBudget` is one shared, mutable row allowance for the WHOLE
  //     request, so `MAX_WIDGETS_PER_BATCH × MAX_RESULT_ROWS` can no longer
  //     multiply into a single-request OOM.
  //   - `mapWithConcurrency` caps how many widget pipelines run at once, so one
  //     request cannot drain the host's Knex pool.
  //   - `context.inFlight` single-flights identical descriptors (the widget `id`
  //     is deliberately excluded from the cache key, so duplicates share one),
  //     collapsing N identical widgets to ONE preflight + ONE query instead of N
  //     of each that all miss the cache because they started concurrently.
  const context: BatchRequestContext = {
    db,
    claims,
    cacheProvider,
    tierCacheProvider,
    tierCacheTtlMs,
    thresholds,
    policy,
    schemaAllowlist,
    columnAllowlist,
    cacheScope,
    queryTimeoutMs,
    rowBudget: createRowBudget(),
    inFlight: new Map(),
  };
  const results: WidgetQueryResult[] = await mapWithConcurrency(
    body.widgets,
    MAX_CONCURRENT_WIDGET_QUERIES,
    (descriptor: BatchWidgetDescriptor) => processWidget(context, descriptor),
  );

  return {
    pageId: body.pageId,
    results,
  };
}

/**
 * Everything one batch request shares across its widgets — the injected
 * dependencies, the compiled security policy, and the two per-request resource
 * governors added for finding H2 (`rowBudget`, `inFlight`).
 *
 * Bundled into one object rather than threaded as ~12 positional arguments so a
 * new per-request concern can be added without every call site growing another
 * parameter (and without a caller silently transposing two of them).
 */
interface BatchRequestContext {
  db: any;
  claims: JwtSecurityClaims;
  cacheProvider: CacheProvider;
  tierCacheProvider: TierCacheProvider | null;
  tierCacheTtlMs: number;
  thresholds: HandleBatchQueryOptions['thresholds'];
  policy: CompiledSecurityPolicy;
  schemaAllowlist: HandleBatchQueryOptions['schemaAllowlist'];
  columnAllowlist: HandleBatchQueryOptions['columnAllowlist'];
  cacheScope: HandleBatchQueryOptions['cacheScope'];
  /**
   * Per-query statement timeout in milliseconds, already validated and defaulted
   * by `resolveQueryTimeoutMs` (F2). Threaded into `runPreflight` and
   * `executeForTier`, which apply it inside their single execution helpers so no
   * exit path can issue an untimed query.
   */
  queryTimeoutMs: number;
  /**
   * Shared, mutable row allowance for the whole request (finding H2). Threaded
   * into every `executeForTier` call, which caps its LIMIT at what is left and
   * decrements it by the rows actually returned.
   */
  rowBudget: RowBudget;
  /**
   * Single-flight map keyed by the security-scoped cache key (finding H2). Two
   * widgets whose descriptors differ only in `id` produce the SAME key — the id
   * is deliberately excluded from `computeQueryHash` — so they share one
   * in-progress pipeline instead of each running its own preflight + query and
   * all missing the cache because they started concurrently.
   */
  inFlight: Map<string, Promise<WidgetQueryOutcome>>;
}

/** The part of a `WidgetQueryResult` that depends only on the query shape, not on the widget `id`. */
type WidgetQueryOutcome = Omit<WidgetQueryResult, 'id' | 'error'>;

async function processWidget(
  context: BatchRequestContext,
  descriptor: BatchWidgetDescriptor,
): Promise<WidgetQueryResult> {
  const { claims, policy, schemaAllowlist, columnAllowlist, cacheScope } = context;

  try {
    // ── 0. Per-widget input validation (inside the try for error isolation) ──
    // Both classes of client-input validation run HERE, per widget, rather than
    // synchronously before the fan-out, so a validation throw becomes this
    // widget's `{ error }` result via the catch below instead of rejecting every
    // well-formed sibling widget too. Ordering is preserved exactly as when these
    // ran up front: the widget's tables (primary + joins) are validated BEFORE its
    // column-reference plan, and both BEFORE cache/preflight/execute.
    //
    // `assertTablesAllowed` enforces the Zero-Knowledge Rule (a table not in the
    // allowlist is rejected before any query is built). `assertQualifiedColumnsAllowed`
    // closes the same rule's gap for a table named ONLY via a qualified column
    // reference (`columns` / `filters` / `orderBy` / `columnAliases`) — it runs
    // UNCONDITIONALLY, unlike `validateDescriptorColumns` below, which only checks
    // this when a `columnAllowlist` happens to be configured. `validateQueryPlan`
    // runs the unconditional HAVING/aggregation-alias/output-alias/ORDER-BY-direction
    // validators and, when a `columnAllowlist` is configured, the fail-closed
    // column-allowlist check — then resolves every column reference into a
    // `ValidatedQueryPlan` whose fields are already-resolved `ColumnRef`s, threaded
    // down in place of the raw descriptor's logical column names + `columnAliases`
    // map so `runPreflight` / `executeForTier` never re-derive alias resolution.
    // Skip any null/non-object join element when extracting join table names —
    // otherwise `.table` on a `null` join (`joins: [null]`) throws a raw
    // `TypeError` here, BEFORE `assertQualifiedColumnsAllowed` below (which now
    // guards that element) can produce this package's precise "malformed entry"
    // error. A malformed join element is rejected there with a clean message; the
    // real join tables are still validated here.
    assertTablesAllowed(
      [
        descriptor.table,
        ...(descriptor.joins ?? [])
          .filter((j) => typeof j === 'object' && j !== null)
          .map((j) => j.table),
        // A `semiJoins[].table` is a real FROM clause in a subquery, so it is a
        // table the query TOUCHES and must clear the Zero-Knowledge Rule exactly
        // like a joined table. Omitting it would make the subquery the one way to
        // read an unallowlisted table's contents — not by returning its rows, but
        // by choosing which of the caller's own rows survive the `IN` test.
        // Collected recursively (a nested semi-join's table counts too) through
        // the shared `collectSemiJoinTables`, the same helper the cache tags use.
        ...collectSemiJoinTables(descriptor.semiJoins),
      ],
      schemaAllowlist,
    );
    assertQualifiedColumnsAllowed(descriptor, schemaAllowlist);
    const plan = validateQueryPlan(descriptor, columnAllowlist);

    // Fold the compiled policy's digest into the cache key so a policy change (e.g.
    // tightening a `perTable` scope mid-rollout) invalidates stale-scope entries
    // instead of a differently-scoped node serving them (Gap B).
    // Generated INSIDE the try block (finding 2.3): `generateCacheKey` throws when
    // no HMAC secret is configured (`CACHE_HMAC_SECRET` / `JWT_SECRET` both unset),
    // and every widget-scoped operation must honor the per-widget error-isolation
    // invariant — a throw here must produce this widget's `{ error }` result, not
    // reject the whole batch.
    const cacheKey = generateCacheKey(claims, descriptor, undefined, policy.digest, cacheScope);

    // ── 0b. Single-flight dedup within this batch (finding H2) ───────────────
    // The widget `id` is deliberately excluded from `computeQueryHash`, so N
    // widgets whose query shape is identical resolve to ONE `cacheKey`. Before
    // this, they were all started concurrently by a bare `Promise.all`, so every
    // one of them missed the (not-yet-populated) cache and ran its own COUNT(*)
    // preflight plus its own full query — N× the round-trips and N× the memory
    // for one logical result. Sharing the in-progress promise collapses them to a
    // single pipeline; each caller still gets its OWN `{ id }` and its own
    // `{ error }` isolation (the shared promise's rejection is caught per widget
    // by the catch below).
    const { inFlight } = context;
    let pipeline = inFlight.get(cacheKey);
    // Whoever CREATES the pipeline is the widget its internal row-budget charge
    // is made on behalf of (`runBounded`, or the cache-hit charge in
    // `runWidgetPipeline`); every other widget attaching to it is charged below.
    const ownsPipeline = pipeline === undefined;
    if (pipeline === undefined) {
      // The `.finally` cleanup is stored (not merely attached) so every awaiter
      // observes the SAME derived promise — a rejection therefore always has a
      // handler and can never surface as an unhandled rejection.
      pipeline = runWidgetPipeline(context, descriptor, plan, cacheKey).finally(() => {
        inFlight.delete(cacheKey);
      });
      inFlight.set(cacheKey, pipeline);
    }
    const outcome = await pipeline;
    if (!ownsPipeline) {
      // Dedup collapses the DB WORK, never the RESPONSE: each of the N widgets
      // sharing this pipeline still serializes its own full copy of these rows
      // into the JSON body. Charging once per pipeline therefore let 50 identical
      // widgets put 50 × MAX_RESULT_ROWS rows in one response against a
      // MAX_ROWS_PER_REQUEST budget — the exact figure the budget exists to
      // prevent. Charge once per AWAITING widget instead; a widget that no longer
      // fits fails via the catch below rather than adding rows.
      chargeRowBudgetOrThrow(context.rowBudget, outcome.rows.length);
    }
    // ROW-ARRAY ALIASING (finding L3): the spread copies the outcome's FIELDS,
    // so every widget sharing this pipeline returns the SAME `rows` array
    // instance (as does every widget served from one data-cache hit, above).
    // That is deliberate — cloning per widget would defeat the dedup's memory
    // benefit, which is most of its point — and it is documented as a
    // no-mutation contract on `WidgetQueryResult.rows` / `BatchQueryResponse`,
    // mirroring the one `CacheProvider.get` already carries for the same reason.
    return { id: descriptor.id, ...outcome };
  } catch (err) {
    return {
      id: descriptor.id,
      rows: [],
      tier: 'db',
      rowCount: 0,
      // Never return a raw DB-driver error verbatim (finding T3.5): our own
      // validation messages pass through, but a driver error (e.g. `no such column`)
      // is a schema oracle, so it is logged server-side and replaced with a generic
      // message here — even when no `columnAllowlist` is configured.
      error: sanitizeBoundaryError(
        err,
        `MUI X Studio Server: The query for this widget could not be completed. ` +
          `The underlying cause has been logged server-side; inspect the server logs to diagnose it. ` +
          `If it persists, verify the widget's table, column, and filter configuration.`,
      ),
    };
  }
}

/**
 * Was this pending cache entry overtaken by a mutation while its rows were being
 * read? See `CacheProvider.wereTagsInvalidatedSince` for the race and for why the
 * provider method is optional.
 *
 * TWO DEGRADATIONS, IN OPPOSITE DIRECTIONS, both deliberate:
 *   - A provider that does NOT implement the hook answers `false` — the
 *     documented fallback, which reproduces the previous behavior exactly rather
 *     than refusing to cache for every host with a custom provider.
 *   - A hook that THROWS answers `true`. Freshness could not be established, and
 *     the fail-closed direction here is "don't cache", which costs a re-query;
 *     the alternative costs a stale answer for the whole TTL. It is warned about
 *     and never fails the widget, matching how every other cache-backend failure
 *     on this path degrades (finding 2.6).
 */
async function tagsInvalidatedSinceRead(
  cacheProvider: CacheProvider,
  tags: string[],
  rowsReadAt: number,
): Promise<boolean> {
  if (typeof cacheProvider.wereTagsInvalidatedSince !== 'function') {
    return false;
  }
  try {
    return await cacheProvider.wereTagsInvalidatedSince(tags, rowsReadAt);
  } catch (cacheErr) {
    console.warn(
      `MUI X Studio Server: could not check whether a mutation invalidated this widget's tables while its rows ` +
        `were being read; the result is still returned but is NOT being cached, so a just-committed write cannot ` +
        `be hidden behind a stale entry. Subsequent requests will re-query the DB until the cache backend ` +
        `recovers. Cause: ${describeCause(cacheErr)}`,
    );
    return true;
  }
}

/**
 * The id-independent half of a widget's pipeline: cache lookup → tier decision →
 * execution → cache population.
 *
 * Split out of `processWidget` so it can be shared by every widget in the batch
 * that resolves to the same `cacheKey` (finding H2). It deliberately returns a
 * `WidgetQueryOutcome` with no `id` — the id is the one thing duplicates do NOT
 * share, so it is attached by each caller instead.
 */
async function runWidgetPipeline(
  context: BatchRequestContext,
  descriptor: BatchWidgetDescriptor,
  plan: ReturnType<typeof validateQueryPlan>,
  cacheKey: string,
): Promise<WidgetQueryOutcome> {
  const {
    db,
    claims,
    cacheProvider,
    tierCacheProvider,
    tierCacheTtlMs,
    thresholds,
    rowBudget,
    queryTimeoutMs,
  } = context;
  const queryOptions = context.policy;

  // Resolved ONCE, before the cache read, because BOTH planes need them: the
  // tier decision below, and the data-cache hit's own tier derivation (see
  // step 1). Reading them in one place is what lets the two planes share a
  // single tier rule instead of re-implementing it.
  const resolvedThresholds = {
    client: thresholds?.clientTier ?? DEFAULT_THRESHOLDS.client,
    server: thresholds?.serverMemoryTier ?? DEFAULT_THRESHOLDS.server,
  };

  // ── 1. Data cache check ────────────────────────────────────────────────
  // The cache is a best-effort layer in FRONT of the authoritative DB: a cache
  // read failure (e.g. Redis down) must degrade to a fresh DB fetch, not fail
  // the widget. Catch here and treat the error as a miss (finding 2.6).
  let cached: CacheEntry | undefined;
  try {
    cached = await cacheProvider.get(cacheKey);
  } catch (cacheErr) {
    cached = undefined;
    console.warn(
      `MUI X Studio Server: cache read failed for a widget; falling back to the database. ` +
        `The result is still served from the DB, but the cache backend should be checked. ` +
        `Cause: ${describeCause(cacheErr)}`,
    );
  }
  // SHAPE-CHECK THE HIT (finding L5). A `CacheProvider` is host-pluggable and its
  // backing store is not exclusively ours: a Redis deployment with no `keyPrefix`
  // can collide with the host's own keys, a partially-written value can be read
  // back, and a custom provider can simply be buggy. Any of those makes `cached`
  // truthy while its fields are not what their types promise — and this handler
  // would then hand them straight to the client.
  //
  // ALL THREE consumed fields are checked, via the SHARED `isCacheEntryShape`
  // (`cache/types.ts`) that `RedisCacheProvider.get` also uses, so the two
  // readers cannot drift on what a usable entry is. Checking only
  // `Array.isArray(cached.rows)` — as this site used to — left `tier` and
  // `rowCount` trusted verbatim behind a `??` that substitutes on null/undefined
  // only: `{ rows: [...], tier: 'banana', rowCount: NaN }` passed the guard and
  // populated a `WidgetQueryResult` whose types declare `tier:
  // 'client'|'server'|'db'` and `rowCount: number`. The Studio client switches on
  // `tier` to decide whether to filter/aggregate in-browser and renders
  // `rowCount` as the total, so neither is inert.
  //
  // Treat a structurally invalid entry as a MISS and re-query, reusing the same
  // degradation path as a cache read failure above.
  if (cached !== undefined && !isCacheEntryShape(cached)) {
    console.warn(
      `MUI X Studio Server: discarded a malformed cache entry for a widget (its "rows" field is not an array, or ` +
        `its "tier"/"rowCount" field is present but is not one of client/server/db / not a finite number); ` +
        `falling back to the database. The result is still served from the DB, but the cache backend should be ` +
        `checked for a key collision (set a "keyPrefix" if the store is shared) or a faulty CacheProvider.`,
    );
    cached = undefined;
  }
  if (cached) {
    // A cache hit costs no database work but still materializes (the provider
    // `structuredClone`s on read) and serializes a full row array into the
    // response, so it consumes the request's row budget exactly like a fresh
    // query. Returning here before `executeForTier` used to skip the charge
    // entirely, so a batch of pre-warmed widgets could return
    // MAX_WIDGETS_PER_BATCH × MAX_RESULT_ROWS rows with the budget untouched.
    chargeRowBudgetOrThrow(rowBudget, cached.rows.length);
    // Echo the ORIGINATING rowCount (the preflight COUNT(*)) — not
    // `cached.rows.length`, which is the (possibly limit-truncated) row count
    // and would flip the reported total between the cold-miss and cache-hit
    // responses. Falls back to the row length for entries written before
    // rowCount was persisted.
    const cachedRowCount = cached.rowCount ?? cached.rows.length;
    return {
      rows: cached.rows,
      // ONE tier rule across both cache planes (finding M2). This site used to
      // echo `cached.tier` verbatim while `router/tierDecision.ts` deliberately
      // did the opposite — re-deriving from the cached `rowCount` — and neither
      // site knew about the other. `thresholds` is folded into neither the cache
      // key nor the policy digest (which is precisely the justification
      // `tierDecision.ts` gives for re-deriving), so a data-cache entry written
      // by a node running `clientTier: 10_000` was reported as 'client' by a
      // mid-rollout node whose own config says 'server'. The rows are identical
      // either way; the client's in-browser filter/aggregate decision is not.
      //
      // The data cache stores `rowCount` alongside `tier`, so it can re-derive
      // identically — and does, through the same exported `tierFromRowCount`.
      // This also makes the reported `tier` and `rowCount` mutually consistent by
      // construction, which echoing could not guarantee. Aggregation results are
      // never written to this cache (see the `tier !== 'db' || !hasAggregations`
      // gate below), so a stored `rowCount` is always a preflight COUNT(*), the
      // exact input `tierFromRowCount` expects.
      tier: tierFromRowCount(cachedRowCount, resolvedThresholds),
      rowCount: cachedRowCount,
    };
  }

  // ── 1b. Budget exhausted? Fail before ANY round-trip ───────────────────
  // `executeForTier` documents the rule this enforces: a widget starved by
  // earlier widgets in the same batch fails "WITHOUT issuing a query at all",
  // because a round-trip per remaining widget is exactly the fan-out the budget
  // exists to contain. Its own check sits inside `executeForTier`, which runs
  // AFTER the tier decision below — so before this guard existed a starved
  // widget still issued a full COUNT(*) preflight: built through
  // `buildSecureQuery` with every join, semi-join subquery and filter applied,
  // and deliberately with no LIMIT, which makes it typically the MORE expensive
  // of the two round-trips being suppressed. One request could spend
  // `MAX_ROWS_PER_REQUEST` on widget 0 and still pay a full COUNT(*) for each of
  // 49 distinct-shaped siblings.
  //
  // Placed after the data-cache read on purpose: a cache HIT costs no database
  // work, and its own charge (above) already fails a widget whose cached rows no
  // longer fit. This guard is about the round-trips a MISS is otherwise about to
  // make. `executeForTier`'s check stays in place as defense in depth — the two
  // are not redundant, since concurrent widgets can exhaust the budget in the
  // window between them.
  if (rowBudget !== undefined && rowBudget.remaining <= 0) {
    throw rowBudgetExhaustedError(rowBudget.remaining);
  }

  // ── 2 & 3. Tier decision: aggregation check → tier cache → COUNT(*) ───
  const hasAggregations = (descriptor.aggregations?.length ?? 0) > 0;

  const tierDecision = await decideTierWithCache(
    hasAggregations,
    // Namespace the tier plane's key so it can never collide with the data
    // plane's entry for the same widget on a shared Redis client (finding 2.1).
    TIER_CACHE_KEY_PREFIX + cacheKey,
    () =>
      runPreflight(db, claims, descriptor, queryOptions, plan, queryTimeoutMs).then(
        (p) => p.rowCount,
      ),
    tierCacheProvider,
    resolvedThresholds,
    tierCacheTtlMs,
  );
  const tier: 'client' | 'server' | 'db' = tierDecision.tier;
  // NOTE (finding 3.2 — best-effort `rowCount`): for a NON-aggregation widget
  // served from a tier-cache HIT, `tierDecision.rowCount` is the preflight
  // COUNT(*) captured when the tier entry was written, up to the tier TTL ago
  // (`DEFAULT_TIER_CACHE_TTL_MS`, 30s). A mutation invalidates the DATA cache by
  // tag (`handleMutation` → `deleteByTag`), but the `TierCacheProvider` interface
  // exposes only `get`/`set`/`invalidatePrefix` — no tag-based invalidation — so
  // the tier entry (and its `rowCount`) is NOT evicted on a write and can lag a
  // just-committed insert/delete by ≤ the tier TTL. The returned ROWS are always
  // fresh (re-read from the DB on this request, or from the freshly-invalidated
  // data cache); only this reported total is best-effort within the tier window.
  let rowCount: number = tierDecision.rowCount;

  // ── 4. Execute query for the selected tier ─────────────────────────────
  // `rowBudget` is the request-wide row allowance (finding H2): it caps this
  // query's LIMIT at whatever the batch has left and is charged by the rows
  // actually returned, so 50 unbounded widgets can no longer sum to 50 ×
  // `MAX_RESULT_ROWS` rows in one response. If the budget — rather than the
  // client's own `limit` — is what shortened this result, `executeForTier`
  // THROWS instead of returning the short slice, so the rows below are always a
  // complete answer for the limit the client asked for.
  //
  // Timestamped BEFORE the query runs: the rows about to be fetched reflect
  // database state at or after this instant, so any `deleteByTag` for one of this
  // entry's tags recorded at or after it may concern a write this query could
  // have missed. Step 5 uses it to decide whether caching them is still safe.
  // Taking it before (rather than after) execution is the conservative side —
  // it can only widen the window, never narrow it.
  const rowsReadAt = Date.now();
  const rows = await executeForTier(
    db,
    claims,
    descriptor,
    tier,
    queryOptions,
    plan,
    rowBudget,
    queryTimeoutMs,
  );

  // For aggregation queries decideTier returns rowCount=0 (bypassed);
  // use the actual number of result groups instead.
  if (hasAggregations) {
    rowCount = rows.length;
  }

  // ── 5. Populate data cache ──────────────────────────────────────────────
  // Aggregation queries are ALWAYS routed to the 'db' tier (step 2 above) and
  // return grouped/aggregated rows keyed by the aggregation shape — left
  // uncached here (unchanged, historical behavior). A NON-aggregation 'db'-tier
  // result (finding 3.2), in contrast, is a plain RAW row slice — the exact
  // same shape `executeForTier` returns for 'client'/'server' — routed to 'db'
  // only because its preflight COUNT(*) exceeded `serverMemoryTier`. It is just
  // as reusable as a 'client'/'server' result, so it is cached the same way;
  // leaving it uncached (the historical behavior, and what the stale comment
  // here used to claim for ALL 'db'-tier results) meant a query too large for
  // the server tier re-ran on every request and re-shipped a potentially
  // >100k-row slice on every hit.
  // Tag with the primary table AND every joined table so a mutation to any of
  // them invalidates this cached (joined) result — tagging only the primary
  // table would leave joined rows stale until TTL. Persist `rowCount` so a
  // later cache hit reports the same total as the cold miss.
  //
  // ONLY COMPLETE RESULTS ARE CACHED. `rows` here can never be a
  // budget-degraded slice: the cache key is derived from `(claims, policy,
  // descriptor)` and carries no budget dimension, so caching a result the
  // SERVER shortened would hand later requests — including other users sharing
  // the security profile — a truncated slice labelled with the full `rowCount`,
  // for the whole TTL, with no way to tell it apart from a normal limited page.
  // The invariant is upheld upstream rather than by a flag: `executeForTier`
  // throws on any budget-driven degradation, so this line is only reached with a
  // result that is complete for the limit the client itself requested.
  if (tier !== 'db' || !hasAggregations) {
    const tags = [
      descriptor.table,
      ...(descriptor.joins?.map((j) => j.table) ?? []),
      // A semi-joined table decides which outer rows survive, so a mutation
      // to it changes this result exactly as a mutation to a joined table
      // does — a customer stops matching the moment its last shipped order
      // is deleted. Untagged, that result would keep being served for the
      // whole TTL.
      ...collectSemiJoinTables(descriptor.semiJoins),
    ];

    // ONLY REACHED IF THIS READ WAS NOT OVERTAKEN BY A MUTATION. `deleteByTag`
    // can only evict keys that ALREADY EXIST, and this one is being written now:
    // a read that executed its SELECT before a mutation committed, and reaches
    // this line after that mutation's `deleteByTag` ran, would store
    // pre-mutation rows under a key the eviction never saw — making a committed
    // write invisible to every reader sharing the security profile for the whole
    // TTL, which is precisely what "a successful mutation always invalidates"
    // says cannot happen. The rows are still RETURNED to this caller (its query
    // genuinely saw them); only the cache write is dropped.
    //
    // Cost is one small read per cached widget, and only on a cache MISS.
    if (await tagsInvalidatedSinceRead(cacheProvider, tags, rowsReadAt)) {
      return { rows, tier, rowCount };
    }

    // The rows are already in hand from the DB — a cache WRITE failure must not
    // discard them. Catch and degrade to "served, uncached" (finding 2.6).
    try {
      await cacheProvider.set(
        cacheKey,
        // SHALLOW-COPY THE ROW ARRAY (finding L3, write side). `rows` is ALSO the
        // array this function returns to the host, and an in-process provider
        // stores what it is given by reference (`LRUCacheProvider` clones only on
        // `get`). Handing over the same array made the host's own result and the
        // process-wide server cache one object: a host that post-processed
        // `results[i].rows` in place wrote into the cache, and every subsequent hit
        // for the whole TTL served the mutated rows to every user sharing the
        // security profile. A shallow copy severs the ARRAY identity for the cost
        // of one pointer array. The row OBJECTS stay shared on purpose — cloning
        // them would defeat the memory rationale for the single-flight dedup — so
        // the documented no-mutation contract on `WidgetQueryResult.rows` and
        // `CacheProvider.set` still governs in-place row edits.
        { rows: [...rows], cachedAt: Date.now(), tier, rowCount },
        { tags },
      );
    } catch (cacheErr) {
      console.warn(
        `MUI X Studio Server: cache write failed for a widget; the result is still returned. ` +
          `Subsequent requests will re-query the DB until the cache backend recovers. ` +
          `Cause: ${describeCause(cacheErr)}`,
      );
    }
  }

  return { rows, tier, rowCount };
}
