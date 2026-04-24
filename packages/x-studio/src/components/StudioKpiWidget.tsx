import * as React from 'react';
import { Box, Typography } from '@mui/material';

import type { StudioDataSource, StudioWidget } from '../models';
import { applyFilters } from './chartUtils';
import { useStudioSelector } from '../context';

export interface StudioKpiWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

function formatValue(value: number, format?: string, prefix?: string, suffix?: string): string {
  let formatted: string;

  if (format === 'currency') {
    formatted = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(value);
  } else if (format === 'percent') {
    formatted = new Intl.NumberFormat(undefined, {
      style: 'percent',
      maximumFractionDigits: 1,
    }).format(value / 100);
  } else {
    formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }

  return `${prefix ?? ''}${formatted}${suffix ?? ''}`;
}

function computeAggregate(
  rows: Record<string, unknown>[],
  field: string,
  aggregation: string,
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

export function StudioKpiWidget(props: StudioKpiWidgetProps) {
  const { dataSource, widget } = props;
  const { config } = widget;
  const filters = useStudioSelector((state) => state.filters);

  const { displayValue, hasData } = React.useMemo(() => {
    if (!dataSource?.rows || !config.kpiValueField) {
      return { displayValue: '—', hasData: false };
    }

    const pageFilters = filters.filter((f) => f.scope === 'page');
    const widgetFilters = filters.filter((f) => f.scope === 'widget' && f.widgetId === widget.id);
    const allFilters = [...pageFilters, ...widgetFilters];

    const rows = applyFilters(dataSource.rows, allFilters);
    const aggregation = config.kpiAggregation ?? 'sum';
    const value = computeAggregate(rows, config.kpiValueField, aggregation);

    return {
      displayValue: formatValue(value, config.kpiFormat, config.kpiPrefix, config.kpiSuffix),
      hasData: true,
    };
  }, [dataSource, filters, config, widget.id]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography
        variant="h3"
        sx={{ fontWeight: 700, lineHeight: 1 }}
        color={hasData ? 'text.primary' : 'text.disabled'}
      >
        {displayValue}
      </Typography>
    </Box>
  );
}
