import type {
  StudioExpression,
  StudioExpressionField,
  StudioFilterNode,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioWidget,
} from '../models';
import { resolveDateRangePresets } from './filterUtils';
import { isFieldExpression, isFunctionExpression } from '../utils/expressionEvaluator';

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
  const { config } = widget;
  const fields = new Set<string>();

  if (!config) {
    return [];
  }

  // Grid columns
  if (config.columns) {
    config.columns.forEach((col) => fields.add(col.fieldId));
  }
  if (config.gridGroupByField) {
    fields.add(config.gridGroupByField);
  }
  if (config.gridSortField) {
    fields.add(config.gridSortField);
  }
  if (config.crossFilterField) {
    fields.add(config.crossFilterField);
  }

  // Chart fields
  if (config.xField) {
    fields.add(config.xField);
  }
  if (config.yField) {
    fields.add(config.yField);
  }
  if (config.yField2) {
    fields.add(config.yField2);
  }
  if (config.seriesField) {
    fields.add(config.seriesField);
  }
  if (config.scatterColorField) {
    fields.add(config.scatterColorField);
  }
  if (config.scatterSizeField) {
    fields.add(config.scatterSizeField);
  }
  if (config.ySeries) {
    config.ySeries.forEach((s) => {
      if (!s.fieldId) {
        return;
      }
      // Foreign-source blended series are fetched independently from their own
      // source (see useChartWidgetData's blend path). Pulling them into the
      // widget's primary query would force a cross-source JOIN and can clash on a
      // shared column such as the category axis present in both sources.
      if (s.sourceId && s.sourceId !== widget.sourceId) {
        return;
      }
      fields.add(s.fieldId);
    });
  }

  // KPI fields
  if (config.kpiValueField) {
    fields.add(config.kpiValueField);
  }
  if (config.kpiSparklineField) {
    // Skip sparkline field when it belongs to a different source — the KPI widget
    // resolves it via in-memory join (resolveChartRowsForAggregation), so it must
    // not be SELECTed from the widget's primary table (causes "no such column" SQL errors).
    const sparklineSourceId = config.kpiSparklineSourceId;
    if (!sparklineSourceId || sparklineSourceId === widget.sourceId) {
      fields.add(config.kpiSparklineField);
    }
  }

  // Pivot fields
  if (config.pivotRowField) {
    fields.add(config.pivotRowField);
  }
  if (config.pivotColField) {
    fields.add(config.pivotColField);
  }
  if (config.pivotValueField) {
    fields.add(config.pivotValueField);
  }

  // Funnel reached-depth field (used by aggregateFunnelReached for cumulative funnel / step-conversion)
  if (config.funnelReachedField) {
    fields.add(config.funnelReachedField);
  }

  // Heatmap fields
  if (config.heatYField) {
    fields.add(config.heatYField);
  }

  // Sankey target ("to") node field (source uses xField, value uses yField)
  if (config.sankeyTargetField) {
    fields.add(config.sankeyTargetField);
  }

  // Gantt chart fields
  if (config.ganttLabelField) {
    fields.add(config.ganttLabelField);
  }
  if (config.ganttStartField) {
    fields.add(config.ganttStartField);
  }
  if (config.ganttEndField) {
    fields.add(config.ganttEndField);
  }
  if (config.ganttColorField) {
    fields.add(config.ganttColorField);
  }

  // Map / choropleth fields
  if (config.mapCountryField) {
    fields.add(config.mapCountryField);
  }
  if (config.mapValueField) {
    fields.add(config.mapValueField);
  }

  return [...fields].filter(Boolean);
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

type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';

function buildAggregations(
  widget: StudioWidget,
  expressionFields: StudioExpressionField[] = [],
): { field: string; fn: AggFn; alias: string }[] | undefined {
  const { config } = widget;
  const aggs: { field: string; fn: AggFn; alias: string }[] = [];

  if (!config) {
    return undefined;
  }

  // Expression-field aggregations cannot be pushed to the server (no physical column,
  // and a computed-column aggregate is not a column aggregate). They are dropped here
  // and recomputed client-side from the enriched raw rows.
  const isExpr = (fieldId: string): boolean =>
    isExpressionField(fieldId, expressionFields, widget.sourceId);

  // Single Y field — skip scatter (raw rows, no aggregation) and gantt (no yField anyway)
  if (config.yField && config.chartType !== 'scatter' && !isExpr(config.yField)) {
    const fn = (config.yAggregation as AggFn | undefined) ?? 'sum';
    aggs.push({ field: config.yField, fn, alias: config.yField });
  }

  // Multiple Y series — use per-series aggregation function. Foreign-source blended
  // series are queried separately against their own source, so they are excluded here.
  if (config.ySeries) {
    config.ySeries.forEach((s) => {
      if (!s.fieldId || (s.sourceId && s.sourceId !== widget.sourceId) || isExpr(s.fieldId)) {
        return;
      }
      const fn = (s.yAggregation as AggFn | undefined) ?? 'sum';
      aggs.push({ field: s.fieldId, fn, alias: s.fieldId });
    });
  }

  // KPI
  if (config.kpiValueField && !isExpr(config.kpiValueField)) {
    const fn = (config.kpiAggregation as AggFn | undefined) ?? 'sum';
    aggs.push({ field: config.kpiValueField, fn, alias: config.kpiValueField });
  }

  // Grid with groupBy — emit per-column aggregations so async adapters receive them
  if (widget.kind === 'grid' && config.gridGroupByField) {
    // Prefer per-column aggregationFn from StudioGridColumn, fall back to gridAggregations
    if (config.columns?.length) {
      config.columns.forEach((col) => {
        const fn =
          (col.aggregationFn as AggFn | undefined) ??
          (config.gridAggregations?.[col.fieldId] as AggFn | undefined);
        if (fn && col.fieldId !== config.gridGroupByField && !isExpr(col.fieldId)) {
          aggs.push({ field: col.fieldId, fn, alias: col.fieldId });
        }
      });
    } else if (config.gridAggregations) {
      Object.entries(config.gridAggregations).forEach(([field, fn]) => {
        if (!isExpr(field)) {
          aggs.push({ field, fn: fn as AggFn, alias: field });
        }
      });
    }
  }

  // Map / choropleth — aggregate the value field per country for db-tier push-down
  if (widget.kind === 'map' && config.mapValueField && !isExpr(config.mapValueField)) {
    const fn = (config.mapAggregation as AggFn | undefined) ?? 'sum';
    aggs.push({ field: config.mapValueField, fn, alias: config.mapValueField });
  }

  // Pivot table — aggregate the value field per (row, col) for db-tier push-down
  if (widget.kind === 'pivot' && config.pivotValueField && !isExpr(config.pivotValueField)) {
    const fn = (config.pivotAggregation as AggFn | undefined) ?? 'sum';
    aggs.push({ field: config.pivotValueField, fn, alias: config.pivotValueField });
  }

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
  const pageFilters = filters.filter((f) => f.scope === 'page');
  const widgetFilters = filters.filter(
    (f) => f.scope === 'widget' && f.widgetId === widget.id && f.filterMode !== 'rank',
  );
  const crossFilters = filters.filter(
    (f) =>
      f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id && f.pageId === activePageId,
  );
  const interactiveFilters = filters.filter(
    (f) => f.scope === 'interactive' && f.sourceWidgetId !== widget.id && f.pageId === activePageId,
  );

  const allFilters = resolveDateRangePresets([
    ...pageFilters,
    ...widgetFilters,
    ...crossFilters,
    ...interactiveFilters,
  ]);
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
