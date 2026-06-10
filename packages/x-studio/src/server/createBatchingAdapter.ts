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
  const { batchDelayMs = 50, fetchFn = globalThis.fetch, dataSources, relationships } = options;

  function createBatchFn(): BatchFn<StudioQueryDescriptor, StudioQueryResult> {
    return async (descriptors) => {
      const body = {
        pageId: descriptors[0]?.sourceId ?? 'unknown',
        widgets: descriptors.map((d) => buildBatchWidgetDescriptor(d, dataSources, relationships)),
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

      // DataLoader invariant: results must be same length and same order as keys
      return descriptors.map((d) => {
        const result = json.results.find((r) => r.id === d.widgetId);
        if (!result) {
          return new Error(`Studio batch response missing result for widget "${d.widgetId}"`);
        }
        if (result.error) {
          return new Error(result.error);
        }
        return { rows: result.rows };
      });
    };
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
      loaderRegistry.set(endpoint, createLoader(createBatchFn(), (cb) => setTimeout(cb, batchDelayMs)));
    }
    loader = loaderRegistry.get(endpoint)!;
  }

  return {
    getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult> {
      return loader.load(descriptor);
    },
  };
}

// ── Cross-source field resolution ───────────────────────────────────────────

/** Internal JOIN descriptor matching the shape expected by x-studio-data-middleware */
interface JoinDescriptorInternal {
  table: string;
  type: 'left';
  on: [string, string][];
}

/**
 * Resolve a field ID to the correct SQL column reference for a query against
 * `primarySourceId`. When the field belongs to a directly related source, returns
 * a qualified `"relatedTable"."field"` column name and the JOIN descriptor needed
 * to reach that table from the primary table.
 *
 * Only `many-to-one` and `one-to-one` relationships are traversed (one hop).
 * Fields not found in any related source are returned as-is (unqualified).
 */
function resolveField(
  fieldId: string,
  primarySourceId: string,
  primaryTableName: string,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
): { column: string; join?: JoinDescriptorInternal } {
  const primarySource = dataSources[primarySourceId];

  // If we don't know the primary source's fields, or the field is in it, use as-is
  if (!primarySource || primarySource.fields.some((f) => f.id === fieldId)) {
    return { column: fieldId };
  }

  // Walk all direct (non-many-to-many) relationships to find a related source
  // that owns this field, then emit a LEFT JOIN.
  for (const rel of relationships) {
    if (rel.type === 'many-to-many') {
      continue;
    }

    let relatedSourceId: string | null = null;
    let leftCol = '';
    let rightCol = '';

    if (rel.sourceId === primarySourceId) {
      // Primary table holds the FK: primary.sourceField = related.targetField
      const relatedSource = dataSources[rel.targetId];
      if (!relatedSource) {
        continue;
      }
      relatedSourceId = rel.targetId;
      const relatedTable = relatedSource.tableName ?? rel.targetId;
      leftCol = `${primaryTableName}.${rel.sourceField}`;
      rightCol = `${relatedTable}.${rel.targetField}`;
    } else if (rel.targetId === primarySourceId) {
      // Related table holds the FK: related.sourceField = primary.targetField
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
          join: { table: relatedTable, type: 'left', on: [[leftCol, rightCol]] },
        };
      }
    }
  }

  // Field not found in any related source — pass through unqualified
  return { column: fieldId };
}

/**
 * Build the `BatchWidgetDescriptor` object to send to the server for one widget.
 *
 * When `dataSources` and `relationships` are provided, any field referenced by the
 * widget that does not belong to the widget's primary source is resolved to its
 * owning table and a LEFT JOIN descriptor is generated automatically.
 */
function buildBatchWidgetDescriptor(
  d: StudioQueryDescriptor,
  dataSources: Record<string, StudioDataSource> | undefined,
  relationships: StudioRelationship[] | undefined,
): object {
  const tableName = d.tableName ?? d.sourceId;
  const aggFieldIds = new Set((d.aggregations ?? []).map((a) => a.field));

  // ── Simple mode (no relationship info) ────────────────────────────────────
  if (!dataSources || !relationships) {
    const columns = d.select.filter((fieldId) => !aggFieldIds.has(fieldId));
    const aggregations: AggregationSpec[] | undefined =
      d.aggregations && d.aggregations.length > 0
        ? d.aggregations.map((a) => ({
            column: a.field,
            func: a.fn === 'count_distinct' ? ('count' as const) : a.fn,
            alias: a.alias,
          }))
        : undefined;

    return {
      id: d.widgetId,
      table: tableName,
      columns,
      aggregations,
      filters: d.filter ? flattenFilterNode(d.filter) : undefined,
      orderBy: d.groupBy ? [{ column: d.groupBy, direction: 'asc' as const }] : undefined,
    };
  }

  // ── Relationship-aware mode ────────────────────────────────────────────────
  // Track joins added so far (keyed by joined table name to deduplicate).
  const joinsMap = new Map<string, JoinDescriptorInternal>();

  function resolve(fieldId: string): string {
    const resolved = resolveField(fieldId, d.sourceId, tableName, dataSources!, relationships!);
    if (resolved.join && !joinsMap.has(resolved.join.table)) {
      joinsMap.set(resolved.join.table, resolved.join);
    }
    return resolved.column;
  }

  // SELECT columns (non-aggregated fields)
  const columns = d.select.filter((fieldId) => !aggFieldIds.has(fieldId)).map(resolve);

  // Aggregations
  const aggregations: AggregationSpec[] | undefined =
    d.aggregations && d.aggregations.length > 0
      ? d.aggregations.map((a) => ({
          column: resolve(a.field),
          func: a.fn === 'count_distinct' ? ('count' as const) : a.fn,
          alias: a.alias,
        }))
      : undefined;

  // Filters — also resolve cross-source filter column references
  const rawFilters = d.filter ? flattenFilterNode(d.filter) : [];
  const filters = rawFilters.map((pred) => ({ ...pred, column: resolve(pred.column) }));

  // ORDER BY
  const orderByColumn = d.groupBy ? resolve(d.groupBy) : undefined;

  return {
    id: d.widgetId,
    table: tableName,
    columns,
    joins: joinsMap.size > 0 ? [...joinsMap.values()] : undefined,
    aggregations,
    filters: filters.length > 0 ? filters : undefined,
    orderBy: orderByColumn ? [{ column: orderByColumn, direction: 'asc' as const }] : undefined,
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
