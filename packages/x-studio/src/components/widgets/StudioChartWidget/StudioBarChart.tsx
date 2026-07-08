'use client';
import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import type { BarChartProps } from '@mui/x-charts/BarChart';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import type { StudioDataSource, StudioExpressionField, StudioWidget } from '../../../models';
import type {
  AggregatedData,
  MultiSeriesData,
  MultiYSeriesData,
} from '../../../internals/chartAggregation';
import {
  buildGhostBarContext,
  CHART_LEGEND_SLOT_PROPS,
  computeControlledHighlight,
  densifyAggregated,
  densifyMultiSeries,
  densifyMultiY,
  makeAxisClickHandler,
  makeCrossFilterValueFormatter,
  makeValueFormatter,
  resolveFieldDef,
} from './chartWidgetHelpers';
import { CrossFilterBarContext } from './CrossFilterBarContext';
import { CrossFilterGhostBar } from './CrossFilterGhostBar';
import { SourceSelectionContext } from './SourceSelectionContext';
import { SourceSelectionBar } from './SourceSelectionBar';
import { AxisFieldTooltip } from './StudioChartFieldTooltip';

const CROSS_FILTER_AXIS_ID = 'cross-filter-axis';
const CROSS_FILTER_SERIES_ID = 'cross-filter-series';

type BarHighlightItem = HighlightItemIdentifier<'bar' | 'line' | 'pie'>;

export interface StudioBarChartProps {
  /** One of the three bar variants this component renders. */
  chartType: 'bar' | 'bar-stacked' | 'bar-100';
  height: number;
  /** Resolved bar orientation/stacking (from `config.barLayout ?? 'grouped'`). */
  barLayout: NonNullable<StudioWidget['config']['barLayout']>;
  /** Filtered single-series aggregation (labels + values). Non-null when the chart is configured. */
  chartData: AggregatedData | null;
  /** Unfiltered single-series aggregation for ghost/cross-highlight; null when not applicable. */
  allChartData: AggregatedData | null;
  /** Filtered split-by (series field) aggregation; drives the per-category bar rendering. */
  seriesFieldData: MultiSeriesData | null;
  /** Unfiltered split-by aggregation — the stable baseline for the split-by ghost bars. */
  allSeriesFieldData: MultiSeriesData | null;
  /** Filtered multi-Y aggregation (one entry per y-field). */
  multiYData: MultiYSeriesData | null;
  /** Unfiltered multi-Y aggregation — the stable baseline for the multi-Y ghost bars. */
  allMultiYData: MultiYSeriesData | null;
  /** Resolved active y-fields — the single-series measure lookup. */
  activeYFields: string[];
  /** Widget data source — used with `expressionFields` to resolve per-series field defs. */
  dataSource?: StudioDataSource;
  /** Computed (expression) fields — the second half of `resolveFieldDef`. */
  expressionFields: StudioExpressionField[];
  /** Format a raw category label for display (applies period labels when x is grouped). */
  formatLabel: (label: string | number) => string;
  /** Localised fallback label for the single measure series. */
  defaultSeriesLabel: string;
  /** Minimum px per band row for horizontal bars (expands the container when set). */
  barMinBandSize: StudioWidget['config']['barMinBandSize'];
  /** Ratio of band width reserved for the gap between categories (band axes only). */
  barCategoryGapRatio: StudioWidget['config']['barCategoryGapRatio'];
  /** Axis tick label font size (px) — applied only in the horizontal single-series layout. */
  axisTickFontSize: StudioWidget['config']['axisTickFontSize'];
  /** Group all but the top-N categories into an "Other" bar (single-series only). */
  barMaxCategories: StudioWidget['config']['barMaxCategories'];
  /** Max characters per band-label line before word-wrapping (0/undefined disables). */
  barBandLabelWrap: StudioWidget['config']['barBandLabelWrap'];
  /** Max wrapped band-label lines before ellipsis. @default 2 */
  wrapBandLabelMaxLines: StudioWidget['config']['wrapBandLabelMaxLines'];
  /** Explicit chart colours (page palette override). */
  chartColors?: string[];
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
  hoveredItem: BarHighlightItem | null;
  /** Current hover axis highlight (set by this or a sibling widget). */
  hoveredAxis: AxisItemIdentifier[] | null;
  /** True when this widget has an active cross-filter on its x-field. */
  hasActiveXFilter: boolean;
  /** True when another widget on the page is emitting a cross-filter to this one. */
  hasIncomingCrossFilters: boolean;
  /** Report a hover change back to the orchestrator's hover state. */
  onHoverChange: (item: BarHighlightItem | null) => void;
  /** Report an axis hover change back to the orchestrator's hover state. */
  onAxisHoverChange: (axis: AxisItemIdentifier[] | null) => void;
  /** Emit a cross-filter for the clicked x-value (regular = single-select, shift = multi-select). */
  onItemClick: (label: string | number | Date, shiftKey: boolean) => void;
  /** Spread onto the underlying BarChart. */
  slotProps?: Partial<BarChartProps>;
  /** Annotation reference lines rendered as chart children. */
  children?: React.ReactNode;
}

