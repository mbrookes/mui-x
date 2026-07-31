/**
 * createBatchingAdapter — client-side request collapsing for Studio widgets.
 *
 * Problem: MUI X Studio fires N independent getRows() calls for N widgets on a
 * page because each widget has its own cacheKey (which includes widgetId). By the
 * time these calls reach the server, the batching window has already closed.
 *
 * Solution: Use a DataLoader-style pattern on the client to collect all widget
 * descriptors within a 50ms window and send them as a single POST request.
 *
 * Architecture:
 *   - One DataLoader per endpoint URL (not per StudioDataSource)
 *   - All sources targeting the same API endpoint share one loader instance
 *   - Within a batch, entries are grouped by their adapter's own `fetchFn`: one POST per
 *     distinct fetch, so same-endpoint sources with different credentials are never coalesced
 *   - Responses are routed back to each widget by the `id` field
 *   - DataLoader cache is disabled (Studio's StudioRequestCache handles caching)
 *
 * Usage:
 *   const source: StudioDataSource = {
 *     id: 'sales',
 *     label: 'Sales',
 *     fields: salesFields,
 *     adapter: createBatchingAdapter('https://api.example.com/studio-data'),
 *   };
 */
import type {
  StudioDataSource,
  StudioDataSourceAdapter,
  StudioExpressionField,
  StudioFilterNode,
  StudioFilterOperator,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioQueryResult,
  StudioRelationship,
  ClientMutationDescriptor,
  ClientMutationResult,
} from '../models';
import {
  applyFilters,
  isConditionComplete,
  isRelativeDateValue,
  resolveRelativeDate,
} from '../internals/filterUtils';
import { normalizeJoinKey } from '../internals/joinKeys';
import {
  aggregationPushdownWarning,
  decideAggregationPushdown,
  isClientOnlyAggFn,
} from './aggregationPushdown';
import type { AggFn } from '../internals/chartTypeRegistry';

/** Structured filter predicate sent to the server (mirrors FilterPredicate in @mui/x-studio-data-middleware) */
interface FilterPredicate {
  column: string;
  operator: 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'between';
  value?: unknown;
}

/** Aggregation spec sent to the server (mirrors AggregationSpec in @mui/x-studio-data-middleware) */
interface AggregationSpec {
  column: string;
  func: 'sum' | 'avg' | 'count' | 'min' | 'max';
  alias: string;
}

/**
 * The identifier charset every ALIAS position on the wire must match.
 *
 * Byte-identical to `SAFE_ALIAS_PATTERN` in `@mui/x-studio-data-middleware`'s
 * `shared/columnValidation.ts`, which that package enforces FAIL-CLOSED (independently of
 * any `columnAllowlist`) on both alias positions a Studio adapter can produce:
 * `aggregations[].alias` (`validateAggregationAliases`) and a `columns` entry that is also a
 * `columnAliases` key (`validateOutputAliases`). Both are interpolated as SQL identifiers via
 * `?? as ??`, so the host rejects the whole widget rather than escape-and-hope.
 *
 * A `StudioDataField.id` carries no such constraint — ids come from CSV headers, SQL view
 * columns and translated labels, so `"Order Amount"`, `"orders.amount"` and `"montant€"` are
 * all ordinary ids that work perfectly in memory. Checking here, at the one place ids become
 * wire aliases, keeps the mismatch from reaching the host as an opaque whole-widget failure —
 * the same reason `x-studio-ai-middleware`'s `buildFieldStatAggregations` validates its own
 * aliases against this charset before emitting them.
 *
 * NOT applied to the ids themselves elsewhere: an unaliased physical column may legitimately
 * contain spaces (the host quotes it), and the in-memory path has no such restriction at all.
 */
const SAFE_WIRE_ALIAS = /^[A-Za-z0-9_-]+$/;

/**
 * Maximum widget descriptors this adapter puts in ONE POST body.
 *
 * Must not exceed `MAX_WIDGETS_PER_BATCH` in `@mui/x-studio-data-middleware`'s `handler.ts`
 * (50, sourced from that package's `shared/limits.ts` `MAX_ITEMS_PER_BATCH`). The value is
 * DUPLICATED rather than imported because x-studio is deliberately free of a dependency on the
 * server package — the same reason `ClientMutationDescriptor` and `OPERATOR_MAP` are mirrors
 * rather than re-exports. `handler.ts` exports the constant, but the middleware's `index.ts`
 * does not re-export it, so there is no published symbol to import even if the dependency were
 * acceptable. `x-studio-data-middleware/src/__tests__/clientWireSeam.test.ts` asserts the two
 * copies are equal; that assertion is the only thing keeping them from drifting.
 *
 * Over-cap batches are not a hypothetical: nothing in Studio caps widgets per page, and the
 * server rejects an over-cap request by THROWING before its per-widget loop — so the failure
 * arrives as one un-attributed transport error for every widget on the page, not as a per-widget
 * result.
 */
export const MAX_BATCH_WIDGETS_PER_REQUEST = 50;

/**
 * A minimal DataLoader-style batch scheduler.
 * Collects keys over one microtask tick (or a custom schedule function)
 * then fires a single batch load.
 */
interface BatchLoader<K, V> {
  load(key: K): Promise<V>;
}

type BatchFn<K, V> = (keys: readonly K[]) => Promise<(V | Error)[]>;

