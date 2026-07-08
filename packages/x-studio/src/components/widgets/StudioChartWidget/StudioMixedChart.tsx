'use client';
import * as React from 'react';
import { BarPlot } from '@mui/x-charts/BarChart';
import { LinePlot, MarkPlot } from '@mui/x-charts/LineChart';
import { ChartsDataProvider } from '@mui/x-charts/ChartsDataProvider';
import { ChartsWrapper } from '@mui/x-charts/ChartsWrapper';
import { ChartsSurface } from '@mui/x-charts/ChartsSurface';
import { ChartsXAxis } from '@mui/x-charts/ChartsXAxis';
import { ChartsYAxis } from '@mui/x-charts/ChartsYAxis';
import { ChartsTooltip } from '@mui/x-charts/ChartsTooltip';
import { ChartsLegend } from '@mui/x-charts/ChartsLegend';
import { ChartsAxisHighlight } from '@mui/x-charts/ChartsAxisHighlight';
import { ChartsGrid } from '@mui/x-charts/ChartsGrid';
import { normalizeChartSeries } from '@mui/x-studio-schema';
import type { StudioDataSource, StudioWidgetConfigForKind } from '../../../models';
import type { MultiYSeriesData } from '../../../internals/chartAggregation';
import { makeValueFormatter } from './chartWidgetHelpers';

type YSeriesConfig = NonNullable<StudioWidgetConfigForKind<'chart'>['ySeries']>[number];

interface StudioMixedChartProps {
  /** Aggregated multi-series data (one entry per configured y-series). */
  multiYData: MultiYSeriesData;
  /** Per-series configuration (type, source, label) aligned to `multiYData.series`. */
  ySeries: YSeriesConfig[];
  /** Route line series to a right-hand y-axis. */
  dualYAxis?: boolean;
  /**
   * Whether the chart blends series from independent sources. When blended the
   * series config is matched by index (order is preserved 1:1); otherwise by fieldId.
   */
  isBlended: boolean;
  resolvedChartColors: string[];
  /** The widget's primary source id (fallback when a series omits `sourceId`). */
  widgetSourceId?: string;
  dataSources: Record<string, StudioDataSource>;
  dataSource?: StudioDataSource;
  height: number;
  skipAnimation: boolean;
  /** Annotation reference lines rendered as chart children. */
  children?: React.ReactNode;
}

/**
 * Renders a combo (mixed) chart overlaying bar and line series on a shared band
 * x-axis, wrapping `@mui/x-charts` primitives via `ChartsDataProvider`. Supports an
 * optional dual y-axis (bars left, lines right) and cross-source blended series.
 */
export function StudioMixedChart({
  multiYData,
  ySeries,
  dualYAxis,
  isBlended,
  resolvedChartColors,
  widgetSourceId,
  dataSources,
  dataSource,
  height,
  skipAnimation,
  children,
}: StudioMixedChartProps) {
  const mixedSeries = multiYData.series.map((s, index) => {
    // For blended charts a fieldId can repeat across sources, so match the config
    // by index (aggregateBlendedSeries preserves ySeries order 1:1); otherwise match
    // by fieldId to stay robust to de-duplicated multi-Y series.
    const seriesConfig = isBlended ? ySeries[index] : ySeries.find((c) => c.fieldId === s.fieldId);
    const seriesType = (seriesConfig && normalizeChartSeries(seriesConfig).type) ?? 'bar';
    const seriesId = `${s.fieldId}-${index}`;
    const color = resolvedChartColors[index % resolvedChartColors.length];
    // The field may live in a foreign source for blended series — fall back across
    // all sources, then to the explicit series label, then the field id.
    const seriesSourceId = seriesConfig?.sourceId ?? widgetSourceId;
    const fieldDef =
      (seriesSourceId ? dataSources[seriesSourceId] : dataSource)?.fields.find(
        (f) => f.id === s.fieldId,
      ) ?? dataSource?.fields.find((f) => f.id === s.fieldId);
    const seriesLabel = seriesConfig?.label ?? fieldDef?.label ?? s.fieldId;
    if (seriesType === 'line') {
      return {
        type: 'line' as const,
        id: seriesId,
        label: seriesLabel,
        data: s.values,
        color,
        yAxisId: dualYAxis ? 'right' : 'left',
      };
    }
    return {
      type: 'bar' as const,
      id: seriesId,
      label: seriesLabel,
      data: s.values,
      color,
      yAxisId: 'left',
    };
  });

  const xAxisData = multiYData.labels;
  // Find a representative field def for each y-axis side (for axis tick formatting)
  const getMixedFieldDef = (sc: { fieldId: string; sourceId?: string } | undefined) => {
    if (!sc) {
      return undefined;
    }
    const srcId = sc.sourceId ?? widgetSourceId;
    return (srcId ? dataSources[srcId] : dataSource)?.fields.find((f) => f.id === sc.fieldId);
  };
  const leftSeriesConfig =
    ySeries.find((sc) => (normalizeChartSeries(sc).type ?? 'bar') === 'bar') ?? ySeries[0];
  const rightSeriesConfig = dualYAxis
    ? ySeries.find((sc) => (normalizeChartSeries(sc).type ?? 'bar') === 'line')
    : undefined;
  const leftAxisFieldDef = getMixedFieldDef(leftSeriesConfig);
  const rightAxisFieldDef = getMixedFieldDef(rightSeriesConfig);
  const yAxes = dualYAxis
    ? [
        {
          id: 'left',
          scaleType: 'linear' as const,
          position: 'left' as const,
          valueFormatter: makeValueFormatter(
            leftAxisFieldDef?.format,
            leftAxisFieldDef?.currencyCode,
            leftAxisFieldDef?.precision,
          ),
        },
        {
          id: 'right',
          scaleType: 'linear' as const,
          position: 'right' as const,
          valueFormatter: makeValueFormatter(
            rightAxisFieldDef?.format,
            rightAxisFieldDef?.currencyCode,
            rightAxisFieldDef?.precision,
          ),
        },
      ]
    : [
        {
          id: 'left',
          scaleType: 'linear' as const,
          valueFormatter: makeValueFormatter(
            leftAxisFieldDef?.format,
            leftAxisFieldDef?.currencyCode,
            leftAxisFieldDef?.precision,
          ),
        },
      ];

  return (
    <div style={{ width: '100%', height }}>
      <ChartsDataProvider
        series={mixedSeries}
        xAxis={[{ id: 'x', data: xAxisData, scaleType: 'band' }]}
        yAxis={yAxes}
        height={height}
        skipAnimation={skipAnimation}
      >
        <ChartsWrapper>
          <ChartsSurface>
            <ChartsGrid horizontal />
            <BarPlot />
            <LinePlot />
            <MarkPlot />
            <ChartsXAxis axisId="x" />
            <ChartsYAxis axisId="left" />
            {dualYAxis && <ChartsYAxis axisId="right" />}
            <ChartsAxisHighlight x="band" />
            {children}
          </ChartsSurface>
          <ChartsTooltip trigger="axis" />
          <ChartsLegend />
        </ChartsWrapper>
      </ChartsDataProvider>
    </div>
  );
}