/**
 * Renders a bar chart, wrapping the `@mui/x-charts` `BarChart`. Supports a multi-Y mode
 * (one series per y-field with optional independent left/right axes), a split-by (series
 * field) mode (one series per category, stacked), and single-series bars in both vertical
 * and horizontal layouts — all with cross-filter ghost overlays and "Other"-grouping.
 */
export function StudioBarChart({
  chartType,
  height,
  barLayout,
  chartData,
  allChartData,
  seriesFieldData,
  allSeriesFieldData,
  multiYData,
  allMultiYData,
  activeYFields,
  dataSource,
  expressionFields,
  formatLabel,
  defaultSeriesLabel,
  barMinBandSize,
  barCategoryGapRatio,
  axisTickFontSize,
  barMaxCategories,
  barBandLabelWrap,
  wrapBandLabelMaxLines,
  chartColors,
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
}: StudioBarChartProps) {
  const isHorizontalBarLayout = barLayout === 'horizontal';

  // Densified (temporal-gap-filled) bar data. Computed as memos so they only run when a bar
  // chart actually mounts (the orchestrator used to compute these unconditionally for every
  // chart type).
  const barChartData = React.useMemo(
    () => (chartData ? densifyAggregated(chartData) : chartData),
    [chartData],
  );

  const barSeriesFieldData = React.useMemo(
    () => (seriesFieldData ? densifyMultiSeries(seriesFieldData) : seriesFieldData),
    [seriesFieldData],
  );

  const barMultiYData = React.useMemo(
    () => (multiYData ? densifyMultiY(multiYData) : multiYData),
    [multiYData],
  );

  // Densified all-data arrays for ghost rendering (only computed when shouldShowGhost)
  const allBarChartData = React.useMemo(
    () => (shouldShowGhost && allChartData ? densifyAggregated(allChartData) : null),
    [shouldShowGhost, allChartData],
  );

  const allBarSeriesFieldData = React.useMemo(
    () => (shouldShowGhost && allSeriesFieldData ? densifyMultiSeries(allSeriesFieldData) : null),
    [shouldShowGhost, allSeriesFieldData],
  );

  const allBarMultiYData = React.useMemo(
    () => (shouldShowGhost && allMultiYData ? densifyMultiY(allMultiYData) : null),
    [shouldShowGhost, allMultiYData],
  );

  const bandLabelWrap = barBandLabelWrap ?? 0;
  const bandLabelWrapMaxLines = Math.max(1, wrapBandLabelMaxLines ?? 2);
  const wrapBandLabel = React.useCallback(
    (label: string): string => {
      const MAX_LINES = bandLabelWrapMaxLines;
      if (!bandLabelWrap || label.length <= bandLabelWrap) {
        return label;
      }
      const words = label.split(' ');
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        const joined = current ? `${current} ${word}` : word;
        if (current && joined.length > bandLabelWrap) {
          if (lines.length >= MAX_LINES - 1) {
            // Hit line limit — append ellipsis to current line and stop
            lines.push(`${current}…`);
            return lines.join('\n');
          }
          lines.push(current);
          current = word;
        } else {
          current = joined;
        }
      }
      if (current) {
        lines.push(current);
      }
      return lines.join('\n');
    },
    [bandLabelWrap, bandLabelWrapMaxLines],
  );

  // Highlightable series ids: the split-by names, an empty set for multi-Y (multi-Y never feeds
  // hover state back), or the single cross-filter series. Computed locally since this component
  // owns the series shape and gates hover highlighting itself.
  let highlightableSeriesIds: Set<string>;
  if (seriesFieldData && seriesFieldData.seriesNames.length > 0) {
    highlightableSeriesIds = new Set(seriesFieldData.seriesNames.map((name) => String(name)));
  } else if (multiYData && multiYData.labels.length > 0) {
    highlightableSeriesIds = new Set<string>();
  } else {
    highlightableSeriesIds = new Set([CROSS_FILTER_SERIES_ID]);
  }

  const { item: controlledHighlightedItem, axis: controlledHighlightedAxis } =
    computeControlledHighlight(
      hoveredItem,
      hoveredAxis,
      hasActiveXFilter,
      hasIncomingCrossFilters,
      highlightableSeriesIds,
    );

  // ── Multi-Y-field bar chart: each y-field is its own series ──
  if (barMultiYData && barMultiYData.labels.length > 0) {
    // When cross-filtering with ghost, use all-data as the basis so ghost bars show full extent
    const effectiveMultiYData =
      shouldShowGhost && allBarMultiYData ? allBarMultiYData : barMultiYData;
    const xAxisData = effectiveMultiYData.labels;
    const selectedDataIndices = getSelectedDataIndices(effectiveMultiYData.labels);
    const isStacked =
      chartType === 'bar-stacked' ||
      chartType === 'bar-100' ||
      (chartType === 'bar' && barLayout === 'stacked');
    const is100 = chartType === 'bar-100';
    const useIndependentAxes =
      !isHorizontalBarLayout && !isStacked && effectiveMultiYData.series.length > 1;
    const totals100 = is100
      ? effectiveMultiYData.labels.map((_, li) =>
          effectiveMultiYData.series.reduce<number>(
            (sum, ms) => sum + ((ms.values[li] ?? 0) as number),
            0,
          ),
        )
      : null;
    const multiYBarFieldDefs = effectiveMultiYData.series.map((s) =>
      resolveFieldDef(s.fieldId, dataSource, expressionFields),
    );
    const yAxes = useIndependentAxes
      ? effectiveMultiYData.series.map((_s, i) => ({
          id: `y-${i}`,
          position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
          width: 'auto' as const,
          valueFormatter: makeValueFormatter(
            multiYBarFieldDefs[i]?.format,
            multiYBarFieldDefs[i]?.currencyCode,
            multiYBarFieldDefs[i]?.precision,
          ),
        }))
      : [
          {
            width: 'auto' as const,
            valueFormatter: is100
              ? (v: number) => `${Math.round(v)}%`
              : makeValueFormatter(
                  multiYBarFieldDefs[0]?.format,
                  multiYBarFieldDefs[0]?.currencyCode,
                  multiYBarFieldDefs[0]?.precision,
                ),
            ...(is100 && { min: 0, max: 100 }),
          },
        ];

    // Build per-series filtered values (aligned to all-data labels) for ghost context
    const multiYBarContext =
      shouldShowGhost && allBarMultiYData
        ? buildGhostBarContext(
            allBarMultiYData.labels,
            barMultiYData.labels,
            allBarMultiYData.series.map((allSeries, i) => ({
              seriesId: `${allSeries.fieldId}-${i}`,
              allValues: allSeries.values,
              filteredValues: barMultiYData.series[i]?.values ?? null,
            })),
          )
        : null;
    const multiYFilteredBySeriesId = multiYBarContext?.filteredValuesBySeriesId ?? {};

    const series = effectiveMultiYData.series.map((s, i) => {
      const fieldDef = resolveFieldDef(s.fieldId, dataSource, expressionFields);
      const data = totals100
        ? s.values.map((v, li) => {
            const total = totals100[li];
            return total ? ((v ?? 0) / total) * 100 : 0;
          })
        : s.values;
      const baseFormatter = is100
        ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
        : makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode, fieldDef?.precision);
      const seriesId = `${s.fieldId}-${i}`;
      const valueFormatter =
        multiYBarContext && multiYFilteredBySeriesId[seriesId]
          ? makeCrossFilterValueFormatter(multiYFilteredBySeriesId[seriesId], baseFormatter)
          : baseFormatter;
      return {
        id: seriesId,
        data,
        label: fieldDef?.label ?? s.fieldId,
        stack: isStacked ? 'total' : undefined,
        yAxisKey: useIndependentAxes ? `y-${i}` : undefined,
        highlightScope: { highlight: 'item' as const, fade: 'global' as const },
        valueFormatter,
      };
    });
    const multiYEffectiveHeight =
      isHorizontalBarLayout && barMinBandSize
        ? Math.max(height, xAxisData.length * barMinBandSize + 40)
        : height;
    return (
      <CrossFilterBarContext.Provider value={multiYBarContext}>
        <div style={{ height: multiYEffectiveHeight }}>
          <BarChart
            {...slotProps}
            skipAnimation={skipAnimation}
            layout={isHorizontalBarLayout ? 'horizontal' : undefined}
            xAxis={
              isHorizontalBarLayout
                ? [
                    {
                      height: 'auto',
                      valueFormatter: is100
                        ? (v: number) => `${Math.round(v)}%`
                        : makeValueFormatter(
                            multiYBarFieldDefs[0]?.format,
                            multiYBarFieldDefs[0]?.currencyCode,
                            multiYBarFieldDefs[0]?.precision,
                          ),
                      ...(is100 && { min: 0, max: 100 }),
                      ...(axisTickFontSize !== undefined
                        ? { tickLabelStyle: { fontSize: `${axisTickFontSize}px` } }
                        : {}),
                    },
                  ]
                : [
                    {
                      id: CROSS_FILTER_AXIS_ID,
                      data: xAxisData,
                      scaleType: 'band',
                      height: 'auto',
                      valueFormatter: (v: string | number) => wrapBandLabel(formatLabel(String(v))),
                    },
                  ]
            }
            yAxis={
              isHorizontalBarLayout
                ? [
                    {
                      id: CROSS_FILTER_AXIS_ID,
                      data: xAxisData,
                      scaleType: 'band',
                      width: 'auto',
                      valueFormatter: (v: string | number) => wrapBandLabel(formatLabel(String(v))),
                      ...(axisTickFontSize !== undefined
                        ? { tickLabelStyle: { fontSize: `${axisTickFontSize}px` } }
                        : {}),
                      ...(barCategoryGapRatio !== undefined
                        ? { categoryGapRatio: barCategoryGapRatio }
                        : {}),
                    },
                  ]
                : yAxes
            }
            series={series}
            colors={chartColors}
            margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
            highlightedItem={null}
            highlightedAxis={
              selectedDataIndices.length > 0
                ? selectedDataIndices.map((i) => ({ axisId: CROSS_FILTER_AXIS_ID, dataIndex: i }))
                : controlledHighlightedAxis
            }
            onHighlightedAxisChange={onAxisHoverChange}
            onAxisClick={makeAxisClickHandler(onItemClick)}
            sx={{ cursor: 'default' }}
            slots={multiYBarContext ? { bar: CrossFilterGhostBar } : undefined}
            slotProps={CHART_LEGEND_SLOT_PROPS}
          >
            {children}
          </BarChart>
        </div>
      </CrossFilterBarContext.Provider>
    );
  }

  // ── seriesField stacked/grouped bar chart: one series per unique category value ──
  if (barSeriesFieldData && barSeriesFieldData.seriesNames.length > 0) {
    // When ghost-rendering, use all-data as basis so ghost bars show full extent.
    // Exception: if the incoming cross-filter constrains the same foreign source that
    // owns the split-by field, the baseline series set is misleading and should collapse
    // to the filtered series only.
    const effectiveSFData =
      shouldShowGhost && allBarSeriesFieldData && preserveSplitByBaseline
        ? allBarSeriesFieldData
        : barSeriesFieldData;
    const xAxisData = effectiveSFData.labels;
    const yFieldDef = resolveFieldDef(activeYFields[0], dataSource, expressionFields);
    const isStacked =
      chartType === 'bar-stacked' ||
      chartType === 'bar-100' ||
      (chartType === 'bar' && barLayout === 'stacked');
    const stackId = isStacked ? 'stack' : undefined;
    const is100 = chartType === 'bar-100';
    const totals100 = is100
      ? effectiveSFData.labels.map((_, i) =>
          effectiveSFData.seriesNames.reduce<number>(
            (sum, name) => sum + ((effectiveSFData.seriesData[name][i] ?? 0) as number),
            0,
          ),
        )
      : null;

    // Build per-series filtered values for ghost context
    const sfBarContext =
      shouldShowGhost && allBarSeriesFieldData && preserveSplitByBaseline
        ? buildGhostBarContext(
            allBarSeriesFieldData.labels,
            barSeriesFieldData.labels,
            allBarSeriesFieldData.seriesNames.map((name) => ({
              seriesId: String(name),
              allValues: allBarSeriesFieldData.seriesData[name] ?? [],
              filteredValues: barSeriesFieldData.seriesData[name] ?? null,
            })),
          )
        : null;
    const sfFilteredBySeriesId = sfBarContext?.filteredValuesBySeriesId ?? {};

    const baseSeriesValueFormatter = is100
      ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
      : makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode, yFieldDef?.precision);

    const series = effectiveSFData.seriesNames.map((name) => {
      const rawData = effectiveSFData.seriesData[name];
      const stackedOrRaw = isStacked ? rawData.map((v) => v ?? 0) : rawData;
      const data: (number | null)[] = totals100
        ? rawData.map((v, i) => {
            const total = totals100[i];
            return total ? ((v ?? 0) / total) * 100 : 0;
          })
        : stackedOrRaw;
      const seriesId = String(name);
      const valueFormatter =
        sfBarContext && sfFilteredBySeriesId[seriesId]
          ? makeCrossFilterValueFormatter(sfFilteredBySeriesId[seriesId], baseSeriesValueFormatter)
          : baseSeriesValueFormatter;
      return {
        id: seriesId,
        data,
        label: seriesId,
        stack: stackId,
        color: getSeriesColor(name),
        valueFormatter,
      };
    });
    const selectedDataIndices = getSelectedDataIndices(effectiveSFData.labels);
    const effectiveSFBarHeight =
      isHorizontalBarLayout && barMinBandSize
        ? Math.max(height, xAxisData.length * barMinBandSize + 40)
        : height;
    return (
      <CrossFilterBarContext.Provider value={sfBarContext}>
        <div style={{ height: effectiveSFBarHeight }}>
          <BarChart
            {...slotProps}
            skipAnimation={skipAnimation}
            layout={isHorizontalBarLayout ? 'horizontal' : undefined}
            xAxis={
              isHorizontalBarLayout
                ? [
                    {
                      height: 'auto',
                      valueFormatter: is100
                        ? (v: number) => `${Math.round(v)}%`
                        : makeValueFormatter(
                            yFieldDef?.format,
                            yFieldDef?.currencyCode,
                            yFieldDef?.precision,
                          ),
                      ...(is100 && { min: 0, max: 100 }),
                      ...(axisTickFontSize !== undefined
                        ? { tickLabelStyle: { fontSize: `${axisTickFontSize}px` } }
                        : {}),
                    },
                  ]
                : [
                    {
                      id: CROSS_FILTER_AXIS_ID,
                      data: xAxisData,
                      scaleType: 'band',
                      height: 'auto',
                      valueFormatter: (v: string | number) => wrapBandLabel(formatLabel(String(v))),
                      ...(barCategoryGapRatio !== undefined
                        ? { categoryGapRatio: barCategoryGapRatio }
                        : {}),
                    },
                  ]
            }
            yAxis={
              isHorizontalBarLayout
                ? [
                    {
                      id: CROSS_FILTER_AXIS_ID,
                      data: xAxisData,
                      scaleType: 'band',
                      width: 'auto',
                      valueFormatter: (v: string | number) => wrapBandLabel(formatLabel(String(v))),
                      ...(axisTickFontSize !== undefined
                        ? { tickLabelStyle: { fontSize: `${axisTickFontSize}px` } }
                        : {}),
                      ...(barCategoryGapRatio !== undefined
                        ? { categoryGapRatio: barCategoryGapRatio }
                        : {}),
                    },
                  ]
                : [
                    {
                      width: 'auto' as const,
                      valueFormatter: is100
                        ? (v: number) => `${Math.round(v)}%`
                        : makeValueFormatter(
                            yFieldDef?.format,
                            yFieldDef?.currencyCode,
                            yFieldDef?.precision,
                          ),
                      ...(is100 && { min: 0, max: 100 }),
                    },
                  ]
            }
            series={series}
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
            slots={sfBarContext ? { bar: CrossFilterGhostBar } : undefined}
            slotProps={CHART_LEGEND_SLOT_PROPS}
          >
            {children}
          </BarChart>
        </div>
      </CrossFilterBarContext.Provider>
    );
  }

  // ── Single-series bar prelude ──
  // For single-series charts, when ghost-rendering use all-data as basis
  const singleSeriesChartData = barChartData;
  const effectiveSingleSeriesData =
    shouldShowGhost && allBarChartData && preserveXFieldBaseline
      ? allBarChartData
      : singleSeriesChartData;
  const xAxisData = effectiveSingleSeriesData!.labels;
  const yFieldDef = resolveFieldDef(activeYFields[0], dataSource, expressionFields);
  const seriesLabel = yFieldDef?.label ?? activeYFields[0] ?? defaultSeriesLabel;
  const seriesValueFormatter = makeValueFormatter(
    yFieldDef?.format,
    yFieldDef?.currencyCode,
    yFieldDef?.precision,
  );

  // Apply the display transform (empty-label filter + top-N "Other" grouping) FIRST, so the
  // selection, ghost-context and highlight computations below all align to the RENDERED
  // (display) order rather than the pre-transform label order.
  const barMaxCats = barMaxCategories ?? undefined;
  // Filter out empty x-axis values before applying max-categories grouping
  const nonEmptyBarPairs = xAxisData.reduce<{ label: string | number; value: number | null }[]>(
    (acc, label, i) => {
      if (label !== null && label !== undefined && label !== '') {
        acc.push({ label, value: (effectiveSingleSeriesData?.values[i] ?? null) as number | null });
      }
      return acc;
    },
    [],
  );
  let displayXAxisData: (string | number)[] = nonEmptyBarPairs.map((p) => p.label);
  let displayBarValues: (number | null)[] = nonEmptyBarPairs.map((p) => p.value);
  // True once the "Other" entry is a grouping bucket (an appended synthetic bucket, or a real
  // "Other" category that also absorbed the folded remainder). Used both to align the ghost
  // "Other" value and to guard clicks on the synthetic bucket.
  let otherGroupingApplied = false;
  if (barMaxCats && displayXAxisData.length > barMaxCats) {
    const topN = barMaxCats - 1;
    // Group by VALUE (largest categories kept, smallest folded into "Other"), matching the
    // pie's top-N behavior — not by axis position. Sort a copy so the original order of the
    // (possibly densified) input is left untouched.
    const sortedPairs = [...nonEmptyBarPairs].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const topPairs = sortedPairs.slice(0, topN);
    const otherValue = sortedPairs.slice(topN).reduce<number>((sum, p) => sum + (p.value ?? 0), 0);
    const existingOtherIdx = topPairs.findIndex((p) => p.label === 'Other');
    if (existingOtherIdx >= 0) {
      // Real "Other" category already in top-N — merge remainder into it
      const merged = topPairs.map((p, i) =>
        i === existingOtherIdx ? { label: p.label, value: (p.value ?? 0) + otherValue } : p,
      );
      displayXAxisData = merged.map((p) => p.label);
      displayBarValues = merged.map((p) => p.value);
    } else {
      displayXAxisData = [...topPairs.map((p) => p.label), 'Other'];
      displayBarValues = [...topPairs.map((p) => p.value), otherValue];
    }
    otherGroupingApplied = true;
  }

  // Selection is computed against the RENDERED (display) label order: a folded-away selected
  // label simply yields no index (getSelectedDataIndices matches by label), and a kept label
  // highlights the correct rendered bar.
  const selectedDataIndices = getSelectedDataIndices(displayXAxisData);
  const sourceSelectionCtxValue =
    // eslint-disable-next-line react/jsx-no-constructed-context-values
    selectedDataIndices.length > 1 ? new Set(selectedDataIndices) : null;

  // Filtered values for the ghost bar context, aligned to the display order. The synthetic
  // "Other" bucket sums the filtered values of every folded-away label (mirroring the display
  // baseline), while kept labels absent from the filtered set stay null → "(filtered out)".
  const ghostActive = Boolean(
    shouldShowGhost && allBarChartData && chartData && preserveXFieldBaseline,
  );
  let singleSeriesFilteredValues: (number | null)[] | null = null;
  if (ghostActive && chartData) {
    const filteredValueByLabel = new Map<string, number | null>(
      chartData.labels.map((l, i) => [String(l), chartData.values[i]]),
    );
    const keepSet = new Set(
      displayXAxisData
        .filter((l) => !(otherGroupingApplied && String(l) === 'Other'))
        .map((l) => String(l)),
    );
    singleSeriesFilteredValues = displayXAxisData.map((label) => {
      if (otherGroupingApplied && String(label) === 'Other') {
        let sum = 0;
        for (const [lbl, fv] of filteredValueByLabel) {
          if (!keepSet.has(lbl)) {
            sum += fv ?? 0;
          }
        }
        return sum;
      }
      return filteredValueByLabel.get(String(label)) ?? null;
    });
  }
  const singleBarContext = singleSeriesFilteredValues
    ? // eslint-disable-next-line react/jsx-no-constructed-context-values
      {
        filteredValuesBySeriesId: {
          [CROSS_FILTER_SERIES_ID]: singleSeriesFilteredValues,
        },
        allValuesBySeriesId: {
          [CROSS_FILTER_SERIES_ID]: displayBarValues.map((v) => v ?? 0),
        },
      }
    : null;
  const singleSeriesVF =
    singleBarContext && singleSeriesFilteredValues
      ? makeCrossFilterValueFormatter(singleSeriesFilteredValues, seriesValueFormatter)
      : seriesValueFormatter;
  // Bar slots: a field-titled tooltip (question as title, category as the labelled row) plus a
  // bar slot — ghost-target rendering wins; otherwise multi-select source dimming; else default.
  const singleBarSlots: {
    tooltip: typeof AxisFieldTooltip;
    bar?: typeof CrossFilterGhostBar | typeof SourceSelectionBar;
  } = { tooltip: AxisFieldTooltip };
  if (singleBarContext) {
    singleBarSlots.bar = CrossFilterGhostBar;
  } else if (selectedDataIndices.length > 1) {
    singleBarSlots.bar = SourceSelectionBar;
  }
  // MUI item highlight for single-series bars: a lone selection highlights that bar; multi-select
  // (>1) is handled by SourceSelectionBar so no item highlight; no selection falls back to hover.
  let singleBarHighlightedItem = controlledHighlightedItem;
  if (selectedDataIndices.length === 1) {
    singleBarHighlightedItem = {
      seriesId: CROSS_FILTER_SERIES_ID,
      dataIndex: selectedDataIndices[0],
    };
  } else if (selectedDataIndices.length > 1) {
    singleBarHighlightedItem = null;
  }

  // Default single-series bar — vertical and horizontal share one render, differing only in
  // axis orientation, axisTickFontSize application (horizontal only — invariant 2), the band
  // axis width, container height, and margin.right (40 horizontal / 16 vertical — invariant 3).
  const isHorizontal = isHorizontalBarLayout;

  // When barMinBandSize is set, expand the container so every row gets at least that many px.
  const minBandSize = barMinBandSize;
  const effectiveHBarHeight =
    isHorizontal && minBandSize
      ? Math.max(height, displayXAxisData.length * minBandSize + 40)
      : height;

  // When bandLabelWrap splits labels across multiple lines, 'auto' only measures the first SVG
  // tspan and produces a width too narrow for longer subsequent lines. Compute an explicit pixel
  // width (horizontal only) from the longest single line across all formatted+wrapped labels.
  const longestHBarLabelLine = isHorizontal
    ? displayXAxisData.reduce((max: number, v) => {
        const wrapped = wrapBandLabel(formatLabel(String(v)));
        const lineMax = wrapped.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
        return Math.max(max, lineMax);
      }, 0)
    : 0;
  const hBarYAxisWidth = Math.min(Math.max(longestHBarLabelLine * 6.5 + 12, 60), 320);

  // Band (category) axis config, shared across orientations. The orientation-specific dimension
  // (height when it lands on x, width when it lands on y) is added at the axis slot below so the
  // object stays assignable to both the X- and Y-axis config types. barCategoryGapRatio applies
  // to both orientations; axisTickFontSize applies ONLY when horizontal (invariant 2).
  const singleBandAxis = {
    id: CROSS_FILTER_AXIS_ID,
    data: displayXAxisData,
    scaleType: 'band' as const,
    valueFormatter: (v: string | number) => wrapBandLabel(formatLabel(String(v))),
    ...(isHorizontal && axisTickFontSize !== undefined
      ? { tickLabelStyle: { fontSize: `${axisTickFontSize}px` } }
      : {}),
    ...(barCategoryGapRatio !== undefined ? { categoryGapRatio: barCategoryGapRatio } : {}),
  };

  // Value (measure) axis config, shared across orientations (dimension added at the slot below).
  // axisTickFontSize applies ONLY when horizontal (invariant 2); vertical never reads it.
  const singleValueAxis = {
    valueFormatter: seriesValueFormatter,
    ...(isHorizontal && axisTickFontSize !== undefined
      ? { tickLabelStyle: { fontSize: `${axisTickFontSize}px` } }
      : {}),
  };

  return (
    <SourceSelectionContext.Provider value={sourceSelectionCtxValue}>
      <CrossFilterBarContext.Provider value={singleBarContext}>
        <div style={{ height: effectiveHBarHeight }}>
          <BarChart
            {...slotProps}
            skipAnimation={skipAnimation}
            layout={isHorizontal ? 'horizontal' : undefined}
            // The x-axis is always sized with height:'auto' (value axis when horizontal, band axis
            // when vertical). The y-axis carries the band width when horizontal (the explicit
            // computed hBarYAxisWidth) or the value axis width:'auto' when vertical.
            xAxis={[
              isHorizontal
                ? { ...singleValueAxis, height: 'auto' as const }
                : { ...singleBandAxis, height: 'auto' as const },
            ]}
            yAxis={[
              isHorizontal
                ? { ...singleBandAxis, width: hBarYAxisWidth }
                : { ...singleValueAxis, width: 'auto' as const },
            ]}
            series={[
              {
                id: CROSS_FILTER_SERIES_ID,
                data: displayBarValues,
                label: seriesLabel,
                highlightScope: { highlight: 'item', fade: 'global' },
                valueFormatter: singleSeriesVF,
              },
            ]}
            colors={chartColors}
            hideLegend
            // margin.right: 40 horizontal, 16 vertical (invariant 3).
            margin={{ top: 16, right: isHorizontal ? 40 : 16, bottom: 8, left: 8 }}
            highlightedItem={singleBarHighlightedItem}
            onHighlightChange={(item) =>
              onHoverChange(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
            }
            // The synthetic "Other" bucket has no single underlying category value, so a
            // cross-filter on it would match nothing — ignore the click. A real "Other"
            // category (no grouping active) still cross-filters normally.
            onAxisClick={makeAxisClickHandler(
              onItemClick,
              (label) => otherGroupingApplied && label === 'Other',
            )}
            sx={{ cursor: 'default' }}
            slots={singleBarSlots}
            slotProps={CHART_LEGEND_SLOT_PROPS}
          >
            {children}
          </BarChart>
        </div>
      </CrossFilterBarContext.Provider>
    </SourceSelectionContext.Provider>
  );
}
