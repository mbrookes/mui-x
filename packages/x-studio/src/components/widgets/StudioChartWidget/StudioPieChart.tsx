'use client';
import * as React from 'react';
import { PieChart, PieArc } from '@mui/x-charts/PieChart';
import type { PieChartProps, PieArcProps } from '@mui/x-charts/PieChart';
import type { HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box, useTheme } from '@mui/material';
import { aggregateByField } from '../../../internals/chartAggregation';
import type { AggregatedData } from '../../../internals/chartAggregation';
import { applyXGroupBy, isEmptyXValue, toXValue } from '../../../internals/chartValues';
import { formatPercent } from '../../../internals/numberFormat';
import { sortLabels } from '../../../internals/temporalUtils';
import type { StudioChartConfig } from '../../../models';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';
import { computeControlledHighlight } from './chartWidgetHelpers';
import { PieHighlightContext } from './PieCrossHighlightContext';
import { PIE_HIGHLIGHT_SLOTS } from './PieCrossHighlightSlots';
import { ChartFieldTitleContext, ItemFieldTooltip } from './StudioChartFieldTooltip';
import {
  buildChartDescription,
  chartKeyboardActivationProps,
  ChartFocusTracker,
  CHART_KEYBOARD_NAV_PROPS,
  useChartFocusRef,
} from './chartA11y';

const CROSS_FILTER_SERIES_ID = 'cross-filter-series';

/**
 * Rendered wherever a category's aggregate is `null` — "nothing was measured for this
 * category", which is a different fact from a measured 0. Same glyph the pivot table's empty
 * cells use, so one dashboard reads consistently.
 */
const NO_VALUE_LABEL = '—';

/**
 * Dimming state for the grouped concentric-ring pie's slices, keyed by
 * `${seriesId}:${dataIndex}` (a plain per-slice boolean isn't expressible via
 * `PieValueType` — it only supports `id`/`value`/`label`/`color` — so, mirroring how
 * `CrossHighlightPieArc` threads its ratio map through `PieHighlightContext` rather
 * than baking it into `color`, dimming state is threaded through context to a custom
 * `pieArc` slot instead).
 */
export const PieRingDimContext = React.createContext<Map<string, boolean> | null>(null);

/**
 * Ring-pie arc renderer: dims via `fill-opacity` (like `CrossHighlightPieArc`) rather
 * than suffixing the slice's `color` with a hex alpha byte (`${color}40`), which
 * silently renders fully opaque — losing the dim entirely — whenever a host supplies a
 * non-hex color (a CSS variable, `rgb(...)`, `hsl(...)`, …) via `chartColors` or
 * `theme.components.MuiPieChart.defaultProps.colors`.
 *
 * Exported (like the sibling `CrossHighlightPieArc`) so it can be unit-tested directly
 * against a mocked `PieArc` — see `RingDimmedPieArc.test.tsx`.
 */
export function RingDimmedPieArc(props: PieArcProps) {
  const { seriesId, dataIndex } = props;
  const dimMap = React.useContext(PieRingDimContext);
  const isDimmed = dimMap?.get(`${seriesId}:${dataIndex}`) ?? false;
  return (
    <g style={{ fillOpacity: isDimmed ? 0.25 : 1 }}>
      <PieArc {...props} />
    </g>
  );
}

const RING_PIE_SLOTS = { pieArc: RingDimmedPieArc } as const;

function EmptyLegend() {
  return null;
}
// Pie/donut slots: cross-highlight arc + a field-titled tooltip (question as title, slice
// as the labelled row). The "no legend" variant also suppresses the built-in legend.
const PIE_FIELD_SLOTS = { ...PIE_HIGHLIGHT_SLOTS, tooltip: ItemFieldTooltip } as const;
const PIE_HIGHLIGHT_SLOTS_NO_LEGEND = {
  ...PIE_HIGHLIGHT_SLOTS,
  legend: EmptyLegend,
  tooltip: ItemFieldTooltip,
} as const;

type PieHighlightItem = HighlightItemIdentifier<'bar' | 'line' | 'pie'>;

export interface StudioPieChartProps {
  /** 'pie' draws full slices; 'donut' adds a centre hole. */
  chartType: 'pie' | 'donut';
  height: number;
  /**
   * Filtered single-series aggregation (labels + values). Non-empty whenever
   * `shouldShowGhost && allChartData && preserveXFieldBaseline` is false (guaranteed by the
   * caller); null (with a non-null `allChartData`) is only reachable when that ghost gate is
   * true, in which case `pieBaseData` below ignores this in favor of `allChartData`.
   */
  chartData: AggregatedData | null;
  /** Unfiltered single-series aggregation for ghost/cross-highlight; null when not applicable. */
  allChartData: AggregatedData | null;
  /** Enriched (filtered) rows — used to build grouped concentric rings when a series field is set. */
  enrichedRows: Record<string, unknown>[];
  /** Unfiltered enriched rows — the stable baseline for grouped rings so cross-filters dim rather than remove slices. */
  allEnrichedRows: Record<string, unknown>[];
  /** Categorical split field id → enables the grouped concentric-ring rendering. */
  seriesField?: string;
  /** x-axis category field id (grouped rings). */
  xField?: string;
  /** y measure field id (grouped rings aggregation). */
  yField?: string;
  /** Resolved active y-fields — fallback measure for the ring aggregation. */
  activeYFields: string[];
  /** Configured measure aggregation for the grouped-ring slices (mirrors the primary ring). */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /** Period grouping applied to the ring category (xField) — mirrors the primary ring. */
  xGroupBy?: StudioChartConfig['xGroupBy'];
  /** Place the legend below the chart with a custom percentage legend instead of the built-in one. */
  pieLegendBelow: boolean;
  /** Arc label mode: formatted value, percent of total, or none. */
  pieArcLabel?: 'value' | 'percent' | 'none';
  /** Minimum arc angle (degrees) required to show an arc label. @default 20 */
  pieArcLabelMinAngle?: number;
  /** Group all but the top-N slices into an "Other" bucket. */
  pieMaxSlices?: number;
  /** Explicit chart colours (page palette override). */
  chartColors?: string[];
  /** Always-resolved palette for stable slice colours. */
  resolvedChartColors: string[];
  /** True when cross-filter ghost rendering is active on this widget. */
  shouldShowGhost: boolean;
  /** False when the x-field is foreign-derived and constrained by an incoming cross-filter. */
  preserveXFieldBaseline: boolean;
  skipAnimation: boolean;
  /** Value formatter for the pie measure (built from the y-field def by the orchestrator). */
  valueFormatter: (value: number | null) => string;
  /** Human label of the pie measure field (tooltip title). */
  fieldLabel?: string;
  /** Format a raw category label for display (applies period labels when x is grouped). */
  formatLabel: (label: string | number) => string;
  /** Compute the cross-filter-selected indices against a rendered label order. */
  getSelectedDataIndices: (labels: Array<string | number | Date>) => number[];
  /** Current hover highlight (set by this or a sibling widget). */
  hoveredItem: PieHighlightItem | null;
  /** True when this widget has an active cross-filter on its x-field. */
  hasActiveXFilter: boolean;
  /** True when another widget on the page is emitting a cross-filter to this one. */
  hasIncomingCrossFilters: boolean;
  /** Report a hover change back to the orchestrator's hover state. */
  onHoverChange: (item: PieHighlightItem | null) => void;
  /** Emit a cross-filter for the clicked slice (regular = single-select, shift = multi-select). */
  onItemClick: (label: string | number | Date, shiftKey: boolean) => void;
  /**
   * Accessible name for the chart graphic — forwarded to the `PieChart`'s `title` prop, which
   * becomes the chart container's `aria-label` (WCAG 1.1.1 / 4.1.2, finding M10).
   */
  ariaTitle?: string;
  /** Spread onto the underlying PieChart. */
  slotProps?: Partial<PieChartProps>;
}

