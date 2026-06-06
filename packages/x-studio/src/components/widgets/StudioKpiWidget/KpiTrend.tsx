'use client';
import * as React from 'react';
import { Box, Stack, Tooltip, Typography, type SxProps, type Theme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat';
import { formatPeriodShort, formatDateRangeLong } from './kpiUtils';

export interface KpiTrendResult {
  delta: number;
  previousValue: number;
  previousStart?: Date;
  previousEnd?: Date;
  /** When set, shown as the "vs." label in place of the auto-formatted date range. */
  comparisonLabel?: string;
}

export interface KpiTrendProps {
  /** Computed trend data; null if no trend is available. */
  trendResult: KpiTrendResult | null;
  /** True when trend is configured but a date filter is needed to compute it. */
  needsDateFilter: boolean;
  /** Invert the colour convention (e.g. lower is better). */
  isInverted?: boolean;
  sx?: SxProps<Theme>;
}

export function KpiTrend(props: KpiTrendProps) {
  const { trendResult, needsDateFilter, isInverted = false, sx } = props;

  if (trendResult) {
    const trendUp = trendResult.delta > 0;
    const trendDown = trendResult.delta < 0;
    const trendFlat = trendResult.delta === 0;

    const isPositiveTrend = (trendUp && !isInverted) || (trendDown && isInverted);

    /** Resolve the semantic color token to an actual color string for alpha/border. */
    const getColor = (theme: Theme): string => {
      if (trendFlat) {
        return theme.palette.text.secondary;
      }
      if (isPositiveTrend) {
        return theme.palette.success.main;
      }
      return theme.palette.error.main;
    };
    // Keep trendColor as a MUI token for sx color resolution on inner elements
    let trendColor: string;
    if (trendFlat) {
      trendColor = 'text.secondary';
    } else if (isPositiveTrend) {
      trendColor = 'success.main';
    } else {
      trendColor = 'error.main';
    }

    const pct = Number.isFinite(trendResult.delta)
      ? `${trendResult.delta >= 0 ? '+' : ''}${(trendResult.delta * 100).toFixed(1)}%`
      : 'New';
    const periodShort = trendResult.comparisonLabel
      ? trendResult.comparisonLabel
      : formatPeriodShort(trendResult.previousStart!, trendResult.previousEnd!);
    const trendTooltip = trendResult.comparisonLabel
      ? `Target: ${trendResult.previousValue}`
      : formatDateRangeLong(trendResult.previousStart!, trendResult.previousEnd!);

    return (
      <Tooltip title={`Previous period: ${trendTooltip}`} placement="bottom-start">
        <Stack
          direction="row"
          spacing={0.75}
          sx={{ alignItems: 'center', cursor: 'default', ...sx }}
        >
          {/* Chip: icon + percentage with semi-transparent background and border */}
          <Box
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.5,
              px: 0.75,
              py: 0.25,
              borderRadius: '12px',
              backgroundColor: (theme) => alpha(getColor(theme), 0.08),
              border: (theme) => `1px solid ${getColor(theme)}`,
            }}
          >
            {trendFlat && (
              <TrendingFlatIcon fontSize="small" sx={{ color: trendColor, fontSize: '1rem' }} />
            )}
            {trendUp && (
              <TrendingUpIcon fontSize="small" sx={{ color: trendColor, fontSize: '1rem' }} />
            )}
            {trendDown && (
              <TrendingDownIcon fontSize="small" sx={{ color: trendColor, fontSize: '1rem' }} />
            )}
            <Typography variant="body2" sx={{ color: trendColor, fontWeight: 600, lineHeight: 1 }}>
              {pct}
            </Typography>
          </Box>
          <Typography variant="caption" sx={{ color: 'text.disabled' }}>
            vs. {periodShort}
          </Typography>
        </Stack>
      </Tooltip>
    );
  }

  if (needsDateFilter) {
    return (
      <Box sx={sx}>
        <Typography variant="caption" color="text.secondary">
          Add a date filter to show the trend.
        </Typography>
      </Box>
    );
  }

  return null;
}
