'use client';

import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';
import { ScatterChart } from '@mui/x-charts/ScatterChart';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box } from '@mui/material';

import type { StudioDataSource, StudioWidget } from '../models';
import {
  resolveRows,
  resolveMetricRefs,
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
  enrichRowsWithRelatedFields,
  prepareScatterData,
  applyRankToAggregated,
  applyRankToMultiSeries,
} from './chartUtils';
import { useStudioController, useStudioSelector } from '../context';
import { formatNumber } from './numberFormat';
import type { StudioNumberFormat } from '../models/studio';

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

export function StudioChartWidget(props: StudioChartWidgetProps) {
  const { dataSource, widget, height: heightProp } = props;
  const chartHeight = heightProp ?? CHART_MIN_HEIGHT;
  const { config } = widget;
  const controller = useStudioController();
  const filters = useStudioSelector((state) => state.filters);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const relationships = useStudioSelector((state) => state.relationships);
  const [hoveredItem, setHoveredItem] = React.useState<HighlightItemIdentifier<
    'bar' | 'line' | 'pie'
  > | null>(null);
  const [hoveredAxis, setHoveredAxis] = React.useState<AxisItemIdentifier[] | null>(null);

  // Check if this widget has an active cross-filter
  const activeCrossFilter = filters.find(
    (f) => f.scope === 'cross-filter' && f.sourceWidgetId === widget.id,
  );

  // Separate rank widget filters (applied post-aggregation) from row-level filters
  const widgetRankFilter = filters.find(
    (f) => f.scope === 'widget' && f.widgetId === widget.id && f.filterMode === 'rank',
  ) ?? null;

  // Get filtered rows (rank filters are excluded — applied after aggregation)
  const filteredRows = React.useMemo(() => {
    if (!dataSource?.rows) {
      return [];
    }

    const pageFilters = filters.filter((f) => f.scope === 'page');
    // Exclude rank filters from row-level filtering
    const widgetFilters = filters.filter(
      (f) => f.scope === 'widget' && f.widgetId === widget.id && f.filterMode !== 'rank',
    );
    const crossFilters = filters.filter(
      (f) => f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id,
    );
    const allFilters = resolveMetricRefs(
      [...pageFilters, ...widgetFilters, ...crossFilters],
      dataSources,
    );

    return resolveRows(dataSource.rows, widget.sourceId, allFilters, dataSources, relationships);
  }, [dataSource, filters, dataSources, relationships, widget.id, widget.sourceId]);

  // Resolve active y-fields: prefer ySeries, fall back to yField
  const activeYFields = React.useMemo(() => {
    if (config.ySeries && config.ySeries.length > 0) {
      const ids = config.ySeries.map((s) => s.fieldId).filter(Boolean);
      return [...new Set(ids)]; // deduplicate, preserving order
    }
    return config.yField ? [config.yField] : [];
  }, [config.ySeries, config.yField]);

  // Enrich rows with fields from directly related sources when those fields
  // are not present on the widget's own source (e.g. 'date' from orders on orderItems rows).
  const enrichedRows = React.useMemo(() => {
    const candidateFields = [
      config.xField,
      ...activeYFields,
      config.seriesField,
    ].filter((f): f is string => Boolean(f));
    return enrichRowsWithRelatedFields(
      filteredRows,
      widget.sourceId,
      candidateFields,
      dataSources,
      relationships,
    );
  }, [filteredRows, widget.sourceId, config.xField, activeYFields, config.seriesField, dataSources, relationships]);

  const isMultiSeries = activeYFields.length > 1;

  // seriesField data: one line per unique value of the series field
  const seriesFieldData = React.useMemo(() => {
    const xField = config.xField;
    const seriesField = config.seriesField;
    const yField = activeYFields[0];
    if (!xField || !seriesField || !yField || enrichedRows.length === 0) {
      return null;
    }
    return aggregateByTwoFields(enrichedRows, xField, seriesField, yField);
  }, [enrichedRows, config.xField, config.seriesField, activeYFields]);

  const chartData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || activeYFields.length === 0 || enrichedRows.length === 0) {
      return null;
    }
    if (isMultiSeries) {
      return null; // handled by multiYData
    }
    const raw = aggregateByField(enrichedRows, xField, activeYFields[0]);
    return applyRankToAggregated(raw, widgetRankFilter);
  }, [enrichedRows, config.xField, activeYFields, isMultiSeries, widgetRankFilter]);

  // Multi-Y-field data (multiple explicit series)
  const multiYData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || activeYFields.length < 2 || enrichedRows.length === 0) {
      return null;
    }
    const raw = aggregateMultipleSeries(enrichedRows, xField, activeYFields);
    return applyRankToMultiSeries(raw, widgetRankFilter);
  }, [enrichedRows, config.xField, activeYFields, widgetRankFilter]);

  // Data for scatter charts
  const scatterData = React.useMemo(() => {
    const xField = config.xField;
    const yField = config.yField;

    if (!xField || !yField || enrichedRows.length === 0) {
      return null;
    }

    return prepareScatterData(enrichedRows, xField, yField);
  }, [enrichedRows, config.xField, config.yField]);

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
      <div>
        <ScatterChart
          series={[
            {
              data: scatterData,
              // label removed per requirements
            },
          ]}
          height={chartHeight}
          hideLegend
          margin={{ top: 16, right: 16, bottom: 32, left: 40 }}
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
      const xAxisData = multiYData.labels.map(String);
      const selectedDataIndex = getSelectedDataIndex(multiYData.labels);
      const isStacked =
        normalizedChartType === 'bar-stacked' ||
        normalizedChartType === 'bar-100' ||
        (normalizedChartType === 'bar' && barLayout === 'stacked');
      const stackStrategy =
        normalizedChartType === 'bar-100' ? ('allPositive' as const) : undefined;
      // For grouped multi-Y, give each series its own independent Y axis so
      // fields with very different magnitudes are all visible. Stacked charts share one axis.
      const useIndependentAxes = !isStacked && multiYData.series.length > 1;
      const yAxes = useIndependentAxes
        ? multiYData.series.map((s, i) => ({
            id: `y-${i}`,
            position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
          }))
        : undefined;
      const series = multiYData.series.map((s, i) => {
        const fieldDef = dataSource?.fields.find((f) => f.id === s.fieldId);
        return {
          id: `${s.fieldId}-${i}`,
          data: s.values,
          label: fieldDef?.label ?? s.fieldId,
          stack: isStacked ? 'total' : undefined,
          stackStrategy,
          yAxisKey: useIndependentAxes ? `y-${i}` : undefined,
          highlightScope: { highlight: 'item' as const, fade: 'global' as const },
          valueFormatter: makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode),
        };
      });
      return (
        <div>
          <BarChart
            xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band' }]}
            yAxis={yAxes}
            series={series}
            height={chartHeight}
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
          height: chartHeight,
        }}
      />
    );
  }

  if (normalizedChartType === 'pie' || normalizedChartType === 'donut') {
    const innerRadius = normalizedChartType === 'donut' ? 50 : 0;
    const selectedDataIndex = getSelectedDataIndex(chartData.labels);

    return (
      <div>
        <PieChart
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              innerRadius,
              data: chartData.labels.map((label, i) => ({
                id: i,
                label: String(label),
                value: chartData.values[i],
              })),
              highlightScope: { highlight: 'item', fade: 'global' },
            },
          ]}
          height={chartHeight}
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
  const isLineOrArea =
    normalizedChartType === 'line' ||
    normalizedChartType === 'area' ||
    normalizedChartType === 'area-stacked' ||
    normalizedChartType === 'area-100';

  // seriesField line chart: one line per unique category value
  if (seriesFieldData && seriesFieldData.seriesNames.length > 0 && normalizedChartType === 'line') {
    const xAxisData = seriesFieldData.labels.map(String);
    const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
    const series = seriesFieldData.seriesNames.map((name) => ({
      id: String(name),
      data: seriesFieldData.seriesData[name],
      label: String(name),
      area: false,
      highlightScope: { highlight: 'item' as const, fade: 'global' as const },
      valueFormatter: makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode),
    }));
    return (
      <div>
        <LineChart
          xAxis={[{ data: xAxisData, scaleType: 'point' }]}
          series={series}
          height={chartHeight}
          margin={{ top: 16, right: 16, bottom: 32, left: 60 }}
        />
      </div>
    );
  }

  if (multiYData && multiYData.labels.length > 0 && isLineOrArea) {
    const xAxisData = multiYData.labels.map(String);
    const selectedDataIndex = getSelectedDataIndex(multiYData.labels);
    const isArea = normalizedChartType !== 'line';
    const isStacked = normalizedChartType === 'area-stacked' || normalizedChartType === 'area-100';

    const useIndependentAxes = !isStacked && multiYData.series.length > 1;
    const yAxes = useIndependentAxes
      ? multiYData.series.map((s, i) => ({
          id: `y-${i}`,
          position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
        }))
      : undefined;
    const series = multiYData.series.map((s, i) => {
      const fieldDef = dataSource?.fields.find((f) => f.id === s.fieldId);
      return {
        id: `${s.fieldId}-${i}`,
        data: s.values,
        label: fieldDef?.label ?? s.fieldId,
        area: isArea,
        stack: isStacked ? 'total' : undefined,
        yAxisKey: useIndependentAxes ? `y-${i}` : undefined,
        highlightScope: { highlight: 'item' as const, fade: 'global' as const },
        valueFormatter: makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode),
      };
    });
    return (
      <div>
        <LineChart
          xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'point' }]}
          yAxis={yAxes}
          series={series}
          height={chartHeight}
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
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
        />
      </div>
    );
  }

  const xAxisData = chartData!.labels.map(String);
  const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
  const seriesLabel = yFieldDef?.label ?? activeYFields[0] ?? 'Value';
  const seriesValueFormatter = makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode);
  const selectedDataIndex = getSelectedDataIndex(chartData!.labels);

  if (normalizedChartType === 'line') {
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
              valueFormatter: seriesValueFormatter,
            },
          ]}
          height={chartHeight}
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
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
        />
      </div>
    );
  }

  if (
    normalizedChartType === 'area' ||
    normalizedChartType === 'area-stacked' ||
    normalizedChartType === 'area-100'
  ) {
    const isStacked100 = normalizedChartType === 'area-100';
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
              stack: isStacked100 ? 'total' : undefined,
              highlightScope: { highlight: 'item', fade: 'global' },
              valueFormatter: seriesValueFormatter,
            },
          ]}
          height={chartHeight}
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
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
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
            valueFormatter: seriesValueFormatter,
          },
        ]}
        height={chartHeight}
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
          if (params?.axisValue !== undefined) {
            handleItemClick(params.axisValue);
          }
        }}
        sx={{ cursor: 'pointer' }}
      />
    </div>
  );
}
