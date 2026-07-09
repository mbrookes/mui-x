'use client';
import * as React from 'react';
import { Box, Tooltip } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

import type {
  StudioDataSource,
  StudioWidgetOf,
  StudioWidgetConfigForKind,
  StudioWidgetConfig,
  StudioFilterState,
  StudioKpiAggregation,
  StudioExpressionField,
  StudioRelationship,
} from '../../../models';
import { summarizeFilter } from '../../StudioFiltersDrawer/filterDrawerUtils';
import { resolveRows } from '../../../internals/dataSourceGraph';
import {
  resolveChartRowsForAggregation,
  analyzeChartSupport,
} from '../../../internals/chartAggregation';
import { getCachedEnrichedRows } from '../../../internals/enrichedRowsCache';
import { selectFiltersForWidget } from '../../../internals/filterScoping';
import { collectSelectFields } from '../../../internals/queryDescriptor';
import { buildFieldLabelMap } from '../../../internals/fieldCatalog';
import { usePageChartColors } from '../../../internals/usePageChartColors';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';
import {
  useStudioSelector,
  useStudioLocaleText,
  selectFilters,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSource,
} from '../../../context';
import { formatNumber } from '../../../internals/numberFormat';
import { cachedCompute } from '../../../internals/computedCache';
import { evaluateMeasure } from '../../../utils/expressionEvaluator';
import {
  type Granularity,
  autoGranularity,
  extractDateRange,
  findDateFilter,
  computeFixedPeriodRange,
  computePreviousPeriodRange,
  filterRowsByDateRange,
  computeAggregate,
  computeSparklineData,
} from './kpiUtils';
import { KpiValue, type KpiValueProps } from './KpiValue';
import { KpiSparkline, type KpiSparklineProps } from './KpiSparkline';
import { KpiTrend, type KpiTrendResult, type KpiTrendProps } from './KpiTrend';

export interface StudioKpiWidgetSlots {
  /** Replaces the main metric value display. */
  value?: React.ElementType<KpiValueProps>;
  /** Replaces the sparkline chart. */
  sparkline?: React.ElementType<KpiSparklineProps>;
  /** Replaces the trend delta badge. */
  trend?: React.ElementType<KpiTrendProps>;
}

export interface StudioKpiWidgetSlotProps {
  value?: Partial<KpiValueProps>;
  sparkline?: Partial<KpiSparklineProps>;
  trend?: Partial<KpiTrendProps>;
}

export interface StudioKpiWidgetProps {
  widget: StudioWidgetOf<'kpi'>;
  dataSource?: StudioDataSource;
  /** ID of the page this widget belongs to. Used to scope page-level filters correctly. */
  pageId: string;
  slots?: StudioKpiWidgetSlots;
  slotProps?: StudioKpiWidgetSlotProps;
}

interface ComputePeriodValueParams {
  /** Value field to aggregate. Unused for a measure or a fieldless count. */
  valueField: string;
  aggregation: StudioKpiAggregation;
  /** When set, the value is a measure that does its own aggregation. */
  measureExprField: StudioExpressionField | undefined;
  /** True when the value field lives on a related (parent) source and rows must be re-anchored. */
  isGrainAnchored: boolean;
  sourceId: string | undefined;
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  expressionFields: StudioExpressionField[];
}

/**
 * Reduces a (date-windowed) row set to a single aggregate value using the same
 * three-way dispatch as the headline value:
 * - measure expression field → `evaluateMeasure` (measures aggregate themselves);
 * - grain-anchored field → re-anchor to the value field's parent-source grain first,
 *   then aggregate (so a cross-source value is counted once per parent, not per child row);
 * - plain native field (or fieldless count) → aggregate directly.
 *
 * Callers window the rows at the widget's own (child) grain FIRST, then pass them here so
 * anchoring runs second — matching the "window first, anchor second" ordering the
 * filter-based trend branch always relied on.
 */
