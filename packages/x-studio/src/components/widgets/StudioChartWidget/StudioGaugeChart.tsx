'use client';
import * as React from 'react';
import { Box } from '@mui/material';
import { Gauge } from '@mui/x-charts/Gauge';
import type { GaugeFormatterParams, GaugeProps } from '@mui/x-charts/Gauge';

interface StudioGaugeChartProps {
  /** Aggregated value to display. Clamped to [valueMin, valueMax] before rendering. */
  value: number;
  valueMin: number;
  valueMax: number;
  height: number;
  /**
   * Accessible name for the gauge graphic (WCAG 1.1.1 / 4.1.2) — the widget's own or inferred
   * title, e.g. "Revenue". `GaugeContainer` forwards `title` to the chart surface's `aria-label`,
   * so the `role="meter"` it already renders stops being an unnamed graphic.
   */
  ariaTitle?: string;
  /**
   * Formats the number printed in the middle of the arc. Built from the measure's own
   * `format`/`currencyCode`/`precision`, so the gauge reads "€1.2M" like the KPI card on the same
   * measure instead of the Gauge default's raw `toLocaleString()` ("1,234,567.89"). Omitted when
   * the field carries no format config at all, which leaves the Gauge's own default in place.
   */
  valueFormatter?: (value: number | null) => string;
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
  ariaTitle,
  valueFormatter,
  slotProps,
}: StudioGaugeChartProps) {
  // Stays `undefined` when no formatter was supplied, so `Gauge` keeps its own
  // `toLocaleString()` default instead of being handed one that renders a bare `String(value)`.
  const valueText = valueFormatter
    ? ({ value: gaugeValue }: GaugeFormatterParams) => valueFormatter(gaugeValue)
    : undefined;
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
        // Before `slotProps` so a host can still override the name/value text; after it for the
        // dimensions and the clamped value, which Studio always controls.
        title={ariaTitle}
        text={valueText}
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
