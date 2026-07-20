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
 * Resolves a single filter value to its wire form, recursively handling a `RelativeDateValue`
 * nested inside a `between { from, to }` bound object — not just a top-level relative value.
 *
 * The drawer lets a user pick a relative date for EITHER bound of a `between` filter
 * (`FilterValueInput.tsx`'s two `DateValueInput`s), so `{ from: <RelativeDateValue>, to: '2024-…' }`
 * is a real shape reaching this function. Only resolving a top-level `RelativeDateValue` (the
 * previous behavior) left such a nested bound raw/unresolved on the wire — a client-side-only
 * concept ({ relative: true, amount, unit, direction }) the remote host cannot interpret.
 */
function resolveWireFilterValue(value: unknown): unknown {
  if (isRelativeDateValue(value)) {
    return resolveRelativeDate(value);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const range = value as { from?: unknown; to?: unknown };
    if (isRelativeDateValue(range.from) || isRelativeDateValue(range.to)) {
      return {
        ...range,
        from: isRelativeDateValue(range.from) ? resolveRelativeDate(range.from) : range.from,
        to: isRelativeDateValue(range.to) ? resolveRelativeDate(range.to) : range.to,
      };
    }
  }
  return value;
}

/**
 * Resolve every `RelativeDateValue` (e.g. "7 days ago") in a filter tree to a concrete date/instant
 * string, returning a new tree (never mutating the input). A relative value is a client-side
 * concept a remote host cannot resolve, so — like `createBatchingAdapter` — the simple adapter
 * resolves them before sending. Unlike the batching adapter it does NOT translate to the
 * middleware's `FilterPredicate` wire shape: it POSTs the native `StudioQueryDescriptor`, so the
 * host is expected to understand that shape directly (finding 2.19).
 */
function resolveFilterNodeRelativeDates(node: StudioFilterNode): StudioFilterNode {
  if (node.type === 'group') {
    return { ...node, children: node.children.map(resolveFilterNodeRelativeDates) };
  }
  const resolved: StudioFilterNode = { ...node };
  resolved.value = resolveWireFilterValue(resolved.value);
  resolved.value2 = resolveWireFilterValue(resolved.value2);
  return resolved;
}

/** Return a descriptor whose filter tree has every relative-date value resolved to a concrete date. */
function resolveDescriptorRelativeDates(descriptor: StudioQueryDescriptor): StudioQueryDescriptor {
  if (!descriptor.filter) {
    return descriptor;
  }
  return { ...descriptor, filter: resolveFilterNodeRelativeDates(descriptor.filter) };
}

/**
 * Strip server-side aggregations from a descriptor that carries an incoming chart-click
 * cross-filter or interactive (filter-widget) selection, so the widget doesn't empty out
 * (finding 2.7 — the same class as `createBatchingAdapter`'s guard).
 *
 * Those scopes are deliberately excluded from the server query and enforced client-side over the
 * returned rows, but a server-aggregated response is one row per group with only the grouped/alias
 * columns — the cross-filter's own field reads `undefined` on every row and empties the widget.
 * Returning raw rows lets the widget apply the cross-filter to real per-row data before its own
 * (always-on) aggregation step runs. A host that ignores `aggregations` entirely already returns
 * raw rows, so this is a no-op for it; it only matters for a host faithfully honouring the
 * (documented) `aggregations` contract.
 */
function stripAggregationsForIncomingCrossFilter(
  descriptor: StudioQueryDescriptor,
): StudioQueryDescriptor {
  if (
    !descriptor.hasIncomingCrossOrInteractiveFilters ||
    !descriptor.aggregations ||
    descriptor.aggregations.length === 0
  ) {
    return descriptor;
  }
  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: A server-side aggregation for source "${descriptor.sourceId}" was stripped ` +
        `before sending to the data adapter because the widget has an incoming cross-filter or ` +
        `interactive filter-widget selection, which is enforced client-side over the returned ` +
        `rows. A server-aggregated response would contain only the grouped/alias columns, so the ` +
        `cross-filter's field would read undefined on every row and empty the widget. Raw rows ` +
        `are requested instead and aggregated client-side.`,
    );
  }
  return { ...descriptor, aggregations: undefined };
}

/**
 * Strip server-side aggregations from a descriptor that carries an active rank-mode (top/bottom-N)
 * filter (finding T2.4 — the same class as the cross-filter guard above).
 *
 * A rank filter has no wire form and is always re-applied client-side over the returned rows, but
 * its reduction sums the rank measure per group and so must see RAW rows. A server-aggregated
 * response GROUP BYs the rank measure into a dimension and collapses duplicate rows, so the client
 * would rank over group-collapsed rows and pick the wrong Top-N. Returning raw rows lets the widget
 * rank over real per-row data before its own aggregation step runs. A host that ignores
 * `aggregations` already returns raw rows, so this is a no-op for it.
 */
function stripAggregationsForRankFilter(descriptor: StudioQueryDescriptor): StudioQueryDescriptor {
  if (
    !descriptor.hasRankFilters ||
    !descriptor.aggregations ||
    descriptor.aggregations.length === 0
  ) {
    return descriptor;
  }
  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: A server-side aggregation for source "${descriptor.sourceId}" was stripped ` +
        `before sending to the data adapter because the widget has an active rank (top/bottom-N) ` +
        `filter, whose client-side reduction must sum the rank measure per group over raw rows. A ` +
        `server-aggregated response would group the rank measure into a dimension and collapse ` +
        `rows, so the rank would select the wrong Top-N. Raw rows are requested instead and ` +
        `aggregated client-side.`,
    );
  }
  return { ...descriptor, aggregations: undefined };
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
      // relative spec it cannot interpret (finding 2.19). Then strip server aggregations when an
      // incoming cross/interactive filter would make an aggregated response empty the widget
      // (finding 2.7), or when an active rank filter needs raw rows to rank correctly (finding T2.4).
      const resolvedDescriptor = stripAggregationsForRankFilter(
        stripAggregationsForIncomingCrossFilter(resolveDescriptorRelativeDates(descriptor)),
      );
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
