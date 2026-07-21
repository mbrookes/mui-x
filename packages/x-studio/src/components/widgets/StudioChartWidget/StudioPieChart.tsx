'use client';
import * as React from 'react';
import { PieChart, PieArc } from '@mui/x-charts/PieChart';
import type { PieChartProps, PieArcProps } from '@mui/x-charts/PieChart';
import type { HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box, useTheme } from '@mui/material';
import { aggregateByField } from '../../../internals/chartAggregation';
import type { AggregatedData } from '../../../internals/chartAggregation';
import { applyXGroupBy, isEmptyXValue, toXValue } from '../../../internals/chartValues';
import { sortLabels } from '../../../internals/temporalUtils';
import type { StudioChartConfig } from '../../../models';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';
import { computeControlledHighlight } from './chartWidgetHelpers';
import { PieHighlightContext } from './PieCrossHighlightContext';
import { PIE_HIGHLIGHT_SLOTS } from './PieCrossHighlightSlots';
import { ChartFieldTitleContext, ItemFieldTooltip } from './StudioChartFieldTooltip';

const CROSS_FILTER_SERIES_ID = 'cross-filter-series';

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
 * `theme.components.MuiPieChart.defaultProps.colors` (finding 3.7).
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
  slotProps,
}: StudioPieChartProps) {
  const theme = useTheme();
  const localeText = useStudioLocaleText();
  const otherBucketLabel = localeText.chartOtherBucketLabel;

  // Resolve the colour palette shared by the single-series arcs, the custom legend, AND the
  // grouped concentric rings so they always agree. Priority: explicit chartColors > theme
  // MuiPieChart default props > resolvedChartColors (blueberryTwilightPalette fallback).
  // Hoisted above the ring branch so the ring path can reconcile its slice/dim colours the
  // same way the single-ring path does (finding 1.3).
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
    // entry on `enrichedRows.length === 0` alone (finding 6) used to bail out of the ring branch
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
    // single-ring pie) rather than treating every raw x value as its own ring (finding 2.25).
    const ringAggregation = yAggregation ?? 'sum';
    const categoryKeyOf = (r: Record<string, unknown>): string | null => {
      const rawX = r[xField];
      if (isEmptyXValue(rawX, localeText)) {
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
    // regardless of the flag (finding 4). Same condition as `canUseGhostBaseline` above (reused,
    // not recomputed, to keep the entry guard and the baseline choice below in lockstep).
    const useGhostBaseline = canUseGhostBaseline;
    const baseRows = useGhostBaseline ? allEnrichedRows : enrichedRows;

    // Get unique category values (period-grouped xField), sorted like the single-ring path
    // (`aggregateByField` → `sortLabels`) rather than left in first-seen row order — otherwise
    // temporal rings render in arbitrary chronological order, and the order can visibly swap
    // when the baseline flips between `allEnrichedRows`/`enrichedRows` (finding 3.4).
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
      map.set(i, allValue > 0 ? filteredValue / allValue : 1);
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
      const ringTotal = ring.slices.values.reduce((sum, v) => sum + (v ?? 0), 0);

      // For multi-ring, compute per-ring arc label props
      let ringArcLabel: 'value' | ((item: { value: number }) => string) | undefined;
      if (pieArcLabelCfg === 'value') {
        ringArcLabel = (item) => valueFormatter(item.value);
      } else if (pieArcLabelCfg === 'percent' && ringTotal > 0) {
        ringArcLabel = (item) => `${((item.value / ringTotal) * 100).toFixed(1)}%`;
      }

      return {
        id: ring.id,
        label: ring.label,
        innerRadius,
        outerRadius,
        ...(ringArcLabel ? { arcLabel: ringArcLabel, arcLabelMinAngle } : {}),
        // Apply the measure valueFormatter so ring tooltips show formatted values (finding 1.3),
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
            // suffixing an alpha byte here (finding 3.7).
            color: baseColor,
          };
        }),
        highlightScope: { highlight: 'item' as const, fade: 'series' as const },
      };
    });

    return (
      <PieRingDimContext.Provider value={ringDimMap}>
        <PieChart
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
        />
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
  let displayValues: (number | undefined)[] = pieBaseData.values;
  // True once the "Other" slice is a grouping bucket (an appended synthetic bucket, or a real
  // "Other" category that also absorbed the folded remainder). Used to guard clicks on it.
  let otherIsSynthetic = false;
  if (pieMaxSlices && displayLabels.length >= pieMaxSlices) {
    const rawTotal = displayValues.reduce<number>((s, v) => s + (v ?? 0), 0);
    const minPct = rawTotal > 0 ? rawTotal * 0.01 : 0; // 1% threshold
    const pairs = displayLabels.map((label, i) => ({
      label,
      value: displayValues[i] ?? 0,
    }));
    pairs.sort((a, b) => b.value - a.value);
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
      const existingOtherIdx = kept.findIndex((p) => p.label === otherBucketLabel);
      if (existingOtherIdx >= 0) {
        kept[existingOtherIdx] = {
          label: otherBucketLabel,
          value: kept[existingOtherIdx].value + otherValue,
        };
        displayLabels = kept.map((p) => p.label);
        displayValues = kept.map((p) => p.value);
      } else {
        displayLabels = [...kept.map((p) => p.label), otherBucketLabel];
        displayValues = [...kept.map((p) => p.value), otherValue];
      }
      otherIsSynthetic = true;
    }
  }

  // Clicking the synthetic "Other" bucket would emit a cross-filter that matches no single
  // category, so ignore it. A real "Other" category (no grouping active) still cross-filters.
  const handleSliceClick = (
    event: { shiftKey?: boolean } | null,
    params: { dataIndex: number },
  ) => {
    const label = displayLabels[params.dataIndex];
    if (label === undefined) {
      return;
    }
    if (otherIsSynthetic && String(label) === otherBucketLabel) {
      return;
    }
    onItemClick(label, Boolean(event?.shiftKey));
  };

  // When no "Other" grouping is applied, displayLabels === pieBaseData.labels (which is
  // allChartData.labels while a cross-highlight is active, chartData.labels otherwise) —
  // the same ordering the arcs below are rendered from. Compute the highlighted indices
  // against that ordering so an own-selection plus an incoming cross-filter highlights the
  // correct arc. (With pieMaxSlices the labels are re-sorted/grouped, so we skip highlighting.)
  const selectedDataIndices = pieMaxSlices ? [] : getSelectedDataIndices(displayLabels);

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
  let filteredDisplayValues: number[] | null = null;
  if (isPieHighlightActive) {
    const keepSet = new Set(
      displayLabels.filter((l) => String(l) !== otherBucketLabel).map(String),
    );
    filteredDisplayValues = displayLabels.map((label) => {
      if (String(label) === otherBucketLabel) {
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
        const filtPct = `${((fv / fTotal) * 100).toFixed(1)}%`;
        const basePct = `${((item.value / total) * 100).toFixed(1)}%`;
        if (fv === item.value) {
          return basePct;
        }
        return `${filtPct} / ${basePct}`;
      };
    } else {
      singleArcLabel = (item) => `${((item.value / total) * 100).toFixed(1)}%`;
    }
  }

  // `pieColors` (the reconciled arc/legend palette) is hoisted to the top of the component so
  // the grouped-ring branch can reuse it (finding 1.3).

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
      data: displayLabels.map((label, i) => ({
        id: i,
        label: formatLabel(label),
        value: displayValues[i] ?? 0,
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
  const pieHighlightedItem =
    selectedDataIndices.length > 0
      ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndices[0] }
      : pieHoverFallback;

  // Ratio map for CrossHighlightPieArc, keyed by the RENDERED arc index.
  // The top-level pieRatioByIndex is keyed by allChartData's original order, but
  // displayLabels are re-sorted and "Other"-grouped when pieMaxSlices is set, so the
  // arc dataIndex no longer matches. Rebuild from displayValues / filteredDisplayValues,
  // which are both already aligned to displayLabels (incl. the "Other" bucket).
  const pieDisplayCtxValue = isPieHighlightActive
    ? // eslint-disable-next-line react/jsx-no-constructed-context-values
      {
        ratioByIndex: new Map<number, number>(
          displayValues.map((bv, i) => {
            const allValue = bv ?? 0;
            const filteredValue = filteredDisplayValues
              ? (filteredDisplayValues[i] ?? 0)
              : allValue;
            return [i, allValue > 0 ? filteredValue / allValue : 1] as const;
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
          <React.Fragment>
            <PieChart
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
            />
            {/* Custom legend: color swatch + left-aligned label + right-aligned percentage */}
            <Box sx={{ px: 1.5, pb: 1 }}>
              {displayLabels.map((label, i) => {
                const value = displayValues[i] ?? 0;
                const basePct =
                  singlePieTotal > 0 ? `${((value / singlePieTotal) * 100).toFixed(1)}%` : '';
                const filteredPct =
                  filteredDisplayValues && filteredPieTotal > 0
                    ? `${(((filteredDisplayValues[i] ?? 0) / filteredPieTotal) * 100).toFixed(1)}%`
                    : null;
                const pct =
                  filteredPct && filteredPct !== basePct ? `${filteredPct} / ${basePct}` : basePct;
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
          </React.Fragment>
        ) : (
          <div style={{ height }}>
            <PieChart
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
            />
          </div>
        )}
      </PieHighlightContext.Provider>
    </ChartFieldTitleContext.Provider>
  );
}
