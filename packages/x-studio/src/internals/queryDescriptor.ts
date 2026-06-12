import type {
  StudioFilterNode,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioWidget,
} from '../models';

// ── Simple stable hash ──────────────────────────────────────────────────────

/**
 * Produces a deterministic string key from any JSON-serializable value.
 * Used as a cache key for StudioQueryDescriptor.
 */
export function stableHash(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

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
    config.ySeries.forEach((s) => fields.add(s.fieldId));
  }

  // KPI fields
  if (config.kpiValueField) {
    fields.add(config.kpiValueField);
  }
  if (config.kpiSparklineField) {
    fields.add(config.kpiSparklineField);
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

  // Heatmap fields
  if (config.heatYField) {
    fields.add(config.heatYField);
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

// ── Aggregations builder ────────────────────────────────────────────────────

type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';

function buildAggregations(
  widget: StudioWidget,
): { field: string; fn: AggFn; alias: string }[] | undefined {
  const { config } = widget;
  const aggs: { field: string; fn: AggFn; alias: string }[] = [];

  if (!config) {
    return undefined;
  }

  // Single Y field
  if (config.yField) {
    const fn = (config.yAggregation as AggFn | undefined) ?? 'sum';
    aggs.push({ field: config.yField, fn, alias: config.yField });
  }

  // Multiple Y series — StudioChartSeries has no aggregation field; default to 'sum'
  if (config.ySeries) {
    config.ySeries.forEach((s) => {
      aggs.push({ field: s.fieldId, fn: 'sum', alias: s.fieldId });
    });
  }

  // KPI
  if (config.kpiValueField) {
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
        if (fn && col.fieldId !== config.gridGroupByField) {
          aggs.push({ field: col.fieldId, fn, alias: col.fieldId });
        }
      });
    } else if (config.gridAggregations) {
      Object.entries(config.gridAggregations).forEach(([field, fn]) => {
        aggs.push({ field, fn: fn as AggFn, alias: field });
      });
    }
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
 */
export function buildQueryDescriptor(
  widget: StudioWidget,
  filters: StudioFilterState[],
  activePageId: string,
  tableName?: string,
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

  const allFilters = [...pageFilters, ...widgetFilters, ...crossFilters, ...interactiveFilters];
  const filter = filtersToFilterNode(allFilters);

  const select = collectSelectFields(widget);
  const groupBy = widget.config?.xField ?? widget.config?.gridGroupByField;
  const xGroupBy = widget.config?.xGroupBy;
  const aggregations = buildAggregations(widget);

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