function computePeriodValue(
  periodRows: Record<string, unknown>[],
  params: ComputePeriodValueParams,
): number {
  const {
    valueField,
    aggregation,
    measureExprField,
    isGrainAnchored,
    sourceId,
    dataSources,
    relationships,
    expressionFields,
  } = params;

  if (measureExprField) {
    // A root-level divide/modulo-by-zero yields `null` (finding 3.16); the trend delta
    // is a subtraction between two period values, so a period with no valid result
    // contributes 0 rather than propagating `null` through the comparison.
    return evaluateMeasure(measureExprField, periodRows, expressionFields) ?? 0;
  }
  if (isGrainAnchored) {
    const anchoredRows = resolveChartRowsForAggregation(
      periodRows,
      sourceId,
      undefined,
      [valueField],
      undefined,
      dataSources,
      relationships,
      expressionFields,
    );
    return computeAggregate(anchoredRows, valueField, aggregation);
  }
  return computeAggregate(periodRows, valueField, aggregation);
}

type KpiConfig = StudioWidgetConfigForKind<'kpi'>;

/**
 * Fixed-period trend: derive rolling current/previous windows from today, window the
 * widget's own (child-grain) rows into each, then reduce both through the shared
 * `computePeriodValue` seam so cross-source / measure value fields yield a correct delta.
 */
function computeFixedPeriodTrend(
  rows: Record<string, unknown>[],
  fixedDateField: string,
  fixedPeriod: NonNullable<KpiConfig['kpiTrendFixedPeriod']>,
  comparisonMode: Parameters<typeof computePreviousPeriodRange>[2],
  periodValueParams: ComputePeriodValueParams,
): KpiTrendResult | null {
  const today = new Date();
  const currentRange = computeFixedPeriodRange(fixedPeriod, today);
  const prevRange = computePreviousPeriodRange(
    currentRange.start,
    currentRange.end,
    comparisonMode,
  );

  const currentPeriodRows = filterRowsByDateRange(
    rows,
    fixedDateField,
    currentRange.start,
    currentRange.end,
  );
  const prevPeriodRows = filterRowsByDateRange(
    rows,
    fixedDateField,
    prevRange.start,
    prevRange.end,
  );

  const currentPeriodValue = computePeriodValue(currentPeriodRows, periodValueParams);
  const previousValue = computePeriodValue(prevPeriodRows, periodValueParams);

  if (previousValue !== 0) {
    return {
      delta: (currentPeriodValue - previousValue) / Math.abs(previousValue),
      previousValue,
      previousStart: prevRange.start,
      previousEnd: prevRange.end,
    };
  }
  if (currentPeriodValue !== 0) {
    return {
      delta: Infinity,
      previousValue,
      previousStart: prevRange.start,
      previousEnd: prevRange.end,
    };
  }
  return null;
}

/**
 * Filter-based trend: window the widget's rows to the previous period defined by the
 * active date filter, then reduce them through the shared `computePeriodValue` seam.
 * The current side of the delta reuses the already-computed headline value.
 */
