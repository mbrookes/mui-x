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
  StudioDataSourceAdapter,
  StudioFilterNode,
  StudioFilterOperator,
  StudioQueryDescriptor,
  StudioQueryResult,
} from '../models';

/** Structured filter predicate sent to the server (mirrors FilterPredicate in @mui/x-studio-data-middleware) */
interface FilterPredicate {
  column: string;
  operator: 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'between';
  value?: unknown;
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
  const { batchDelayMs = 50, fetchFn = globalThis.fetch } = options;

  // Get or create the shared loader for this endpoint
  if (!loaderRegistry.has(endpoint)) {
    const loader = createLoader<StudioQueryDescriptor, StudioQueryResult>(
      async (descriptors) => {
        const body = {
          pageId: descriptors[0]?.sourceId ?? 'unknown',
          widgets: descriptors.map((d) => {
            // Encode aggregated columns using the server's prefix convention:
            // e.g. { field: 'revenue', fn: 'sum' } → 'sum_revenue'
            let columns: string[];
            if (d.aggregations?.length && d.groupBy) {
              const aggFieldIds = new Set(d.aggregations.map((a) => a.field));
              columns = d.select.map((fieldId) => {
                if (aggFieldIds.has(fieldId)) {
                  const agg = d.aggregations!.find((a) => a.field === fieldId)!;
                  const prefix = agg.fn === 'count_distinct' ? 'count_' : `${agg.fn}_`;
                  return `${prefix}${fieldId}`;
                }
                return fieldId;
              });
            } else {
              columns = d.select;
            }

            return {
              id: d.widgetId,
              table: d.sourceId,
              columns,
              filters: d.filter ? flattenFilterNode(d.filter) : undefined,
              orderBy: d.groupBy ? [{ column: d.groupBy, direction: 'asc' as const }] : undefined,
              limit: undefined,
            };
          }),
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
      },
      (cb) => setTimeout(cb, batchDelayMs),
    );

    loaderRegistry.set(endpoint, loader);
  }

  return {
    getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult> {
      return loaderRegistry.get(endpoint)!.load(descriptor);
    },
  };
}

/**
 * Lookup table from Studio filter operators to batch protocol operators.
 * Operators absent from this map are not supported by the batch protocol.
 */
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
  const predicate: FilterPredicate = { column: node.field, operator, value: node.value };
  const predicates: FilterPredicate[] = [predicate];
  // Handle range (op2 / value2) — e.g. date-range filter emits between with two bounds
  if (node.op2 && node.value2 !== undefined) {
    const op2 = mapOperator(node.op2);
    if (op2) {
      predicates.push({ column: node.field, operator: op2, value: node.value2 });
    }
  }
  return predicates;
}
