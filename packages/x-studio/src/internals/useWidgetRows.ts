'use client';

import * as React from 'react';
import type { StudioDataSource, StudioWidget } from '../models';
import {
  useStudioSelector,
  selectFilters,
  selectDataSources,
  selectRelationships,
  selectExpressionFields,
  selectActivePageId,
} from '../context';
import { resolveMetricRefs } from './chartUtils';
import { resolveRowsCached } from './resolvedRowsCache';

type Row = Record<string, unknown>;

export interface UseWidgetRowsResult {
  /** Rows after applying all active filters — page, widget, cross-filter, and interactive. */
  filteredRows: Row[];
  /**
   * Rows after applying only page and widget filters, with no cross-filters or interactive
   * filters applied. When no cross-filters are active this is the same reference as
   * `filteredRows`, allowing downstream memos to short-circuit automatically.
   */
  filteredRowsNoCross: Row[];
  /** Whether this widget has at least one incoming cross-filter or interactive filter. */
  hasCrossFilters: boolean;
}

/**
 * Encapsulates pipeline layers L1 (metric-ref resolution) and L3 (enrich + filter) for a
 * widget. Handles all filter scope partitioning and store subscriptions internally.
 *
 * @param widget  The widget whose rows are being resolved.
 * @param dataSource  The widget's primary data source (may be undefined while loading).
 */
export function useWidgetRows(
  widget: StudioWidget,
  dataSource: StudioDataSource | undefined,
): UseWidgetRowsResult {
  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const activePageId = useStudioSelector(selectActivePageId);

  const hasCrossFilters = React.useMemo(
    () =>
      filters.some(
        (f) =>
          f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id && f.pageId === activePageId,
      ) ||
      filters.some(
        (f) =>
          f.scope === 'interactive' && f.sourceWidgetId !== widget.id && f.pageId === activePageId,
      ),
    [filters, widget.id, activePageId],
  );

  const filteredRows = React.useMemo((): Row[] => {
    if (!dataSource?.rows) {
      return [];
    }
    const pageFilters = filters.filter((f) => f.scope === 'page');
    const widgetFilters = filters.filter(
      (f) => f.scope === 'widget' && f.widgetId === widget.id && f.filterMode !== 'rank',
    );
    const crossFilters = filters.filter(
      (f) =>
        f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id && f.pageId === activePageId,
    );
    const interactiveFilters = filters.filter(
      (f) =>
        f.scope === 'interactive' && f.sourceWidgetId !== widget.id && f.pageId === activePageId,
    );
    const allFilters = resolveMetricRefs(
      [...pageFilters, ...widgetFilters, ...crossFilters, ...interactiveFilters],
      dataSources,
    );
    return resolveRowsCached(
      dataSource.rows,
      widget.sourceId,
      allFilters,
      dataSources,
      relationships,
      expressionFields,
    );
  }, [
    dataSource,
    filters,
    dataSources,
    relationships,
    expressionFields,
    widget.id,
    widget.sourceId,
    activePageId,
  ]);

  const filteredRowsNoCross = React.useMemo((): Row[] => {
    if (!hasCrossFilters) {
      // Same reference — downstream memos short-circuit automatically.
      return filteredRows;
    }
    if (!dataSource?.rows) {
      return [];
    }
    const pageFilters = filters.filter((f) => f.scope === 'page');
    const widgetFilters = filters.filter(
      (f) => f.scope === 'widget' && f.widgetId === widget.id && f.filterMode !== 'rank',
    );
    const allFilters = resolveMetricRefs([...pageFilters, ...widgetFilters], dataSources);
    return resolveRowsCached(
      dataSource.rows,
      widget.sourceId,
      allFilters,
      dataSources,
      relationships,
      expressionFields,
    );
  }, [
    hasCrossFilters,
    filteredRows,
    dataSource,
    filters,
    dataSources,
    relationships,
    expressionFields,
    widget.id,
    widget.sourceId,
  ]);

  return { filteredRows, filteredRowsNoCross, hasCrossFilters };
}
