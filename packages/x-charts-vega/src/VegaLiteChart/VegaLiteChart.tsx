'use client';
import * as React from 'react';
import { ChartsSurface } from '@mui/x-charts/ChartsSurface';
import { ChartsWrapper } from '@mui/x-charts/ChartsWrapper';
import { ChartsLegend } from '@mui/x-charts/ChartsLegend';
import { ChartsTooltip } from '@mui/x-charts/ChartsTooltip';
import { ChartsXAxis } from '@mui/x-charts/ChartsXAxis';
import { ChartsYAxis } from '@mui/x-charts/ChartsYAxis';
import { ChartsGrid } from '@mui/x-charts/ChartsGrid';
import { ChartsAxisHighlight } from '@mui/x-charts/ChartsAxisHighlight';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import { BarPlot } from '@mui/x-charts/BarChart';
import { AreaPlot, LineHighlightPlot, LinePlot, MarkPlot } from '@mui/x-charts/LineChart';
import { ScatterPlot } from '@mui/x-charts/ScatterChart';
import { PiePlot } from '@mui/x-charts/PieChart';
import { HeatmapPlot } from '@mui/x-charts-pro/Heatmap';
import { heatmapSeriesConfig } from '@mui/x-charts-pro/Heatmap/seriesConfig';
import {
  ChartsDataProviderPremium,
  defaultSeriesConfigPremium,
} from '@mui/x-charts-premium/ChartsDataProviderPremium';
import { Unstable_ChartsGeoDataProviderPremium as ChartsGeoDataProviderPremium } from '@mui/x-charts-premium/ChartsGeoDataProviderPremium';
import { RangeBarPlot } from '@mui/x-charts-premium/BarChartPremium';
import { GeoDataPlot, MapShapePlot } from '@mui/x-charts-premium/Map';
import type { DatasetRow, VegaLiteSpec } from '../types';
import type { TranslationGap } from '../gaps';
import { compileSpec } from '../compile';

// The premium provider's default series config registers every premium
// series EXCEPT heatmap (only the dedicated <Heatmap> chart wires that one
// in), so it must be merged in explicitly for heatmap series to process.
const SERIES_CONFIG = {
  ...defaultSeriesConfigPremium,
  heatmap: heatmapSeriesConfig,
};

export interface VegaLiteChartProps {
  /** The Vega-Lite specification to translate. */
  spec: VegaLiteSpec;
  /** Rows standing in for (or overriding) `spec.data.values`. */
  data?: readonly DatasetRow[];
  /** Named datasets referenced by `data: {name}` entries in the spec. */
  datasets?: Record<string, readonly DatasetRow[]>;
  /** Overrides `spec.width`. Without either, the chart fills its container. */
  width?: number;
  /** Overrides `spec.height`. */
  height?: number;
  /** Categorical palette override. */
  colors?: readonly string[];
  /**
   * Called (on mount and when the spec changes) with every Vega-Lite feature
   * of the spec that could not be fully translated to x-charts components.
   * @param {TranslationGap[]} gaps The features that were dropped, approximated, or ignored.
   */
  onGaps?: (gaps: TranslationGap[]) => void;
  /** Extra children rendered inside the chart surface (composition escape hatch). */
  children?: React.ReactNode;
}

/**
 * Renders a Vega-Lite specification with `@mui/x-charts` subcomponents.
 *
 * This is a best-effort translator: the supported grammar subset renders
 * natively (bar/line/area/point/arc/rect/rule/geoshape marks, positional +
 * color encodings, aggregation, stacking, layering); everything else degrades
 * gracefully and is reported through `onGaps` (and a dev-mode console
 * warning) rather than throwing. Marks covered only by the commercial tiers
 * (rect heatmaps, ranged bars, geoshape maps) render through
 * `@mui/x-charts-premium` — without a license key they show a watermark.
 * See GAPS.md for the full support matrix.
 */
