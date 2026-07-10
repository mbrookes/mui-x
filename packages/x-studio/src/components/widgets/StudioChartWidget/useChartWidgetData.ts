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
  selectFilters,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSources,
  selectGlobalCrossFilterMode,
  selectCrossFilterAllPages,
} from '../../../context';
import { usePageChartColors } from '../../../internals/usePageChartColors';
import { cachedCompute } from '../../../internals/computedCache';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { useChartRows } from '../../../internals/useChartRows';
import { selectFiltersForWidget } from '../../../internals/filterScoping';
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

  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const globalCrossFilterMode = useStudioSelector(selectGlobalCrossFilterMode);
  const crossFilterAllPages = useStudioSelector(selectCrossFilterAllPages);
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

  // Separate rank widget filters (applied post-aggregation) from row-level filters
  const widgetRankFilter = React.useMemo(
    () =>
      filters.find(
        (f) =>
          // `!f.disabled` mirrors `selectFiltersForWidget` (the scoping authority every other
          // filter path uses): a disabled Top-N filter must NOT keep reducing the chart to N
          // categories after the user toggles it off in the drawer (finding 2.6).
          !f.disabled &&
          f.scope.kind === 'widget' &&
          f.scope.widgetId === widget.id &&
          f.filterMode === 'rank',
      ) ?? null,
    [filters, widget.id],
  );

  // Page-level chart colour palette (undefined → charts use their default).
  const chartColors = usePageChartColors();

  const {
    filteredRows,
    filteredRowsNoCross,
    hasCrossFilters,
    shouldShowGhost,
    effectiveRows,
    isLoading,
    isRecomputing,
    isError,
    errorMessage,
  } = useWidgetRows(widget, dataSource, pageId);

  // The widget's fully resolved/scoped filter set — recomputed here (rather than exposed by
  // `useWidgetRows`) via the exact same `selectFiltersForWidget` call and params it uses
  // internally, so this hook's L4 anchor-filter re-application (finding 1.4, threaded through
  // `useChartRows` below) can never disagree with what L3 actually enforced as a semi-join.
  // `resolvedFiltersNoCross` ('page' + 'widget' only) matches `filteredRowsNoCross`;
  // `resolvedFiltersAll` ('all' — page + widget + cross-filter + interactive) matches
  // `filteredRows`. `effectiveRows` is `filteredRowsNoCross` in `crossFilterMode: 'none'` and
  // `filteredRows` otherwise — mirroring `useWidgetRows`'s own `effectiveRows` resolution exactly.
  const resolvedFiltersNoCross = React.useMemo(
    () =>
      selectFiltersForWidget(filters, {
        widgetId: widget.id,
        widgetSourceId: widget.sourceId,
        activePageId: pageId,
        include: 'no-cross',
        crossFilterAllPages,
      }),
    [filters, widget.id, widget.sourceId, pageId, crossFilterAllPages],
  );
  const resolvedFiltersAll = React.useMemo(
    () =>
      selectFiltersForWidget(filters, {
        widgetId: widget.id,
        widgetSourceId: widget.sourceId,
        activePageId: pageId,
        include: 'all',
        crossFilterAllPages,
      }),
    [filters, widget.id, widget.sourceId, pageId, crossFilterAllPages],
  );
  const chartCrossFilterMode =
    globalCrossFilterMode ??
    (widget.config as StudioWidgetConfig)?.crossFilterMode ??
    'cross-highlight';
  const effectiveResolvedFilters =
    chartCrossFilterMode === 'none' ? resolvedFiltersNoCross : resolvedFiltersAll;

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
  const singleSeriesYAggregation = config.ySeries?.[0]?.yAggregation ?? config.yAggregation;

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

  // Enriched rows from non-cross-filtered data — used to compute stable series names.
  const allEnrichedRows = useChartRows(
    filteredRowsNoCross,
    widget,
    activeYFields,
    chartSupport,
    chartTypeExtraFields,
    resolvedFiltersNoCross,
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
  ]);

  // seriesField data: one line per unique value of the series field
  const seriesFieldData = React.useMemo(() => {
    const xField = config.xField;
    const seriesField = config.seriesField;
    const yField = activeYFields[0];
    if (!xField || !seriesField || !yField || enrichedRows.length === 0) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      enrichedRows,
      `sfd:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${singleSeriesYAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
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
          ),
          widgetRankFilter,
        ),
    );
  }, [
    enrichedRows,
    config.xField,
    config.seriesField,
    activeYFields,
    xGroupBy,
    singleSeriesYAggregation,
    widgetRankFilter,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
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
      `asn:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${singleSeriesYAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
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

  const chartData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || (activeYFields.length === 0 && !isFieldlessCount) || enrichedRows.length === 0) {
      return null;
    }
    if (isMultiSeries) {
      return null; // handled by multiYData
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      enrichedRows,
      `cd:${xField}:${categoryYField}:${xGroupBy ?? ''}:${singleSeriesYAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
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
        );
        return applyRankToAggregated(raw, widgetRankFilter);
      },
    );
  }, [
    enrichedRows,
    config.xField,
    activeYFields,
    isFieldlessCount,
    categoryYField,
    isMultiSeries,
    widgetRankFilter,
    xGroupBy,
    singleSeriesYAggregation,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
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
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      enrichedRows,
      `myd:${xField}:${activeYFields.join(',')}:${xGroupBy ?? ''}:${yAggByFieldKey}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
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
        );
        return applyRankToMultiSeries(raw, widgetRankFilter);
      },
    );
  }, [
    isBlended,
    enrichedRows,
    config.xField,
    activeYFields,
    yAggregationByField,
    yAggByFieldKey,
    widgetRankFilter,
    xGroupBy,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
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
      `acd:${xField}:${categoryYField}:${xGroupBy ?? ''}:${singleSeriesYAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
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
        );
        return applyRankToAggregated(raw, widgetRankFilter);
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
    xGroupBy,
    singleSeriesYAggregation,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
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
      `asfd:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${singleSeriesYAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
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
      `amyd:${xField}:${activeYFields.join(',')}:${xGroupBy ?? ''}:${yAggByFieldKey}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
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
  ]);

  // Data for scatter charts
  const scatterData = React.useMemo(() => {
    const xField = config.xField;
    const yField = config.yField;
    const sizeField = config.scatterSizeField;

    if (!xField || !yField || enrichedRows.length === 0) {
      return null;
    }

    return cachedCompute(enrichedRows, `scat:${xField}:${yField}:${sizeField ?? ''}`, () =>
      prepareScatterData(enrichedRows, xField, yField, sizeField),
    );
  }, [enrichedRows, config.xField, config.yField, config.scatterSizeField]);

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
    const yField = config.yField;
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
    config.yField,
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
    const yField = config.yField;
    const sizeField = config.scatterSizeField;
    if (!xField || !yField || allEnrichedRows.length === 0) {
      return null;
    }
    return cachedCompute(allEnrichedRows, `scat-all:${xField}:${yField}:${sizeField ?? ''}`, () =>
      prepareScatterData(allEnrichedRows, xField, yField, sizeField),
    );
  }, [shouldShowGhost, allEnrichedRows, config.xField, config.yField, config.scatterSizeField]);

  const allScatterSeries: ScatterSeriesData[] | null = React.useMemo(() => {
    if (!shouldShowGhost || !config.scatterColorField || !scatterColorCategories) {
      return null;
    }
    const xField = config.xField;
    const yField = config.yField;
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
    config.yField,
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
