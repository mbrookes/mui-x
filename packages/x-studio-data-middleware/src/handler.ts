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
import { createRowBudget, executeForTier, type RowBudget } from './router/execute';
import {
  decideTierWithCache,
  DEFAULT_THRESHOLDS,
  TIER_CACHE_KEY_PREFIX,
} from './router/tierDecision';
import { assertQualifiedColumnsAllowed, assertTablesAllowed } from './shared/assertTablesAllowed';
import { sanitizeBoundaryError } from './shared/sanitizeError';
import {
  MAX_ARRAY_ITEMS_PER_DESCRIPTOR,
  MAX_STRING_LENGTH,
  MAX_STRING_VALUE_LENGTH,
} from './shared/limits';
import type { CacheEntry, CacheProvider, TierCacheProvider } from './cache/types';

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
 */
export const MAX_WIDGETS_PER_BATCH = 50;

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
    for (const [field, value] of [
      ['id', widget.id],
      ['table', widget.table],
    ] as const) {
      if (value.length > MAX_STRING_LENGTH) {
        throw new Error(
          `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "${field}" is ${value.length} ` +
            `characters long, which exceeds the maximum of ${MAX_STRING_LENGTH} allowed. ` +
            `An unbounded "${field}" string is expensive to hash and serialize repeatedly across a batch. ` +
            `Shorten "${field}" to at most ${MAX_STRING_LENGTH} characters.`,
        );
      }
    }
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
    // Size cap for an `in`-predicate's value list. `filters` is validated as an
    // array above (or absent), so it is safe to iterate here. `filters[].value` is
    // NOT validated for shape yet (that happens later, per widget, via
    // `isScalarComparisonValue`/`isPrimitivePredicateElement` in `shared/predicates.ts`)
    // — only a PRESENT array value is length-capped here, regardless of operator,
    // so a pathologically long `in`-list can't reach query building at all.
    const filters = (widget as Partial<BatchWidgetDescriptor>).filters;
    if (Array.isArray(filters)) {
      filters.forEach((predicate, predicateIndex) => {
        const predicateValue = (predicate as { value?: unknown } | null)?.value;
        if (
          Array.isArray(predicateValue) &&
          predicateValue.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR
        ) {
          throw new Error(
            `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "filters[${predicateIndex}].value" ` +
              `contains ${predicateValue.length} entries, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} ` +
              `allowed per predicate. An unbounded "in" value list is unbounded query-building and execution work ` +
              `driven entirely by client input. Reduce the number of entries to at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
          );
        }
        // Length cap on a scalar/"in"-element STRING value (Tier2 finding —
        // resource exhaustion). `filters[].value` had no cap on individual
        // string length anywhere — a single scalar (or "in"-list element) string
        // is folded into the query cache-key hash (`computeQueryHash`) and,
        // uncached, reaches the database as a bound parameter. Uses the larger
        // `MAX_STRING_VALUE_LENGTH` bound (not `MAX_STRING_LENGTH`): a filter
        // value is business data, not an identifier, and may legitimately need
        // more headroom. Only PRESENT string values are checked, whether the
        // predicate carries a bare scalar or an array (`in`) of values — full
        // shape validation still happens later, per widget, in
        // `shared/predicates.ts`.
        const stringValues = Array.isArray(predicateValue) ? predicateValue : [predicateValue];
        stringValues.forEach((v) => {
          if (typeof v === 'string' && v.length > MAX_STRING_VALUE_LENGTH) {
            throw new Error(
              `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "filters[${predicateIndex}].value" ` +
                `contains a string ${v.length} characters long, which exceeds the maximum of ${MAX_STRING_VALUE_LENGTH} ` +
                `allowed. An unbounded value string is expensive to hash (it is folded into the query cache key) and, ` +
                `once queried, expensive for the database to scan/index as a bound parameter. Shorten the value to at ` +
                `most ${MAX_STRING_VALUE_LENGTH} characters.`,
            );
          }
        });
      });
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
    if (columnAliases !== undefined) {
      if (
        typeof columnAliases !== 'object' ||
        columnAliases === null ||
        Array.isArray(columnAliases) ||
        Object.values(columnAliases).some((value) => typeof value !== 'string')
      ) {
        throw new Error(
          `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "columnAliases" must be a plain ` +
            `object mapping logical field ids to string column references, but received ` +
            `${JSON.stringify(columnAliases)}. A non-object value (or one with non-string values) cannot be safely ` +
            `resolved into column references and would otherwise throw a confusing internal error instead of a ` +
            `clean validation failure. Ensure "columnAliases" is a { [logicalId: string]: string } object (or omit it).`,
        );
      }
      const columnAliasesKeyCount = Object.keys(columnAliases).length;
      if (columnAliasesKeyCount > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) {
        throw new Error(
          `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "columnAliases" contains ` +
            `${columnAliasesKeyCount} keys, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} allowed ` +
            `per widget. An unbounded number of column aliases is unbounded alias-resolution work (and an unbounded ` +
            `cache-key hash input) driven entirely by client input. Reduce the number of keys in "columnAliases" to ` +
            `at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
        );
      }
      // Length cap on each key/value STRING (Tier2 finding — resource
      // exhaustion). The key-COUNT cap above bounds how many entries
      // "columnAliases" may hold, but not how long any one key (the logical
      // field id) or value (the physical column reference) may be — both are
      // hashed unbounded in `computeQueryHash` (`security/cacheKey.ts`) and the
      // value is additionally re-validated as a column reference downstream.
      for (const [key, value] of Object.entries(columnAliases)) {
        if (key.length > MAX_STRING_LENGTH) {
          throw new Error(
            `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — a "columnAliases" key is ` +
              `${key.length} characters long, which exceeds the maximum of ${MAX_STRING_LENGTH} allowed for an ` +
              `identifier. An unbounded key is expensive to hash (it is folded into the query cache key) and to ` +
              `resolve repeatedly across a batch. Shorten the "columnAliases" key to at most ${MAX_STRING_LENGTH} characters.`,
          );
        }
        if (value.length > MAX_STRING_LENGTH) {
          throw new Error(
            `MUI X Studio Server: Malformed widget descriptor at widgets[${index}] — "columnAliases" value for key ` +
              `"${key.slice(0, 80)}…" is ${value.length} characters long, which exceeds the maximum of ` +
              `${MAX_STRING_LENGTH} allowed for an identifier. An unbounded value is expensive to hash (it is folded ` +
              `into the query cache key) and to resolve repeatedly across a batch. Shorten the "columnAliases" value ` +
              `to at most ${MAX_STRING_LENGTH} characters.`,
          );
        }
      }
    }
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
  const policy = compileSecurityPolicy({ tenancy, securityColumns, columnAllowlist });
  const cacheProvider = options.cacheProvider ?? getDefaultCache();
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
    if (pipeline === undefined) {
      // The `.finally` cleanup is stored (not merely attached) so every awaiter
      // observes the SAME derived promise — a rejection therefore always has a
      // handler and can never surface as an unhandled rejection.
      pipeline = runWidgetPipeline(context, descriptor, plan, cacheKey).finally(() => {
        inFlight.delete(cacheKey);
      });
      inFlight.set(cacheKey, pipeline);
    }
    return { id: descriptor.id, ...(await pipeline) };
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
  const { db, claims, cacheProvider, tierCacheProvider, tierCacheTtlMs, thresholds, rowBudget } =
    context;
  const queryOptions = context.policy;

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
        `Cause: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
    );
  }
  // SHAPE-CHECK THE HIT (finding L5). A `CacheProvider` is host-pluggable and its
  // backing store is not exclusively ours: a Redis deployment with no `keyPrefix`
  // can collide with the host's own keys, a partially-written value can be read
  // back, and a custom provider can simply be buggy. Any of those makes `cached`
  // truthy while `cached.rows` is `undefined` (or a non-array), which this handler
  // would then return in a field typed `Record<string, unknown>[]` — every
  // downstream `rows.map` / `rows.length` then crashes on data the database never
  // produced. Treat a structurally invalid entry as a MISS and re-query, reusing
  // the same degradation path as a cache read failure above.
  if (cached && !Array.isArray(cached.rows)) {
    console.warn(
      `MUI X Studio Server: discarded a malformed cache entry for a widget (its "rows" field is not an array); ` +
        `falling back to the database. The result is still served from the DB, but the cache backend should be ` +
        `checked for a key collision (set a "keyPrefix" if the store is shared) or a faulty CacheProvider.`,
    );
    cached = undefined;
  }
  if (cached) {
    return {
      rows: cached.rows,
      // Echo the tier that actually produced the cached rows (defaults to
      // 'server' for entries written before tier was persisted). Reporting a
      // 'client'-tier result as 'server' would change client-side behavior.
      tier: cached.tier ?? 'server',
      // Echo the ORIGINATING rowCount (the preflight COUNT(*)) — not
      // `cached.rows.length`, which is the (possibly limit-truncated) row
      // count and would flip the reported total between the cold-miss and
      // cache-hit responses. Falls back to the row length for entries written
      // before rowCount was persisted.
      rowCount: cached.rowCount ?? cached.rows.length,
    };
  }

  // ── 2 & 3. Tier decision: aggregation check → tier cache → COUNT(*) ───
  const hasAggregations = (descriptor.aggregations?.length ?? 0) > 0;
  const resolvedThresholds = {
    client: thresholds?.clientTier ?? DEFAULT_THRESHOLDS.client,
    server: thresholds?.serverMemoryTier ?? DEFAULT_THRESHOLDS.server,
  };

  const tierDecision = await decideTierWithCache(
    hasAggregations,
    // Namespace the tier plane's key so it can never collide with the data
    // plane's entry for the same widget on a shared Redis client (finding 2.1).
    TIER_CACHE_KEY_PREFIX + cacheKey,
    () => runPreflight(db, claims, descriptor, queryOptions, plan).then((p) => p.rowCount),
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
  // query's LIMIT at whatever the batch has left and is decremented by the rows
  // actually returned, so 50 unbounded widgets can no longer sum to 50 ×
  // `MAX_RESULT_ROWS` live rows.
  const rows = await executeForTier(db, claims, descriptor, tier, queryOptions, plan, rowBudget);

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
  if (tier !== 'db' || !hasAggregations) {
    // The rows are already in hand from the DB — a cache WRITE failure must not
    // discard them. Catch and degrade to "served, uncached" (finding 2.6).
    try {
      await cacheProvider.set(
        cacheKey,
        { rows, cachedAt: Date.now(), tier, rowCount },
        { tags: [descriptor.table, ...(descriptor.joins?.map((j) => j.table) ?? [])] },
      );
    } catch (cacheErr) {
      console.warn(
        `MUI X Studio Server: cache write failed for a widget; the result is still returned. ` +
          `Subsequent requests will re-query the DB until the cache backend recovers. ` +
          `Cause: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
      );
    }
  }

  return { rows, tier, rowCount };
}
