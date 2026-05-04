'use client';

import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';
import { ScatterChart } from '@mui/x-charts/ScatterChart';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box } from '@mui/material';

import { Typography } from '@mui/material';
import type { StudioDataSource, StudioWidget } from '../models';
import {
  fillTemporalLabelGaps,
  formatTemporalAxisLabel,
  formatPeriodLabel,
  getTemporalAxisData,
  getChartSupportMessage,
} from '../internals/chartUtils';
import { useStudioController, useStudioSelector } from '../context';
import { formatNumber } from '../internals/numberFormat';
import type { StudioNumberFormat } from '../models/studio';
import { useChartWidgetData } from './useChartWidgetData';
import { buildMultiYLineSeries } from './lineSeries';

export interface StudioChartWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  height?: number;
}

export const CHART_MIN_HEIGHT = 260;
const CROSS_FILTER_AXIS_ID = 'cross-filter-axis';
const CROSS_FILTER_SERIES_ID = 'cross-filter-series';

function densifyBarLabels(labels: (string | number)[]) {
  return fillTemporalLabelGaps(labels);
}

function createLineXAxisConfig(
  labels: (string | number)[],
  xGroupBy: StudioWidget['config']['xGroupBy'],
  formatLabel: (label: string | number) => string,
  axisId?: string,
) {
  const temporalData = getTemporalAxisData(labels);
  if (temporalData) {
    return [{
      ...(axisId ? { id: axisId } : {}),
      data: temporalData,
      scaleType: 'utc' as const,
      height: 'auto' as const,
      valueFormatter: (value: Date) => formatTemporalAxisLabel(value, xGroupBy),
    }];
  }

  return [{
    ...(axisId ? { id: axisId } : {}),
    data: labels.map(formatLabel),
    scaleType: 'point' as const,
    height: 'auto' as const,
  }];
}

function makeValueFormatter(format?: StudioNumberFormat, currencyCode?: string) {
  return (value: number | null) => {
    if (value === null) {
      return '';
    }
    if (!format) {
      return String(value);
    }
    return formatNumber(value, format, currencyCode);
  };
}

function normalizeCrossFilterValue(value: string | number | Date | undefined) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value == null) {
    return null;
  }

  return String(value);
}

