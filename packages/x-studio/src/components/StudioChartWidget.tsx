'use client';

import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';
import { ScatterChart } from '@mui/x-charts/ScatterChart';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box, Typography } from '@mui/material';

import type { StudioDataSource, StudioWidget } from '../models';
import {
  resolveRows,
  aggregateByField,
  aggregateMultipleSeries,
  prepareScatterData,
} from './chartUtils';
import { useStudioController, useStudioSelector } from '../context';

export interface StudioChartWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

const CHART_HEIGHT = 260;
const CROSS_FILTER_AXIS_ID = 'cross-filter-axis';
const CROSS_FILTER_SERIES_ID = 'cross-filter-series';

function normalizeCrossFilterValue(value: string | number | Date | undefined) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value == null) {
    return null;
  }

  return String(value);
}

export function StudioChartWidget(props: StudioChartWidgetProps) {
  const { dataSource, widget } = props;
  const { config } = widget;
  const controller = useStudioController();
  const filters = useStudioSelector((state) => state.filters);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const [hoveredItem, setHoveredItem] = React.useState<HighlightItemIdentifier<
    'bar' | 'line' | 'pie'
  > | null>(null);
  const [hoveredAxis, setHoveredAxis] = React.useState<AxisItemIdentifier[] | null>(null);

  // Check if this widget has an active cross-filter
  const activeCrossFilter = filters.find(
    (f) => f.scope === 'cross-filter' && f.sourceWidgetId === widget.id,
  );

  // Get filtered rows
  const filteredRows = React.useMemo(() => {
    if (!dataSource?.rows) {
      return [];
    }

    const pageFilters = filters.filter((f) => f.scope === 'page');
    const widgetFilters = filters.filter((f) => f.scope === 'widget' && f.widgetId === widget.id);
    const crossFilters = filters.filter(
      (f) => f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id,
    );
    const allFilters = [...pageFilters, ...widgetFilters, ...crossFilters];

    return resolveRows(dataSource.rows, widget.sourceId, allFilters, dataSources);
  }, [dataSource, filters, dataSources, widget.id, widget.sourceId]);

  // Resolve active y-fields: prefer ySeries, fall back to yField
  const activeYFields = React.useMemo(() => {
    if (config.ySeries && config.ySeries.length > 0) {
      const ids = config.ySeries.map((s) => s.fieldId).filter(Boolean);
      return [...new Set(ids)]; // deduplicate, preserving order
    }
    return config.yField ? [config.yField] : [];
  }, [config.ySeries, config.yField]);

  const isMultiSeries = activeYFields.length > 1;

  const chartData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || activeYFields.length === 0 || filteredRows.length === 0) {
      return null;
    }
    if (isMultiSeries) {
      return null; // handled by multiYData
    }
    return aggregateByField(filteredRows, xField, activeYFields[0]);
  }, [filteredRows, config.xField, activeYFields, isMultiSeries]);

  // Multi-Y-field data (multiple explicit series)
  const multiYData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || activeYFields.length < 2 || filteredRows.length === 0) {
      return null;
    }
    return aggregateMultipleSeries(filteredRows, xField, activeYFields);
  }, [filteredRows, config.xField, activeYFields]);

  // Data for scatter charts
  const scatterData = React.useMemo(() => {
    const xField = config.xField;
    const yField = config.yField;

    if (!xField || !yField || filteredRows.length === 0) {
      return null;
    }

    return prepareScatterData(filteredRows, xField, yField);
  }, [filteredRows, config.xField, config.yField]);

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

  // Scatter chart
  if (chartType === 'scatter') {
    if (!scatterData || scatterData.length === 0) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: CHART_HEIGHT,
          }}
        ></Box>
      );
    }

    const xLabel =
      dataSource?.fields.find((f) => f.id === config.xField)?.label ?? config.xField ?? 'X';
    const yLabel =
      dataSource?.fields.find((f) => f.id === activeYFields[0])?.label ?? activeYFields[0] ?? 'Y';

    return (
      <div>
        <ScatterChart
          series={[
            {
              data: scatterData,
              // label removed per requirements
            },
          ]}
          height={CHART_HEIGHT}
          hideLegend
          margin={{ top: 16, right: 16, bottom: 32, left: 40 }}
          sx={{ cursor: 'pointer' }}
        />
      </div>
    );
  }

  // Grouped or stacked bar charts (by category field OR multiple y-fields)
  const isGroupedOrStacked =
    chartType === 'bar-grouped' ||
    chartType === 'bar-stacked' ||
    chartType === 'bar';

  if (isGroupedOrStacked) {
    // Multi-Y-field path: each y-field is its own series
    if (multiYData && multiYData.labels.length > 0) {
      const xAxisData = multiYData.labels.map(String);
      const selectedDataIndex = getSelectedDataIndex(multiYData.labels);
      const isStacked =
        chartType === 'bar-stacked' || (chartType === 'bar' && barLayout === 'stacked');
      // For grouped multi-Y, give each series its own independent Y axis so
      // fields with very different magnitudes (e.g. revenue vs quantity) are
      // all visible. Stacked charts share a single axis since values are additive.
      const useIndependentAxes = !isStacked && multiYData.series.length > 1;
      const yAxes = useIndependentAxes
        ? multiYData.series.map((s, i) => ({
            id: `y-${i}`,
            position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
          }))
        : undefined;
      const series = multiYData.series.map((s, i) => ({
        id: `${s.fieldId}-${i}`,
        data: s.values,
        label: dataSource?.fields.find((f) => f.id === s.fieldId)?.label ?? s.fieldId,
        stack: isStacked ? 'total' : undefined,
        yAxisKey: useIndependentAxes ? `y-${i}` : undefined,
        highlightScope: { highlight: 'item' as const, fade: 'global' as const },
      }));
      return (
        <div>
          <BarChart
            xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band' }]}
            yAxis={yAxes}
            series={series}
            height={CHART_HEIGHT}
            margin={{ top: 16, right: 40, bottom: 32, left: 40 }}
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
          height: CHART_HEIGHT,
        }}
      />
    );
  }

  if (chartType === 'pie') {
    const selectedDataIndex = getSelectedDataIndex(chartData.labels);

    return (
      <div>
        <PieChart
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              data: chartData.labels.map((label, i) => ({
                id: i,
                label: String(label),
                value: chartData.values[i],
              })),
              // arcLabel: 'label', // Removed arc labels for legend-only
              // Pie chart now uses legend instead of arc labels
              highlightScope: { highlight: 'item', fade: 'global' },
            },
          ]}
          height={CHART_HEIGHT}
          slotProps={{}} // legend positioning uses default
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
  if (multiYData && multiYData.labels.length > 0 && (chartType === 'line' || chartType === 'area')) {
    const xAxisData = multiYData.labels.map(String);
    const selectedDataIndex = getSelectedDataIndex(multiYData.labels);
    const isArea = chartType === 'area';

    const useIndependentAxes = multiYData.series.length > 1;
    const yAxes = useIndependentAxes
      ? multiYData.series.map((s, i) => ({
          id: `y-${i}`,
          position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
        }))
      : undefined;
    const series = multiYData.series.map((s, i) => ({
      id: `${s.fieldId}-${i}`,
      data: s.values,
      label: dataSource?.fields.find((f) => f.id === s.fieldId)?.label ?? s.fieldId,
      area: isArea,
      yAxisKey: useIndependentAxes ? `y-${i}` : undefined,
      highlightScope: { highlight: 'item' as const, fade: 'global' as const },
    }));
    return (
      <div>
        <LineChart
          xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'point' }]}
          yAxis={yAxes}
          series={series}
          height={CHART_HEIGHT}
          margin={{ top: 16, right: 40, bottom: 32, left: 40 }}
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
            if (params?.axisValue !== undefined) handleItemClick(params.axisValue);
          }}
          sx={{ cursor: 'pointer' }}
        />
      </div>
    );
  }

  const xAxisData = chartData!.labels.map(String);
  const seriesLabel =
    dataSource?.fields.find((f) => f.id === activeYFields[0])?.label ?? activeYFields[0] ?? 'Value';
  const selectedDataIndex = getSelectedDataIndex(chartData!.labels);

  if (chartType === 'line') {
    return (
      <div>
        <LineChart
          xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'point' }]}
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              data: chartData!.values,
              label: seriesLabel,
              area: false,
              highlightScope: { highlight: 'item', fade: 'global' },
            },
          ]}
          height={CHART_HEIGHT}
          hideLegend
          margin={{ top: 16, right: 16, bottom: 32, left: 40 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) handleItemClick(params.axisValue);
          }}
          sx={{ cursor: 'pointer' }}
        />
      </div>
    );
  }

  if (chartType === 'area') {
    return (
      <div>
        <LineChart
          xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'point' }]}
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              data: chartData!.values,
              label: seriesLabel,
              area: true,
              highlightScope: { highlight: 'item', fade: 'global' },
            },
          ]}
          height={CHART_HEIGHT}
          hideLegend
          margin={{ top: 16, right: 16, bottom: 32, left: 40 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) handleItemClick(params.axisValue);
          }}
          sx={{ cursor: 'pointer' }}
        />
      </div>
    );
  }

  // Default: bar chart
  return (
    <div>
      <BarChart
        xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band' }]}
        series={[
          {
            id: CROSS_FILTER_SERIES_ID,
            data: chartData!.values,
            label: seriesLabel,
            highlightScope: { highlight: 'item', fade: 'global' },
          },
        ]}
        height={CHART_HEIGHT}
        hideLegend
        margin={{ top: 16, right: 16, bottom: 32, left: 40 }}
        highlightedItem={
          selectedDataIndex >= 0
            ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
            : controlledHighlightedItem
        }
        onHighlightChange={(item) =>
          setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
        }
        onAxisClick={(_event, params) => {
          if (params?.axisValue !== undefined) handleItemClick(params.axisValue);
        }}
        sx={{ cursor: 'pointer' }}
      />
    </div>
  );
}
