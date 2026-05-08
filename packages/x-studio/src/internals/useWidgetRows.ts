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
  selectPartitionedFilters,
} from '../context';
import { resolveMetricRefs } from './chartUtils';
import { resolveRowsCached } from './resolvedRowsCache';
import { buildQueryDescriptor, collectSelectFields } from './queryDescriptor';
import { getCachedNormalizedDataSource } from './normalizedRowsCache';
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
  const partitioned = useStudioSelector(selectPartitionedFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  // expressionFields: use the full set (all sources) so that cross-filter foreign
  // source enrichment in resolveRows can evaluate expression fields like
  // expr-order-country (ORDERS source) when this widget is on ORDER_ITEMS.
  // Source-scoped optimization is correct for useChartWidgetData/KPI/Grid/Filter
  // (own-source aggregations only) but NOT here where resolveRows may enrich
  // any foreign source referenced by an incoming cross-filter.
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

  // Compute the set of field IDs this widget actually uses in its config.
  // Passed to resolveRowsCached so enrichment is lazy-by-widget — adding an
  // unused expression field for the same source won't invalidate this widget's
  // enriched-rows cache slot.
  const usedFieldIds = React.useMemo((): ReadonlySet<string> => {
    const ids = new Set(collectSelectFields(widget));
    // Also include any fields referenced in active filters (they need to be
    // enriched so the filter can evaluate against them).
    for (const f of filters) {
      if (f.field) {
        ids.add(f.field);
      }
    }
    return ids;
  }, [widget, filters]);

  // ── Lazy per-widget normalization (L1) ─────────────────────────────────
  // The store holds raw data sources. Each widget normalizes only the fields it
  // uses — date conversion and fieldDistinctValues building are scoped to
  // usedFieldIds so adding an unused field to a different widget is zero cost.
  const normalizedDataSource = React.useMemo((): StudioDataSource | undefined => {
    if (!dataSource) {
      return undefined;
    }
    return getCachedNormalizedDataSource(dataSource, usedFieldIds);
  }, [dataSource, usedFieldIds]);

  const hasCrossFilters = React.useMemo(
    () =>
      !hasAdapter &&
      (partitioned.cross.some(
        (f) => f.sourceWidgetId !== widget.id && f.pageId === activePageId,
      ) ||
        partitioned.interactive.some(
          (f) => f.sourceWidgetId !== widget.id && f.pageId === activePageId,
        )),
    [hasAdapter, partitioned, widget.id, activePageId],
  );

  const filteredRows = React.useMemo((): Row[] => {
    if (hasAdapter) {
      return adapterRows;
    }
    if (!normalizedDataSource?.rows) {
      return [];
    }
    const pageFilters = partitioned.page;
    const widgetFilters = (partitioned.byWidgetId.get(widget.id) ?? []).filter(
      (f) => f.filterMode !== 'rank',
    );
    const crossFilters = partitioned.cross.filter(
      (f) => f.sourceWidgetId !== widget.id && f.pageId === activePageId,
    );
    const interactiveFilters = partitioned.interactive.filter(
      (f) => f.sourceWidgetId !== widget.id && f.pageId === activePageId,
    );
    const allFilters = resolveMetricRefs(
      [...pageFilters, ...widgetFilters, ...crossFilters, ...interactiveFilters],
      dataSources,
    );
    return resolveRowsCached(
      normalizedDataSource.rows,
      widget.sourceId,
      allFilters,
      dataSources,
      relationships,
      expressionFields,
      usedFieldIds,
    );
  }, [
    hasAdapter,
    adapterRows,
    normalizedDataSource,
    partitioned,
    dataSources,
    relationships,
    expressionFields,
    widget.id,
    widget.sourceId,
    widget.config,
    activePageId,
    usedFieldIds,
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
    if (!normalizedDataSource?.rows) {
      return [];
    }
    const pageFilters = partitioned.page;
    const widgetFilters = (partitioned.byWidgetId.get(widget.id) ?? []).filter(
      (f) => f.filterMode !== 'rank',
    );
    const allFilters = resolveMetricRefs([...pageFilters, ...widgetFilters], dataSources);
    return resolveRowsCached(
      normalizedDataSource.rows,
      widget.sourceId,
      allFilters,
      dataSources,
      relationships,
      expressionFields,
      usedFieldIds,
    );
  }, [
    hasAdapter,
    hasCrossFilters,
    filteredRows,
    normalizedDataSource,
    partitioned,
    dataSources,
    relationships,
    expressionFields,
    widget.id,
    widget.sourceId,
    widget.config,
    usedFieldIds,
  ]);

  return { filteredRows, filteredRowsNoCross, hasCrossFilters, isLoading };
}