function createLoader<K, V>(
  batchFn: BatchFn<K, V>,
  batchScheduleFn: (cb: () => void) => void,
): BatchLoader<K, V> {
  let batch: { key: K; resolve: (v: V) => void; reject: (error: Error) => void }[] = [];
  let scheduled = false;

  function dispatch() {
    const currentBatch = batch;
    batch = [];
    scheduled = false;

    batchFn(currentBatch.map((b) => b.key)).then(
      (results) => {
        for (let i = 0; i < currentBatch.length; i += 1) {
          const result = results[i];
          if (result instanceof Error) {
            currentBatch[i].reject(result);
          } else {
            currentBatch[i].resolve(result);
          }
        }
      },
      (err: Error) => {
        for (const item of currentBatch) {
          item.reject(err);
        }
      },
    );
  }

  return {
    load(key: K): Promise<V> {
      return new Promise((resolve, reject) => {
        batch.push({ key, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          batchScheduleFn(dispatch);
        }
      });
    },
  };
}

/**
 * One entry the shared simple-mode loader batches: the widget's query descriptor PLUS the
 * `fetchFn` of the adapter instance that issued it.
 *
 * `fetchFn` travels with the request rather than living in the shared per-endpoint config
 * because DISTINCT data sources legitimately share ONE endpoint (see the module header and the
 * "same-endpoint SQL JOIN generation" tests) while carrying DIFFERENT credentials:
 *
 *   createBatchingAdapter('/api/data', { fetchFn: withTenantAToken })
 *   createBatchingAdapter('/api/data', { fetchFn: withTenantBToken })
 *
 * When `fetchFn` was a single last-write-wins field on the endpoint-keyed registry entry,
 * whichever adapter happened to be CONSTRUCTED last owned the fetch for BOTH sources. Adapters
 * are normally built inside per-source `useMemo`s, so "constructed last" is render-order
 * dependent: tenant A's widgets could silently issue their queries with tenant B's credentials,
 * non-deterministically and with no warning.
 */
interface BatchRequest {
  descriptor: StudioQueryDescriptor;
  fetchFn: typeof fetch;
}

/**
 * Mutable per-endpoint config the shared simple-mode loader reads on every batch dispatch.
 * Keeping `batchDelayMs` / `expressionFields` behind a live reference (rather than baking them
 * into the loader's closure at creation time) lets a recreated adapter refresh them — e.g. a
 * newly-added calculated column in `expressionFields` (finding 3.6) — instead of silently pinning
 * the FIRST adapter instance's closure forever. A stale `expressionFields` list would leave the
 * `groupByIsExpressionField` guard evaluating against the old set, re-emitting the
 * `ORDER BY <expression-id>` that guard exists to prevent.
 *
 * IMPORTANT: `expressionFields` is merged (unioned by field id), never overwritten — see
 * `mergeExpressionFields` (finding 9). Multiple DISTINCT sources can legitimately share one
 * endpoint, each contributing its own expression fields. `batchDelayMs` remains last-write-wins:
 * it is a scalar timing knob with no per-source meaning and no correctness consequence — the
 * batch window only decides how long requests wait to be coalesced.
 *
 * `fetchFn` is deliberately NOT here — it is per-request (see {@link BatchRequest}). This also
 * subsumes what the old live-reference refresh existed for (finding 3.14, a rotated auth token in
 * a recreated adapter): the new instance's requests carry the new token by construction, and the
 * old instance's carry the token it was actually configured with instead of one belonging to a
 * different source.
 */
interface LoaderRegistryEntry {
  loader: BatchLoader<BatchRequest, StudioQueryResult>;
  config: {
    batchDelayMs: number;
    expressionFields: StudioExpressionField[] | undefined;
  };
}

/**
 * Merge a newly-registered adapter instance's `expressionFields` into the shared endpoint
 * config's list, keyed by field id (finding 9).
 *
 * Simple-mode adapters for DIFFERENT `StudioDataSource`s can share one endpoint (see
 * "same-endpoint SQL JOIN generation" tests). Before this merge, registering a second instance
 * — even one with no `expressionFields` of its own — REPLACED the shared list wholesale, wiping
 * out the first instance's entries. `buildBatchWidgetDescriptor` only ever looks up an expression
 * field by `id` (scoped to the descriptor's own `sourceId`), so a superset list is always safe:
 * an entry irrelevant to the current descriptor has zero effect. On an id collision the incoming
 * (newer) definition wins, so edits to an existing calculated field still refresh correctly
 * (finding 3.6).
 */
function mergeExpressionFields(
  existing: StudioExpressionField[] | undefined,
  incoming: StudioExpressionField[] | undefined,
): StudioExpressionField[] | undefined {
  if (!incoming || incoming.length === 0) {
    return existing;
  }
  if (!existing || existing.length === 0) {
    return incoming;
  }
  const merged = new Map<string, StudioExpressionField>();
  for (const field of existing) {
    merged.set(field.id, field);
  }
  for (const field of incoming) {
    merged.set(field.id, field);
  }
  return Array.from(merged.values());
}

/** Registry of simple-mode loaders — one per endpoint URL, with a refreshable config. */
const loaderRegistry = new Map<string, LoaderRegistryEntry>();

/**
 * How long a cross-endpoint enrichment (join-dimension) lookup stays reusable. Matches
 * `StudioRequestCache`'s own 30s TTL so an enrichment dimension and the fact rows it decorates
 * go stale on the same schedule.
 */
const ENRICHMENT_LOOKUP_TTL_MS = 30_000;

interface EnrichmentLookupEntry {
  /** pkValue → the join source's row. Shared by every batch that hits this entry. */
  promise: Promise<Map<unknown, Record<string, unknown>>>;
  fetchedAt: number;
}

/**
 * Cross-endpoint enrichment lookups, cached ACROSS batch dispatches.
 *
 * This map used to be created INSIDE `batchFn`, so its whole lifetime was a single dispatch: a
 * cross-DB join against a 500k-row `customers` dimension re-issued an unfiltered `getRows` and
 * rebuilt a 500k-entry `Map` on EVERY 50ms batch — i.e. on every filter change, every cross-filter
 * click, and every widget edit. It also called `joinSource.adapter.getRows` directly, bypassing
 * `StudioRequestCache` entirely, which is why the constant `cacheKey: '_xjoin:<id>'` it passes
 * bought nothing.
 *
 * Keyed first by the JOIN SOURCE'S ADAPTER (a `WeakMap`, so entries disappear with the adapter and
 * two adapters that happen to share a source id can never serve each other's rows — the same
 * per-instance-identity discipline `BatchRequest.fetchFn` applies), then by
 * `joinSourceId|joinPkField|<selected fields>`. The selected-field list is part of the key because
 * the lookup only SELECTs the columns the current batch asked for: reusing a narrower cached
 * lookup for a wider request would silently enrich rows with `null`.
 *
 * Deliberately NOT limited or filtered: the lookup must cover every FK value present in the fact
 * rows, and a `limit` would turn "row not in the truncated page" into a silent `null` enrichment
 * rather than an error. A true semi-join (an `in` predicate over the batch's distinct FK values)
 * would bound it further, but the FK set differs per batch, so it would defeat this cache — the
 * column narrowing plus the TTL is the trade chosen here.
 */
const enrichmentLookupCache = new WeakMap<
  StudioDataSourceAdapter,
  Map<string, EnrichmentLookupEntry>
>();

/**
 * Private symbol used to tag a batching adapter with its endpoint URL.
 * Enables cross-endpoint relationship validation at adapter creation time.
 */
const BATCHING_ENDPOINT = Symbol('mui-studio/batching-endpoint');

/** Returns the endpoint URL tagged on a batching adapter, or undefined for other adapter types. */
function getBatchingEndpoint(adapter: StudioDataSourceAdapter | undefined): string | undefined {
  if (!adapter) {
    return undefined;
  }
  return (adapter as unknown as Record<symbol, unknown>)[BATCHING_ENDPOINT] as string | undefined;
}

/**
 * Stable per-request wire id for a batch entry (finding 2.14).
 *
 * The server echoes the descriptor `id` we send straight back onto its result
 * (`handler.ts` → `WidgetQueryResult.id`). Keying batch entries by `widgetId` alone
 * meant two getRows() calls for the SAME widget with DIFFERENT descriptors (e.g. a page
 * filter changed twice inside the 50ms window, both cache misses) collapsed to the same
 * `id`, so `results.find(r => r.id === widgetId)` handed BOTH callers the first result —
 * and `StudioRequestCache.addInflight` then cached those stale rows under the second
 * descriptor's cacheKey for a fresh 30s TTL. Folding the descriptor's `cacheKey`
 * (a stable hash of every other descriptor field) into the wire id makes each distinct
 * request route to its own result.
 */
function batchEntryId(d: StudioQueryDescriptor): string {
  return `${d.widgetId}::${d.cacheKey}`;
}

/**
 * Route a server result back to its descriptor by the stable wire id (finding 2.14),
 * falling back to the bare `widgetId` ONLY when exactly one result carries it (back-compat
 * with any server/mock that echoes just the widgetId). With duplicate widgetIds in a batch
 * the fallback is intentionally skipped so the ambiguous case surfaces as a missing result
 * rather than silently returning the wrong (first) rows.
 */
function findBatchResult<T extends { id: string }>(
  results: T[],
  d: StudioQueryDescriptor,
): T | undefined {
  const wireId = batchEntryId(d);
  const exact = results.find((r) => r.id === wireId);
  if (exact) {
    return exact;
  }
  const byWidget = results.filter((r) => r.id === d.widgetId);
  return byWidget.length === 1 ? byWidget[0] : undefined;
}

/**
 * Warn in development when two related sources use different adapter endpoints.
 * SQL JOINs cannot span separate database connections — the auto-generated JOIN
 * descriptor would reference a table from a different database and fail at query time.
 */
function warnOnCrossEndpointRelationships(
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
): void {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  for (const rel of relationships) {
    if (rel.type === 'many-to-many') {
      continue;
    }
    const sourceEndpoint = getBatchingEndpoint(dataSources[rel.sourceId]?.adapter);
    const targetEndpoint = getBatchingEndpoint(dataSources[rel.targetId]?.adapter);
    if (sourceEndpoint && targetEndpoint && sourceEndpoint !== targetEndpoint) {
      console.warn(
        `[MUI X Studio] Relationship "${rel.id}" connects "${rel.sourceId}" (${sourceEndpoint}) ` +
          `and "${rel.targetId}" (${targetEndpoint}) which use different adapter endpoints. ` +
          `SQL JOINs cannot span database boundaries — cross-source field references ` +
          `between these sources will be skipped. Use separate widgets or merge the data client-side.`,
      );
    }
  }
}

export interface BatchingAdapterOptions {
  /**
   * Batch window delay in milliseconds.
   * All getRows() calls within this window are collapsed into one HTTP request.
   * Default: 50ms — balances responsiveness with collapsing efficiency.
   */
  batchDelayMs?: number;
  /**
   * Custom fetch implementation. Defaults to global `fetch`.
   * Useful for adding auth headers, interceptors, or test mocks.
   */
  fetchFn?: typeof fetch;
  /**
   * Endpoint URL for write-back mutations (INSERT/UPDATE/DELETE).
   *
   * When provided, the returned adapter exposes a `submitMutation()` method
   * that POSTs to this endpoint using the `handleMutation` batch format.
   * Grid widgets call this automatically from `processRowUpdate` when the
   * widget's `config.gridPkField` is set.
   *
   * @example '/api/mutations'
   */
  mutationEndpoint?: string;
  /**
   * All data sources in the current Studio state, keyed by source ID.
   *
   * When provided together with `relationships`, the adapter automatically
   * generates SQL JOINs for widget fields that belong to a related source.
   * Without this, all field references are passed unqualified and the server
   * must have prior knowledge of the schema.
   */
  dataSources?: Record<string, StudioDataSource>;
  /**
   * Expression fields defined in the current Studio state.
   *
   * When provided, the adapter resolves expression field references in widget
   * queries to their physical SQL counterparts:
   * - `JoinFieldExpression` (e.g. `customers.country` looked up via a FK join):
   *   resolved to a LEFT JOIN + aliased SELECT column.
   * - `FunctionExpression` (arithmetic like `price * stock`): stripped from the
   *   server request so the server returns raw rows and Studio evaluates the
   *   expression client-side.
   */
  expressionFields?: StudioExpressionField[];
  /**
   * Relationship graph for cross-source field resolution.
   *
   * Used together with `dataSources` to detect when a requested field lives
   * in a related source and to generate the corresponding JOIN descriptor.
   * Only `many-to-one` and `one-to-one` relationships are used for automatic
   * JOIN generation; `many-to-many` relationships are skipped.
   */
  relationships?: StudioRelationship[];
}

/**
 * Create a StudioDataSourceAdapter that batches all widget getRows() calls
 * within a 50ms window into a single HTTP request.
 *
 * @param endpoint - URL of the POST endpoint (e.g. '/api/studio-data')
 * @param options - Optional configuration
 */
export function createBatchingAdapter(
  endpoint: string,
  options: BatchingAdapterOptions = {},
): StudioDataSourceAdapter {
  const {
    batchDelayMs = 50,
    fetchFn = globalThis.fetch,
    dataSources,
    relationships,
    expressionFields,
    mutationEndpoint,
  } = options;

  /**
   * Resolve (and cache across batches) the join-dimension index for one cross-endpoint
   * enrichment target. `selectFields` is the UNION of every join field the current batch needs
   * from this dimension, plus its PK — never the source's whole field list, which turned each
   * lookup into an unfiltered `SELECT *` over the dimension table.
   *
   * See `enrichmentLookupCache` for the caching contract and why the lookup stays unfiltered.
   */
  function getEnrichmentLookup(
    joinSourceId: string,
    joinPkField: string,
    selectFields: string[],
  ): Promise<Map<unknown, Record<string, unknown>>> {
    const joinSource = dataSources?.[joinSourceId];
    const joinAdapter = joinSource?.adapter;
    if (!joinSource || !joinAdapter) {
      return Promise.resolve(new Map());
    }
    const perAdapter =
      enrichmentLookupCache.get(joinAdapter) ?? new Map<string, EnrichmentLookupEntry>();
    enrichmentLookupCache.set(joinAdapter, perAdapter);
    const select = Array.from(new Set([joinPkField, ...selectFields])).sort();
    const cacheKey = `${joinSourceId}|${joinPkField}|${select.join(',')}`;
    const cached = perAdapter.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt <= ENRICHMENT_LOOKUP_TTL_MS) {
      return cached.promise;
    }

    const lookupDescriptor: StudioQueryDescriptor = {
      sourceId: joinSourceId,
      tableName: joinSource.tableName ?? joinSourceId,
      widgetId: `_xjoin_${joinSourceId}`,
      select,
      cacheKey: `_xjoin:${joinSourceId}:${select.join(',')}`,
    };
    // Explicit annotation: the `.catch` handler references `promise` (to avoid evicting a NEWER
    // entry), which without it would be a self-referential type inference error.
    const promise: Promise<Map<unknown, Record<string, unknown>>> = joinAdapter
      .getRows(lookupDescriptor)
      .then((result) => {
        // Key the join index through the shared `normalizeJoinKey` policy (finding 2.20)
        // so a numeric FK matches a string PK etc. — matching every other join path.
        const lookup = new Map<unknown, Record<string, unknown>>();
        for (const row of result.rows) {
          const pkKey = normalizeJoinKey(row[joinPkField]);
          if (pkKey !== null && !lookup.has(pkKey)) {
            lookup.set(pkKey, row as Record<string, unknown>);
          }
        }
        return lookup;
      })
      .catch(() => {
        // Never cache a failure for the full TTL — drop the entry so the next batch retries
        // instead of enriching every row with `null` for the next 30 seconds.
        if (perAdapter.get(cacheKey)?.promise === promise) {
          perAdapter.delete(cacheKey);
        }
        return new Map<unknown, Record<string, unknown>>();
      });
    perAdapter.set(cacheKey, { promise, fetchedAt: Date.now() });
    return promise;
  }

  /**
   * Per-batch union of the join fields each `(joinSourceId, joinPkField)` dimension must supply,
   * so the dimension is fetched ONCE with exactly the columns this batch needs.
   */
  function collectEnrichmentSelects(built: BuiltBatchDescriptor[]): Map<string, string[]> {
    const byTarget = new Map<string, Set<string>>();
    for (const b of built) {
      for (const enr of b.crossEndpointEnrichments) {
        const key = `${enr.joinSourceId}|${enr.joinPkField}`;
        let fields = byTarget.get(key);
        if (!fields) {
          fields = new Set();
          byTarget.set(key, fields);
        }
        fields.add(enr.joinFieldId);
      }
    }
    return new Map(Array.from(byTarget, ([key, fields]) => [key, Array.from(fields)]));
  }

  // `getExpressionFields` is read on every dispatch so a shared simple-mode loader always uses
  // the latest expression-field list (finding 3.6). Relationship-aware mode passes its own
  // instance value directly (dedicated loader — no staleness possible). `fetchFn` is NOT read
  // from here: it travels per request (see `BatchRequest`), so same-endpoint adapters with
  // different credentials never borrow each other's fetch.
  function createBatchFn(
    getExpressionFields: () => StudioExpressionField[] | undefined,
  ): BatchFn<BatchRequest, StudioQueryResult> {
    /** Issue ONE POST for a set of descriptors that all share `groupFetch`. */
    async function runBatchGroup(
      groupFetch: typeof fetch,
      descriptors: readonly StudioQueryDescriptor[],
      currentExpressionFields: StudioExpressionField[] | undefined,
    ): Promise<(StudioQueryResult | Error)[]> {
      const builtDescriptors = descriptors.map((d) =>
        buildBatchWidgetDescriptor(d, dataSources, relationships, currentExpressionFields),
      );

      const body = {
        pageId: descriptors[0]?.sourceId ?? 'unknown',
        widgets: builtDescriptors.map((b) => b.requestBody),
      };

      const response = await groupFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = new Error(
          `Studio batch request failed: ${response.status} ${response.statusText}`,
        );
        return descriptors.map(() => err);
      }

      const json = (await response.json()) as {
        results: Array<{ id: string; rows: Record<string, unknown>[]; error?: string }>;
      };

      // Union of the join fields this batch needs per dimension, so each dimension is fetched
      // once with only those columns — and cached across dispatches (see `enrichmentLookupCache`).
      const enrichmentSelects = collectEnrichmentSelects(builtDescriptors);

      // DataLoader invariant: results must be same length and same order as keys
      return Promise.all(
        descriptors.map(async (d, i) => {
          const result = findBatchResult(json.results, d);
          if (!result) {
            return new Error(`Studio batch response missing result for widget "${d.widgetId}"`);
          }
          if (result.error) {
            return /* minify-error-disabled */ new Error(result.error);
          }

          const { crossEndpointEnrichments, clientFilter } = builtDescriptors[i];

          // Apply cross-endpoint enrichments: fetch each join source once, then enrich rows.
          let rows = result.rows;
          for (const enr of crossEndpointEnrichments) {
            // eslint-disable-next-line no-await-in-loop
            const lookup = await getEnrichmentLookup(
              enr.joinSourceId,
              enr.joinPkField,
              enrichmentSelects.get(`${enr.joinSourceId}|${enr.joinPkField}`) ?? [enr.joinFieldId],
            );
            if (lookup.size === 0) {
              continue;
            }
            rows = rows.map((row) => {
              if (enr.logicalFieldId in row) {
                return row; // Already set — don't overwrite (consistent with enrichRowsWithExpressions)
              }
              // Probe with the SAME normalized key policy the lookup was built with (finding 2.20).
              const fkKey = normalizeJoinKey(row[enr.fkField]);
              const joinRow = fkKey !== null ? lookup.get(fkKey) : undefined;
              const enrichedValue = joinRow?.[enr.joinFieldId] ?? null;
              return { ...row, [enr.logicalFieldId]: enrichedValue };
            });
          }

          // Client-side residual filters (findings 1.4 / 1.5): predicates the server's query
          // protocol cannot express faithfully (OR-combined conditions, or operators with no
          // SQL equivalent / a case-sensitivity mismatch) were withheld from the request and
          // are enforced here — against the SAME evaluator in-memory sources use — so the
          // adapter path produces the same rows instead of silently over- or under-filtering.
          // Only attached for raw-row (non-server-aggregated) queries; see buildBatchWidgetDescriptor.
          if (clientFilter && clientFilter.length > 0) {
            rows = applyFilters(rows, clientFilter) as Record<string, unknown>[];
          }

          return { rows };
        }),
      );
    }

    return async (requests) => {
      // Snapshot the expression fields ONCE per dispatch so every group in this batch is built
      // against the same list.
      const currentExpressionFields = getExpressionFields();

      // Partition the batch by `fetchFn` IDENTITY and issue one POST per distinct fetch. Entries
      // whose `fetchFn` differs are never coalesced: they may carry different credentials (see
      // `BatchRequest`), and a single request can only be sent with one of them. Requests sharing
      // a fetch still collapse into one POST, so the common case (every source on this endpoint
      // configured identically, including the default `globalThis.fetch`) is unchanged — a single
      // group, a single request.
      const groups = new Map<typeof fetch, number[]>();
      for (let i = 0; i < requests.length; i += 1) {
        const indices = groups.get(requests[i].fetchFn);
        if (indices) {
          indices.push(i);
        } else {
          groups.set(requests[i].fetchFn, [i]);
        }
      }

      // Split each group into CHUNKS no larger than the server's per-request widget cap
      // (`MAX_BATCH_WIDGETS_PER_REQUEST`). The middleware's `assertValidBatchQueryRequest`
      // THROWS on an over-cap batch — before the per-widget loop, so no widget gets its own
      // `{ error }` — and a host that maps a thrown error to a bare 500 discards the server's
      // actionable text entirely. On the client side `!response.ok` fails EVERY descriptor in
      // the group, so one widget past the cap takes down the whole page with
      // `Studio batch request failed: 500 Internal Server Error`. Chunking keeps a large page
      // (Studio does not cap widgets per page) inside the shape the server accepts, and gives
      // each chunk its own shared row budget besides.
      const chunks: { groupFetch: typeof fetch; indices: number[] }[] = [];
      for (const [groupFetch, indices] of groups) {
        for (let i = 0; i < indices.length; i += MAX_BATCH_WIDGETS_PER_REQUEST) {
          chunks.push({
            groupFetch,
            indices: indices.slice(i, i + MAX_BATCH_WIDGETS_PER_REQUEST),
          });
        }
      }

      const results: (StudioQueryResult | Error)[] = new Array(requests.length);
      await Promise.all(
        chunks.map(async ({ groupFetch, indices }) => {
          let groupResults: (StudioQueryResult | Error)[];
          try {
            groupResults = await runBatchGroup(
              groupFetch,
              indices.map((i) => requests[i].descriptor),
              currentExpressionFields,
            );
          } catch (err) {
            // One chunk's transport failure must not reject the whole dispatch and fail the
            // OTHER chunks' unrelated requests — `createLoader`'s rejection path would reject
            // every caller in the batch, including those served by a different, healthy fetch.
            const error = err instanceof Error ? err : new Error(String(err));
            groupResults = indices.map(() => error);
          }
          indices.forEach((requestIndex, groupIndex) => {
            results[requestIndex] = groupResults[groupIndex];
          });
        }),
      );
      return results;
    };
  }

  // Warn in dev when relationships span different endpoints (cross-DB JOINs won't work).
  if (dataSources && relationships) {
    warnOnCrossEndpointRelationships(dataSources, relationships);
  }

  let loader: BatchLoader<BatchRequest, StudioQueryResult>;
  if (dataSources) {
    // Relationship-aware mode: create a dedicated loader that captures the
    // dataSources/relationships closure. Don't use the shared registry because
    // the resolver is specific to this adapter instance's state snapshot.
    loader = createLoader(
      createBatchFn(() => expressionFields),
      (cb) => setTimeout(cb, batchDelayMs),
    );
  } else {
    // Simple mode: use shared registry so multiple adapter instances pointing
    // at the same endpoint share one DataLoader (batching still works across instances).
    let entry = loaderRegistry.get(endpoint);
    if (!entry) {
      const config = { batchDelayMs, expressionFields };
      entry = {
        // Both the batch fn and the schedule fn read the live `config`, so a later adapter
        // recreated at the same endpoint (e.g. a newly-added calculated column) is honoured
        // (finding 3.6). The per-request `fetchFn` covers the rotated-token case (finding 3.14)
        // without letting one source's credentials leak into another's request (see
        // `BatchRequest`).
        loader: createLoader(
          createBatchFn(() => config.expressionFields),
          (cb) => setTimeout(cb, config.batchDelayMs),
        ),
        config,
      };
      loaderRegistry.set(endpoint, entry);
    } else {
      // Refresh the shared loader's config instead of pinning the first instance's closure.
      entry.config.batchDelayMs = batchDelayMs;
      // Union by field id rather than overwrite (finding 9): distinct sources sharing this
      // endpoint each register their own expression fields, and a later instance with none of
      // its own (or a different source's list) must not wipe out an earlier instance's entries.
      entry.config.expressionFields = mergeExpressionFields(
        entry.config.expressionFields,
        expressionFields,
      );
    }
    loader = entry.loader;
  }

  const adapter: StudioDataSourceAdapter = {
    getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult> {
      // The adapter's OWN `fetchFn` travels with the request — never read from the shared
      // per-endpoint config — so a same-endpoint sibling adapter constructed later cannot take
      // over this source's credentials (see `BatchRequest`).
      return loader.load({ descriptor, fetchFn });
    },
  };

  // Attach submitMutation when a mutation endpoint is configured.
  if (mutationEndpoint) {
    adapter.submitMutation = async (
      descriptor: ClientMutationDescriptor,
    ): Promise<ClientMutationResult> => {
      let response: Response;
      try {
        response = await fetchFn(mutationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Wrap in BatchMutationRequest format expected by handleMutation()
          body: JSON.stringify({
            mutations: [{ id: 'client-mutation', ...descriptor }],
          }),
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Network error',
        };
      }
      if (!response.ok) {
        return { ok: false, error: `${response.status} ${response.statusText}` };
      }
      const json = (await response.json()) as {
        results?: Array<{ id: string; ok: boolean; rowsAffected?: number; error?: string }>;
      };
      const result = json.results?.[0];
      return result ?? { ok: false, error: 'No result in response' };
    };
  }

  // Tag the adapter with its endpoint URL for cross-endpoint relationship validation.
  (adapter as unknown as Record<symbol, unknown>)[BATCHING_ENDPOINT] = endpoint;
  return adapter;
}

