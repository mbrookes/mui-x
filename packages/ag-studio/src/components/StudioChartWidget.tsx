import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';
import { Box, Typography } from '@mui/material';

import type { StudioDataSource, StudioWidget } from '../models';
import { applyFilters, aggregateByField } from './chartUtils';
import { useStudioSelector } from '../context';

export interface StudioChartWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

const CHART_HEIGHT = 260;

export function StudioChartWidget(props: StudioChartWidgetProps) {
  const { dataSource, widget } = props;
  const { config } = widget;
  const filters = useStudioSelector((state) => state.filters);

  const chartData = React.useMemo(() => {
    if (!dataSource?.rows) {
      return null;
    }

    const pageFilters = filters.filter((f) => f.scope === 'page');
    const widgetFilters = filters.filter((f) => f.scope === 'widget' && f.widgetId === widget.id);
    const allFilters = [...pageFilters, ...widgetFilters];

    const rows = applyFilters(dataSource.rows, allFilters);

    const xField = config.xField;
    const yField = config.yField;

    if (!xField || !yField) {
      return null;
    }

    return aggregateByField(rows, xField, yField);
  }, [dataSource, filters, config.xField, config.yField, widget.id]);

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

  if (chartType === 'pie') {
    return (
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
      />
    );
  }

  const xAxisData = chartData.labels.map(String);
  const seriesLabel = dataSource?.fields.find((f) => f.id === config.yField)?.label ?? config.yField ?? 'Value';

  if (chartType === 'line') {
    return (
      <LineChart
        xAxis={[{ data: xAxisData, scaleType: 'point' }]}
        series={[{ data: chartData.values, label: seriesLabel, area: false }]}
        height={CHART_HEIGHT}
      />
    );
  }

  return (
    <BarChart
      xAxis={[{ data: xAxisData, scaleType: 'band' }]}
      series={[{ data: chartData.values, label: seriesLabel }]}
      height={CHART_HEIGHT}
    />
  );
}
