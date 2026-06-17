'use client';
import * as React from 'react';
import { FunnelChart } from '@mui/x-charts-pro/FunnelChart';
import { formatNumber } from '../../../internals/numberFormat';
import type { StudioNumberFormat } from '../../../models';

interface FunnelStage {
  label: string;
  value: number;
}

interface StudioFunnelChartProps {
  stages: FunnelStage[];
  height: number;
  valueFormat?: StudioNumberFormat;
  currencyCode?: string;
}

export function StudioFunnelChart({
  stages,
  height,
  valueFormat,
  currencyCode,
}: StudioFunnelChartProps) {
  if (stages.length === 0) {
    return null;
  }

  return (
    <FunnelChart
      series={[
        {
          data: stages.map((s) => ({ value: s.value, label: s.label })),
          funnelDirection: 'decreasing',
          valueFormatter: (item) =>
            formatNumber(item.value, valueFormat ?? 'decimal', currencyCode),
        },
      ]}
      height={height}
    />
  );
}
