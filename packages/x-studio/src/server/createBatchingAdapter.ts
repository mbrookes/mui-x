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
import { applyFilters, isRelativeDateValue, resolveRelativeDate } from '../internals/filterUtils';

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
 * Mutable per-endpoint config the shared simple-mode loader reads on every batch dispatch.
 * Keeping `fetchFn` / `batchDelayMs` behind a live reference (rather than baking them into the
 * loader's closure at creation time) lets a recreated adapter refresh them — e.g. a rotated auth
 * token in a new `fetchFn` — instead of silently pinning the FIRST adapter instance's closure
 * forever (finding 3.14).
 */
interface LoaderRegistryEntry {
  loader: BatchLoader<StudioQueryDescriptor, StudioQueryResult>;
  config: { fetchFn: typeof fetch; batchDelayMs: number };
}

/** Registry of simple-mode loaders — one per endpoint URL, with a refreshable config. */
const loaderRegistry = new Map<string, LoaderRegistryEntry>();

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

  // `getFetch` is read on every dispatch so a shared simple-mode loader always uses the LATEST
  // adapter instance's fetch (finding 3.14). Relationship-aware mode passes its own instance
  // `fetchFn` directly (dedicated loader — no staleness possible).
  function createBatchFn(
    getFetch: () => typeof fetch,
  ): BatchFn<StudioQueryDescriptor, StudioQueryResult> {
    return async (descriptors) => {
      const builtDescriptors = descriptors.map((d) =>
        buildBatchWidgetDescriptor(d, dataSources, relationships, expressionFields),
      );

      const body = {
        pageId: descriptors[0]?.sourceId ?? 'unknown',
        widgets: builtDescriptors.map((b) => b.requestBody),
      };

      const response = await getFetch()(endpoint, {
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

      // Build a lookup map of enrichment results: joinSourceId → (pkValue → joinFieldValues).
      // We fetch each unique join source only once and share the lookup across all descriptors.
      const enrichmentLookups = new Map<string, Promise<Map<unknown, Record<string, unknown>>>>();

      function getEnrichmentLookup(
        joinSourceId: string,
        joinPkField: string,
      ): Promise<Map<unknown, Record<string, unknown>>> {
        const cacheKey = `${joinSourceId}:${joinPkField}`;
        if (!enrichmentLookups.has(cacheKey)) {
          const joinSource = dataSources?.[joinSourceId];
          if (!joinSource?.adapter) {
            enrichmentLookups.set(cacheKey, Promise.resolve(new Map()));
          } else {
            const tableName = joinSource.tableName ?? joinSourceId;
            const lookupDescriptor: StudioQueryDescriptor = {
              sourceId: joinSourceId,
              tableName,
              widgetId: `_xjoin_${joinSourceId}`,
              select: joinSource.fields.map((f) => f.id),
              cacheKey: `_xjoin:${joinSourceId}`,
            };
            const promise = joinSource.adapter
              .getRows(lookupDescriptor)
              .then((result) => {
                const lookup = new Map<unknown, Record<string, unknown>>();
                for (const row of result.rows) {
                  const pkVal = row[joinPkField];
                  if (pkVal != null && !lookup.has(pkVal)) {
                    lookup.set(pkVal, row as Record<string, unknown>);
                  }
                }
                return lookup;
              })
              .catch(() => new Map<unknown, Record<string, unknown>>());
            enrichmentLookups.set(cacheKey, promise);
          }
        }
        return enrichmentLookups.get(cacheKey)!;
      }

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
            const lookup = await getEnrichmentLookup(enr.joinSourceId, enr.joinPkField);
            if (lookup.size === 0) {
              continue;
            }
            rows = rows.map((row) => {
              if (enr.logicalFieldId in row) {
                return row; // Already set — don't overwrite (consistent with enrichRowsWithExpressions)
              }
              const fkValue = row[enr.fkField];
              const joinRow = fkValue != null ? lookup.get(fkValue) : undefined;
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
    };
  }

  // Warn in dev when relationships span different endpoints (cross-DB JOINs won't work).
  if (dataSources && relationships) {
    warnOnCrossEndpointRelationships(dataSources, relationships);
  }

  let loader: BatchLoader<StudioQueryDescriptor, StudioQueryResult>;
  if (dataSources) {
    // Relationship-aware mode: create a dedicated loader that captures the
    // dataSources/relationships closure. Don't use the shared registry because
    // the resolver is specific to this adapter instance's state snapshot.
    loader = createLoader(
      createBatchFn(() => fetchFn),
      (cb) => setTimeout(cb, batchDelayMs),
    );
  } else {
    // Simple mode: use shared registry so multiple adapter instances pointing
    // at the same endpoint share one DataLoader (batching still works across instances).
    let entry = loaderRegistry.get(endpoint);
    if (!entry) {
      const config = { fetchFn, batchDelayMs };
      entry = {
        // Both the batch fn and the schedule fn read the live `config`, so a later adapter
        // recreated at the same endpoint (e.g. rotated token) is honoured (finding 3.14).
        loader: createLoader(
          createBatchFn(() => config.fetchFn),
          (cb) => setTimeout(cb, config.batchDelayMs),
        ),
        config,
      };
      loaderRegistry.set(endpoint, entry);
    } else {
      // Refresh the shared loader's config instead of pinning the first instance's closure.
      entry.config.fetchFn = fetchFn;
      entry.config.batchDelayMs = batchDelayMs;
    }
    loader = entry.loader;
  }

  const adapter: StudioDataSourceAdapter = {
    getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult> {
      return loader.load(descriptor);
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
              leftCol = `${joinTable}.${rel.sourceField}`;
              rightCol = `${primaryTableName}.${rel.targetField}`;
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
          if (hop1Rel.sourceId === primarySourceId && hop1Rel.targetId === exprSourceId) {
            hop1Left = `${primaryTableName}.${hop1Rel.sourceField}`;
            hop1Right = `${exprTable}.${hop1Rel.targetField}`;
          } else if (hop1Rel.targetId === primarySourceId && hop1Rel.sourceId === exprSourceId) {
            hop1Left = `${exprTable}.${hop1Rel.sourceField}`;
            hop1Right = `${primaryTableName}.${hop1Rel.targetField}`;
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
                if (hop2Rel.sourceId === exprSourceId && hop2Rel.targetId === joinSourceId) {
                  hop2Left = `${exprTable}.${hop2Rel.sourceField}`;
                  hop2Right = `${joinTable}.${hop2Rel.targetField}`;
                } else if (hop2Rel.targetId === exprSourceId && hop2Rel.sourceId === joinSourceId) {
                  hop2Left = `${joinTable}.${hop2Rel.sourceField}`;
                  hop2Right = `${exprTable}.${hop2Rel.targetField}`;
                }
                if (!hop2Left) {
                  continue;
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
      leftCol = `${relatedTable}.${rel.sourceField}`;
      rightCol = `${primaryTableName}.${rel.targetField}`;
    }

    if (relatedSourceId !== null) {
      const relatedSource = dataSources[relatedSourceId];
      if (relatedSource?.fields.some((f) => f.id === fieldId)) {
        const relatedTable = relatedSource.tableName ?? relatedSourceId;
        return {
          column: `${relatedTable}.${fieldId}`,
          joins: [{ table: relatedTable, type: 'left', on: [[leftCol, rightCol]] }],
        };
      }
    }
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
    // A `count` aggregation is routed client-side (2.16d): the wire protocol's count becomes
    // SQL `COUNT(column)` (skips NULL measures), but Studio's count means row-count including
    // nulls (COUNT(*) semantics, matching KPI/chart/grid). We can't express COUNT(*) on the wire
    // without editing the middleware, so we return raw rows (aggregations stripped) and let the
    // widget aggregate client-side — exactly like the cross-endpoint-groupBy path already does.
    // `columns` already carries every select field (group-by + measure), so raw rows are complete.
    let aggregations: AggregationSpec[] | undefined;
    if (hasCountAggregation(d.aggregations)) {
      warnCountRoutedClientSide(d.sourceId, warnDedupe);
      aggregations = undefined;
    } else if (d.aggregations && d.aggregations.length > 0) {
      aggregations = d.aggregations.map((a) => ({
        column: a.field,
        // count_distinct has no wire equivalent → downgraded to count with a warning (2.11).
        func: mapAggFn(a.fn, d.sourceId, warnDedupe),
        alias: a.alias,
      }));
    } else {
      aggregations = undefined;
    }

    // Split the filter into server-executable predicates and a client-side residual
    // (OR conditions / unmappable operators) so neither is silently mistranslated (1.4 / 1.5).
    // Leaves we DO push down are checked for null/date divergence via warnServerLeafDivergence
    // (finding 2.16 a/b).
    const partition = partitionFilterNode(d.filter, (leaf) =>
      warnServerLeafDivergence(leaf, d.sourceId, warnDedupe),
    );
    const clientFilter = resolveClientResidual(
      partition,
      Boolean(aggregations),
      d.sourceId,
      warnDedupe,
      (fieldId) => {
        if (!columns.includes(fieldId)) {
          columns.push(fieldId);
        }
        return true;
      },
    );

    return {
      requestBody: {
        id: batchEntryId(d),
        table: tableName,
        columns,
        aggregations,
        filters: partition.predicates.length > 0 ? partition.predicates : undefined,
        orderBy: d.groupBy ? [{ column: d.groupBy, direction: 'asc' as const }] : undefined,
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

  function resolve(fieldId: string): { column: string; skip?: boolean; unresolved?: boolean } {
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
    return { column: resolved.column, skip: resolved.skip, unresolved: resolved.unresolved };
  }

  // SELECT all fields (group-by AND aggregate-source fields), skipping server-incompatible
  // expressions and fields that cannot be resolved to any column in the primary or related
  // sources. Including aggregate fields ensures client/server-tier raw rows contain the
  // measure columns Studio needs for client-side aggregation. For db-tier, executeForTier
  // filters out aggregate fields from the GROUP BY using aggregations[*].column.
  const columns = d.select.flatMap((fieldId) => {
    const r = resolve(fieldId);
    return r.skip || r.unresolved ? [] : [r.column];
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

  // Aggregations — skip expression fields that can't be aggregated server-side.
  // When the groupBy field is cross-endpoint, strip ALL aggregations so the server
  // returns raw rows (with FK column) that the client can enrich and then aggregate.
  const aggregations: AggregationSpec[] | undefined = (() => {
    if (groupByIsCrossEndpoint) {
      // Can't group server-side — return raw rows for client-side enrichment + aggregation.
      return undefined;
    }
    // A `count` aggregation is routed client-side (2.16d) — SQL COUNT(column) skips NULLs while
    // Studio counts every row (COUNT(*) semantics). Strip ALL aggregations so the server returns
    // raw rows the widget can count client-side (the select columns already carry the measures).
    if (hasCountAggregation(d.aggregations)) {
      warnCountRoutedClientSide(d.sourceId, warnDedupe);
      return undefined;
    }
    const aggs = (d.aggregations ?? []).flatMap((a) => {
      const r = resolve(a.field);
      if (r.skip) {
        return [];
      }
      return [
        {
          column: r.column,
          // count_distinct has no wire equivalent → downgraded to count with a warning (2.11).
          func: mapAggFn(a.fn, d.sourceId, warnDedupe),
          alias: a.alias,
        },
      ];
    });
    return aggs.length > 0 ? aggs : undefined;
  })();

  // Filters — split into server-executable predicates and a client-side residual (OR
  // conditions / unmappable operators, findings 1.4 / 1.5), then resolve the server predicates'
  // cross-source column references, using the physical column name (not the logical alias) so
  // the server WHERE clause references a real column. Predicates whose field cannot be resolved
  // to any column in this source (unresolved: true) are dropped — applying them would produce
  // "no such column" SQL errors.
  const partition = partitionFilterNode(d.filter, (leaf) =>
    warnServerLeafDivergence(leaf, d.sourceId, warnDedupe),
  );
  const filters = partition.predicates.flatMap((pred) => {
    const r = resolve(pred.column);
    if (r.skip || r.unresolved) {
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
  // aliased/physical key, so those are dropped with a warning instead. The primary/expression
  // membership check is deliberately side-effect-free (unlike `resolve`, which would register a
  // spurious JOIN for a cross-source field before we reject it).
  const clientFilter = resolveClientResidual(
    partition,
    Boolean(aggregations),
    d.sourceId,
    warnDedupe,
    (fieldId) => {
      const isExpressionField = expressionFields?.some((f) => f.id === fieldId) ?? false;
      const isPlainPrimaryField =
        !isExpressionField &&
        Boolean(dataSources[d.sourceId]?.fields.some((f) => f.id === fieldId));
      if (!isPlainPrimaryField) {
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
  // eslint-disable-next-line no-console
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
  if (Array.isArray(value)) {
    return value.length === 2 && Boolean(value[0]) && Boolean(value[1]);
  }
  const range = value as { from?: unknown; to?: unknown };
  return Boolean(range.from) && Boolean(range.to);
}

/**
 * True when a single (op, value) pair can be sent to the server with EXACTLY the same semantics
 * as the in-memory evaluator. Beyond the operator mapping, two value-shaped cases must stay
 * client-side because their wire translation inverts or corrupts the in-memory result:
 *  - an empty `in` array matches NOTHING in-memory (`filterVal.some(...)` over `[]`), but the
 *    middleware DROPS an empty-`in` predicate on reads — matching EVERYTHING (finding 2.16c);
 *  - an open-ended `between` (only one bound set) is unbounded in-memory but becomes a
 *    malformed two-arg `whereBetween` on the wire (finding 2.15).
 */
function isOpValueServerTranslatable(op: StudioFilterOperator, value: unknown): boolean {
  if (mapOperator(op) === null) {
    return false;
  }
  if (op === 'in' && Array.isArray(value) && value.length === 0) {
    return false;
  }
  if (op === 'between' && !isFullyBoundedBetween(value)) {
    return false;
  }
  return true;
}

/**
 * True when a leaf can be sent to the server with EXACTLY the same semantics as the in-memory
 * evaluator: its operator(s) + value(s) map to the wire protocol AND, when it carries a second
 * condition, the two are AND-combined (the wire protocol ANDs every predicate and has no OR).
 */
function isLeafServerTranslatable(leaf: StudioFilterLeaf): boolean {
  if (!isOpValueServerTranslatable(leaf.op, leaf.value)) {
    return false;
  }
  const hasSecondCondition = leaf.op2 !== undefined && leaf.value2 !== undefined;
  if (!hasSecondCondition) {
    return true;
  }
  // A second condition combined with OR ("x < 5 OR x > 100") cannot be expressed as two
  // AND-ed predicates — the server would AND them and return zero rows (finding 1.4).
  if (leaf.conjunction === 'or') {
    return false;
  }
  return isOpValueServerTranslatable(leaf.op2!, leaf.value2);
}

/**
 * Warn (once per widget-descriptor build) about the null-handling / date-normalization drift of
 * a leaf that IS pushed to the server but whose semantics differ subtly from the in-memory
 * evaluator (finding 2.16 a/b). Unlike the operators routed to the client residual, these stay
 * server-side because their pushdown is essential (`not_equals`, date range bounds are common,
 * high-selectivity filters and routing them client-side would defeat the query pushdown and, for
 * aggregated widgets, drop the filter entirely). The divergence is surfaced loudly instead of
 * silently:
 *  - `not_equals` (any type): SQL three-valued logic excludes NULL rows server-side, but the
 *    in-memory evaluator KEEPS them (`row[field] != value` is true for null).
 *  - `equals` on a `date`/`datetime` field: the server compares the raw column to a bare
 *    `'YYYY-MM-DD'` string while in-memory normalizes both sides — so an equality against a
 *    DATETIME/timestamp column can match zero rows server-side yet match that day in-memory.
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
  const isDateField = leaf.fieldType === 'date' || leaf.fieldType === 'datetime';
  if (isDateField && (leaf.op === 'equals' || leaf.op2 === 'equals')) {
    warnAdapterDivergence(
      dedupe,
      `An "equals" filter on the ${leaf.fieldType} field "${leaf.field}" for source "${sourceId}" ` +
        `compares raw column values server-side but normalized values in-memory. On a ` +
        `DATETIME/timestamp column an equality against a plain date can match zero rows ` +
        `server-side while matching that day's rows in-memory. Use a "between" range instead.`,
    );
  }
}

/**
 * Emit the server FilterPredicate(s) for a server-translatable leaf. Mirrors the historical
 * `flattenFilterNode` leaf branch, including the `{ from, to }` → `[lo, hi]` `between`
 * conversion and the AND-combined second condition (`op2` / `value2`).
 */
function leafToPredicates(leaf: StudioFilterLeaf): FilterPredicate[] {
  const operator = mapOperator(leaf.op)!;
  let value = isRelativeDateValue(leaf.value) ? resolveRelativeDate(leaf.value) : leaf.value;
  // setDashboardDateRange / setWidgetDateRange store between values as { from, to } objects.
  // Convert to the [lo, hi] tuple that the server's queryBuilder expects.
  if (
    operator === 'between' &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const range = value as { from?: unknown; to?: unknown };
    value = [range.from, range.to] as unknown;
  }
  const predicates: FilterPredicate[] = [{ column: leaf.field, operator, value }];
  // Handle range (op2 / value2) — e.g. date-range filter emits between with two bounds.
  if (leaf.op2 && leaf.value2 !== undefined) {
    const op2 = mapOperator(leaf.op2)!;
    const value2 = isRelativeDateValue(leaf.value2)
      ? resolveRelativeDate(leaf.value2)
      : leaf.value2;
    predicates.push({ column: leaf.field, operator: op2, value: value2 });
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
      // Surface any null-handling / date-normalization drift for leaves we DO push down
      // (finding 2.16 a/b) before emitting the predicate.
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
    filterMode: 'condition',
  } as unknown as StudioFilterState;
}

/**
 * Resolve the client-side residual of a partitioned filter into the `StudioFilterState[]` to
 * re-apply after fetching, warning (never silently) for anything that cannot be recovered.
 *
 * @param aggregated - whether the server will aggregate. When true the returned rows are
 *   pre-aggregated and a raw-field predicate cannot be re-applied, so it is dropped with a
 *   warning instead of a (wrong) client-side pass.
 * @param tryProjectField - ensures the leaf's field will be present (by its logical id) in the
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
 * True when any aggregation uses `count`. A `count` aggregation is deliberately NOT pushed to the
 * server (finding 2.16d): the wire protocol's `count` becomes SQL `COUNT(column)`, which skips
 * rows whose measure value is NULL, whereas Studio's `count` means row-count including nulls
 * (`COUNT(*)` semantics — the policy the KPI / chart / grid client aggregators follow). Since the
 * wire protocol cannot express `COUNT(*)` and the middleware is owned elsewhere, count-aggregated
 * queries are routed through the raw-rows-then-client-aggregate path instead.
 */
function hasCountAggregation(aggregations: StudioQueryDescriptor['aggregations']): boolean {
  return (aggregations ?? []).some((a) => a.fn === 'count');
}

/** Warn (once per build) that a `count` aggregation was routed client-side (finding 2.16d). */
function warnCountRoutedClientSide(sourceId: string, dedupe: Set<string>): void {
  warnAdapterDivergence(
    dedupe,
    `A "count" aggregation for source "${sourceId}" was computed client-side instead of pushed ` +
      `to the data adapter: the adapter's SQL count skips rows with a NULL measure value, while ` +
      `Studio counts every row (COUNT(*) semantics, consistent with in-memory sources). Raw rows ` +
      `are fetched for this widget and aggregated client-side.`,
  );
}

/**
 * Map an aggregation function to its wire form, warning once when `count_distinct` is
 * downgraded to a plain `count` (finding 2.11): the wire protocol has no DISTINCT aggregation,
 * so a "distinct count of X" would otherwise silently render the TOTAL row count on a db-tier
 * source. In-memory sources are unaffected.
 */
function mapAggFn(
  fn: NonNullable<StudioQueryDescriptor['aggregations']>[number]['fn'],
  sourceId: string,
  dedupe: Set<string>,
): AggregationSpec['func'] {
  if (fn === 'count_distinct') {
    warnAdapterDivergence(
      dedupe,
      `count_distinct is not supported by the data adapter's query protocol for source ` +
        `"${sourceId}" and was executed as a plain count (total rows, not distinct values). ` +
        `Distinct counts work correctly on in-memory sources.`,
    );
    return 'count';
  }
  return fn;
}
