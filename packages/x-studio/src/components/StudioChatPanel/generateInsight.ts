/**
 * Widget data-summary utilities.
 *
 * Despite the historical file name, this module no longer generates insights — the
 * client no longer calls any `/insight` or `/title` endpoint. Insight generation now
 * happens entirely server-side (in `x-studio-ai-middleware`); the client's only job is
 * to build a compact, pipeline-filtered summary of a widget's data. This module owns:
 *
 * - `buildWidgetDataSummary` — a CSV-style sample + numeric stats block for a widget,
 *   attached to AI chat requests (`studioBackendAdapter`) and text-widget generation
 *   (`useTextWidgetAI`).
 * - `numericStats` — min/max/mean/… over a numeric column (also used by `richContext`).
 */
import type { StudioKpiAggregation } from '../../models/baseTypes';
import type { StudioState, StudioFilterState } from '../../models/stateTypes';
import type { StudioWidget, StudioWidgetConfig } from '../../models/widgetTypes';
import type { StudioDataSource } from '../../models/dataTypes';
import type { StudioExpressionField } from '../../models/expressionTypes';
import { createStudioPipeline, type StudioPipelineState } from '../../internals/StudioPipeline';
import { selectFiltersForWidget } from '../../internals/filterScoping';
import {
  enrichWithCrossSourceFields,
  enrichWithCrossSourceColumns,
} from '../../internals/crossSourceEnrichment';
import { normalizeToAlpha2, normalizeToStateAbbr } from '../widgets/StudioMapWidget/countryUtils';
import {
  computeAggregate,
  findDateFilter,
  extractDateRange,
  computePreviousPeriodRange,
  toLocalYmd,
} from '../widgets/StudioKpiWidget/kpiUtils';
import {
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
  aggregateHeatmap,
  applyRankToAggregated,
  applyRankToMultiSeries,
  applyRankToSeriesFieldData,
  resolveChartRowsForAggregation,
  type AggregatedData,
  type MultiSeriesData,
  type MultiYSeriesData,
  type HeatmapData,
} from '../../internals/chartAggregation';
import { canDetectAnomalies, detectChartDataAnomalies } from '../../internals/anomalyDetection';

// ── Internal helpers ──────────────────────────────────────────────────────────

const MAX_DATA_ROWS = 100;

interface DataSummaryOptions {
  /**
   * Row selection strategy when the dataset exceeds the row cap:
   * - `'aggregate'`: bucket rows into groups and aggregate numeric fields per bucket —
   *   best for summary/analysis/forecast on dense time-series (every period represented)
   * - `'stride'`: evenly distributed sample — kept for non-numeric/non-time widget kinds
   * - `'anomaly'`: guarantees anomaly rows are included, fills remainder with stride —
   *   never aggregate here (would smooth out the outliers)
   */
  sampling?: 'stride' | 'aggregate' | 'anomaly';
  /** X-axis values identifying anomaly rows — only used when sampling === 'anomaly' */
  anomalyAxisValues?: string[];
  /**
   * Maximum number of rows/buckets to include in the CSV sample.
   * Defaults to MAX_DATA_ROWS (100). Use a smaller value (e.g. 15) for contexts
   * where token budget is tight, such as the `summarise_page` tool snapshot.
   * The numeric stats block (min/max/mean) is always computed from the full dataset.
   */
  maxRows?: number;
}

function selectSampleRows(
  rows: Record<string, unknown>[],
  options: DataSummaryOptions,
  xFieldId: string | undefined,
): { sample: Record<string, unknown>[]; label: string } {
  const total = rows.length;
  const maxRows = options.maxRows ?? MAX_DATA_ROWS;
  if (total <= maxRows) {
    return { sample: rows, label: `${total} row${total !== 1 ? 's' : ''}` };
  }

  const { sampling = 'stride', anomalyAxisValues = [] } = options;

  if (sampling === 'anomaly' && xFieldId && anomalyAxisValues.length > 0) {
    // Reserve slots for anomaly row indices FIRST (up to maxRows), then fill any
    // remaining budget with a stride-based sample. Reserving anomalies first is
    // required for the "guarantees anomaly rows are included" contract to actually
    // hold: a stride sample alone already numbers close to maxRows, so merging
    // stride-first and slicing to maxRows would silently drop anomalies that land
    // late in the dataset.
    const anomalySet = new Set(anomalyAxisValues.map(String));
    const anomalyIndices = rows
      .reduce<number[]>((acc, r, i) => {
        if (anomalySet.has(String(r[xFieldId] ?? ''))) {
          acc.push(i);
        }
        return acc;
      }, [])
      .slice(0, maxRows);
    const remaining = maxRows - anomalyIndices.length;
    let strideIndices: number[] = [];
    if (remaining > 0) {
      const stride = Math.ceil(total / remaining);
      strideIndices = rows.flatMap((_, i) => (i % stride === 0 ? [i] : []));
    }
    const allIndices = [...new Set([...anomalyIndices, ...strideIndices])]
      .toSorted((a, b) => a - b)
      .slice(0, maxRows);
    return {
      sample: allIndices.map((i) => rows[i]),
      label: `${allIndices.length} of ${total} rows (including anomaly points)`,
    };
  }

  // stride (default) — distributed sample covers the full date/value range
  const stride = Math.ceil(total / maxRows);
  const sample = rows.filter((_, i) => i % stride === 0).slice(0, maxRows);
  return {
    sample,
    label: `${sample.length} of ${total} rows (sampled)`,
  };
}

