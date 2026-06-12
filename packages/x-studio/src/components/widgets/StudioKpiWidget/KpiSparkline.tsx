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
  /** Gauge minimum. @default 0 */
  gaugeMin?: number;
  /** Gauge maximum. Required when plotType is 'gauge'. */
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
    gaugeMin = 0,
    gaugeMax = 100,
  } = props;
  const localeText = useStudioLocaleText();

  if (plotType === 'gauge') {
    const value = kpiValue ?? 0;
    // Sanitize range — guard against NaN and inverted/zero-width ranges
    const safeMin = Number.isFinite(gaugeMin) ? gaugeMin : 0;
    const safeMax = Number.isFinite(gaugeMax) && gaugeMax > safeMin ? gaugeMax : safeMin + 1;
    const clampedValue = Math.min(Math.max(value, safeMin), safeMax);
    return (
      <Box
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
          valueMin={safeMin}
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
    return (
      <Box
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
            <ChartsReferenceLine y={targetValue} label={localeText.kpiSetupTargetLabel} labelAlign="end" />
          )}
        </SparkLineChart>
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
