'use client';
import * as React from 'react';
import { useTheme } from '@mui/material';
import { HeatmapPremium } from '@mui/x-charts-premium/HeatmapPremium';
import type { HeatmapData } from '../../../internals/chartShapes/heatmap';
import type { StudioChartConfig, StudioDataField } from '../../../models';
import { formatFieldValue } from '../../../internals/numberFormat';

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

  const seriesData: [number, number, number][] = [];
  for (let xi = 0; xi < xLabels.length; xi += 1) {
    for (let yi = 0; yi < yLabels.length; yi += 1) {
      seriesData.push([xi, yi, cells.get(`${xLabels[xi]}\x00${yLabels[yi]}`) ?? 0]);
    }
  }

  const paletteColor = theme.palette[colorScheme].main;
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
            color: ['#ffffff', paletteColor],
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
