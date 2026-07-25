'use client';
import * as React from 'react';
import { ScatterChart } from '@mui/x-charts/ScatterChart';
import type { ScatterChartProps } from '@mui/x-charts/ScatterChart';
import { rainbowSurgePalette } from '@mui/x-charts';
import { Box, useColorScheme, useTheme } from '@mui/material';
import {
  buildScatterCategoryColorMap,
  type ScatterDataPoint,
  type ScatterSeriesData,
} from '../../../internals/chartAggregation';

const GHOST_SERIES_SUFFIX = '-ghost';
const DEFAULT_MIN_RADIUS = 4;
const DEFAULT_MAX_RADIUS = 40;

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
  /**
   * Gates the single-series (no `colorField`) ghost baseline — mirrors
   * `StudioBarChart`/`StudioLineAreaChart`/`StudioPieChart`'s identical
   * `shouldShowGhost && allChartData && preserveXFieldBaseline` gate. When the
   * widget's x-field reads from a join-field expression a sibling cross-filter is
   * driving unreliable (e.g. a related-source join field), the baseline must not
   * render even though `shouldShowGhost` is true.
   */
  preserveXFieldBaseline: boolean;
  /**
   * Gates the colour-by (`colorField`) grouped ghost baseline — mirrors
   * `StudioBarChart`/`StudioLineAreaChart`'s split-by ghost gate
   * (`shouldShowGhost && allBarSeriesFieldData && preserveSplitByBaseline`).
   * `colorField` is scatter's equivalent of a split-by/series field.
   */
  preserveSplitByBaseline: boolean;
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
  preserveXFieldBaseline,
  preserveSplitByBaseline,
  skipAnimation,
  colors,
  xAxisLabel,
  yAxisLabel,
  slotProps,
  children,
}: StudioScatterChartProps) {
  const muiTheme = useTheme();
  const { colorScheme } = useColorScheme();
  const resolvedMode = (colorScheme ?? muiTheme.palette.mode) as 'light' | 'dark';

  // Sanitize the bubble radius range — `minRadius`/`maxRadius` (`config.scatterMinRadius`/
  // `config.scatterMaxRadius`) are validated ONLY by `ScatterConfigSection.tsx`'s `RadiusInput`
  // (min < max, 1 <= min <= 50, 1 <= max <= 100), which is editor-level validation: it enforces
  // the constraint on a keystroke typed through that specific setup-panel control. A value
  // written via `loadSerializedState`/an AI `update_widget`/`apply_bulk_update` tool call bypasses
  // that editor entirely and reaches `sizeMap.size` below unchecked — an inverted (`min > max`),
  // negative, or non-finite pair would otherwise feed a broken/crashing bubble size scale. Self-
  // validate here, at the render call site, mirroring `StudioGaugeChart`'s "guard-and-continue,
  // warn in dev, never throw" `rangeIsValid` pattern rather than relying on the editor alone.
  const radiusRangeIsValid =
    (minRadius === undefined || (Number.isFinite(minRadius) && minRadius > 0)) &&
    (maxRadius === undefined || (Number.isFinite(maxRadius) && maxRadius > 0)) &&
    (minRadius ?? DEFAULT_MIN_RADIUS) < (maxRadius ?? DEFAULT_MAX_RADIUS);
  if (!radiusRangeIsValid && process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: Scatter chart requires finite, positive "scatterMinRadius"/"scatterMaxRadius" ` +
        `with max > min (received min=${minRadius}, max=${maxRadius}). Falling back to ` +
        `${DEFAULT_MIN_RADIUS}/${DEFAULT_MAX_RADIUS}.`,
    );
  }
  const safeMinRadius = radiusRangeIsValid ? (minRadius ?? DEFAULT_MIN_RADIUS) : DEFAULT_MIN_RADIUS;
  const safeMaxRadius = radiusRangeIsValid ? (maxRadius ?? DEFAULT_MAX_RADIUS) : DEFAULT_MAX_RADIUS;

  // Colour-by is only active when both a field is configured and grouped series exist.
  const colorSeries = colorField && scatterSeries ? scatterSeries : null;
  const hasFilteredData = colorSeries
    ? colorSeries.some((s) => s.data.length > 0)
    : scatterData != null && scatterData.length > 0;
  // An emptied cross-filter (the filtered set has zero points) must not blank the chart when a
  // ghost baseline (the widget's own un-cross-filtered all-data) is available to render instead.
  // Bar/line/pie get this bypass from their `chartTypeDefs.tsx` dispatcher entry (`hasGhostData`);
  // scatter's dispatcher entry has no such bypass and always renders `StudioScatterChart`
  // unconditionally, so this component owns its own empty-state decision entirely and needs the
  // equivalent gate here (finding 6). `prepareScatterDataGrouped` drops empty categories
  // entirely, so an emptied filter yields `scatterSeries: []` (truthy, not null) — checking
  // `allScatterSeries` the same way (rather than falling through to the single-series
  // `allScatterData` branch) keeps this consistent with the colour-by ghost path below.
  //
  // Also gated on `preserveXFieldBaseline`/`preserveSplitByBaseline` (mirroring every sibling
  // chart type's ghost gate): a cross-filter can mark the baseline unreliable (e.g. the widget's
  // x-field/colour-by field is a join-field expression reading a related source), in which case
  // the baseline must not render even though `shouldShowGhost` is true.
  const hasGhostBaseline = Boolean(
    shouldShowGhost &&
    (colorField
      ? preserveSplitByBaseline &&
        allScatterSeries &&
        allScatterSeries.some((s) => s.data.length > 0)
      : preserveXFieldBaseline && allScatterData != null && allScatterData.length > 0),
  );
  const hasData = hasFilteredData || hasGhostBaseline;

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

  // Stable per-category colors, keyed by category identity (not array index), so a
  // category's ghost (baseline) and highlighted (filtered) series always share the
  // same hue — even though the two series lists can differ in length/order (a
  // category present in the baseline can be entirely absent from the filtered set).
  // The baseline list (`allScatterSeries`, when present) is used as the canonical
  // ordering source since it's always a superset of the filtered categories; any
  // extra categories only present in the filtered list (not expected in practice,
  // but handled defensively) are appended in their own order.
  const resolvedPalette = colors && colors.length > 0 ? colors : rainbowSurgePalette(resolvedMode);
  const categoryColorMap = (() => {
    if (!colorSeries) {
      return null;
    }
    const orderedCategoryIds = allScatterSeries ? allScatterSeries.map((s) => s.id) : [];
    const seen = new Set(orderedCategoryIds);
    for (const s of colorSeries) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        orderedCategoryIds.push(s.id);
      }
    }
    return buildScatterCategoryColorMap(orderedCategoryIds, resolvedPalette);
  })();

  // When cross-highlight is active, render ghost (all data, dim) + highlighted (filtered) series.
  // Gated on `preserveSplitByBaseline`/`preserveXFieldBaseline` respectively (same rationale as
  // `hasGhostBaseline` above) so an unreliable baseline is never drawn even when `shouldShowGhost`
  // is true — mirrors every sibling chart type's ghost-series gate.
  const ghostSeries = (() => {
    if (!shouldShowGhost) {
      return null;
    }
    if (colorSeries && allScatterSeries) {
      return preserveSplitByBaseline
        ? allScatterSeries.map((s) => ({
            id: `${s.id}${GHOST_SERIES_SUFFIX}`,
            // No `label`: ghost series must not add a second legend entry for a
            // category that's already shown (highlighted) in the legend.
            data: s.data,
            markerSize: 3,
            color: categoryColorMap?.get(s.id),
          }))
        : null;
    }
    if (allScatterData) {
      return preserveXFieldBaseline
        ? [
            {
              id: `__all${GHOST_SERIES_SUFFIX}`,
              data: allScatterData,
              markerSize: 3,
              color: resolvedPalette[0],
            },
          ]
        : null;
    }
    return null;
  })();

  const highlightedSeries = colorSeries
    ? colorSeries.map((s) => ({
        id: s.id,
        label: s.label,
        data: s.data,
        color: categoryColorMap?.get(s.id),
      }))
    : [
        {
          data: scatterData ?? [],
          color: resolvedPalette[0],
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
            size: [safeMinRadius, safeMaxRadius] as [number, number],
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
          ...slotProps?.slotProps,
          legend: {
            ...slotProps?.slotProps?.legend,
            sx: {
              ...slotProps?.slotProps?.legend?.sx,
              overflowY: 'auto',
              flexWrap: 'nowrap',
              maxHeight: '100%',
            },
          },
        }}
        sx={{
          cursor: 'default',
          ...(ghostIds.size > 0 && {
            // Dim ghost series dots using CSS targeting. Each ghost series' `<g>`
            // wrapper renders with `data-series` ending in `GHOST_SERIES_SUFFIX`
            // (`Scatter.tsx` in `@mui/x-charts` renders
            // `<g data-series={series.id} className="MuiScatterChart-series">` — one
            // group per series, not per-marker — and the utility class prefix is
            // `MuiScatterChart-*`, not `MuiScatter-*`; `root` there is a single `<g>`
            // wrapping every series, so `:nth-of-type` could never isolate the ghost
            // series by count regardless of prefix).
            [`& g[data-series$="${GHOST_SERIES_SUFFIX}"] circle`]: {
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