// ── Cross-source field resolution ───────────────────────────────────────────

/** Internal JOIN descriptor matching the shape expected by x-studio-data-middleware */
interface JoinDescriptorInternal {
  table: string;
  type: 'left';
  on: [string, string][];
}

/**
 * Internal SEMI-JOIN descriptor matching `SemiJoinDescriptor` in
 * x-studio-data-middleware — `column IN (SELECT foreignColumn FROM table WHERE …)`.
 *
 * This is the wire form of "keep the widget rows having AT LEAST ONE matching
 * related row", which is what `dataSourceGraph.resolveRows` computes in memory for
 * a cross-source filter. It exists because a `JoinDescriptorInternal` cannot
 * express it: across a relationship that is one-to-many from the widget's side, a
 * LEFT JOIN multiplies the widget's rows by the number of matches, so every
 * aggregate reads high by a data-dependent factor. See the orientation branch in
 * `resolveField`.
 */
interface SemiJoinDescriptorInternal {
  table: string;
  column: string;
  foreignColumn: string;
  filters: FilterPredicate[];
  /**
   * Nested subquery, applied inside this one. Exactly one level of nesting is ever produced, for
   * the two-hop many-to-many shape (widget → junction → remote) `dataSourceGraph.findJoinPath`
   * models as `hops: 2`. The middleware caps nesting at the same two levels.
   */
  semiJoins?: SemiJoinDescriptorInternal[];
}

/**
 * The DEEPEST level of a semi-join tree — where a predicate on the filtered source belongs.
 *
 * For a one-hop semi-join that is the descriptor itself; for the two-hop many-to-many shape it is
 * the inner subquery against the REMOTE table, since the junction level exists only to link the
 * widget to it and carries no predicate of its own.
 */
function innermostSemiJoin(descriptor: SemiJoinDescriptorInternal): SemiJoinDescriptorInternal {
  let current = descriptor;
  while (current.semiJoins && current.semiJoins.length > 0) {
    current = current.semiJoins[0];
  }
  return current;
}

/**
 * Result of resolving a field ID to its SQL representation.
 *
 * - `column`: the logical ID to use in the `columns` array (unchanged for most fields).
 * - `physicalColumn`: when set, the actual DB column to SELECT (e.g. `customers.country`).
 *   The server SELECTs `physicalColumn AS column` to preserve the logical field ID in responses.
 * - `joins`: JOIN descriptors to add when the field lives in a related table. Multiple JOINs
 *   are emitted for multi-hop paths (e.g. order_items → orders → customers).
 * - `skip`: when true, the field is a server-side-incompatible expression (e.g. arithmetic);
 *   exclude it from columns and aggregations and return raw rows for client-side evaluation.
 */
interface ResolvedField {
  column: string;
  physicalColumn?: string;
  joins?: JoinDescriptorInternal[];
  skip?: boolean;
  /** True when the field cannot be resolved to any column in the primary or related sources.
   *  The column MUST be dropped from both SELECT and WHERE clauses to avoid "no such column"
   *  SQL errors — qualifying an unresolved name with the primary table (e.g. `products.date`)
   *  will fail if that column does not exist on the table. */
  unresolved?: boolean;
  /**
   * True when the field WAS found on a related source, but only across a relationship that is
   * one-to-many from the widget's point of view (the widget sits on the "one" side of a
   * `many-to-one`). Always accompanied by `unresolved: true` — see the fan-out guard in
   * `resolveField` for why such a reference has no correct JOIN form.
   *
   * A FILTER on such a field IS expressible, as a semi-join (`semiJoin` below); every OTHER use
   * — a display column, a groupBy, an aggregation source — is not, because a semi-join filters
   * rows rather than producing a value, and in-memory those uses pick ONE representative related
   * value per row (`enrichRowsWithRelatedFields`), which SQL cannot pick without a rule nobody
   * declared. Those callers therefore still drop the reference and warn.
   */
  fanOut?: boolean;
  /**
   * Set together with `fanOut` — the semi-join that expresses a FILTER on this field faithfully.
   * Only the filter path reads it; every other caller sees `unresolved` and degrades visibly.
   */
  semiJoin?: {
    /**
     * The FILTERED source's id. Used to GROUP every predicate targeting the same foreign source
     * into ONE subquery, which is the whole semantics of a multi-predicate cross-source filter:
     * `EXISTS(foreign matching A AND B)`, not `EXISTS(matching A) AND EXISTS(matching B)`. The
     * latter admits a customer with one paid order and a DIFFERENT order over $100 — the exact
     * divergence `dataSourceGraph.resolveRows`'s own grouping comment records having to fix.
     */
    sourceId: string;
    /**
     * The subquery tree linking the widget's table to the filtered one, with EMPTY `filters` at
     * every level. The predicate is appended to `innermostSemiJoin(descriptor).filters` by the
     * caller, so the first predicate for a source establishes the tree and later ones join it.
     */
    descriptor: SemiJoinDescriptorInternal;
    /** The physical column, on the innermost table, that this predicate targets. */
    filterColumn: string;
  };
  /**
   * When skip=true because the join target lives on a different adapter endpoint,
   * this carries the information needed to enrich rows client-side after fetching
   * the primary rows from the server.
   */
  crossEndpointJoin?: {
    /** FK field on the primary source rows (e.g. 'customerId') */
    fkField: string;
    /** Source ID of the join target (e.g. 'source-customers') */
    joinSourceId: string;
    /** The field to pull from the join target (e.g. 'segment') */
    joinFieldId: string;
    /** PK field on the join target that matches fkField values (e.g. 'id') */
    joinPkField: string;
  };
}

/**
 * Returns true when `expr` is a `StudioJoinFieldExpression`.
 * (Duck-type check since we can't import expressionTypes here without a circular path.)
 */
function isJoinExpression(expr: unknown): expr is { joinSourceId: string; fieldId: string } {
  return typeof expr === 'object' && expr !== null && 'joinSourceId' in expr && 'fieldId' in expr;
}

/**
 * Resolve a field ID to the correct SQL column reference for a query against
 * `primarySourceId`. Handles the following cases:
 *
 * 1. Physical field on the primary source — returned as-is.
 * 2. Expression field with a join expression on the primary source — resolved to a LEFT JOIN + alias.
 * 3. Expression field with a join expression on a related source (e.g. an `expr-order-country`
 *    field defined on ORDERS, used as a cross-filter on an ORDER_ITEMS widget) — resolved to
 *    two LEFT JOINs: one hop from the primary source to the expression's owning source, then a
 *    second hop through the expression's own join.
 * 4. Expression field with an arithmetic expression — marked `skip` so the
 *    server returns raw rows and Studio evaluates the expression client-side.
 * 5. Physical field on a directly related source (one-hop cross-source reference) — resolved
 *    via the relationship graph to a LEFT JOIN + qualified column.
 * 6. Field not found anywhere (e.g. a field from a source 2+ hops away, like `orders.date`
 *    used as a filter on a `products` widget) — returned with `unresolved: true`. Callers
 *    MUST drop this field from both SELECT and WHERE clauses; qualifying the name with the
 *    primary table (e.g. `products.date`) would cause "no such column" SQL errors.
 *
 * Only `many-to-one` and `one-to-one` relationships are traversed (one hop per step).
 */