type SourceField = { id: string; label?: string; type?: string; aiAggregation?: string };

/**
 * Merges a data source's own fields with its own-source expression fields (calculated
 * columns / measures) so field-metadata lookups (numeric-stats type detection, label
 * resolution) recognize expression-derived fields too — mirrors `widgetExport.ts`'s
 * `ownExpressionFields` filter. Without this, `buildNumericStats` only ever saw
 * `source.fields`, so a calculated-column value/measure field (which has no entry in
 * `source.fields`) got no stats line even when it's exactly the field the widget
 * aggregates (finding 2.5).
 */
function sourceFieldsWithExpressions(
  source: StudioDataSource,
  expressionFields: StudioExpressionField[],
): SourceField[] {
  return [...source.fields, ...expressionFields.filter((ef) => ef.sourceId === source.id)];
}

/**
 * Aggregates rows into at most MAX_DATA_ROWS buckets by computing per-bucket
 * statistics for numeric fields and taking the first value for others.
 *
 * This ensures every part of the date range is represented — nothing is silently
 * dropped between stride points — making it the best choice for summary, analysis,
 * and forecast on dense time-series data.
 */
function aggregateRows(
  rows: Record<string, unknown>[],
  fieldIds: string[],
  sourceFields: SourceField[],
  maxRows: number = MAX_DATA_ROWS,
): { sample: Record<string, unknown>[]; label: string } {
  const total = rows.length;
  if (total <= maxRows) {
    return { sample: rows, label: `${total} row${total !== 1 ? 's' : ''}` };
  }

  const bucketSize = Math.ceil(total / maxRows);
  const sample: Record<string, unknown>[] = [];

  const fieldById = new Map(sourceFields.map((f) => [f.id, f]));

  for (let i = 0; i < total; i += bucketSize) {
    const bucket = rows.slice(i, i + bucketSize);
    const row: Record<string, unknown> = {};

    for (const id of fieldIds) {
      const field = fieldById.get(id);
      const isNumeric = field?.type === 'number';
      const aggFn = field?.aiAggregation ?? (isNumeric ? 'avg' : 'first');

      if (aggFn === 'first' || !isNumeric) {
        row[id] = bucket[0][id];
      } else {
        const nums = bucket
          .map((r) => r[id])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        if (nums.length === 0) {
          row[id] = null;
        } else if (aggFn === 'sum') {
          row[id] = nums.reduce((a, b) => a + b, 0);
        } else if (aggFn === 'min') {
          // Reduce with a loop instead of `Math.min(...nums)`: spreading a large
          // array as call arguments throws `RangeError: Maximum call stack size
          // exceeded` once it exceeds ~65k–125k elements (finding 2.13). A bucket
          // here can hold up to `ceil(totalRows / maxRows)` values, so a large
          // source can still overflow a single bucket. Mirrors `numericStats`
          // below and `aggregateNumbers` in `internals/aggregate.ts`.
          row[id] = nums.reduce((acc, v) => (v < acc ? v : acc));
        } else if (aggFn === 'max') {
          row[id] = nums.reduce((acc, v) => (v > acc ? v : acc));
        } else {
          // avg (default for number fields)
          const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
          row[id] = Math.round(avg * 100) / 100;
        }
      }
    }

    sample.push(row);
  }

  return {
    sample,
    label: `${sample.length} aggregated buckets of ~${bucketSize} rows (${total} total)`,
  };
}

/**
 * Computes min / max / mean / median for a list of finite numbers.
 * Returns `null` for an empty input. Shared between the per-widget data summary
 * and the richer AI context builder so there is a single implementation.
 */
export function numericStats(
  values: number[],
): { min: number; max: number; mean: number; median: number } | null {
  if (values.length === 0) {
    return null;
  }
  // Reduce with a loop instead of `Math.min(...values)` / `Math.max(...values)`:
  // spreading a large array as call arguments throws `RangeError: Maximum call
  // stack size exceeded` once it exceeds ~65k–125k elements (finding 2.13). This
  // function receives ALL filtered rows (no sampling cap), so a 100k+-row source
  // would otherwise crash every chat send synchronously in the pageSnapshot build.
  // Mirrors `aggregateNumbers` in `internals/aggregate.ts`, which avoids the spread
  // for exactly this reason.
  const min = values.reduce((acc, v) => (v < acc ? v : acc));
  const max = values.reduce((acc, v) => (v > acc ? v : acc));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { min, max, mean, median };
}

