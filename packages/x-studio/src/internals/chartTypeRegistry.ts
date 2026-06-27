/**
 * Chart-type registry.
 *
 * Each entry describes how to extract fields and build aggregation specs for a
 * specific chart type (or widget kind). `queryDescriptor.ts` delegates to this
 * registry so the branching logic is centralised here and the descriptor builder
 * stays thin.
 */

import type { StudioChartType, StudioWidgetKind } from '../models/baseTypes';
import type { StudioWidgetConfig } from '../models/widgetTypes';

// ── Public types ──────────────────────────────────────────────────────────────

export type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';
export type AggSpec = { field: string; fn: AggFn; alias: string };

/**
 * Descriptor for a single chart type (or widget kind).
 *
 * `collectFields` — returns the field IDs that must appear in the SELECT clause
 *   for this type.  Receives:
 *     • `config`          — the widget config object
 *     • `widgetSourceId`  — the widget's own sourceId; required to guard
 *                           foreign-source sparkline / ySeries fields
 *
 * `buildAggregationSpecs` — returns the aggregation specs for db-tier push-down.
 *   Receives:
 *     • `config`          — the widget config
 *     • `isExpr`          — predicate returning true when a field ID is an
 *                           expression field (computed client-side, not aggregated)
 *     • `widgetSourceId`  — the widget's own sourceId; required to exclude
 *                           foreign-source ySeries from aggregations
 */
