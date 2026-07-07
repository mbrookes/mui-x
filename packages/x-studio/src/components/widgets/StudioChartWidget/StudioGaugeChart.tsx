'use client';
import * as React from 'react';
import { Box } from '@mui/material';
import { Gauge } from '@mui/x-charts/Gauge';
import type { GaugeProps } from '@mui/x-charts/Gauge';

interface StudioGaugeChartProps {
  /** Aggregated value to display. Clamped to [valueMin, valueMax] before rendering. */
  value: number;
  valueMin: number;
  valueMax: number;
  height: number;
  /** Extra Gauge props (dimensions/value are always controlled by Studio). */
  slotProps?: Omit<
    Partial<GaugeProps>,
    'ref' | 'value' | 'valueMin' | 'valueMax' | 'width' | 'height'
  >;
}

/**
 * Renders a single-value Gauge, wrapping the `@mui/x-charts` `Gauge`. The value is
 * clamped into the configured min/max range so the needle never overshoots the arc.
 */
export function StudioGaugeChart({
  value,
  valueMin,
  valueMax,
  height,
  slotProps,
}: StudioGaugeChartProps) {
  const clampedValue = Math.min(Math.max(value, valueMin), valueMax);
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height,
        width: '100%',
      }}
    >
      <Gauge
        {...slotProps}
        value={clampedValue}
        valueMin={valueMin}
        valueMax={valueMax}
        width={Math.min(height * 1.2, 320)}
        height={height * 0.85}
      />
    </Box>
  );
}
