import type {
  StudioExpressionField,
  StudioFilterNode,
  StudioFilterState,
  StudioQuery,
  StudioQueryDescriptor,
  StudioRelationship,
  StudioWidget,
  StudioWidgetConfig,
} from '../models';
import { findJoinPath } from './dataSourceGraph';
import { selectFiltersForWidget } from './filterScoping';
import { isFilterComplete } from './filterUtils';
import { isJoinFieldExpression } from '../utils/expressionEvaluator';
import { collectExpressionRefs, collectJoinSourceIds } from './expressionRefs';
import { stableStringify } from './stableStringify';
import { resolvedRelativeBound } from './resolvedRowsCache';
import { getDescriptor } from './chartTypeRegistry';
import type { AggFn } from './chartTypeRegistry';

// ── Filter tree builder ─────────────────────────────────────────────────────

function filterStateToLeaf(f: StudioFilterState): StudioFilterNode {
  return {
    type: 'leaf',
    field: f.field,
    op: f.operator,
    value: f.value,
    value2: f.value2,
    conjunction: f.conjunction,
    op2: f.operator2,
    fieldType: f.fieldType,
    filterSourceId: f.filterSourceId,
    // Carried so the adapter's client-side residual can distinguish a selection-mode empty `in []`
    // ("any value" → match everything) from a condition-mode `in []` (match nothing).
    filterMode: f.filterMode,
    // Rank configuration, inert on every leaf the WIRE builds (rank filters are excluded from that
    // tree upstream) and load-bearing on the LOCAL path, where the descriptor is now the only road
    // to rows and a rank leaf that lost its direction and measure executes as a different query.
    rankDirection: f.rankDirection,
    rankByField: f.rankByField,
    rankMultiSeriesBy: f.rankMultiSeriesBy,
  };
}

/**
 * Converts an array of StudioFilterState items (already scoped to one source)
 * into a recursive StudioFilterNode tree. Returns undefined when no filters.
 */
export function filtersToFilterNode(filters: StudioFilterState[]): StudioFilterNode | undefined {
  if (filters.length === 0) {
    return undefined;
  }
  if (filters.length === 1) {
    return filterStateToLeaf(filters[0]);
  }
  return {
    type: 'group',
    logic: 'and',
    children: filters.map(filterStateToLeaf),
  };
}

/**
 * A descriptor for the in-memory executor, from filters that have ALREADY been scoped.
 *
 * The counterpart to {@link buildQueryDescriptor}, which builds the WIRE's descriptor. Two builders
 * rather than one because they answer to different constraints, and collapsing them would import
 * each one's constraints into the other:
 *
 * - The wire's descriptor feeds a request **cacheKey**, so every field in it is a refetch trigger.
 *   That is why rank filters are excluded there — a Top-N nudge is a client-side reduction and must
 *   not become a server round-trip — and why incomplete filters are pruned before the tree is
 *   built.
 * - This one feeds an executor that can run everything, and its only consumer is a local pass over
 *   rows already in memory. Rank belongs in the tree; incomplete leaves can stay, because the
 *   planner routes them to the residual and `applyFilters` re-drops them there.
 *
 * `select` is empty rather than computed: the in-memory executor deliberately does not project (see
 * `executeLocalQuery`), because nothing in Studio benefits from dropping columns client-side.
 * `select` exists so a REMOTE executor can avoid transferring them.
 * @param params The widget's identity and its already-scoped filters.
 * @returns A descriptor the local executor can answer.
 */
export function buildLocalQueryDescriptor(params: {
  /** The widget's own source. Rank and cross-source routing are resolved against it. */
  sourceId: string;
  widgetId: string;
  /**
   * Output of `selectFiltersForWidget` — page/widget/cross/interactive scoping already applied,
   * `disabled` already dropped. Passing UNSCOPED filters here would apply another widget's filters
   * to this one; the scoping step is not something this builder can redo, because it needs the
   * page and cross-filter context the caller holds.
   */
  filters: StudioFilterState[];
}): StudioQuery {
  return {
    sourceId: params.sourceId,
    widgetId: params.widgetId,
    select: [],
    filter: filtersToFilterNode(params.filters),
  };
}

