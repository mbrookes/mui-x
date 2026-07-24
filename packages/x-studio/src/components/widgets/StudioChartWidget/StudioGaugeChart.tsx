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
  // Sanitize the range — `valueMin`/`valueMax` are typed as `number` but that type is NOT
  // enforced at the load/AI-tool boundary (they come from `config.gaugeMin`/`config.gaugeMax`
  // in a possibly hostile/corrupted doc). A `valueMin === valueMax` pair divides by zero in the
  // Gauge's angle interpolation → a NaN SVG path (blank/broken arc); a `valueMin > valueMax`
  // pair clamps into and renders a reversed arc. Fall back to `0`/`100` when the pair isn't
  // finite or `max <= min` — matching the "guard-and-continue, warn in dev, never throw" style
  // KpiSparkline's gauge already uses (finding).
  const rangeIsValid =
    Number.isFinite(valueMin) && Number.isFinite(valueMax) && valueMax > valueMin;
  if (!rangeIsValid && process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: Gauge chart requires a finite "gaugeMin"/"gaugeMax" pair with gaugeMax > gaugeMin ` +
        `(received min=${valueMin}, max=${valueMax}). Falling back to 0/100. ` +
        "Set a valid range in the compose drawer's gauge options.",
    );
  }
  const safeMin = rangeIsValid ? valueMin : 0;
  const safeMax = rangeIsValid ? valueMax : 100;
  const clampedValue = Math.min(Math.max(value, safeMin), safeMax);
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
        valueMin={safeMin}
        valueMax={safeMax}
        width={Math.min(height * 1.2, 320)}
        height={height * 0.85}
      />
    </Box>
  );
}
