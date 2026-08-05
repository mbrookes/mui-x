'use client';
import { Box, Stack, Tooltip, Typography, type SxProps, type Theme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat';
import { formatPeriodShort, formatDateRangeLong } from './kpiUtils';
import { formatPercent } from '../../../internals/numberFormat';
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

    // `delta` is a ratio (0.425 = +42.5%), so scale it to the 0–100 domain `formatPercent`
    // expects. Formatting via `Intl` (rather than `toFixed` + a literal '%') keeps the
    // decimal separator and the symbol's placement consistent with the KPI value rendered
    // directly above this badge, which already goes through `formatNumber`. The explicit
    // '+' stays: `Intl` omits a sign for positive numbers, and the badge's whole job is to
    // show direction.
    const pct = Number.isFinite(trendResult.delta)
      ? `${trendResult.delta >= 0 ? '+' : ''}${formatPercent(trendResult.delta * 100)}`
      : localeText.kpiTrendNewLabel;
    // `KpiTrendResult` is a public slot API (`StudioKpiWidgetSlotProps.trend`): the
    // built-in widget's own trend computation always sets `comparisonLabel` together
    // with `previousStart`/`previousEnd`, so the type marks all three optional but in
    // practice one of "comparisonLabel present" or "both dates present" always holds.
    // A HOST-supplied `trendResult` isn't bound by that convention, though, so guard
    // rather than assert: fall back to an empty period string (still a coherent,
    // non-crashing render — just an unlabeled "vs." caption) when neither a
    // `comparisonLabel` nor a complete `previousStart`/`previousEnd` pair is present.
    let periodShort: string;
    let trendTooltip: string;
    if (trendResult.comparisonLabel) {
      periodShort = trendResult.comparisonLabel;
      trendTooltip = localeText.kpiTrendTargetTooltip(trendResult.previousValue);
    } else if (trendResult.previousStart && trendResult.previousEnd) {
      periodShort = formatPeriodShort(trendResult.previousStart, trendResult.previousEnd);
      trendTooltip = formatDateRangeLong(trendResult.previousStart, trendResult.previousEnd);
    } else {
      periodShort = '';
      trendTooltip = '';
    }

    return (
      <Tooltip
        // `describeChild`: the default puts the title on the child as `aria-label`, which names
        // nothing on a roleless `<div>` — so the full comparison period was reachable by mouse
        // hover alone. `describeChild` emits a real `title` attribute (and `aria-describedby` while
        // open), making it programmatically determinable (WCAG 1.3.1). No `tabIndex`: the badge is
        // a readout, not a control, and the SHORT period is already rendered as visible text in the
        // "vs. {period}" caption below — the tooltip only widens it to the exact date range, so no
        // information is pointer-exclusive.
        describeChild
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
            {localeText.kpiTrendVsLabel(periodShort)}
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
