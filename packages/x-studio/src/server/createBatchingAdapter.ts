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
import type { StudioDataSourceAdapter, StudioQueryDescriptor, StudioQueryResult } from '../models/studio';

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
  let batch: { key: K; resolve: (v: V) => void; reject: (e: Error) => void }[] = [];
  let scheduled = false;

  function dispatch() {
    const currentBatch = batch;
    batch = [];
    scheduled = false;

    batchFn(currentBatch.map((b) => b.key)).then(
      (results) => {
        for (let i = 0; i < currentBatch.length; i++) {
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
const loaderRegistry = new Map<
  string,
  BatchLoader<StudioQueryDescriptor, StudioQueryResult>
>();

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
          widgets: descriptors.map((d) => ({
            id: d.widgetId,
            table: d.sourceId,
            columns: d.select,
            filters: d.filter ? [flattenFilterNode(d.filter)] : undefined,
            orderBy: undefined,
            limit: undefined,
          })),
        };

        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const err = new Error(`Studio batch request failed: ${response.status} ${response.statusText}`);
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
 * Flatten a StudioFilterNode into a simple predicate for the batch request.
 * Production adapters should map the full filter tree to structured predicates.
 * This stub passes through the filter node as-is for initial wiring.
 */
function flattenFilterNode(node: unknown): unknown {
  return node;
}
