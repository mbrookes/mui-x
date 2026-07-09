'use client';

import * as React from 'react';
import { blueberryTwilightPalette } from '@mui/x-charts';
import { useTheme, useColorScheme } from '@mui/material';
import type { StudioChartConfig, StudioDataSource, StudioWidgetOf } from '../../../models';
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
  makeSelectExpressionFieldsForSource,
} from '../../../context';
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
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
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
          f.scope.kind === 'widget' && f.scope.widgetId === widget.id && f.filterMode === 'rank',
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
    ],
  );

  // Resolve chart rows at the right grain for direct related fields used by x/series/y.
  const enrichedRows = useChartRows(effectiveRows, widget, activeYFields, chartSupport);

  // Enriched rows from non-cross-filtered data — used to compute stable series names.
  const allEnrichedRows = useChartRows(filteredRowsNoCross, widget, activeYFields, chartSupport);

  const isMultiSeries = activeYFields.length > 1;

  // A "count" aggregation tallies rows and ignores the measure field, so a single-series
  // category chart is valid with no Y field at all (e.g. "contacts by department" over a
  // source with no visible numeric field). aggregateByField counts when yAggregation is
  // 'count', so we pass an empty field id. Split-by / multi-Y are NOT supported fieldless
  // (aggregateByTwoFields/MultipleSeries sum the measure), so this only relaxes the single-
  // series path; the setup panel disables those combinations. See BL-186.
  const isFieldlessCount = activeYFields.length === 0 && config.yAggregation === 'count';
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
      return [{ fieldId: s.fieldId, rows, yAggregation: s.yAggregation }];
    });
    if (inputs.length === 0) {
      return null;
    }
    return aggregateBlendedSeries(
      inputs,
      xField,
      xGroupBy,
      chartSortBy,
      chartSortDirection,
      xFieldOrderedValues,
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
      `sfd:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${config.yAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
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
            config.yAggregation,
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
    config.yAggregation,
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
      `asn:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
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
      `cd:${xField}:${categoryYField}:${xGroupBy ?? ''}:${config.yAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
      () => {
        const raw = aggregateByField(
          enrichedRows,
          xField,
          categoryYField,
          xGroupBy,
          config.yAggregation,
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
    config.yAggregation,
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
      `acd:${xField}:${categoryYField}:${xGroupBy ?? ''}:${config.yAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
      () => {
        const raw = aggregateByField(
          allEnrichedRows,
          xField,
          categoryYField,
          xGroupBy,
          config.yAggregation,
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
    config.yAggregation,
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
      `asfd:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${config.yAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
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
            config.yAggregation,
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
    config.yAggregation,
    widgetRankFilter,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
  ]);

  const allMultiYData = React.useMemo(() => {
    if (!shouldShowGhost) {
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
