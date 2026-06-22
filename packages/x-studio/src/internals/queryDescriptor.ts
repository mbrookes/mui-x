import type {
  StudioExpression,
  StudioExpressionField,
  StudioFilterNode,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioWidget,
} from '../models';
import { selectFiltersForWidget } from './filterScoping';
import {
  isFieldExpression,
  isFunctionExpression,
  isJoinFieldExpression,
} from '../utils/expressionEvaluator';
import { getDescriptor } from './chartTypeRegistry';
import type { AggFn } from './chartTypeRegistry';

function sortedStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(sortedStringify).join(',')}]`;
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${sortedStringify((value as Record<string, unknown>)[k])}`);
  return `{${sorted.join(',')}}`;
}

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

function collectExpressionRefs(expr: StudioExpression): string[] {
  const refs: string[] = [];
  const walk = (node: StudioExpression): void => {
    if (isFieldExpression(node)) {
      refs.push(node.id);
    } else if (isFunctionExpression(node)) {
      node.inputs.forEach(walk);
    }
    // JoinFieldExpression / ValueExpression reference no native column on this source.
  };
  walk(expr);
  return refs;
}

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
 * Only filters scoped to this widget (page, widget, cross-filter from others,
 * interactive from others) are included — same scoping as the sync pipeline.
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
  const allFilters = selectFiltersForWidget(filters, {
    widgetId: widget.id,
    widgetSourceId: widget.sourceId,
    activePageId,
  });
  const filter = filtersToFilterNode(allFilters);

  // Expression columns are expanded to the native columns they depend on — the server
  // returns the raw inputs and the expression is re-derived client-side.
  const select = expandToNativeFields(
    collectSelectFields(widget),
    expressionFields,
    widget.sourceId,
  );
  const groupBy = widget.config?.xField ?? widget.config?.gridGroupByField;
  const xGroupBy = widget.config?.xGroupBy;
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
  const cacheKey = `${widget.sourceId}:${sortedStringify(cacheKeySource)}`;

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
