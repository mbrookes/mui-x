'use client';
import * as React from 'react';
import { Box } from '@mui/material';

import type { StudioDataSource, StudioWidget, StudioFilterState } from '../models';
import { resolveRows, resolveMetricRefs } from '../internals/chartUtils';
import { useStudioSelector } from '../context';
import { formatNumber } from '../internals/numberFormat';
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
  const filters = useStudioSelector((state) => state.filters);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const relationships = useStudioSelector((state) => state.relationships);
  const expressionFields = useStudioSelector((state) => state.expressionFields);

  const { displayValue, hasData, sparklineData, sparklineTimeField, trendResult, trendNeedsDateFilter } =
    React.useMemo(() => {
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

      const pageFilters = filters.filter((f) => f.scope === 'page');
      const widgetFilters = filters.filter((f) => f.scope === 'widget' && f.widgetId === widget.id);
      const allFilters = resolveMetricRefs([...pageFilters, ...widgetFilters], dataSources);

      const rows = resolveRows(
        dataSource.rows,
        widget.sourceId,
        allFilters,
        dataSources,
        relationships,
        expressionFields,
      );
      const aggregation = config.kpiAggregation ?? 'sum';

      const measureExprField = expressionFields.find(
        (ef) => ef.id === config.kpiValueField && ef.isMeasure,
      );
      const value = measureExprField
        ? evaluateMeasure(measureExprField, rows, expressionFields)
        : computeAggregate(rows, config.kpiValueField!, aggregation);

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

          kpiSparklineData = computeSparklineData(
            sparklineRows,
            timeField,
            config.kpiValueField!,
            aggregation,
            granularity,
            config.kpiSparklineCumulative ?? false,
          );
        }
      }

      // Trend
      let kpiTrend: KpiTrendResult | null = null;

      const needsDateFilter =
        !!(config.kpiTrend && config.kpiValueField) &&
        !findDateFilter(filters, widget.id, dataSource);

      if (config.kpiTrend && config.kpiValueField) {
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
              dataSource.rows,
              widget.sourceId,
              prevFilters,
              dataSources,
              relationships,
              expressionFields,
            );
            const previousValue = measureExprField
              ? evaluateMeasure(measureExprField, prevRows, expressionFields)
              : computeAggregate(prevRows, config.kpiValueField, aggregation);

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
    }, [dataSource, filters, dataSources, relationships, expressionFields, config, widget.id, widget.sourceId]);

  const fieldDef = dataSource?.fields.find((f) => f.id === config.kpiValueField);

  const showSparkline = config.kpiSparkline ?? false;
  const showSparklineArea = showSparkline && sparklineData !== null && sparklineData.length > 1;
  const showSparklineHintArea = showSparkline && sparklineTimeField === null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, height: '100%', minWidth: 232 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexGrow: showSparklineArea || showSparklineHintArea ? 1 : 0,
        }}
      >
        <KpiValue value={displayValue} hasData={hasData} />
        {showSparkline && (
          <KpiSparkline
            data={sparklineData}
            timeFieldResolved={sparklineTimeField !== null}
            plotType={config.kpiSparklinePlotType ?? 'line'}
            area={config.kpiSparklineArea ?? false}
            compact={config.kpiCompact ?? true}
            fieldFormat={fieldDef?.format}
            fieldCurrencyCode={fieldDef?.currencyCode}
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
