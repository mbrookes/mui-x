'use client';

import * as React from 'react';
import { blueberryTwilightPalette } from '@mui/x-charts';
import { useTheme, useColorScheme } from '@mui/material';
import type {
  StudioChartConfig,
  StudioDataSource,
  StudioWidgetConfig,
  StudioWidgetOf,
} from '../../../models';
import {
  aggregateBlendedSeries,
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
  analyzeChartSupport,
  prepareScatterData,
  prepareScatterDataGrouped,
  type BlendedSeriesInput,
  type ScatterSeriesData,
  applyRankToAggregated,
  applyRankToMultiSeries,
  applyRankToSeriesFieldData,
} from '../../../internals/chartAggregation';
import {
  useStudioSelector,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSources,
  selectGlobalCrossFilterMode,
} from '../../../context';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';
import { usePageChartColors } from '../../../internals/usePageChartColors';
import { cachedCompute } from '../../../internals/computedCache';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { useChartRows } from '../../../internals/useChartRows';
import { useBlendedSeriesRows } from './useBlendedSeriesRows';

export function useChartWidgetData(
  widget: StudioWidgetOf<'chart'>,
  dataSource: StudioDataSource | undefined,
  pageId: string,
) {
  // Flat-widen to the generic `StudioChartConfig` patch type: this hook reads keys
  // spanning several chart families (xField/ySeries/chartSortBy/scatter*), so it
  // operates across chartTypes by design rather than narrowing to one family.
  const config: StudioChartConfig = widget.config;
  const xGroupBy = config.xGroupBy;
  const chartSortBy = config.chartSortBy;
  const chartSortDirection = config.chartSortDirection;
  // Threaded into every aggregation call below so the empty-category bucket label
  // (`chartEmptyCategoryLabel`) resolves to the consumer's locale instead of always
  // falling back to the English default — matching how `StudioPieChart`'s own
  // ring/sliceField aggregation already threads `localeText` through (finding T3.2).
  const localeText = useStudioLocaleText();

  // ── Cross-source blending (mixed charts) ──────────────────────────────────
  // A mixed chart may overlay series from different sources, aligned on a shared
  // categorical xField. A series is "foreign" when its sourceId differs from the
  // widget's primary source; it is aggregated independently in its own source and
  // outer-joined onto the chart's category axis (see useBlendedSeriesRows). The blend
  // hook owns `isBlended` (the single source of truth) and resolves each foreign
  // source's rows; `blendedMultiYData` below aligns them against the primary series.
  const blendSeries = config.ySeries;
  const { isBlended, foreignRowsBySource } = useBlendedSeriesRows(widget, pageId);

  // Canonical label order defined on the xField (e.g. pipeline stages).
  // Used by aggregation functions when chartSortBy is not 'value'.
  const xFieldOrderedValues = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || !dataSource) {
      return undefined;
    }
    return dataSource.fields.find((f) => f.id === xField)?.orderedValues;
  }, [config.xField, dataSource]);

  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const globalCrossFilterMode = useStudioSelector(selectGlobalCrossFilterMode);
  // Subscribe to the widget's own source PLUS every directly-related (one-hop) source,
  // mirroring `useWidgetRows`' `relevantSourceIds`/`makeSelectExpressionFieldsForSources`
  // pattern exactly. `analyzeChartSupport` below (and `ChartSetupPanel`'s own support
  // check) resolves a related-source calculated field via `findDirectFieldOwner` →
  // `hasRowLevelField`, which only finds an expression field in this list — an
  // own-source-only list makes a related-source expression field invisible here, so this
  // guard falsely disagrees with the setup panel's full-list check (finding 2.1).
  // For a many-to-many relationship the junction (bridge) source is included too, so a
  // junction-owned expression field used as a chart dimension is resolvable by the guard
  // and by L4 grain resolution instead of being invisible (mirrors `getReachableSourceIds`;
  // finding 2.1).
  const relevantSourceIds = React.useMemo(() => {
    const ids = new Set<string>();
    if (widget.sourceId) {
      ids.add(widget.sourceId);
      for (const rel of relationships) {
        if (rel.sourceId === widget.sourceId) {
          ids.add(rel.targetId);
          if (rel.type === 'many-to-many' && rel.junctionSourceId) {
            ids.add(rel.junctionSourceId);
          }
        } else if (rel.targetId === widget.sourceId) {
          ids.add(rel.sourceId);
          if (rel.type === 'many-to-many' && rel.junctionSourceId) {
            ids.add(rel.junctionSourceId);
          }
        }
      }
    }
    return ids;
  }, [widget.sourceId, relationships]);

  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSources(relevantSourceIds),
    [relevantSourceIds],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);
  const muiTheme = useTheme();
  const { colorScheme } = useColorScheme();
  // In CSS variables mode, palette.mode is always 'light'; use colorScheme for the real value.
  const resolvedMode = (colorScheme ?? muiTheme.palette.mode) as 'light' | 'dark';

  // Page-level chart colour palette (undefined → charts use their default).
  const chartColors = usePageChartColors();

  const {
    filteredRows,
    filteredRowsNoChartCross,
    hasCrossFilters,
    shouldShowGhost,
    effectiveRows,
    isLoading,
    isRecomputing,
    isError,
    errorMessage,
    // The widget's fully resolved/scoped filter sets, now EXPOSED by `useWidgetRows` and derived
    // from the SAME deferred filter snapshot the rows came from — rather than recomputed here from
    // the live `selectFilters` array. During a `useDeferredValue` window the urgent render would
    // otherwise pair stale L3 rows with a freshly-resolved filter list, so `resolveRowsAtGrain`'s
    // L4 semi-join rendered the intersection of two filter states (a transient flash to empty).
    // `resolvedFiltersAll` ('all') matches `filteredRows` (finding 2.1).
    // `resolvedFiltersNoChartCross` ('page' + 'widget' + 'interactive') matches
    // `filteredRowsNoChartCross` — the chart ghost/tooltip "all rows" baseline (finding 1.4), AND
    // is the correct pairing for `effectiveRows` in `'none'` mode (see `effectiveResolvedFilters`
    // below — finding 1, tier 1). NOTE: `resolvedFiltersNoCross` ('page' + 'widget' only, pairs
    // with `filteredRowsNoCross`) is deliberately NOT destructured here — `effectiveRows` is never
    // `filteredRowsNoCross` in this hook, so there is no rows/filters pair it correctly matches.
    resolvedFiltersAll,
    resolvedFiltersNoChartCross,
    // The widget's own WIDGET-scoped rank (Top-N) filters, derived from the same deferred filter
    // snapshot the rows came from — rather than re-derived here from the live `selectFilters`
    // array. During a `useDeferredValue` window a live-derived rank edit would otherwise re-rank
    // the still-deferred (stale) rows for a frame (finding 3.3).
    widgetScopedRankFilters,
  } = useWidgetRows(widget, dataSource, pageId);

  // The single active widget-scoped rank filter (post-aggregation Top-N reduction). Mirrors the
  // former `selectFilters.find(...)` lookup, but sourced from the deferred snapshot above so the
  // rank and the rows it reduces always come from the same filter state (finding 3.3). `!disabled`
  // and `filterMode === 'rank'` are already applied inside `widgetScopedRankFilters`.
  const widgetRankFilter = widgetScopedRankFilters[0] ?? null;

  const chartCrossFilterMode =
    globalCrossFilterMode ??
    (widget.config as StudioWidgetConfig)?.crossFilterMode ??
    'cross-highlight';
  // In `'none'` mode, `effectiveRows` (from `useWidgetRows`) equals `filteredRowsNoChartCross`
  // (page + widget + interactive filters, chart-click cross-filters only excluded) — NOT
  // `filteredRowsNoCross` (page + widget only). The filter set passed to L4 re-anchoring
  // (`useChartRows` below) must match whichever rows it's re-anchoring, or `resolveRowsAtGrain`
  // re-applies the wrong `anchorScopedFilters` and resurrects rows an active interactive filter
  // excluded (finding 1, tier 1). So this must be `resolvedFiltersNoChartCross`, matching
  // `effectiveRows`'s actual `'none'`-mode value — not `resolvedFiltersNoCross`, which pairs with
  // `filteredRowsNoCross` (a different, narrower row set effectiveRows is not in 'none' mode).
  const effectiveResolvedFilters =
    chartCrossFilterMode === 'none' ? resolvedFiltersNoChartCross : resolvedFiltersAll;

  // When a cross-highlight ghost is active, the widget-scoped rank must be applied ONCE — to the
  // baseline (all*) aggregations, which define the rendered top-N — and the FILTERED aggregations
  // must stay un-ranked so their full label→value map is available for the downstream ghost
  // alignment (which projects filtered values onto the baseline's kept labels). Ranking the
  // filtered aggregation independently diverges the two top-N sets, so a baseline-kept category
  // with a real filtered value renders "(filtered out)" while a filtered-only category is
  // invisible (finding 2.2). When no ghost is active there is no baseline, so the filtered
  // aggregation ranks itself as before.
  const filteredRankFilter = shouldShowGhost ? null : widgetRankFilter;

  // Resolve active y-fields: prefer ySeries, fall back to yField
  const activeYFields = React.useMemo(() => {
    if (config.ySeries && config.ySeries.length > 0) {
      const ids = config.ySeries.flatMap((s) => {
        if (!s.fieldId) {
          return [];
        }
        // For blended mixed charts, foreign-source series are resolved separately
        // (see blendedMultiYData); exclude them here so the primary-source support
        // analysis and row enrichment only consider native fields.
        if (isBlended && s.sourceId && s.sourceId !== widget.sourceId) {
          return [];
        }
        return [s.fieldId];
      });
      return [...new Set(ids)]; // deduplicate, preserving order
    }
    return config.yField ? [config.yField] : [];
  }, [config.ySeries, config.yField, isBlended, widget.sourceId]);

  // Per-series aggregation map (fieldId → fn), derived from the documented
  // `StudioChartSeries.yAggregation`. The non-blended multi-series client path must
  // honour this per field so an in-memory source produces the same numbers as an
  // adapter-backed source's server push-down (finding 1.4). Fields without an
  // explicit fn fall back to 'sum' inside `aggregateMultipleSeries`.
  const yAggregationByField = React.useMemo(() => {
    const map: Record<string, 'sum' | 'count' | 'avg' | 'min' | 'max'> = {};
    if (config.ySeries) {
      for (const s of config.ySeries) {
        if (s.fieldId && s.yAggregation) {
          map[s.fieldId] = s.yAggregation;
        }
      }
    }
    return map;
  }, [config.ySeries]);

  // Cache-key fragment for `yAggregationByField` (memo identity isn't stable across
  // renders, so serialize the entries for `cachedCompute` keys).
  const yAggByFieldKey = React.useMemo(
    () =>
      Object.entries(yAggregationByField)
        .map(([f, fn]) => `${f}=${fn}`)
        .join(','),
    [yAggregationByField],
  );

  // The single-series and split-by paths aggregate one measure (`activeYFields[0]`). Honour
  // that series' own `yAggregation` with precedence over the widget-level `config.yAggregation`
  // default, mirroring the server/adapter push-down precedence in `chartTypeRegistry`
  // ("the more specific per-series fn wins over the yField-derived one") so an in-memory source
  // produces the same numbers as a pushed-down aggregation (finding 1.12).
  //
  // Read the `yAggregation` from the SAME `ySeries` entry that supplied `activeYFields[0]`, not
  // from `ySeries[0]` unconditionally: `activeYFields` skips fieldId-less / foreign-blended
  // entries, so a half-configured leading entry (e.g. `[{yAggregation:'sum'}, {fieldId:'revenue',
  // yAggregation:'avg'}]`) would otherwise aggregate `revenue` with `sum` (finding 2.6). `find`
  // returns `undefined` when `activeYFields[0]` came from `config.yField` (no matching series),
  // falling through to the `config.yAggregation` default.
  const singleSeriesYAggregation =
    config.ySeries?.find((s) => s.fieldId === activeYFields[0])?.yAggregation ??
    config.yAggregation;

  // Dimension-like fields that the non-xy chart families (heatmap / funnel / sankey / gantt)
  // actually read but that are not expressed as x / y / series. Passed to `analyzeChartSupport`
  // so its guard validates them against the source graph instead of silently ignoring them
  // (finding 2.5).
  const chartTypeExtraFields = React.useMemo((): (string | undefined)[] => {
    switch (config.chartType) {
      case 'heatmap':
        return [config.heatYField];
      case 'funnel':
        return [config.funnelReachedField];
      case 'sankey':
        return [config.sankeyTargetField];
      case 'gantt':
        return [
          config.ganttLabelField,
          config.ganttStartField,
          config.ganttEndField,
          config.ganttColorField,
        ];
      default:
        return [];
    }
  }, [
    config.chartType,
    config.heatYField,
    config.funnelReachedField,
    config.sankeyTargetField,
    config.ganttLabelField,
    config.ganttStartField,
    config.ganttEndField,
    config.ganttColorField,
  ]);

  const chartSupport = React.useMemo(
    () =>
      analyzeChartSupport(
        widget.sourceId,
        config.xField,
        activeYFields,
        config.seriesField,
        config.chartType,
        dataSources,
        relationships,
        expressionFields,
        config.scatterColorField,
        config.scatterSizeField,
        chartTypeExtraFields,
      ),
    [
      widget.sourceId,
      config.xField,
      activeYFields,
      config.seriesField,
      config.chartType,
      dataSources,
      relationships,
      expressionFields,
      config.scatterColorField,
      config.scatterSizeField,
      chartTypeExtraFields,
    ],
  );

  // Resolve chart rows at the right grain for direct related fields used by x/series/y, plus the
  // non-xy families' extra dimension fields (heatY/funnelReached/sankeyTarget/gantt*) so a
  // one-hop cross-source extra dimension is enriched onto the rows the renderers read from
  // (`enrichedRows`) instead of resolving to `undefined` (finding 1.9).
  const enrichedRows = useChartRows(
    effectiveRows,
    widget,
    activeYFields,
    chartSupport,
    chartTypeExtraFields,
    effectiveResolvedFilters,
  );

  // Baseline enriched rows for ghost bars, stable series names, and the "filtered / total"
  // tooltip. This is `filteredRowsNoChartCross` (page + widget + INTERACTIVE, excluding only
  // chart-click cross-filters), NOT `filteredRowsNoCross` (page + widget only): interactive
  // filter-widget selections are always hard filters per BI norm, so resurrecting them here made
  // ghost bars and tooltip totals include rows the interactive hard filter removed — larger than
  // anything ever displayed and disagreeing with the grid (finding 1.4). `resolvedFiltersNoChartCross`
  // is the matching L4 filter set from the same deferred snapshot.
  const allEnrichedRows = useChartRows(
    filteredRowsNoChartCross,
    widget,
    activeYFields,
    chartSupport,
    chartTypeExtraFields,
    resolvedFiltersNoChartCross,
  );

  const isMultiSeries = activeYFields.length > 1;

  // A "count" aggregation tallies rows and ignores the measure field, so a single-series
  // category chart is valid with no Y field at all (e.g. "contacts by department" over a
  // source with no visible numeric field). aggregateByField counts when yAggregation is
  // 'count', so we pass an empty field id. Split-by / multi-Y are NOT supported fieldless
  // (aggregateByTwoFields/MultipleSeries sum the measure), so this only relaxes the single-
  // series path; the setup panel disables those combinations. See BL-186.
  // Check the SAME aggregation value that's actually passed to `aggregateByField` below
  // (`singleSeriesYAggregation`), not the widget-level `config.yAggregation` default. A
  // half-configured `ySeries[0]` (e.g. `{yAggregation: 'sum'}` with no `fieldId` yet, the
  // state the setup panel can pass through while a user is adding a series) previously
  // made this guard pass on `config.yAggregation === 'count'` while `singleSeriesYAggregation`
  // was actually 'sum' — producing all-zero bars (summing an empty field id) instead of
  // counts (finding 3.6).
  const isFieldlessCount = activeYFields.length === 0 && singleSeriesYAggregation === 'count';
  const categoryYField = activeYFields[0] ?? '';

  // Blended multi-Y data: each series aggregated in its own source, aligned on xField.
  const blendedMultiYData = React.useMemo(() => {
    const xField = config.xField;
    if (!isBlended || !blendSeries || !xField) {
      return null;
    }
    const inputs: BlendedSeriesInput[] = blendSeries.flatMap((s) => {
      if (!s.fieldId) {
        return [];
      }
      const sid = s.sourceId;
      const rows =
        !sid || sid === widget.sourceId ? enrichedRows : (foreignRowsBySource.get(sid) ?? []);
      // Default the resolved sourceId to the widget's primary source (mirroring the
      // `rows` fallback above) so the output always carries a concrete sourceId for
      // the (fieldId, sourceId) pair-matching consumers rely on (finding 2.12).
      return [
        {
          fieldId: s.fieldId,
          sourceId: sid ?? widget.sourceId ?? '',
          rows,
          yAggregation: s.yAggregation,
        },
      ];
    });
    if (inputs.length === 0) {
      return null;
    }
    // Apply the widget rank filter post-aggregation, mirroring the non-blended `multiYData`
    // path — a blended mixed chart under a Top-N widget rank filter previously ignored it
    // entirely (finding 2.7).
    return applyRankToMultiSeries(
      aggregateBlendedSeries(
        inputs,
        xField,
        xGroupBy,
        chartSortBy,
        chartSortDirection,
        xFieldOrderedValues,
        localeText,
      ),
      widgetRankFilter,
    );
  }, [
    isBlended,
    blendSeries,
    config.xField,
    widget.sourceId,
    enrichedRows,
    foreignRowsBySource,
    xGroupBy,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
    widgetRankFilter,
    localeText,
  ]);

  // seriesField data: one line per unique value of the series field
  const seriesFieldData = React.useMemo(() => {
    const xField = config.xField;
    const seriesField = config.seriesField;
    const yField = activeYFields[0];
    if (!xField || !seriesField || !yField || enrichedRows.length === 0) {
      return null;
    }
    // `filteredRankFilter` (null under a ghost) — see its declaration: the baseline
    // `allSeriesFieldData` carries the rank; the filtered set stays un-ranked so its full series
    // set is available for ghost alignment (finding 2.2).
    const rkKey = JSON.stringify(filteredRankFilter);
    return cachedCompute(
      enrichedRows,
      `sfd:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${singleSeriesYAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}:${localeText.chartEmptyCategoryLabel}`,
      () =>
        applyRankToSeriesFieldData(
          aggregateByTwoFields(
            enrichedRows,
            xField,
            seriesField,
            yField,
            xGroupBy,
            chartSortBy,
            chartSortDirection,
            xFieldOrderedValues,
            singleSeriesYAggregation,
            localeText,
          ),
          filteredRankFilter,
        ),
    );
  }, [
    enrichedRows,
    config.xField,
    config.seriesField,
    activeYFields,
    xGroupBy,
    singleSeriesYAggregation,
    filteredRankFilter,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
    localeText,
  ]);

  // Full series names from non-cross-filtered data (with rank applied).
  // Used to assign stable colors so series don't change color when cross-filters hide some of them.
  const allSeriesNames = React.useMemo((): (string | number)[] => {
    const xField = config.xField;
    const seriesField = config.seriesField;
    const yField = activeYFields[0];
    if (!xField || !seriesField || !yField || allEnrichedRows.length === 0) {
      return [];
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      allEnrichedRows,
      `asn:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${singleSeriesYAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}:${localeText.chartEmptyCategoryLabel}`,
      () =>
        applyRankToSeriesFieldData(
          aggregateByTwoFields(
            allEnrichedRows,
            xField,
            seriesField,
            yField,
            xGroupBy,
            chartSortBy,
            chartSortDirection,
            xFieldOrderedValues,
            // Pass the configured aggregation so this color-stability baseline ranks the same
            // top-N series set the rendered `seriesFieldData`/`allSeriesFieldData` do — omitting
            // it defaulted to 'sum', which under a rank filter + non-sum aggregation (avg/min/max/
            // count) could rank a different top-N than the actual data, defeating stable colors
            // (finding 2.23).
            singleSeriesYAggregation,
            localeText,
          ),
          widgetRankFilter,
        ).seriesNames,
    );
  }, [
    allEnrichedRows,
    config.xField,
    config.seriesField,
    activeYFields,
    xGroupBy,
    singleSeriesYAggregation,
    widgetRankFilter,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
    localeText,
  ]);

  // Always-resolved palette: used for stable per-series color assignment.
  const resolvedChartColors = React.useMemo((): string[] => {
    if (chartColors) {
      return chartColors;
    }
    return blueberryTwilightPalette(resolvedMode);
  }, [chartColors, resolvedMode]);

  // Whether this widget has incoming cross-filters (from another widget on the same page)
  // NOTE: hasCrossFilters is declared earlier in the file (before filteredRowsNoCross) so that
  // memo can use it to short-circuit. The declaration there also includes interactive filters.

  // Per-label SUM of the rank filter's `rankByField` (when specified), computed over the SAME
  // rows and x-axis grouping as `chartData`'s own single-series aggregation below. Passed to
  // `applyRankToAggregated` so the chart's post-aggregation Top-N ranks by the rank-by measure —
  // matching the row-level rank reduction grid/KPI/map/pivot widgets apply (`filterUtils.ts`,
  // which always SUMS `rankByField` per group) — instead of the displayed (possibly avg/min/max)
  // aggregated value, which previously made a chart disagree with every other widget kind on an
  // identical rank filter (finding 3.x). `undefined` (and ignored) when the rank filter doesn't
  // specify a `rankByField`.
  const rankByFieldData = React.useMemo(() => {
    const xField = config.xField;
    if (!filteredRankFilter?.rankByField || !xField || enrichedRows.length === 0) {
      return undefined;
    }
    return aggregateByField(
      enrichedRows,
      xField,
      filteredRankFilter.rankByField,
      xGroupBy,
      'sum',
      undefined,
      undefined,
      undefined,
      localeText,
    );
  }, [filteredRankFilter, config.xField, enrichedRows, xGroupBy, localeText]);

  // Baseline (all-rows) counterpart of `rankByFieldData`, for `allChartData`'s ghost-mode
  // ranking below — mirrors the `enrichedRows` → `allEnrichedRows` and
  // `filteredRankFilter` → `widgetRankFilter` baseline swap `allChartData` already makes.
  const allRankByFieldData = React.useMemo(() => {
    const xField = config.xField;
    if (!widgetRankFilter?.rankByField || !xField || allEnrichedRows.length === 0) {
      return undefined;
    }
    return aggregateByField(
      allEnrichedRows,
      xField,
      widgetRankFilter.rankByField,
      xGroupBy,
      'sum',
      undefined,
      undefined,
      undefined,
      localeText,
    );
  }, [widgetRankFilter, config.xField, allEnrichedRows, xGroupBy, localeText]);

  const chartData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || (activeYFields.length === 0 && !isFieldlessCount) || enrichedRows.length === 0) {
      return null;
    }
    if (isMultiSeries) {
      return null; // handled by multiYData
    }
    // `filteredRankFilter` (null under a ghost): the baseline `allChartData` carries the rank and
    // defines the rendered top-N; the filtered set stays un-ranked so the downstream ghost
    // alignment can project its full label→value map onto the baseline's kept labels (finding 2.2).
    const rkKey = JSON.stringify(filteredRankFilter);
    return cachedCompute(
      enrichedRows,
      `cd:${xField}:${categoryYField}:${xGroupBy ?? ''}:${singleSeriesYAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}:${localeText.chartEmptyCategoryLabel}`,
      () => {
        const raw = aggregateByField(
          enrichedRows,
          xField,
          categoryYField,
          xGroupBy,
          singleSeriesYAggregation,
          chartSortBy,
          chartSortDirection,
          xFieldOrderedValues,
          localeText,
        );
        return applyRankToAggregated(raw, filteredRankFilter, rankByFieldData);
      },
    );
  }, [
    enrichedRows,
    config.xField,
    activeYFields,
    isFieldlessCount,
    categoryYField,
    isMultiSeries,
    filteredRankFilter,
    rankByFieldData,
    xGroupBy,
    singleSeriesYAggregation,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
    localeText,
  ]);

  // Multi-Y-field data (multiple explicit series)
  const multiYData = React.useMemo(() => {
    const xField = config.xField;
    if (isBlended) {
      return null; // handled by blendedMultiYData
    }
    if (!xField || activeYFields.length < 2 || enrichedRows.length === 0) {
      return null;
    }
    // `filteredRankFilter` (null under a ghost) — baseline `allMultiYData` carries the rank
    // (finding 2.2).
    const rkKey = JSON.stringify(filteredRankFilter);
    return cachedCompute(
      enrichedRows,
      `myd:${xField}:${activeYFields.join(',')}:${xGroupBy ?? ''}:${yAggByFieldKey}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}:${localeText.chartEmptyCategoryLabel}`,
      () => {
        const raw = aggregateMultipleSeries(
          enrichedRows,
          xField,
          activeYFields,
          xGroupBy,
          chartSortBy,
          chartSortDirection,
          xFieldOrderedValues,
          yAggregationByField,
          localeText,
        );
        return applyRankToMultiSeries(raw, filteredRankFilter);
      },
    );
  }, [
    isBlended,
    enrichedRows,
    config.xField,
    activeYFields,
    yAggregationByField,
    yAggByFieldKey,
    filteredRankFilter,
    xGroupBy,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
    localeText,
  ]);

  // Full (baseline) aggregations — used for ghost rendering when cross-filters are active.
  // Only computed when shouldShowGhost to avoid wasteful work.
  const allChartData = React.useMemo(() => {
    if (!shouldShowGhost) {
      return null;
    }
    const xField = config.xField;
    if (
      !xField ||
      (activeYFields.length === 0 && !isFieldlessCount) ||
      isMultiSeries ||
      allEnrichedRows.length === 0
    ) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      allEnrichedRows,
      `acd:${xField}:${categoryYField}:${xGroupBy ?? ''}:${singleSeriesYAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}:${localeText.chartEmptyCategoryLabel}`,
      () => {
        const raw = aggregateByField(
          allEnrichedRows,
          xField,
          categoryYField,
          xGroupBy,
          singleSeriesYAggregation,
          chartSortBy,
          chartSortDirection,
          xFieldOrderedValues,
          localeText,
        );
        return applyRankToAggregated(raw, widgetRankFilter, allRankByFieldData);
      },
    );
  }, [
    shouldShowGhost,
    allEnrichedRows,
    config.xField,
    activeYFields,
    isFieldlessCount,
    categoryYField,
    isMultiSeries,
    widgetRankFilter,
    allRankByFieldData,
    xGroupBy,
    singleSeriesYAggregation,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
    localeText,
  ]);

  const allSeriesFieldData = React.useMemo(() => {
    if (!shouldShowGhost) {
      return null;
    }
    const xField = config.xField;
    const seriesField = config.seriesField;
    const yField = activeYFields[0];
    if (!xField || !seriesField || !yField || allEnrichedRows.length === 0) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      allEnrichedRows,
      `asfd:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${singleSeriesYAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}:${localeText.chartEmptyCategoryLabel}`,
      () =>
        applyRankToSeriesFieldData(
          aggregateByTwoFields(
            allEnrichedRows,
            xField,
            seriesField,
            yField,
            xGroupBy,
            chartSortBy,
            chartSortDirection,
            xFieldOrderedValues,
            singleSeriesYAggregation,
            localeText,
          ),
          widgetRankFilter,
        ),
    );
  }, [
    shouldShowGhost,
    allEnrichedRows,
    config.xField,
    config.seriesField,
    activeYFields,
    xGroupBy,
    singleSeriesYAggregation,
    widgetRankFilter,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
    localeText,
  ]);

  const allMultiYData = React.useMemo(() => {
    if (!shouldShowGhost) {
      return null;
    }
    // Blended mixed charts have no single-grain baseline to aggregate here (each series lives in
    // its own source); a non-blended `aggregateMultipleSeries` over `allEnrichedRows` would be a
    // wrong ghost that nothing consumes. Bail out exactly as `multiYData` does (finding 2.7).
    if (isBlended) {
      return null;
    }
    const xField = config.xField;
    if (!xField || activeYFields.length < 2 || allEnrichedRows.length === 0) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      allEnrichedRows,
      `amyd:${xField}:${activeYFields.join(',')}:${xGroupBy ?? ''}:${yAggByFieldKey}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}:${localeText.chartEmptyCategoryLabel}`,
      () => {
        const raw = aggregateMultipleSeries(
          allEnrichedRows,
          xField,
          activeYFields,
          xGroupBy,
          chartSortBy,
          chartSortDirection,
          xFieldOrderedValues,
          yAggregationByField,
          localeText,
        );
        return applyRankToMultiSeries(raw, widgetRankFilter);
      },
    );
  }, [
    shouldShowGhost,
    isBlended,
    allEnrichedRows,
    config.xField,
    activeYFields,
    yAggregationByField,
    yAggByFieldKey,
    widgetRankFilter,
    xGroupBy,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
    localeText,
  ]);

  // Scatter's y measure: mirror the `yField ?? ySeries[0].fieldId` fallback every sibling chart
  // family has, so a chart authored via `ySeries` then switched to scatter still resolves its
  // measure. Without it `scatterData`/`scatterSeries` stay null (they required `config.yField`)
  // while the support guard — which reads `activeYFields`, already honoring the fallback — reports
  // supported, producing an empty render (finding 2.7).
  const scatterYField = config.yField ?? config.ySeries?.[0]?.fieldId;

  // Data for scatter charts
  const scatterData = React.useMemo(() => {
    const xField = config.xField;
    const yField = scatterYField;
    const sizeField = config.scatterSizeField;

    if (!xField || !yField || enrichedRows.length === 0) {
      return null;
    }

    return cachedCompute(enrichedRows, `scat:${xField}:${yField}:${sizeField ?? ''}`, () =>
      prepareScatterData(enrichedRows, xField, yField, sizeField),
    );
  }, [enrichedRows, config.xField, scatterYField, config.scatterSizeField]);

  // Stable category order for scatter color-by field (from unfiltered rows)
  const scatterColorCategories = React.useMemo(() => {
    const colorField = config.scatterColorField;
    if (!colorField) {
      return null;
    }
    const seen = new Set<string>();
    const cats: string[] = [];
    for (const row of allEnrichedRows) {
      const raw = row[colorField];
      const cat = raw == null || raw === '' ? '(blank)' : String(raw);
      if (!seen.has(cat)) {
        seen.add(cat);
        cats.push(cat);
      }
    }
    return cats.sort();
  }, [allEnrichedRows, config.scatterColorField]);

  // Multiple scatter series, one per color category
  const scatterSeries: ScatterSeriesData[] | null = React.useMemo(() => {
    const xField = config.xField;
    const yField = scatterYField;
    const colorField = config.scatterColorField;
    const sizeField = config.scatterSizeField;

    if (!xField || !yField || !colorField || !scatterColorCategories || enrichedRows.length === 0) {
      return null;
    }

    return cachedCompute(
      enrichedRows,
      `scatc:${xField}:${yField}:${colorField}:${scatterColorCategories.join(',')}:${sizeField ?? ''}`,
      () =>
        prepareScatterDataGrouped(
          enrichedRows,
          xField,
          yField,
          colorField,
          scatterColorCategories,
          sizeField,
        ),
    );
  }, [
    enrichedRows,
    config.xField,
    scatterYField,
    config.scatterColorField,
    config.scatterSizeField,
    scatterColorCategories,
  ]);

  // Ghost scatter data (all rows, pre-cross-filter) for cross-highlight mode
  const allScatterData = React.useMemo(() => {
    if (!shouldShowGhost) {
      return null;
    }
    const xField = config.xField;
    const yField = scatterYField;
    const sizeField = config.scatterSizeField;
    if (!xField || !yField || allEnrichedRows.length === 0) {
      return null;
    }
    return cachedCompute(allEnrichedRows, `scat-all:${xField}:${yField}:${sizeField ?? ''}`, () =>
      prepareScatterData(allEnrichedRows, xField, yField, sizeField),
    );
  }, [shouldShowGhost, allEnrichedRows, config.xField, scatterYField, config.scatterSizeField]);

  const allScatterSeries: ScatterSeriesData[] | null = React.useMemo(() => {
    if (!shouldShowGhost || !config.scatterColorField || !scatterColorCategories) {
      return null;
    }
    const xField = config.xField;
    const yField = scatterYField;
    const sizeField = config.scatterSizeField;
    if (!xField || !yField || allEnrichedRows.length === 0) {
      return null;
    }
    return cachedCompute(
      allEnrichedRows,
      `scatc-all:${xField}:${yField}:${config.scatterColorField}:${scatterColorCategories.join(',')}:${sizeField ?? ''}`,
      () =>
        prepareScatterDataGrouped(
          allEnrichedRows,
          xField,
          yField,
          config.scatterColorField!,
          scatterColorCategories,
          sizeField,
        ),
    );
  }, [
    shouldShowGhost,
    allEnrichedRows,
    config.xField,
    scatterYField,
    config.scatterColorField,
    config.scatterSizeField,
    scatterColorCategories,
  ]);

  return {
    chartColors,
    resolvedChartColors,
    allSeriesNames,
    chartSupport,
    filteredRows,
    // The mode-appropriate primary baseline (`'none'` → filteredRowsNoChartCross, else
    // filteredRows) and the pre-chart-cross baseline, exposed so the "No data" guard tests the
    // same row set the chart actually renders from rather than the include:'all' `filteredRows`
    // (finding 1.3).
    effectiveRows,
    filteredRowsNoChartCross,
    activeYFields,
    enrichedRows,
    allEnrichedRows,
    isMultiSeries,
    isBlended,
    seriesFieldData,
    chartData,
    multiYData: isBlended ? blendedMultiYData : multiYData,
    scatterData,
    scatterSeries,
    allScatterData,
    allScatterSeries,
    hasCrossFilters,
    shouldShowGhost,
    allChartData,
    allSeriesFieldData,
    allMultiYData,
    isLoading,
    isRecomputing,
    isError,
    errorMessage,
  };
}
