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
import type { StudioChartConfig, StudioDataSource, StudioExpressionField } from '../../../models';
import type { MultiYSeriesData } from '../../../internals/chartAggregation';
import { makeValueFormatter, resolveFieldDef } from './chartWidgetHelpers';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';
import { buildChartDescription } from './chartA11y';

type YSeriesConfig = NonNullable<StudioChartConfig['ySeries']>[number];

/**
 * Looks up a blended series' source in the `dataSources` record, guarding against inherited
 * keys. `srcId` is doc-authored (a blended chart series' `sourceId`, or the widget's own
 * `sourceId` as fallback), so a key like "toString"/"constructor" would otherwise resolve a
 * function off `Object.prototype` instead of "not found" — and that truthy non-source object
 * slips past `resolveFieldDef`'s `dataSource?.fields.find(...)` and throws (prototype-chain key
 * lookup fix, matching `makeSelectWidgetSource` in `context/selectors.ts`).
 */
function getBlendedDataSource(
  dataSources: Record<string, StudioDataSource>,
  srcId: string | undefined,
): StudioDataSource | undefined {
  return srcId && Object.hasOwn(dataSources, srcId) ? dataSources[srcId] : undefined;
}

export interface StudioMixedChartProps {
  /** Aggregated multi-series data (one entry per configured y-series). */
  multiYData: MultiYSeriesData;
  /** Per-series configuration (type, source, label) aligned to `multiYData.series`. */
  ySeries: YSeriesConfig[];
  /** Route line series to a right-hand y-axis. */
  dualYAxis?: boolean;
  resolvedChartColors: string[];
  /** The widget's primary source id (fallback when a series omits `sourceId`). */
  widgetSourceId?: string;
  dataSources: Record<string, StudioDataSource>;
  dataSource?: StudioDataSource;
  /**
   * Doc-wide computed (expression) fields. Resolved via `resolveFieldDef` alongside each
   * series/axis's native fields (bar, line/area via `lineSeries.ts`, pie, and scatter all
   * already do this) so a calculated mixed-chart measure gets its real label/format
   * instead of rendering its raw field id. Expression field ids are unique
   * doc-wide, so the same list resolves foreign-source blended series correctly too — no
   * per-source filtering is needed.
   */
  expressionFields?: StudioExpressionField[];
  height: number;
  skipAnimation: boolean;
  /**
   * Format a raw category label for display (applies period labels when x is grouped).
   * Threaded through so the band x-axis/tooltip agree with every other categorical
   * chart, which formats period-grouped keys (e.g. `2024-W07`) via this same helper.
   *
   */
  formatLabel: (label: string | number) => string;
  /**
   * Accessible name for the chart graphic — forwarded to `ChartsSurface`'s `title` prop, which
   * becomes the chart container's `aria-label` (WCAG 1.1.1 / 4.1.2).
   */
  ariaTitle?: string;
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
  resolvedChartColors,
  widgetSourceId,
  dataSources,
  dataSource,
  expressionFields = [],
  height,
  skipAnimation,
  formatLabel,
  ariaTitle,
  children,
}: StudioMixedChartProps) {
  const { filterSummaryAndMore: andMore } = useStudioLocaleText();
  const mixedSeries = multiYData.series.map((s, index) => {
    // Match the config by fieldId, for both blended and non-blended charts.
    // `multiYData.series` order does NOT reliably line up with `ySeries` by index for
    // blended charts: `useChartWidgetData`'s `blendedMultiYData` builds its inputs via
    // `blendSeries.flatMap((s) => (s.fieldId ? [...] : []))`, which drops fieldless
    // entries — so an incomplete `ySeries` row (no `fieldId` yet, e.g. mid-configuration
    // in the setup panel) before a configured one shifts every subsequent series one
    // index out of alignment with a positional lookup.
    //
    // For a real blended chart, `blendedMultiYData` always populates `s.sourceId` on
    // every entry (see its construction in `useChartWidgetData.ts`), and two series can
    // legitimately share a `fieldId` while blending different sources (e.g. `amount`
    // from `orders` and `amount` from `refunds`) — matching by fieldId alone would
    // config-match the second series to the first's `ySeries` entry, rendering it with
    // the wrong chart type/label/format/axis. So when the data entry
    // itself carries a sourceId, also require the config's resolved sourceId (falling
    // back to the widget's primary source, same as `seriesSourceId` below) to match it.
    const seriesConfig = ySeries.find((c) => {
      if (c.fieldId !== s.fieldId) {
        return false;
      }
      if (s.sourceId === undefined) {
        return true;
      }
      return (c.sourceId ?? widgetSourceId) === s.sourceId;
    });
    const seriesType = (seriesConfig && normalizeChartSeries(seriesConfig).type) ?? 'bar';
    const seriesId = `${s.fieldId}-${index}`;
    const color = resolvedChartColors[index % resolvedChartColors.length];
    // The field may live in a foreign source for blended series — fall back across
    // all sources, then to the explicit series label, then the field id. `resolveFieldDef`
    // also checks `expressionFields` (doc-wide, so this covers a foreign source's
    // expression fields too), matching every sibling chart family.
    const seriesSourceId = seriesConfig?.sourceId ?? widgetSourceId;
    const fieldDef =
      resolveFieldDef(
        s.fieldId,
        seriesSourceId ? getBlendedDataSource(dataSources, seriesSourceId) : dataSource,
        expressionFields,
      ) ?? resolveFieldDef(s.fieldId, dataSource, expressionFields);
    const seriesLabel = seriesConfig?.label ?? fieldDef?.label ?? s.fieldId;
    // Series values must honour the field's format/currencyCode/precision the same way
    // the y-axes already do (lines below) — otherwise the tooltip shows raw numbers
    // while the axis they're plotted against shows formatted ones.
    const valueFormatter = makeValueFormatter(
      fieldDef?.format,
      fieldDef?.currencyCode,
      fieldDef?.precision,
    );
    if (seriesType === 'line') {
      return {
        type: 'line' as const,
        id: seriesId,
        label: seriesLabel,
        data: s.values,
        color,
        yAxisId: dualYAxis ? 'right' : 'left',
        valueFormatter,
      };
    }
    return {
      type: 'bar' as const,
      id: seriesId,
      label: seriesLabel,
      data: s.values,
      color,
      yAxisId: 'left',
      valueFormatter,
    };
  });

  const xAxisData = multiYData.labels;
  // Find a representative field def for each y-axis side (for axis tick formatting)
  const getMixedFieldDef = (sc: { fieldId: string; sourceId?: string } | undefined) => {
    if (!sc) {
      return undefined;
    }
    const srcId = sc.sourceId ?? widgetSourceId;
    return resolveFieldDef(
      sc.fieldId,
      srcId ? getBlendedDataSource(dataSources, srcId) : dataSource,
      expressionFields,
    );
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
        xAxis={[
          {
            id: 'x',
            data: xAxisData,
            scaleType: 'band',
            valueFormatter: (v: string | number) => formatLabel(String(v)),
          },
        ]}
        yAxis={yAxes}
        height={height}
        skipAnimation={skipAnimation}
      >
        <ChartsWrapper>
          <ChartsSurface
            title={ariaTitle}
            // Bar and line series are otherwise distinguished by hue/shape alone.
            desc={buildChartDescription(
              mixedSeries.map((entry) => String(entry.label ?? '')),
              andMore,
            )}
          >
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