function resolveField(
  fieldId: string,
  primarySourceId: string,
  primaryTableName: string,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields?: StudioExpressionField[],
): ResolvedField {
  // ── 1. Check expression fields on the primary source ───────────────────────
  if (expressionFields) {
    const exprField = expressionFields.find(
      (f) => f.id === fieldId && f.sourceId === primarySourceId,
    );
    if (exprField) {
      if (isJoinExpression(exprField.expression)) {
        // JoinFieldExpression: resolve to the joined table's physical column.
        const { joinSourceId, fieldId: joinFieldId } = exprField.expression;
        const joinSource = dataSources[joinSourceId];
        if (joinSource) {
          // Skip if this join would span database boundaries (different adapter endpoints).
          // Cross-database JOINs are not executable server-side; the field will be evaluated
          // client-side by the enrichment layer instead.
          const primaryEndpoint = getBatchingEndpoint(dataSources[primarySourceId]?.adapter);
          const joinEndpoint = getBatchingEndpoint(joinSource.adapter);
          if (primaryEndpoint && joinEndpoint && primaryEndpoint !== joinEndpoint) {
            // Find the relationship to surface FK info for client-side enrichment.
            for (const rel of relationships) {
              if (rel.type === 'many-to-many') {
                continue;
              }
              if (rel.sourceId === primarySourceId && rel.targetId === joinSourceId) {
                return {
                  column: fieldId,
                  skip: true,
                  crossEndpointJoin: {
                    fkField: rel.sourceField,
                    joinSourceId,
                    joinFieldId,
                    joinPkField: rel.targetField,
                  },
                };
              }
              if (rel.targetId === primarySourceId && rel.sourceId === joinSourceId) {
                return {
                  column: fieldId,
                  skip: true,
                  crossEndpointJoin: {
                    fkField: rel.targetField,
                    joinSourceId,
                    joinFieldId,
                    joinPkField: rel.sourceField,
                  },
                };
              }
            }
            return { column: fieldId, skip: true };
          }
          const joinTable = joinSource.tableName ?? joinSourceId;
          // Find the relationship between primarySourceId and joinSourceId
          for (const rel of relationships) {
            if (rel.type === 'many-to-many') {
              continue;
            }
            let leftCol = '';
            let rightCol = '';
            if (rel.sourceId === primarySourceId && rel.targetId === joinSourceId) {
              leftCol = `${primaryTableName}.${rel.sourceField}`;
              rightCol = `${joinTable}.${rel.targetField}`;
            } else if (rel.targetId === primarySourceId && rel.sourceId === joinSourceId) {
              // The widget sits on the relationship's TARGET side, so the relationship's own
              // fields read "backwards" relative to the join being emitted. The ON pair is NOT
              // written in relationship order, though: the wire protocol requires LEFT to name a
              // table already in scope and RIGHT to name the table THIS join introduces (see
              // `validateJoinOnPairs` in x-studio-data-middleware). Reading `rel.sourceField` onto
              // the LEFT here emitted `[joinTable.fk, primaryTable.pk]` for `table: joinTable` —
              // a right-hand column qualified with the WRONG table, which the server rejects
              // outright, failing the whole widget with `StudioWidgetErrorOverlay`.
              leftCol = `${primaryTableName}.${rel.targetField}`;
              rightCol = `${joinTable}.${rel.sourceField}`;
              // ORIENTATION GUARD — the same one section 3 applies to plain cross-source fields,
              // and it MUST accompany the qualification fix above rather than follow it. Across a
              // `many-to-one` traversed backwards the widget is on the ONE side, so
              // `LEFT JOIN orders ON customers.id = orders.customer_id` multiplies each widget row
              // by its match count: correcting only the ON orientation would turn a loud
              // server-side rejection into a silently inflated `SUM` (a customer with three orders
              // reads 3×). A FILTER on the expression field is still expressible faithfully — as a
              // semi-join, exactly as for a plain cross-source field — while every other use
              // (display column, groupBy, aggregation source) degrades visibly via `unresolved`.
              if (rel.type === 'many-to-one') {
                return {
                  column: fieldId,
                  unresolved: true,
                  fanOut: true,
                  semiJoin: {
                    sourceId: joinSourceId,
                    descriptor: {
                      table: joinTable,
                      column: `${primaryTableName}.${rel.targetField}`,
                      foreignColumn: `${joinTable}.${rel.sourceField}`,
                      filters: [],
                    },
                    // The expression resolves to the joined table's PHYSICAL column, so that —
                    // not the logical expression-field id — is what the subquery filters on.
                    filterColumn: `${joinTable}.${joinFieldId}`,
                  },
                };
              }
            }
            if (leftCol) {
              return {
                column: fieldId, // keep logical ID; server aliases physical → logical
                physicalColumn: `${joinTable}.${joinFieldId}`,
                joins: [{ table: joinTable, type: 'left', on: [[leftCol, rightCol]] }],
              };
            }
          }
        }
        // Couldn't resolve the join — skip
        return { column: fieldId, skip: true };
      }
      // FunctionExpression or unknown — can't compute server-side
      return { column: fieldId, skip: true };
    }

    // ── 1b. Expression field on a related source ──────────────────────────────
    // Handles cross-filters where the filter field is an expression (e.g. expr-order-country
    // defined on ORDERS) applied to a widget on a different source (e.g. ORDER_ITEMS).
    // Resolution: PRIMARY → exprField.sourceId (hop 1) → joinSourceId (hop 2).
    const relatedExprField = expressionFields.find(
      (f) => f.id === fieldId && f.sourceId !== primarySourceId,
    );
    if (relatedExprField) {
      const exprSourceId = relatedExprField.sourceId;
      const exprSource = dataSources[exprSourceId];
      if (exprSource) {
        const primaryEndpoint = getBatchingEndpoint(dataSources[primarySourceId]?.adapter);
        const exprEndpoint = getBatchingEndpoint(exprSource.adapter);
        // Skip if hop 1 would span database boundaries.
        if (primaryEndpoint && exprEndpoint && primaryEndpoint !== exprEndpoint) {
          return { column: fieldId, skip: true };
        }
        const exprTable = exprSource.tableName ?? exprSourceId;
        // Find hop 1: primarySource → exprField's source
        for (const hop1Rel of relationships) {
          if (hop1Rel.type === 'many-to-many') {
            continue;
          }
          let hop1Left = '';
          let hop1Right = '';
          /**
           * True when hop 1 is a `many-to-one` traversed BACKWARDS — the widget is on the "one"
           * side, so joining across it multiplies the widget's rows. See the orientation guard
           * below, and the identical one in section 3.
           */
          let hop1FansOut = false;
          if (hop1Rel.sourceId === primarySourceId && hop1Rel.targetId === exprSourceId) {
            hop1Left = `${primaryTableName}.${hop1Rel.sourceField}`;
            hop1Right = `${exprTable}.${hop1Rel.targetField}`;
          } else if (hop1Rel.targetId === primarySourceId && hop1Rel.sourceId === exprSourceId) {
            // LEFT = a table already in scope, RIGHT = the table this join introduces — not the
            // relationship's own field order. Emitting `[exprTable.fk, primaryTable.pk]` for
            // `table: exprTable` is a right-hand column qualified with the wrong table, which
            // `validateJoinOnPairs` rejects, failing the whole widget.
            hop1Left = `${primaryTableName}.${hop1Rel.targetField}`;
            hop1Right = `${exprTable}.${hop1Rel.sourceField}`;
            hop1FansOut = hop1Rel.type === 'many-to-one';
          }
          if (!hop1Left) {
            continue;
          }

          if (isJoinExpression(relatedExprField.expression)) {
            // Hop 2: exprField's source → the expression's join target
            const { joinSourceId, fieldId: joinFieldId } = relatedExprField.expression;

            // Special case: hop 2 lands back on the primary source (e.g. expr-order-country
            // defined on ORDERS with joinSourceId=CUSTOMERS, applied to a CUSTOMERS widget).
            // The final column (e.g. customers.country) is already in the primary table —
            // only emit hop 1 (primary → exprSource) if we actually need the intermediate
            // table for a column. Here the physical column is on the primary table itself,
            // so NO joins are needed at all.
            if (joinSourceId === primarySourceId) {
              return {
                column: fieldId,
                physicalColumn: `${primaryTableName}.${joinFieldId}`,
                joins: [],
              };
            }

            const joinSource = dataSources[joinSourceId];
            if (joinSource) {
              // Skip if hop 2 would span database boundaries.
              const joinEndpoint = getBatchingEndpoint(joinSource.adapter);
              if (primaryEndpoint && joinEndpoint && primaryEndpoint !== joinEndpoint) {
                return { column: fieldId, skip: true };
              }
              const joinTable = joinSource.tableName ?? joinSourceId;
              for (const hop2Rel of relationships) {
                if (hop2Rel.type === 'many-to-many') {
                  continue;
                }
                let hop2Left = '';
                let hop2Right = '';
                /** Same backwards-`many-to-one` test as `hop1FansOut`, for the second hop. */
                let hop2FansOut = false;
                if (hop2Rel.sourceId === exprSourceId && hop2Rel.targetId === joinSourceId) {
                  hop2Left = `${exprTable}.${hop2Rel.sourceField}`;
                  hop2Right = `${joinTable}.${hop2Rel.targetField}`;
                } else if (hop2Rel.targetId === exprSourceId && hop2Rel.sourceId === joinSourceId) {
                  // LEFT must name a table already in scope — `exprTable`, joined by hop 1 —
                  // and RIGHT the table hop 2 introduces. The reverse order was rejected by
                  // `validateJoinOnPairs`' right-hand rule.
                  hop2Left = `${exprTable}.${hop2Rel.targetField}`;
                  hop2Right = `${joinTable}.${hop2Rel.sourceField}`;
                  hop2FansOut = hop2Rel.type === 'many-to-one';
                }
                if (!hop2Left) {
                  continue;
                }
                // ORIENTATION GUARD for the two-hop chain. A fan-out at EITHER hop multiplies the
                // widget's rows just as badly as one at a single hop, so the join form is
                // abandoned for both. The faithful filter form is the same nested semi-join the
                // two-hop many-to-many case emits (`MAX_SEMI_JOIN_DEPTH` is exactly 2), with the
                // link columns read in the same orientation the LEFT JOINs above use: the outer
                // `column` names the enclosing table, the `foreignColumn` the subquery's own —
                // which is precisely what the middleware's `validateSemiJoins` requires.
                if (hop1FansOut || hop2FansOut) {
                  return {
                    column: fieldId,
                    unresolved: true,
                    fanOut: true,
                    semiJoin: {
                      sourceId: joinSourceId,
                      descriptor: {
                        table: exprTable,
                        column: hop1Left,
                        foreignColumn: hop1Right,
                        // The intermediate level only links the widget to the filtered source; the
                        // predicate belongs to the nested level (see `innermostSemiJoin`).
                        filters: [],
                        semiJoins: [
                          {
                            table: joinTable,
                            column: hop2Left,
                            foreignColumn: hop2Right,
                            filters: [],
                          },
                        ],
                      },
                      filterColumn: `${joinTable}.${joinFieldId}`,
                    },
                  };
                }
                return {
                  column: fieldId, // keep logical ID; server aliases physical → logical
                  physicalColumn: `${joinTable}.${joinFieldId}`,
                  joins: [
                    { table: exprTable, type: 'left', on: [[hop1Left, hop1Right]] },
                    { table: joinTable, type: 'left', on: [[hop2Left, hop2Right]] },
                  ],
                };
              }
            }
          } else {
            // FunctionExpression in a related source — can't compute server-side
            return { column: fieldId, skip: true };
          }
        }
      }
    }
  }

  const primarySource = dataSources[primarySourceId];

  // ── 2. Field is in the primary source's field list ──────────────────────────
  if (!primarySource || primarySource.fields.some((f) => f.id === fieldId)) {
    return { column: fieldId };
  }

  // ── 3. Cross-source field: walk relationships to find a related source ──────
  for (const rel of relationships) {
    if (rel.type === 'many-to-many') {
      continue;
    }

    let relatedSourceId: string | null = null;
    let leftCol = '';
    let rightCol = '';

    if (rel.sourceId === primarySourceId) {
      const relatedSource = dataSources[rel.targetId];
      if (!relatedSource) {
        continue;
      }
      relatedSourceId = rel.targetId;
      const relatedTable = relatedSource.tableName ?? rel.targetId;
      leftCol = `${primaryTableName}.${rel.sourceField}`;
      rightCol = `${relatedTable}.${rel.targetField}`;
    } else if (rel.targetId === primarySourceId) {
      const relatedSource = dataSources[rel.sourceId];
      if (!relatedSource) {
        continue;
      }
      relatedSourceId = rel.sourceId;
      const relatedTable = relatedSource.tableName ?? rel.sourceId;
      // LEFT = the table already in scope (the widget's own), RIGHT = the table this join
      // introduces — NOT the relationship's own field order. Written the other way round, the
      // pair reads `[relatedTable.fk, primaryTable.pk]` for `table: relatedTable`, whose
      // right-hand column names the wrong table and which `validateJoinOnPairs` rejects, failing
      // the whole widget. (The `many-to-one`-traversed-backwards arity is diverted to a semi-join
      // by the orientation guard below, so this branch only ever emits a `one-to-one` join.)
      leftCol = `${primaryTableName}.${rel.targetField}`;
      rightCol = `${relatedTable}.${rel.sourceField}`;
    }

    if (relatedSourceId !== null) {
      const relatedSource = dataSources[relatedSourceId];
      if (relatedSource?.fields.some((f) => f.id === fieldId)) {
        // ORIENTATION GUARD. A `LEFT JOIN` is row-preserving only when the widget's source is on
        // the MANY side of the relationship (or the relationship is `one-to-one`). When the widget
        // sits on the ONE side, the join FANS the row set OUT — one widget row per matching
        // related row — and everything downstream reads a multiplied table:
        //   - as a FILTER, `customers … LEFT JOIN orders … WHERE orders.status = 'shipped'` makes a
        //     customer with three shipped orders contribute three rows, so a `SUM(lifetime_value)`
        //     KPI reads 3× (the in-memory path runs a SEMI-join and reads 1×);
        //   - as a DISPLAY column, the same fan-out duplicates every grid row, while in-memory
        //     `enrichRowsWithRelatedFields` picks one representative related value per row.
        //
        // The faithful SQL for the FILTER case is a semi-join
        // (`WHERE customers.id IN (SELECT orders.customer_id FROM orders WHERE …)`), which the wire
        // protocol now expresses as a `SemiJoinDescriptor` — the same shape, and the same answer,
        // as the in-memory semi-join. `semiJoin` below carries everything the filter path needs to
        // emit it; the middleware applies the caller's row-level-security predicate INSIDE the
        // subquery, so it is scoped exactly as a joined table would be.
        //
        // Every OTHER use of the reference stays unresolved-with-a-warning. A semi-join filters
        // rows; it does not produce a VALUE, so a display column / groupBy / aggregation source on
        // the "many" side still has no faithful wire form — in memory those pick one representative
        // related value per row, a choice SQL cannot make without a rule nobody declared. Hence
        // `unresolved: true, fanOut: true` are KEPT alongside `semiJoin`: the filter path reads
        // `semiJoin` first, everything else degrades visibly as before.
        if (rel.type === 'many-to-one' && rel.targetId === primarySourceId) {
          const relatedTable = relatedSource.tableName ?? relatedSourceId;
          return {
            column: fieldId,
            unresolved: true,
            fanOut: true,
            semiJoin: {
              sourceId: relatedSourceId,
              descriptor: {
                table: relatedTable,
                // The SAME column pair the (unused here) LEFT JOIN branch below would emit —
                // outer key first, subquery projection second: `rel.targetField` is the key on the
                // widget's "one" table, `rel.sourceField` the FK on the related "many" table.
                column: `${primaryTableName}.${rel.targetField}`,
                foreignColumn: `${relatedTable}.${rel.sourceField}`,
                filters: [],
              },
              filterColumn: `${relatedTable}.${fieldId}`,
            },
          };
        }
        const relatedTable = relatedSource.tableName ?? relatedSourceId;
        return {
          column: `${relatedTable}.${fieldId}`,
          joins: [{ table: relatedTable, type: 'left', on: [[leftCol, rightCol]] }],
        };
      }
    }
  }

  // ── 4. Many-to-many cross-source field → a (possibly nested) SEMI-JOIN ──────
  //
  // An M:N relationship is one-to-many from BOTH sides, so it has no JOIN form that preserves the
  // widget's rows at all — which is why the loop above skips `many-to-many` outright and why such
  // a filter used to be dropped as plain `unresolved`. A semi-join has no such problem: it filters
  // the widget's rows without multiplying them, at either arity.
  //
  // Two shapes, exactly the two `dataSourceGraph.findJoinPath` models (this mirrors its arms
  // deliberately — the in-memory and wire paths must agree on which relationships are reachable):
  //
  //   - the field lives on the M:N's REMOTE endpoint → `hops: 2`, a NESTED semi-join through the
  //     junction table (`widget.k IN (SELECT j.wk FROM j WHERE j.rk IN (SELECT r.k FROM r WHERE …))`);
  //   - the field lives on the JUNCTION source itself → `hops: 1`, a plain semi-join against the
  //     junction's own rows. A junction table is never a relationship's own `sourceId`/`targetId`,
  //     only its `junctionSourceId`, so neither loop above can reach it.
  //
  // As with the one-to-many case above, `unresolved: true, fanOut: true` are kept alongside
  // `semiJoin`: only the FILTER path can use a semi-join, and every other use of an M:N field
  // (display column, groupBy, aggregation source) still has no faithful wire form.
  for (const rel of relationships) {
    if (rel.type !== 'many-to-many') {
      continue;
    }
    if (!rel.junctionSourceId || !rel.junctionSourceField || !rel.junctionTargetField) {
      continue; // incomplete M:N config — matches `findJoinPath`'s own completeness check
    }
    // Orient the relationship around the widget's source.
    let remoteSourceId: string;
    let widgetJoinField: string;
    let junctionWidgetField: string;
    let junctionRemoteField: string;
    let remoteJoinField: string;
    if (rel.sourceId === primarySourceId) {
      remoteSourceId = rel.targetId;
      widgetJoinField = rel.sourceField;
      junctionWidgetField = rel.junctionSourceField;
      junctionRemoteField = rel.junctionTargetField;
      remoteJoinField = rel.targetField;
    } else if (rel.targetId === primarySourceId) {
      remoteSourceId = rel.sourceId;
      widgetJoinField = rel.targetField;
      junctionWidgetField = rel.junctionTargetField;
      junctionRemoteField = rel.junctionSourceField;
      remoteJoinField = rel.sourceField;
    } else {
      continue;
    }

    const junctionSource = dataSources[rel.junctionSourceId];
    if (!junctionSource) {
      continue;
    }
    // Both extra tables must live on the SAME adapter endpoint as the widget's own source — a
    // subquery cannot span databases any more than a JOIN can. Mirrors the endpoint guards on the
    // expression-field paths above.
    const primaryEndpoint = getBatchingEndpoint(dataSources[primarySourceId]?.adapter);
    const junctionEndpoint = getBatchingEndpoint(junctionSource.adapter);
    if (primaryEndpoint && junctionEndpoint && primaryEndpoint !== junctionEndpoint) {
      continue;
    }
    const junctionTable = junctionSource.tableName ?? rel.junctionSourceId;

    // `hops: 1` — the filtered field is a column of the JUNCTION table itself.
    if (junctionSource.fields.some((f) => f.id === fieldId)) {
      return {
        column: fieldId,
        unresolved: true,
        fanOut: true,
        semiJoin: {
          sourceId: rel.junctionSourceId,
          descriptor: {
            table: junctionTable,
            column: `${primaryTableName}.${widgetJoinField}`,
            foreignColumn: `${junctionTable}.${junctionWidgetField}`,
            filters: [],
          },
          filterColumn: `${junctionTable}.${fieldId}`,
        },
      };
    }

    // `hops: 2` — the filtered field is a column of the REMOTE endpoint, reached through the
    // junction.
    const remoteSource = dataSources[remoteSourceId];
    if (!remoteSource?.fields.some((f) => f.id === fieldId)) {
      continue;
    }
    const remoteEndpoint = getBatchingEndpoint(remoteSource.adapter);
    if (primaryEndpoint && remoteEndpoint && primaryEndpoint !== remoteEndpoint) {
      continue;
    }
    const remoteTable = remoteSource.tableName ?? remoteSourceId;
    return {
      column: fieldId,
      unresolved: true,
      fanOut: true,
      semiJoin: {
        sourceId: remoteSourceId,
        descriptor: {
          table: junctionTable,
          column: `${primaryTableName}.${widgetJoinField}`,
          foreignColumn: `${junctionTable}.${junctionWidgetField}`,
          // The junction level links the two tables and carries NO predicate of its own — the
          // filter belongs to the remote source, so it lands in the nested level.
          filters: [],
          semiJoins: [
            {
              table: remoteTable,
              column: `${junctionTable}.${junctionRemoteField}`,
              foreignColumn: `${remoteTable}.${remoteJoinField}`,
              filters: [],
            },
          ],
        },
        filterColumn: `${remoteTable}.${fieldId}`,
      },
    };
  }

  // Field not found anywhere — pass through unqualified but mark as unresolved so
  // callers can drop it from WHERE clauses (avoids "no such column" SQL errors).
  return { column: fieldId, unresolved: true };
}

