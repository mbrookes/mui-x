'use client';

import * as React from 'react';
import type { StudioChartConfig, StudioFilterState, StudioWidgetOf } from '../models';
import {
  useStudioSelector,
  selectDataSources,
  selectRelationships,
  selectExpressionFields,
} from '../context';
import { resolveChartRowsForAggregation, type ChartSupportResult } from './chartAggregation';

type Row = Record<string, unknown>;

/**
 * Encapsulates pipeline layer L4 (chart-grain rebase) for chart widgets.
 *
 * Takes filtered rows (typically from `useWidgetRows`) and re-anchors them to
 * the correct aggregation grain when the chart uses fields from a related source.
 * Wraps `resolveChartRowsForAggregation` with store subscriptions for `dataSources`,
 * `relationships`, and `expressionFields`.
 *
 * @param filteredRows  Row array from the filter layer (L3).  May be either
 *   `filteredRows` (with cross-filters) or `filteredRowsNoCross` — the caller
 *   decides which variant to pass.
 * @param widget         The chart widget.
 * @param activeYFields  Resolved y-field IDs (prefer ySeries, fall back to yField).
 * @param chartSupport   Result of `analyzeChartSupport`; used to short-circuit when
 *   the chart configuration is not yet valid.
 * @param extraFields    Non-xy dimension fields (heatmap `heatYField`, funnel
 *   `funnelReachedField`, sankey `sankeyTargetField`, `gantt*`) that must be enriched onto
 *   the returned rows so a one-hop cross-source extra dimension isn't read as
 *   `undefined`. Defaults to `[]` for the xy families that don't use it.
 * @param widgetFilters  The widget's fully resolved/scoped filter set (exactly what L3 used to
 *   produce `filteredRows`). Only the anchor-source-scoped subset is applied to the anchor rows
 *   during L4 re-anchoring, so a filter on an anchor-source field isn't silently re-widened back
 *   to every anchor row after L3's semi-join already narrowed it. Defaults to `[]`.
 */
export function useChartRows(
  filteredRows: Row[],
  widget: StudioWidgetOf<'chart'>,
  activeYFields: string[],
  chartSupport: ChartSupportResult,
  extraFields: (string | undefined)[] = [],
  widgetFilters: StudioFilterState[] = [],
): Row[] {
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const expressionFields = useStudioSelector(selectExpressionFields);
  // Flat-widen: reads xField/seriesField across chart families.
  const config: StudioChartConfig = widget.config;
  // Stable dep key for the extra-fields array (its identity isn't guaranteed across renders).
  const extraFieldsKey = extraFields.join(',');

  return React.useMemo((): Row[] => {
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
      extraFields,
      widgetFilters,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chartSupport.supported,
    filteredRows,
    widget.sourceId,
    config.xField,
    activeYFields,
    config.seriesField,
    dataSources,
    relationships,
    expressionFields,
    extraFieldsKey,
    widgetFilters,
  ]);
}
