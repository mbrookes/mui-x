'use client';
import * as React from 'react';
import { Box, Tooltip } from '@mui/material';

import type {
  StudioDataSource,
  StudioWidget,
  StudioFilterState,
} from '../models';
import { summarizeFilter } from '../StudioFiltersDrawer/filterDrawerUtils';
import { resolveRows, resolveMetricRefs } from '../internals/chartUtils';
import { getCachedEnrichedRows } from '../internals/enrichedRowsCache';
import { collectSelectFields } from '../internals/queryDescriptor';
import { usePageChartColors } from '../internals/usePageChartColors';
import { useWidgetRows } from '../internals/useWidgetRows';
import {
  useStudioSelector,
  selectFilters,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSource,
} from '../context';
import { formatNumber } from '../internals/numberFormat';
import { cachedCompute } from '../internals/computedCache';
import { evaluateMeasure } from '../utils/expressionEvaluator';
import {
  type Granularity,
  autoGranularity,
  extractDateRange,
  findDateFilter,
  computePreviousPeriodRange,
  computeAggregate,
  computeSparklineData,
} from './kpiUtils';
import { KpiValue } from './KpiValue';
import { KpiSparkline } from './KpiSparkline';
import { KpiTrend, type KpiTrendResult } from './KpiTrend';

export interface StudioKpiWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

export const StudioKpiWidget = React.memo(function StudioKpiWidget(props: StudioKpiWidgetProps) {
  const { dataSource, widget } = props;
  const { config } = widget;
  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);
  const chartColors = usePageChartColors();

  // Current-period rows via the shared pipeline hook.
  // KPI widgets intentionally ignore cross-filters (they show absolute totals), so we
  // use filteredRowsNoCross, which excludes cross-filter and interactive-filter constraints.
  const { filteredRowsNoCross: currentRows } = useWidgetRows(widget, dataSource);

  const {
    displayValue,
    hasData,
    sparklineData,
    sparklineTimeField,
    trendResult,
    trendNeedsDateFilter,
  } = React.useMemo(() => {
    if (!dataSource?.rows || !config.kpiValueField) {
      return {
        displayValue: '—',
        hasData: false,
        sparklineData: null,
        sparklineTimeField: null,
        trendResult: null,
        trendNeedsDateFilter: false,
      };
    }

    const rows = currentRows;
    const aggregation = config.kpiAggregation ?? 'sum';

    const measureExprField = expressionFields.find(
      (ef) => ef.id === config.kpiValueField && ef.isMeasure,
    );
    const measureKey = measureExprField ? `measure:${measureExprField.id}` : `agg:${aggregation}`;
    const value = cachedCompute(
      rows,
      `kpi-value:${config.kpiValueField}:${measureKey}`,
      () =>
        measureExprField
          ? evaluateMeasure(measureExprField, rows, expressionFields)
          : computeAggregate(rows, config.kpiValueField!, aggregation),
    );

    const fieldDef =
      dataSource.fields.find((f) => f.id === config.kpiValueField) ??
      expressionFields.find((ef) => ef.id === config.kpiValueField);
    // avg of a boolean field is a 0–1 ratio; scale to 0–100 and display as percent
    const isBooleanAvg = fieldDef?.type === 'boolean' && aggregation === 'avg';
    const formatted = formatNumber(
      isBooleanAvg ? value * 100 : value,
      isBooleanAvg ? 'percent' : fieldDef?.format,
      fieldDef?.currencyCode,
      config.kpiCompact ?? true,
    );
    const kpiDisplay = `${config.kpiPrefix ?? ''}${formatted}${config.kpiSuffix ?? ''}`;

    // Sparkline
    let kpiSparklineData: number[] | null = null;
    let kpiSparklineTimeField: string | null = null;

    if (config.kpiSparkline) {
      const dateFilter = findDateFilter(filters, widget.id, dataSource);
      const timeField = dateFilter?.field ?? config.kpiSparklineField ?? null;

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
        if (timeFieldSourceId && timeFieldSourceId !== widget.sourceId) {
          const relSource = dataSources[timeFieldSourceId];
          if (relSource?.rows) {
            const joinKeyMap = new Map<unknown, unknown>();
            const rel = relationships.find(
              (r) =>
                (r.sourceId === widget.sourceId && r.targetId === timeFieldSourceId) ||
                (r.targetId === widget.sourceId && r.sourceId === timeFieldSourceId),
            );
            if (rel) {
              const widgetJoinField =
                rel.sourceId === widget.sourceId ? rel.sourceField : rel.targetField;
              const foreignJoinField =
                rel.sourceId === widget.sourceId ? rel.targetField : rel.sourceField;
              for (const foreignRow of relSource.rows) {
                joinKeyMap.set(foreignRow[foreignJoinField], foreignRow[timeField]);
              }
              sparklineRows = rows.map((r) => ({
                ...r,
                [timeField]: joinKeyMap.get(r[widgetJoinField]),
              }));
            }
          }
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

    const needsDateFilter =
      !!(config.kpiTrend && config.kpiValueField) &&
      !findDateFilter(filters, widget.id, dataSource);

    if (config.kpiTrend && config.kpiValueField) {
      const kpiValueField = config.kpiValueField;
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

          // Build allFilters for the previous period (page + widget + interactive only;
          // cross-filters are intentionally excluded for KPI trend comparisons).
          const pageFilters = filters.filter((f) => f.scope === 'page');
          const widgetFilters = filters.filter(
            (f) => f.scope === 'widget' && f.widgetId === widget.id,
          );
          const interactiveFilters = filters.filter(
            (f) => f.scope === 'interactive' && f.sourceWidgetId !== widget.id,
          );
          const allFilters = resolveMetricRefs(
            [...pageFilters, ...widgetFilters, ...interactiveFilters],
            dataSources,
          );

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
          const previousValue = cachedCompute(
            prevRows,
            `kpi-value:${kpiValueField}:${measureKey}`,
            () =>
              measureExprField
                ? evaluateMeasure(measureExprField, prevRows, expressionFields)
                : computeAggregate(prevRows, kpiValueField, aggregation),
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

    return {
      displayValue: kpiDisplay,
      hasData: true,
      sparklineData: kpiSparklineData,
      sparklineTimeField: kpiSparklineTimeField,
      trendResult: kpiTrend,
      trendNeedsDateFilter: needsDateFilter,
    };
  }, [
    currentRows,
    dataSource,
    filters,
    dataSources,
    relationships,
    expressionFields,
    config,
    widget,
  ]);

  const fieldDef = dataSource?.fields.find((f) => f.id === config.kpiValueField);

  const filterSubtitle = React.useMemo(() => {
    if (!dataSource) {
      return '';
    }
    const relevant = filters.filter(
      (f) => f.scope === 'page' || (f.scope === 'widget' && f.widgetId === widget.id),
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

  const showSparkline = config.kpiSparkline ?? false;

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
            <KpiValue value={displayValue} hasData={hasData} />
          </span>
        </Tooltip>
        {showSparkline && (
          <KpiSparkline
            data={sparklineData}
            timeFieldResolved={sparklineTimeField !== null}
            plotType={config.kpiSparklinePlotType ?? 'line'}
            area={config.kpiSparklineArea ?? false}
            compact={config.kpiCompact ?? true}
            fieldFormat={fieldDef?.format}
            fieldCurrencyCode={fieldDef?.currencyCode}
            colors={chartColors}
          />
        )}
      </Box>
      <KpiTrend
        trendResult={trendResult}
        needsDateFilter={trendNeedsDateFilter}
        isInverted={config.kpiTrendInvert ?? false}
      />
    </Box>
  );
});
