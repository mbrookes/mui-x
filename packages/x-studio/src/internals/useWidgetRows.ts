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
import { buildQueryDescriptor } from './queryDescriptor';
import { studioRequestCache } from './StudioRequestCache';

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
  /**
   * True while an async adapter fetch is in progress.
   * Always false for sources without an adapter (sync path).
   */
  isLoading: boolean;
}

/**
 * Encapsulates pipeline layers L1 (metric-ref resolution) and L3 (enrich + filter) for a
 * widget. Handles all filter scope partitioning and store subscriptions internally.
 *
 * When `dataSource.adapter` is set, the async path is used instead of the in-memory pipeline.
 * The hook returns stale data immediately while a fresh fetch is in-flight (`isLoading: true`).
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

  // ── Async adapter path ──────────────────────────────────────────────────
  const hasAdapter = Boolean(dataSource?.adapter);

  // Descriptor is rebuilt whenever any state that affects it changes.
  const descriptor = React.useMemo(() => {
    if (!hasAdapter || !widget.sourceId) {
      return null;
    }
    return buildQueryDescriptor(widget, filters, activePageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAdapter, widget, filters, activePageId]);

  // Async state: rows fetched from adapter.
  const [adapterRows, setAdapterRows] = React.useState<Row[]>(() => {
    if (!hasAdapter) return [];
    // Seed from cache synchronously on mount.
    const cached = descriptor ? studioRequestCache.get(descriptor.cacheKey) : undefined;
    return cached ? cached.rows : [];
  });
  const [isLoading, setIsLoading] = React.useState(false);

  React.useEffect(() => {
    if (!descriptor || !dataSource?.adapter) {
      return;
    }

    const { cacheKey } = descriptor;
    const cached = studioRequestCache.get(cacheKey);

    if (cached) {
      // Cache hit — serve synchronously, no loading state.
      setAdapterRows(cached.rows);
      return;
    }

    // Check for an existing in-flight request to deduplicate.
    let promise = studioRequestCache.getInflight(cacheKey);
    if (!promise) {
      promise = studioRequestCache.addInflight(cacheKey, dataSource.adapter.getRows(descriptor));
    }

    setIsLoading(true);
    let cancelled = false;

    promise.then(
      (result) => {
        if (!cancelled) {
          setAdapterRows(result.rows);
          setIsLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setIsLoading(false);
        }
      },
    );

    // eslint-disable-next-line consistent-return
    return () => {
      cancelled = true;
    };
  }, [descriptor, dataSource]);

  // ── Sync (in-memory) path ───────────────────────────────────────────────

  const hasCrossFilters = React.useMemo(
    () =>
      !hasAdapter &&
      (filters.some(
        (f) =>
          f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id && f.pageId === activePageId,
      ) ||
        filters.some(
          (f) =>
            f.scope === 'interactive' &&
            f.sourceWidgetId !== widget.id &&
            f.pageId === activePageId,
        )),
    [hasAdapter, filters, widget.id, activePageId],
  );

  const filteredRows = React.useMemo((): Row[] => {
    if (hasAdapter) {
      return adapterRows;
    }
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
    hasAdapter,
    adapterRows,
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
    if (hasAdapter) {
      // Adapter path: descriptor already scopes all filters, so there is no
      // "noCross" distinction — return the same reference.
      return filteredRows;
    }
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
    hasAdapter,
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

  return { filteredRows, filteredRowsNoCross, hasCrossFilters, isLoading };
}
