'use client';

import * as React from 'react';
import type { StudioWidget } from '../models';
import {
  useStudioSelector,
  selectDataSources,
  selectRelationships,
  selectExpressionFields,
} from '../context';
import { resolveChartRowsForAggregation, type ChartSupportResult } from './chartUtils';

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
 */
export function useChartRows(
  filteredRows: Row[],
  widget: StudioWidget,
  activeYFields: string[],
  chartSupport: ChartSupportResult,
): Row[] {
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const { config } = widget;

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
}
