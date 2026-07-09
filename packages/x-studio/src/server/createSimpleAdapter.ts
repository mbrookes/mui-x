/**
 * createSimpleAdapter — single-source REST fetch adapter for Studio widgets.
 *
 * A lightweight alternative to `createBatchingAdapter` when each data source has
 * its own dedicated endpoint that accepts a single Studio query descriptor and
 * returns `{ rows: Record<string, unknown>[] }`.
 *
 * Unlike the batching adapter, each `getRows()` call fires an individual HTTP
 * request. This is simpler to set up on the server side but trades network
 * efficiency for simplicity. Prefer `createBatchingAdapter` when you have many
 * widgets on the same page.
 *
 * Server contract:
 *   POST <endpoint>
 *   Request body: { sourceId, select, filter?, groupBy?, aggregations? }
 *   Response: { rows: Record<string, unknown>[] }
 *
 * Usage:
 *   const source: StudioDataSource = {
 *     id: 'orders',
 *     label: 'Orders',
 *     fields: orderFields,
 *     adapter: createSimpleAdapter('/api/studio/orders'),
 *   };
 */
import type {
  StudioDataSourceAdapter,
  StudioFilterNode,
  StudioQueryDescriptor,
  StudioQueryResult,
} from '../models';
import { isRelativeDateValue, resolveRelativeDate } from '../internals/filterUtils';

/**
 * Resolve every `RelativeDateValue` (e.g. "7 days ago") in a filter tree to a concrete
 * `YYYY-MM-DD` string, returning a new tree (never mutating the input). A relative value is a
 * client-side concept a remote host cannot resolve, so — like `createBatchingAdapter` — the
 * simple adapter resolves them before sending. Unlike the batching adapter it does NOT translate
 * to the middleware's `FilterPredicate` wire shape: it POSTs the native `StudioQueryDescriptor`,
 * so the host is expected to understand that shape directly (finding 2.19).
 */
function resolveFilterNodeRelativeDates(node: StudioFilterNode): StudioFilterNode {
  if (node.type === 'group') {
    return { ...node, children: node.children.map(resolveFilterNodeRelativeDates) };
  }
  const resolved: StudioFilterNode = { ...node };
  if (isRelativeDateValue(resolved.value)) {
    resolved.value = resolveRelativeDate(resolved.value);
  }
  if (isRelativeDateValue(resolved.value2)) {
    resolved.value2 = resolveRelativeDate(resolved.value2);
  }
  return resolved;
}

/** Return a descriptor whose filter tree has every relative-date value resolved to a concrete date. */
function resolveDescriptorRelativeDates(descriptor: StudioQueryDescriptor): StudioQueryDescriptor {
  if (!descriptor.filter) {
    return descriptor;
  }
  return { ...descriptor, filter: resolveFilterNodeRelativeDates(descriptor.filter) };
}

export interface SimpleAdapterOptions {
  /**
   * Custom fetch implementation. Defaults to global `fetch`.
   * Useful for adding auth headers, interceptors, or test mocks.
   */
  fetchFn?: typeof fetch;
  /**
   * Transform the query descriptor before sending it to the server.
   * Useful for renaming fields or adding custom query parameters.
   * @param {StudioQueryDescriptor} descriptor Query descriptor to transform before sending.
   * @returns {unknown} Transformed descriptor payload.
   */
  transformDescriptor?: (descriptor: StudioQueryDescriptor) => unknown;
}

/**
 * Create a `StudioDataSourceAdapter` that sends each widget's query descriptor
 * to a dedicated REST endpoint as a POST request.
 *
 * @param endpoint - URL of the POST endpoint (e.g. '/api/studio/orders')
 * @param options - Optional configuration
 * @returns {StudioDataSourceAdapter} Adapter that resolves rows from the endpoint.
 */
export function createSimpleAdapter(
  endpoint: string,
  options: SimpleAdapterOptions = {},
): StudioDataSourceAdapter {
  const { fetchFn = globalThis.fetch, transformDescriptor } = options;

  return {
    /**
     * @param {StudioQueryDescriptor} descriptor Query descriptor for the widget request.
     * @returns {Promise<StudioQueryResult>} Promise resolving to the fetched rows.
     */
    async getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult> {
      // Resolve relative-date values (e.g. "7 days ago") to concrete dates before sending —
      // the host receives a plain, self-describing descriptor rather than a client-only
      // relative spec it cannot interpret (finding 2.19).
      const resolvedDescriptor = resolveDescriptorRelativeDates(descriptor);
      const body = transformDescriptor
        ? transformDescriptor(resolvedDescriptor)
        : resolvedDescriptor;

      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(
          `MUI X Studio: Failed to fetch data from "${endpoint}": ${response.status} ${response.statusText}`,
        );
      }

      const json = (await response.json()) as { rows: Record<string, unknown>[] };

      if (!Array.isArray(json.rows)) {
        throw new Error(`MUI X Studio: Response from "${endpoint}" must have a "rows" array`);
      }

      return { rows: json.rows };
    },
  };
}
