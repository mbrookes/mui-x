'use client';
import * as React from 'react';
import { LineChart } from '@mui/x-charts/LineChart';
import type { LineChartProps } from '@mui/x-charts/LineChart';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import type { StudioChartConfig, StudioDataSource, StudioExpressionField } from '../../../models';
import type { StudioWidgetForecast } from '../../../models/widgetTypes';
import type {
  AggregatedData,
  MultiSeriesData,
  MultiYSeriesData,
} from '../../../internals/chartAggregation';
import { computeWidgetForecast } from '../../../internals/forecastUtils';
import { buildMultiYLineSeries } from './lineSeries';
import {
  alignFilteredToAllLabels,
  CHART_LEGEND_SLOT_PROPS,
  computeControlledHighlight,
  computeStackTotals,
  createLineXAxisConfig,
  formatPercentAxis,
  formatPercentValue,
  isAreaStacked,
  makeAxisClickHandler,
  makeCrossHighlightLineFormatter,
  makeValueFormatter,
  resolveFieldDef,
  sortAggregatedTemporally,
  sortMultiSeriesTemporally,
  sortMultiYTemporally,
} from './chartWidgetHelpers';

const CROSS_FILTER_AXIS_ID = 'cross-filter-axis';
const CROSS_FILTER_SERIES_ID = 'cross-filter-series';
const GHOST_SERIES_SUFFIX = '-ghost';

type LineHighlightItem = HighlightItemIdentifier<'bar' | 'line' | 'pie'>;

export interface StudioLineAreaChartProps {
  /** One of the four line/area variants this component renders. */
  chartType: 'line' | 'area' | 'area-stacked' | 'area-100';
  height: number;
  /** Filtered single-series aggregation (labels + values). Non-null when the chart is configured. */
  chartData: AggregatedData | null;
  /** Unfiltered single-series aggregation for ghost/cross-highlight; null when not applicable. */
  allChartData: AggregatedData | null;
  /** Filtered split-by (series field) aggregation; drives the per-category line/area rendering. */
  seriesFieldData: MultiSeriesData | null;
  /** Unfiltered split-by aggregation — the stable baseline for the split-by ghost lines. */
  allSeriesFieldData: MultiSeriesData | null;
  /** Filtered multi-Y aggregation (one entry per y-field). */
  multiYData: MultiYSeriesData | null;
  /** Unfiltered multi-Y aggregation — the stable baseline for the multi-Y ghost lines. */
  allMultiYData: MultiYSeriesData | null;
  /** Resolved active y-fields — the single-series measure lookup. */
  activeYFields: string[];
  /** Widget data source — used with `expressionFields` to resolve per-series field defs. */
  dataSource?: StudioDataSource;
  /** Computed (expression) fields — the second half of `resolveFieldDef`. */
  expressionFields: StudioExpressionField[];
  /** Period grouping for the x-axis (drives the temporal axis config). */
  xGroupBy: StudioChartConfig['xGroupBy'];
  /** Format a raw category label for display (applies period labels when x is grouped). */
  formatLabel: (label: string | number) => string;
  /** Forecast config for the single-series line/area paths (null/undefined disables). */
  forecast: StudioWidgetForecast | undefined;
  /** Localised label for the forecast trend series. */
  forecastSeriesLabel: string;
  /** Localised fallback label for the single measure series. */
  defaultSeriesLabel: string;
  /** Explicit chart colours (page palette override). */
  chartColors?: string[];
  /** Always-resolved palette for stable series colours. */
  resolvedChartColors: string[];
  /** Stable colour for a split-by series name, based on its position in the unfiltered set. */
  getSeriesColor: (name: string | number) => string | undefined;
  /** True when cross-filter ghost rendering is active on this widget. */
  shouldShowGhost: boolean;
  /** False when the x-field is foreign-derived and constrained by an incoming cross-filter. */
  preserveXFieldBaseline: boolean;
  /** False when the split-by field is foreign-derived and constrained by an incoming cross-filter. */
  preserveSplitByBaseline: boolean;
  skipAnimation: boolean;
  /** Compute the cross-filter-selected indices against a rendered label order. */
  getSelectedDataIndices: (labels: Array<string | number | Date>) => number[];
  /** Current hover highlight (set by this or a sibling widget). */
  hoveredItem: LineHighlightItem | null;
  /** Current hover axis highlight (set by this or a sibling widget). */
  hoveredAxis: AxisItemIdentifier[] | null;
  /** True when this widget has an active cross-filter on its x-field. */
  hasActiveXFilter: boolean;
  /** True when another widget on the page is emitting a cross-filter to this one. */
  hasIncomingCrossFilters: boolean;
  /** Report a hover change back to the orchestrator's hover state. */
  onHoverChange: (item: LineHighlightItem | null) => void;
  /** Report an axis hover change back to the orchestrator's hover state. */
  onAxisHoverChange: (axis: AxisItemIdentifier[] | null) => void;
  /** Emit a cross-filter for the clicked x-value (regular = single-select, shift = multi-select). */
  onItemClick: (label: string | number | Date, shiftKey: boolean) => void;
  /** Spread onto the underlying LineChart. */
  slotProps?: Partial<LineChartProps>;
  /** Annotation reference lines rendered as chart children. */
  children?: React.ReactNode;
}

