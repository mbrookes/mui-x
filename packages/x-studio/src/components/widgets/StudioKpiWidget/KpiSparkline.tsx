'use client';
import { Box, Typography } from '@mui/material';
import { SparkLineChart } from '@mui/x-charts/SparkLineChart';
import { Gauge } from '@mui/x-charts/Gauge';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import type { StudioNumberFormat } from '../../../models';
import { formatNumber } from '../../../internals/numberFormat';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';

export interface KpiSparklineProps {
  /** Bucketed time-series values; null means not yet computed. */
  data: number[] | null;
  /** True when a time field was resolved — false means no time field at all. */
  timeFieldResolved: boolean;
  plotType?: 'line' | 'bar' | 'gauge';
  area?: boolean;
  compact?: boolean;
  fieldFormat?: StudioNumberFormat;
  fieldPrecision?: number;
  fieldCurrencyCode?: string;
  /** Chart palette from the active page theme. Used to pick the sparkline color. */
  colors?: string[];
  /** When set, renders a horizontal reference line at this y-value. */
  targetValue?: number;
  /** Current KPI aggregate value — used only when plotType is 'gauge'. */
  kpiValue?: number;
  /** Gauge maximum (target value). Required when plotType is 'gauge'. */
  gaugeMax?: number;
}

export function KpiSparkline(props: KpiSparklineProps) {
  const {
    data,
    timeFieldResolved,
    plotType = 'line',
    area = false,
    compact = true,
    fieldFormat,
    fieldPrecision,
    fieldCurrencyCode,
    colors,
    targetValue,
    kpiValue,
    gaugeMax = 100,
  } = props;
  const localeText = useStudioLocaleText();
  const fmt = (v: number) => formatNumber(v, fieldFormat, fieldCurrencyCode, compact, fieldPrecision);

  if (plotType === 'gauge') {
    const value = kpiValue ?? 0;
    // Sanitize range — guard against NaN and zero-width ranges
    const safeMax = Number.isFinite(gaugeMax) && gaugeMax > 0 ? gaugeMax : 1;
    const clampedValue = Math.min(Math.max(value, 0), safeMax);
    // Text alternative: the gauge is a visual-only SVG.
    const gaugeAriaLabel = `Gauge: ${fmt(clampedValue)} of ${fmt(safeMax)}.`;
    return (
      <Box
        role="img"
        aria-label={gaugeAriaLabel}
        sx={{
          flexGrow: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 64,
          overflow: 'hidden',
        }}
      >
        <Gauge
          value={clampedValue}
          valueMin={0}
          valueMax={safeMax}
          width={120}
          height={80}
          text={({ value: v }) =>
            v === null
              ? ''
              : formatNumber(v, fieldFormat, fieldCurrencyCode, compact, fieldPrecision)
          }
        />
      </Box>
    );
  }

  const hasEnoughData = data !== null && data.length > 1;

  if (hasEnoughData) {
    const first = data[0];
    const last = data[data.length - 1];
    let direction = 'flat';
    if (last > first) {
      direction = 'trending up';
    } else if (last < first) {
      direction = 'trending down';
    }
    const sparkAriaLabel = `Sparkline with ${data.length} points, ${direction}, from ${fmt(
      first,
    )} to ${fmt(last)}.`;
    return (
      <Box
        role="img"
        aria-label={sparkAriaLabel}
        sx={{ flexGrow: 1, minWidth: 0, alignSelf: 'stretch', minHeight: 48, overflow: 'hidden' }}
      >
        <SparkLineChart
          data={data}
          plotType={plotType}
          area={plotType !== 'bar' ? area : undefined}
          showHighlight
          showTooltip
          valueFormatter={(v) =>
            v === null
              ? ''
              : formatNumber(v, fieldFormat, fieldCurrencyCode, compact, fieldPrecision)
          }
          color={colors?.[0]}
          sx={{ height: '100%' }}
          margin={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          {targetValue !== undefined && (
            <ChartsReferenceLine
              y={targetValue}
              label={localeText.kpiSetupTargetLabel}
              labelAlign="end"
            />
          )}
        </SparkLineChart>
      </Box>
    );
  }

  if (!timeFieldResolved) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
        {localeText.kpiSparklineNoTimeFieldHint}
      </Typography>
    );
  }

  return null;
}
