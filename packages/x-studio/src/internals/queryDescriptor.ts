import type {
  StudioExpressionField,
  StudioFilterNode,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioWidget,
  StudioWidgetConfig,
} from '../models';
import { selectFiltersForWidget } from './filterScoping';
import { isJoinFieldExpression } from '../utils/expressionEvaluator';
import { collectExpressionRefs } from './expressionRefs';
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
 */
export function expandToNativeFields(
  fields: string[],
  expressionFields: StudioExpressionField[],
  sourceId: string | undefined,
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
 */
export function buildQueryDescriptor(
  widget: StudioWidget,
  filters: StudioFilterState[],
  activePageId: string,
  tableName?: string,
  expressionFields: StudioExpressionField[] = [],
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
  // Rank-mode filters (top/bottom-N) have no wire representation: `filterStateToLeaf` drops
  // `filterMode`, so a page-scoped rank filter would serialize as a bogus `field = <rankValue>`
  // predicate (the leaf's `value` is the N, e.g. 10) and the actual top-N reduction would never
  // run server-side. Strip them from the server filter tree; the rank reduction is applied
  // client-side after the fetch via `applyFilters` (the same `compileRowTest`/`applyFilters` path
  // the in-memory/sync path uses) — see `useWidgetRows`' adapter branch (finding 1.6).
  const filter = filtersToFilterNode(
    serverFilters.filter((f) => (f.filterMode ?? 'condition') !== 'rank'),
  );

  // Expression columns are expanded to the native columns they depend on — the server
  // returns the raw inputs and the expression is re-derived client-side.
  const select = expandToNativeFields(
    collectSelectFields(widget),
    expressionFields,
    widget.sourceId,
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
  const cacheKeySource = {
    sourceId: widget.sourceId,
    select: select.toSorted(),
    filter,
    groupBy,
    xGroupBy,
    aggregations,
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
    cacheKey,
  };
}