function computeFilterBasedTrend(params: {
  config: KpiConfig;
  widget: StudioWidgetOf<'kpi'>;
  dataSource: StudioDataSource;
  pageId: string;
  filters: StudioFilterState[];
  currentValue: number;
  measureKey: string;
  crossFilterMode: 'none' | 'cross-filter';
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  expressionFields: StudioExpressionField[];
  periodValueParams: ComputePeriodValueParams;
}): KpiTrendResult | null {
  const {
    config,
    widget,
    dataSource,
    pageId,
    filters,
    currentValue,
    measureKey,
    crossFilterMode,
    dataSources,
    relationships,
    expressionFields,
    periodValueParams,
  } = params;

  // In this branch kpiValueField is set (guaranteed by the caller's gate).
  const previousKpiValueField = config.kpiValueField!;

  // Scope the filters through the SAME authority the headline rows use
  // (`selectFiltersForWidget`) before deriving anything from them. This enforces
  // the `pageId`, `disabled`, and `dashboard-date-range` sourceId checks that a raw
  // `filters` partition skips — otherwise, on a multi-page dashboard, the previous
  // period would be computed with another page's filters applied while the current
  // headline correctly excludes them, and `findDateFilter` could latch onto a
  // disabled date filter or one whose source doesn't match the widget (finding 2.17).
  // `include` mirrors the row-scope the headline actually renders:
  //   'none' → currentRows = filteredRowsNoCross → page + widget only ('no-cross')
  //   else   → currentRows = effectiveRows        → all active scopes ('all')
  const scopedFilters = selectFiltersForWidget(filters, {
    widgetId: widget.id,
    widgetSourceId: widget.sourceId,
    activePageId: pageId,
    include: crossFilterMode === 'none' ? 'no-cross' : 'all',
  });
  const dateFilter = findDateFilter(scopedFilters, widget.id, dataSource);
  if (!dateFilter) {
    return null;
  }
  const currentRange = extractDateRange(dateFilter);
  if (!currentRange) {
    return null;
  }
  const comparisonMode = config.kpiTrendComparison ?? 'previous-period';
  const prevRange = computePreviousPeriodRange(
    currentRange.start,
    currentRange.end,
    comparisonMode,
  );

  // Pre-enrich once here so the previous-period resolveRows call can skip
  // enrichment. Pass usedFieldIds matching what useWidgetRows computed so this
  // hits the already-populated cache slot rather than the all-fields slot.
  const kpiUsedFieldIds = new Set(collectSelectFields(widget));
  kpiUsedFieldIds.add(dateFilter.field);
  for (const f of scopedFilters) {
    if (f.field) {
      kpiUsedFieldIds.add(f.field);
    }
  }
  const preEnrichedRows = getCachedEnrichedRows(
    dataSource.rows ?? [],
    widget.sourceId,
    expressionFields,
    dataSources,
    relationships,
    kpiUsedFieldIds,
  );

  // `scopedFilters` already reflects the current row scope (see above): for the
  // 'none' mode it is page + widget only (matching filteredRowsNoCross), and for
  // cross-filter mode it is every active scope (matching effectiveRows). Swapping
  // the current date filter for the previous-period window below therefore keeps the
  // previous side under exactly the same non-date filters as the current headline.
  const allFilters = scopedFilters;

  const prevDateFilter: StudioFilterState = {
    ...dateFilter,
    operator: 'greater_than_or_equal',
    value: prevRange.start.toISOString().slice(0, 10),
    operator2: 'less_than_or_equal',
    value2: prevRange.end.toISOString().slice(0, 10),
    conjunction: 'and',
  };
  const prevFilters = allFilters.map((f) => (f.id === dateFilter.id ? prevDateFilter : f));
  const prevRows = resolveRows(
    preEnrichedRows,
    widget.sourceId,
    prevFilters,
    dataSources,
    relationships,
    expressionFields,
    { skipEnrichment: true },
  );
  // prevRows are already windowed to the previous date range at the widget's
  // own (child) grain; computePeriodValue anchors second, matching the headline.
  const previousValue = cachedCompute(
    prevRows,
    `kpi-value:${previousKpiValueField}:${measureKey}`,
    () => computePeriodValue(prevRows, periodValueParams),
  );

  if (previousValue !== 0) {
    return {
      delta: (currentValue - previousValue) / Math.abs(previousValue),
      previousValue,
      previousStart: prevRange.start,
      previousEnd: prevRange.end,
    };
  }
  if (currentValue !== 0) {
    return {
      delta: Infinity,
      previousValue,
      previousStart: prevRange.start,
      previousEnd: prevRange.end,
    };
  }
  return null;
}

/**
 * Grain-aware rows for KPI value and sparkline computation.
 *
 * When kpiValueField belongs to a related (parent) source — e.g. a KPI on order_items
 * using orders.revenue — calling computeAggregate over the widget's own rows inflates
 * the result because each parent-level value is repeated once per child row.
 * resolveChartRowsForAggregation re-anchors to the correct aggregation grain (the parent
 * source rows, filtered to those that have at least one matching child row).
 *
 * Measure expression fields handle their own aggregation via evaluateMeasure and are
 * excluded from re-anchoring.
 *
 * isGrainAnchored is true when the value field is on a different (parent) source and the
 * re-anchoring actually changed the row grain. Used to skip the redundant time-field join
 * in the sparkline path when the time field is also on the anchor source rows natively.
 */