/**
 * Describes a cross-endpoint join that must be resolved client-side after
 * fetching the primary rows from the server.
 */
interface CrossEndpointEnrichment {
  /** The logical expression field ID to populate (e.g. 'expr-deal-segment') */
  logicalFieldId: string;
  /** FK field on the primary source rows that links to the join source (e.g. 'customerId') */
  fkField: string;
  /** Source ID of the join target (e.g. 'source-customers') */
  joinSourceId: string;
  /** The field to pull from the join target (e.g. 'segment') */
  joinFieldId: string;
  /** PK field on the join target that matches fkField values (e.g. 'id') */
  joinPkField: string;
}

/**
 * Result of building a batch widget descriptor: the request body to send to the server
 * and any cross-endpoint enrichments to apply after receiving the server response.
 */
interface BuiltBatchDescriptor {
  requestBody: object;
  crossEndpointEnrichments: CrossEndpointEnrichment[];
  /**
   * Filters that could NOT be faithfully sent to the server (OR-combined conditions or
   * operators with no equivalent / a case-sensitivity mismatch on the wire protocol) and
   * must be re-applied to the returned raw rows client-side (findings 1.4 / 1.5). Only set
   * for raw-row queries — when the server aggregates, the predicate is dropped with a warning
   * instead, since it cannot be re-applied to pre-aggregated rows.
   */
  clientFilter?: StudioFilterState[];
}

/**
 * Build the `BatchWidgetDescriptor` object to send to the server for one widget.
 *
 * When `dataSources` and `relationships` are provided, any field referenced by the
 * widget that does not belong to the widget's primary source is resolved to its
 * owning table and a LEFT JOIN descriptor is generated automatically.
 *
 * Expression fields are also resolved:
 * - `JoinFieldExpression` → aliased column SELECT via `columnAliases`
 * - `FunctionExpression` → stripped from the descriptor (server returns raw rows)
 *
 * When an expression field's join target lives on a different adapter endpoint
 * (cross-DB), the field is skipped server-side. The FK column is added to the
 * SELECT so the client can perform enrichment after fetching.
 */