export const StudioChartWidget = React.memo(function StudioChartWidget(props: StudioChartWidgetProps) {
  const { dataSource, widget, height: heightProp } = props;
  const chartHeight = heightProp ?? CHART_MIN_HEIGHT;
  const { config } = widget;
  const xGroupBy = config.xGroupBy;
  const controller = useStudioController();
  const filters = useStudioSelector((state) => state.filters);
  const activePageId = useStudioSelector((state) => state.dashboard.activePageId);
  const [hoveredItem, setHoveredItem] = React.useState<HighlightItemIdentifier<
    'bar' | 'line' | 'pie'
  > | null>(null);
  const [hoveredAxis, setHoveredAxis] = React.useState<AxisItemIdentifier[] | null>(null);

  const { chartColors, resolvedChartColors, allSeriesNames, chartSupport, activeYFields, isMultiSeries, seriesFieldData, chartData, multiYData, scatterData } =
    useChartWidgetData(widget, dataSource);

  const chartHighlightStateKey = React.useMemo(
    () =>
      JSON.stringify({
        chartType: config.chartType,
        barLayout: config.barLayout,
        xField: config.xField,
        yField: config.yField,
        ySeries: (config.ySeries ?? []).map((series) => series.fieldId ?? ''),
        seriesField: config.seriesField,
      }),
    [
      config.barLayout,
      config.chartType,
      config.seriesField,
      config.xField,
      config.yField,
      config.ySeries,
    ],
  );

  // Clear stale hover state when the chart's field/layout signature changes to avoid
  // keeping series identifiers or axis highlights from a previous chart shape.
  React.useEffect(() => {
    setHoveredItem(null);
    setHoveredAxis(null);
  }, [chartHighlightStateKey]);

  /** Format x-axis label: apply human-readable period labels when xGroupBy is set. */
  const formatLabel = React.useCallback(
    (label: string | number): string => {
      if (xGroupBy) {
        return formatPeriodLabel(String(label));
      }
      return String(label);
    },
    [xGroupBy],
  );

  const createLineXAxis = React.useCallback(
    (labels: (string | number)[], axisId?: string) => createLineXAxisConfig(labels, xGroupBy, formatLabel, axisId),
    [formatLabel, xGroupBy],
  );

  // Check if this widget has an active cross-filter on the current page
  const activeCrossFilter = filters.find(
    (f) => f.scope === 'cross-filter' && f.sourceWidgetId === widget.id && f.pageId === activePageId,
  );

  /**
   * Returns the stable color for a series name, based on its position in the full
   * (unfiltered) set of series names. This prevents colors shifting when cross-filters
   * hide some series.
   */
  const getSeriesColor = React.useCallback(
    (name: string | number): string | undefined => {
      const idx = allSeriesNames.indexOf(name);
      if (idx < 0) {
        return undefined;
      }
      return resolvedChartColors[idx % resolvedChartColors.length];
    },
    [allSeriesNames, resolvedChartColors],
  );

  const handleItemClick = React.useCallback(
    (label: string | number | Date) => {
      if (!config.xField) {
        return;
      }

      // Convert Date to string for filtering
      const filterValue = label instanceof Date ? label.toISOString() : label;

      // Toggle cross-filter: if same value is already active, clear it
      if (activeCrossFilter && activeCrossFilter.value === filterValue) {
        controller.clearCrossFilter(widget.id);
      } else {
        controller.applyCrossFilter(widget.id, config.xField, filterValue, widget.sourceId);
      }
    },
    [controller, widget.id, config.xField, activeCrossFilter],
  );

  const chartType = config.chartType ?? 'bar';
  // Normalise legacy type alias
  const normalizedChartType = chartType === 'bar-grouped' ? 'bar' : chartType;
  const barLayout = config.barLayout ?? 'grouped';
  const isHorizontalBarLayout = barLayout === 'horizontal';
  const selectedFilterValue =
    activeCrossFilter && activeCrossFilter.field === config.xField
      ? normalizeCrossFilterValue(activeCrossFilter.value as string | number | Date)
      : null;

  const getSelectedDataIndex = React.useCallback(
    (labels: Array<string | number | Date>) => {
      if (selectedFilterValue == null) {
        return -1;
      }

      return labels.findIndex((label) => normalizeCrossFilterValue(label) === selectedFilterValue);
    },
    [selectedFilterValue],
  );

  const currentHighlightableSeriesIds = React.useMemo(() => {
    if (normalizedChartType === 'pie' || normalizedChartType === 'donut') {
      return new Set([CROSS_FILTER_SERIES_ID]);
    }

    if (normalizedChartType === 'line' || normalizedChartType === 'area' || normalizedChartType === 'area-stacked' || normalizedChartType === 'area-100') {
      if (seriesFieldData && seriesFieldData.seriesNames.length > 0) {
        return new Set(seriesFieldData.seriesNames.map((name) => String(name)));
      }

      if (multiYData && multiYData.labels.length > 0) {
        return new Set(multiYData.series.map((series, index) => `${series.fieldId}-${index}`));
      }

      return new Set([CROSS_FILTER_SERIES_ID]);
    }

    if (normalizedChartType === 'bar' || normalizedChartType === 'bar-stacked' || normalizedChartType === 'bar-100') {
      if (seriesFieldData && seriesFieldData.seriesNames.length > 0) {
        return new Set(seriesFieldData.seriesNames.map((name) => String(name)));
      }

      if (multiYData && multiYData.labels.length > 0) {
        return new Set<string>();
      }

      return new Set([CROSS_FILTER_SERIES_ID]);
    }

    return new Set<string>();
  }, [multiYData, normalizedChartType, seriesFieldData]);

  const controlledHighlightedItem =
    selectedFilterValue == null &&
    hoveredItem &&
    currentHighlightableSeriesIds.has(hoveredItem.seriesId)
      ? hoveredItem
      : null;
  const controlledHighlightedAxis =
    selectedFilterValue == null ? (hoveredAxis ?? undefined) : undefined;

  // Guard: return placeholder if chart isn't configured yet (must be after all hooks)
  if (!dataSource || !config.xField) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: chartHeight,
          color: 'text.disabled',
        }}
      >
        <Typography variant="body2">
          Use the Setup tab to configure this chart.
        </Typography>
      </Box>
    );
  }

  if (!chartSupport.supported && chartSupport.reason) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: chartHeight,
          color: 'text.disabled',
          px: 2,
          textAlign: 'center',
        }}
      >
        <Typography variant="body2">
          {getChartSupportMessage(chartSupport.reason)}
        </Typography>
      </Box>
    );
  }

  // Scatter chart
  if (normalizedChartType === 'scatter') {
    if (!scatterData || scatterData.length === 0) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: chartHeight,
          }}
        ></Box>
      );
    }

    return (
      <div style={{ height: chartHeight }}>
        <ScatterChart
          series={[
            {
              data: scatterData,
              // label removed per requirements
            },
          ]}
          colors={chartColors}
          hideLegend
          margin={{ top: 16, right: 16, bottom: 8, left: 40 }}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
          sx={{ cursor: 'pointer' }}
        />
      </div>
    );
  }

  // Grouped or stacked bar charts (by category field OR multiple y-fields)
  const isBar =
    normalizedChartType === 'bar' ||
    normalizedChartType === 'bar-stacked' ||
    normalizedChartType === 'bar-100';

  const barChartData = React.useMemo(() => {
    if (!isBar || !chartData) {
      return chartData;
    }
    const labels = densifyBarLabels(chartData.labels);
    if (labels === chartData.labels) {
      return chartData;
    }
    const valueByLabel = new Map(chartData.labels.map((label, index) => [label, chartData.values[index]]));
    return {
      labels,
      values: labels.map((label) => valueByLabel.get(label) ?? null),
    };
  }, [isBar, chartData]);

  const barSeriesFieldData = React.useMemo(() => {
    if (!isBar || !seriesFieldData) {
      return seriesFieldData;
    }
    const labels = densifyBarLabels(seriesFieldData.labels);
    if (labels === seriesFieldData.labels) {
      return seriesFieldData;
    }
    return {
      labels,
      seriesNames: seriesFieldData.seriesNames,
      seriesData: Object.fromEntries(
        seriesFieldData.seriesNames.map((seriesName) => {
          const valueByLabel = new Map(
            seriesFieldData.labels.map((label, index) => [label, seriesFieldData.seriesData[seriesName][index]]),
          );
          return [seriesName, labels.map((label) => valueByLabel.get(label) ?? null)];
        }),
      ),
    };
  }, [isBar, seriesFieldData]);

  const barMultiYData = React.useMemo(() => {
    if (!isBar || !multiYData) {
      return multiYData;
    }
    const labels = densifyBarLabels(multiYData.labels);
    if (labels === multiYData.labels) {
      return multiYData;
    }
    return {
      labels,
      series: multiYData.series.map((series) => {
        const valueByLabel = new Map(multiYData.labels.map((label, index) => [label, series.values[index]]));
        return {
          fieldId: series.fieldId,
          values: labels.map((label) => valueByLabel.get(label) ?? null),
        };
      }),
    };
  }, [isBar, multiYData]);

  if (isBar) {
    // Multi-Y-field path: each y-field is its own series
    if (barMultiYData && barMultiYData.labels.length > 0) {
      const xAxisData = barMultiYData.labels.map(formatLabel);
      const selectedDataIndex = getSelectedDataIndex(barMultiYData.labels);
      const isStacked =
        normalizedChartType === 'bar-stacked' ||
        normalizedChartType === 'bar-100' ||
        (normalizedChartType === 'bar' && barLayout === 'stacked');
      const is100 = normalizedChartType === 'bar-100';
      // For grouped multi-Y, give each series its own independent Y axis so
      // fields with very different magnitudes are all visible. Stacked charts share one axis.
      const useIndependentAxes = !isHorizontalBarLayout && !isStacked && barMultiYData.series.length > 1;
      // Pre-compute per-label totals for 100% normalization.
      const totals100 = is100
        ? barMultiYData.labels.map((_, li) =>
            barMultiYData.series.reduce<number>((sum, ms) => sum + ((ms.values[li] ?? 0) as number), 0),
          )
        : null;
      const yAxes = useIndependentAxes
        ? barMultiYData.series.map((s, i) => ({
            id: `y-${i}`,
            position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
            width: 'auto' as const,
          }))
        : [
            {
              width: 'auto' as const,
              ...(is100 && {
                min: 0,
                max: 100,
                valueFormatter: (v: number) => `${Math.round(v)}%`,
              }),
            },
          ];
      const series = barMultiYData.series.map((s, i) => {
        const fieldDef = dataSource?.fields.find((f) => f.id === s.fieldId);
        const data = totals100
          ? s.values.map((v, li) => {
              const total = totals100[li];
              return total ? ((v ?? 0) / total) * 100 : 0;
            })
          : s.values;
        const valueFormatter = is100
          ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
          : makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode);
        return {
          id: `${s.fieldId}-${i}`,
          data,
          label: fieldDef?.label ?? s.fieldId,
          stack: isStacked ? 'total' : undefined,
          yAxisKey: useIndependentAxes ? `y-${i}` : undefined,
          highlightScope: { highlight: 'item' as const, fade: 'global' as const },
          valueFormatter,
        };
      });
      return (
        <div style={{ height: chartHeight }}>
          <BarChart
            layout={isHorizontalBarLayout ? 'horizontal' : undefined}
            xAxis={
              isHorizontalBarLayout
                ? [
                    {
                      width: 'auto',
                      ...(is100 && {
                        min: 0,
                        max: 100,
                        valueFormatter: (v: number) => `${Math.round(v)}%`,
                      }),
                    },
                  ]
                : [{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', height: 'auto' }]
            }
            yAxis={
              isHorizontalBarLayout
                ? [{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', width: 'auto' }]
                : yAxes
            }
            series={series}
            colors={chartColors}
            margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
            highlightedItem={null}
            highlightedAxis={
              selectedDataIndex >= 0
                ? [{ axisId: CROSS_FILTER_AXIS_ID, dataIndex: selectedDataIndex }]
                : controlledHighlightedAxis
            }
            onHighlightedAxisChange={setHoveredAxis}
            onAxisClick={(_event, params) => {
              if (params?.axisValue !== undefined) {
                handleItemClick(params.axisValue);
              }
            }}
            sx={{ cursor: 'pointer' }}
            slotProps={{
              legend: {
                sx: {
                  overflowY: 'auto',
                  flexWrap: 'nowrap',
                  maxHeight: '100%',
                },
              },
            }}
          />
        </div>
      );
    }
  }

  if (!chartData || chartData.labels.length === 0) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: chartHeight,
        }}
      />
    );
  }

  if (normalizedChartType === 'pie' || normalizedChartType === 'donut') {
    const innerRadius = normalizedChartType === 'donut' ? 50 : 0;
    const selectedDataIndex = getSelectedDataIndex(chartData.labels);

    return (
      <div style={{ height: chartHeight }}>
        <PieChart
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              innerRadius,
              data: chartData.labels.map((label, i) => ({
                id: i,
                label: formatLabel(label),
                value: chartData.values[i],
              })),
              highlightScope: { highlight: 'item', fade: 'global' },
            },
          ]}
          colors={chartColors}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }} 
          margin={{ top: 16, right: 16, bottom: 16, left: 16 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onItemClick={(_event, params) => {
            const label = chartData.labels[params.dataIndex];
            if (label !== undefined) {
              handleItemClick(label);
            }
          }}
          sx={{ cursor: 'pointer' }}
        />
      </div>
    );
  }

  // For multi-Y line/area charts
  const isLineOrArea =
    normalizedChartType === 'line' ||
    normalizedChartType === 'area' ||
    normalizedChartType === 'area-stacked' ||
    normalizedChartType === 'area-100';

  // seriesField stacked/grouped bar chart: one series per unique category value
  if (
    barSeriesFieldData &&
    barSeriesFieldData.seriesNames.length > 0 &&
    (normalizedChartType === 'bar' ||
      normalizedChartType === 'bar-stacked' ||
      normalizedChartType === 'bar-100')
  ) {
    const xAxisData = barSeriesFieldData.labels.map(formatLabel);
    const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
    const isStacked =
      normalizedChartType === 'bar-stacked' ||
      normalizedChartType === 'bar-100' ||
      (normalizedChartType === 'bar' && barLayout === 'stacked');
    const stackId = isStacked ? 'stack' : undefined;
    const is100 = normalizedChartType === 'bar-100';
    const totals100 = is100
      ? barSeriesFieldData.labels.map((_, i) =>
          barSeriesFieldData.seriesNames.reduce<number>(
            (sum, name) => sum + ((barSeriesFieldData.seriesData[name][i] ?? 0) as number),
            0,
          ),
        )
      : null;
    const series = barSeriesFieldData.seriesNames.map((name) => {
      const rawData = barSeriesFieldData.seriesData[name];
      const data: (number | null)[] = totals100
        ? rawData.map((v, i) => {
            const total = totals100[i];
            return total ? ((v ?? 0) / total) * 100 : 0;
          })
        : isStacked
          ? rawData.map((v) => v ?? 0)
          : rawData;
      return {
        id: String(name),
        data,
        label: String(name),
        stack: stackId,
        color: getSeriesColor(name),
        valueFormatter: is100
          ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
          : makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode),
      };
    });
    return (
      <div style={{ height: chartHeight }}>
        <BarChart
          layout={isHorizontalBarLayout ? 'horizontal' : undefined}
          xAxis={
            isHorizontalBarLayout
              ? [
                  {
                    width: 'auto',
                    ...(is100 && {
                      min: 0,
                      max: 100,
                      valueFormatter: (v: number) => `${Math.round(v)}%`,
                    }),
                  },
                ]
              : [{ data: xAxisData, scaleType: 'band', height: 'auto' }]
          }
          yAxis={
            isHorizontalBarLayout
              ? [{ data: xAxisData, scaleType: 'band', width: 'auto' }]
              : [
                  {
                    width: 'auto',
                    ...(is100 && {
                      min: 0,
                      max: 100,
                      valueFormatter: (v: number) => `${Math.round(v)}%`,
                    }),
                  },
                ]
          }
          series={series}
          colors={chartColors}
          margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
          highlightedItem={controlledHighlightedItem}
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    );
  }

  // seriesField line/area chart: one line (or area) per unique series-field value
  if (
    seriesFieldData &&
    seriesFieldData.seriesNames.length > 0 &&
    (normalizedChartType === 'line' ||
      normalizedChartType === 'area' ||
      normalizedChartType === 'area-stacked' ||
      normalizedChartType === 'area-100')
  ) {
    const xAxis = createLineXAxis(seriesFieldData.labels);
    const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
    const isArea = normalizedChartType !== 'line';
    const isStacked = normalizedChartType === 'area-stacked' || normalizedChartType === 'area-100';
    const is100 = normalizedChartType === 'area-100';

    // Pre-normalize to 0-100% per x-position (avoids floating-point issues with stackOffset:'expand')
    const totals100 = is100
      ? seriesFieldData.labels.map((_, i) =>
          seriesFieldData.seriesNames.reduce<number>(
            (sum, name) => sum + ((seriesFieldData.seriesData[name][i] ?? 0) as number),
            0,
          ),
        )
      : null;

    const series = seriesFieldData.seriesNames.map((name) => {
      const rawData = seriesFieldData.seriesData[name];
      const data: (number | null)[] = totals100
        ? rawData.map((v, i) => {
            const total = totals100[i];
            return total ? ((v ?? 0) / total) * 100 : 0;
          })
        : isStacked
          // Stacked area: null breaks the stacking algorithm → use 0
          ? rawData.map((v) => v ?? 0)
          : rawData;
      return {
        id: String(name),
        data,
        label: String(name),
        area: isArea,
        connectNulls: true,
        stack: isStacked ? 'total' : undefined,
        color: getSeriesColor(name),
        highlightScope: { highlight: 'item' as const, fade: 'global' as const },
        valueFormatter: is100
          ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
          : makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode),
      };
    });
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          xAxis={xAxis}
          yAxis={[
            {
              width: 'auto',
              ...(is100 && { min: 0, max: 100, valueFormatter: (v: number) => `${Math.round(v)}%` }),
            },
          ]}
          series={series}
          colors={chartColors}
          margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
          highlightedItem={controlledHighlightedItem}
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    );
  }

  if (multiYData && multiYData.labels.length > 0 && isLineOrArea) {
    const xAxis = createLineXAxis(multiYData.labels, CROSS_FILTER_AXIS_ID);
    const selectedDataIndex = getSelectedDataIndex(multiYData.labels);
    const isArea = normalizedChartType !== 'line';
    const isStacked = normalizedChartType === 'area-stacked' || normalizedChartType === 'area-100';
    const is100 = normalizedChartType === 'area-100';

    const useIndependentAxes = !isStacked && multiYData.series.length > 1;
    const yAxes = useIndependentAxes
      ? multiYData.series.map((s, i) => ({
          id: `y-${i}`,
          position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
          width: 'auto' as const,
        }))
      : [
          {
            width: 'auto' as const,
            ...(is100 && { min: 0, max: 100, valueFormatter: (v: number) => `${Math.round(v)}%` }),
          },
        ];
    const series = buildMultiYLineSeries(multiYData, normalizedChartType, dataSource?.fields);
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          xAxis={xAxis}
          yAxis={yAxes}
          series={series}
          colors={chartColors}
          margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? {
                  seriesId: multiYData.series[0]?.fieldId ?? CROSS_FILTER_SERIES_ID,
                  dataIndex: selectedDataIndex,
                }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    );
  }

  const singleSeriesChartData = isBar ? barChartData : chartData;
  const xAxisData = singleSeriesChartData!.labels.map(formatLabel);
  const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
  const seriesLabel = yFieldDef?.label ?? activeYFields[0] ?? 'Value';
  const seriesValueFormatter = makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode);
  const selectedDataIndex = getSelectedDataIndex(singleSeriesChartData!.labels);

  if (normalizedChartType === 'line') {
    const xAxis = createLineXAxis(singleSeriesChartData!.labels, CROSS_FILTER_AXIS_ID);
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          xAxis={xAxis}
          yAxis={[{ width: 'auto' }]}
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              data: singleSeriesChartData!.values,
              label: seriesLabel,
              area: false,
              connectNulls: true,
              highlightScope: { highlight: 'item', fade: 'global' },
              valueFormatter: seriesValueFormatter,
            },
          ]}
          colors={chartColors}
          hideLegend
          margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    );
  }

  if (
    normalizedChartType === 'area' ||
    normalizedChartType === 'area-stacked' ||
    normalizedChartType === 'area-100'
  ) {
    // Single-series: stacking has no visual effect; area-100 shows a flat 100% fill
    const xAxis = createLineXAxis(singleSeriesChartData!.labels, CROSS_FILTER_AXIS_ID);
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          xAxis={xAxis}
          yAxis={[{ width: 'auto' }]}
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              data: singleSeriesChartData!.values,
              label: seriesLabel,
              area: true,
              connectNulls: true,
              highlightScope: { highlight: 'item', fade: 'global' },
              valueFormatter: seriesValueFormatter,
            },
          ]}
          colors={chartColors}
          hideLegend
          margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    );
  }

  // Default: bar chart (vertical or horizontal)
  const isHorizontal = isHorizontalBarLayout;

  if (isHorizontal) {
    return (
      <div style={{ height: chartHeight }}>
        <BarChart
          layout="horizontal"
          xAxis={[{ height: 'auto' }]}
          yAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', width: 'auto' }]}
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              data: singleSeriesChartData!.values,
              label: seriesLabel,
              highlightScope: { highlight: 'item', fade: 'global' },
              valueFormatter: seriesValueFormatter,
            },
          ]}
          colors={chartColors}
          hideLegend
          margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ height: chartHeight }}>
      <BarChart
        xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', height: 'auto' }]}
        yAxis={[{ width: 'auto' }]}
        series={[
          {
            id: CROSS_FILTER_SERIES_ID,
            data: singleSeriesChartData!.values,
            label: seriesLabel,
            highlightScope: { highlight: 'item', fade: 'global' },
            valueFormatter: seriesValueFormatter,
          },
        ]}
        colors={chartColors}
        hideLegend
        margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
        highlightedItem={
          selectedDataIndex >= 0
            ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
            : controlledHighlightedItem
        }
        onHighlightChange={(item) =>
          setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
        }
        onAxisClick={(_event, params) => {
          if (params?.axisValue !== undefined) {
            handleItemClick(params.axisValue);
          }
        }}
        sx={{ cursor: 'pointer' }}
        slotProps={{
          legend: {
            sx: {
              overflowY: 'auto',
              flexWrap: 'nowrap',
              maxHeight: '100%',
            },
          },
        }}
      />
    </div>
  );
});