/**
 * Every relative-date bound the filter tree currently resolves to, in tree order.
 *
 * A `RelativeDateValue` ("7 days ago") is a STABLE object, so `stableStringify(filter)` yields
 * the same bytes across a `RELATIVE_DATE_REFRESH_CADENCE_MS` tick — while `createSimpleAdapter`
 * / `createBatchingAdapter` resolve that same value to a DIFFERENT concrete instant when they
 * serialize the request. The cacheKey then names a window the request no longer asks for, and a
 * widget can be served rows fetched for the previous window. `StudioRequestCache`'s 30s TTL
 * bounds the staleness, but the two keys were being built by different rules for the same
 * reason: `resolvedRowsCache.filterFingerprint` already folds `resolvedRelativeBound` in. Reusing
 * that exact helper here keeps both key builders on one rule (and one definition of "nested
 * inside a `between` bound's `{from,to}`" — which `isRelativeDateValue(value)` alone never sees).
 *
 * Bounds that resolve to `null` (the overwhelmingly common no-relative-date case) are omitted, so
 * a dashboard with no relative-date filter keeps a byte-identical, non-churning cacheKey.
 */
function collectResolvedRelativeBounds(node: StudioFilterNode | undefined): string[] {
  if (!node) {
    return [];
  }
  if (node.type === 'leaf') {
    return [resolvedRelativeBound(node.value), resolvedRelativeBound(node.value2)].filter(
      (bound): bound is string => bound !== null,
    );
  }
  return node.children.flatMap(collectResolvedRelativeBounds);
}

// ── Select field collector ──────────────────────────────────────────────────

export function collectSelectFields(widget: StudioWidget): string[] {
  if (!widget.config) {
    return [];
  }
  const descriptor = getDescriptor(widget.kind, widget.config);
  return descriptor.collectFields(widget.config, widget.sourceId);
}

// ── Expression-field expansion ──────────────────────────────────────────────
//
// Servers and adapters can only project and aggregate *physical* columns. An
// expression field (e.g. `price - cost`, or `stock * price`) is a client-side
// concept: the database has no such column, so it cannot be SELECTed and it
// certainly cannot be aggregated server-side (e.g. `avg(price - cost)` is not the
// same as a column average). These helpers replace expression fields with the
// native columns they depend on so the rows come back with the raw inputs, and
// the expression is re-derived client-side after the fetch (see useWidgetRows).

/**
 * Replaces any expression-field IDs in `fields` with the native field IDs they
 * (transitively) depend on. Native fields and unknown IDs pass through unchanged.
 *
 * @param relationships - Declared source relationships. Needed to resolve the FK column
 *   backing a `JoinFieldExpression` nested inside a `FunctionExpression` (e.g.
 *   `if(customers.country == 'US', 1, 0)`) — see the nested-join branch below.
 */
export function expandToNativeFields(
  fields: string[],
  expressionFields: StudioExpressionField[],
  sourceId: string | undefined,
  relationships: StudioRelationship[] = [],
): string[] {
  if (!sourceId || expressionFields.length === 0) {
    return fields;
  }
  const exprById = new Map(
    expressionFields.filter((ef) => ef.sourceId === sourceId).map((ef) => [ef.id, ef]),
  );
  if (exprById.size === 0) {
    return fields;
  }
  const result = new Set<string>();
  const expanding = new Set<string>();
  const addNative = (id: string): void => {
    const expr = exprById.get(id);
    if (!expr) {
      result.add(id); // physical column (or unknown — leave for the server to validate)
      return;
    }
    if (expanding.has(id)) {
      return; // guard against cyclic expression definitions
    }
    expanding.add(id);
    if (isJoinFieldExpression(expr.expression)) {
      // JoinFieldExpression has no native column on this source — pass the logical
      // field ID through so the batching adapter can resolve it to a server-side JOIN
      // (via resolveField). If the join target is on a different endpoint, the adapter
      // marks it skip=true and falls back to client-side enrichment instead.
      result.add(id);
      return;
    }
    // Walk the FULL expression tree (not just the top-level node) for nested
    // JoinFieldExpression hits — e.g. the `customers` join inside
    // `if(customers.country == 'US', 1, 0)`. `collectExpressionRefs` deliberately excludes
    // JoinFieldExpression nodes (they have no native column ON THIS SOURCE), so — unlike the
    // top-level-join branch above — neither the calculated field's own id nor any native
    // column previously reached `select` for this shape, and a server-side JOIN can't be
    // built for an arbitrary function expression anyway. Instead, add the relationship's FK
    // field (the column on THIS source used to join to the foreign source) to the native
    // field set, so the raw row the adapter returns carries the FK and client-side
    // re-enrichment (`getCachedEnrichedRows`, which always runs on adapter rows) can resolve
    // the join locally instead of evaluating against `undefined`.
    for (const joinSourceId of new Set(collectJoinSourceIds(expr.expression))) {
      const rel = relationships.find((r) => r.sourceId === sourceId && r.targetId === joinSourceId);
      if (rel) {
        result.add(rel.sourceField);
      }
    }
    for (const ref of collectExpressionRefs(expr.expression)) {
      addNative(ref);
    }
  };
  fields.forEach(addNative);
  return [...result];
}