function buildBatchWidgetDescriptor(
  d: StudioQueryDescriptor,
  dataSources: Record<string, StudioDataSource> | undefined,
  relationships: StudioRelationship[] | undefined,
  expressionFields?: StudioExpressionField[],
): BuiltBatchDescriptor {
  const tableName = d.tableName ?? d.sourceId;
  // Per-build set so each divergence warning fires at most once per fetch, never per row.
  const warnDedupe = new Set<string>();

  // ── Simple mode (no relationship info) ────────────────────────────────────
  if (!dataSources || !relationships) {
    // Include all select fields (both group-by and aggregate-source fields) so
    // client/server-tier raw rows contain the measure columns Studio needs for
    // client-side aggregation. The db-tier query builder excludes aggregate
    // fields from groupBy via aggregations[*].column.
    const columns = [...d.select];

    // Split the filter into server-executable predicates and a client-side residual
    // (OR conditions / unmappable operators) so neither is silently mistranslated (1.4 / 1.5).
    // Leaves we DO push down are checked for NULL-handling divergence via
    // warnServerLeafDivergence (finding 2.16a).
    //
    // This MUST run before the aggregation push-down decision below: "a leaf fell to the client
    // residual" is one of that decision's inputs, and the two used to run in the opposite order.
    // A residual cannot be evaluated against a pre-aggregated response, so an aggregating widget
    // with (say) a `contains` page filter pushed the aggregation down, discarded the residual with
    // only a warning, and aggregated over EVERY row.
    const partition = partitionFilterNode(d.filter, (leaf) =>
      warnServerLeafDivergence(leaf, d.sourceId, warnDedupe),
    );

    // An own-source expression (calculated-column) field has no physical column of the same name,
    // so simple mode — which has no relationship graph and cannot resolve it to one — must not
    // send it in a WHERE (server predicate) or a SELECT (client-residual projection): either fails
    // the batch entry with "no such column". Relationship-aware mode handles this via resolve()'s
    // `skip` (server predicate) + the isPlainPrimaryField check (residual projection); simple mode
    // needs the same two guards. The predicate is dropped and the leaf's client residual is
    // rejected — never silently (finding 2.6). (The returned raw rows aren't enriched with the
    // calculated value, so a client-side residual over them cannot be evaluated faithfully either.)
    const isOwnSourceExpressionField = (fieldId: string): boolean =>
      expressionFields?.some((ef) => ef.id === fieldId && ef.sourceId === d.sourceId) ?? false;

    const serverPredicates = partition.predicates.filter((pred) => {
      if (isOwnSourceExpressionField(pred.column)) {
        warnAdapterDivergence(
          warnDedupe,
          `A filter on the calculated field "${pred.column}" for source "${d.sourceId}" cannot be ` +
            `executed by a simple-mode data adapter (the server has no column of that name), so it ` +
            `was dropped from the query and the widget may show more rows than expected. ` +
            `Calculated-field filters work correctly on in-memory sources.`,
        );
        return false;
      }
      return true;
    });

    // Only a residual leaf that CAN be re-applied to the returned raw rows justifies giving up the
    // push-down. A leaf on an own-source calculated column is rejected by the projection guard
    // below whether or not the query aggregates (the raw rows never carry that column), so counting
    // it here would trade a wrong number for an equally wrong number fetched the slow way.
    const aggregations = decideWireAggregations(
      d,
      partition.clientLeaves.some((leaf) => !isOwnSourceExpressionField(leaf.field)),
      warnDedupe,
      (fieldId) => fieldId,
    );

    const clientFilter = resolveClientResidual(
      partition,
      Boolean(aggregations),
      d.sourceId,
      warnDedupe,
      (fieldId) => {
        if (isOwnSourceExpressionField(fieldId)) {
          return false;
        }
        if (!columns.includes(fieldId)) {
          columns.push(fieldId);
        }
        return true;
      },
    );

    // Simple mode has no relationship graph to resolve a groupBy id against, so an expression
    // (calculated-column) field id has no guaranteed physical column of the same name — emitting
    // `ORDER BY <expression-field-id>` unresolved fails the whole batch entry with "no such
    // column". Relationship-aware mode already strips this case via its `skip`/`unresolved`
    // check (`orderByColumn`, below); simple mode needs the same guard (finding 2.11).
    const groupByIsExpressionField = Boolean(
      d.groupBy &&
      expressionFields?.some((ef) => ef.id === d.groupBy && ef.sourceId === d.sourceId),
    );

    return {
      requestBody: {
        id: batchEntryId(d),
        table: tableName,
        columns,
        aggregations,
        filters: serverPredicates.length > 0 ? serverPredicates : undefined,
        orderBy:
          d.groupBy && !groupByIsExpressionField
            ? [{ column: d.groupBy, direction: 'asc' as const }]
            : undefined,
      },
      crossEndpointEnrichments: [],
      clientFilter,
    };
  }

  // ── Relationship-aware mode ────────────────────────────────────────────────
  const joinsMap = new Map<string, JoinDescriptorInternal>();
  // Maps logical field ID → physical SQL column (for expression fields)
  const columnAliases: Record<string, string> = {};
  // Cross-endpoint enrichments collected while resolving fields
  const enrichments: CrossEndpointEnrichment[] = [];

  /**
   * Semi-joins accumulated while resolving the server-pushable filter predicates, keyed by the
   * FOREIGN SOURCE they filter so every predicate targeting one source lands in ONE subquery.
   *
   * The grouping is the semantics, not an optimization: one subquery per source means
   * `EXISTS(foreign row matching A AND B)`, which is what SQL, every BI tool, and
   * `dataSourceGraph.resolveRows`'s own grouped pass all compute. One subquery per PREDICATE would
   * mean `EXISTS(matching A) AND EXISTS(matching B)` — satisfied by a customer whose order #1 is
   * paid and whose DIFFERENT order #2 is over $100 — and would put the adapter path back in
   * disagreement with the in-memory path on the same dashboard.
   */
  const semiJoinGroups = new Map<string, SemiJoinDescriptorInternal>();

  function resolve(fieldId: string): {
    column: string;
    skip?: boolean;
    unresolved?: boolean;
    fanOut?: boolean;
    semiJoin?: ResolvedField['semiJoin'];
  } {
    const resolved = resolveField(
      fieldId,
      d.sourceId,
      tableName,
      dataSources!,
      relationships!,
      expressionFields,
    );
    for (const join of resolved.joins ?? []) {
      if (!joinsMap.has(join.table)) {
        joinsMap.set(join.table, join);
      }
    }
    if (resolved.physicalColumn) {
      // Expression join field: keep logical ID in columns, alias to physical column
      columnAliases[resolved.column] = resolved.physicalColumn;
    }
    if (resolved.crossEndpointJoin) {
      // Record enrichment only if not already registered (dedup by logicalFieldId).
      const alreadyRegistered = enrichments.some(
        (enrichment) => enrichment.logicalFieldId === fieldId,
      );
      if (!alreadyRegistered) {
        enrichments.push({ logicalFieldId: fieldId, ...resolved.crossEndpointJoin });
      }
    }
    return {
      column: resolved.column,
      skip: resolved.skip,
      unresolved: resolved.unresolved,
      fanOut: resolved.fanOut,
      semiJoin: resolved.semiJoin,
    };
  }

  // SELECT all fields (group-by AND aggregate-source fields), skipping server-incompatible
  // expressions and fields that cannot be resolved to any column in the primary or related
  // sources. Including aggregate fields ensures client/server-tier raw rows contain the
  // measure columns Studio needs for client-side aggregation. For db-tier, executeForTier
  // filters out aggregate fields from the GROUP BY using aggregations[*].column.
  const columns = d.select.flatMap((fieldId) => {
    const r = resolve(fieldId);
    if (r.skip || r.unresolved) {
      return [];
    }
    // A projected column that is ALSO a `columnAliases` key becomes an interpolated
    // `?? as ??` output alias server-side, which the host charset-checks fail-closed
    // (`validateOutputAliases`) — an id like `"montant€"` would fail the whole widget, not
    // just this column. Drop the column instead, so the rest of the widget still renders.
    // A filter on the same field is unaffected: it references the PHYSICAL column, and the
    // `columnAliases` entry that resolves it is never itself checked.
    if (columnAliases[r.column] !== undefined && !SAFE_WIRE_ALIAS.test(r.column)) {
      warnAdapterDivergence(
        warnDedupe,
        `The calculated field "${r.column}" for source "${d.sourceId}" has an id containing ` +
          `characters outside the identifier charset the data adapter's query protocol allows ` +
          `(letters, digits, underscores and hyphens), so it could not be projected and was ` +
          `dropped from the query. Rename the field id to a plain identifier; the field works ` +
          `correctly on in-memory sources.`,
      );
      return [];
    }
    return [r.column];
  });

  // For cross-endpoint enrichments, add the FK column to the SELECT so the client
  // can look up the join target's value after receiving server rows.
  for (const enr of enrichments) {
    if (!columns.includes(enr.fkField)) {
      columns.push(enr.fkField);
    }
  }

  // Resolve the groupBy field to detect if it's cross-endpoint.
  const groupByResolved = d.groupBy ? resolve(d.groupBy) : undefined;
  const groupByIsCrossEndpoint = Boolean(groupByResolved?.skip);

  // Filters — split into server-executable predicates and a client-side residual (OR
  // conditions / unmappable operators, findings 1.4 / 1.5), then resolve the server predicates'
  // cross-source column references, using the physical column name (not the logical alias) so
  // the server WHERE clause references a real column. Predicates whose field cannot be resolved
  // to any column in this source (unresolved: true) are dropped — applying them would produce
  // "no such column" SQL errors.
  //
  // Partitioning runs BEFORE the aggregation push-down decision below, because "a leaf fell to the
  // client residual" is one of that decision's inputs and a residual cannot be evaluated against a
  // pre-aggregated response. The two used to run in the opposite order, so an aggregating widget
  // with an unpushable filter dropped that filter with only a warning and aggregated every row.
  const partition = partitionFilterNode(d.filter, (leaf) =>
    warnServerLeafDivergence(leaf, d.sourceId, warnDedupe),
  );

  /**
   * Whether a residual leaf's field can be re-projected under its LOGICAL id in the returned raw
   * rows — the same test `resolveClientResidual`'s `tryProjectField` applies below, minus the
   * projection side effect, so it can also be asked BEFORE the push-down decision. Deliberately
   * side-effect-free (unlike `resolve`, which would register a spurious JOIN for a cross-source
   * field before we reject it).
   */
  const isPlainPrimaryField = (fieldId: string): boolean => {
    const isExpressionField = expressionFields?.some((f) => f.id === fieldId) ?? false;
    return (
      !isExpressionField && Boolean(dataSources[d.sourceId]?.fields.some((f) => f.id === fieldId))
    );
  };

  // Aggregations — skip expression fields that can't be aggregated server-side.
  // When the groupBy field is cross-endpoint, strip ALL aggregations so the server
  // returns raw rows (with FK column) that the client can enrich and then aggregate.
  const aggregations: AggregationSpec[] | undefined = groupByIsCrossEndpoint
    ? // Can't group server-side — return raw rows for client-side enrichment + aggregation.
      undefined
    : decideWireAggregations(
        d,
        // Only a residual leaf that CAN be re-applied to the returned raw rows justifies giving up
        // the push-down; one whose column could not be projected is dropped either way.
        partition.clientLeaves.some((leaf) => isPlainPrimaryField(leaf.field)),
        warnDedupe,
        (fieldId) => {
          const r = resolve(fieldId);
          return r.skip ? null : r.column;
        },
      );

  const filters = partition.predicates.flatMap((pred) => {
    const r = resolve(pred.column);
    if (r.skip) {
      // A `skip` predicate targets a computed (arithmetic `FunctionExpression`) field with no
      // server-side column — the raw inputs come back and the expression is re-derived
      // client-side, but this predicate cannot be re-applied at the adapter's raw-row residual
      // stage (the expression column isn't materialised there). Warn rather than drop it
      // silently, honouring the module's "degrades to client-side, never silently dropped"
      // contract (finding 1.7).
      warnAdapterDivergence(
        warnDedupe,
        `A filter on the computed field "${pred.column}" for source "${d.sourceId}" targets an ` +
          `arithmetic expression with no server-side column, so it was dropped from the query. ` +
          `Computed-field filters work correctly on in-memory sources.`,
      );
      return [];
    }
    if (r.semiJoin) {
      // The predicate's field is reachable only across a relationship that is one-to-many from
      // this widget's side. A LEFT JOIN there would multiply the widget's rows by the match count
      // and inflate every aggregate; a SEMI-join filters them without multiplying, which is
      // exactly what `dataSourceGraph.resolveRows` does in memory. Accumulate into the group for
      // this foreign source rather than emitting one subquery per predicate — see
      // `semiJoinGroups`.
      let group = semiJoinGroups.get(r.semiJoin.sourceId);
      if (!group) {
        group = r.semiJoin.descriptor;
        semiJoinGroups.set(r.semiJoin.sourceId, group);
      }
      // The predicate belongs to the DEEPEST level — the subquery against the source it actually
      // filters. For a one-hop semi-join that is the descriptor itself; for a two-hop
      // many-to-many one it is the nested level, since the junction exists only to link the two
      // tables and carries no predicate of its own.
      innermostSemiJoin(group).filters.push({ ...pred, column: r.semiJoin.filterColumn });
      return [];
    }
    if (r.fanOut) {
      // Reachable only across a one-to-many relationship AND not expressible as a semi-join —
      // the residual case the orientation guard could not hand a `semiJoin` for. Dropping it
      // makes the widget show MORE rows than the in-memory path; emitting the join would make
      // every aggregate wrong by the per-row match count, which is worse and invisible.
      warnAdapterDivergence(
        warnDedupe,
        `A filter on "${pred.column}" for source "${d.sourceId}" targets a related source that has ` +
          `MANY rows per row of this source. The data adapter's query protocol can only express ` +
          `that as a JOIN, which would multiply this widget's rows and inflate every aggregate, ` +
          `so the filter was dropped and the widget may show more rows than expected. This filter ` +
          `works correctly on in-memory sources.`,
      );
      return [];
    }
    if (r.unresolved) {
      // The predicate's field resolves to no column in this source or any directly related source
      // (typically a field 2+ relationship hops away, e.g. `orders.date` filtering a `products`
      // widget). Emitting it would produce a "no such column" SQL error, so it is dropped — but,
      // like the `skip` branch above, never silently: the widget will show MORE rows than the same
      // dashboard on an in-memory source, and that divergence must be surfaced (finding 2.5).
      warnAdapterDivergence(
        warnDedupe,
        `A filter on "${pred.column}" for source "${d.sourceId}" could not be resolved to any ` +
          `column in this source or a directly related source (the field may live two or more ` +
          `relationship hops away), so it was dropped from the query and the widget may show more ` +
          `rows than expected. This filter works correctly on in-memory sources.`,
      );
      return [];
    }
    // columnAliases maps logical ID → physical column (e.g. 'expr-order-country' → 'customers.country').
    // WHERE clauses must reference the physical column; the alias is only used in SELECT.
    const physicalColumn = columnAliases[r.column] ?? r.column;
    return [{ ...pred, column: physicalColumn }];
  });

  // Client-side residual: re-applied to returned raw rows when the query is NOT aggregated
  // server-side. A leaf's field is only usable client-side if it comes back under its logical
  // id (a plain primary-source column) — a cross-source/expression field would arrive under an
  // aliased/physical key, so those are dropped with a warning instead.
  const clientFilter = resolveClientResidual(
    partition,
    Boolean(aggregations),
    d.sourceId,
    warnDedupe,
    (fieldId) => {
      if (!isPlainPrimaryField(fieldId)) {
        return false;
      }
      if (!columns.includes(fieldId)) {
        columns.push(fieldId);
      }
      return true;
    },
  );

  // ORDER BY — use physical column for expression fields (server sees physical name).
  // When groupBy is cross-endpoint, orderBy is already suppressed via groupByIsCrossEndpoint.
  const orderByColumn = groupByIsCrossEndpoint ? undefined : groupByResolved;

  return {
    requestBody: {
      id: batchEntryId(d),
      table: tableName,
      columns: columns.length > 0 ? columns : undefined,
      columnAliases: Object.keys(columnAliases).length > 0 ? columnAliases : undefined,
      joins: joinsMap.size > 0 ? [...joinsMap.values()] : undefined,
      // `semiJoinGroups` is populated as a side effect of the `filters` flatMap above (which
      // already ran, being a `const`), so this reads the complete set.
      semiJoins: semiJoinGroups.size > 0 ? [...semiJoinGroups.values()] : undefined,
      aggregations,
      filters: filters.length > 0 ? filters : undefined,
      // Drop the ORDER BY when the groupBy field is `skip` (server-incompatible expression) OR
      // `unresolved` (resolvable to no column in this source). `resolveField`'s contract requires
      // callers to drop an unresolved field from SELECT/WHERE — which they do — but the ORDER BY
      // emission previously checked only `.skip`, so an unresolved groupBy (a field 2+ hops away)
      // would emit `ORDER BY <nonexistent column>` and fail the whole batch entry (finding 2.19).
      orderBy:
        orderByColumn && !orderByColumn.skip && !orderByColumn.unresolved
          ? [
              {
                column: columnAliases[orderByColumn.column] ?? orderByColumn.column,
                direction: 'asc' as const,
              },
            ]
          : undefined,
    },
    crossEndpointEnrichments: enrichments,
    clientFilter,
  };
}

/**
 * Operators the data-middleware queryBuilder can execute server-side (its `SAFE_OPERATORS`
 * allowlist). Every `StudioFilterOperator` NOT in this map has no faithful translation on the
 * wire protocol and is therefore handled client-side (see `partitionFilterNode`):
 *  - there is no `NOT IN`, `NOT LIKE`, or `IS (NOT) NULL` operator, so `not_in`,
 *    `does_not_contain`, `not_starts_with`, `not_ends_with`, `is_empty`, `is_not_empty` have
 *    no equivalent;
 *  - `contains` / `starts_with` / `ends_with` could be approximated with `LIKE '%x%'` /
 *    `LIKE 'x%'` / `LIKE '%x'`, but the server's `LIKE` is case-SENSITIVE while Studio's
 *    in-memory evaluator is case-INSENSITIVE, so pushing them down would DIVERGE from
 *    in-memory results (trading one silent-wrong-data bug for a subtler one). `contains` was
 *    even worse: it mapped to `'like'` and forwarded the raw needle WITHOUT `%` wildcards, so
 *    the server's `whereLike(col, value)` behaved as a case-sensitive EXACT match — silently
 *    returning only rows equal to the needle instead of every row containing it (finding 1.7).
 *    All three substring operators are evaluated client-side to stay byte-for-byte consistent.
 *
 * Presence in this map is NECESSARY but not SUFFICIENT for pushdown: `isOpValueServerTranslatable`
 * subtracts the (operator, value, fieldType) combinations whose wire form would still diverge —
 * today an empty `in: []`, an open-ended `between`, a `not_equals` on a `date`/`datetime` field
 * and an `equals` on a `date`/`datetime` field whose value does not reduce to a calendar day
 * (see there). And presence does not mean a 1:1 predicate: `toPredicatesFor` rewrites the
 * date-granularity operators (`eq`, `gt`, `lte`, `between`) into day-faithful bound pairs.
 */
const OPERATOR_MAP: Partial<Record<StudioFilterOperator, FilterPredicate['operator']>> = {
  equals: 'eq',
  not_equals: 'neq',
  in: 'in',
  greater_than: 'gt',
  less_than: 'lt',
  greater_than_or_equal: 'gte',
  less_than_or_equal: 'lte',
  between: 'between',
};

function mapOperator(op: StudioFilterOperator): FilterPredicate['operator'] | null {
  return OPERATOR_MAP[op] ?? null;
}

type StudioFilterLeaf = Extract<StudioFilterNode, { type: 'leaf' }>;

/**
 * Warn (at most once per widget-descriptor build — `dedupe` is a per-build Set, so never once
 * per row) that a filter/aggregation could not be executed faithfully server-side and how it
 * was handled, so the divergence from in-memory behaviour is never silent (findings 1.4 / 1.5 /
 * 2.11). Fires in every environment because the harm (wrong data) is most visible against a
 * real db-tier source in production.
 */
function warnAdapterDivergence(dedupe: Set<string>, message: string): void {
  if (dedupe.has(message)) {
    return;
  }
  dedupe.add(message);

  console.warn(`MUI X Studio: ${message}`);
}

/**
 * True when a `{ from, to }` (or `[lo, hi]`) `between` value has BOTH bounds set. Mirrors the
 * in-memory evaluator's truthy-bound semantics (`filterUtils.ts`: `range.from ? … : null`), so
 * an empty string counts as "unset". An open-ended between ({ from } or { to } only) is NOT
 * fully bounded — the wire path would send `whereBetween(col, [value, undefined])`, a binding
 * error on Postgres / a silent wrong result on SQLite/MySQL (finding 2.15). Single-bound
 * betweens are therefore kept client-side, where a missing bound is treated as unbounded.
 */
function isFullyBoundedBetween(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  // `!= null && !== ''` rather than a truthiness check so a genuine `0` bound (e.g.
  // "between 0 and 100") counts as SET — a truthiness check treated `0` as unset and kept
  // the whole predicate client-side, mirroring the in-memory bug this pairs with (finding 2.25).
  const hasBound = (v: unknown): boolean => v != null && v !== '';
  if (Array.isArray(value)) {
    return value.length === 2 && hasBound(value[0]) && hasBound(value[1]);
  }
  const range = value as { from?: unknown; to?: unknown };
  return hasBound(range.from) && hasBound(range.to);
}

