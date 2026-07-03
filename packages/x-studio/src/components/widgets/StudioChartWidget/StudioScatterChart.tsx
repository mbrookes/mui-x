'use client';
import * as React from 'react';
import { ScatterChart } from '@mui/x-charts/ScatterChart';
import type { ScatterChartProps } from '@mui/x-charts/ScatterChart';
import { Box } from '@mui/material';
import type { ScatterDataPoint, ScatterSeriesData } from '../../../internals/chartAggregation';

const GHOST_SERIES_SUFFIX = '-ghost';

interface StudioScatterChartProps {
  height: number;
  /** Categorical color-by field id (enables the multi-series, colour-coded rendering). */
  colorField?: string;
  /** Bubble size field id — when set, points map their `sizeValue` to a marker radius. */
  sizeField?: string;
  minRadius?: number;
  maxRadius?: number;
  /** Filtered (highlighted) single-series points, when no colour-by field is configured. */
  scatterData: ScatterDataPoint[] | null;
  /** Filtered (highlighted) per-category series, when a colour-by field is configured. */
  scatterSeries: ScatterSeriesData[] | null;
  /** Unfiltered single-series points, drawn dimmed behind the highlighted set. */
  allScatterData: ScatterDataPoint[] | null;
  /** Unfiltered per-category series, drawn dimmed behind the highlighted set. */
  allScatterSeries: ScatterSeriesData[] | null;
  /** When true, render the unfiltered ("ghost") points behind the filtered ones. */
  shouldShowGhost: boolean;
  skipAnimation: boolean;
  colors?: string[];
  xAxisLabel?: string;
  yAxisLabel?: string;
  slotProps?: Partial<ScatterChartProps>;
  /** Annotation reference lines rendered as chart children. */
  children?: React.ReactNode;
}

/**
 * Renders a scatter (or bubble) chart, wrapping the `@mui/x-charts` `ScatterChart`.
 * Supports an optional colour-by field (one series per category) and, when a
 * cross-filter is active, dimmed "ghost" points showing the unfiltered extent.
 */
export function StudioScatterChart({
  height,
  colorField,
  sizeField,
  minRadius,
  maxRadius,
  scatterData,
  scatterSeries,
  allScatterData,
  allScatterSeries,
  shouldShowGhost,
  skipAnimation,
  colors,
  xAxisLabel,
  yAxisLabel,
  slotProps,
  children,
}: StudioScatterChartProps) {
  // Colour-by is only active when both a field is configured and grouped series exist.
  const colorSeries = colorField && scatterSeries ? scatterSeries : null;
  const hasData = colorSeries
    ? colorSeries.some((s) => s.data.length > 0)
    : scatterData != null && scatterData.length > 0;

  if (!hasData) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height,
        }}
      />
    );
  }

  // When cross-highlight is active, render ghost (all data, dim) + highlighted (filtered) series
  const ghostSeries = (() => {
    if (!shouldShowGhost) {
      return null;
    }
    if (colorSeries && allScatterSeries) {
      return allScatterSeries.map((s) => ({
        id: `${s.id}${GHOST_SERIES_SUFFIX}`,
        label: s.label,
        data: s.data,
        markerSize: 3,
      }));
    }
    if (allScatterData) {
      return [{ id: `__all${GHOST_SERIES_SUFFIX}`, data: allScatterData, markerSize: 3 }];
    }
    return null;
  })();

  const highlightedSeries = colorSeries
    ? colorSeries.map((s) => ({
        id: s.id,
        label: s.label,
        data: s.data,
      }))
    : [
        {
          data: scatterData ?? [],
        },
      ];

  const resolvedSeries = ghostSeries ? [...ghostSeries, ...highlightedSeries] : highlightedSeries;

  // Bubble mode: when a size field is configured, each point carries a `sizeValue`
  // that the chart maps to a marker radius via a continuous size scale on the z-axis
  // (mui-x native bubble support — series default to the first z-axis as the size axis).
  const bubbleZAxis = sizeField
    ? [
        {
          sizeMap: {
            type: 'continuous' as const,
            size: [minRadius ?? 4, maxRadius ?? 40] as [number, number],
          },
        },
      ]
    : undefined;

  // Ghost series are identified by suffix; we render them at reduced opacity via sx
  const ghostIds = new Set(ghostSeries?.map((s) => s.id) ?? []);

  return (
    <div style={{ height }}>
      <ScatterChart
        {...slotProps}
        skipAnimation={skipAnimation}
        series={resolvedSeries}
        zAxis={bubbleZAxis}
        colors={colors}
        hideLegend={!colorSeries}
        margin={{ top: 16, right: colorSeries ? 8 : 16, bottom: 30, left: 40 }}
        xAxis={[{ label: xAxisLabel }]}
        yAxis={[{ label: yAxisLabel }]}
        slotProps={{
          legend: {
            sx: {
              overflowY: 'auto',
              flexWrap: 'nowrap',
              maxHeight: '100%',
            },
          },
        }}
        sx={{
          cursor: 'default',
          ...(ghostIds.size > 0 && {
            // Dim ghost series dots using CSS targeting — each ghost series
            // gets a lower-opacity fill. Ghost series are interleaved before
            // the highlighted series so they render behind them.
            [`& .MuiScatter-root:nth-of-type(-n+${ghostIds.size}) circle`]: {
              opacity: 0.2,
            },
          }),
        }}
      >
        {children}
      </ScatterChart>
    </div>
  );
}