function useKpiGrainAnchoredRows(
  currentRows: Record<string, unknown>[],
  kpiValueField: string | undefined,
  sourceId: string | undefined,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
): { grainAnchoredRows: Record<string, unknown>[]; isGrainAnchored: boolean } {
  return React.useMemo(() => {
    const isMeasure = kpiValueField
      ? expressionFields.some((ef) => ef.id === kpiValueField && ef.isMeasure)
      : false;
    if (!kpiValueField || !sourceId || isMeasure) {
      return { grainAnchoredRows: currentRows, isGrainAnchored: false };
    }
    const support = analyzeChartSupport(
      sourceId,
      undefined,
      [kpiValueField],
      undefined,
      undefined,
      dataSources,
      relationships,
      expressionFields,
    );
    if (!support.supported || !support.anchorSourceId || support.anchorSourceId === sourceId) {
      return { grainAnchoredRows: currentRows, isGrainAnchored: false };
    }
    return {
      grainAnchoredRows: resolveChartRowsForAggregation(
        currentRows,
        sourceId,
        undefined,
        [kpiValueField],
        undefined,
        dataSources,
        relationships,
        expressionFields,
      ),
      isGrainAnchored: true,
    };
  }, [currentRows, kpiValueField, sourceId, expressionFields, dataSources, relationships]);
}

/**
 * Headline value: aggregation defaulting, the no-data guard, the value computation (over
 * grain-anchored or measure rows), and boolean-avg/percent display formatting. Returns the
 * raw numeric value and measure/aggregation metadata that the sparkline and trend hooks reuse.
 */
function useKpiValue(params: {
  config: KpiConfig;
  dataSource: StudioDataSource | undefined;
  currentRows: Record<string, unknown>[];
  grainAnchoredRows: Record<string, unknown>[];
  expressionFields: StudioExpressionField[];
}): {
  displayValue: string;
  hasData: boolean;
  kpiNumericValue: number;
  rawValue: number;
  aggregation: StudioKpiAggregation;
  measureExprField: StudioExpressionField | undefined;
  measureKey: string;
} {
  const { config, dataSource, currentRows, grainAnchoredRows, expressionFields } = params;
  return React.useMemo(() => {
    // With no value field the only meaningful aggregation is a row "count" (the setup
    // panel locks the selector to Count in that state). Default accordingly so a KPI
    // reproduced from scratch — source picked, value field left empty, aggregation not
    // explicitly persisted — still renders a count rather than the no-data placeholder.
    const aggregation = config.kpiAggregation ?? (config.kpiValueField ? 'sum' : 'count');
    // A "count" aggregation tallies rows and is field-independent, so it is a
    // complete, reproducible configuration on its own — no value field required.
    // Any other aggregation needs a value field to operate on.
    const isFieldlessCount = aggregation === 'count' && !config.kpiValueField;
    const measureExprField = expressionFields.find(
      (ef) => ef.id === config.kpiValueField && ef.isMeasure,
    );
    const measureKey = measureExprField ? `measure:${measureExprField.id}` : `agg:${aggregation}`;
    if (!dataSource?.rows || (!config.kpiValueField && !isFieldlessCount)) {
      return {
        displayValue: '—',
        hasData: false,
        kpiNumericValue: 0,
        rawValue: 0,
        aggregation,
        measureExprField,
        measureKey,
      };
    }

    const rows = currentRows;
    // Use grain-anchored rows for the value so cross-source fields (e.g. orders.revenue on an
    // order_items widget) are aggregated once per parent row, not once per child row.
    const valueRows = measureExprField ? rows : grainAnchoredRows;
    // For a fieldless count the field argument is unused (computeAggregate tallies rows),
    // so pass an empty string.
    const valueField = config.kpiValueField ?? '';
    const value = cachedCompute(valueRows, `kpi-value:${valueField}:${measureKey}`, () =>
      measureExprField
        ? evaluateMeasure(measureExprField, valueRows, expressionFields)
        : computeAggregate(valueRows, valueField, aggregation),
    );

    // A measure's root-level divide/modulo-by-zero yields `null` (finding 3.16) rather
    // than a fabricated 0 — treat it the same as "no data" instead of silently coercing.
    if (value === null) {
      return {
        displayValue: '—',
        hasData: false,
        kpiNumericValue: 0,
        rawValue: 0,
        aggregation,
        measureExprField,
        measureKey,
      };
    }

    const fieldDef =
      dataSource.fields.find((f) => f.id === config.kpiValueField) ??
      expressionFields.find((ef) => ef.id === config.kpiValueField);
    // avg of a boolean field is a 0–1 ratio; scale to 0–100 and display as percent
    const isBooleanAvg = fieldDef?.type === 'boolean' && aggregation === 'avg';
    const semanticValue = isBooleanAvg ? value * 100 : value;
    const formatted = formatNumber(
      semanticValue,
      isBooleanAvg ? 'percent' : fieldDef?.format,
      fieldDef?.currencyCode,
      config.kpiCompact ?? true,
      fieldDef?.precision,
    );
    const kpiDisplay = `${config.kpiPrefix ?? ''}${formatted}${config.kpiSuffix ?? ''}`;

    return {
      displayValue: kpiDisplay,
      hasData: true,
      kpiNumericValue: semanticValue,
      rawValue: value,
      aggregation,
      measureExprField,
      measureKey,
    };
  }, [config, dataSource, currentRows, grainAnchoredRows, expressionFields]);
}

