'use client';
import * as React from 'react';
import { ChartsDataProvider } from '@mui/x-charts/ChartsDataProvider';
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
import type { DatasetRow, VegaLiteSpec } from '../types';
import type { TranslationGap } from '../gaps';
import { compileSpec } from '../compile';

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
   */
  onGaps?: (gaps: TranslationGap[]) => void;
  /** Extra children rendered inside the chart surface (composition escape hatch). */
  children?: React.ReactNode;
}

/**
 * Renders a Vega-Lite specification with `@mui/x-charts` subcomponents.
 *
 * This is a best-effort translator: the supported grammar subset renders
 * natively (bar/line/area/point/arc marks, positional + color encodings,
 * aggregation, stacking, layering); everything else degrades gracefully and
 * is reported through `onGaps` (and a dev-mode console warning) rather than
 * throwing. See GAPS.md for the full support matrix.
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
        `MUI X Charts Vega: ${compiled.gaps.length} spec feature(s) could not be fully translated:\n` +
          compiled.gaps.map((gap) => `- [${gap.severity}] ${gap.code}: ${gap.message}`).join('\n'),
      );
    }
  }, [compiled.gaps, onGaps]);

  const resolvedWidth = width ?? compiled.width;
  const resolvedHeight = height ?? compiled.height;
  const xAxis = compiled.xAxis ? [compiled.xAxis.config] : undefined;
  const yAxis = compiled.yAxis ? [compiled.yAxis.config] : undefined;

  return (
    <ChartsDataProvider
      series={compiled.series}
      xAxis={xAxis}
      yAxis={yAxis}
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
          {compiled.plots.includes('bar') && <BarPlot />}
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
        <ChartsTooltip />
      </ChartsWrapper>
    </ChartsDataProvider>
  );
}