function isExpressionField(
  fieldId: string,
  expressionFields: StudioExpressionField[],
  sourceId: string | undefined,
): boolean {
  return expressionFields.some((ef) => ef.id === fieldId && ef.sourceId === sourceId);
}

// ── Aggregations builder ────────────────────────────────────────────────────

function buildAggregations(
  widget: StudioWidget,
  expressionFields: StudioExpressionField[] = [],
): { field: string; fn: AggFn; alias: string }[] | undefined {
  const { config } = widget;

  if (!config) {
    return undefined;
  }

  // Expression-field aggregations cannot be pushed to the server (no physical column,
  // and a computed-column aggregate is not a column aggregate). They are dropped here
  // and recomputed client-side from the enriched raw rows.
  const isExpr = (fieldId: string): boolean =>
    isExpressionField(fieldId, expressionFields, widget.sourceId);

  const descriptor = getDescriptor(widget.kind, widget.config);
  const aggs = descriptor.buildAggregationSpecs(config, isExpr, widget.sourceId);

  return aggs.length > 0 ? aggs : undefined;
}

// ── Descriptor builder ──────────────────────────────────────────────────────

/**
 * Builds a StudioQueryDescriptor for the given widget from the current store state.
 *
 * Only page and widget filters (`include: 'no-cross'`) are baked into the server query.
 * Chart-click cross-filters and interactive (filter-widget) selections are deliberately
 * excluded here: they are transient, per-interaction refinements that must NOT trigger a
 * server round-trip (or churn the request cacheKey). They are enforced client-side on the
 * fetched rows by `useWidgetRows.computeFilteredRows` (the sole enforcement point) via the
 * same `selectFiltersForWidget` + `resolveRowsCached` calls the sync path uses.
 *
 * @param widget - The widget to build a descriptor for.
 * @param filters - All active filters from the store.
 * @param activePageId - The currently active page ID (from dashboard state).
 * @param tableName - Optional database table name. When provided, takes precedence
 *   over the source ID for server-side batch queries.
 * @param expressionFields - Expression (calculated) fields for the widget's source.
 *   Used to expand expression columns to their native dependencies in `select` and to
 *   exclude expression-field aggregations (both are computed client-side instead).
 * @param relationships - Declared source relationships. Used to resolve the FK column for a
 *   nested join expression (see `expandToNativeFields`).
 * @param crossFilterAllPages - Mirrors `StudioState.doc.dashboard.crossFilterAllPages`; needed
 *   only to correctly detect `hasIncomingCrossOrInteractiveFilters` below (a cross-filter scoped
 *   to a different page still counts as "incoming" when this is `true`).
 */
