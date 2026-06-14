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
  StudioQueryDescriptor,
  StudioQueryResult,
  StudioRelationship,
} from '../models';
import { isRelativeDateValue, resolveRelativeDate } from '../internals/filterUtils';

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

/** Registry of loaders — one per endpoint URL */
const loaderRegistry = new Map<string, BatchLoader<StudioQueryDescriptor, StudioQueryResult>>();

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
  } = options;

  function createBatchFn(): BatchFn<StudioQueryDescriptor, StudioQueryResult> {
    return async (descriptors) => {
      const builtDescriptors = descriptors.map((d) =>
        buildBatchWidgetDescriptor(d, dataSources, relationships, expressionFields),
      );

      const body = {
        pageId: descriptors[0]?.sourceId ?? 'unknown',
        widgets: builtDescriptors.map((b) => b.requestBody),
      };

      const response = await fetchFn(endpoint, {
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
          const result = json.results.find((r) => r.id === d.widgetId);
          if (!result) {
            return new Error(`Studio batch response missing result for widget "${d.widgetId}"`);
          }
          if (result.error) {
            return new Error(result.error);
          }

          const { crossEndpointEnrichments } = builtDescriptors[i];
          if (crossEndpointEnrichments.length === 0) {
            return { rows: result.rows };
          }

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
    loader = createLoader(createBatchFn(), (cb) => setTimeout(cb, batchDelayMs));
  } else {
    // Simple mode: use shared registry so multiple adapter instances pointing
    // at the same endpoint share one DataLoader (batching still works across instances).
    if (!loaderRegistry.has(endpoint)) {
      loaderRegistry.set(
        endpoint,
        createLoader(createBatchFn(), (cb) => setTimeout(cb, batchDelayMs)),
      );
    }
    loader = loaderRegistry.get(endpoint)!;
  }

  const adapter: StudioDataSourceAdapter = {
    getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult> {
      return loader.load(descriptor);
    },
  };
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
   *  The column is passed through as-is for SELECT (backward-compat) but MUST be dropped from
   *  WHERE clauses to avoid "no such column" SQL errors. */
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
 *    should DROP this field from WHERE clauses (to avoid "no such column" SQL errors) but MAY
 *    pass it through in SELECT for backward compatibility.
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

  // ── Simple mode (no relationship info) ────────────────────────────────────
  if (!dataSources || !relationships) {
    // Include all select fields (both group-by and aggregate-source fields) so
    // client/server-tier raw rows contain the measure columns Studio needs for
    // client-side aggregation. The db-tier query builder excludes aggregate
    // fields from groupBy via aggregations[*].column.
    const columns = d.select;
    const aggregations: AggregationSpec[] | undefined =
      d.aggregations && d.aggregations.length > 0
        ? d.aggregations.map((a) => ({
            column: a.field,
            func: a.fn === 'count_distinct' ? ('count' as const) : a.fn,
            alias: a.alias,
          }))
        : undefined;

    return {
      requestBody: {
        id: d.widgetId,
        table: tableName,
        columns,
        aggregations,
        filters: d.filter ? flattenFilterNode(d.filter) : undefined,
        orderBy: d.groupBy ? [{ column: d.groupBy, direction: 'asc' as const }] : undefined,
      },
      crossEndpointEnrichments: [],
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
  // expressions. Including aggregate fields ensures client/server-tier raw rows contain the
  // measure columns Studio needs for client-side aggregation. For db-tier, executeForTier
  // filters out aggregate fields from the GROUP BY using aggregations[*].column.
  const columns = d.select.flatMap((fieldId) => {
    const r = resolve(fieldId);
    return r.skip ? [] : [r.column];
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
    const aggs = (d.aggregations ?? []).flatMap((a) => {
      const r = resolve(a.field);
      if (r.skip) {
        return [];
      }
      return [
        {
          column: r.column,
          func: a.fn === 'count_distinct' ? ('count' as const) : a.fn,
          alias: a.alias,
        },
      ];
    });
    return aggs.length > 0 ? aggs : undefined;
  })();

  // Filters — resolve cross-source filter column references, and use the physical
  // column name (not the logical alias) so the server WHERE clause references a real column.
  // Filters whose field cannot be resolved to any column in this source (unresolved: true)
  // are silently dropped — applying them would produce "no such column" SQL errors.
  const rawFilters = d.filter ? flattenFilterNode(d.filter) : [];
  const filters = rawFilters.flatMap((pred) => {
    const r = resolve(pred.column);
    if (r.skip || r.unresolved) {
      return [];
    }
    // columnAliases maps logical ID → physical column (e.g. 'expr-order-country' → 'customers.country').
    // WHERE clauses must reference the physical column; the alias is only used in SELECT.
    const physicalColumn = columnAliases[r.column] ?? r.column;
    return [{ ...pred, column: physicalColumn }];
  });

  // ORDER BY — use physical column for expression fields (server sees physical name).
  // When groupBy is cross-endpoint, orderBy is already suppressed via groupByIsCrossEndpoint.
  const orderByColumn = groupByIsCrossEndpoint ? undefined : groupByResolved;

  return {
    requestBody: {
      id: d.widgetId,
      table: tableName,
      columns: columns.length > 0 ? columns : undefined,
      columnAliases: Object.keys(columnAliases).length > 0 ? columnAliases : undefined,
      joins: joinsMap.size > 0 ? [...joinsMap.values()] : undefined,
      aggregations,
      filters: filters.length > 0 ? filters : undefined,
      orderBy:
        orderByColumn && !orderByColumn.skip
          ? [
              {
                column: columnAliases[orderByColumn.column] ?? orderByColumn.column,
                direction: 'asc' as const,
              },
            ]
          : undefined,
    },
    crossEndpointEnrichments: enrichments,
  };
}

const OPERATOR_MAP: Partial<Record<StudioFilterOperator, FilterPredicate['operator']>> = {
  equals: 'eq',
  not_equals: 'neq',
  in: 'in',
  greater_than: 'gt',
  less_than: 'lt',
  greater_than_or_equal: 'gte',
  less_than_or_equal: 'lte',
  contains: 'like',
  between: 'between',
};

function mapOperator(op: StudioFilterOperator): FilterPredicate['operator'] | null {
  return OPERATOR_MAP[op] ?? null;
}

/**
 * Flatten a StudioFilterNode tree into an array of FilterPredicates.
 * Group nodes are flattened (AND logic only — OR groups are skipped server-side
 * and will fall back to showing all rows, which is safe/conservative).
 */
function flattenFilterNode(node: StudioFilterNode): FilterPredicate[] {
  if (node.type === 'group') {
    return node.children.flatMap(flattenFilterNode);
  }
  const operator = mapOperator(node.op);
  if (!operator) {
    return [];
  }
  const value = isRelativeDateValue(node.value) ? resolveRelativeDate(node.value) : node.value;
  const predicate: FilterPredicate = { column: node.field, operator, value };
  const predicates: FilterPredicate[] = [predicate];
  // Handle range (op2 / value2) — e.g. date-range filter emits between with two bounds
  if (node.op2 && node.value2 !== undefined) {
    const op2 = mapOperator(node.op2);
    if (op2) {
      const value2 = isRelativeDateValue(node.value2)
        ? resolveRelativeDate(node.value2)
        : node.value2;
      predicates.push({ column: node.field, operator: op2, value: value2 });
    }
  }
  return predicates;
}