export function VegaLiteChart(props: VegaLiteChartProps) {
  const { spec, data, datasets, width, height, colors, onGaps, children } = props;

  const compiled = React.useMemo(
    () => compileSpec(spec, { data, datasets, palette: colors }),
    [spec, data, datasets, colors],
  );

  const reportedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const signature = compiled.gaps.map((gap) => `${gap.code}|${gap.path}`).join(';');
    if (reportedRef.current === signature) {
      return;
    }
    reportedRef.current = signature;
    onGaps?.(compiled.gaps);
    if (process.env.NODE_ENV !== 'production' && compiled.gaps.length > 0 && !onGaps) {
      console.warn(
        `MUI X Charts Vega: ${compiled.gaps.length} spec feature(s) could not be fully translated:\n${compiled.gaps
          .map((gap) => `- [${gap.severity}] ${gap.code}: ${gap.message}`)
          .join('\n')}`,
      );
    }
  }, [compiled.gaps, onGaps]);

  const resolvedWidth = width ?? compiled.width;
  const resolvedHeight = height ?? compiled.height;

  if (compiled.chartKind === 'geo') {
    return (
      <ChartsGeoDataProviderPremium
        geoData={compiled.geo?.geoData as never}
        projection={compiled.geo?.projection as never}
        series={compiled.series as never}
        colors={compiled.colors.slice()}
        width={resolvedWidth}
        height={resolvedHeight}
      >
        <ChartsWrapper>
          {compiled.hasLegend && <ChartsLegend />}
          <ChartsSurface title={compiled.title}>
            {compiled.plots.includes('geoBase') && <GeoDataPlot />}
            {compiled.plots.includes('mapShape') && <MapShapePlot />}
            {children}
          </ChartsSurface>
          <ChartsTooltip trigger="item" />
        </ChartsWrapper>
      </ChartsGeoDataProviderPremium>
    );
  }

  const xAxis = compiled.xAxis ? [compiled.xAxis.config] : undefined;
  const yAxis = compiled.yAxis ? [compiled.yAxis.config] : undefined;

  return (
    <ChartsDataProviderPremium
      series={compiled.series}
      seriesConfig={SERIES_CONFIG as never}
      xAxis={xAxis}
      yAxis={yAxis}
      zAxis={compiled.zAxis}
      colors={compiled.colors.slice()}
      width={resolvedWidth}
      height={resolvedHeight}
    >
      <ChartsWrapper>
        {compiled.hasLegend && <ChartsLegend />}
        <ChartsSurface title={compiled.title}>
          {compiled.chartKind === 'cartesian' && (
            <ChartsGrid
              vertical={compiled.grid.vertical ?? false}
              horizontal={compiled.grid.horizontal ?? false}
            />
          )}
          {compiled.plots.includes('heatmap') && <HeatmapPlot />}
          {compiled.plots.includes('bar') && <BarPlot />}
          {compiled.plots.includes('rangeBar') && <RangeBarPlot />}
          {compiled.plots.includes('area') && <AreaPlot />}
          {compiled.plots.includes('line') && <LinePlot />}
          {compiled.plots.includes('scatter') && <ScatterPlot />}
          {compiled.plots.includes('marks') && <MarkPlot />}
          {compiled.plots.includes('lineHighlight') && <LineHighlightPlot />}
          {compiled.plots.includes('pie') && <PiePlot />}
          {compiled.chartKind === 'cartesian' && xAxis && <ChartsXAxis />}
          {compiled.chartKind === 'cartesian' && yAxis && <ChartsYAxis />}
          {compiled.chartKind === 'cartesian' && <ChartsAxisHighlight />}
          {compiled.referenceLines.map((line, index) =>
            line.axis === 'x' ? (
              <ChartsReferenceLine
                key={`x-${index}`}
                x={line.value}
                label={line.label}
                lineStyle={line.lineStyle}
              />
            ) : (
              <ChartsReferenceLine
                key={`y-${index}`}
                y={line.value}
                label={line.label}
                lineStyle={line.lineStyle}
              />
            ),
          )}
          {children}
        </ChartsSurface>
        {/* Heatmap cells have no axis-tooltip payload — use the item trigger. */}
        <ChartsTooltip trigger={compiled.plots.includes('heatmap') ? 'item' : undefined} />
      </ChartsWrapper>
    </ChartsDataProviderPremium>
  );
}
