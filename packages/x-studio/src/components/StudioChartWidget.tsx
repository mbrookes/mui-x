import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';
import { Box, Chip, Stack, Typography } from '@mui/material';

import type { StudioDataSource, StudioWidget } from '../models';
import { applyFilters, aggregateByField } from './chartUtils';
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

  const chartData = React.useMemo(() => {
    if (!dataSource?.rows) {
      return null;
    }

    const pageFilters = filters.filter((f) => f.scope === 'page');
    const widgetFilters = filters.filter((f) => f.scope === 'widget' && f.widgetId === widget.id);
    // Cross-filters from OTHER widgets affect this widget
    const crossFilters = filters.filter(
      (f) => f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id,
    );
    const allFilters = [...pageFilters, ...widgetFilters, ...crossFilters];

    const rows = applyFilters(dataSource.rows, allFilters);

    const xField = config.xField;
    const yField = config.yField;

    if (!xField || !yField) {
      return null;
    }

    return aggregateByField(rows, xField, yField);
  }, [dataSource, filters, config.xField, config.yField, widget.id]);

  const handleItemClick = React.useCallback(
    (label: string | number) => {
      if (!config.xField) return;

      // Toggle cross-filter: if same value is already active, clear it
      if (activeCrossFilter && activeCrossFilter.value === label) {
        controller.clearCrossFilter(widget.id);
      } else {
        controller.applyCrossFilter(widget.id, config.xField, label);
      }
    },
    [controller, widget.id, config.xField, activeCrossFilter],
  );

  const chartType = config.chartType ?? 'bar';

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