export interface ChartTypeDescriptor {
  collectFields(config: StudioWidgetConfig, widgetSourceId: string | undefined): string[];
  buildAggregationSpecs(
    config: StudioWidgetConfig,
    isExpr: (id: string) => boolean,
    widgetSourceId: string | undefined,
  ): AggSpec[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Adds `value` to `set` only when it is a non-empty string. */
function addField(set: Set<string>, value: string | undefined | null): void {
  if (value) {
    set.add(value);
  }
}

/**
 * Collects common x/y/series fields shared by most simple chart types (bar,
 * line, area, pie, donut, gauge …).
 */
function collectXYSeriesFields(
  config: StudioWidgetConfig,
  widgetSourceId: string | undefined,
): Set<string> {
  const fields = new Set<string>();
  addField(fields, config.xField);
  addField(fields, config.yField);
  addField(fields, config.yField2);
  addField(fields, config.seriesField);

  // Multi-series — skip foreign-source blended series; those are fetched
  // independently against their own source.
  if (config.ySeries) {
    config.ySeries.forEach((s) => {
      if (!s.fieldId) {
        return;
      }
      if (s.sourceId && s.sourceId !== widgetSourceId) {
        return;
      }
      fields.add(s.fieldId);
    });
  }

  return fields;
}

/**
 * Builds yField / ySeries aggregations that are common to most chart types.
 * Scatter and gantt are excluded (they use raw rows).
 */
function buildXYAggSpecs(
  config: StudioWidgetConfig,
  isExpr: (id: string) => boolean,
  widgetSourceId: string | undefined,
): AggSpec[] {
  const aggs: AggSpec[] = [];

  if (config.yField && !isExpr(config.yField)) {
    const fn = (config.yAggregation as AggFn | undefined) ?? 'sum';
    aggs.push({ field: config.yField, fn, alias: config.yField });
  }

  if (config.ySeries) {
    config.ySeries.forEach((s) => {
      if (!s.fieldId || (s.sourceId && s.sourceId !== widgetSourceId) || isExpr(s.fieldId)) {
        return;
      }
      const fn = (s.yAggregation as AggFn | undefined) ?? 'sum';
      aggs.push({ field: s.fieldId, fn, alias: s.fieldId });
    });
  }

  return aggs;
}

// ── Descriptors ───────────────────────────────────────────────────────────────

/**
 * Generic x/y/series descriptor used by bar, line, area, mixed, pie, donut,
 * gauge and any unknown chart type that falls back here.
 */
const xyDescriptor: ChartTypeDescriptor = {
  collectFields(config, widgetSourceId) {
    return [...collectXYSeriesFields(config, widgetSourceId)].filter(Boolean);
  },
  buildAggregationSpecs(config, isExpr, widgetSourceId) {
    return buildXYAggSpecs(config, isExpr, widgetSourceId);
  },
};

/**
 * Scatter charts return raw rows — no aggregations.
 */
const scatterDescriptor: ChartTypeDescriptor = {
  collectFields(config, widgetSourceId) {
    const fields = collectXYSeriesFields(config, widgetSourceId);
    addField(fields, config.scatterColorField);
    addField(fields, config.scatterSizeField);
    return [...fields].filter(Boolean);
  },
  buildAggregationSpecs() {
    // Scatter plots show individual data points — no server-side aggregation.
    return [];
  },
};

/**
 * Heatmap: x-axis (column) + y-axis row field + value (intensity) field.
 */
const heatmapDescriptor: ChartTypeDescriptor = {
  collectFields(config) {
    const fields = new Set<string>();
    addField(fields, config.xField);
    addField(fields, config.yField); // intensity / colour value
    addField(fields, config.heatYField); // row axis
    return [...fields].filter(Boolean);
  },
  buildAggregationSpecs(config, isExpr) {
    const aggs: AggSpec[] = [];
    if (config.yField && !isExpr(config.yField)) {
      const fn = (config.yAggregation as AggFn | undefined) ?? 'sum';
      aggs.push({ field: config.yField, fn, alias: config.yField });
    }
    return aggs;
  },
};

/**
 * Funnel: category (xField) + value (yField) + optional cumulative-reached field.
 * The `funnelReachedField` regression fix (commit 07d66182) ensures that field
 * is always included in the SELECT when set.
 */
const funnelDescriptor: ChartTypeDescriptor = {
  collectFields(config) {
    const fields = new Set<string>();
    addField(fields, config.xField);
    addField(fields, config.yField);
    // Regression fix (commit 07d66182): always include funnelReachedField.
    addField(fields, config.funnelReachedField);
    return [...fields].filter(Boolean);
  },
  buildAggregationSpecs(config, isExpr) {
    const aggs: AggSpec[] = [];
    if (config.yField && !isExpr(config.yField)) {
      const fn = (config.yAggregation as AggFn | undefined) ?? 'sum';
      aggs.push({ field: config.yField, fn, alias: config.yField });
    }
    return aggs;
  },
};

/**
 * Gantt / timeline: label + start date + end date + optional colour field.
 * No aggregation (raw rows).
 */
const ganttDescriptor: ChartTypeDescriptor = {
  collectFields(config) {
    const fields = new Set<string>();
    addField(fields, config.ganttLabelField);
    addField(fields, config.ganttStartField);
    addField(fields, config.ganttEndField);
    addField(fields, config.ganttColorField);
    return [...fields].filter(Boolean);
  },
  buildAggregationSpecs() {
    // Gantt shows raw timeline rows — no aggregation.
    return [];
  },
};

/**
 * Sankey diagram: source (xField) + target + link weight (yField).
 */
const sankeyDescriptor: ChartTypeDescriptor = {
  collectFields(config) {
    const fields = new Set<string>();
    addField(fields, config.xField);
    addField(fields, config.yField);
    addField(fields, config.sankeyTargetField);
    return [...fields].filter(Boolean);
  },
  buildAggregationSpecs(config, isExpr) {
    const aggs: AggSpec[] = [];
    if (config.yField && !isExpr(config.yField)) {
      const fn = (config.yAggregation as AggFn | undefined) ?? 'sum';
      aggs.push({ field: config.yField, fn, alias: config.yField });
    }
    return aggs;
  },
};

// ── Widget-kind descriptors ───────────────────────────────────────────────────

/**
 * KPI widget descriptor.
 *
 * Key invariant (commit dd2e96b5): KPI aggregations must NOT be pushed to the
 * server. KPIs aggregate client-side via `computeAggregate`. Sending aggregations
 * triggers the db-tier which returns 1 pre-aggregated row; `COUNT([1 row])` = 1,
 * not the real row count.
 *
 * Sparkline field guard (commit eb140b29): when `kpiSparklineSourceId` is set
 * and differs from the widget's own sourceId, the field belongs to a related
 * source; it must NOT appear in the primary SELECT (causes "no such column" SQL
 * errors). The in-memory join in `resolveChartRowsForAggregation` handles it.
 */
const kpiDescriptor: ChartTypeDescriptor = {
  collectFields(config, widgetSourceId) {
    const fields = new Set<string>();
    addField(fields, config.kpiValueField);
    if (config.kpiSparklineField) {
      const sparklineSourceId = config.kpiSparklineSourceId;
      // Only include when the sparkline field belongs to this widget's source.
      if (!sparklineSourceId || sparklineSourceId === widgetSourceId) {
        fields.add(config.kpiSparklineField);
      }
    }
    return [...fields].filter(Boolean);
  },
  buildAggregationSpecs() {
    // KPI always aggregates client-side — never push to the server.
    return [];
  },
};

/**
 * Grid widget descriptor.
 * Aggregations are emitted only when gridGroupByField is set.
 */
const gridDescriptor: ChartTypeDescriptor = {
  collectFields(config) {
    const fields = new Set<string>();
    if (config.columns) {
      config.columns.forEach((col) => addField(fields, col.fieldId));
    }
    addField(fields, config.gridGroupByField);
    addField(fields, config.gridSortField);
    addField(fields, config.crossFilterField);
    return [...fields].filter(Boolean);
  },
  buildAggregationSpecs(config, isExpr) {
    if (!config.gridGroupByField) {
      return [];
    }
    const aggs: AggSpec[] = [];
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
    return aggs;
  },
};

/**
 * Map / choropleth widget descriptor.
 */
const mapDescriptor: ChartTypeDescriptor = {
  collectFields(config) {
    const fields = new Set<string>();
    addField(fields, config.mapCountryField);
    addField(fields, config.mapValueField);
    return [...fields].filter(Boolean);
  },
  buildAggregationSpecs(config, isExpr) {
    const aggs: AggSpec[] = [];
    if (config.mapValueField && !isExpr(config.mapValueField)) {
      const fn = (config.mapAggregation as AggFn | undefined) ?? 'sum';
      aggs.push({ field: config.mapValueField, fn, alias: config.mapValueField });
    }
    return aggs;
  },
};

/**
 * Pivot table descriptor.
 */
const pivotDescriptor: ChartTypeDescriptor = {
  collectFields(config) {
    const fields = new Set<string>();
    addField(fields, config.pivotRowField);
    addField(fields, config.pivotColField);
    addField(fields, config.pivotValueField);
    return [...fields].filter(Boolean);
  },
  buildAggregationSpecs(config, isExpr) {
    const aggs: AggSpec[] = [];
    if (config.pivotValueField && !isExpr(config.pivotValueField)) {
      const fn = (config.pivotAggregation as AggFn | undefined) ?? 'sum';
      aggs.push({ field: config.pivotValueField, fn, alias: config.pivotValueField });
    }
    return aggs;
  },
};

// ── Registry maps ─────────────────────────────────────────────────────────────

/**
 * Registry keyed by `StudioChartType`.
 * Chart widgets use `widget.config.chartType` to look up their descriptor.
 *
 * `satisfies Record<StudioChartType, ...>` enforces at compile time that every
 * value of `StudioChartType` has a descriptor entry — adding a new chart type
 * to the union without registering it here becomes a type error immediately.
 */
const chartTypeRegistry = {
  bar: xyDescriptor,
  'bar-stacked': xyDescriptor,
  'bar-100': xyDescriptor,
  line: xyDescriptor,
  area: xyDescriptor,
  'area-stacked': xyDescriptor,
  'area-100': xyDescriptor,
  mixed: xyDescriptor,
  pie: xyDescriptor,
  donut: xyDescriptor,
  gauge: xyDescriptor,
  heatmap: heatmapDescriptor,
  funnel: funnelDescriptor,
  gantt: ganttDescriptor,
  sankey: sankeyDescriptor,
  scatter: scatterDescriptor,
} satisfies Record<StudioChartType, ChartTypeDescriptor>;

/**
 * Registry keyed by `StudioWidgetKind` for widget kinds that are not `'chart'`.
 * Chart widgets are dispatched via `chartTypeRegistry` instead.
 */
const widgetKindRegistry: Partial<Record<StudioWidgetKind, ChartTypeDescriptor>> = {
  grid: gridDescriptor,
  kpi: kpiDescriptor,
  map: mapDescriptor,
  pivot: pivotDescriptor,
};

// ── Public lookup ─────────────────────────────────────────────────────────────

/**
 * Returns the `ChartTypeDescriptor` for the given widget kind / chart type.
 *
 * Resolution order:
 *  1. If `kind === 'chart'`, look up `config.chartType` in `chartTypeRegistry`.
 *  2. Otherwise look up `kind` in `widgetKindRegistry`.
 *  3. Fall back to `xyDescriptor` (covers unknown/custom types gracefully).
 */
export function getDescriptor(
  kind: StudioWidgetKind,
  config: StudioWidgetConfig,
): ChartTypeDescriptor {
  if (kind === 'chart') {
    return chartTypeRegistry[config.chartType as StudioChartType] ?? xyDescriptor;
  }
  return widgetKindRegistry[kind] ?? xyDescriptor;
}