/**
 * Renders a pie or donut chart, wrapping the `@mui/x-charts` `PieChart`. Supports an
 * optional grouped concentric-ring mode (one ring per x-category, sliced by a series
 * field), "Other"-grouping of small slices, arc labels, an optional custom below-chart
 * legend, and cross-filter ghost/overlay highlighting via `PieHighlightContext`.
 */
export function StudioPieChart({
  chartType,
  height,
  chartData,
  allChartData,
  enrichedRows,
  allEnrichedRows,
  seriesField,
  xField,
  yField,
  activeYFields,
  yAggregation,
  xGroupBy,
  pieLegendBelow,
  pieArcLabel,
  pieArcLabelMinAngle,
  pieMaxSlices,
  chartColors,
  resolvedChartColors,
  shouldShowGhost,
  preserveXFieldBaseline,
  skipAnimation,
  valueFormatter,
  fieldLabel,
  formatLabel,
  getSelectedDataIndices,
  hoveredItem,
  hasActiveXFilter,
  hasIncomingCrossFilters,
  onHoverChange,
  onItemClick,
  ariaTitle,
  slotProps,
}: StudioPieChartProps) {
  const theme = useTheme();
  const localeText = useStudioLocaleText();
  const otherBucketLabel = localeText.chartOtherBucketLabel;
  // Allocated unconditionally (rules of hooks) — shared by the ring and single-series paths.
  const chartFocusRef = useChartFocusRef();

  // Resolve the colour palette shared by the single-series arcs, the custom legend, AND the
  // grouped concentric rings so they always agree. Priority: explicit chartColors > theme
  // MuiPieChart default props > resolvedChartColors (blueberryTwilightPalette fallback).
  // Hoisted above the ring branch so the ring path can reconcile its slice/dim colours the
  // same way the single-ring path does.
  const themeDefaultPieColors = (
    theme.components as
      | Record<string, { defaultProps?: { colors?: string[] } } | undefined>
      | undefined
  )?.MuiPieChart?.defaultProps?.colors;
  const pieColors: string[] = chartColors ?? themeDefaultPieColors ?? resolvedChartColors;

  // Pre-compute grouped-ring pie data: one ring per xField category, each ring
  // divided into slices by seriesField — like grouped bars but as concentric rings.
  const twoRingData = React.useMemo(() => {
    // Whether the unfiltered baseline is usable as a stand-in when this widget's own filtered
    // rows are empty — computed up front (rather than only where `baseRows` is chosen below) so
    // the entry guard can gate on it too. A sibling widget's cross-filter can empty
    // `enrichedRows` entirely while `allEnrichedRows` still has rows for every category; gating
    // entry on `enrichedRows.length === 0` alone used to bail out of the ring branch
    // in that case, collapsing an N-series ring chart into the single-ring aggregate-total path
    // below instead of rendering every baseline ring dimmed. Mirrors `StudioBarChart`'s
    // `effectiveSFData` pattern.
    const canUseGhostBaseline =
      shouldShowGhost && allEnrichedRows.length > 0 && preserveXFieldBaseline;
    if (!seriesField || !xField || (enrichedRows.length === 0 && !canUseGhostBaseline)) {
      return null;
    }
    const sliceField = seriesField;
    const ringYField = yField ?? activeYFields[0] ?? '';
    // Mirror the primary ring's aggregation (built by `useChartWidgetData`'s `aggregateByField`):
    // use the configured measure aggregation instead of a hardcoded 'sum', and period-group the
    // ring categories by `xGroupBy` (so a temporal xField groups by day/week/month/… like the
    // single-ring pie) rather than treating every raw x value as its own ring.
    const ringAggregation = yAggregation ?? 'sum';
    const categoryKeyOf = (r: Record<string, unknown>): string | null => {
      const rawX = r[xField];
      if (isEmptyXValue(rawX)) {
        return null;
      }
      return String(applyXGroupBy(toXValue(rawX, localeText), xGroupBy));
    };

    // Finding 1.1: use the properly filtered rows (which honor interactive filter-widget
    // selections AND `crossFilterMode: 'filter'` cross-filters) as the base by default —
    // mirroring the single-ring path's `pieBaseData = isPieHighlightActive ? allChartData : chartData`.
    // Only fall back to the unfiltered baseline (`allEnrichedRows`) — rendering every slice and
    // *dimming* the filtered-out ones — when a chart-click cross-highlight ghost is genuinely
    // active. `shouldShowGhost` is true ONLY for chart-click cross-filters in 'cross-highlight'
    // mode, so hard filters (which every other widget applies) now filter the rings too.
    // Also gated on `preserveXFieldBaseline`, mirroring the single-ring path's
    // `isPieHighlightActive` (~line 368) — otherwise the grouped-ring ghost baseline would show
    // regardless of the flag. Same condition as `canUseGhostBaseline` above (reused,
    // not recomputed, to keep the entry guard and the baseline choice below in lockstep).
    const useGhostBaseline = canUseGhostBaseline;
    const baseRows = useGhostBaseline ? allEnrichedRows : enrichedRows;

    // Get unique category values (period-grouped xField), sorted like the single-ring path
    // (`aggregateByField` → `sortLabels`) rather than left in first-seen row order — otherwise
    // temporal rings render in arbitrary chronological order, and the order can visibly swap
    // when the baseline flips between `allEnrichedRows`/`enrichedRows`.
    const categories = sortLabels(
      [...new Set(baseRows.map(categoryKeyOf))].filter((c): c is string => c != null),
    ) as string[];

    // For each category, aggregate by sliceField within that category's rows.
    let rings = categories.map((category) => {
      const catRows = baseRows.filter((r) => categoryKeyOf(r) === category);
      const agg = aggregateByField(
        catRows,
        sliceField,
        ringYField,
        undefined,
        ringAggregation,
        undefined,
        undefined,
        undefined,
        localeText,
      );
      return { id: `ring-${category}`, label: category, slices: agg };
    });

    // Finding 1.3: "Other"-group the split-by categories GLOBALLY across all rings (keeping the
    // top `pieMaxSlices - 1` categories by total value), so the kept category set — and therefore
    // the category→colour mapping — stays consistent between rings. This mirrors the single-ring
    // pieMaxSlices behaviour (which only applied to the single-ring path before).
    let keptCategories: Set<string> | null = null;
    {
      const totals = new Map<string, number>();
      for (const ring of rings) {
        ring.slices.labels.forEach((l, i) => {
          const s = String(l);
          totals.set(s, (totals.get(s) ?? 0) + (ring.slices.values[i] ?? 0));
        });
      }
      if (pieMaxSlices && totals.size >= pieMaxSlices) {
        const sorted = [...totals.keys()].sort(
          (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0),
        );
        keptCategories = new Set(sorted.slice(0, pieMaxSlices - 1));
      }
    }
    // Collapse a slice label to its display key: itself when kept (or no grouping), else "Other".
    const collapseLabel = (label: string | number): string => {
      const s = String(label);
      return keptCategories && !keptCategories.has(s) ? otherBucketLabel : s;
    };
    if (keptCategories) {
      rings = rings.map((ring) => {
        const merged = new Map<string, number>();
        ring.slices.labels.forEach((l, i) => {
          const key = collapseLabel(l);
          merged.set(key, (merged.get(key) ?? 0) + (ring.slices.values[i] ?? 0));
        });
        return {
          ...ring,
          slices: { labels: [...merged.keys()], values: [...merged.values()] },
        };
      });
    }

    // Stable union of split-by categories across ALL rings (first-seen order, post-grouping).
    // Drives the category→colour mapping and the legend so an inner ring's slice is always
    // coloured (and labelled) by its category, not by its positional index within that ring.
    const categoryOrder: string[] = [];
    const seenCategory = new Set<string>();
    for (const ring of rings) {
      for (const l of ring.slices.labels) {
        const s = String(l);
        if (!seenCategory.has(s)) {
          seenCategory.add(s);
          categoryOrder.push(s);
        }
      }
    }

    // Filtered label sets for dimming — only when the ghost baseline is in use.
    const filteredCategories = useGhostBaseline
      ? new Set(enrichedRows.map(categoryKeyOf).filter((c): c is string => c != null))
      : null;
    const filteredSlicesByCategory = useGhostBaseline
      ? new Map(
          categories.map((cat) => {
            const catRows = enrichedRows.filter((r) => categoryKeyOf(r) === cat);
            const agg = aggregateByField(
              catRows,
              sliceField,
              ringYField,
              undefined,
              ringAggregation,
              undefined,
              undefined,
              undefined,
              localeText,
            );
            // Collapse filtered labels the same way so grouped ("Other") rings dim correctly.
            return [cat, new Set(agg.labels.map(collapseLabel))];
          }),
        )
      : null;

    return { rings, categoryOrder, filteredCategories, filteredSlicesByCategory };
  }, [
    seriesField,
    xField,
    yField,
    activeYFields,
    enrichedRows,
    allEnrichedRows,
    shouldShowGhost,
    xGroupBy,
    yAggregation,
    pieMaxSlices,
    otherBucketLabel,
    localeText,
    preserveXFieldBaseline,
  ]);

  // Per-slice dim state for the grouped-ring `RingDimmedPieArc` slot, keyed by
  // `${seriesId}:${dataIndex}` — see the `PieRingDimContext` comment above for why this
  // can't be baked into `color`. Memoized (rather than rebuilt as a fresh `Map` every
  // render inside the ring branch below) so the object passed to `PieRingDimContext.Provider`
  // has a stable reference across renders that don't change the underlying ring data —
  // otherwise every render would force-remount/re-evaluate every consumer of the context.
  // Computed unconditionally (not inside the `if (seriesField && twoRingData)` branch
  // below) so this hook is never called conditionally.
  const ringDimMap = React.useMemo((): Map<string, boolean> => {
    const map = new Map<string, boolean>();
    if (!twoRingData) {
      return map;
    }
    const { rings, filteredCategories, filteredSlicesByCategory } = twoRingData;
    for (const ring of rings) {
      const isCatDimmed = filteredCategories != null && !filteredCategories.has(ring.label);
      const filteredSlices = filteredSlicesByCategory?.get(ring.label) ?? null;
      ring.slices.labels.forEach((label, i) => {
        const catKey = String(label);
        const isDimmed = isCatDimmed || (filteredSlices != null && !filteredSlices.has(catKey));
        map.set(`${ring.id}:${i}`, isDimmed);
      });
    }
    return map;
  }, [twoRingData]);

  // ── Pie cross-highlight context ──────────────────────────────────────────────
  const isPieHighlightActive = Boolean(shouldShowGhost && allChartData && preserveXFieldBaseline);
  const pieRatioByIndex = React.useMemo((): Map<number, number> => {
    if (!isPieHighlightActive || !allChartData || !chartData) {
      return new Map();
    }
    const filteredValueMap = new Map(
      chartData.labels.map((l, i) => [String(l), chartData.values[i]]),
    );
    const map = new Map<number, number>();
    allChartData.labels.forEach((label, i) => {
      const allValue = allChartData.values[i];
      const filteredValue = filteredValueMap.get(String(label)) ?? 0;
      // `null` is "no data measured", not zero: there is no meaningful dim ratio for it,
      // so treat it the same as a non-positive total and leave the slice undimmed.
      map.set(i, allValue !== null && allValue > 0 ? filteredValue / allValue : 1);
    });
    return map;
  }, [isPieHighlightActive, allChartData, chartData]);

  const pieHighlightCtxValue = React.useMemo(
    () => ({ ratioByIndex: pieRatioByIndex, isActive: isPieHighlightActive, skipAnimation }),
    [pieRatioByIndex, isPieHighlightActive, skipAnimation],
  );

  // Filtered values by label string for pie tooltip/legend/arc labels when highlight is active
  const pieFilteredValueByLabel = React.useMemo((): Map<string, number> => {
    if (!isPieHighlightActive || !chartData) {
      return new Map();
    }
    return new Map(chartData.labels.map((l, i) => [String(l), chartData.values[i] ?? 0]));
  }, [isPieHighlightActive, chartData]);

  // Highlightable series ids: the ring ids for grouped rings, otherwise the single
  // cross-filter series. Computed locally since this component owns the ring data.
  const highlightableSeriesIds =
    seriesField && twoRingData
      ? new Set<string>(twoRingData.rings.map((r) => r.id))
      : new Set<string>([CROSS_FILTER_SERIES_ID]);

  const { item: controlledHighlightedItem } = computeControlledHighlight(
    hoveredItem,
    null,
    hasActiveXFilter,
    hasIncomingCrossFilters,
    highlightableSeriesIds,
  );

  const donutHole = chartType === 'donut' ? 50 : 0;
  const twoRingBottomM = pieLegendBelow ? 150 : 16;
  const twoRingPieH = Math.max(height, pieLegendBelow ? 420 : 280);
  const twoRingTopM = 16;
  // Cap maxRadius so the outermost ring doesn't overflow into the legend area
  const maxRadius = Math.min(
    Math.round(height * 0.38),
    Math.floor((twoRingPieH - twoRingTopM - twoRingBottomM) / 2),
  );
  // Arc label configuration for single-series pie/donut
  const pieArcLabelCfg = pieArcLabel;
  const arcLabelMinAngle = pieArcLabelMinAngle ?? 20;

  // ── Grouped rings: one ring per xField category, slices by seriesField ──
  if (seriesField && twoRingData) {
    const { rings, categoryOrder } = twoRingData;
    const n = rings.length;
    if (n === 0) {
      return <div style={{ height }} />;
    }

    const totalSpace = maxRadius - donutHole;
    const ringGapActual = 1;
    const ringWidth = Math.max(6, Math.floor((totalSpace - ringGapActual * (n - 1)) / n));

    // Finding 1.3: a stable category → colour mapping across ALL rings, keyed on the union of
    // split-by categories (categoryOrder). Every slice is coloured by its category, so the same
    // split-by category is the same colour in every ring — unlike the previous positional
    // `resolvedChartColors[i % …]` which re-coloured categories per ring. Reconciled with the
    // single-ring palette (`pieColors`) so dimmed and un-dimmed arcs draw from one source.
    const categoryColor = new Map<string, string>(
      categoryOrder.map((cat, i) => [cat, pieColors[i % pieColors.length]]),
    );
    // Emit exactly one legend entry per union category — from the first ring that contains it —
    // so the legend describes every category once, coloured to match. (Previously the legend was
    // built from the outermost ring only, mislabelling inner-ring categories absent from it.)
    const legendAssigned = new Set<string>();

    const pieSeries = rings.map((ring, ringIndex) => {
      const outerRadius = maxRadius - ringIndex * (ringWidth + ringGapActual);
      const innerRadius = Math.max(donutHole, outerRadius - ringWidth);
      const ringTotal = ring.slices.values.reduce<number>((sum, v) => sum + (v ?? 0), 0);

      // For multi-ring, compute per-ring arc label props
      let ringArcLabel: 'value' | ((item: { value: number }) => string) | undefined;
      if (pieArcLabelCfg === 'value') {
        ringArcLabel = (item) => valueFormatter(item.value);
      } else if (pieArcLabelCfg === 'percent' && ringTotal > 0) {
        // `formatPercent` (not `toFixed`) so the decimal separator and the `%` placement follow
        // the same `Intl` locale every other number in this widget is formatted with.
        ringArcLabel = (item) => formatPercent((item.value / ringTotal) * 100);
      }

      return {
        id: ring.id,
        label: ring.label,
        innerRadius,
        outerRadius,
        ...(ringArcLabel ? { arcLabel: ringArcLabel, arcLabelMinAngle } : {}),
        // Apply the measure valueFormatter so ring tooltips show formatted values,
        // matching the single-ring path instead of showing raw numbers.
        valueFormatter: (item: { value: number }) => valueFormatter(item.value),
        data: ring.slices.labels.map((label, i) => {
          const catKey = String(label);
          const baseColor = categoryColor.get(catKey) ?? pieColors[i % pieColors.length];
          const showLegend = !legendAssigned.has(catKey);
          if (showLegend) {
            legendAssigned.add(catKey);
          }
          return {
            id: i,
            // Function label: tooltip gets the slice name; a legend entry is emitted only for the
            // first ring that carries each category, so every category appears exactly once.
            label: showLegend
              ? formatLabel(label)
              : (location: 'legend' | 'tooltip' | 'arc') =>
                  location === 'tooltip' ? formatLabel(label) : '',
            value: ring.slices.values[i] ?? 0,
            // Always the real colour — dimming is applied via `fill-opacity` by
            // `RingDimmedPieArc` (reading `ringDimMap` through `PieRingDimContext`), not by
            // suffixing an alpha byte here.
            color: baseColor,
          };
        }),
        highlightScope: { highlight: 'item' as const, fade: 'series' as const },
      };
    });

    // A ring arc identifies an (x-category, split-by) PAIR, but this widget cross-filters on the
    // x-field only — so the value emitted for an arc is its RING's category, which is what the
    // orchestrator's `handleItemClick` expects. The ring id encodes that category, and x-charts
    // reports the arc's `seriesId` on both click and keyboard focus, so it is the lookup key.
    const ringLabelBySeriesId = new Map<string, string | number>(
      rings.map((ring) => [ring.id, ring.label]),
    );
    const handleRingClick = (
      event: { shiftKey?: boolean } | null,
      params: { seriesId: string | number; dataIndex: number },
    ) => {
      const label = ringLabelBySeriesId.get(String(params.seriesId));
      if (label === undefined) {
        return;
      }
      onItemClick(label, Boolean(event?.shiftKey));
    };
    // Enter / Space on the keyboard-focused arc emits the same cross-filter as a pointer click,
    // so switching a pie widget to a split-by never silently drops it out of the keyboard path.
    // The shared `chartKeyboardActivationProps` can't be reused here: it resolves the label by
    // `dataIndex`, which in a ring pie indexes the SLICE within a ring, not the ring itself.
    const ringKeyboardProps = {
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }
        const focused = chartFocusRef.current;
        const label =
          focused && 'seriesId' in focused
            ? ringLabelBySeriesId.get(String(focused.seriesId))
            : undefined;
        if (label === undefined) {
          return;
        }
        // Swallow the key only once it is known to be handled, so an unhandled Space still
        // scrolls the dashboard as usual.
        event.preventDefault();
        onItemClick(label, event.shiftKey);
      },
    };

    return (
      <PieRingDimContext.Provider value={ringDimMap}>
        {/* `display: contents` so the keydown wrapper adds no box of its own. The keydown is
            DELEGATED: it originates on x-charts' focusable keyboard-navigation proxy inside the
            chart and bubbles up here, so this wrapper is deliberately not itself a tab stop. */}
        <div style={{ display: 'contents' }} {...ringKeyboardProps}>
          <PieChart
            {...CHART_KEYBOARD_NAV_PROPS}
            title={ariaTitle}
            // Rings and their split-by categories are otherwise distinguished by hue alone —
            // enumerate the rings so the description names each one.
            desc={buildChartDescription(
              rings.map((ring) => String(ring.label)),
              localeText.filterSummaryAndMore,
            )}
            {...slotProps}
            height={twoRingPieH}
            skipAnimation={skipAnimation}
            series={pieSeries}
            colors={pieColors}
            slots={RING_PIE_SLOTS}
            {...(pieLegendBelow && {
              slotProps: {
                legend: {
                  direction: 'vertical' as const,
                  position: { vertical: 'bottom' as const, horizontal: 'center' as const },
                },
              },
            })}
            margin={{ top: twoRingTopM, right: 16, bottom: twoRingBottomM, left: 16 }}
            highlightedItem={controlledHighlightedItem}
            onHighlightChange={(item) =>
              onHoverChange(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
            }
            onItemClick={handleRingClick}
          >
            <ChartFocusTracker focusRef={chartFocusRef} />
          </PieChart>
        </div>
      </PieRingDimContext.Provider>
    );
  }

  // ── Single series paths ───────────────────────────────────────────────
  const pieH = Math.max(height, 280);
  const pieSideM = 50;
  const pieTopM = 20;
  const pieBottomM = 12;
  // For donut: shrink outerRadius so outside arc labels stay within the drawing area
  const donutLabelOverhang = 18;
  const pieSingleOuterRadius =
    chartType === 'donut'
      ? Math.floor((pieH - pieTopM - pieBottomM) / 2) - donutLabelOverhang
      : undefined;
  const singleInnerRadius =
    chartType === 'donut' && pieSingleOuterRadius !== undefined
      ? Math.round(pieSingleOuterRadius * 0.7)
      : 0;
  const singleArcLabelRadius =
    chartType === 'donut' && pieSingleOuterRadius !== undefined
      ? pieSingleOuterRadius + donutLabelOverhang
      : undefined;

  // Use stable baseline data (isPieHighlightActive / pieRatioByIndex computed at top level).
  // `chartData` can only be null when `isPieHighlightActive` is true (the caller only ever
  // omits it in favor of a ghost baseline), so the `?? { labels: [], values: [] }` fallback
  // is defensive only — it's never actually exercised on the `!isPieHighlightActive` branch.
  const pieBaseData = isPieHighlightActive
    ? allChartData!
    : (chartData ?? { labels: [], values: [] });

  // Apply "Other" grouping if pieMaxSlices is configured.
  // Trigger when we have >= pieMaxSlices items (>= so N items collapses the last one).
  // Also absorb any top-N item whose share is < 1% of total into the "Other" group.
  let displayLabels = pieBaseData.labels;
  // A `null` aggregate means "nothing was measured" for that category, which is NOT a measured
  // zero. It is carried through as `null` all the way to the render: the category keeps its
  // legend row and its entry in the chart description (both rendered as `NO_VALUE_LABEL`), and
  // it contributes NO arc at all — the pie's equivalent of the bar chart drawing no bar. See
  // `internals/aggregators.ts` for why the aggregation layer emits `null` rather than 0.
  let displayValues: (number | null)[] = pieBaseData.values;
  // True once the "Other" slice is a grouping bucket (an appended synthetic bucket, or a real
  // "Other" category that also absorbed the folded remainder). Used to guard clicks on it.
  let otherIsSynthetic = false;
  if (pieMaxSlices && displayLabels.length >= pieMaxSlices) {
    // Only MEASURED categories take part in the ranking and the "Other" fold: an unmeasured
    // category has no value to rank by and nothing to contribute to the bucket's sum, and
    // folding it in as 0 would re-introduce the fabricated zero this pipeline avoids. They are
    // appended unchanged, so they keep their (slice-less) legend row.
    const measured: { label: string | number; value: number }[] = [];
    const unmeasured: (string | number)[] = [];
    displayLabels.forEach((label, i) => {
      const value = displayValues[i];
      if (value == null) {
        unmeasured.push(label);
      } else {
        measured.push({ label, value });
      }
    });
    const rawTotal = measured.reduce<number>((s, p) => s + p.value, 0);
    const minPct = rawTotal > 0 ? rawTotal * 0.01 : 0; // 1% threshold
    const pairs = [...measured].sort((a, b) => b.value - a.value);
    // Keep up to topN items that individually exceed the 1% threshold
    const topN = pieMaxSlices - 1;
    const kept: typeof pairs = [];
    const grouped: typeof pairs = [];
    for (const p of pairs) {
      if (kept.length < topN && p.value >= minPct) {
        kept.push(p);
      } else {
        grouped.push(p);
      }
    }
    const otherValue = grouped.reduce((sum, p) => sum + p.value, 0);
    if (otherValue > 0 || grouped.length > 0) {
      const unmeasuredValues = unmeasured.map(() => null);
      const existingOtherIdx = kept.findIndex((p) => p.label === otherBucketLabel);
      if (existingOtherIdx >= 0) {
        kept[existingOtherIdx] = {
          label: otherBucketLabel,
          value: kept[existingOtherIdx].value + otherValue,
        };
        displayLabels = [...kept.map((p) => p.label), ...unmeasured];
        displayValues = [...kept.map((p) => p.value), ...unmeasuredValues];
      } else {
        displayLabels = [...kept.map((p) => p.label), otherBucketLabel, ...unmeasured];
        displayValues = [...kept.map((p) => p.value), otherValue, ...unmeasuredValues];
      }
      otherIsSynthetic = true;
    }
  }

  // Only measured categories become arcs: `PieValueType.value` is a plain `number`, so an
  // unmeasured category has no representable slice — emitting one at 0 would draw a zero-width
  // arc that still claims a share of the total and reads as a genuine measurement in the
  // tooltip. `arcToDisplayIndex` maps each rendered arc back to its `displayLabels` index so
  // clicks, keyboard activation, the selection highlight and the ghost ratio map (all keyed by
  // the arc's `dataIndex`) stay aligned with the display arrays.
  const arcToDisplayIndex: number[] = [];
  displayValues.forEach((value, i) => {
    if (value != null) {
      arcToDisplayIndex.push(i);
    }
  });
  const arcLabels = arcToDisplayIndex.map((i) => displayLabels[i]);
  const displayToArcIndex = new Map<number, number>(
    arcToDisplayIndex.map((displayIndex, arcIndex) => [displayIndex, arcIndex]),
  );

  // Clicking the synthetic "Other" bucket would emit a cross-filter that matches no single
  // category, so ignore it. A real "Other" category (no grouping active) still cross-filters.
  const handleSliceClick = (
    event: { shiftKey?: boolean } | null,
    params: { dataIndex: number },
  ) => {
    // `dataIndex` indexes the RENDERED arcs, which skip unmeasured categories.
    const label = arcLabels[params.dataIndex];
    if (label === undefined) {
      return;
    }
    if (otherIsSynthetic && String(label) === otherBucketLabel) {
      return;
    }
    onItemClick(label, Boolean(event?.shiftKey));
  };

  // Keyboard cross-filtering: Enter / Space on the arc x-charts' keyboard navigation has
  // focused emits the same cross-filter as a pointer click, with the same synthetic-"Other"
  // guard `handleSliceClick` applies.
  // The focused item's `dataIndex` addresses the rendered arcs, so activation resolves against
  // `arcLabels` (not `displayLabels`, which also carries the slice-less unmeasured categories).
  const pieKeyboardProps = chartKeyboardActivationProps(
    chartFocusRef,
    arcLabels,
    onItemClick,
    (label) => otherIsSynthetic && String(label) === otherBucketLabel,
  );

  // Text alternative for the single-series pie: slices are distinguished by hue alone once arc
  // labels are off, so name every slice in the chart's description. Unmeasured
  // categories announce the same `NO_VALUE_LABEL` the visible legend shows for them, so the
  // description and the legend never disagree about whether a category was measured.
  const pieAriaDescription = buildChartDescription(
    displayLabels.map((label, i) => {
      const value = displayValues[i];
      return `${formatLabel(label)}: ${value == null ? NO_VALUE_LABEL : valueFormatter(value)}`;
    }),
    localeText.filterSummaryAndMore,
  );

  // Selection is computed against the RENDERED (display) label order, exactly like the bar
  // chart's `getSelectedDataIndices(displayXAxisData)`. `getSelectedDataIndices` matches by
  // LABEL, so the re-sorting/grouping `pieMaxSlices` applies is irrelevant: a kept label
  // resolves to its new rendered index, a folded-away label simply yields no index, and the
  // synthetic "Other" bucket can never match a real selected category.
  //
  // This was previously suppressed whenever `pieMaxSlices` was merely *set* (`pieMaxSlices ? []
  // : …`). Because grouping only kicks in at `displayLabels.length >= pieMaxSlices`, a
  // `pieMaxSlices: 8` over 5 categories does no grouping at all yet still lost its selected
  // arc: clicking a slice applied the cross-filter (siblings narrowed, the chip appeared) while
  // the pie showed no selection at all.
  const selectedDataIndices = getSelectedDataIndices(displayLabels);

  // Capture local copy to avoid TDZ in valueFormatter closures
  const localPieValueFormatter = valueFormatter;

  // When cross-highlight is active: build filtered values parallel to displayLabels
  // (handles "Other" grouping by summing filtered values of ungrouped labels).
  // Deliberately NOT gated on `pieFilteredValueByLabel.size > 0`: a cross-filter that empties
  // every row for this widget makes `chartData` null/empty, so the map is legitimately empty —
  // but the highlight is still active and every slice must render fully dimmed (ratio 0) rather
  // than falling through to the `: allValue` fallback below, which rendered the ghost at full
  // (undimmed) opacity instead of the "filtered out" treatment (Tier 2 finding). `.get(...) ?? 0`
  // below already handles an empty map correctly (every label resolves to 0 = fully filtered out).
  //
  // Both the keep-set exclusion and the fold-in sum are gated on `otherIsSynthetic`, mirroring
  // the bar chart's `otherGroupingApplied &&` guards. Without it, a dashboard with a REAL
  // category literally named "Other" (and no grouping active) had that category absorb the
  // filtered value of every other category, so it rendered fully undimmed under a
  // cross-highlight while its true filtered value could be zero.
  let filteredDisplayValues: number[] | null = null;
  if (isPieHighlightActive) {
    const isOtherBucket = (l: unknown) => otherIsSynthetic && String(l) === otherBucketLabel;
    const keepSet = new Set(displayLabels.filter((l) => !isOtherBucket(l)).map(String));
    filteredDisplayValues = displayLabels.map((label) => {
      if (isOtherBucket(label)) {
        let sum = 0;
        for (const [lbl, fv] of pieFilteredValueByLabel) {
          if (!keepSet.has(lbl)) {
            sum += fv;
          }
        }
        return sum;
      }
      return pieFilteredValueByLabel.get(String(label)) ?? 0;
    });
  }

  // Compute arc label props for single-series pie/donut
  const singlePieTotal = displayValues.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const filteredPieTotal = filteredDisplayValues
    ? filteredDisplayValues.reduce((s, v) => s + v, 0)
    : 0;
  let singleArcLabel: 'value' | ((item: { value: number }) => string) | undefined;
  if (pieArcLabelCfg === 'value') {
    if (filteredDisplayValues) {
      const localFilteredDisplayValues = filteredDisplayValues;
      singleArcLabel = (item) => {
        const idx = (item as { id?: number; value: number }).id ?? 0;
        const fv = localFilteredDisplayValues[idx] ?? 0;
        const bv = item.value;
        if (fv === bv) {
          return localPieValueFormatter(bv);
        }
        return `${localPieValueFormatter(fv)} / ${localPieValueFormatter(bv)}`;
      };
    } else {
      singleArcLabel = 'value';
    }
  } else if (pieArcLabelCfg === 'percent' && singlePieTotal > 0) {
    const total = singlePieTotal;
    if (filteredDisplayValues && filteredPieTotal > 0) {
      const fTotal = filteredPieTotal;
      const localFilteredDisplayValues = filteredDisplayValues;
      singleArcLabel = (item) => {
        const idx = (item as { id?: number; value: number }).id ?? 0;
        const fv = localFilteredDisplayValues[idx] ?? 0;
        const filtPct = formatPercent((fv / fTotal) * 100);
        const basePct = formatPercent((item.value / total) * 100);
        if (fv === item.value) {
          return basePct;
        }
        return `${filtPct} / ${basePct}`;
      };
    } else {
      singleArcLabel = (item) => formatPercent((item.value / total) * 100);
    }
  }

  // `pieColors` (the reconciled arc/legend palette) is hoisted to the top of the component so
  // the grouped-ring branch can reuse it.

  // Shared series definition for both legend modes
  const pieSingleSeries = [
    {
      id: CROSS_FILTER_SERIES_ID,
      ...(pieLegendBelow && pieSingleOuterRadius !== undefined
        ? { outerRadius: pieSingleOuterRadius }
        : {}),
      innerRadius: singleInnerRadius,
      ...(singleArcLabel
        ? {
            arcLabel: singleArcLabel,
            arcLabelMinAngle,
            ...(pieLegendBelow && singleArcLabelRadius !== undefined
              ? { arcLabelRadius: singleArcLabelRadius }
              : {}),
          }
        : {}),
      // One entry per MEASURED category. `id` stays the DISPLAY index, which is what the
      // `arcLabel`/`valueFormatter` closures below use to reach `filteredDisplayValues`.
      data: arcToDisplayIndex.map((displayIndex) => ({
        id: displayIndex,
        label: formatLabel(displayLabels[displayIndex]),
        value: displayValues[displayIndex] as number,
        // Pin the palette entry by DISPLAY index so a category's colour doesn't shift when an
        // unmeasured neighbour contributes no arc, and so the custom legend's swatch (also
        // display-indexed) always names the slice it is coloured after.
        color: pieColors[displayIndex % pieColors.length],
      })),
      highlightScope: { highlight: 'item' as const, fade: 'global' as const },
      ...(filteredDisplayValues
        ? {
            valueFormatter: (item: { id?: unknown; value: number }) => {
              const idx = item.id as number;
              const fv = filteredDisplayValues[idx] ?? 0;
              const bv = item.value;
              if (fv === bv) {
                return localPieValueFormatter(bv);
              }
              return `${localPieValueFormatter(fv)} / ${localPieValueFormatter(bv)}`;
            },
          }
        : {}),
    },
  ];

  // Self-selection takes priority over ghost-highlight mode so clicking a pie arc
  // always brightens it even when the pie is also receiving a cross-highlight from
  // another chart. isPieHighlightActive suppresses stale hover; otherwise fall back to hover.
  const pieHoverFallback = isPieHighlightActive ? null : controlledHighlightedItem;
  // `highlightedItem.dataIndex` addresses the rendered arcs, so translate the selected display
  // index. A selected category that was never measured has no arc and simply can't be
  // highlighted (it is not a slice), so the hover fallback applies.
  const selectedArcIndex =
    selectedDataIndices.length > 0 ? displayToArcIndex.get(selectedDataIndices[0]) : undefined;
  const pieHighlightedItem =
    selectedArcIndex !== undefined
      ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedArcIndex }
      : pieHoverFallback;

  // Ratio map for CrossHighlightPieArc, keyed by the RENDERED arc index.
  // The top-level pieRatioByIndex is keyed by allChartData's original order, but
  // displayLabels are re-sorted and "Other"-grouped when pieMaxSlices is set, so the
  // arc dataIndex no longer matches. Rebuild from displayValues / filteredDisplayValues,
  // which are both already aligned to displayLabels (incl. the "Other" bucket), walking them
  // through `arcToDisplayIndex` so the map is keyed by the ARC index the slot receives.
  const pieDisplayCtxValue = isPieHighlightActive
    ? // eslint-disable-next-line react/jsx-no-constructed-context-values
      {
        ratioByIndex: new Map<number, number>(
          arcToDisplayIndex.map((displayIndex, arcIndex) => {
            const allValue = displayValues[displayIndex] ?? 0;
            const filteredValue = filteredDisplayValues
              ? (filteredDisplayValues[displayIndex] ?? 0)
              : allValue;
            return [arcIndex, allValue > 0 ? filteredValue / allValue : 1] as const;
          }),
        ),
        isActive: isPieHighlightActive,
        skipAnimation,
      }
    : pieHighlightCtxValue;

  return (
    /* PieHighlightContext always wraps PieChart — never conditionally — so PieChart
       stays at the same tree position and arcs never remount on filter changes. */
    <ChartFieldTitleContext.Provider value={fieldLabel}>
      <PieHighlightContext.Provider value={pieDisplayCtxValue}>
        {pieLegendBelow ? (
          // `display: contents` so wiring the keyboard handler adds no box of its own — the
          // PieChart and the custom legend keep the exact layout they had under a Fragment.
          // The keydown is DELEGATED: it originates on x-charts' own focusable
          // keyboard-navigation proxy inside the chart and bubbles up here, so this wrapper is
          // deliberately not itself a tab stop.
          <div style={{ display: 'contents' }} {...pieKeyboardProps}>
            <PieChart
              {...CHART_KEYBOARD_NAV_PROPS}
              title={ariaTitle}
              desc={pieAriaDescription}
              {...slotProps}
              height={pieH}
              skipAnimation={skipAnimation}
              slots={PIE_HIGHLIGHT_SLOTS_NO_LEGEND}
              series={pieSingleSeries}
              colors={pieColors}
              margin={{ top: pieTopM, right: pieSideM, bottom: pieBottomM, left: pieSideM }}
              highlightedItem={pieHighlightedItem}
              onHighlightChange={(item) =>
                onHoverChange(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
              }
              onItemClick={handleSliceClick}
              sx={{ cursor: 'default' }}
            >
              <ChartFocusTracker focusRef={chartFocusRef} />
            </PieChart>
            {/* Custom legend: color swatch + left-aligned label + right-aligned percentage */}
            <Box sx={{ px: 1.5, pb: 1 }}>
              {displayLabels.map((label, i) => {
                const value = displayValues[i];
                // An unmeasured category has no share of the total to report: it renders the
                // same `NO_VALUE_LABEL` the chart description announces for it, never the
                // "0.0%" a `?? 0` would fabricate for a category that has no slice at all.
                let pct: string;
                if (value == null) {
                  pct = NO_VALUE_LABEL;
                } else if (singlePieTotal > 0) {
                  const basePct = formatPercent((value / singlePieTotal) * 100);
                  const filteredPct =
                    filteredDisplayValues && filteredPieTotal > 0
                      ? formatPercent(((filteredDisplayValues[i] ?? 0) / filteredPieTotal) * 100)
                      : null;
                  pct =
                    filteredPct && filteredPct !== basePct
                      ? `${filteredPct} / ${basePct}`
                      : basePct;
                } else {
                  // Every category measured, but they sum to zero — there is no percentage to
                  // report, and this is not the "unmeasured" case either.
                  pct = '';
                }
                const color = pieColors[i % pieColors.length];
                return (
                  <Box
                    key={i}
                    sx={{ display: 'flex', alignItems: 'center', gap: '6px', py: '2px' }}
                  >
                    <Box
                      component="span"
                      sx={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '2px',
                        bgcolor: color,
                        flexShrink: 0,
                      }}
                    />
                    <Box
                      component="span"
                      sx={{
                        flex: 1,
                        fontSize: '0.65rem',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatLabel(label)}
                    </Box>
                    <Box
                      component="span"
                      sx={{
                        fontSize: '0.65rem',
                        fontVariantNumeric: 'tabular-nums',
                        flexShrink: 0,
                        color: 'text.secondary',
                        pl: '8px',
                        textAlign: 'right',
                      }}
                    >
                      {pct}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </div>
        ) : (
          // Delegated keydown — see the legend-below wrapper above.
          <div style={{ height }} {...pieKeyboardProps}>
            <PieChart
              {...CHART_KEYBOARD_NAV_PROPS}
              title={ariaTitle}
              desc={pieAriaDescription}
              {...slotProps}
              skipAnimation={skipAnimation}
              slots={PIE_FIELD_SLOTS}
              series={pieSingleSeries}
              colors={pieColors}
              margin={{ top: 16, right: 16, bottom: 16, left: 16 }}
              highlightedItem={pieHighlightedItem}
              onHighlightChange={(item) =>
                onHoverChange(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
              }
              onItemClick={handleSliceClick}
              sx={{ cursor: 'default' }}
            >
              <ChartFocusTracker focusRef={chartFocusRef} />
            </PieChart>
          </div>
        )}
      </PieHighlightContext.Provider>
    </ChartFieldTitleContext.Provider>
  );
}