/**
 * True when a single (op, value, fieldType) triple can be sent to the server with EXACTLY the same
 * semantics as the in-memory evaluator. Beyond the operator mapping, five cases must stay
 * client-side because their wire translation inverts or corrupts the in-memory result:
 *  - an empty `in` array matches NOTHING both in-memory (`filterVal.some(...)` over `[]`) and on
 *    the wire (the middleware emits `whereIn(col, [])` → `1 = 0`), so pushing it down would be
 *    faithful today — but the in-memory "match nothing" is the SEMANTICS this module pins, and the
 *    predicate selects no rows either way, so it is kept client-side where one evaluator owns the
 *    empty-selection rule (see `leafToClientFilterState`'s `filterMode` note, finding T2.3);
 *  - an open-ended `between` (only one bound set) is unbounded in-memory but becomes a
 *    malformed two-arg `whereBetween` on the wire (finding 2.15);
 *  - a `boolean` field whose value is not one of the two spellings `toWirePredicateValue` can
 *    coerce to a real boolean (see the `boolean` branch below);
 *  - `not_equals` on a `date`/`datetime` field, whose faithful form is an OR (finding T1.3b);
 *  - `equals` on a `date`/`datetime` field whose value does not reduce to a calendar day, so the
 *    day-range rewrite in `toPredicatesFor` cannot be built (finding T1.3b).
 *
 * The two date cases exist because `equals`/`not_equals` on a `date`/`datetime` field are
 * DAY-granular in-memory for EVERY value form: `filterUtils`' `compileSingleCondition` routes both
 * sides through `toDayComparable`, which truncates to `YYYY-MM-DD`. (This is unlike the ordering
 * bounds, which go through `compileDateBound` and only widen a DATE-ONLY value — so the wire
 * rewrite for them is conditional on date-only-ness while the one for `equals` is not.)
 */
function isOpValueServerTranslatable(
  op: StudioFilterOperator,
  value: unknown,
  fieldType: StudioFilterLeaf['fieldType'],
): boolean {
  if (mapOperator(op) === null) {
    return false;
  }
  if (op === 'in' && Array.isArray(value) && value.length === 0) {
    return false;
  }
  if (op === 'between' && !isFullyBoundedBetween(value)) {
    return false;
  }
  if (fieldType === 'boolean') {
    // The drawer stores a boolean filter's value as the STRING `'true'`/`'false'`, which the
    // in-memory evaluator compares as `String(row[field]) === value` — correct. Bound to SQL as a
    // string it is not: PostgreSQL implicitly casts `'true'`, but MySQL (`tinyint(1)`) and SQLite
    // coerce it NUMERICALLY to 0, so `col = 'true'` returns exactly the rows where the flag is
    // FALSE — the complement of what was asked for. `toWirePredicateValue` coerces the two
    // recognised spellings to real booleans; anything else on a boolean field (a bare `''`, a
    // number, an `in [...]` list) has no equally certain coercion, so it falls to the client
    // residual instead of shipping a guess.
    return coerceWireBoolean(resolveWireScalar(value)) !== null;
  }
  if (isDateFieldType(fieldType)) {
    // "not on day D" is `col < D OR col >= nextDay(D)`. The wire protocol AND-combines every
    // predicate and has no OR, so there is no AND-expressible form — pushing `neq D` instead
    // compares the raw column to midnight and KEEPS every non-midnight row of day D, i.e. the
    // adapter returns MORE rows than the evaluator. Route it to the client residual, where
    // `applyFilters` evaluates it at day granularity (and, as a bonus, keeps the NULL rows SQL
    // three-valued logic would have dropped).
    if (op === 'not_equals') {
      return false;
    }
    // `equals` IS AND-expressible (`>= D` AND `< nextDay(D)`, see `toPredicatesFor`) — but only
    // once the wire value reduces to a calendar day. A numeric epoch, a `Date` instance or a
    // non-ISO string cannot be turned into that pair here, and a bare `eq` against them diverges,
    // so those fall back to the client residual rather than shipping a wrong predicate.
    if (op === 'equals') {
      return dayPartOfWireValue(resolveWireScalar(value)) !== null;
    }
  }
  return true;
}

/**
 * True when a leaf can be sent to the server with EXACTLY the same semantics as the in-memory
 * evaluator: its operator(s) + value(s) map to the wire protocol AND, when it carries a second
 * condition, the two are AND-combined (the wire protocol ANDs every predicate and has no OR).
 */
function isLeafServerTranslatable(leaf: StudioFilterLeaf): boolean {
  // An incomplete first condition (e.g. the drawer's `{ operator: 'equals', value: '' }`
  // add-filter default) has no in-memory effect — `applyFilters` drops it via `isFilterComplete`.
  // Pushing it down as a real `col = ''` predicate empties a string column / errors a numeric one.
  // Route it to the client-side residual instead, where `applyFilters` re-drops it (self-healing,
  // finding T1.1). The normal path also prunes it in `buildQueryDescriptor`; this guards a
  // host-authored descriptor that bypasses that builder.
  if (!isConditionComplete(leaf.op, leaf.value)) {
    return false;
  }
  if (!isOpValueServerTranslatable(leaf.op, leaf.value, leaf.fieldType)) {
    return false;
  }
  // Mirror `isConditionComplete`'s presence rule (not a bare `value2 !== undefined` check) — a
  // valueless second operator (`is_empty`/`is_not_empty`) IS a real, present second condition
  // with no value at all. The old `value2 !== undefined` check reported `hasSecondCondition` as
  // false for it, so the leaf was declared "fully translatable" on its FIRST condition alone —
  // silently dropping the second condition entirely (never emitted in `leafToPredicates` either,
  // since that function has the same `value2 !== undefined` gate) instead of failing translation
  // and falling back to the client-side residual, where the in-memory evaluator enforces both
  // conditions correctly (finding 2.8).
  const hasSecondCondition = leaf.op2 !== undefined && isConditionComplete(leaf.op2, leaf.value2);
  if (!hasSecondCondition) {
    return true;
  }
  // A second condition combined with OR ("x < 5 OR x > 100") cannot be expressed as two
  // AND-ed predicates — the server would AND them and return zero rows (finding 1.4).
  if (leaf.conjunction === 'or') {
    return false;
  }
  return isOpValueServerTranslatable(leaf.op2!, leaf.value2, leaf.fieldType);
}

/**
 * Warn (once per widget-descriptor build) about the null-handling drift of a leaf that IS pushed
 * to the server but whose semantics differ subtly from the in-memory evaluator (finding 2.16a).
 * Unlike the operators routed to the client residual, `not_equals` stays server-side because its
 * pushdown is essential (it is a common, high-selectivity filter, and routing it client-side would
 * defeat the query pushdown and, for aggregated widgets, drop the filter entirely). The divergence
 * is surfaced loudly instead of silently: SQL three-valued logic excludes NULL rows server-side,
 * but the in-memory evaluator KEEPS them (`row[field] != value` is true for null).
 *
 * There is no longer a companion date warning. `equals` on a `date`/`datetime` field used to be
 * pushed as a raw `eq` against a bare `'YYYY-MM-DD'` — matching only exact-midnight rows on a
 * DATETIME column while in-memory matched the whole day — and that was merely warned about
 * ("Use a `between` range instead"), i.e. a dashboard viewer saw a wrong number and only a
 * developer saw the console note. It is now TRANSLATED to a faithful `>= D AND < nextDay(D)` pair
 * by `toPredicatesFor`, and the shapes that cannot be translated are routed to the client residual
 * by `isOpValueServerTranslatable`, so there is nothing left to warn about (finding T1.3b).
 *
 * `not_equals` on a `date`/`datetime` field is likewise no longer pushed at all (its faithful form
 * is an OR), so this warning only ever fires for a non-date `not_equals`.
 */
function warnServerLeafDivergence(
  leaf: StudioFilterLeaf,
  sourceId: string,
  dedupe: Set<string>,
): void {
  if (leaf.op === 'not_equals' || leaf.op2 === 'not_equals') {
    warnAdapterDivergence(
      dedupe,
      `A "not_equals" filter on "${leaf.field}" for source "${sourceId}" is executed server-side, ` +
        `where SQL three-valued logic excludes rows whose value is NULL. In-memory sources keep ` +
        `those NULL rows, so the adapter may return fewer rows. Add an explicit "is empty" ` +
        `condition if NULL rows should be included.`,
    );
  }
}

/** Resolves `rawValue` to its wire form if it's a top-level `RelativeDateValue`, else passes it through unchanged. */
function resolveWireScalar(rawValue: unknown): unknown {
  return isRelativeDateValue(rawValue) ? resolveRelativeDate(rawValue) : rawValue;
}

/**
 * A boolean filter value as a REAL boolean, or `null` when this module cannot be certain what the
 * author meant (finding: boolean `equals`/`not_equals` inverted on MySQL/SQLite).
 *
 * The filter drawer stores a boolean condition's value as the string `'true'`/`'false'`
 * (`BooleanValueInput`'s `<Select>` options), and the in-memory evaluator compares it as
 * `String(row[field]) === value`, which is right. Bound to SQL as a string it is not: `where(col,
 * '=', 'true')` is implicitly cast by PostgreSQL but coerced NUMERICALLY by MySQL's `tinyint(1)`
 * and by SQLite, both of which read `'true'` as `0` and therefore return the COMPLEMENT of the
 * requested rows. Both drivers are first-class in the dev server, so this is not a theoretical
 * dialect corner.
 *
 * Only the exact spellings the drawer produces (plus a genuine boolean, for a host-authored
 * descriptor) are recognised. `'1'`/`'yes'`/`0` etc. return `null` so the leaf falls to the client
 * residual, where the shared evaluator decides — rather than this module inventing a rule the
 * in-memory path does not have.
 */
function coerceWireBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
}

/**
 * Resolve a filter value to its wire form for one (operator, value) pair:
 *  - relative-date values (e.g. "7 days ago") are resolved to a concrete date/instant string;
 *  - a `between` value authored as a `{ from, to }` object (how `setDashboardDateRange` /
 *    `setWidgetDateRange` / the drawer's `SecondCondition` store it) is converted to the
 *    `[lo, hi]` tuple the server's queryBuilder expects.
 *
 * Applied to BOTH the first predicate AND the `op2`/`value2` second condition — the object→tuple
 * conversion was previously inlined in the first-predicate branch only, so a second-condition
 * `between` (e.g. "amount > 0 AND amount between 10–20") shipped its raw `{ from, to }` object,
 * which the middleware rejects for a non-array `between` value → the whole batch entry errors
 * (finding 1.5).
 *
 * Each `between` bound is ALSO resolved individually (not just the top-level value): the drawer
 * lets a user pick a relative date for either bound of a `between` filter
 * (`FilterValueInput.tsx`'s two `DateValueInput`s), so `{ from: <RelativeDateValue>, to: '2024-…' }`
 * is a real shape reaching this function. `isRelativeDateValue(rawValue)` alone only catches a
 * relative value stored as the WHOLE filter value, not one nested inside `from`/`to` — such a
 * nested bound used to ship to the server raw/unresolved, which the middleware cannot interpret.
 */
function toWirePredicateValue(
  operator: FilterPredicate['operator'],
  rawValue: unknown,
  fieldType?: StudioFilterLeaf['fieldType'],
): unknown {
  const value = resolveWireScalar(rawValue);
  if (fieldType === 'boolean') {
    // Ship a real boolean, never the drawer's `'true'`/`'false'` STRING — see the `boolean` branch
    // of `isOpValueServerTranslatable`, which is what guarantees the coercion succeeds here.
    const asBoolean = coerceWireBoolean(value);
    if (asBoolean !== null) {
      return asBoolean;
    }
  }
  if (
    operator === 'between' &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const range = value as { from?: unknown; to?: unknown };
    return [resolveWireScalar(range.from), resolveWireScalar(range.to)] as unknown;
  }
  return value;
}

/** Matches a bare `YYYY-MM-DD` date string (no time-of-day) — the day-granular filter form. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateFieldType(fieldType: StudioFilterLeaf['fieldType']): boolean {
  return fieldType === 'date' || fieldType === 'datetime';
}

/** True for a bare `YYYY-MM-DD` string (relative-date values are already resolved to this form). */
function isDateOnlyWireValue(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY_RE.test(value);
}

/**
 * The calendar day of a wire date value as `YYYY-MM-DD` — the whole of a bare date, or the date
 * part of a full ISO instant (`2024-07-10T13:04:00.000Z` → `2024-07-10`). `null` for anything this
 * module cannot reduce to a calendar day on its own (a numeric epoch, a `Date` instance, a
 * non-ISO string), which is the signal to keep the predicate client-side rather than guess.
 *
 * Deliberately looser than `isDateOnlyWireValue`: the ordering bounds only widen a value that
 * carries NO time-of-day (mirroring `filterUtils`' `isDateOnlyFilterValue`), whereas `equals` is
 * day-granular in-memory even for a value that DOES carry one (`toDayComparable` truncates it),
 * so its wire rewrite needs the day of an instant too.
 */
function dayPartOfWireValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match === null ? null : match[1];
}

