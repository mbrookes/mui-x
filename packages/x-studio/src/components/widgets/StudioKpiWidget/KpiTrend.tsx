'use client';
import { Box, Stack, Tooltip, Typography, type SxProps, type Theme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat';
import { formatPeriodShort, formatDateRangeLong } from './kpiUtils';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';

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
  const localeText = useStudioLocaleText();

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

    // Sentiment (favorable / unfavorable) is otherwise conveyed only by the
    // green/red color, which fails for color-blind users (SC 1.4.1). Expose it
    // as screen-reader-only text so the meaning is not color-dependent.
    let sentimentLabel: string;
    if (trendFlat) {
      sentimentLabel = localeText.kpiTrendNoChangeLabel;
    } else if (isPositiveTrend) {
      sentimentLabel = localeText.kpiTrendFavorableLabel;
    } else {
      sentimentLabel = localeText.kpiTrendUnfavorableLabel;
    }

    const pct = Number.isFinite(trendResult.delta)
      ? `${trendResult.delta >= 0 ? '+' : ''}${(trendResult.delta * 100).toFixed(1)}%`
      : localeText.kpiTrendNewLabel;
    const periodShort = trendResult.comparisonLabel
      ? trendResult.comparisonLabel
      : formatPeriodShort(trendResult.previousStart!, trendResult.previousEnd!);
    const trendTooltip = trendResult.comparisonLabel
      ? localeText.kpiTrendTargetTooltip(trendResult.previousValue)
      : formatDateRangeLong(trendResult.previousStart!, trendResult.previousEnd!);

    return (
      <Tooltip
        title={localeText.kpiTrendPreviousPeriodTooltip(trendTooltip)}
        placement="bottom-start"
      >
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
            <Box
              component="span"
              sx={{
                position: 'absolute',
                width: 1,
                height: 1,
                p: 0,
                m: '-1px',
                overflow: 'hidden',
                clip: 'rect(0 0 0 0)',
                whiteSpace: 'nowrap',
                border: 0,
              }}
            >
              {sentimentLabel}
            </Box>
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
          {localeText.kpiTrendNoDateFilterHint}
        </Typography>
      </Box>
    );
  }

  return null;
}
