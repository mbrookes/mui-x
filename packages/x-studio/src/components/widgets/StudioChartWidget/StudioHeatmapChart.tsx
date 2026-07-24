'use client';
import * as React from 'react';
import { useTheme } from '@mui/material';
import { HeatmapPremium } from '@mui/x-charts-premium/HeatmapPremium';
import type { HeatmapData } from '../../../internals/chartShapes/heatmap';
import type { StudioChartConfig, StudioDataField } from '../../../models';
import { formatFieldValue } from '../../../internals/numberFormat';

/**
 * Allow-list of the theme-palette keys a heatmap may index for its cell gradient. Guards
 * `theme.palette[colorScheme].main`: `colorScheme` is typed as this union but that type is
 * NOT enforced at the load/AI-tool boundary, so an unrecognized value (e.g. `"zzz"`) would
 * make `theme.palette[key]` undefined and crash the whole dashboard when `.main` is read.
 */
const SAFE_HEAT_SCHEMES = new Set<string>(['primary', 'success', 'warning', 'error']);

interface StudioHeatmapChartProps {
  height: number;
  heatData: HeatmapData;
  xFieldLabel?: string;
  yFieldLabel?: string;
  /** Value field's format config (drives the cell/legend value formatter). */
  valueFieldDef?: Pick<StudioDataField, 'type' | 'format' | 'currencyCode' | 'precision'>;
  /** Theme palette key used for the cell color gradient (white → this color's `main`). */
  colorScheme: NonNullable<StudioChartConfig['heatColorScheme']>;
  legendPosition: NonNullable<StudioChartConfig['heatLegendPosition']>;
  legendAlign: NonNullable<StudioChartConfig['heatLegendAlign']>;
}

/**
 * Renders a heatmap grid, wrapping `@mui/x-charts-premium`'s `HeatmapPremium`. Data
 * shaping (row/column aggregation) already lives in `internals/chartShapes/heatmap.ts`
 * (`aggregateHeatmap`) — this component only handles axis/legend/color presentation.
 */
export function StudioHeatmapChart({
  height,
  heatData,
  xFieldLabel,
  yFieldLabel,
  valueFieldDef,
  colorScheme,
  legendPosition,
  legendAlign,
}: StudioHeatmapChartProps) {
  const theme = useTheme();
  const { xLabels, yLabels, cells, minValue, maxValue } = heatData;

  // `@mui/x-charts-pro`'s `HeatmapValueType` tuple has no null slot — a cell with
  // genuinely zero contributing rows is represented by OMITTING its (xIndex, yIndex)
  // entry entirely, not by pushing a `0`. `HeatmapData.getValue` (x-charts-pro) then
  // returns `null` for any index pair absent from `data`, which flows into
  // `valueFormatter` as `null` (already handled below) and renders with no fill via
  // `getColor` — distinct from a real computed 0, which gets a genuine color (finding
  // 5). `aggregateHeatmap` only records a cell in `cells` when at least one row landed
  // in it, so `cells.has(...)` is exactly the "did any row contribute" check.
  const seriesData: [number, number, number][] = [];
  for (let xi = 0; xi < xLabels.length; xi += 1) {
    for (let yi = 0; yi < yLabels.length; yi += 1) {
      const key = `${xLabels[xi]}\x00${yLabels[yi]}`;
      if (cells.has(key)) {
        seriesData.push([xi, yi, cells.get(key) as number]);
      }
    }
  }

  // The `colorScheme` prop is typed as the four-key palette union, but that type is not
  // enforced at the load/AI-tool boundary (`config.heatColorScheme` can carry any string
  // from a hostile/corrupted doc). Indexing `theme.palette` with an unknown key yields
  // `undefined`, and reading `.main` off it throws — and since this package has NO error
  // boundary, that single bad value crashes the entire dashboard, not just this widget.
  // Allow-list before indexing and fall back to `'primary'` (mirrors the map widget's
  // `COLOR_RAMPS[colorScheme] ?? COLOR_RAMPS.blues`).
  const safeScheme = SAFE_HEAT_SCHEMES.has(colorScheme) ? colorScheme : 'primary';
  const paletteColor = theme.palette[safeScheme].main;
  // Low end of the continuous color ramp: anchoring to a hardcoded `'#ffffff'` made
  // low-value cells render bright white on a dark canvas in dark mode, inverting
  // perceived intensity (finding 4). `background.paper` already tracks the theme mode
  // (light: white-ish, dark: a dark elevation surface), so the ramp always starts from
  // "blends with the canvas" rather than a fixed light color.
  const colorRampBase = theme.palette.background.paper;
  // Size y-axis width to the longest label so owner names aren't truncated.
  // 7px/char is a reasonable estimate for the default axis font; cap at 240px.
  const longestYLabel = yLabels.reduce((max, l) => Math.max(max, String(l).length), 0);
  const yAxisWidth = Math.min(Math.max(longestYLabel * 7 + 8, 64), 240);

  const isVerticalHeatLegend = legendPosition === 'left' || legendPosition === 'right';
  const heatLegendDirection: 'horizontal' | 'vertical' = isVerticalHeatLegend
    ? 'vertical'
    : 'horizontal';
  const vertAlignMap = { start: 'top', center: 'middle', end: 'bottom' } as const;
  const heatLegendPos = isVerticalHeatLegend
    ? {
        horizontal: (legendPosition === 'left' ? 'start' : 'end') as 'start' | 'end',
        vertical: vertAlignMap[legendAlign],
      }
    : {
        vertical: (legendPosition === 'top' ? 'top' : 'bottom') as 'top' | 'bottom',
        horizontal: legendAlign,
      };
  const heatValueFormatter = (v: number) => formatFieldValue(v, valueFieldDef);

  return (
    <HeatmapPremium
      height={height}
      series={[
        {
          data: seriesData,
          valueFormatter: (v) => (v == null ? '' : heatValueFormatter(v)),
        },
      ]}
      xAxis={[
        {
          data: xLabels,
          label: xFieldLabel,
          height: xFieldLabel ? 60 : 40,
        },
      ]}
      yAxis={[
        {
          data: yLabels,
          label: yFieldLabel,
          width: yAxisWidth,
        },
      ]}
      zAxis={[
        {
          colorMap: {
            type: 'continuous',
            color: [colorRampBase, paletteColor],
            min: minValue,
            max: maxValue,
          },
        },
      ]}
      hideLegend={legendPosition === 'hidden'}
      slotProps={{
        legend: {
          position: heatLegendPos,
          direction: heatLegendDirection,
          minLabel: ({ value }) => heatValueFormatter(value as number),
          maxLabel: ({ value }) => heatValueFormatter(value as number),
          // Match the map widget's legend dimensions (180px wide / 140px tall).
          sx: isVerticalHeatLegend ? { height: 140 } : { width: 180 },
        },
      }}
    />
  );
}
