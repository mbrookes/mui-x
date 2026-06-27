'use client';
import * as React from 'react';
import { Box, Tooltip } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

import type { StudioDataSource, StudioWidget, StudioFilterState } from '../../../models';
import { summarizeFilter } from '../../StudioFiltersDrawer/filterDrawerUtils';
import {
  resolveRows,
  resolveChartRowsForAggregation,
  analyzeChartSupport,
} from '../../../internals/chartUtils';
import { getCachedEnrichedRows } from '../../../internals/enrichedRowsCache';
import { collectSelectFields } from '../../../internals/queryDescriptor';
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
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  /** ID of the page this widget belongs to. Used to scope page-level filters correctly. */
  pageId: string;
  slots?: StudioKpiWidgetSlots;
  slotProps?: StudioKpiWidgetSlotProps;
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
  const crossFilterMode =
    config.crossFilterMode === 'cross-highlight'
      ? 'cross-filter'
      : (config.crossFilterMode ?? 'none');

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

  // Grain-aware rows for KPI value and sparkline computation.
  //
  // When kpiValueField belongs to a related (parent) source — e.g. a KPI on order_items
  // using orders.revenue — calling computeAggregate over the widget's own rows inflates
  // the result because each parent-level value is repeated once per child row.
  // resolveChartRowsForAggregation re-anchors to the correct aggregation grain (the parent
  // source rows, filtered to those that have at least one matching child row).
  //
  // Measure expression fields handle their own aggregation via evaluateMeasure and are
  // excluded from re-anchoring.
  //
  // isGrainAnchored is true when the value field is on a different (parent) source and the
  // re-anchoring actually changed the row grain. Used to skip the redundant time-field join
  // in the sparkline path when the time field is also on the anchor source rows natively.
  const currentKpiValueField = config.kpiValueField;
  const { grainAnchoredRows, isGrainAnchored } = React.useMemo(() => {
    const isMeasure = currentKpiValueField
      ? expressionFields.some((ef) => ef.id === currentKpiValueField && ef.isMeasure)
      : false;
    if (!currentKpiValueField || !widget.sourceId || isMeasure) {
      return { grainAnchoredRows: currentRows, isGrainAnchored: false };
    }
    const support = analyzeChartSupport(
      widget.sourceId,
      undefined,
      [currentKpiValueField],
      undefined,
      undefined,
      dataSources,
      relationships,
      expressionFields,
    );
    if (
      !support.supported ||
      !support.anchorSourceId ||
      support.anchorSourceId === widget.sourceId
    ) {
      return { grainAnchoredRows: currentRows, isGrainAnchored: false };
    }
    return {
      grainAnchoredRows: resolveChartRowsForAggregation(
        currentRows,
        widget.sourceId,
        undefined,
        [currentKpiValueField],
        undefined,
        dataSources,
        relationships,
        expressionFields,
      ),
      isGrainAnchored: true,
    };
  }, [
    currentRows,
    currentKpiValueField,
    widget.sourceId,
    expressionFields,
    dataSources,
    relationships,
  ]);

  const {
    displayValue,
    hasData,
    sparklineData,
    sparklineTimeField,
    trendResult,
    trendNeedsDateFilter,
    kpiNumericValue,
  } = React.useMemo(() => {
    // With no value field the only meaningful aggregation is a row "count" (the setup
    // panel locks the selector to Count in that state). Default accordingly so a KPI
    // reproduced from scratch — source picked, value field left empty, aggregation not
    // explicitly persisted — still renders a count rather than the no-data placeholder.
    const aggregation = config.kpiAggregation ?? (config.kpiValueField ? 'sum' : 'count');
    // A "count" aggregation tallies rows and is field-independent, so it is a
    // complete, reproducible configuration on its own — no value field required.
    // Any other aggregation needs a value field to operate on.
    const isFieldlessCount = aggregation === 'count' && !config.kpiValueField;
    if (!dataSource?.rows || (!config.kpiValueField && !isFieldlessCount)) {
      return {
        displayValue: '—',
        hasData: false,
        sparklineData: null,
        sparklineTimeField: null,
        trendResult: null,
        trendNeedsDateFilter: false,
        kpiNumericValue: 0,
      };
    }

    const rows = currentRows;

    const measureExprField = expressionFields.find(
      (ef) => ef.id === config.kpiValueField && ef.isMeasure,
    );
    const measureKey = measureExprField ? `measure:${measureExprField.id}` : `agg:${aggregation}`;
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

    // Sparkline
    let kpiSparklineData: number[] | null = null;
    let kpiSparklineTimeField: string | null = null;

    if (config.kpiSparkline) {
      const dateFilter = findDateFilter(filters, widget.id, dataSource);
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
            ),
        );
      }
    }

    // Trend
    let kpiTrend: KpiTrendResult | null = null;

    const hasFixedPeriodTrend = !!(config.kpiTrend && config.kpiTrendFixedPeriod);

    // Fixed-period mode derives its own windows from today — no date filter required.
    // The existing filter-based mode still requires an active date filter to define the
    // current period (shown as a warning badge when missing).
    const needsDateFilter =
      !hasFixedPeriodTrend &&
      !!(config.kpiTrend && config.kpiValueField) &&
      !findDateFilter(filters, widget.id, dataSource);

    if (config.kpiTrend && (config.kpiValueField || hasFixedPeriodTrend)) {
      if (hasFixedPeriodTrend) {
        // Fixed-period mode: compute rolling windows from today without a date filter.
        // The headline (value / currentRows) is the all-time total — unfiltered. Only
        // the trend delta rows are windowed by the date field.
        const fixedDateField =
          config.kpiSparklineField ??
          dataSource.fields.find((f) => f.type === 'date' || f.type === 'datetime')?.id ??
          null;
        if (fixedDateField) {
          const today = new Date();
          const currentRange = computeFixedPeriodRange(config.kpiTrendFixedPeriod!, today);
          const comparisonMode = config.kpiTrendComparison ?? 'previous-period';
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

          const aggField = config.kpiValueField ?? '';
          const currentPeriodValue = computeAggregate(currentPeriodRows, aggField, aggregation);
          const previousValue = computeAggregate(prevPeriodRows, aggField, aggregation);

          if (previousValue !== 0) {
            kpiTrend = {
              delta: (currentPeriodValue - previousValue) / Math.abs(previousValue),
              previousValue,
              previousStart: prevRange.start,
              previousEnd: prevRange.end,
            };
          } else if (currentPeriodValue !== 0) {
            kpiTrend = {
              delta: Infinity,
              previousValue,
              previousStart: prevRange.start,
              previousEnd: prevRange.end,
            };
          }
        }
      } else {
        // In this branch hasFixedPeriodTrend is false, so the outer gate's
        // (config.kpiValueField || hasFixedPeriodTrend) means kpiValueField is set.
        const previousKpiValueField = config.kpiValueField!;
        const dateFilter = findDateFilter(filters, widget.id, dataSource);
        if (dateFilter) {
          const currentRange = extractDateRange(dateFilter);
          if (currentRange) {
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
            for (const f of filters) {
              if (f.field) {
                kpiUsedFieldIds.add(f.field);
              }
            }
            const preEnrichedRows = getCachedEnrichedRows(
              dataSource.rows,
              widget.sourceId,
              expressionFields,
              dataSources,
              relationships,
              kpiUsedFieldIds,
            );

            // Build allFilters for the previous period using the same scope as currentRows.
            // When crossFilterMode is 'none', currentRows = filteredRowsNoCross which excludes
            // interactive and cross-filter scopes. Including interactive filters here would cause
            // the trend delta to reflect different filter states for current vs previous period.
            const pageFilters = filters.filter(
              (f) => f.scope.kind === 'page' || f.scope.kind === 'dashboard-date-range',
            );
            const widgetFilters = filters.filter(
              (f) => f.scope.kind === 'widget' && f.scope.widgetId === widget.id,
            );
            const interactiveFilters =
              crossFilterMode !== 'none'
                ? filters.filter(
                    (f) => f.scope.kind === 'interactive' && f.scope.sourceWidgetId !== widget.id,
                  )
                : [];
            const allFilters = [...pageFilters, ...widgetFilters, ...interactiveFilters];

            const prevDateFilter: StudioFilterState = {
              ...dateFilter,
              operator: 'greater_than_or_equal',
              value: prevRange.start.toISOString().slice(0, 10),
              operator2: 'less_than_or_equal',
              value2: prevRange.end.toISOString().slice(0, 10),
              conjunction: 'and',
            };
            const prevFilters = allFilters.map((f) =>
              f.id === dateFilter.id ? prevDateFilter : f,
            );
            const prevRows = resolveRows(
              preEnrichedRows,
              widget.sourceId,
              prevFilters,
              dataSources,
              relationships,
              expressionFields,
              { skipEnrichment: true },
            );
            const previousValue = cachedCompute(
              prevRows,
              `kpi-value:${previousKpiValueField}:${measureKey}`,
              () => {
                if (measureExprField) {
                  return evaluateMeasure(measureExprField, prevRows, expressionFields);
                }
                if (isGrainAnchored) {
                  // Apply the same grain anchoring to prevRows as we do for the current period.
                  // prevRows are already filtered to the previous date range via prevFilters, so
                  // resolveChartRowsForAggregation will re-anchor to the correct parent-source
                  // grain while respecting that pre-filtered row set.
                  const prevGrainRows = resolveChartRowsForAggregation(
                    prevRows,
                    widget.sourceId,
                    undefined,
                    [previousKpiValueField],
                    undefined,
                    dataSources,
                    relationships,
                    expressionFields,
                  );
                  return computeAggregate(prevGrainRows, previousKpiValueField, aggregation);
                }
                return computeAggregate(prevRows, previousKpiValueField, aggregation);
              },
            );

            if (previousValue !== 0) {
              kpiTrend = {
                delta: (value - previousValue) / Math.abs(previousValue),
                previousValue,
                previousStart: prevRange.start,
                previousEnd: prevRange.end,
              };
            } else if (value !== 0) {
              kpiTrend = {
                delta: Infinity,
                previousValue,
                previousStart: prevRange.start,
                previousEnd: prevRange.end,
              };
            }
          }
        }
      }
    }

    return {
      displayValue: kpiDisplay,
      hasData: true,
      sparklineData: kpiSparklineData,
      sparklineTimeField: kpiSparklineTimeField,
      trendResult: kpiTrend,
      trendNeedsDateFilter: needsDateFilter,
      kpiNumericValue: semanticValue,
    };
  }, [
    currentRows,
    grainAnchoredRows,
    isGrainAnchored,
    dataSource,
    filters,
    dataSources,
    relationships,
    expressionFields,
    config,
    widget,
    crossFilterMode,
  ]);

  const fieldDef = dataSource?.fields.find((f) => f.id === config.kpiValueField);

  const filterSubtitle = React.useMemo(() => {
    if (!dataSource) {
      return '';
    }
    const relevant = filters.filter(
      (f) =>
        f.scope.kind === 'page' ||
        f.scope.kind === 'dashboard-date-range' ||
        (f.scope.kind === 'widget' && f.scope.widgetId === widget.id),
    );
    if (relevant.length === 0) {
      return '';
    }
    const fieldLabelMap = new Map<string, string>();
    for (const ds of Object.values(dataSources)) {
      for (const f of ds.fields) {
        if (!fieldLabelMap.has(f.id)) {
          fieldLabelMap.set(f.id, f.label);
        }
      }
    }
    for (const ef of expressionFields) {
      if (!fieldLabelMap.has(ef.id)) {
        fieldLabelMap.set(ef.id, ef.label);
      }
    }
    return relevant
      .map((f) => {
        const label = fieldLabelMap.get(f.field) ?? f.field;
        return `${label}: ${summarizeFilter(f)}`;
      })
      .join(' · ');
  }, [filters, dataSources, expressionFields, dataSource, widget.id]);

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
