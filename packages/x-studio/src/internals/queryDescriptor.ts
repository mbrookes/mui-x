import type {
  StudioExpressionField,
  StudioFilterNode,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioRelationship,
  StudioWidget,
  StudioWidgetConfig,
} from '../models';
import { selectFiltersForWidget } from './filterScoping';
import { isJoinFieldExpression } from '../utils/expressionEvaluator';
import { collectExpressionRefs, collectJoinSourceIds } from './expressionRefs';
import { stableStringify } from './stableStringify';
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
 *   `if(customers.country == 'US', 1, 0)`) — see the nested-join branch below (finding 2.9).
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
    // the join locally instead of evaluating against `undefined` (finding 2.9).
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
  // empty the widget (finding 2.9).
  const hasIncomingCrossOrInteractiveFilters = selectFiltersForWidget(filters, {
    widgetId: widget.id,
    widgetSourceId: widget.sourceId,
    activePageId,
    include: 'all',
    crossFilterAllPages,
  }).some((f) => f.scope.kind === 'cross-filter' || f.scope.kind === 'interactive');
  // Rank-mode filters (top/bottom-N) have no wire representation: `filterStateToLeaf` drops
  // `filterMode`, so a page-scoped rank filter would serialize as a bogus `field = <rankValue>`
  // predicate (the leaf's `value` is the N, e.g. 10) and the actual top-N reduction would never
  // run server-side. Strip them from the server filter tree; the rank reduction is applied
  // client-side after the fetch via `applyFilters` (the same `compileRowTest`/`applyFilters` path
  // the in-memory/sync path uses) — see `useWidgetRows`' adapter branch (finding 1.6).
  //
  // `selectFiltersForWidget`'s own 'widget' scope case unconditionally excludes
  // `filterMode === 'rank'` filters (they're handled as a special post-aggregation reduction, not
  // an ordinary row predicate, by `useChartWidgetData`'s own `widgetRankFilter` lookup) — so a
  // WIDGET-scoped rank filter never reaches `serverFilters` at all. Only page-scoped rank filters
  // do. Both scopes are collected here directly from the raw `filters` array so a widget-scoped
  // "top N by measure" filter's field-widening (below) isn't silently skipped (finding 2.5).
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
  const filter = filtersToFilterNode(
    serverFilters.filter((f) => (f.filterMode ?? 'condition') !== 'rank'),
  );

  // A rank-by-measure filter (e.g. "top 5 by profit") reduces on `rankByField`, not `field`
  // (which is the group-by/dimension column for an aggregate rank, or unused for a plain
  // numeric rank). Neither `field` nor `rankByField` is otherwise guaranteed to be part of the
  // widget's own config (xField/yField/columns), so without explicitly widening `select` here,
  // the adapter never fetches the rank measure column and the client-side rank reduction (in
  // `useWidgetRows`) reads `Number(row['profit'] ?? 0)` = 0 for every row — an arbitrary "top 5"
  // in insertion order instead of a real ranking (finding 2.5).
  const rankFilterFieldRefs = rankFilters.flatMap((f) =>
    [f.field, f.rankByField].filter((v): v is string => Boolean(v)),
  );

  // Expression columns are expanded to the native columns they depend on — the server
  // returns the raw inputs and the expression is re-derived client-side.
  const select = expandToNativeFields(
    [...collectSelectFields(widget), ...rankFilterFieldRefs],
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
  // `hasIncomingCrossOrInteractiveFilters` is folded into the key ONLY when there is a
  // server-side aggregation to strip — that is the one case where the flag actually changes the
  // request shape (aggregated vs. raw rows, finding 2.9). For a widget with no aggregations to
  // strip, folding the raw flag in unconditionally would churn the cacheKey (and force a spurious
  // server round-trip) on every chart click / interactive-filter change for widgets that have
  // nothing to gain from it — exactly the round-trip the architecture deliberately avoids by
  // excluding cross-filters/interactive filters from the descriptor's `filter` tree in the first
  // place.
  const cacheKeySource = {
    sourceId: widget.sourceId,
    select: select.toSorted(),
    filter,
    groupBy,
    xGroupBy,
    aggregations,
    hasIncomingCrossOrInteractiveFilters:
      hasIncomingCrossOrInteractiveFilters && Boolean(aggregations && aggregations.length > 0),
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
    cacheKey,
  };
}