/** The calendar day AFTER a bare `YYYY-MM-DD` date, as a `YYYY-MM-DD` string (handles month/year rollover). */
function nextDayIso(dateOnly: string): string {
  const [y, m, d] = dateOnly.split('-').map(Number);
  // Day overflow is normalized by Date (e.g. Jul 31 + 1 → Aug 1, Dec 31 + 1 → Jan 1 next year).
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Emit the server FilterPredicate(s) for one (operator, value) pair, translating a bare-date bound
 * on a `date`/`datetime` field so it keeps the in-memory DAY-granularity semantics on the wire
 * (finding T1.3). In-memory, a bare-date bound compares the row's whole day (`compileDateBound`),
 * so on a DATETIME column:
 *  - `<= D` covers the entire day D → the wire must run `< nextDay(D)` (a plain `col <= 'D'` at
 *    midnight would drop everything after midnight of day D);
 *  - `> D` excludes the entire day D → the wire must run `>= nextDay(D)` (a plain `col > 'D'` would
 *    keep day-D afternoon rows the evaluator excludes);
 *  - `< D` (→ `< 'D'` at midnight) and `>= D` (→ `>= 'D'`) already match day granularity unchanged;
 *  - `between [from, to]` upper bound is the same `<= to` case → emit `>= from` AND `< nextDay(to)`.
 * For those ordering bounds, a value carrying an explicit time keeps full precision (no
 * translation), exactly like in-memory (`compileDateBound` → `isDateOnlyFilterValue`).
 *
 * `equals` is the one operator whose in-memory form is day-granular UNCONDITIONALLY — the
 * `equals`/`not_equals` branches of `compileSingleCondition` run BOTH sides through
 * `toDayComparable`, which truncates to `YYYY-MM-DD` whether or not the filter value carries a
 * time. So `= D` becomes `>= day(D) AND < nextDay(day(D))` for every value that reduces to a
 * calendar day, not only for bare dates (finding T1.3b). Before this, a "On 2024-07-10" filter on
 * a DATETIME column shipped `WHERE created_at = '2024-07-10'` — matching only exact-midnight rows,
 * so a KPI that reads a real number in-memory read 0 through the adapter.
 *
 * `not_equals` has no AND-expressible day form (`< D OR >= nextDay(D)`) and so is not routed here
 * at all — `isOpValueServerTranslatable` keeps it client-side.
 */
function toPredicatesFor(
  field: string,
  operator: FilterPredicate['operator'],
  value: unknown,
  fieldType: StudioFilterLeaf['fieldType'],
): FilterPredicate[] {
  const isDate = isDateFieldType(fieldType);
  if (isDate && operator === 'eq') {
    const day = dayPartOfWireValue(value);
    // A `null` day means the value never passed `isOpValueServerTranslatable` in the first place,
    // so this leaf is on the client residual and we are not called for it — the guard is defensive
    // for a hand-built predicate path.
    if (day !== null) {
      return [
        { column: field, operator: 'gte', value: day },
        { column: field, operator: 'lt', value: nextDayIso(day) },
      ];
    }
  }
  if (isDate && operator === 'lte' && isDateOnlyWireValue(value)) {
    return [{ column: field, operator: 'lt', value: nextDayIso(value) }];
  }
  if (isDate && operator === 'gt' && isDateOnlyWireValue(value)) {
    return [{ column: field, operator: 'gte', value: nextDayIso(value) }];
  }
  if (isDate && operator === 'between' && Array.isArray(value) && value.length === 2) {
    const [from, to] = value as [unknown, unknown];
    const predicates: FilterPredicate[] = [{ column: field, operator: 'gte', value: from }];
    predicates.push(
      isDateOnlyWireValue(to)
        ? { column: field, operator: 'lt', value: nextDayIso(to) }
        : { column: field, operator: 'lte', value: to },
    );
    return predicates;
  }
  return [{ column: field, operator, value }];
}

/**
 * Emit the server FilterPredicate(s) for a server-translatable leaf. Mirrors the historical
 * `flattenFilterNode` leaf branch, including the `{ from, to }` → `[lo, hi]` `between`
 * conversion, the faithful day-granular date translation (`toPredicatesFor`, findings T1.3 /
 * T1.3b — note it can emit TWO predicates for a single condition), and
 * the AND-combined second condition (`op2` / `value2`).
 */
function leafToPredicates(leaf: StudioFilterLeaf): FilterPredicate[] {
  const operator = mapOperator(leaf.op)!;
  const value = toWirePredicateValue(operator, leaf.value, leaf.fieldType);
  const predicates: FilterPredicate[] = toPredicatesFor(
    leaf.field,
    operator,
    value,
    leaf.fieldType,
  );
  // Handle the AND-combined second condition (op2 / value2) — e.g. a date-range filter emitting two
  // bounds. Gate on `isConditionComplete` (NOT a bare `value2 !== undefined`) so it agrees exactly
  // with `isLeafServerTranslatable`: an `op2` set with an incomplete `value2` (`value2 === ''`) is
  // NOT a present second condition, so it must not emit a phantom `col = ''` predicate (finding
  // T1.2). Because translatability already vetted `op2`, the `mapOperator(...)!` below is safe.
  if (leaf.op2 !== undefined && isConditionComplete(leaf.op2, leaf.value2)) {
    const op2 = mapOperator(leaf.op2)!;
    const value2 = toWirePredicateValue(op2, leaf.value2, leaf.fieldType);
    predicates.push(...toPredicatesFor(leaf.field, op2, value2, leaf.fieldType));
  }
  return predicates;
}

interface PartitionedFilter {
  /** Predicates safe to send to the server (it AND-combines them). */
  predicates: FilterPredicate[];
  /** Leaves that must be evaluated client-side to preserve in-memory semantics. */
  clientLeaves: StudioFilterLeaf[];
  /**
   * True when an OR `group` node was encountered. The AND-only wire protocol cannot express
   * it, and the client-side `applyFilters` array form is also AND-combined, so it is dropped
   * with a warning rather than mis-evaluated. Producers only build `logic: 'and'` groups today
   * (`queryDescriptor.filtersToFilterNode`), so this is defensive.
   */
  droppedOrGroup: boolean;
}

/**
 * Split a `StudioFilterNode` into the parts that can be executed faithfully server-side
 * (`predicates`, AND-combined) and the parts that must fall back to client-side evaluation
 * (`clientLeaves`) so the adapter path matches the in-memory evaluator exactly.
 *
 * Was previously an unconditional AND flatten (`flattenFilterNode`) that silently:
 *  - turned an intra-leaf OR into an AND (finding 1.4), and
 *  - dropped any leaf whose operator did not map (finding 1.5).
 *
 * Now:
 *  - AND group → children partitioned recursively (AND distributes, so each child is
 *    independently server- or client-side);
 *  - OR group  → whole group dropped from the request, `droppedOrGroup` flagged (defensive);
 *  - leaf      → server-side when `isLeafServerTranslatable`, else evaluated client-side.
 */
function partitionFilterNode(
  node: StudioFilterNode | undefined,
  onServerLeaf?: (leaf: StudioFilterLeaf) => void,
): PartitionedFilter {
  const result: PartitionedFilter = { predicates: [], clientLeaves: [], droppedOrGroup: false };
  if (!node) {
    return result;
  }
  const visit = (n: StudioFilterNode): void => {
    if (n.type === 'group') {
      if (n.logic === 'or') {
        result.droppedOrGroup = true;
        return;
      }
      n.children.forEach(visit);
      return;
    }
    if (isLeafServerTranslatable(n)) {
      // Surface any NULL-handling drift for leaves we DO push down (finding 2.16a) before
      // emitting the predicate. Date-granularity drift is no longer warned about — it is
      // translated away by `toPredicatesFor` or routed to the residual (finding T1.3b).
      onServerLeaf?.(n);
      result.predicates.push(...leafToPredicates(n));
    } else {
      result.clientLeaves.push(n);
    }
  };
  visit(node);
  return result;
}

/**
 * Convert an un-sendable leaf into a `StudioFilterState` so the shared client evaluator
 * (`filterUtils.applyFilters`) enforces it against the returned rows with identical semantics.
 * The `id` / `scope` fields are unused by the evaluator; only field/operator/value(2) matter.
 */
function leafToClientFilterState(leaf: StudioFilterLeaf): StudioFilterState {
  return {
    id: `_adapter_client_${leaf.field}`,
    field: leaf.field,
    operator: leaf.op,
    value: leaf.value,
    operator2: leaf.op2,
    value2: leaf.value2,
    conjunction: leaf.conjunction,
    fieldType: leaf.fieldType,
    // Preserve the source leaf's authoring mode instead of hardcoding `'condition'`. An empty
    // selection ("any value") arrives as a selection-mode `in []`: in-memory `isFilterComplete`
    // drops it (→ match everything), but a `'condition'` restamp makes `isConditionComplete('in',
    // [])` true and re-applies `in []` as a real predicate that matches NOTHING — inverting the
    // filter and blanking the widget on the adapter path (finding T2.3).
    filterMode: leaf.filterMode ?? 'condition',
  } as unknown as StudioFilterState;
}

/**
 * Resolve the client-side residual of a partitioned filter into the `StudioFilterState[]` to
 * re-apply after fetching, warning (never silently) for anything that cannot be recovered.
 *
 * @param {boolean} aggregated - whether the server will aggregate. When true the returned rows
 *   are pre-aggregated and a raw-field predicate cannot be re-applied, so it is dropped with a
 *   warning instead of a (wrong) client-side pass. Since `decideAggregationPushdown` now gives up
 *   the push-down whenever a RECOVERABLE residual leaf exists, this branch is reached only for
 *   leaves that could not have been re-applied to raw rows either (a filter on an own-source
 *   calculated column, which the raw rows do not carry) — the drop is unavoidable, not a choice.
 * @param {(fieldId: string) => boolean} tryProjectField - ensures the leaf's field will be present (by its logical id) in the
 *   returned raw rows; returns false when the column cannot be projected (e.g. a cross-source
 *   field whose row key would not be the logical id), in which case the leaf is dropped+warned.
 */
function resolveClientResidual(
  partition: PartitionedFilter,
  aggregated: boolean,
  sourceId: string,
  dedupe: Set<string>,
  tryProjectField: (fieldId: string) => boolean,
): StudioFilterState[] | undefined {
  if (partition.droppedOrGroup) {
    warnAdapterDivergence(
      dedupe,
      `An OR filter group could not be executed by the data adapter for source "${sourceId}" ` +
        `and was dropped, so results may include rows the filter should exclude. ` +
        `OR groups work correctly on in-memory sources.`,
    );
  }
  if (partition.clientLeaves.length === 0) {
    return undefined;
  }
  if (aggregated) {
    for (const leaf of partition.clientLeaves) {
      warnAdapterDivergence(
        dedupe,
        `Filter on "${leaf.field}" (operator "${leaf.op}"${
          leaf.conjunction === 'or' ? ' with an OR condition' : ''
        }) cannot be executed by the data adapter for source "${sourceId}", and the widget ` +
          `aggregates server-side, so it cannot be re-applied to the pre-aggregated rows. ` +
          `The filter was dropped for this source; it works correctly on in-memory sources.`,
      );
    }
    return undefined;
  }
  const states: StudioFilterState[] = [];
  for (const leaf of partition.clientLeaves) {
    if (tryProjectField(leaf.field)) {
      states.push(leafToClientFilterState(leaf));
    } else {
      warnAdapterDivergence(
        dedupe,
        `Filter on "${leaf.field}" (operator "${leaf.op}") could not be executed by the data ` +
          `adapter for source "${sourceId}" and its column could not be projected for ` +
          `client-side evaluation, so it was dropped. It works correctly on in-memory sources.`,
      );
    }
  }
  return states.length > 0 ? states : undefined;
}

/**
 * Run the SHARED aggregation push-down ladder (`decideAggregationPushdown`, also used by
 * `createSimpleAdapter`) and translate the surviving specs to the wire shape.
 *
 * Returns `undefined` — i.e. "server returns raw rows, the widget aggregates client-side" — for
 * every case the ladder rejects, warning once per build so the divergence from in-memory behaviour
 * is never silent.
 *
 * @param {(fieldId: string) => string | null} resolveColumn - maps a measure's logical field id to
 *   the physical column to aggregate, or `null` when it has no server-side column at all (an
 *   arithmetic expression field); such a spec is dropped, and the raw inputs come back for the
 *   client to re-derive.
 */
function decideWireAggregations(
  d: StudioQueryDescriptor,
  hasUnpushableFilters: boolean,
  dedupe: Set<string>,
  resolveColumn: (fieldId: string) => string | null,
): AggregationSpec[] | undefined {
  /**
   * Studio's aggregation name → the middleware's `AggregationSpec.func`.
   *
   * Only `count_non_null` differs, and it is the one aggregation whose Studio name and wire
   * name disagree while the SEMANTICS match exactly: the middleware's `count` emits SQL
   * `COUNT(column)`, which is precisely "how many rows had a value" — `count_non_null`. It
   * therefore pushes down faithfully, where Studio's own `count` (`COUNT(*)`, rows including
   * nulls) does NOT and is stripped by `isClientOnlyAggFn` above.
   *
   * Translating here rather than at descriptor-build time is load-bearing: `stripAggregations`
   * runs its client-only check against `descriptor.aggregations[].fn`, so renaming
   * `count_non_null` to `count` any earlier would make that check see Studio's row-count
   * `count` and strip the whole push-down — silently turning a pushable aggregation into a
   * full raw-row fetch.
   */
  const toWireAggFunc = (
    fn: Exclude<AggFn, 'count' | 'count_distinct'>,
  ): AggregationSpec['func'] => (fn === 'count_non_null' ? 'count' : fn);

  const decision = decideAggregationPushdown({ descriptor: d, hasUnpushableFilters });
  if (decision.reason) {
    warnAdapterDivergence(dedupe, aggregationPushdownWarning(d.sourceId, decision.reason));
  }
  if (decision.strip) {
    return undefined;
  }
  const specs = (d.aggregations ?? []).flatMap((a): AggregationSpec[] => {
    // Unreachable: the ladder strips the whole push-down when a client-only function is present.
    // Kept so `func` narrows to the wire enum rather than being cast.
    if (isClientOnlyAggFn(a.fn)) {
      return [];
    }
    const column = resolveColumn(a.field);
    return column === null ? [] : [{ column, func: toWireAggFunc(a.fn), alias: a.alias }];
  });
  // An alias outside the host's identifier charset makes the host reject the ENTIRE widget
  // (`validateAggregationAliases` is fail-closed), so the widget renders an error overlay
  // instead of data. Give up the push-down instead: raw rows come back and the client
  // aggregates them itself, which is slower but produces the same numbers — the same
  // degradation every other unpushable case in this ladder takes. All-or-nothing, mirroring
  // `decideAggregationPushdown`: a half-aggregated response has no shape the client can read.
  const unsafeAlias = specs.find((spec) => !SAFE_WIRE_ALIAS.test(spec.alias));
  if (unsafeAlias) {
    warnAdapterDivergence(
      dedupe,
      `The aggregation alias "${unsafeAlias.alias}" for source "${d.sourceId}" contains ` +
        `characters outside the identifier charset the data adapter's query protocol allows ` +
        `(letters, digits, underscores and hyphens), so the aggregation could not be pushed ` +
        `down and raw rows were fetched instead. The widget shows the same values; rename the ` +
        `field id to a plain identifier to restore server-side aggregation.`,
    );
    return undefined;
  }
  return specs.length > 0 ? specs : undefined;
}
