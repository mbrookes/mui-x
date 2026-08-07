'use client';
import * as React from 'react';
import {
  FunnelChart,
  createFunnelPercentFormatter,
  createFunnelConversionFormatter,
} from '@mui/x-charts-pro/FunnelChart';
import type { FunnelCurveType } from '@mui/x-charts-pro/FunnelChart';
import { formatNumber } from '@mui/x-studio-core/engine';
import type { StudioNumberFormat } from '../../../models';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';
import { buildChartDescription } from './chartA11y';

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
  /**
   * Accessible name for the chart graphic — forwarded to the `FunnelChart`'s `title` prop, which
   * becomes the chart container's `aria-label` (WCAG 1.1.1 / 4.1.2).
   */
  ariaTitle?: string;
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
  ariaTitle,
}: StudioFunnelChartProps) {
  const { filterSummaryAndMore: andMore } = useStudioLocaleText();
  if (stages.length === 0) {
    return null;
  }

  let data = stages.map((s) => ({ value: s.value, label: s.label }));
  if (sort === 'descending') {
    data = [...data].sort((a, b) => b.value - a.value);
  } else if (sort === 'ascending') {
    data = [...data].sort((a, b) => a.value - b.value);
  }

  let valueFormatter: (item: { value: number } | null) => string;
  if (labelFormat === 'percent') {
    valueFormatter = createFunnelPercentFormatter(data);
  } else if (labelFormat === 'conversion') {
    valueFormatter = createFunnelConversionFormatter(data);
  } else {
    valueFormatter = (item) =>
      formatNumber(item?.value ?? 0, valueFormat ?? 'decimal', currencyCode);
  }

  const sectionLabel =
    labelPlacement !== 'inside' ? { placement: labelPlacement, offset: 20 } : undefined;

  return (
    <FunnelChart
      title={ariaTitle}
      // Stages are otherwise distinguished by position/hue alone.
      desc={buildChartDescription(
        data.map((d) => `${d.label}: ${valueFormatter({ value: d.value })}`),
        andMore,
      )}
      series={[
        {
          data,
          funnelDirection: 'decreasing',
          valueFormatter,
          curve,
          variant,
          ...(sectionLabel ? { sectionLabel } : {}),
        },
      ]}
      gap={gap}
      height={height}
    />
  );
}
