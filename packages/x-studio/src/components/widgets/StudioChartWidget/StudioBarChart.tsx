'use client';
import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import type { BarChartProps } from '@mui/x-charts/BarChart';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import type { StudioChartConfig, StudioDataSource, StudioExpressionField } from '../../../models';
import type {
  AggregatedData,
  MultiSeriesData,
  MultiYSeriesData,
} from '../../../internals/chartAggregation';
import { sanitizeFiniteNumber } from '../../../internals/cssValueValidation';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';
import {
  alignFilteredToAllLabels,
  buildGhostBarContext,
  CHART_LEGEND_SLOT_PROPS,
  computeControlledHighlight,
  computeStackTotals,
  densifyAggregated,
  densifyMultiSeries,
  densifyMultiY,
  formatPercentAxis,
  formatPercentValue,
  isBarStacked,
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

// Upper bound for `barMinBandSize` (finding: architecture review, Tier 3) — see the sanitization
// block near the top of `StudioBarChart` for why this is needed.
const MAX_BAR_MIN_BAND_SIZE = 500;

type BarHighlightItem = HighlightItemIdentifier<'bar' | 'line' | 'pie'>;

export interface StudioBarChartProps {
  /** One of the three bar variants this component renders. */
  chartType: 'bar' | 'bar-stacked' | 'bar-100';
  height: number;
  /** Resolved bar orientation/stacking (from `config.barLayout ?? 'grouped'`). */
  barLayout: NonNullable<StudioChartConfig['barLayout']>;
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
  barMinBandSize: StudioChartConfig['barMinBandSize'];
  /** Ratio of band width reserved for the gap between categories (band axes only). */
  barCategoryGapRatio: StudioChartConfig['barCategoryGapRatio'];
  /** Axis tick label font size (px) — applied only in the horizontal single-series layout. */
  axisTickFontSize: StudioChartConfig['axisTickFontSize'];
  /** Group all but the top-N categories into an "Other" bar (single-series only). */
  barMaxCategories: StudioChartConfig['barMaxCategories'];
  /** Max characters per band-label line before word-wrapping (0/undefined disables). */
  barBandLabelWrap: StudioChartConfig['barBandLabelWrap'];
  /** Max wrapped band-label lines before ellipsis. @default 2 */
  wrapBandLabelMaxLines: StudioChartConfig['wrapBandLabelMaxLines'];
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
  const localeText = useStudioLocaleText();
  const otherBucketLabel = localeText.chartOtherBucketLabel;

  // Sanitize `barMinBandSize`/`barCategoryGapRatio` — typed as `number` but, unlike every other
  // bar-chart config field, neither has ANY setup-panel UI (no `BarConfigSection.tsx` exists, and
  // nothing in `StudioComposeDrawer` writes these keys), so they're reachable ONLY via
  // `loadSerializedState`/an AI `update_widget`/`apply_bulk_update` tool call — never validated by
  // any UI. `barMinBandSize` feeds `xAxisData.length * barMinBandSize + 40` into a
  // `<div style={{ height }}>` below: a non-finite value collapses the container to a NaN height
  // (silently blanks the chart), and an unbounded one (e.g. `1e9`) inflates it to an enormous
  // layout height with no cap. `barCategoryGapRatio` feeds the x-charts axis `categoryGapRatio`
  // prop directly, whose valid range is `[0, 1)`; an out-of-range or non-finite value produces
  // broken/garbage band geometry. Both are validated here, at the render call site — never just
  // formatted for the height style — mirroring `StudioGaugeChart`'s "guard-and-continue, warn in
  // dev, never throw" `rangeIsValid` pattern.
  const barMinBandSizeIsValid =
    barMinBandSize === undefined ||
    (sanitizeFiniteNumber(barMinBandSize, 1) !== undefined &&
      barMinBandSize <= MAX_BAR_MIN_BAND_SIZE);
  if (!barMinBandSizeIsValid && process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: Bar chart "barMinBandSize" must be a finite number between 1 and ` +
        `${MAX_BAR_MIN_BAND_SIZE} (received ${barMinBandSize}). Ignoring the value.`,
    );
  }
  const safeBarMinBandSize = barMinBandSizeIsValid ? barMinBandSize : undefined;

  const barCategoryGapRatioIsValid =
    barCategoryGapRatio === undefined ||
    (Number.isFinite(barCategoryGapRatio) && barCategoryGapRatio >= 0 && barCategoryGapRatio < 1);
  if (!barCategoryGapRatioIsValid && process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: Bar chart "barCategoryGapRatio" must be a finite number in [0, 1) ` +
        `(received ${barCategoryGapRatio}). Ignoring the value.`,
    );
  }
  const safeBarCategoryGapRatio = barCategoryGapRatioIsValid ? barCategoryGapRatio : undefined;

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
    // — but only when `preserveXFieldBaseline` opts into it (matching every sibling ghost path:
    // multi-Y line/area, single-series bar, single-series line, pie), otherwise the ghost baseline
    // is shown unconditionally regardless of the flag (finding 3).
    const effectiveMultiYData =
      shouldShowGhost && allBarMultiYData && preserveXFieldBaseline
        ? allBarMultiYData
        : barMultiYData;
    const xAxisData = effectiveMultiYData.labels;
    const selectedDataIndices = getSelectedDataIndices(effectiveMultiYData.labels);
    const isStacked = isBarStacked(chartType, barLayout);
    const is100 = chartType === 'bar-100';
    const useIndependentAxes =
      !isHorizontalBarLayout && !isStacked && effectiveMultiYData.series.length > 1;
    const totals100 = is100
      ? computeStackTotals(
          effectiveMultiYData.series.map((ms) => ms.values),
          effectiveMultiYData.labels.length,
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
              ? formatPercentAxis
              : makeValueFormatter(
                  multiYBarFieldDefs[0]?.format,
                  multiYBarFieldDefs[0]?.currencyCode,
                  multiYBarFieldDefs[0]?.precision,
                ),
            ...(is100 && { min: 0, max: 100 }),
          },
        ];

    // Build per-series filtered values (aligned to all-data labels) for ghost context.
    // Deliberately gated ONLY on `shouldShowGhost` (not `preserveXFieldBaseline`) — the
    // within-bar-position ghost overlay is independent of whether the x-axis extent widens to
    // the baseline label set; see the "gated ONLY on shouldShowGhost" invariant test.
    //
    // The bars are rendered against `effectiveMultiYData.labels` — the BASELINE labels when
    // `preserveXFieldBaseline` is true, but the FILTERED labels themselves when it's false (the
    // x-axis intentionally does NOT widen in that case). `CrossFilterGhostBar` looks up both
    // `allValuesBySeriesId` and `filteredValuesBySeriesId` by the rendered bar's `dataIndex`, so
    // BOTH arrays must be aligned to that same `effectiveMultiYData.labels` basis — not
    // unconditionally to `allBarMultiYData.labels`, which only coincides with it when
    // `preserveXFieldBaseline` is true. Passing `allSeries.values` through unaligned (its natural
    // order matches `allBarMultiYData.labels`, not `effectiveMultiYData.labels`) misindexed the
    // ghost baseline/ratio against the rendered bar in a multi-Y chart whenever the two label sets
    // differ in order or membership, e.g. after a cross-filter narrows one label set (Tier 2
    // finding 3). `alignFilteredToAllLabels` re-projects by LABEL (not position), so it's correct
    // even when the two label arrays differ in length or ordering.
    const multiYBarContext =
      shouldShowGhost && allBarMultiYData
        ? buildGhostBarContext(
            effectiveMultiYData.labels,
            barMultiYData.labels,
            allBarMultiYData.series.map((allSeries, i) => ({
              seriesId: `${allSeries.fieldId}-${i}`,
              allValues: alignFilteredToAllLabels(
                effectiveMultiYData.labels,
                allBarMultiYData.labels,
                allSeries.values,
              ),
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
        ? formatPercentValue
        : makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode, fieldDef?.precision);
      const seriesId = `${s.fieldId}-${i}`;
      const rawFilteredValues = multiYFilteredBySeriesId[seriesId];
      // For bar-100 the rendered bar values (and thus the `value` handed to the formatter) are
      // percentages of the per-label stack total, but the ghost context holds RAW filtered
      // aggregates. Normalize the filtered values into the same percent frame before formatting
      // so the "filtered / total" tooltip compares like with like instead of stamping a raw
      // count with a '%' suffix (finding 2.24). The ghost-bar geometry keeps the raw context.
      const filteredValuesForFormatter =
        totals100 && rawFilteredValues
          ? rawFilteredValues.map((fv, li) => {
              if (fv == null) {
                return null;
              }
              const total = totals100[li];
              return total ? (fv / total) * 100 : 0;
            })
          : rawFilteredValues;
      const valueFormatter =
        multiYBarContext && filteredValuesForFormatter
          ? makeCrossFilterValueFormatter(
              filteredValuesForFormatter,
              baseFormatter,
              localeText.chartCrossFilterFilteredOutLabel,
            )
          : baseFormatter;
      return {
        id: seriesId,
        data,
        label: fieldDef?.label ?? s.fieldId,
        stack: isStacked ? 'total' : undefined,
        yAxisId: useIndependentAxes ? `y-${i}` : undefined,
        highlightScope: { highlight: 'item' as const, fade: 'global' as const },
        valueFormatter,
      };
    });
    const multiYEffectiveHeight =
      isHorizontalBarLayout && safeBarMinBandSize
        ? Math.max(height, xAxisData.length * safeBarMinBandSize + 40)
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
                        ? formatPercentAxis
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
                      ...(safeBarCategoryGapRatio !== undefined
                        ? { categoryGapRatio: safeBarCategoryGapRatio }
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
  // When ghost-rendering, use all-data as basis so ghost bars show full extent.
  // Exception: if the incoming cross-filter constrains the same foreign source that
  // owns the split-by field, the baseline series set is misleading and should collapse
  // to the filtered series only.
  //
  // Computed BEFORE the entry guard (rather than only once already inside it) so the guard
  // itself can key off `effectiveSFData` instead of `barSeriesFieldData` alone. A cross-filter
  // that empties every row for this widget makes `barSeriesFieldData.seriesNames` empty even
  // though the split-by field still has categories in the baseline — gating entry on
  // `barSeriesFieldData` alone used to fall through to the single-series prelude below,
  // silently collapsing the chart's per-series structure (colors, legend, individual series
  // identity) into one unsplit "ghost" bar instead of rendering every baseline series fully
  // filtered-out/dimmed (finding 2).
  const effectiveSFData =
    shouldShowGhost && allBarSeriesFieldData && preserveSplitByBaseline
      ? allBarSeriesFieldData
      : barSeriesFieldData;
  if (effectiveSFData && effectiveSFData.seriesNames.length > 0) {
    const xAxisData = effectiveSFData.labels;
    const yFieldDef = resolveFieldDef(activeYFields[0], dataSource, expressionFields);
    const isStacked = isBarStacked(chartType, barLayout);
    const stackId = isStacked ? 'stack' : undefined;
    const is100 = chartType === 'bar-100';
    const totals100 = is100
      ? computeStackTotals(
          effectiveSFData.seriesNames.map((name) => effectiveSFData.seriesData[name]),
          effectiveSFData.labels.length,
        )
      : null;

    // Build per-series filtered values for ghost context. `barSeriesFieldData` can be null here
    // (the cross-filter emptied every row), in which case every series is entirely filtered out —
    // `buildGhostBarContext` already renders that as an all-null filtered column per series when
    // given `filteredValues: null`.
    const sfBarContext =
      shouldShowGhost && allBarSeriesFieldData && preserveSplitByBaseline
        ? buildGhostBarContext(
            allBarSeriesFieldData.labels,
            barSeriesFieldData?.labels ?? [],
            allBarSeriesFieldData.seriesNames.map((name) => ({
              seriesId: String(name),
              allValues: allBarSeriesFieldData.seriesData[name] ?? [],
              filteredValues: barSeriesFieldData?.seriesData[name] ?? null,
            })),
          )
        : null;
    const sfFilteredBySeriesId = sfBarContext?.filteredValuesBySeriesId ?? {};

    const baseSeriesValueFormatter = is100
      ? formatPercentValue
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
      const rawFilteredValues = sfFilteredBySeriesId[seriesId];
      // See the multi-Y path above: for bar-100 normalize the raw filtered aggregates into the
      // same per-label percent frame as the rendered bars so the "filtered / total" tooltip
      // doesn't format a raw value as a percentage (finding 2.24).
      const filteredValuesForFormatter =
        totals100 && rawFilteredValues
          ? rawFilteredValues.map((fv, i) => {
              if (fv == null) {
                return null;
              }
              const total = totals100[i];
              return total ? (fv / total) * 100 : 0;
            })
          : rawFilteredValues;
      const valueFormatter =
        sfBarContext && filteredValuesForFormatter
          ? makeCrossFilterValueFormatter(
              filteredValuesForFormatter,
              baseSeriesValueFormatter,
              localeText.chartCrossFilterFilteredOutLabel,
            )
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
      isHorizontalBarLayout && safeBarMinBandSize
        ? Math.max(height, xAxisData.length * safeBarMinBandSize + 40)
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
                        ? formatPercentAxis
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
                      ...(safeBarCategoryGapRatio !== undefined
                        ? { categoryGapRatio: safeBarCategoryGapRatio }
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
                      ...(safeBarCategoryGapRatio !== undefined
                        ? { categoryGapRatio: safeBarCategoryGapRatio }
                        : {}),
                    },
                  ]
                : [
                    {
                      width: 'auto' as const,
                      valueFormatter: is100
                        ? formatPercentAxis
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
    const existingOtherIdx = topPairs.findIndex((p) => p.label === otherBucketLabel);
    if (existingOtherIdx >= 0) {
      // Real "Other" category already in top-N — merge remainder into it
      const merged = topPairs.map((p, i) =>
        i === existingOtherIdx ? { label: p.label, value: (p.value ?? 0) + otherValue } : p,
      );
      displayXAxisData = merged.map((p) => p.label);
      displayBarValues = merged.map((p) => p.value);
    } else {
      displayXAxisData = [...topPairs.map((p) => p.label), otherBucketLabel];
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
  // Deliberately NOT gated on `chartData` being truthy: a cross-filter that empties every row for
  // this widget makes `chartData` null while `allBarChartData` (the baseline) stays populated —
  // the ghost must still render (fully dimmed, no foreground bar for any label) instead of
  // silently reverting to an undimmed baseline render (Tier 2 finding).
  const ghostActive = Boolean(shouldShowGhost && allBarChartData && preserveXFieldBaseline);
  let singleSeriesFilteredValues: (number | null)[] | null = null;
  if (ghostActive) {
    const filteredValueByLabel = new Map<string, number | null>(
      chartData ? chartData.labels.map((l, i) => [String(l), chartData.values[i]]) : [],
    );
    const keepSet = new Set(
      displayXAxisData
        .filter((l) => !(otherGroupingApplied && String(l) === otherBucketLabel))
        .map((l) => String(l)),
    );
    singleSeriesFilteredValues = displayXAxisData.map((label) => {
      if (otherGroupingApplied && String(label) === otherBucketLabel) {
        let sum = 0;
        for (const [lbl, fv] of filteredValueByLabel) {
          // Exclude the empty-label bucket, matching `nonEmptyBarPairs`'s exclusion above
          // (`label !== null && label !== undefined && label !== ''`) — otherwise this ghost
          // sum can include a filtered value the baseline's `otherValue` never counted,
          // making the "Other" ghost total exceed its own (baseline) bar (finding 3.9).
          if (lbl !== '' && !keepSet.has(lbl)) {
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
      ? makeCrossFilterValueFormatter(
          singleSeriesFilteredValues,
          seriesValueFormatter,
          localeText.chartCrossFilterFilteredOutLabel,
        )
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
  const minBandSize = safeBarMinBandSize;
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
    ...(safeBarCategoryGapRatio !== undefined ? { categoryGapRatio: safeBarCategoryGapRatio } : {}),
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
              (label) => otherGroupingApplied && label === otherBucketLabel,
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