export function buildQueryDescriptor(
  widget: StudioWidget,
  filters: StudioFilterState[],
  activePageId: string,
  tableName?: string,
  expressionFields: StudioExpressionField[] = [],
  relationships: StudioRelationship[] = [],
  crossFilterAllPages: boolean = false,
): StudioQueryDescriptor {
  // 'no-cross' → page + widget + dashboard-date-range only. Cross-filter / interactive
  // scopes are dropped: they are applied client-side (see useWidgetRows), so they never
  // reach the server query nor perturb the cacheKey.
  const serverFilters = selectFiltersForWidget(filters, {
    widgetId: widget.id,
    widgetSourceId: widget.sourceId,
    activePageId,
    include: 'no-cross',
  });

  // Whether this widget currently has an incoming chart-click cross-filter or interactive
  // (filter-widget) selection. Computed independently of `serverFilters` above (which
  // deliberately excludes both scopes) via the SAME `selectFiltersForWidget` call the client uses
  // to enforce them, so this can never disagree with what `useWidgetRows` actually applies.
  // Adapters use this to decide whether to strip a server-side aggregation push-down and fetch
  // raw rows instead — a server-aggregated response is one row per group with only the grouped/
  // alias columns, so a cross-filter on any other field would read `undefined` on every row and
  // empty the widget.
  const incomingFilters = selectFiltersForWidget(filters, {
    widgetId: widget.id,
    widgetSourceId: widget.sourceId,
    activePageId,
    include: 'all',
    crossFilterAllPages,
  });
  const crossOrInteractiveFilters = incomingFilters.filter(
    (f) => f.scope.kind === 'cross-filter' || f.scope.kind === 'interactive',
  );
  const hasIncomingCrossOrInteractiveFilters = crossOrInteractiveFilters.length > 0;
  // Rank-mode filters (top/bottom-N) have no wire representation: `filterStateToLeaf` drops
  // `filterMode`, so a page-scoped rank filter would serialize as a bogus `field = <rankValue>`
  // predicate (the leaf's `value` is the N, e.g. 10) and the actual top-N reduction would never
  // run server-side. Strip them from the server filter tree; the rank reduction is applied
  // client-side after the fetch via `applyFilters` (the same `compileRowTest`/`applyFilters` path
  // the in-memory/sync path uses) — see `useWidgetRows`' adapter branch.
  //
  // `selectFiltersForWidget`'s own 'widget' scope case unconditionally excludes
  // `filterMode === 'rank'` filters (they're handled as a special post-aggregation reduction, not
  // an ordinary row predicate, by `useChartWidgetData`'s own `widgetRankFilter` lookup) — so a
  // WIDGET-scoped rank filter never reaches `serverFilters` at all. Only page-scoped rank filters
  // do. Both scopes are collected here directly from the raw `filters` array so a widget-scoped
  // "top N by measure" filter's field-widening (below) isn't silently skipped.
  const widgetScopedRankFilters = filters.filter(
    (f) =>
      !f.disabled &&
      f.scope.kind === 'widget' &&
      f.scope.widgetId === widget.id &&
      (f.filterMode ?? 'condition') === 'rank',
  );
  const rankFilters = [
    ...serverFilters.filter((f) => (f.filterMode ?? 'condition') === 'rank'),
    ...widgetScopedRankFilters,
  ];
  // Prune incomplete filters (an empty-value condition — the drawer's `{ operator: 'equals',
  // value: '' }` add-filter default — or an empty selection) BEFORE building the server filter
  // tree. In-memory `applyFilters` drops them via `isFilterComplete`, so shipping them as real
  // predicates (`col = ''`, or an empty-`in` that inverts to match-nothing) diverges from the
  // in-memory evaluator AND churns the cacheKey on every keystroke while the user is still
  // authoring the filter. This fixes both the batching and simple adapters
  // (both consume this `filter` tree) and stabilizes the cacheKey.
  const filter = filtersToFilterNode(
    serverFilters.filter((f) => (f.filterMode ?? 'condition') !== 'rank' && isFilterComplete(f)),
  );
  // Whether this widget currently carries an active rank-mode (top/bottom-N) filter. Adapters use
  // this to strip a server-side aggregation push-down and fetch raw rows instead: the client rank
  // reduction must sum `rankByField` per group over RAW rows, but a pushed-down aggregation
  // GROUP BYs `rankByField` into a grouping dimension and collapses duplicate rows, so the client
  // would rank over group-collapsed rows and pick the wrong Top-N.
  const hasRankFilters = rankFilters.length > 0;

  // A rank-by-measure filter (e.g. "top 5 by profit") reduces on `rankByField`, not `field`
  // (which is the group-by/dimension column for an aggregate rank, or unused for a plain
  // numeric rank). Neither `field` nor `rankByField` is otherwise guaranteed to be part of the
  // widget's own config (xField/yField/columns), so without explicitly widening `select` here,
  // the adapter never fetches the rank measure column and the client-side rank reduction (in
  // `useWidgetRows`) reads `Number(row['profit'] ?? 0)` = 0 for every row — an arbitrary "top 5"
  // in insertion order instead of a real ranking.
  const rankFilterFieldRefs = rankFilters.flatMap((f) =>
    [f.field, f.rankByField].filter((v): v is string => Boolean(v)),
  );

  // Incoming cross-filter / interactive-filter fields must also be widened into `select`. The
  // adapter's client-side enforcement (`useWidgetRows`) is the SOLE enforcement point for these
  // scopes and evaluates them against the FETCHED raw rows, while `x-studio-data-middleware`
  // deliberately projects ONLY `select` (= `plan.columns`). A cross/interactive field that is not
  // already part of the widget's own config (xField/yField/columns) would therefore be MISSING
  // from every returned row, so the residual `row[field] == value` is `undefined == value` →
  // false for every row and the widget empties.
  //
  // Only the FIELD SET is folded in here — never the per-value selection. `select` feeds the
  // cacheKey, so this changes the key at most once, when a cross/interactive filter first lands on
  // a NEW field (one refetch); clicking different values on the same field leaves the field set —
  // and thus the cacheKey — unchanged. Hosts that ignore `select` and return full rows are
  // unaffected.
  const crossOrInteractiveFieldRefs = crossOrInteractiveFilters.flatMap((f) => {
    if (!f.field) {
      return [];
    }
    // Same-source filter: the filtered column lives on the widget's own source, so project it.
    if (!f.filterSourceId || f.filterSourceId === widget.sourceId) {
      return [f.field];
    }
    // Cross-source filter: the residual semi-joins the foreign match set back to the widget's
    // rows on the relationship join column, so THAT column (on the widget's source) must be
    // projected — the foreign field itself belongs to another source and can't be selected here.
    //
    // Call `findJoinPath` rather than re-deriving the column from a local `relationships.find`.
    // The local version mirrored only that function's DIRECT-relationship arm, so a cross-filter
    // whose `filterSourceId` names a many-to-many remote endpoint (a two-hop path) or an M:N
    // JUNCTION source — both of which `findJoinPath` resolves — matched nothing, projected no
    // column, and left the residual comparing `undefined` on every row: the widget emptied.
    const joinPath = findJoinPath(widget.sourceId ?? '', f.filterSourceId, relationships);
    return joinPath ? [joinPath.widgetJoinField] : [];
  });

  // Expression columns are expanded to the native columns they depend on — the server
  // returns the raw inputs and the expression is re-derived client-side.
  const select = expandToNativeFields(
    [...collectSelectFields(widget), ...rankFilterFieldRefs, ...crossOrInteractiveFieldRefs],
    expressionFields,
    widget.sourceId,
    relationships,
  );
  // This query descriptor is built for BOTH chart and grid widgets: a chart
  // groups by its `xField`, a grid by its `gridGroupByField`. Rather than
  // branch on `widget.kind` (the descriptor's shape is identical either way,
  // only which key supplies the grouping differs), read both keys through the
  // flat cross-kind `StudioWidgetConfig` patch type — the irrelevant key is
  // simply absent on the other kind's config and coalesces away.
  const config = widget.config as StudioWidgetConfig;
  const groupBy = config?.xField ?? config?.gridGroupByField;
  const xGroupBy = config?.xGroupBy;
  const aggregations = buildAggregations(widget, expressionFields);

  // Compute a stable cache key from query shape (no widgetId) so widgets with
  // identical queries — same source, filters, select, groupBy, aggregations —
  // share one cache entry and one server request.
  //
  // `hasIncomingCrossOrInteractiveFilters` is folded into the key ONLY when there is a server-side
  // aggregation to strip — that is the one case where the flag actually changes the request shape
  // (aggregated vs. raw rows). For a widget with no aggregations to strip, folding the raw flag in
  // unconditionally would churn the cacheKey (and force a spurious server round-trip) on every
  // chart click / interactive-filter change for widgets that have nothing to gain from it — exactly
  // the round-trip the architecture deliberately avoids by excluding cross-filters/interactive
  // filters from the descriptor's `filter` tree in the first place. Like
  // `hasIncomingCrossOrInteractiveFilters`, `hasRankFilters` only changes the request shape (raw
  // rows vs. aggregated) when there is an aggregation to strip — folding it into the key
  // unconditionally would churn the cacheKey for a widget with nothing to gain.
  //
  // `relativeDateBounds` folds in what each relative-date filter value currently RESOLVES to
  // (see `collectResolvedRelativeBounds`): the raw `filter` tree alone is byte-stable across a
  // cadence tick while the adapter re-resolves the bound at request time, so without it one key
  // named two different windows. Omitted entirely when no filter carries a relative date.
  const hasAggregations = Boolean(aggregations && aggregations.length > 0);
  const relativeDateBounds = collectResolvedRelativeBounds(filter);
  const cacheKeySource = {
    sourceId: widget.sourceId,
    select: select.toSorted(),
    filter,
    ...(relativeDateBounds.length > 0 ? { relativeDateBounds } : {}),
    groupBy,
    xGroupBy,
    aggregations,
    hasIncomingCrossOrInteractiveFilters: hasIncomingCrossOrInteractiveFilters && hasAggregations,
    hasRankFilters: hasRankFilters && hasAggregations,
  };
  const cacheKey = `${widget.sourceId}:${stableStringify(cacheKeySource)}`;

  return {
    sourceId: widget.sourceId ?? '',
    tableName,
    widgetId: widget.id,
    select,
    filter,
    groupBy,
    xGroupBy,
    aggregations,
    hasIncomingCrossOrInteractiveFilters,
    hasRankFilters,
    cacheKey,
  };
}

