'use client';
import * as React from 'react';
import {
  FunnelChart,
  createFunnelPercentFormatter,
  createFunnelConversionFormatter,
} from '@mui/x-charts-pro/FunnelChart';
import type { FunnelCurveType } from '@mui/x-charts-pro/FunnelChart';
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
  /** How section labels display their values. @default 'value' */
  labelFormat?: 'value' | 'percent' | 'conversion';
  /** Where section labels are placed. @default 'inside' */
  labelPlacement?: 'inside' | 'outside-start' | 'outside-end';
  /** Gap in pixels between sections. @default 0 */
  gap?: number;
  /** Curve/shape style for sections. @default 'linear' */
  curve?: FunnelCurveType;
  /** Visual style for sections. @default 'filled' */
  variant?: 'filled' | 'outlined';
  /** Native sort applied by FunnelChart. 'none' means data is already ordered. */
  sort?: 'ascending' | 'descending' | 'none';
}

export function StudioFunnelChart({
  stages,
  height,
  valueFormat,
  currencyCode,
  labelFormat = 'value',
  labelPlacement = 'inside',
  gap = 0,
  curve = 'linear',
  variant = 'filled',
  sort = 'none',
}: StudioFunnelChartProps) {
  if (stages.length === 0) {
    return null;
  }

  const data = stages.map((s) => ({ value: s.value, label: s.label }));

  const valueFormatter =
    labelFormat === 'percent'
      ? createFunnelPercentFormatter(data)
      : labelFormat === 'conversion'
        ? createFunnelConversionFormatter(data)
        : (item: { value: number } | null) =>
            formatNumber(item?.value ?? 0, valueFormat ?? 'decimal', currencyCode);

  const sectionLabel =
    labelPlacement !== 'inside' ? { placement: labelPlacement, offset: 20 } : undefined;

  return (
    <FunnelChart
      series={[
        {
          data,
          funnelDirection: 'decreasing',
          valueFormatter,
          gap,
          curve,
          variant,
          sort,
          ...(sectionLabel ? { sectionLabel } : {}),
        },
      ]}
      height={height}
    />
  );
}
