'use client';
import * as React from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat';
import { SparkLineChart } from '@mui/x-charts/SparkLineChart';

import type { StudioDataSource, StudioKpiAggregation, StudioWidget, StudioFilterState } from '../models';
import { resolveRows, resolveMetricRefs, normalizeToDate } from './chartUtils';
import { useStudioSelector } from '../context';
import { formatNumber } from './numberFormat';
import { evaluateMeasure } from '../utils/expressionEvaluator';

export interface StudioKpiWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

function computeAggregate(
  rows: Record<string, unknown>[],
  field: string,
  aggregation: StudioKpiAggregation,
): number {
  if (aggregation === 'count') {
    return rows.length;
  }

  const values = rows.map((row) => Number(row[field] ?? 0)).filter((v) => !Number.isNaN(v));

  if (values.length === 0) {
    return 0;
  }

  switch (aggregation) {
    case 'sum':
      return values.reduce((acc, v) => acc + v, 0);
    case 'avg':
      return values.reduce((acc, v) => acc + v, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    default:
      return values.reduce((acc, v) => acc + v, 0);
  }
}

type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

function getBucketKey(date: Date, granularity: Granularity): string {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  switch (granularity) {
    case 'day':
      return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    case 'week': {
      // ISO week start (Monday)
      const day = date.getDay() || 7;
      const monday = new Date(date);
      monday.setDate(d - day + 1);
      return `${monday.getFullYear()}-W${String(monday.getDate()).padStart(2, '0')}-${String(monday.getMonth() + 1).padStart(2, '0')}`;
    }
    case 'month':
      return `${y}-${String(m + 1).padStart(2, '0')}`;
    case 'quarter':
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    case 'year':
      return `${y}`;
    default:
      return `${y}-${String(m + 1).padStart(2, '0')}`;
  }
}

function autoGranularity(start: Date, end: Date): Granularity {
  const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 14) {
    return 'day';
  }
  if (days <= 90) {
    return 'week';
  }
  if (days <= 730) {
    return 'month';
  }
  if (days <= 1460) {
    return 'quarter';
  }
  return 'year';
}

function computeSparklineData(
  rows: Record<string, unknown>[],
  timeField: string,
  valueField: string,
  aggregation: StudioKpiAggregation,
  granularity: Granularity,
  cumulative: boolean,
): number[] {
  const buckets = new Map<string, Record<string, unknown>[]>();

  for (const row of rows) {
    const raw = row[timeField];
    if (raw === null || raw === undefined) {
      continue;
    }
    const date = normalizeToDate(raw);
    if (!date) {
      continue;
    }
    const key = getBucketKey(date, granularity);
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key)!.push(row);
  }

  const sortedKeys = Array.from(buckets.keys()).sort();
  const periodValues = sortedKeys.map((key) =>
    computeAggregate(buckets.get(key)!, valueField, aggregation),
  );

  if (!cumulative) {
    return periodValues;
  }

  let running = 0;
  return periodValues.map((v) => {
    running += v;
    return running;
  });
}

/** Find the first date/datetime filter that applies to this widget (page or widget scope). */
function findDateFilter(
  filters: StudioFilterState[],
  widgetId: string,
  dataSource: StudioDataSource,
): StudioFilterState | undefined {
  const relevant = filters.filter(
    (f) => f.scope === 'page' || (f.scope === 'widget' && f.widgetId === widgetId),
  );
  return relevant.find((f) => {
    const fieldDef = dataSource.fields.find((fd) => fd.id === f.field);
    return fieldDef?.type === 'date' || fieldDef?.type === 'datetime';
  });
}

