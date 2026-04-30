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
  formatPeriodLabel,
} from '../internals/chartUtils';
import { useStudioController, useStudioSelector } from '../context';
import { formatNumber } from '../internals/numberFormat';
import type { StudioNumberFormat } from '../models/studio';
import { useChartWidgetData } from './useChartWidgetData';

export interface StudioChartWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  height?: number;
}

export const CHART_MIN_HEIGHT = 260;
const CROSS_FILTER_AXIS_ID = 'cross-filter-axis';
const CROSS_FILTER_SERIES_ID = 'cross-filter-series';

function makeValueFormatter(format?: StudioNumberFormat, currencyCode?: string) {
  if (!format) {
    return undefined;
  }
  return (value: number | null) => {
    if (value === null) {
      return '';
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
  const [hoveredItem, setHoveredItem] = React.useState<HighlightItemIdentifier<
    'bar' | 'line' | 'pie'
  > | null>(null);
  const [hoveredAxis, setHoveredAxis] = React.useState<AxisItemIdentifier[] | null>(null);

  const { chartColors, activeYFields, isMultiSeries, seriesFieldData, chartData, multiYData, scatterData } =
    useChartWidgetData(widget, dataSource);

  // Clear stale hovered item when chart type or series field changes to avoid
  // "controlled/uncontrolled" errors from stale seriesIds referencing old series.
  React.useEffect(() => {
    setHoveredItem(null);
    setHoveredAxis(null);
  }, [config.chartType, config.seriesField]);

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

  // Check if this widget has an active cross-filter
  const activeCrossFilter = filters.find(
    (f) => f.scope === 'cross-filter' && f.sourceWidgetId === widget.id,
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
        controller.applyCrossFilter(widget.id, config.xField, filterValue);
      }
    },
    [controller, widget.id, config.xField, activeCrossFilter],
  );

  const chartType = config.chartType ?? 'bar';
  // Normalise legacy type alias
  const normalizedChartType = chartType === 'bar-grouped' ? 'bar' : chartType;
  const barLayout = config.barLayout ?? 'grouped';
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

  const controlledHighlightedItem = selectedFilterValue == null ? hoveredItem : null;
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

  if (isBar) {
    // Multi-Y-field path: each y-field is its own series
    if (multiYData && multiYData.labels.length > 0) {
      const xAxisData = multiYData.labels.map(formatLabel);
      const selectedDataIndex = getSelectedDataIndex(multiYData.labels);
      const isStacked =
        normalizedChartType === 'bar-stacked' ||
        normalizedChartType === 'bar-100' ||
        (normalizedChartType === 'bar' && barLayout === 'stacked');
      const is100 = normalizedChartType === 'bar-100';
      // For grouped multi-Y, give each series its own independent Y axis so
      // fields with very different magnitudes are all visible. Stacked charts share one axis.
      const useIndependentAxes = !isStacked && multiYData.series.length > 1;
      // Pre-compute per-label totals for 100% normalization.
      const totals100 = is100
        ? multiYData.labels.map((_, li) =>
            multiYData.series.reduce<number>((sum, ms) => sum + ((ms.values[li] ?? 0) as number), 0),
          )
        : null;
      const yAxes = useIndependentAxes
        ? multiYData.series.map((s, i) => ({
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
      const series = multiYData.series.map((s, i) => {
        const fieldDef = dataSource?.fields.find((f) => f.id === s.fieldId);
        const data = totals100
          ? s.values.map((v, li) => {
              const total = totals100[li];
              return total ? ((v ?? 0) / total) * 100 : 0;
            })
          : s.values;
        const valueFormatter = is100
          ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
          : makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode) ??
            ((v: number | null) => (v == null ? '' : String(v)));
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
            xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', height: 'auto' }]}
            yAxis={yAxes}
            series={series}
            colors={chartColors}
            margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
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
    seriesFieldData &&
    seriesFieldData.seriesNames.length > 0 &&
    (normalizedChartType === 'bar' ||
      normalizedChartType === 'bar-stacked' ||
      normalizedChartType === 'bar-100')
  ) {
    const xAxisData = seriesFieldData.labels.map(formatLabel);
    const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
    const isStacked =
      normalizedChartType === 'bar-stacked' ||
      normalizedChartType === 'bar-100' ||
      (normalizedChartType === 'bar' && barLayout === 'stacked');
    const stackId = isStacked ? 'stack' : undefined;
    const is100 = normalizedChartType === 'bar-100';
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
      const data = totals100
        ? rawData.map((v, i) => {
            const total = totals100[i];
            return total ? (v / total) * 100 : 0;
          })
        : rawData;
      return {
        id: String(name),
        data,
        label: String(name),
        stack: stackId,
        valueFormatter: is100
          ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
          : makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode),
      };
    });
    return (
      <div style={{ height: chartHeight }}>
        <BarChart
          xAxis={[{ data: xAxisData, scaleType: 'band', height: 'auto' }]}
          yAxis={[
            {
              width: 'auto',
              ...(is100 && {
                min: 0,
                max: 100,
                valueFormatter: (v: number) => `${Math.round(v)}%`,
              }),
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

  // seriesField line/area chart: one line (or area) per unique series-field value
  if (
    seriesFieldData &&
    seriesFieldData.seriesNames.length > 0 &&
    (normalizedChartType === 'line' ||
      normalizedChartType === 'area' ||
      normalizedChartType === 'area-stacked' ||
      normalizedChartType === 'area-100')
  ) {
    const xAxisData = seriesFieldData.labels.map(formatLabel);
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
      const data = totals100
        ? rawData.map((v, i) => {
            const total = totals100[i];
            return total ? ((v as number) / total) * 100 : 0;
          })
        : rawData;
      return {
        id: String(name),
        data,
        label: String(name),
        area: isArea,
        stack: isStacked ? 'total' : undefined,
        highlightScope: { highlight: 'item' as const, fade: 'global' as const },
        valueFormatter: is100
          ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
          : makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode),
      };
    });
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          xAxis={[{ data: xAxisData, scaleType: 'point', height: 'auto' }]}
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
    const xAxisData = multiYData.labels.map(formatLabel);
    const selectedDataIndex = getSelectedDataIndex(multiYData.labels);
    const isArea = normalizedChartType !== 'line';
    const isStacked = normalizedChartType === 'area-stacked' || normalizedChartType === 'area-100';
    const is100 = normalizedChartType === 'area-100';

    // Pre-normalize to 0-100% per x-position for area-100
    const totals100 = is100
      ? multiYData.labels.map((_, i) =>
          multiYData.series.reduce<number>((sum, s) => sum + ((s.values[i] ?? 0) as number), 0),
        )
      : null;

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
    const series = multiYData.series.map((s, i) => {
      const fieldDef = dataSource?.fields.find((f) => f.id === s.fieldId);
      const data = totals100
        ? s.values.map((v, idx) => {
            const total = totals100[idx];
            return total ? ((v as number) / total) * 100 : 0;
          })
        : s.values;
      return {
        id: `${s.fieldId}-${i}`,
        data,
        label: fieldDef?.label ?? s.fieldId,
        area: isArea,
        stack: isStacked ? 'total' : undefined,
        yAxisKey: useIndependentAxes ? `y-${i}` : undefined,
        highlightScope: { highlight: 'item' as const, fade: 'global' as const },
        valueFormatter: is100
          ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
          : makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode),
      };
    });
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'point', height: 'auto' }]}
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

  const xAxisData = chartData!.labels.map(formatLabel);
  const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
  const seriesLabel = yFieldDef?.label ?? activeYFields[0] ?? 'Value';
  const seriesValueFormatter = makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode);
  const selectedDataIndex = getSelectedDataIndex(chartData!.labels);

  if (normalizedChartType === 'line') {
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'point', height: 'auto' }]}
          yAxis={[{ width: 'auto' }]}
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              data: chartData!.values,
              label: seriesLabel,
              area: false,
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
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'point', height: 'auto' }]}
          yAxis={[{ width: 'auto' }]}
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              data: chartData!.values,
              label: seriesLabel,
              area: true,
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
  const isHorizontal = barLayout === 'horizontal';

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
              data: chartData!.values,
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
            data: chartData!.values,
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
