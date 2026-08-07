/**
 * Shared "should this widget's aggregation be pushed to the server?" decision, used by BOTH
 * `createBatchingAdapter` and `createSimpleAdapter`.
 *
 * Both adapters implement the same ladder: when a server-side aggregation would make the response
 * impossible to post-process faithfully, the aggregation is STRIPPED, raw rows are fetched, and the
 * widget's own (always-on) client-side aggregation produces the number instead. The ladder used to
 * be written twice and had diverged — the simple adapter implemented two of the five rungs, and the
 * batching adapter's own ladder ran BEFORE the filter partition, so it could not see the one rung
 * that depends on it (a filter the wire cannot express). Both bugs are structural, so the ladder
 * now lives here once and both adapters call it.
 *
 * Every rung is "the server's answer cannot be repaired client-side", never "the server would be
 * slower":
 *
 * 1. **Unpushable filter** — a predicate with no faithful wire form (`contains`, `not_in`,
 *    `is_empty`, an OR-combined leaf, …) is re-applied client-side against the RETURNED rows. A
 *    server-aggregated response is one row per group, so the predicate's own column is absent and
 *    the residual cannot run at all: it would be dropped and the widget would aggregate over EVERY
 *    row.
 * 2. **Incoming cross-filter / interactive selection** — same shape: those scopes are enforced
 *    client-side over the returned rows, and would read `undefined` on every pre-aggregated row.
 * 3. **Rank (top/bottom-N) filter** — its client-side reduction sums the rank measure per group and
 *    must therefore see raw rows; a pushed-down aggregation collapses the rows it ranks over.
 * 4. **`count` / `count_distinct`** — the wire protocol's `count` is SQL `COUNT(column)` (skips NULL
 *    measures) while Studio counts every row, and it has no DISTINCT form at all.
 * 5. **`avg` at a server grain finer than the client's** — the middleware GROUP BYs every projected
 *    non-measure column, so an `avg` computed at that finer grain is re-averaged client-side into an
 *    unweighted average of averages.
 */
import type { StudioQueryDescriptor } from '../models';
import type { AggFn } from '../engine/chartTypeRegistry';

/** Aggregation functions with no faithful wire form — always computed client-side over raw rows. */
const CLIENT_ONLY_AGG_FNS: ReadonlySet<AggFn> = new Set<AggFn>(['count', 'count_distinct']);

/**
 * True when `fn` must be computed client-side.
 *
 * `count`: the wire `count` becomes SQL `COUNT(column)`, which skips rows whose measure is NULL,
 * whereas Studio's `count` is a row count including nulls (`COUNT(*)` semantics — the policy every
 * client aggregator follows).
 *
 * `count_distinct`: the wire protocol has no DISTINCT aggregation at all. It used to be DOWNGRADED
 * to a plain `count` with a warning, but the downgrade could never produce a usable number: the
 * client re-aggregates the response, and a server-aggregated response has exactly one row per
 * group, so every group's distinct count rendered as `1` — an outcome the warning did not describe.
 *
 * `count_non_null` is deliberately NOT here, and it is the one count that isn't. The wire `count`
 * IS SQL `COUNT(column)`, which is exactly `count_non_null`'s definition — so it pushes down
 * faithfully and the server's number is the same number the client would have computed. That
 * mismatch between Studio's `count` and the wire's is precisely why the two need separate names:
 * without `count_non_null`, the only way to spell "how many rows have a value" was the wire's
 * `count`, which no client aggregator agrees with. The rename to the wire spelling happens at the
 * LAST moment, in `createBatchingAdapter`'s `toWireAggFunc`, so this check still sees the
 * distinct Studio name.
 */
export function isClientOnlyAggFn(fn: AggFn): fn is 'count' | 'count_distinct' {
  return CLIENT_ONLY_AGG_FNS.has(fn);
}

/**
 * The columns the SERVER will GROUP BY for this descriptor: every projected column that is not an
 * aggregation measure (the middleware derives its GROUP BY from the projection, NOT from
 * `descriptor.groupBy`).
 */
function serverGroupingColumns(d: StudioQueryDescriptor): string[] {
  const measures = new Set((d.aggregations ?? []).map((a) => a.field));
  return d.select.filter((fieldId) => !measures.has(fieldId));
}