/**
 * Sparkline series + resolved time field. Disabled (returns nulls) unless the KPI has data
 * and the sparkline is enabled in config.
 */
function useKpiSparkline(params: {
  config: KpiConfig;
  widget: StudioWidgetOf<'kpi'>;
  dataSource: StudioDataSource | undefined;
  pageId: string;
  filters: StudioFilterState[];
  currentRows: Record<string, unknown>[];
  grainAnchoredRows: Record<string, unknown>[];
  isGrainAnchored: boolean;
  aggregation: StudioKpiAggregation;
  measureExprField: StudioExpressionField | undefined;
  crossFilterMode: 'none' | 'cross-filter';
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  expressionFields: StudioExpressionField[];
  enabled: boolean;
}): { sparklineData: number[] | null; sparklineTimeField: string | null } {
  const {
    config,
    widget,
    dataSource,
    pageId,
    filters,
    currentRows,
    grainAnchoredRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    crossFilterMode,
    dataSources,
    relationships,
    expressionFields,
    enabled,
  } = params;
  return React.useMemo(() => {
    if (!enabled || !dataSource) {
      return { sparklineData: null, sparklineTimeField: null };
    }

    const rows = currentRows;
    let kpiSparklineData: number[] | null = null;
    let kpiSparklineTimeField: string | null = null;

    // Scope the filters through the SAME authority the trend path uses
    // (`selectFiltersForWidget`) before deriving the time field / auto-granularity from
    // them. `findDateFilter` itself performs no `pageId`/`disabled`/source check, so a
    // raw, unscoped `filters` partition let another page's (or a disabled) date filter
    // silently drive the sparkline's time field and auto-granularity on a multi-page
    // dashboard (finding 2.5 — the same bug already fixed for the trend path in
    // finding 2.17). `include` mirrors the row-scope `currentRows` actually uses.
    const scopedFilters = selectFiltersForWidget(filters, {
      widgetId: widget.id,
      widgetSourceId: widget.sourceId,
      activePageId: pageId,
      include: crossFilterMode === 'none' ? 'no-cross' : 'all',
    });
    const dateFilter = findDateFilter(scopedFilters, widget.id, dataSource);
    // Only use the date filter's field as the time axis when the filter applies to the
    // widget's own source. Cross-source filters (e.g. an orders.date filter on a customers
    // widget) narrow the result set correctly but their field name doesn't exist on the
    // widget's rows, so using it as timeField would produce an empty sparkline.
    const dateFilterIsNative =
      !dateFilter?.filterSourceId || dateFilter.filterSourceId === widget.sourceId;
    const timeField =
      (dateFilterIsNative ? dateFilter?.field : null) ?? config.kpiSparklineField ?? null;

    if (timeField) {
      kpiSparklineTimeField = timeField;

      let granularity: Granularity = config.kpiSparklineGranularity ?? 'month';
      if (!config.kpiSparklineGranularity && dateFilter) {
        const range = extractDateRange(dateFilter);
        if (range) {
          granularity = autoGranularity(range.start, range.end);
        }
      }

      let sparklineRows = rows;
      const timeFieldSourceId = config.kpiSparklineSourceId;
      if (isGrainAnchored) {
        // The value field is on a related (parent) source. The grain-anchored rows are
        // at the parent grain and natively contain the value field.
        // If the time field is also from that parent source (timeFieldSourceId set to a
        // related source, or auto-detected date filter), it is already present on the
        // anchor rows — use grainAnchoredRows directly, no join needed.
        // If the time field is from the widget's own (child) source, this is a
        // contradictory configuration: the value is at the parent grain, but the time
        // axis is from the child grain. Using grainAnchoredRows would produce an empty
        // sparkline (the child time field is absent on parent rows), so we fall back to
        // unanchored rows. Values will be inflated (double-counted at the child grain),
        // but at least the sparkline renders. The recommended fix for users is to
        // choose a time field from the same source as the value field.
        const timeOnAnchorSource = !timeFieldSourceId || timeFieldSourceId !== widget.sourceId;
        sparklineRows = timeOnAnchorSource ? grainAnchoredRows : rows;
      } else if (timeFieldSourceId && timeFieldSourceId !== widget.sourceId) {
        // Time field is from a related source. Use resolveChartRowsForAggregation to
        // join the time field onto widget rows via the relationship graph. This avoids
        // double-counting that a naive many-to-one lookup join can cause when widget
        // rows expand after enrichment (DC-05).
        sparklineRows = resolveChartRowsForAggregation(
          rows,
          widget.sourceId,
          timeField,
          config.kpiValueField ? [config.kpiValueField] : [],
          undefined,
          dataSources,
          relationships,
          expressionFields,
        );
      }

      kpiSparklineData = cachedCompute(
        sparklineRows,
        `kpi-sparkline:${config.kpiValueField}:${aggregation}:${granularity}:${config.kpiSparklineCumulative ?? false}:${timeField}`,
        () =>
          computeSparklineData(
            sparklineRows,
            timeField,
            config.kpiValueField!,
            aggregation,
            granularity,
            config.kpiSparklineCumulative ?? false,
            // A measure expression field aggregates itself via `evaluateMeasure` — its
            // values do not exist per-row, so `computeAggregate` reading
            // `row[measureId]` would silently produce a flat zero series for every
            // bucket (finding 2.6). Route measures through the same evaluateMeasure
            // seam the headline/trend already use.
            measureExprField,
            expressionFields,
          ),
      );
    }

    return { sparklineData: kpiSparklineData, sparklineTimeField: kpiSparklineTimeField };
  }, [
    enabled,
    config,
    widget,
    dataSource,
    pageId,
    filters,
    currentRows,
    grainAnchoredRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    crossFilterMode,
    dataSources,
    relationships,
    expressionFields,
  ]);
}

