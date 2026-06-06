'use client';

import * as React from 'react';
import { blueberryTwilightPalette } from '@mui/x-charts';
import { useTheme } from '@mui/material';
import type { StudioDataSource, StudioWidget } from '../../../models';
import {
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
  analyzeChartSupport,
  prepareScatterData,
  prepareScatterDataGrouped,
  type ScatterSeriesData,
  applyRankToAggregated,
  applyRankToMultiSeries,
  applyRankToSeriesFieldData,
} from '../../../internals/chartUtils';
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

export function useChartWidgetData(widget: StudioWidget, dataSource: StudioDataSource | undefined) {
  const { config } = widget;
  const xGroupBy = config.xGroupBy;
  const chartSortBy = config.chartSortBy;
  const chartSortDirection = config.chartSortDirection;

  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);
  const muiTheme = useTheme();

  // Separate rank widget filters (applied post-aggregation) from row-level filters
  const widgetRankFilter = React.useMemo(
    () =>
      filters.find(
        (f) => f.scope === 'widget' && f.widgetId === widget.id && f.filterMode === 'rank',
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
  } = useWidgetRows(widget, dataSource);

  // Resolve active y-fields: prefer ySeries, fall back to yField
  const activeYFields = React.useMemo(() => {
    if (config.ySeries && config.ySeries.length > 0) {
      const ids = config.ySeries.flatMap((s) => (s.fieldId ? [s.fieldId] : []));
      return [...new Set(ids)]; // deduplicate, preserving order
    }
    return config.yField ? [config.yField] : [];
  }, [config.ySeries, config.yField]);

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
      `sfd:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}`,
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
    widgetRankFilter,
    chartSortBy,
    chartSortDirection,
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
      `asn:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}`,
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
  ]);

  // Always-resolved palette: used for stable per-series color assignment.
  const resolvedChartColors = React.useMemo((): string[] => {
    if (chartColors) {
      return chartColors;
    }
    return blueberryTwilightPalette(muiTheme.palette.mode);
  }, [chartColors, muiTheme.palette.mode]);

  // Whether this widget has incoming cross-filters (from another widget on the same page)
  // NOTE: hasCrossFilters is declared earlier in the file (before filteredRowsNoCross) so that
  // memo can use it to short-circuit. The declaration there also includes interactive filters.

  const chartData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || activeYFields.length === 0 || enrichedRows.length === 0) {
      return null;
    }
    if (isMultiSeries) {
      return null; // handled by multiYData
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      enrichedRows,
      `cd:${xField}:${activeYFields[0]}:${xGroupBy ?? ''}:${config.yAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}`,
      () => {
        const raw = aggregateByField(
          enrichedRows,
          xField,
          activeYFields[0],
          xGroupBy,
          config.yAggregation,
          chartSortBy,
          chartSortDirection,
        );
        return applyRankToAggregated(raw, widgetRankFilter);
      },
    );
  }, [
    enrichedRows,
    config.xField,
    activeYFields,
    isMultiSeries,
    widgetRankFilter,
    xGroupBy,
    config.yAggregation,
    chartSortBy,
    chartSortDirection,
  ]);

  // Multi-Y-field data (multiple explicit series)
  const multiYData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || activeYFields.length < 2 || enrichedRows.length === 0) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      enrichedRows,
      `myd:${xField}:${activeYFields.join(',')}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}`,
      () => {
        const raw = aggregateMultipleSeries(
          enrichedRows,
          xField,
          activeYFields,
          xGroupBy,
          chartSortBy,
          chartSortDirection,
        );
        return applyRankToMultiSeries(raw, widgetRankFilter);
      },
    );
  }, [
    enrichedRows,
    config.xField,
    activeYFields,
    widgetRankFilter,
    xGroupBy,
    chartSortBy,
    chartSortDirection,
  ]);

  // Full (baseline) aggregations — used for ghost rendering when cross-filters are active.
  // Only computed when shouldShowGhost to avoid wasteful work.
  const allChartData = React.useMemo(() => {
    if (!shouldShowGhost) {
      return null;
    }
    const xField = config.xField;
    if (!xField || activeYFields.length === 0 || isMultiSeries || allEnrichedRows.length === 0) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      allEnrichedRows,
      `acd:${xField}:${activeYFields[0]}:${xGroupBy ?? ''}:${config.yAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}`,
      () => {
        const raw = aggregateByField(
          allEnrichedRows,
          xField,
          activeYFields[0],
          xGroupBy,
          config.yAggregation,
          chartSortBy,
          chartSortDirection,
        );
        return applyRankToAggregated(raw, widgetRankFilter);
      },
    );
  }, [
    shouldShowGhost,
    allEnrichedRows,
    config.xField,
    activeYFields,
    isMultiSeries,
    widgetRankFilter,
    xGroupBy,
    config.yAggregation,
    chartSortBy,
    chartSortDirection,
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
      `asfd:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}`,
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
    widgetRankFilter,
    chartSortBy,
    chartSortDirection,
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
      `amyd:${xField}:${activeYFields.join(',')}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}`,
      () => {
        const raw = aggregateMultipleSeries(
          allEnrichedRows,
          xField,
          activeYFields,
          xGroupBy,
          chartSortBy,
          chartSortDirection,
        );
        return applyRankToMultiSeries(raw, widgetRankFilter);
      },
    );
  }, [
    shouldShowGhost,
    allEnrichedRows,
    config.xField,
    activeYFields,
    widgetRankFilter,
    xGroupBy,
    chartSortBy,
    chartSortDirection,
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
    seriesFieldData,
    chartData,
    multiYData,
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
