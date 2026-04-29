'use client';
import * as React from 'react';
import { Box, Typography } from '@mui/material';
import { SparkLineChart } from '@mui/x-charts/SparkLineChart';

import type { StudioDataSource, StudioKpiAggregation, StudioWidget, StudioFilterState } from '../models';
import { resolveRows, resolveMetricRefs, normalizeToDate } from './chartUtils';
import { useStudioSelector } from '../context';
import { formatNumber } from './numberFormat';

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

export const StudioKpiWidget = React.memo(function StudioKpiWidget(props: StudioKpiWidgetProps) {
  const { dataSource, widget } = props;
  const { config } = widget;
  const filters = useStudioSelector((state) => state.filters);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const relationships = useStudioSelector((state) => state.relationships);

  const { displayValue, hasData, sparklineData, sparklineTimeField } = React.useMemo(() => {
    if (!dataSource?.rows || !config.kpiValueField) {
      return { displayValue: '—', hasData: false, sparklineData: null, sparklineTimeField: null };
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
    );
    const aggregation = config.kpiAggregation ?? 'sum';
    const value = computeAggregate(rows, config.kpiValueField, aggregation);

    const fieldDef = dataSource.fields.find((f) => f.id === config.kpiValueField);
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

    return {
      displayValue: kpiDisplay,
      hasData: true,
      sparklineData: kpiSparklineData,
      sparklineTimeField: kpiSparklineTimeField,
    };
  }, [dataSource, filters, dataSources, relationships, config, widget.id, widget.sourceId]);

  const fieldDef = dataSource?.fields.find((f) => f.id === config.kpiValueField);

  const hasSparkline = config.kpiSparkline && sparklineData && sparklineData.length > 1;
  const showSparklineHint =
    config.kpiSparkline && (!sparklineData || sparklineData.length <= 1) && sparklineTimeField === null;

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
    </Box>
  );
});