/**
 * Trend badge result + the "needs a date filter" hint. Routes both the fixed-period and
 * filter-based modes through `computePeriodValue` (via the two module-level helpers) so a
 * cross-source / measure value field produces a correct delta. Disabled (returns null / false)
 * when the KPI has no data.
 */
function useKpiTrend(params: {
  config: KpiConfig;
  widget: StudioWidgetOf<'kpi'>;
  dataSource: StudioDataSource | undefined;
  pageId: string;
  filters: StudioFilterState[];
  currentRows: Record<string, unknown>[];
  isGrainAnchored: boolean;
  aggregation: StudioKpiAggregation;
  measureExprField: StudioExpressionField | undefined;
  measureKey: string;
  rawValue: number;
  crossFilterMode: 'none' | 'cross-filter';
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  expressionFields: StudioExpressionField[];
  enabled: boolean;
}): { trendResult: KpiTrendResult | null; trendNeedsDateFilter: boolean } {
  const {
    config,
    widget,
    dataSource,
    pageId,
    filters,
    currentRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    measureKey,
    rawValue,
    crossFilterMode,
    dataSources,
    relationships,
    expressionFields,
    enabled,
  } = params;
  return React.useMemo(() => {
    if (!enabled || !dataSource) {
      return { trendResult: null, trendNeedsDateFilter: false };
    }

    const hasFixedPeriodTrend = !!(config.kpiTrend && config.kpiTrendFixedPeriod);

    // Fixed-period mode derives its own windows from today — no date filter required.
    // The existing filter-based mode still requires an active date filter to define the
    // current period (shown as a warning badge when missing). Scope the lookup through
    // the same authority the trend computation uses so the "needs a date filter" hint
    // stays consistent with whether a date filter is actually in scope (finding 2.17).
    const scopedFiltersForBadge = selectFiltersForWidget(filters, {
      widgetId: widget.id,
      widgetSourceId: widget.sourceId,
      activePageId: pageId,
      include: crossFilterMode === 'none' ? 'no-cross' : 'all',
    });
    const needsDateFilter =
      !hasFixedPeriodTrend &&
      !!(config.kpiTrend && config.kpiValueField) &&
      !findDateFilter(scopedFiltersForBadge, widget.id, dataSource);

    // Shared parameters for reducing a date-windowed row set to a single trend value.
    // Both the fixed-period and filter-based trend branches route through
    // computePeriodValue(...) so a cross-source or measure value field is aggregated
    // the same (correct) way as the headline value — not read as a missing row column.
    const periodValueParams: ComputePeriodValueParams = {
      valueField: config.kpiValueField ?? '',
      aggregation,
      measureExprField,
      isGrainAnchored,
      sourceId: widget.sourceId,
      dataSources,
      relationships,
      expressionFields,
    };

    let kpiTrend: KpiTrendResult | null = null;
    if (config.kpiTrend && (config.kpiValueField || hasFixedPeriodTrend)) {
      if (hasFixedPeriodTrend) {
        // The headline (value / currentRows) is the all-time total — unfiltered. Only
        // the trend delta rows are windowed by the date field.
        const fixedDateField =
          config.kpiSparklineField ??
          dataSource.fields.find((f) => f.type === 'date' || f.type === 'datetime')?.id ??
          null;
        if (fixedDateField) {
          kpiTrend = computeFixedPeriodTrend(
            currentRows,
            fixedDateField,
            config.kpiTrendFixedPeriod!,
            config.kpiTrendComparison ?? 'previous-period',
            periodValueParams,
          );
        }
      } else {
        kpiTrend = computeFilterBasedTrend({
          config,
          widget,
          dataSource,
          pageId,
          filters,
          currentValue: rawValue,
          measureKey,
          crossFilterMode,
          dataSources,
          relationships,
          expressionFields,
          periodValueParams,
        });
      }
    }

    return { trendResult: kpiTrend, trendNeedsDateFilter: needsDateFilter };
  }, [
    enabled,
    config,
    widget,
    dataSource,
    pageId,
    filters,
    currentRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    measureKey,
    rawValue,
    crossFilterMode,
    dataSources,
    relationships,
    expressionFields,
  ]);
}

