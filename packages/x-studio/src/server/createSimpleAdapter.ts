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
 * The `filter` tree is Studio's own `StudioFilterNode`, NOT the data-middleware's
 * `FilterPredicate` wire shape, so the host must implement Studio's operator semantics. The one
 * that most often surprises a host implementer is date granularity: on a `date`/`datetime` field,
 * `equals`/`not_equals` and any bare `YYYY-MM-DD` ordering bound compare at CALENDAR-DAY
 * granularity, not at the midnight instant the value literally names. Against a DATETIME/timestamp
 * column that means:
 *   - `equals D`        → `col >= D AND col < D+1day` (a literal `col = D` matches only the rows
 *                         stored at exactly midnight — typically none);
 *   - `not_equals D`    → `col < D OR col >= D+1day` (or NULL — Studio keeps NULL rows here, SQL's
 *                         `col != D` does not);
 *   - `<= D` / `> D`    → `col < D+1day` / `col >= D+1day` (the whole of day D is inside `<= D`);
 *   - `>= D` / `< D`    → unchanged;
 *   - `between [F, T]`  → `col >= F AND col < T+1day`.
 * A bound that carries an explicit time-of-day keeps full precision, EXCEPT for
 * `equals`/`not_equals`, which are day-granular for every value form. `createBatchingAdapter`
 * performs exactly these rewrites itself because it speaks the `FilterPredicate` protocol; this
 * adapter cannot, because it does not translate the tree at all — the host owns the semantics.
 *
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
import { aggregationPushdownWarning, decideAggregationPushdown } from './aggregationPushdown';

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
 * host is expected to understand that shape directly.
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
 * Strip a server-side aggregation push-down the client could not repair, using the SAME ladder
 * `createBatchingAdapter` runs (`decideAggregationPushdown`).
 *
 * This used to be two bespoke guards here — incoming cross/interactive filters and rank filters —
 * i.e. two of the ladder's five rungs. The three missing ones were not academic: a simple-adapter
 * bar chart with `yAggregation: 'count'` asked the host for one pre-aggregated row per group and
 * then counted those rows client-side, so EVERY bar read `1`. `count_distinct` and an `avg` at a
 * grain finer than the widget's re-aggregation grain failed the same way. Sharing the decision is
 * the structural fix: a rung added for one adapter can no longer be missing from the other.
 *
 * A host that ignores `aggregations` entirely already returns raw rows, so this is a no-op for it;
 * it only matters for a host faithfully honouring the (documented) `aggregations` contract.
 *
 * `hasUnpushableFilters` is `false` because this adapter does not partition the filter tree at all:
 * it forwards Studio's native `StudioFilterNode` and the host owns every operator's semantics, so
 * no leaf is left over for a client-side residual.
 */
function stripUnrepairableAggregations(descriptor: StudioQueryDescriptor): StudioQueryDescriptor {
  const decision = decideAggregationPushdown({ descriptor, hasUnpushableFilters: false });
  if (!decision.strip) {
    return descriptor;
  }
  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: ${aggregationPushdownWarning(descriptor.sourceId, decision.reason!)}`,
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
      // relative spec it cannot interpret. Then run the shared aggregation
      // push-down ladder, which strips an aggregation the client could not repair (see
      // `stripUnrepairableAggregations`).
      const resolvedDescriptor = stripUnrepairableAggregations(
        resolveDescriptorRelativeDates(descriptor),
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
