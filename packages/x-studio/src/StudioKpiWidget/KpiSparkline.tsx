'use client';
import * as React from 'react';
import { Box, Typography } from '@mui/material';
import { SparkLineChart } from '@mui/x-charts/SparkLineChart';
import type { StudioNumberFormat } from '../models';
import { formatNumber } from '../internals/numberFormat';

export interface KpiSparklineProps {
  /** Bucketed time-series values; null means not yet computed. */
  data: number[] | null;
  /** True when a time field was resolved — false means no time field at all. */
  timeFieldResolved: boolean;
  plotType?: 'line' | 'bar';
  area?: boolean;
  compact?: boolean;
  fieldFormat?: StudioNumberFormat;
  fieldCurrencyCode?: string;
  /** Chart palette from the active page theme. Used to pick the sparkline color. */
  colors?: string[];
}

export function KpiSparkline(props: KpiSparklineProps) {
  const { data, timeFieldResolved, plotType = 'line', area = false, compact = true, fieldFormat, fieldCurrencyCode, colors } = props;

  const hasEnoughData = data !== null && data.length > 1;

  if (hasEnoughData) {
    return (
      <Box sx={{ flexGrow: 1, minWidth: 80, alignSelf: 'stretch', minHeight: 48 }}>
        <SparkLineChart
          data={data}
          plotType={plotType}
          area={plotType !== 'bar' ? area : undefined}
          showHighlight
          showTooltip
          valueFormatter={(v) =>
            v === null
              ? ''
              : formatNumber(v, fieldFormat, fieldCurrencyCode, compact)
          }
          color={colors?.[0]}
          sx={{ height: '100%' }}
          margin={{ top: 4, bottom: 4, left: 4, right: 4 }}
        />
      </Box>
    );
  }

  if (!timeFieldResolved) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
        Add a date filter or select a time field to show a sparkline.
      </Typography>
    );
  }

  return null;
}
