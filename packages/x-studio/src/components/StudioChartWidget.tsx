import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';
import { ScatterChart } from '@mui/x-charts/ScatterChart';
import { Box, Chip, Stack, Typography } from '@mui/material';

import type { StudioDataSource, StudioWidget } from '../models';
import { applyFilters, aggregateByField, aggregateByTwoFields, prepareScatterData } from './chartUtils';
import { useStudioController, useStudioSelector } from '../context';

export interface StudioChartWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

const CHART_HEIGHT = 260;

export function StudioChartWidget(props: StudioChartWidgetProps) {
  const { dataSource, widget } = props;
  const { config } = widget;
  const controller = useStudioController();
  const filters = useStudioSelector((state) => state.filters);
  const mode = useStudioSelector((state) => state.mode);

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

    return applyFilters(dataSource.rows, allFilters);
  }, [dataSource, filters, widget.id]);

  const chartData = React.useMemo(() => {
    const xField = config.xField;
    const yField = config.yField;

    if (!xField || !yField || filteredRows.length === 0) {
      return null;
    }

    return aggregateByField(filteredRows, xField, yField);
  }, [filteredRows, config.xField, config.yField]);

  // Data for grouped/stacked charts (multiple series)
  const multiSeriesData = React.useMemo(() => {
    const xField = config.xField;
    const yField = config.yField;
    const seriesField = config.seriesField;

    if (!xField || !yField || !seriesField || filteredRows.length === 0) {
      return null;
    }

    return aggregateByTwoFields(filteredRows, xField, seriesField, yField);
  }, [filteredRows, config.xField, config.yField, config.seriesField]);

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
      if (!config.xField) return;

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

  // Cross-filter indicator
  const crossFilterIndicator = activeCrossFilter ? (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
      <Chip
        size="small"
        label={`Filtering: ${config.xField} = ${activeCrossFilter.value}`}
        onDelete={() => controller.clearCrossFilter(widget.id)}
        color="primary"
        variant="outlined"
      />
    </Stack>
  ) : null;

  // Scatter chart
  if (chartType === 'scatter') {
    if (!scatterData || scatterData.length === 0) {
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: CHART_HEIGHT }}>
          <Typography variant="body2" color="text.secondary">
            {!config.xField || !config.yField
              ? 'Configure x and y fields in the Compose drawer.'
              : 'No data to display.'}
          </Typography>
        </Box>
      );
    }

    const xLabel = dataSource?.fields.find((f) => f.id === config.xField)?.label ?? config.xField ?? 'X';
    const yLabel = dataSource?.fields.find((f) => f.id === config.yField)?.label ?? config.yField ?? 'Y';

    return (
      <Box>
        {crossFilterIndicator}
        <ScatterChart
          series={[
            {
              data: scatterData,
              label: `${xLabel} vs ${yLabel}`,
            },
          ]}
          height={CHART_HEIGHT}
          sx={{ cursor: 'pointer' }}
        />
      </Box>
    );
  }

  // Grouped or stacked bar charts
  if (chartType === 'bar-grouped' || chartType === 'bar-stacked') {
    if (!multiSeriesData || multiSeriesData.labels.length === 0) {
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: CHART_HEIGHT }}>
          <Typography variant="body2" color="text.secondary">
            {!config.xField || !config.yField || !config.seriesField
              ? 'Configure x, y, and series fields in the Compose drawer.'
              : 'No data to display.'}
          </Typography>
        </Box>
      );
    }

    const xAxisData = multiSeriesData.labels.map(String);
    const series = multiSeriesData.seriesNames.map((seriesName) => ({
      data: multiSeriesData.seriesData[seriesName],
      label: String(seriesName),
      stack: chartType === 'bar-stacked' ? 'total' : undefined,
    }));

    return (
      <Box>
        {crossFilterIndicator}
        <BarChart
          xAxis={[{ data: xAxisData, scaleType: 'band' }]}
          series={series}
          height={CHART_HEIGHT}
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
        />
      </Box>
    );
  }

  // Standard charts (bar, line, pie, area)
  if (!chartData || chartData.labels.length === 0) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: CHART_HEIGHT }}>
        <Typography variant="body2" color="text.secondary">
          {!config.xField || !config.yField
            ? 'Configure x and y fields in the Compose drawer.'
            : 'No data to display.'}
        </Typography>
      </Box>
    );
  }

  if (chartType === 'pie') {
    return (
      <Box>
        {crossFilterIndicator}
        <PieChart
          series={[
            {
              data: chartData.labels.map((label, i) => ({
                id: i,
                label: String(label),
                value: chartData.values[i],
              })),
              highlightScope: { highlight: 'item', fade: 'global' },
            },
          ]}
          height={CHART_HEIGHT}
          onItemClick={(_event, params) => {
            const label = chartData.labels[params.dataIndex];
            if (label !== undefined) {
              handleItemClick(label);
            }
          }}
          sx={{ cursor: 'pointer' }}
        />
      </Box>
    );
  }

  const xAxisData = chartData.labels.map(String);
  const seriesLabel = dataSource?.fields.find((f) => f.id === config.yField)?.label ?? config.yField ?? 'Value';

  if (chartType === 'line') {
    return (
      <Box>
        {crossFilterIndicator}
        <LineChart
          xAxis={[{ data: xAxisData, scaleType: 'point' }]}
          series={[{ data: chartData.values, label: seriesLabel, area: false }]}
          height={CHART_HEIGHT}
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
        />
      </Box>
    );
  }

  if (chartType === 'area') {
    return (
      <Box>
        {crossFilterIndicator}
        <LineChart
          xAxis={[{ data: xAxisData, scaleType: 'point' }]}
          series={[{ data: chartData.values, label: seriesLabel, area: true }]}
          height={CHART_HEIGHT}
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
        />
      </Box>
    );
  }

  // Default: bar chart
  return (
    <Box>
      {crossFilterIndicator}
      <BarChart
        xAxis={[{ data: xAxisData, scaleType: 'band' }]}
        series={[{ data: chartData.values, label: seriesLabel }]}
        height={CHART_HEIGHT}
        onAxisClick={(_event, params) => {
          if (params?.axisValue !== undefined) {
            handleItemClick(params.axisValue);
          }
        }}
        sx={{ cursor: 'pointer' }}
      />
    </Box>
  );
}