/**
 * Renders a line or area chart, wrapping the `@mui/x-charts` `LineChart`. Supports a
 * split-by (series field) mode (one line/area per category), a multi-Y mode (one series
 * per y-field with optional independent left/right axes), and single-series line/area
 * rendering with cross-filter ghost overlays and forecast trend/confidence-band series.
 */
export function StudioLineAreaChart({
  chartType,
  height,
  chartData: chartDataRaw,
  allChartData: allChartDataRaw,
  seriesFieldData: seriesFieldDataRaw,
  allSeriesFieldData: allSeriesFieldDataRaw,
  multiYData: multiYDataRaw,
  allMultiYData: allMultiYDataRaw,
  activeYFields,
  dataSource,
  expressionFields,
  xGroupBy,
  formatLabel,
  forecast,
  forecastSeriesLabel,
  defaultSeriesLabel,
  chartColors,
  resolvedChartColors,
  getSeriesColor,
  shouldShowGhost,
  preserveXFieldBaseline,
  preserveSplitByBaseline,
  skipAnimation,
  getSelectedDataIndices,
  hoveredItem,
  hoveredAxis,
  hasActiveXFilter,
  hasIncomingCrossFilters,
  onHoverChange,
  onAxisHoverChange,
  onItemClick,
  slotProps,
  children,
}: StudioLineAreaChartProps) {
  const createLineXAxis = (labels: (string | number)[], axisId?: string) =>
    createLineXAxisConfig(labels, xGroupBy, formatLabel, axisId);

  // A temporal line/area x-axis is always plotted chronologically ascending (the axis
  // dates are sorted inside `getTemporalAxisData`). The aggregations arrive in whatever
  // order `chartSortBy` / `chartSortDirection` / a rank filter produced, so reorder every
  // series' values with the same chronological permutation — otherwise each value renders
  // against the wrong date (finding 1.7). No-ops (same reference) for non-temporal or
  // already-chronological labels.
  const chartData = chartDataRaw ? sortAggregatedTemporally(chartDataRaw) : chartDataRaw;
  const allChartData = allChartDataRaw
    ? sortAggregatedTemporally(allChartDataRaw)
    : allChartDataRaw;
  const seriesFieldData = seriesFieldDataRaw
    ? sortMultiSeriesTemporally(seriesFieldDataRaw)
    : seriesFieldDataRaw;
  const allSeriesFieldData = allSeriesFieldDataRaw
    ? sortMultiSeriesTemporally(allSeriesFieldDataRaw)
    : allSeriesFieldDataRaw;
  const multiYData = multiYDataRaw ? sortMultiYTemporally(multiYDataRaw) : multiYDataRaw;
  const allMultiYData = allMultiYDataRaw
    ? sortMultiYTemporally(allMultiYDataRaw)
    : allMultiYDataRaw;

  // Highlightable series ids: the split-by names, the multi-Y series ids, or the single
  // cross-filter series. Computed locally since this component owns the series shape and
  // gates hover highlighting itself (rather than receiving a pre-gated item).
  let highlightableSeriesIds: Set<string>;
  if (seriesFieldData && seriesFieldData.seriesNames.length > 0) {
    highlightableSeriesIds = new Set<string>(
      seriesFieldData.seriesNames.map((name) => String(name)),
    );
  } else if (multiYData && multiYData.labels.length > 0) {
    highlightableSeriesIds = new Set<string>(
      multiYData.series.map((series, index) => `${series.fieldId}-${index}`),
    );
  } else {
    highlightableSeriesIds = new Set<string>([CROSS_FILTER_SERIES_ID]);
  }

  const { item: controlledHighlightedItem, axis: controlledHighlightedAxis } =
    computeControlledHighlight(
      hoveredItem,
      hoveredAxis,
      hasActiveXFilter,
      hasIncomingCrossFilters,
      highlightableSeriesIds,
    );

  // ── seriesField line/area chart: one line (or area) per unique series-field value ──
  if (
    seriesFieldData &&
    seriesFieldData.seriesNames.length > 0 &&
    (chartType === 'line' ||
      chartType === 'area' ||
      chartType === 'area-stacked' ||
      chartType === 'area-100')
  ) {
    const yFieldDef = resolveFieldDef(activeYFields[0], dataSource, expressionFields);
    const isArea = chartType !== 'line';
    const isStacked = isAreaStacked(chartType);
    const is100 = chartType === 'area-100';

    // When ghost-rendering (non-stacked only), use allSeriesFieldData as the x-axis basis so
    // ghost lines appear for all series/x-positions, including ones filtered away.
    const sfLineAllData =
      !isStacked && shouldShowGhost && allSeriesFieldData && preserveSplitByBaseline
        ? allSeriesFieldData
        : null;
    const effectiveSFLineData = sfLineAllData ?? seriesFieldData;
    const xAxis = createLineXAxis(effectiveSFLineData.labels, CROSS_FILTER_AXIS_ID);
    const selectedDataIndices = getSelectedDataIndices(effectiveSFLineData.labels);

    // Pre-normalize to 0-100% per x-position (avoids floating-point issues with stackOffset:'expand')
    const totals100 = is100
      ? computeStackTotals(
          seriesFieldData.seriesNames.map((name) => seriesFieldData.seriesData[name]),
          seriesFieldData.labels.length,
        )
      : null;

    // Ghost series: each series at 25% opacity with full baseline values, no marks, no legend entry.
    // Placed before active series so they render behind.
    const ghostSeries = sfLineAllData
      ? sfLineAllData.seriesNames.map((name) => ({
          id: `${String(name)}-ghost`,
          data: sfLineAllData.seriesData[name],
          color: `${getSeriesColor(name) ?? resolvedChartColors[0]}40`,
          area: isArea,
          connectNulls: true as const,
          showMark: false,
          disableHighlight: true as const,
        }))
      : [];

    const series = effectiveSFLineData.seriesNames.map((name) => {
      // Align filtered data to the all-data x-positions when ghost series are present.
      const rawData = sfLineAllData
        ? alignFilteredToAllLabels(
            sfLineAllData.labels,
            seriesFieldData.labels,
            seriesFieldData.seriesData[name] ?? sfLineAllData.labels.map(() => null),
          )
        : seriesFieldData.seriesData[name];
      // Stacked area: null breaks the stacking algorithm → use 0
      const stackedLineOrRaw = isStacked ? rawData.map((v) => v ?? 0) : rawData;
      const data: (number | null)[] = totals100
        ? rawData.map((v, i) => {
            const total = totals100[i];
            return total ? ((v ?? 0) / total) * 100 : 0;
          })
        : stackedLineOrRaw;
      return {
        id: String(name),
        data,
        label: String(name),
        area: isArea,
        connectNulls: true,
        stack: isStacked ? 'total' : undefined,
        color: getSeriesColor(name),
        highlightScope: { highlight: 'item' as const, fade: 'global' as const },
        valueFormatter: is100
          ? formatPercentValue
          : makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode, yFieldDef?.precision),
      };
    });
    return (
      <div style={{ height }}>
        <LineChart
          {...slotProps}
          skipAnimation={skipAnimation}
          xAxis={xAxis}
          yAxis={[
            {
              width: 'auto',
              valueFormatter: is100
                ? formatPercentAxis
                : makeValueFormatter(
                    yFieldDef?.format,
                    yFieldDef?.currencyCode,
                    yFieldDef?.precision,
                  ),
              ...(is100 && { min: 0, max: 100 }),
            },
          ]}
          series={[...ghostSeries, ...series]}
          colors={chartColors}
          margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
          highlightedItem={controlledHighlightedItem}
          highlightedAxis={
            selectedDataIndices.length > 0
              ? selectedDataIndices.map((i) => ({ axisId: CROSS_FILTER_AXIS_ID, dataIndex: i }))
              : controlledHighlightedAxis
          }
          onHighlightChange={(item) =>
            onHoverChange(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onHighlightedAxisChange={onAxisHoverChange}
          onAxisClick={makeAxisClickHandler(onItemClick)}
          sx={{ cursor: 'default' }}
          slotProps={CHART_LEGEND_SLOT_PROPS}
        >
          {children}
        </LineChart>
      </div>
    );
  }

  // ── multi-Y line/area chart: one series per y-field ──
  if (multiYData && multiYData.labels.length > 0) {
    const isArea = chartType !== 'line';
    const isStacked = isAreaStacked(chartType);
    const is100 = chartType === 'area-100';

    // When ghost-rendering (non-stacked only), use allMultiYData as the x-axis basis so ghost
    // series cover all x-positions including those filtered away.
    const multiYAllData =
      !isStacked && shouldShowGhost && allMultiYData && preserveXFieldBaseline
        ? allMultiYData
        : null;
    const effectiveLabels = (multiYAllData ?? multiYData).labels;
    const xAxis = createLineXAxis(effectiveLabels, CROSS_FILTER_AXIS_ID);
    const selectedDataIndices = getSelectedDataIndices(effectiveLabels);

    const useIndependentAxes = !isStacked && multiYData.series.length > 1;
    const multiYLineFieldDefs = multiYData.series.map((s) =>
      resolveFieldDef(s.fieldId, dataSource, expressionFields),
    );
    const yAxes = useIndependentAxes
      ? multiYData.series.map((_s, i) => ({
          id: `y-${i}`,
          position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
          width: 'auto' as const,
          valueFormatter: makeValueFormatter(
            multiYLineFieldDefs[i]?.format,
            multiYLineFieldDefs[i]?.currencyCode,
            multiYLineFieldDefs[i]?.precision,
          ),
        }))
      : [
          {
            width: 'auto' as const,
            valueFormatter: is100
              ? formatPercentAxis
              : makeValueFormatter(
                  multiYLineFieldDefs[0]?.format,
                  multiYLineFieldDefs[0]?.currencyCode,
                  multiYLineFieldDefs[0]?.precision,
                ),
            ...(is100 && { min: 0, max: 100 }),
          },
        ];

    // Ghost series: each y-field at 25% opacity with full baseline values, no marks, no legend entry.
    const ghostSeries = multiYAllData
      ? multiYAllData.series.map((s, i) => ({
          id: `${s.fieldId}-${i}-ghost`,
          data: s.values,
          color: `${resolvedChartColors[i % resolvedChartColors.length]}40`,
          area: isArea,
          connectNulls: true as const,
          showMark: false,
          disableHighlight: true as const,
          yAxisId: useIndependentAxes ? `y-${i}` : undefined,
        }))
      : [];

    // Active series: aligned to allMultiYData labels when ghost series are present.
    const activeSeries = multiYAllData
      ? multiYAllData.series.map((s, i) => {
          const filteredSeries = multiYData.series[i];
          const alignedValues: (number | null)[] = filteredSeries
            ? alignFilteredToAllLabels(
                multiYAllData.labels,
                multiYData.labels,
                filteredSeries.values,
              )
            : multiYAllData.labels.map(() => null);
          const fieldDef = resolveFieldDef(s.fieldId, dataSource, expressionFields);
          return {
            id: `${s.fieldId}-${i}`,
            data: alignedValues,
            label: fieldDef?.label ?? s.fieldId,
            area: isArea,
            connectNulls: true as const,
            color: resolvedChartColors[i % resolvedChartColors.length],
            yAxisId: useIndependentAxes ? `y-${i}` : undefined,
            highlightScope: { highlight: 'item' as const, fade: 'global' as const },
            valueFormatter: makeValueFormatter(
              fieldDef?.format,
              fieldDef?.currencyCode,
              fieldDef?.precision,
            ),
          };
        })
      : buildMultiYLineSeries(multiYData, chartType, dataSource, expressionFields);

    return (
      <div style={{ height }}>
        <LineChart
          {...slotProps}
          skipAnimation={skipAnimation}
          xAxis={xAxis}
          yAxis={yAxes}
          series={[...ghostSeries, ...activeSeries]}
          colors={chartColors}
          margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
          highlightedItem={
            selectedDataIndices.length > 0
              ? {
                  // The rendered series ids carry an index suffix (`${fieldId}-${i}`), so the
                  // highlighted seriesId must match the first rendered series id (`${fieldId}-0`)
                  // rather than the bare `fieldId`.
                  seriesId: multiYData.series[0]
                    ? `${multiYData.series[0].fieldId}-0`
                    : CROSS_FILTER_SERIES_ID,
                  dataIndex: selectedDataIndices[0],
                }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            onHoverChange(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={makeAxisClickHandler(onItemClick)}
          sx={{ cursor: 'default' }}
          slotProps={CHART_LEGEND_SLOT_PROPS}
        >
          {children}
        </LineChart>
      </div>
    );
  }

  // ── Single-series line/area prelude ──
  const singleChartData = chartData;
  const yFieldDef = resolveFieldDef(activeYFields[0], dataSource, expressionFields);
  const seriesLabel = yFieldDef?.label ?? activeYFields[0] ?? defaultSeriesLabel;
  const seriesValueFormatter = makeValueFormatter(
    yFieldDef?.format,
    yFieldDef?.currencyCode,
    yFieldDef?.precision,
  );

  // Ghost line series data (allChartData values) for line/area charts when ghost-rendering
  const ghostLineValues =
    shouldShowGhost && allChartData && preserveXFieldBaseline ? allChartData.values : null;

  const isArea = chartType !== 'line';
  const ghostAlpha = isArea ? '30' : '40';
  // Forecast is single-series and line/area only (never area-stacked/area-100).
  const forecastEligible = chartType === 'line' || chartType === 'area';
  const forecastData =
    forecastEligible && forecast?.enabled && !ghostLineValues && singleChartData
      ? computeWidgetForecast(singleChartData.labels, singleChartData.values, forecast)
      : null;

  // When ghost-rendering, the axis is built from the ALL-data (baseline) labels — the same basis
  // as the ghost values — so the filtered values must be RE-ALIGNED onto those positions. Without
  // that, a cross-filter that drops an entire x bucket shifts every later filtered value one slot
  // left of its real label and the "filtered / total" tooltip pairs mismatch. The split-by and
  // multi-Y paths already align this way via `alignFilteredToAllLabels`; the single-series ghost
  // path did not (finding 2.29). Forecast and ghost are mutually exclusive (forecast is disabled
  // when `ghostLineValues` is set), so the branches below never overlap.
  // Single-series: stacking has no visual effect; area-100 shows a flat 100% fill.
  const effectiveLabels = forecastData
    ? forecastData.labels
    : ghostLineValues && allChartData
      ? allChartData.labels
      : singleChartData!.labels;
  const mainSeriesData: (number | null)[] = forecastData
    ? forecastData.historicalSeries
    : ghostLineValues && allChartData
      ? alignFilteredToAllLabels(
          allChartData.labels,
          singleChartData!.labels,
          singleChartData!.values,
        )
      : singleChartData!.values;
  // Highlight index is computed against the RENDERED (effective) label order so an own-selection
  // resolves to the correct axis position even when the ghost axis uses the baseline labels.
  const selectedDataIndices = getSelectedDataIndices(effectiveLabels);
  const xAxis = createLineXAxis(effectiveLabels, CROSS_FILTER_AXIS_ID);
  const lineColor = resolvedChartColors[0];
  return (
    <div style={{ height }}>
      <LineChart
        {...slotProps}
        skipAnimation={skipAnimation}
        xAxis={xAxis}
        yAxis={[{ width: 'auto', valueFormatter: seriesValueFormatter }]}
        series={[
          // Ghost series: baseline (all-data) shown at low opacity — only when cross-filtering.
          ...(ghostLineValues
            ? [
                {
                  id: `${CROSS_FILTER_SERIES_ID}${GHOST_SERIES_SUFFIX}`,
                  data: ghostLineValues,
                  label: seriesLabel,
                  area: isArea,
                  connectNulls: true,
                  showMark: false,
                  disableHighlight: true,
                  // Faded baseline colour set directly on the series (line ghost = 25% alpha,
                  // area ghost = ~19% alpha), matching the multi-Y / seriesField ghost paths.
                  // x-charts resolves `series.color ?? colors[i]`, so the explicit color must
                  // already carry the alpha — a full-opacity color here would make the ghost
                  // indistinguishable from the active series.
                  color: `${lineColor}${ghostAlpha}`,
                  valueFormatter: seriesValueFormatter,
                } as const,
              ]
            : []),
          {
            id: CROSS_FILTER_SERIES_ID,
            data: mainSeriesData,
            label: seriesLabel,
            area: isArea,
            connectNulls: true,
            color: lineColor,
            highlightScope: { highlight: 'item', fade: 'global' },
            // Cross-highlight ("filtered / total") formatter is applied only for the line
            // variant under an active ghost; the area variant keeps the plain formatter
            // (pre-existing asymmetry, preserved as-is).
            valueFormatter:
              !isArea && ghostLineValues
                ? makeCrossHighlightLineFormatter(ghostLineValues, seriesValueFormatter)
                : seriesValueFormatter,
          },
          // Forecast trend line (dashed, no marks, excluded from legend)
          ...(forecastData
            ? [
                {
                  id: '__forecast__',
                  data: forecastData.forecastSeries,
                  label: forecastSeriesLabel,
                  area: isArea,
                  connectNulls: false,
                  showMark: false,
                  disableHighlight: true as const,
                  color: lineColor,
                  valueFormatter: seriesValueFormatter,
                } as const,
                // Confidence bands are line-only — the area variant never renders them
                // (pre-existing asymmetry, preserved as-is).
                ...(!isArea && forecastData.upperBand
                  ? [
                      {
                        id: '__forecast_upper__',
                        data: forecastData.upperBand,
                        label: '',
                        area: true,
                        connectNulls: false,
                        showMark: false,
                        disableHighlight: true as const,
                        color: `${lineColor}30`,
                        stack: 'confidence',
                        stackOrder: 'ascending' as const,
                        valueFormatter: () => '',
                      } as const,
                      {
                        id: '__forecast_lower__',
                        data: forecastData.lowerBand as (number | null)[],
                        label: '',
                        area: true,
                        connectNulls: false,
                        showMark: false,
                        disableHighlight: true as const,
                        color: 'transparent',
                        stack: 'confidence',
                        stackOrder: 'ascending' as const,
                        valueFormatter: () => '',
                      } as const,
                    ]
                  : []),
              ]
            : []),
        ]}
        colors={chartColors}
        hideLegend
        margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
        highlightedItem={
          selectedDataIndices.length > 0
            ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndices[0] }
            : controlledHighlightedItem
        }
        onHighlightChange={(item) =>
          onHoverChange(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
        }
        onAxisClick={makeAxisClickHandler(onItemClick)}
        sx={{ cursor: 'default' }}
        slotProps={CHART_LEGEND_SLOT_PROPS}
      >
        {children}
      </LineChart>
    </div>
  );
}