/**
 * True when the server would aggregate at a FINER grain than the grain the client re-aggregates at.
 *
 * The client's grain is `groupBy` (a chart's `xField`, a grid's `gridGroupByField`), optionally
 * time-bucketed by `xGroupBy`. The server's grain is every projected non-measure column. Any
 * projected column outside the client's grain — or any `xGroupBy` bucketing, which the wire cannot
 * transmit at all — splits each client group into several server groups.
 *
 * Only `avg` cares: `sum`/`min`/`max` re-reduce correctly from partial results, an average of
 * averages does not (it is unweighted, so it is right only when every sub-group has the same row
 * count).
 */
function serverGrainIsFinerThanClientGrain(d: StudioQueryDescriptor): boolean {
  if (d.xGroupBy) {
    return true;
  }
  return serverGroupingColumns(d).some((fieldId) => fieldId !== d.groupBy);
}

export interface AggregationPushdownInput {
  descriptor: StudioQueryDescriptor;
  /**
   * True when the filter partition produced at least one leaf that must be re-applied client-side
   * against the returned rows. Adapters that do not partition filters (the simple adapter forwards
   * the whole tree and lets the host evaluate it) pass `false`.
   */
  hasUnpushableFilters: boolean;
}

export interface AggregationPushdownDecision {
  /** True when `aggregations` must be dropped from the request so the server returns raw rows. */
  strip: boolean;
  /** Why, phrased for a console warning. `undefined` when nothing was stripped. */
  reason?: string;
}

/**
 * Decide whether this descriptor's aggregations can be pushed to the server. See the module header
 * for each rung's rationale. The rungs are mutually compatible; only the first match is reported.
 */
export function decideAggregationPushdown({
  descriptor: d,
  hasUnpushableFilters,
}: AggregationPushdownInput): AggregationPushdownDecision {
  if (!d.aggregations || d.aggregations.length === 0) {
    return { strip: false };
  }
  if (hasUnpushableFilters) {
    return {
      strip: true,
      reason:
        `one or more filters have no faithful form in the adapter's query protocol and are ` +
        `re-applied client-side over the returned rows. A server-aggregated response contains ` +
        `only the grouped/alias columns, so those filters could not be re-applied at all and the ` +
        `widget would aggregate over EVERY row`,
    };
  }
  if (d.hasIncomingCrossOrInteractiveFilters) {
    return {
      strip: true,
      reason:
        `the widget has an incoming cross-filter or interactive filter-widget selection, which is ` +
        `enforced client-side over the returned rows. A server-aggregated response contains only ` +
        `the grouped/alias columns, so the cross-filter's field would read undefined on every row ` +
        `and empty the widget`,
    };
  }
  if (d.hasRankFilters) {
    return {
      strip: true,
      reason:
        `the widget has an active rank (top/bottom-N) filter, whose client-side reduction must sum ` +
        `the rank measure per group over raw rows. A server-aggregated response would group the ` +
        `rank measure into a dimension and collapse rows, so the rank would select the wrong Top-N`,
    };
  }
  const clientOnly = d.aggregations.find((a) => isClientOnlyAggFn(a.fn));
  if (clientOnly) {
    return {
      strip: true,
      reason:
        `the "${clientOnly.fn}" aggregation has no faithful form in the adapter's query protocol ` +
        `(its SQL count skips rows with a NULL measure, and there is no DISTINCT form at all), so ` +
        `it is computed client-side to stay consistent with in-memory sources`,
    };
  }
  if (d.aggregations.some((a) => a.fn === 'avg') && serverGrainIsFinerThanClientGrain(d)) {
    return {
      strip: true,
      reason:
        `an "avg" aggregation would be computed at a finer grain than the widget re-aggregates at ` +
        `(the adapter groups by every projected non-measure column and cannot transmit time ` +
        `bucketing), so a server-side average would be re-bucketed into an incorrect unweighted ` +
        `average of averages`,
    };
  }
  return { strip: false };
}

/**
 * The single warning both adapters emit when {@link decideAggregationPushdown} strips a push-down.
 * Each adapter keeps its own emission policy (the batching adapter dedupes per descriptor build and
 * warns in every environment; the simple adapter warns once per request, in development only).
 */
export function aggregationPushdownWarning(sourceId: string, reason: string): string {
  return (
    `A server-side aggregation for source "${sourceId}" was computed client-side instead of ` +
    `pushed to the data adapter: ${reason}. Raw rows are fetched for this widget and aggregated ` +
    `client-side instead.`
  );
}
