'use client';

import * as React from 'react';
import {
  blueberryTwilightPalette,
} from '@mui/x-charts';
import { useTheme } from '@mui/material';
import type { StudioDataSource, StudioWidget } from '../models';
import {
  resolveRows,
  resolveMetricRefs,
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
  analyzeChartSupport,
  resolveChartRowsForAggregation,
  prepareScatterData,
  applyRankToAggregated,
  applyRankToMultiSeries,
  applyRankToSeriesFieldData,
} from '../internals/chartUtils';
import { useStudioSelector } from '../context';
import { usePageChartColors } from '../internals/usePageChartColors';

export function useChartWidgetData(
  widget: StudioWidget,
  dataSource: StudioDataSource | undefined,
) {
  const { config } = widget;
  const xGroupBy = config.xGroupBy;

  const filters = useStudioSelector((state) => state.filters);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const relationships = useStudioSelector((state) => state.relationships);
  const expressionFields = useStudioSelector((state) => state.expressionFields);
  const activePageId = useStudioSelector((state) => state.dashboard.activePageId);
  const muiTheme = useTheme();

  // Separate rank widget filters (applied post-aggregation) from row-level filters
  const widgetRankFilter =
    filters.find(
      (f) => f.scope === 'widget' && f.widgetId === widget.id && f.filterMode === 'rank',
    ) ?? null;

  // Page-level chart colour palette (undefined → charts use their default).
  const chartColors = usePageChartColors();

  // Get filtered rows (rank filters are excluded — applied after aggregation)
  const filteredRows = React.useMemo(() => {
    if (!dataSource?.rows) {
      return [];
    }

    const pageFilters = filters.filter((f) => f.scope === 'page');
    // Exclude rank filters from row-level filtering
    const widgetFilters = filters.filter(
      (f) => f.scope === 'widget' && f.widgetId === widget.id && f.filterMode !== 'rank',
    );
    const crossFilters = filters.filter(
      (f) => f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id && f.pageId === activePageId,
    );
    const allFilters = resolveMetricRefs(
      [...pageFilters, ...widgetFilters, ...crossFilters],
      dataSources,
    );

    return resolveRows(
      dataSource.rows,
      widget.sourceId,
      allFilters,
      dataSources,
      relationships,
      expressionFields,
    );
  }, [dataSource, filters, dataSources, relationships, expressionFields, widget.id, widget.sourceId, activePageId]);

  // Rows filtered by page+widget filters only (no cross-filters).
  // Used to compute the stable full set of series names for consistent color assignment.
  const filteredRowsNoCross = React.useMemo(() => {
    if (!dataSource?.rows) {
      return [];
    }
    const pageFilters = filters.filter((f) => f.scope === 'page');
    const widgetFilters = filters.filter(
      (f) => f.scope === 'widget' && f.widgetId === widget.id && f.filterMode !== 'rank',
    );
    const allFilters = resolveMetricRefs([...pageFilters, ...widgetFilters], dataSources);
    return resolveRows(
      dataSource.rows,
      widget.sourceId,
      allFilters,
      dataSources,
      relationships,
      expressionFields,
    );
  }, [dataSource, filters, dataSources, relationships, expressionFields, widget.id, widget.sourceId]);

  // Resolve active y-fields: prefer ySeries, fall back to yField
  const activeYFields = React.useMemo(() => {
    if (config.ySeries && config.ySeries.length > 0) {
      const ids = config.ySeries.map((s) => s.fieldId).filter(Boolean);
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
    ],
  );

  // Resolve chart rows at the right grain for direct related fields used by x/series/y.
  const enrichedRows = React.useMemo(() => {
    if (!chartSupport.supported) {
      return [];
    }
    return resolveChartRowsForAggregation(
      filteredRows,
      widget.sourceId,
      config.xField,
      activeYFields,
      config.seriesField,
      dataSources,
      relationships,
      expressionFields,
    );
  }, [
    chartSupport.supported,
    filteredRows,
    widget.sourceId,
    config.xField,
    activeYFields,
    config.seriesField,
    dataSources,
    relationships,
  ]);

  // Enriched rows from non-cross-filtered data — used to compute stable series names.
  const allEnrichedRows = React.useMemo(() => {
    if (!chartSupport.supported) {
      return [];
    }
    return resolveChartRowsForAggregation(
      filteredRowsNoCross,
      widget.sourceId,
      config.xField,
      activeYFields,
      config.seriesField,
      dataSources,
      relationships,
      expressionFields,
    );
  }, [
    chartSupport.supported,
    filteredRowsNoCross,
    widget.sourceId,
    config.xField,
    activeYFields,
    config.seriesField,
    dataSources,
    relationships,
  ]);

  const isMultiSeries = activeYFields.length > 1;

  // seriesField data: one line per unique value of the series field
  const seriesFieldData = React.useMemo(() => {
    const xField = config.xField;
    const seriesField = config.seriesField;
    const yField = activeYFields[0];
    if (!xField || !seriesField || !yField || enrichedRows.length === 0) {
      return null;
    }
    return applyRankToSeriesFieldData(
      aggregateByTwoFields(enrichedRows, xField, seriesField, yField, xGroupBy),
      widgetRankFilter,
    );
  }, [enrichedRows, config.xField, config.seriesField, activeYFields, xGroupBy, widgetRankFilter]);

  // Full series names from non-cross-filtered data (with rank applied).
  // Used to assign stable colors so series don't change color when cross-filters hide some of them.
  const allSeriesNames = React.useMemo((): (string | number)[] => {
    const xField = config.xField;
    const seriesField = config.seriesField;
    const yField = activeYFields[0];
    if (!xField || !seriesField || !yField || allEnrichedRows.length === 0) {
      return [];
    }
    return applyRankToSeriesFieldData(
      aggregateByTwoFields(allEnrichedRows, xField, seriesField, yField, xGroupBy),
      widgetRankFilter,
    ).seriesNames;
  }, [allEnrichedRows, config.xField, config.seriesField, activeYFields, xGroupBy, widgetRankFilter]);

  // Always-resolved palette: used for stable per-series color assignment.
  const resolvedChartColors = React.useMemo((): string[] => {
    if (chartColors) {
      return chartColors;
    }
    return blueberryTwilightPalette(muiTheme.palette.mode);
  }, [chartColors, muiTheme.palette.mode]);

  const chartData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || activeYFields.length === 0 || enrichedRows.length === 0) {
      return null;
    }
    if (isMultiSeries) {
      return null; // handled by multiYData
    }
    const raw = aggregateByField(enrichedRows, xField, activeYFields[0], xGroupBy);
    return applyRankToAggregated(raw, widgetRankFilter);
  }, [enrichedRows, config.xField, activeYFields, isMultiSeries, widgetRankFilter, xGroupBy]);

  // Multi-Y-field data (multiple explicit series)
  const multiYData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || activeYFields.length < 2 || enrichedRows.length === 0) {
      return null;
    }
    const raw = aggregateMultipleSeries(enrichedRows, xField, activeYFields, xGroupBy);
    return applyRankToMultiSeries(raw, widgetRankFilter);
  }, [enrichedRows, config.xField, activeYFields, widgetRankFilter, xGroupBy]);

  // Data for scatter charts
  const scatterData = React.useMemo(() => {
    const xField = config.xField;
    const yField = config.yField;

    if (!xField || !yField || enrichedRows.length === 0) {
      return null;
    }

    return prepareScatterData(enrichedRows, xField, yField);
  }, [enrichedRows, config.xField, config.yField]);

  return {
    chartColors,
    resolvedChartColors,
    allSeriesNames,
    chartSupport,
    filteredRows,
    activeYFields,
    enrichedRows,
    isMultiSeries,
    seriesFieldData,
    chartData,
    multiYData,
    scatterData,
  };
}
