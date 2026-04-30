'use client';
import * as React from 'react';
import { Stack, Tooltip, Typography } from '@mui/material';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat';
import { formatPeriodShort, formatDateRangeLong } from './kpiUtils';

export interface KpiTrendResult {
  delta: number;
  previousValue: number;
  previousStart: Date;
  previousEnd: Date;
}

export interface KpiTrendProps {
  /** Computed trend data; null if no trend is available. */
  trendResult: KpiTrendResult | null;
  /** True when trend is configured but a date filter is needed to compute it. */
  needsDateFilter: boolean;
  /** Invert the colour convention (e.g. lower is better). */
  isInverted?: boolean;
}

export function KpiTrend(props: KpiTrendProps) {
  const { trendResult, needsDateFilter, isInverted = false } = props;

  if (trendResult) {
    const trendUp = trendResult.delta > 0;
    const trendDown = trendResult.delta < 0;
    const trendFlat = trendResult.delta === 0;

    const trendColor = trendFlat
      ? 'text.secondary'
      : ((trendUp && !isInverted) || (trendDown && isInverted))
        ? 'success.main'
        : 'error.main';

    const pct = Number.isFinite(trendResult.delta)
      ? `${trendResult.delta >= 0 ? '+' : ''}${(trendResult.delta * 100).toFixed(1)}%`
      : 'New';
    const periodShort = formatPeriodShort(trendResult.previousStart, trendResult.previousEnd);
    const trendLabel = `${pct} vs. ${periodShort}`;
    const trendTooltip = formatDateRangeLong(trendResult.previousStart, trendResult.previousEnd);

    return (
      <Tooltip title={`Previous period: ${trendTooltip}`} placement="bottom-start">
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'baseline', cursor: 'default' }}>
          {trendFlat && <TrendingFlatIcon fontSize="small" sx={{ color: trendColor, alignSelf: 'center' }} />}
          {trendUp && <TrendingUpIcon fontSize="small" sx={{ color: trendColor, alignSelf: 'center' }} />}
          {trendDown && <TrendingDownIcon fontSize="small" sx={{ color: trendColor, alignSelf: 'center' }} />}
          <Typography variant="body2" sx={{ color: trendColor, fontWeight: 500 }}>
            {pct}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.disabled' }}>
            vs. {periodShort}
          </Typography>
        </Stack>
      </Tooltip>
    );
  }

  if (needsDateFilter) {
    return (
      <Typography variant="caption" color="text.secondary">
        Add a date filter to show the trend.
      </Typography>
    );
  }

  return null;
}