/** Extract a date range [start, end] from a filter, accounting for compound conditions. */
function extractDateRange(filter: StudioFilterState): { start: Date; end: Date } | null {
  const toDate = (v: unknown): Date | null => {
    if (!v) {
      return null;
    }
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const v1 = toDate(filter.value);
  const v2 = toDate(filter.value2);

  if (v1 && v2 && filter.conjunction === 'and') {
    const start = v1 < v2 ? v1 : v2;
    const end = v1 < v2 ? v2 : v1;
    return { start, end };
  }
  if (v1) {
    // Single-sided — use v1 ± 1 year as a fallback range
    const start = new Date(v1);
    start.setFullYear(start.getFullYear() - 1);
    return { start, end: v1 };
  }
  return null;
}

type TrendComparison = 'previous-period' | 'previous-calendar-period' | 'year-over-year';

/**
 * Given a current [start, end] date range and a comparison mode, computes the
 * [start, end] of the previous comparison period.
 */
function computePreviousPeriodRange(
  start: Date,
  end: Date,
  mode: TrendComparison,
): { start: Date; end: Date } {
  if (mode === 'year-over-year') {
    const prevStart = new Date(start);
    prevStart.setFullYear(start.getFullYear() - 1);
    const prevEnd = new Date(end);
    prevEnd.setFullYear(end.getFullYear() - 1);
    return { start: prevStart, end: prevEnd };
  }

  if (mode === 'previous-calendar-period') {
    const granularity = autoGranularity(start, end);
    if (granularity === 'year') {
      return {
        start: new Date(start.getFullYear() - 1, 0, 1),
        end: new Date(start.getFullYear() - 1, 11, 31, 23, 59, 59, 999),
      };
    }
    if (granularity === 'quarter') {
      const q = Math.floor(start.getMonth() / 3);
      const prevQ = q === 0 ? 3 : q - 1;
      const prevYear = q === 0 ? start.getFullYear() - 1 : start.getFullYear();
      return {
        start: new Date(prevYear, prevQ * 3, 1),
        end: new Date(prevYear, prevQ * 3 + 3, 0, 23, 59, 59, 999),
      };
    }
    if (granularity === 'week') {
      // Previous 7-day block
      const ms = 7 * 24 * 60 * 60 * 1000;
      return {
        start: new Date(start.getTime() - ms),
        end: new Date(end.getTime() - ms),
      };
    }
    // month (default)
    const prevMonth = start.getMonth() === 0 ? 11 : start.getMonth() - 1;
    const prevYear = start.getMonth() === 0 ? start.getFullYear() - 1 : start.getFullYear();
    return {
      start: new Date(prevYear, prevMonth, 1),
      end: new Date(prevYear, prevMonth + 1, 0, 23, 59, 59, 999),
    };
  }

  // Default: 'previous-period' — shift by the current window duration
  const duration = end.getTime() - start.getTime();
  return {
    start: new Date(start.getTime() - duration),
    end: new Date(start.getTime() - 1),
  };
}

/** Format a date as a short human-readable label, e.g. "Mar 2026" or "Mar 1–31". */
function formatPeriodShort(start: Date, end: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${months[start.getMonth()]} ${start.getFullYear()}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${months[start.getMonth()]}–${months[end.getMonth()]} ${start.getFullYear()}`;
  }
  return `${months[start.getMonth()]} ${start.getFullYear()}–${months[end.getMonth()]} ${end.getFullYear()}`;
}

/** Format a full date range for a tooltip, e.g. "Mar 1 – Mar 31, 2026". */
function formatDateRangeLong(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const startStr = start.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}

export const StudioKpiWidget = React.memo(function StudioKpiWidget(props: StudioKpiWidgetProps) {
  const { dataSource, widget } = props;
  const { config } = widget;
  const filters = useStudioSelector((state) => state.filters);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const relationships = useStudioSelector((state) => state.relationships);
  const expressionFields = useStudioSelector((state) => state.expressionFields);

  const { displayValue, hasData, sparklineData, sparklineTimeField, trendResult } = React.useMemo(() => {
    if (!dataSource?.rows || !config.kpiValueField) {
      return { displayValue: '—', hasData: false, sparklineData: null, sparklineTimeField: null, trendResult: null };
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

    // Check if the KPI value field is a measure expression field
    const measureExprField = expressionFields.find(
      (ef) => ef.id === config.kpiValueField && ef.isMeasure,
    );
    const value = measureExprField
      ? evaluateMeasure(measureExprField, rows, expressionFields)
      : computeAggregate(rows, config.kpiValueField, aggregation);

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
      // Resolve time field: prefer auto-detected date filter, then manual config
      const dateFilter = findDateFilter(filters, widget.id, dataSource);
      const timeField = dateFilter?.field ?? config.kpiSparklineField ?? null;

      if (timeField) {
        kpiSparklineTimeField = timeField;

        // Determine granularity
        let granularity: Granularity = config.kpiSparklineGranularity ?? 'month';
        if (!config.kpiSparklineGranularity && dateFilter) {
          const range = extractDateRange(dateFilter);
          if (range) {
            granularity = autoGranularity(range.start, range.end);
          }
        }

        // If the time field lives on a related source, join it into the rows
        let sparklineRows = rows;
        const timeFieldSourceId = config.kpiSparklineSourceId;
        if (timeFieldSourceId && timeFieldSourceId !== widget.sourceId) {
          const relSource = dataSources[timeFieldSourceId];
          if (relSource?.rows) {
            // Build a lookup: foreign join key → date value
            const joinKeyMap = new Map<unknown, unknown>();
            // Find the relationship between our source and the related source
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
          config.kpiValueField,
          aggregation,
          granularity,
          config.kpiSparklineCumulative ?? false,
        );
      }
    }

    // Trend
    let kpiTrend: {
      delta: number;
      previousValue: number;
      previousStart: Date;
      previousEnd: Date;
    } | null = null;

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

          // Build a modified filter set: replace the date filter with the previous period range
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
            // previous was zero but current is non-zero — show as "new"
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
    };
  }, [dataSource, filters, dataSources, relationships, expressionFields, config, widget.id, widget.sourceId]);

  const fieldDef = dataSource?.fields.find((f) => f.id === config.kpiValueField);

  const hasSparkline = config.kpiSparkline && sparklineData && sparklineData.length > 1;
  const showSparklineHint =
    config.kpiSparkline && (!sparklineData || sparklineData.length <= 1) && sparklineTimeField === null;

  const hasTrend = config.kpiTrend && trendResult != null;
  const trendUp = hasTrend && trendResult!.delta > 0;
  const trendDown = hasTrend && trendResult!.delta < 0;
  const trendFlat = hasTrend && trendResult!.delta === 0;
  const isInverted = config.kpiTrendInvert ?? false;
  const trendColor = trendFlat
    ? 'text.secondary'
    : ((trendUp && !isInverted) || (trendDown && isInverted))
      ? 'success.main'
      : 'error.main';

  let trendLabel = '';
  let trendTooltip = '';
  if (hasTrend) {
    const pct = Number.isFinite(trendResult!.delta)
      ? `${trendResult!.delta >= 0 ? '+' : ''}${(trendResult!.delta * 100).toFixed(1)}%`
      : 'New';
    const periodShort = formatPeriodShort(trendResult!.previousStart, trendResult!.previousEnd);
    trendLabel = `${pct} vs. ${periodShort}`;
    trendTooltip = formatDateRangeLong(trendResult!.previousStart, trendResult!.previousEnd);
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, height: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexGrow: hasSparkline || showSparklineHint ? 1 : 0 }}>
        <Typography
          variant="h3"
          sx={{ fontSize: 40, fontWeight: 700, lineHeight: 1, flexShrink: 0 }}
          color={hasData ? 'text.primary' : 'text.disabled'}
        >
          {displayValue}
        </Typography>

        {hasSparkline && (
          <Box sx={{ flexGrow: 1, minWidth: 80, alignSelf: 'stretch', minHeight: 48 }}>
            <SparkLineChart
              data={sparklineData}
              plotType={config.kpiSparklinePlotType ?? 'line'}
              area={
                config.kpiSparklinePlotType !== 'bar' ? (config.kpiSparklineArea ?? false) : undefined
              }
              showHighlight
              showTooltip
              valueFormatter={(v) =>
                v === null
                  ? ''
                  : formatNumber(v, fieldDef?.format, fieldDef?.currencyCode, config.kpiCompact ?? true)
              }
              sx={{ height: '100%' }}
              margin={{ top: 4, bottom: 4, left: 4, right: 4 }}
            />
          </Box>
        )}

        {showSparklineHint && (
          <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
            Add a date filter or select a time field to show a sparkline.
          </Typography>
        )}
      </Box>

      {hasTrend && (
        <Tooltip title={`Previous period: ${trendTooltip}`} placement="bottom-start">
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', cursor: 'default' }}>
            {trendFlat && <TrendingFlatIcon fontSize="small" sx={{ color: trendColor }} />}
            {trendUp && <TrendingUpIcon fontSize="small" sx={{ color: trendColor }} />}
            {trendDown && <TrendingDownIcon fontSize="small" sx={{ color: trendColor }} />}
            <Typography variant="body2" sx={{ color: trendColor, fontWeight: 500 }}>
              {trendLabel}
            </Typography>
          </Stack>
        </Tooltip>
      )}
    </Box>
  );
});