function buildNumericStats(
  rows: Record<string, unknown>[],
  fieldIds: string[],
  sourceFields: Array<{ id: string; label?: string; type?: string }>,
): string {
  const fieldById = new Map(sourceFields.map((f) => [f.id, f]));
  const parts: string[] = [];
  for (const id of fieldIds) {
    const field = fieldById.get(id);
    if (field?.type !== 'number') {
      continue;
    }
    const values = rows
      .map((r) => r[id])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const stats = numericStats(values);
    if (!stats) {
      continue;
    }
    parts.push(
      `${field.label ?? id}: min=${stats.min}, max=${stats.max}, mean=${Math.round(stats.mean)}, median=${Math.round(stats.median)}`,
    );
  }
  return parts.join(' | ');
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Builds the flat `StudioPipelineState` shape `createStudioPipeline` needs from the
 * lifetime-partitioned `StudioState`. Passed explicitly (rather than the nested
 * `StudioState` itself) so this call site doesn't depend on `createStudioPipeline`
 * unwrapping `doc`/`runtime` internally — the flat shape is the pipeline's own
 * documented "built manually" input.
 *
 * Must forward `globalCrossFilterMode` and `crossFilterAllPages` (finding 2.4): the
 * pipeline resolves its effective cross-filter mode as
 * `globalCrossFilterMode ?? options?.widgetCrossFilterMode ?? 'cross-highlight'` and scopes
 * cross-filters to all pages when `crossFilterAllPages` is set. Dropping them here meant
 * the snapshot's L3 rows always resolved cross-filters as if both dashboard settings were
 * unset, while `buildChartWidgetSummary`'s L4 `widgetFilters` (below) read them directly
 * off `state.doc.dashboard` — the two layers could disagree within this one code path.
 *
 * The pipeline honours both fields unconditionally now (they are no longer gated behind
 * passing `options`), but that does NOT make this forwarding redundant: it can only honour
 * what the snapshot carries, and a flat `StudioPipelineState` that omits them still reads
 * as "both unset". This is the one hazard left in the flat-shape input.
 */
function toPipelineState(state: StudioState): StudioPipelineState {
  return {
    dataSources: state.runtime.dataSources,
    relationships: state.doc.relationships,
    expressionFields: state.doc.expressionFields,
    filters: state.doc.filters,
    crossFilterAllPages: state.doc.dashboard.crossFilterAllPages,
    globalCrossFilterMode: state.doc.dashboard.globalCrossFilterMode,
  };
}

function buildKpiWidgetSummary(
  widget: StudioWidget,
  source: StudioDataSource,
  filteredRows: Record<string, unknown>[],
  state: StudioState,
  dateFilter: StudioFilterState | undefined,
  currentRange: { start: Date; end: Date } | null,
): string {
  // Read config through the flat cross-kind `StudioWidgetConfig` patch type:
  // these summary builders are dispatched generically by kind and are not
  // statically narrowed to a single-kind widget at their call sites.
  const cfg: StudioWidgetConfig = widget.config;
  const valueField: string | undefined = cfg.kpiValueField;
  const agg: string = cfg.kpiAggregation ?? (valueField ? 'sum' : 'count');

  if (!valueField && agg !== 'count') {
    return '';
  }

  const value = computeAggregate(filteredRows, valueField ?? '', agg as StudioKpiAggregation);
  // `null` means "no data" (every row's value was null/non-numeric for avg/min/max),
  // which is distinct from a real 0. Emitting "Value: 0" here would state a measured
  // result the data does not support, and the trend maths below would divide by it.
  if (value === null) {
    return '';
  }
  // Look up through the own-source + own-source-expression-fields merge (not just
  // `source.fields`) so a calculated-field (expression field) KPI value shows its
  // configured display label instead of its raw field id/expression (finding 2.x) —
  // mirrors the same `sourceFieldsWithExpressions` lookup used for `Stats:` below and
  // the widget-level render path's own-source-then-expression-field resolution.
  const fieldLabel = valueField
    ? (sourceFieldsWithExpressions(source, state.doc.expressionFields).find(
        (f) => f.id === valueField,
      )?.label ?? valueField)
    : 'rows';

  const lines: string[] = [
    `Aggregation: ${agg} of ${filteredRows.length} rows`,
    `Value: ${cfg.kpiPrefix ?? ''}${value}${cfg.kpiSuffix ?? ''} (${fieldLabel})`,
  ];

  if (cfg.kpiSparklinePlotType === 'gauge') {
    const gMax = cfg.kpiSparklineGaugeMax ?? 100;
    lines.push(`Gauge range: 0 – ${gMax}`);
  }

  // Trend: compare current value against previous period
  if (cfg.kpiTrend && valueField) {
    if (dateFilter && currentRange) {
      const comparisonMode = cfg.kpiTrendComparison ?? 'previous-period';
      const prevRange = computePreviousPeriodRange(
        currentRange.start,
        currentRange.end,
        comparisonMode,
      );
      const prevDateFilter: StudioFilterState = {
        ...dateFilter,
        // `dateFilter.dateRangePreset` (e.g. 'last_3_months') must NOT survive onto the
        // previous-period filter as-is: `resolveDateRangePresets` (run inside
        // `resolveWidgetRows` via `selectFiltersForWidget`) treats ANY non-'custom'
        // `dateRangePreset` as a signal to recompute `value` fresh from the preset using
        // TODAY — clobbering the explicit previous-period `value`/`value2` below right back
        // to the CURRENT period's window (an object shape the `operator`/`operator2` below
        // don't even expect), which silently zeroed every previous-period row and produced
        // "Previous period: 0" (finding 2.x). Marking this filter `'custom'` is what tells
        // that resolver to leave the explicit previous-period bounds alone.
        dateRangePreset: 'custom',
        operator: 'greater_than_or_equal',
        // `computePreviousPeriodRange` builds LOCAL-time boundaries, so serialize their local
        // calendar components — `toISOString().slice(0, 10)` round-trips through UTC and
        // day-shifts the bound for non-UTC viewers (finding 3.1, matching the KPI widget).
        value: toLocalYmd(prevRange.start),
        operator2: 'less_than_or_equal',
        value2: toLocalYmd(prevRange.end),
        conjunction: 'and',
      };
      const prevPipeline = createStudioPipeline({
        ...toPipelineState(state),
        filters: state.doc.filters.map((f) => (f.id === dateFilter.id ? prevDateFilter : f)),
      });
      // Passing the widget OBJECT makes this previous-period baseline resolve
      // `shouldApplyWidgetRankAtL3` exactly as `buildWidgetDataSummary`'s current-period
      // `resolveWidgetRows` call does, so the two periods are always ranked identically —
      // comparing a ranked current value against an unranked previous one is not possible.
      const prevRows = prevPipeline.resolveWidgetRows(
        widget,
        widget.sourceId as string,
        source.rows as Record<string, unknown>[],
        state.doc.dashboard.activePageId,
        {
          widgetCrossFilterMode: cfg.crossFilterMode,
        },
      );
      const prevValue = computeAggregate(prevRows, valueField, agg as StudioKpiAggregation);
      const label = comparisonMode === 'year-over-year' ? 'YoY' : 'vs previous period';
      lines.push(
        `Previous period (${formatDate(prevRange.start)} – ${formatDate(prevRange.end)}): ${cfg.kpiPrefix ?? ''}${prevValue ?? '—'}${cfg.kpiSuffix ?? ''}`,
      );
      // A `null` previous period has no measured value to compare against, so there is
      // no trend to state — same reason 0 is excluded (it would divide by zero).
      if (prevValue !== null && prevValue !== 0) {
        const delta = (value - prevValue) / Math.abs(prevValue);
        lines.push(`Trend: ${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}% ${label}`);
      }
    }
  }

  if (valueField) {
    const stats = buildNumericStats(
      filteredRows,
      [valueField],
      sourceFieldsWithExpressions(source, state.doc.expressionFields),
    );
    if (stats) {
      lines.push(`Stats: ${stats}`);
    }
  }

  return lines.join('\n');
}

const CHART_RAW_ROW_FALLBACK = new Set(['scatter', 'gantt', 'sankey']);

/**
 * Render an aggregated cell for the model-facing CSV summary.
 *
 * `null`/`undefined` mean the bucket had NOTHING measurable (see the aggregation layer's
 * `number | null` contract), which is not the same claim as `0`. These tables are read by
 * the LLM as fact, so an empty cell — the standard CSV encoding for a missing value — is
 * the honest rendering; `?? 0` would assert a measurement that was never taken and skew
 * any trend or comparison the model draws from it.
 * @param {number | null | undefined} value The aggregated value, or nullish when unmeasured.
 * @returns {string} The number as text, or an empty string when unmeasured.
 */
function insightCell(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function buildChartWidgetSummary(
  widget: StudioWidget,
  source: StudioDataSource,
  filteredRows: Record<string, unknown>[],
  state: StudioState,
  maxRows: number,
): string {
  // Read config through the flat cross-kind `StudioWidgetConfig` patch type:
  // these summary builders are dispatched generically by kind and are not
  // statically narrowed to a single-kind widget at their call sites.
  const cfg: StudioWidgetConfig = widget.config;
  const xField: string | undefined = cfg.xField;
  if (!xField) {
    return '';
  }

  type ChartAggFn = 'sum' | 'count' | 'avg' | 'min' | 'max';
  const chartType: string = cfg.chartType ?? 'bar';
  const seriesField: string | undefined = cfg.seriesField;
  const yField: string | undefined = cfg.yField;
  const ySeries: Array<{ fieldId: string; sourceId?: string; yAggregation?: ChartAggFn }> =
    cfg.ySeries ?? [];
  const xGroupBy = cfg.xGroupBy;
  const sortBy = cfg.chartSortBy;
  const sortDir = cfg.chartSortDirection;
  const xOrder = source.fields.find((f) => f.id === xField)?.orderedValues;

  // Mirror the live chart's data path (`useChartWidgetData.ts`) so the insight text
  // describes the SAME numbers the chart actually shows (finding 2.12):
  //  - `singleSeriesYAggregation`: the single-series / split-by measure honours its
  //    own per-series `yAggregation` with precedence over the widget-level default.
  //  - `yAggregationByField`: per-field aggregation map for the multi-Y path.
  //  - `rankFilter`: the widget's Top-N rank filter, applied post-aggregation.
  const singleSeriesYAggregation: ChartAggFn = (ySeries[0]?.yAggregation ??
    cfg.yAggregation ??
    'sum') as ChartAggFn;
  const yAggregationByField: Record<string, ChartAggFn> = {};
  for (const s of ySeries) {
    if (s.fieldId && s.yAggregation) {
      yAggregationByField[s.fieldId] = s.yAggregation;
    }
  }
  const rankFilter =
    state.doc.filters.find(
      (f) =>
        // `!f.disabled` mirrors `useChartWidgetData.ts`'s `widgetRankFilter` (the render path):
        // a disabled Top-N rank filter must NOT keep reducing this AI-facing summary to N
        // categories after the user toggles it off in the drawer (finding 2.1).
        !f.disabled &&
        f.scope.kind === 'widget' &&
        f.scope.widgetId === widget.id &&
        f.filterMode === 'rank',
    ) ?? null;

  let activeYFields: string[] = [];
  if (ySeries.length > 0) {
    activeYFields = ySeries.map((s) => s.fieldId).filter(Boolean);
  } else if (yField) {
    activeYFields = [yField];
  }

  const isBlended = ySeries.some((s) => s.sourceId && s.sourceId !== widget.sourceId);
  if (isBlended || CHART_RAW_ROW_FALLBACK.has(chartType)) {
    return '';
  }

  // Non-xy dimension fields the chart family reads but that aren't expressed as x/y/series —
  // mirrors `useChartWidgetData.ts`'s `chartTypeExtraFields` exactly, so a cross-source
  // heatmap/funnel/sankey/gantt dimension is enriched onto `enrichedRows` here the same way
  // it is onto the rendered chart's rows (finding 2.1).
  const chartTypeExtraFields: (string | undefined)[] = (() => {
    switch (chartType) {
      case 'heatmap':
        return [cfg.heatYField];
      case 'funnel':
        return [cfg.funnelReachedField];
      case 'sankey':
        return [cfg.sankeyTargetField];
      case 'gantt':
        return [cfg.ganttLabelField, cfg.ganttStartField, cfg.ganttEndField, cfg.ganttColorField];
      default:
        return [];
    }
  })();

  // The widget's fully resolved/scoped filter set — mirrors `useChartWidgetData.ts`'s
  // `effectiveResolvedFilters` (selectFiltersForWidget with `include` matching the rows
  // baseline in use) so the L4 anchor-filter re-application below can never disagree with
  // what L3 actually enforced as a semi-join to produce `filteredRows` (finding 2.1).
  const chartCrossFilterMode =
    state.doc.dashboard.globalCrossFilterMode ?? cfg.crossFilterMode ?? 'cross-highlight';
  const widgetFilters = selectFiltersForWidget(state.doc.filters, {
    widgetId: widget.id,
    widgetSourceId: widget.sourceId,
    activePageId: state.doc.dashboard.activePageId,
    include: chartCrossFilterMode === 'none' ? 'no-cross' : 'all',
    crossFilterAllPages: state.doc.dashboard.crossFilterAllPages,
  });

  const enrichedRows = resolveChartRowsForAggregation(
    filteredRows,
    widget.sourceId,
    xField,
    activeYFields,
    seriesField,
    state.runtime.dataSources,
    state.doc.relationships,
    state.doc.expressionFields,
    chartTypeExtraFields,
    widgetFilters,
  );

  // Look up through the own-source + own-source-expression-fields merge (not just
  // `source.fields`) so a calculated-field (expression field) y-axis measure shows its
  // configured display label instead of its raw field id (finding 14) — mirrors the same
  // `sourceFieldsWithExpressions` lookup used by the KPI/map/raw-row label paths above.
  const yFieldSourceFields = sourceFieldsWithExpressions(source, state.doc.expressionFields);
  const yFieldLabel = (id: string) => yFieldSourceFields.find((f) => f.id === id)?.label ?? id;

  const lines: string[] = [];

  if (chartType === 'heatmap') {
    const heatY: string | undefined = cfg.heatYField;
    const heatValue: string | undefined = cfg.yField;
    if (!heatY || !heatValue) {
      return '';
    }
    const result: HeatmapData = aggregateHeatmap(
      enrichedRows,
      xField,
      heatY,
      heatValue,
      xGroupBy,
      singleSeriesYAggregation,
    );
    const xSlice = result.xLabels.slice(0, maxRows);
    lines.push(
      `Heatmap (${singleSeriesYAggregation} of ${yFieldLabel(heatValue)} by ${xField} × ${heatY}):`,
      `${result.xLabels.length} x-values × ${result.yLabels.length} y-values${
        result.xLabels.length > maxRows ? `, showing first ${maxRows}` : ''
      }`,
      ['', ...result.yLabels].join(','),
    );
    for (const xLabel of xSlice) {
      // `aggregateHeatmap` keys `cells` as `${xLabel}\x00${yLabel}` — the same key
      // `StudioHeatmapChart` reads. Any other separator misses every entry and emits an
      // all-empty table, which the model reads as "no data" for a chart that is full of it.
      const row = result.yLabels.map((yLabel) =>
        insightCell(result.cells.get(`${xLabel}\x00${yLabel}`)),
      );
      lines.push([xLabel, ...row].join(','));
    }
  } else if (seriesField && activeYFields.length === 1) {
    const result: MultiSeriesData = applyRankToSeriesFieldData(
      aggregateByTwoFields(
        enrichedRows,
        xField,
        seriesField,
        activeYFields[0],
        xGroupBy,
        sortBy,
        sortDir,
        xOrder,
        singleSeriesYAggregation,
      ),
      rankFilter,
    );
    const total = result.labels.length;
    const slice = result.labels.slice(0, maxRows);
    lines.push(
      `Aggregated by ${xField}${xGroupBy ? ` (${xGroupBy})` : ''} × ${seriesField} (${singleSeriesYAggregation} of ${yFieldLabel(activeYFields[0])})`,
      `${total} x-values${total > maxRows ? `, showing first ${maxRows}` : ''}`,
      [xField, ...result.seriesNames].join(','),
    );
    for (let i = 0; i < slice.length; i += 1) {
      const vals = result.seriesNames.map((s) => insightCell(result.seriesData[s]?.[i]));
      lines.push([slice[i], ...vals].join(','));
    }
  } else if (activeYFields.length > 1 && !seriesField) {
    const result: MultiYSeriesData = applyRankToMultiSeries(
      aggregateMultipleSeries(
        enrichedRows,
        xField,
        activeYFields,
        xGroupBy,
        sortBy,
        sortDir,
        xOrder,
        yAggregationByField,
      ),
      rankFilter,
    );
    const total = result.labels.length;
    const slice = result.labels.slice(0, maxRows);
    lines.push(
      `Aggregated by ${xField}${xGroupBy ? ` (${xGroupBy})` : ''} (multiple measures)`,
      `${total} x-values${total > maxRows ? `, showing first ${maxRows}` : ''}`,
      [xField, ...result.series.map((s) => yFieldLabel(s.fieldId))].join(','),
    );
    for (let i = 0; i < slice.length; i += 1) {
      const vals = result.series.map((s) => insightCell(s.values[i]));
      lines.push([slice[i], ...vals].join(','));
    }
  } else {
    const yF = activeYFields[0] ?? '';
    const result: AggregatedData = applyRankToAggregated(
      aggregateByField(
        enrichedRows,
        xField,
        yF,
        xGroupBy,
        singleSeriesYAggregation,
        sortBy,
        sortDir,
        xOrder,
      ),
      rankFilter,
    );
    const total = result.labels.length;
    const slice = result.labels.slice(0, maxRows);
    lines.push(
      `Aggregated by ${xField}${xGroupBy ? ` (${xGroupBy})` : ''} (${singleSeriesYAggregation} of ${yF ? yFieldLabel(yF) : 'rows'})`,
      `${total} categories${total > maxRows ? `, showing first ${maxRows}` : ''}`,
      [xField, yF ? yFieldLabel(yF) : 'count'].join(','),
    );
    for (let i = 0; i < slice.length; i += 1) {
      lines.push([slice[i], String(result.values[i])].join(','));
    }
  }

  if (activeYFields.length > 0) {
    const stats = buildNumericStats(
      filteredRows,
      activeYFields,
      sourceFieldsWithExpressions(source, state.doc.expressionFields),
    );
    if (stats) {
      lines.push(`Stats: ${stats}`);
    }
  }

  if (canDetectAnomalies(widget) && activeYFields.length > 0) {
    const yF = activeYFields[0];
    // Detect anomalies over the same rank-applied, configured-aggregation data the
    // live chart renders (`StudioChartWidget.tsx` runs `detectChartDataAnomalies` on
    // `chartData`, which is `applyRankToAggregated(aggregateByField(...))`).
    const aggResult = applyRankToAggregated(
      aggregateByField(
        enrichedRows,
        xField,
        yF,
        xGroupBy,
        singleSeriesYAggregation,
        sortBy,
        sortDir,
        xOrder,
      ),
      rankFilter,
    );
    const anomalies = detectChartDataAnomalies(widget.id, aggResult.labels, aggResult.values, true);
    if (anomalies.length > 0) {
      lines.push(`Anomalies detected at: ${anomalies.map((a) => String(a.value)).join(', ')}`);
    }
  }

  return lines.join('\n');
}

function buildMapWidgetSummary(
  widget: StudioWidget,
  source: StudioDataSource,
  filteredRows: Record<string, unknown>[],
  state: StudioState,
  maxRows: number,
): string {
  // Read config through the flat cross-kind `StudioWidgetConfig` patch type:
  // these summary builders are dispatched generically by kind and are not
  // statically narrowed to a single-kind widget at their call sites.
  const cfg: StudioWidgetConfig = widget.config;
  const countryField: string | undefined = cfg.mapCountryField;
  const valueField: string | undefined = cfg.mapValueField;
  const agg: string = cfg.mapAggregation ?? 'sum';

  if (!countryField) {
    return '';
  }

  // `mapCountryField`/`mapValueField` can reference a related source
  // (`mapCountrySourceId`/`mapValueSourceId` differing from `widget.sourceId`) — the
  // rendered map joins those values onto rows via `useWidgetRows.ts`'s
  // `mapCrossSourceFields` enrichment. `filteredRows` here only carries L2/L3
  // (own-source expression + filters), so without the same enrichment a cross-source
  // country/value field is blank on this path (finding 2.5). Mirror
  // `widgetExport.ts:119-134`'s enrichment.
  const crossSourceFieldRefs: { fieldId: string; sourceId: string }[] = [];
  if (cfg.mapCountrySourceId && cfg.mapCountrySourceId !== widget.sourceId) {
    crossSourceFieldRefs.push({ fieldId: countryField, sourceId: cfg.mapCountrySourceId });
  }
  if (valueField && cfg.mapValueSourceId && cfg.mapValueSourceId !== widget.sourceId) {
    crossSourceFieldRefs.push({ fieldId: valueField, sourceId: cfg.mapValueSourceId });
  }
  const enrichedRows =
    crossSourceFieldRefs.length > 0
      ? enrichWithCrossSourceFields(
          filteredRows,
          widget.sourceId,
          crossSourceFieldRefs,
          state.runtime.dataSources,
          state.doc.relationships,
          // Thread the expression fields so a related-source *calculated* country/value field is
          // L2-enriched before the join, matching the fixed shared render path (finding 1.1) —
          // without this the AI-facing map summary keeps the identical blind spot the render had,
          // and the two silently diverge once the render is fixed.
          state.doc.expressionFields,
        )
      : filteredRows;

  // Merge region spelling variants the same way the rendered map does — `StudioMapWidget`
  // normalizes every row's country value (`normalizeToStateAbbr` for the 'usa' geography,
  // `normalizeToAlpha2` otherwise) before grouping, so 'US'/'USA'/'United States' become one
  // region. This summary previously grouped by the raw field value with no normalization,
  // so it reported those as three separate countries while the map merges them (finding
  // 2.5). Rows whose value doesn't normalize (the widget's `if (!id) continue`) are dropped
  // the same way.
  const normalize = cfg.mapGeography === 'usa' ? normalizeToStateAbbr : normalizeToAlpha2;
  const normalizedRows = enrichedRows.reduce<Record<string, unknown>[]>((acc, row) => {
    const normalized = normalize(row[countryField]);
    if (normalized) {
      acc.push({ ...row, [countryField]: normalized });
    }
    return acc;
  }, []);

  const result: AggregatedData = aggregateByField(
    normalizedRows,
    countryField,
    valueField ?? '',
    undefined,
    (valueField ? agg : 'count') as 'sum' | 'count' | 'avg' | 'min' | 'max',
    'value',
    'desc',
  );

  const total = result.labels.length;
  const slice = result.labels.slice(0, maxRows);
  // Look up through the own-source + own-source-expression-fields merge (not just
  // `source.fields`) so a calculated-field (expression field) map value shows its
  // configured display label instead of its raw field id/expression (finding 2.x).
  const valueLabel = valueField
    ? (sourceFieldsWithExpressions(source, state.doc.expressionFields).find(
        (f) => f.id === valueField,
      )?.label ?? valueField)
    : 'count';

  const lines: string[] = [
    `Aggregated by country (${agg} of ${valueLabel})`,
    `${total} countries${total > maxRows ? `, showing top ${maxRows}` : ''}`,
    `Country,${valueLabel}`,
    ...slice.map((label, i) => `${label},${result.values[i]}`),
  ];

  if (valueField) {
    const stats = buildNumericStats(
      normalizedRows,
      [valueField],
      sourceFieldsWithExpressions(source, state.doc.expressionFields),
    );
    if (stats) {
      lines.push(`Stats: ${stats}`);
    }
  }

  return lines.join('\n');
}

function csvRow(row: Record<string, unknown>, fieldIds: string[]): string {
  return fieldIds
    .map((id) => {
      const v = row[id];
      const s = v === null || v === undefined ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    })
    .join(',');
}

/**
 * Builds a compact CSV data summary for a widget's relevant fields.
 * Applies the widget's active filters via the pipeline so the data
 * matches what the user actually sees.
 *
 * Uses type-aware sampling to maximise AI usefulness:
 * - forecast → tail slice (most recent data)
 * - anomaly  → guaranteed anomaly rows + stride fill
 * - all else → stride sample across the full range
 *
 * Always includes a numeric stats preamble (min/max/avg) from the full
 * filtered dataset so the AI has global context even when rows are sampled.
 */
export function buildWidgetDataSummary(
  widget: StudioWidget,
  state: StudioState,
  options: DataSummaryOptions = {},
): string {
  if (!widget.sourceId) {
    return '';
  }
  const source = state.runtime.dataSources[widget.sourceId];
  if (!source) {
    return '';
  }
  const rawRows = source.rows;
  if (!rawRows || rawRows.length === 0) {
    if (source.adapter) {
      return 'Data is loaded via a server adapter — raw rows are not available locally.';
    }
    return '';
  }

  // Apply the widget's active filters so data matches what the user sees
  const pipeline = createStudioPipeline(toPipelineState(state));
  // Passing the widget OBJECT (not `widget.id`) lets `resolveWidgetRows` resolve
  // `shouldApplyWidgetRankAtL3` itself, so this summary is computed over exactly the row set the
  // widget renders. `widget.kind !== 'chart'` is NOT an equivalent rule: only the xy chart
  // families (bar / line / area / pie / donut / mixed) re-rank post-aggregation in
  // `buildChartWidgetSummary` below. A heatmap / funnel / sankey / gantt / scatter / gauge chart
  // aggregates rows directly and never re-ranks, so its widget-scoped Top-N belongs at L3 here —
  // otherwise the assistant reports a number computed over the UNRANKED rows while the chart on
  // screen shows the top N.
  const filteredRows = pipeline.resolveWidgetRows(
    widget,
    widget.sourceId,
    rawRows,
    state.doc.dashboard.activePageId,
    {
      // `crossFilterMode` is a cross-kind key, read via the flat cross-kind config type
      // (this dispatcher runs before the widget's kind-specific `cfg` is narrowed below).
      widgetCrossFilterMode: (widget.config as StudioWidgetConfig).crossFilterMode,
    },
  );

  const maxRows = options.maxRows ?? MAX_DATA_ROWS;

  // Compute the active date range once — used in every widget kind's output.
  // Scope the filter list first (matching the KPI widget) so `findDateFilter` can't latch
  // onto a disabled date filter, a different page's date filter, or a `dashboard-date-range`
  // filter for another source — `findDateFilter` itself checks none of those (finding 2.2).
  const scopedFilters = selectFiltersForWidget(state.doc.filters, {
    widgetId: widget.id,
    widgetSourceId: widget.sourceId,
    activePageId: state.doc.dashboard.activePageId,
    crossFilterAllPages: state.doc.dashboard.crossFilterAllPages ?? false,
  });
  const dateFilter = findDateFilter(scopedFilters, widget.id, source);
  const currentRange = dateFilter ? extractDateRange(dateFilter) : null;
  const dateRangeLine = currentRange
    ? `Date range: ${formatDate(currentRange.start)} – ${formatDate(currentRange.end)}`
    : '';

  const prefix = (body: string) => (dateRangeLine ? `${dateRangeLine}\n${body}` : body);

  // Dispatch to widget-type-specific builders that represent what the widget actually displays
  if (widget.kind === 'kpi') {
    return prefix(
      buildKpiWidgetSummary(widget, source, filteredRows, state, dateFilter, currentRange),
    );
  }
  if (widget.kind === 'chart') {
    const summary = buildChartWidgetSummary(widget, source, filteredRows, state, maxRows);
    if (summary) {
      return prefix(summary);
    }
    // Fall through to raw-row path for scatter/gantt/sankey/blended
  }
  if (widget.kind === 'map') {
    return prefix(buildMapWidgetSummary(widget, source, filteredRows, state, maxRows));
  }

  // Raw-row path: grid, pivot, and chart fallbacks
  // Read config through the flat cross-kind `StudioWidgetConfig` patch type:
  // these summary builders are dispatched generically by kind and are not
  // statically narrowed to a single-kind widget at their call sites.
  const cfg: StudioWidgetConfig = widget.config;
  let fieldIds: string[] = [];
  let xFieldId: string | undefined;

  if (widget.kind === 'grid') {
    fieldIds = (cfg.columns ?? []).map((c: { fieldId: string }) => c.fieldId).slice(0, 8);
  } else if (widget.kind === 'pivot') {
    if (cfg.pivotRowField) {
      fieldIds.push(cfg.pivotRowField);
    }
    if (cfg.pivotColField) {
      fieldIds.push(cfg.pivotColField);
    }
    if (cfg.pivotValueField) {
      fieldIds.push(cfg.pivotValueField);
    }
  } else if (widget.kind === 'chart') {
    xFieldId = cfg.xField as string | undefined;
    if (cfg.xField) {
      fieldIds.push(cfg.xField);
    }
    if (cfg.yField) {
      fieldIds.push(cfg.yField);
    } else if (cfg.ySeries?.[0]) {
      fieldIds.push(cfg.ySeries[0].fieldId);
    }
    if (cfg.seriesField) {
      fieldIds.push(cfg.seriesField);
    }
  }

  // Cross-source grid columns (columns whose `sourceId` differs from the widget's primary
  // source) are joined onto rows for display by `useWidgetRows.ts`'s
  // `enrichWithCrossSourceFields` call, and again for CSV export by
  // `widgetExport.ts:119-134` — this raw-row data-sample path never ran that enrichment at
  // all, so a cross-source grid column was blank here and then dropped entirely by the
  // "exists in the data" filter below (finding 2.5). Mirror that enrichment via the same
  // `enrichWithCrossSourceColumns` convenience wrapper (a no-op when `cfg.columns` is
  // undefined or has no cross-source entries, e.g. for pivot/chart-fallback widgets).
  const enrichedFilteredRows = enrichWithCrossSourceColumns(
    filteredRows,
    widget.sourceId,
    cfg.columns,
    state.runtime.dataSources,
    state.doc.relationships,
  );

  // Deduplicate and keep only fields that actually exist in the enriched data. Checking
  // against `rawRows` (pre-L2, pre-cross-source) excluded own-source expression columns
  // (only ever added by the pipeline's L2 enrichment) and cross-source columns (only added
  // above) from the sample — the AI was never told about the very column a pivot/grid
  // widget aggregates (finding 2.5).
  fieldIds = [...new Set(fieldIds)].filter(
    (id) => id && enrichedFilteredRows.some((r: Record<string, unknown>) => id in r),
  );

  if (fieldIds.length === 0) {
    return '';
  }

  const { sampling = 'stride' } = options;
  const { sample, label } =
    sampling === 'aggregate'
      ? aggregateRows(
          enrichedFilteredRows,
          fieldIds,
          // Include own-source expression (calculated) fields — same lookup as `buildNumericStats`
          // and the header-label merge below. With bare `source.fields`, a numeric CALCULATED
          // column isn't found, so it fails `aggregateRows`' `field?.type === 'number'` check and
          // gets bucket/`first`-style sampling instead of numeric aggregation, silently
          // misrepresenting a computed measure in the AI-generated insight summary.
          sourceFieldsWithExpressions(source, state.doc.expressionFields),
          maxRows,
        )
      : selectSampleRows(enrichedFilteredRows, options, xFieldId);

  // Stats computed from ALL filtered rows (not just sample) for global context
  const stats = buildNumericStats(
    enrichedFilteredRows,
    fieldIds,
    sourceFieldsWithExpressions(source, state.doc.expressionFields),
  );

  // Look up header labels through the same own-source-fields + own-source-expression-fields
  // merge as the stats above (and as `widgetUtils.tsx`'s `buildCsvContent`), so an
  // expression column's header reads its configured label instead of its raw field id.
  const allFieldsForLabels = sourceFieldsWithExpressions(source, state.doc.expressionFields);
  const headers = fieldIds.map((id) => {
    const field = allFieldsForLabels.find((f) => f.id === id);
    return field?.label ?? id;
  });

  const lines: string[] = [`Data sample (${label}):`];
  if (stats) {
    lines.push(`Stats: ${stats}`);
  }
  lines.push(headers.join(','), ...sample.map((row) => csvRow(row, fieldIds)));

  return prefix(lines.join('\n'));
}
