'use client';
import * as React from 'react';
import { Box, useTheme } from '@mui/material';
import { HeatmapPremium } from '@mui/x-charts-premium/HeatmapPremium';
import type { HeatmapData } from '../../../internals/chartShapes/heatmap';
import type { StudioChartConfig, StudioDataField } from '../../../models';
import { formatFieldValue } from '../../../internals/numberFormat';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';
import { buildChartDescription } from './chartA11y';

/**
 * Allow-list of the theme-palette keys a heatmap may index for its cell gradient. Guards
 * `theme.palette[colorScheme].main`: `colorScheme` is typed as this union but that type is
 * NOT enforced at the load/AI-tool boundary, so an unrecognized value (e.g. `"zzz"`) would
 * make `theme.palette[key]` undefined and crash the whole dashboard when `.main` is read.
 */
const SAFE_HEAT_SCHEMES = new Set<string>(['primary', 'success', 'warning', 'error']);

/**
 * Allow-list for the heatmap legend alignment union (`'start' | 'center' | 'end'`). Same
 * rationale as {@link SAFE_HEAT_SCHEMES}: `legendAlign` is typed as this union but that type is
 * not enforced at the load/AI-tool boundary, so an unknown value (e.g. `"middle"`) would index
 * `vertAlignMap` as `undefined` (or pass raw into the legend position) and render a garbage
 * legend placement. Fall back to `'center'`.
 */
const SAFE_HEAT_LEGEND_ALIGNS = new Set<string>(['start', 'center', 'end']);

/** Default `formatLabel`: render an axis label as-is. Module-level so the prop identity is stable. */
const IDENTITY_LABEL = (label: string | number) => String(label);

interface StudioHeatmapChartProps {
  height: number;
  heatData: HeatmapData;
  xFieldLabel?: string;
  yFieldLabel?: string;
  /** Value field's format config (drives the cell/legend value formatter). */
  valueFieldDef?: Pick<StudioDataField, 'type' | 'format' | 'currencyCode' | 'precision'>;
  /**
   * Formats an x-axis label for display. `aggregateHeatmap` builds `xLabels` from
   * `applyXGroupBy`, whose output is a sort-stable INTERNAL period key (`'2024-01'`,
   * `'2024-W03'`) whenever an `xGroupBy` is set — not something to show a user. Every other
   * x-axis family runs those keys through the widget's `formatLabel` (`'Jan 2024'`), so
   * without this a heatmap and the bar chart beside it labelled the same field differently.
   * Defaults to rendering the label as-is (the correct behaviour for a non-grouped axis).
   */
  formatLabel?: (label: string | number) => string;
  /** Theme palette key used for the cell color gradient (white → this color's `main`). */
  colorScheme: NonNullable<StudioChartConfig['heatColorScheme']>;
  legendPosition: NonNullable<StudioChartConfig['heatLegendPosition']>;
  legendAlign: NonNullable<StudioChartConfig['heatLegendAlign']>;
  /**
   * Accessible name for the chart graphic (WCAG 1.1.1 / 4.1.2).
   *
   * Unlike every sibling family, `HeatmapPremium` does NOT thread `title`/`desc` through to its
   * `ChartsLayerContainer` — it renders `<ChartsLayerContainer>` with no props — so passing
   * them would silently do nothing. The name is applied on a `role="img"` wrapper instead,
   * matching the pattern `StudioSankeyChart` / `StudioGanttChart` / `KpiSparkline` already use.
   * Safe here specifically because the studio heatmap is non-interactive: it wires no
   * cross-filter click and leaves x-charts' (opt-in, default-off) keyboard navigation disabled,
   * so `role="img"` hides no focusable descendant.
   */
  ariaTitle?: string;
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
  formatLabel = IDENTITY_LABEL,
  colorScheme,
  legendPosition,
  legendAlign,
  ariaTitle,
}: StudioHeatmapChartProps) {
  const theme = useTheme();
  const { filterSummaryAndMore: andMore } = useStudioLocaleText();
  const { xLabels, yLabels, cells, minValue, maxValue } = heatData;

  // `@mui/x-charts-pro`'s `HeatmapValueType` tuple has no null slot, so a cell with NO
  // measurement is represented by OMITTING its (xIndex, yIndex) entry entirely rather than by
  // pushing a `0`. `HeatmapData.getValue` (x-charts-pro) returns `null` for any index pair
  // absent from `data`, which flows into `valueFormatter` as `null` (handled below) and renders
  // unfilled via `getColor` — distinct from a real computed 0, which gets a genuine colour.
  //
  // `aggregateHeatmap` reports "no measurement" two ways, and both must be skipped here: an
  // absent key (no row landed in the cell at all) and a `null` value (rows landed, but every
  // one of their measures was null/non-numeric). Testing `value != null` covers both; testing
  // `cells.has(key)` covered only the first and pushed the all-null cells in as fabricated 0s,
  // so an Oslo/March tile with five null temperature readings painted at the bottom of the ramp
  // and its tooltip read "0 °C".
  const seriesData: [number, number, number][] = [];
  for (let xi = 0; xi < xLabels.length; xi += 1) {
    for (let yi = 0; yi < yLabels.length; yi += 1) {
      const value = cells.get(`${xLabels[xi]}\x00${yLabels[yi]}`);
      if (value != null) {
        seriesData.push([xi, yi, value]);
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
  // perceived intensity. `background.paper` already tracks the theme mode
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
  const safeLegendAlign = SAFE_HEAT_LEGEND_ALIGNS.has(legendAlign) ? legendAlign : 'center';
  const vertAlignMap = { start: 'top', center: 'middle', end: 'bottom' } as const;
  const heatLegendPos = isVerticalHeatLegend
    ? {
        horizontal: (legendPosition === 'left' ? 'start' : 'end') as 'start' | 'end',
        vertical: vertAlignMap[safeLegendAlign],
      }
    : {
        vertical: (legendPosition === 'top' ? 'top' : 'bottom') as 'top' | 'bottom',
        horizontal: safeLegendAlign,
      };
  const heatValueFormatter = (v: number) => formatFieldValue(v, valueFieldDef);

  // Text alternative: the heatmap is a visual-only SVG whose cells encode value by colour
  // intensity alone. Name the chart, then its two dimensions and value range — a single
  // `aria-label` rather than a separate description, since `role="img"` exposes no children
  // to build an `aria-describedby` target from.
  const heatAriaLabel = buildChartDescription(
    [
      ...(ariaTitle ? [ariaTitle] : []),
      ...(xFieldLabel ? [xFieldLabel] : []),
      ...(yFieldLabel ? [yFieldLabel] : []),
      `${heatValueFormatter(minValue)} – ${heatValueFormatter(maxValue)}`,
    ],
    andMore,
  );

  return (
    <Box role="img" aria-label={heatAriaLabel} sx={{ width: '100%', height }}>
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
            // `xLabels` are the raw aggregation keys — period keys ('2024-01') under an
            // `xGroupBy`. Format them the same way every other x-axis family does.
            valueFormatter: (value: string | number) => formatLabel(String(value)),
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
    </Box>
  );
}