export const StudioKpiWidget = React.memo(function StudioKpiWidget(props: StudioKpiWidgetProps) {
  const { dataSource, widget, pageId, slots, slotProps } = props;

  const ValueComponent = slots?.value ?? KpiValue;
  const SparklineComponent = slots?.sparkline ?? KpiSparkline;
  const TrendComponent = slots?.trend ?? KpiTrend;
  const { config } = widget;
  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const localeText = useStudioLocaleText();
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);
  const chartColors = usePageChartColors();

  // KPI cross-filter mode: 'none' (default) keeps the grand-total behaviour users expect
  // from summary cards; 'cross-filter' opts in to context-sensitivity.
  // 'cross-highlight' is not applicable to KPIs (no visual row representation), but treat
  // it as 'cross-filter' for backward compatibility with any saved dashboard configs.
  const crossFilterModeRaw = (config as StudioWidgetConfig).crossFilterMode;
  const crossFilterMode =
    crossFilterModeRaw === 'cross-highlight' ? 'cross-filter' : (crossFilterModeRaw ?? 'none');

  // Current-period rows via the shared pipeline hook.
  // When crossFilterMode is 'none' (default) we deliberately use filteredRowsNoCross so
  // the KPI always shows the absolute total, ignoring chart-click selections.
  // In 'cross-filter' or 'cross-highlight' mode we use effectiveRows, which respects
  // the active cross-filter (same as the chart widget does).
  const { filteredRowsNoCross, effectiveRows, isError, errorMessage } = useWidgetRows(
    widget,
    dataSource,
    pageId,
  );
  const currentRows = crossFilterMode === 'none' ? filteredRowsNoCross : effectiveRows;

  // Grain-aware rows for KPI value and sparkline computation (see useKpiGrainAnchoredRows).
  const { grainAnchoredRows, isGrainAnchored } = useKpiGrainAnchoredRows(
    currentRows,
    config.kpiValueField,
    widget.sourceId,
    dataSources,
    relationships,
    expressionFields,
  );

  const {
    displayValue,
    hasData,
    kpiNumericValue,
    rawValue,
    aggregation,
    measureExprField,
    measureKey,
  } = useKpiValue({ config, dataSource, currentRows, grainAnchoredRows, expressionFields });

  const { sparklineData, sparklineTimeField } = useKpiSparkline({
    config,
    widget,
    dataSource,
    pageId,
    filters,
    currentRows,
    grainAnchoredRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    crossFilterMode,
    dataSources,
    relationships,
    expressionFields,
    enabled: hasData && (config.kpiSparkline ?? false),
  });

  const { trendResult, trendNeedsDateFilter } = useKpiTrend({
    config,
    widget,
    dataSource,
    pageId,
    filters,
    currentRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    measureKey,
    rawValue,
    crossFilterMode,
    dataSources,
    relationships,
    expressionFields,
    enabled: hasData,
  });

  // Also check expressionFields (not just dataSource.fields) so a measure/calculated
  // field's format/currency/precision isn't dropped from the sparkline tooltip —
  // matching the lookup useKpiValue already does for the headline (finding 2.6).
  const fieldDef =
    dataSource?.fields.find((f) => f.id === config.kpiValueField) ??
    expressionFields.find((ef) => ef.id === config.kpiValueField);

  const filterSubtitle = React.useMemo(() => {
    if (!dataSource) {
      return '';
    }
    // Route through the same widget-scoped filter selection the trend/sparkline paths
    // use (`selectFiltersForWidget`) instead of a raw `scope.kind === 'page'` match with
    // no pageId check — otherwise the hover tooltip lists another page's (or a disabled)
    // filter as if it were applied to this KPI (finding 2.5).
    const relevant = selectFiltersForWidget(filters, {
      widgetId: widget.id,
      widgetSourceId: widget.sourceId,
      activePageId: pageId,
      include: crossFilterMode === 'none' ? 'no-cross' : 'all',
    });
    if (relevant.length === 0) {
      return '';
    }
    const fieldLabelMap = buildFieldLabelMap(dataSources, expressionFields);
    return relevant
      .map((f) => {
        const label = fieldLabelMap.get(f.field) ?? f.field;
        return `${label}: ${summarizeFilter(f)}`;
      })
      .join(' · ');
  }, [
    filters,
    dataSources,
    expressionFields,
    dataSource,
    widget.id,
    widget.sourceId,
    pageId,
    crossFilterMode,
  ]);

  const showSparkline = (config.kpiSparkline ?? false) && hasData;

  // Show an indicator when crossFilterMode is 'none' and there are active interactive
  // filters from other widgets that this KPI is intentionally ignoring.
  const hasIgnoredInteractiveFilters =
    crossFilterMode === 'none' &&
    filters.some((f) => f.scope.kind === 'interactive' && f.scope.sourceWidgetId !== widget.id);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 93,
        overflow: 'hidden',
      }}
    >
      {isError && (
        <StudioWidgetErrorOverlay message={errorMessage} sx={{ px: 1, pt: 0.5, py: 1 }} />
      )}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexGrow: 1,
          justifyContent: 'flex-start',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <Tooltip
          title={filterSubtitle || ''}
          disableHoverListener={!filterSubtitle}
          placement="top"
        >
          <span>
            <ValueComponent value={displayValue} hasData={hasData} {...slotProps?.value} />
          </span>
        </Tooltip>
        {showSparkline && (
          <SparklineComponent
            data={sparklineData}
            timeFieldResolved={sparklineTimeField !== null}
            plotType={config.kpiSparklinePlotType ?? 'line'}
            area={config.kpiSparklineArea ?? false}
            compact={config.kpiCompact ?? true}
            fieldFormat={fieldDef?.format}
            fieldPrecision={fieldDef?.precision}
            fieldCurrencyCode={fieldDef?.currencyCode}
            colors={chartColors}
            kpiValue={kpiNumericValue}
            gaugeMax={config.kpiSparklineGaugeMax ?? 100}
            {...slotProps?.sparkline}
          />
        )}
        {hasIgnoredInteractiveFilters && (
          <Tooltip title={localeText.kpiGrandTotalTooltip} placement="top">
            <InfoOutlinedIcon
              sx={{ fontSize: 14, color: 'text.disabled', flexShrink: 0, ml: 'auto' }}
            />
          </Tooltip>
        )}
      </Box>
      <TrendComponent
        trendResult={trendResult}
        needsDateFilter={trendNeedsDateFilter}
        isInverted={config.kpiTrendInvert ?? false}
        {...slotProps?.trend}
        sx={[
          { mt: 'auto' },
          ...(Array.isArray(slotProps?.trend?.sx)
            ? slotProps.trend.sx
            : [slotProps?.trend?.sx].filter(Boolean)),
        ]}
      />
    </Box>
  );
});