// ── Shared "descriptor from state" helper ─────────────────────

/**
 * The subset of `StudioState` needed to build a widget's query descriptor, bundled into a
 * single required object rather than left as individually-optional positional arguments.
 *
 * This exists because `buildQueryDescriptor` itself defaults `relationships` to `[]` and
 * `crossFilterAllPages` to `false` — convenient for the many unit tests that only care about
 * filters/select, but exactly what let the CSV export path silently omit both and still
 * compile. Both fields feed the descriptor's `cacheKey`, so a descriptor built with the
 * defaults produces a DIFFERENT cache key than one built from real state, even when the
 * underlying widget/page/filters are identical — the export path's cache lookup then misses
 * an entry the live grid already populated. Requiring this object (with no defaults) makes
 * that omission a compile error instead of a silent, cache-key-breaking drift.
 */
export interface WidgetQueryDescriptorState {
  filters: StudioFilterState[];
  expressionFields: StudioExpressionField[];
  relationships: StudioRelationship[];
  crossFilterAllPages: boolean;
}

/**
 * Single source of truth for building a widget's `StudioQueryDescriptor` from live state.
 * Both the on-screen adapter fetch (`useAdapterRows`) and the CSV export path
 * (`runWidgetExport`) must call this — never `buildQueryDescriptor` directly with a hand-picked
 * subset of arguments — so the two can never again build descriptors with different `cacheKey`s
 * for what is otherwise the same query.
 */
export function buildWidgetQueryDescriptor(
  widget: StudioWidget,
  pageId: string,
  tableName: string | undefined,
  state: WidgetQueryDescriptorState,
): StudioQueryDescriptor {
  return buildQueryDescriptor(
    widget,
    state.filters,
    pageId,
    tableName,
    state.expressionFields,
    state.relationships,
    state.crossFilterAllPages,
  );
}
