'use client';

import * as React from 'react';
import type { StudioDataSource, StudioWidget } from '../models';
import {
  useStudioSelector,
  selectFilters,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSources,
  selectActivePageId,
  selectPartitionedFilters,
  selectPartitionedBaseFilters,
} from '../context';
import { resolveMetricRefs } from './chartUtils';
import { resolveRowsCached } from './resolvedRowsCache';
import { buildQueryDescriptor, collectSelectFields } from './queryDescriptor';
import { getCachedNormalizedDataSource } from './normalizedRowsCache';
import { studioRequestCache } from './StudioRequestCache';
import { enrichWithCrossSourceFields } from './crossSourceEnrichment';

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
  /**
   * Rows after applying page, widget, and interactive (filter-widget) filters, but WITHOUT
   * chart-click cross-filters (`scope: 'cross-filter'`).
   *
   * This is the correct "all rows" baseline for table cross-highlight mode: interactive
   * filter-widget selections are always hard-filtered (BI norm), while chart cross-filters
   * drive the highlight/dim overlay. When no chart cross-filters are active, this is the
   * same reference as `filteredRows`.
   */
  filteredRowsNoChartCross: Row[];
  /** Whether this widget has at least one incoming cross-filter or interactive filter. */
  hasCrossFilters: boolean;
  /**
   * True when there is at least one incoming chart-click cross-filter (`scope: 'cross-filter'`)
   * from another widget on the active page.
   */
  hasChartCrossFilters: boolean;
  /**
   * True when a ghost overlay should be rendered for this widget.
   *
   * This is true only when ALL of the following hold:
   * - The widget's `crossFilterMode` is `'cross-highlight'` (the default)
   * - There is at least one incoming **chart-click** cross-filter (`scope: 'cross-filter'`)
   *
   * Interactive (filter widget) selections never trigger ghost rendering because dedicated
   * filter controls always act as hard filters, regardless of the target widget's mode.
   */
  shouldShowGhost: boolean;
  /**
   * The rows the widget should use as its primary dataset.
   * - `'none'` mode: equals `filteredRowsNoCross` (cross-filters are ignored)
   * - All other modes: equals `filteredRows`
   */
  effectiveRows: Row[];
  /**
   * True while an async adapter fetch is in progress.
   * Always false for sources without an adapter (sync path).
   */
  isLoading: boolean;
  /** True while cross-filter or page-filter changes are being applied via React's deferred rendering. Always false for adapter-based sources (use isLoading instead). */
  isRecomputing: boolean;
  /**
   * True when the last async adapter fetch failed.
   * Cleared when a subsequent fetch succeeds.
   * Always false for sources without an adapter (sync path).
   */
  isError: boolean;
  /**
   * Human-readable error message from the last failed adapter fetch.
   * Empty string when there is no error.
   */
  errorMessage: string;
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
  const rawDeferredPartitioned = React.useDeferredValue(partitioned);
  // When cross-filters are being *removed* (live count < deferred count), use the
  // live value immediately — there's no heavy computation and the extra deferred
  // render cycle makes removal feel sluggish. Only defer when adding filters (which
  // requires a new row-filtering pass that may be expensive).
  const deferredPartitioned =
    partitioned.cross.length < rawDeferredPartitioned.cross.length
      ? partitioned
      : rawDeferredPartitioned;
  // Separate deferred for isRecomputing — only triggers the loading overlay
  // for page/widget filter changes, not cross-filter or interactive changes.
  const basePartitioned = useStudioSelector(selectPartitionedBaseFilters);
  const deferredBasePartitioned = React.useDeferredValue(basePartitioned);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  // expressionFields: subscribe to own source + all directly related sources.
  // Own source is needed for self-enrichment; related sources are needed so that
  // resolveRows can enrich foreign source rows when evaluating cross-filters
  // (e.g. expr-order-country on ORDERS when this widget is on ORDER_ITEMS).
  // Completely unrelated sources (e.g. PRODUCTS for an ORDER_ITEMS widget) are
  // excluded so that adding expressions there doesn't trigger a re-render here.
  const relevantSourceIds = React.useMemo(() => {
    const ids = new Set<string>();
    if (widget.sourceId) {
      ids.add(widget.sourceId);
      for (const rel of relationships) {
        if (rel.sourceId === widget.sourceId) {
          ids.add(rel.targetId);
        } else if (rel.targetId === widget.sourceId) {
          ids.add(rel.sourceId);
        }
      }
    }
    return ids;
  }, [widget.sourceId, relationships]);

  const selectExprFields = React.useMemo(
    () => makeSelectExpressionFieldsForSources(relevantSourceIds),
    [relevantSourceIds],
  );
  const expressionFields = useStudioSelector(selectExprFields);
  const activePageId = useStudioSelector(selectActivePageId);

  // ── Async adapter path ──────────────────────────────────────────────────
  const hasAdapter = Boolean(dataSource?.adapter);

  // Descriptor is rebuilt whenever any state that affects it changes.
  const descriptor = React.useMemo(() => {
    if (!hasAdapter || !widget.sourceId) {
      return null;
    }
    return buildQueryDescriptor(widget, filters, activePageId, dataSource?.tableName);
  }, [hasAdapter, widget, filters, activePageId]);

  // Async state: rows fetched from adapter.
  const [adapterRows, setAdapterRows] = React.useState<Row[]>(() => {
    if (!hasAdapter) {
      return [];
    }
    // Seed from cache synchronously on mount.
    const cached = descriptor ? studioRequestCache.get(descriptor.cacheKey) : undefined;
    return cached ? cached.rows : [];
  });
  // react-doctor-disable-next-line react-doctor/rendering-usetransition-loading -- isLoading guards an async data fetch (adapter.getRows), not a state transition
  const [isLoading, setIsLoading] = React.useState(false);
  const [isError, setIsError] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- multiple setState calls are intentional: they atomically update related async fetch state
  React.useEffect(() => {
    if (!descriptor || !dataSource?.adapter) {
      return;
    }

    const { cacheKey } = descriptor;
    const cached = studioRequestCache.get(cacheKey);

    if (cached) {
      // Cache hit — serve synchronously, no loading state.
      setAdapterRows(cached.rows);
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- resetting error state on new descriptor is intentional
      setIsError(false);
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- resetting error state on new descriptor is intentional
      setErrorMessage('');
      return;
    }

    // Check for an existing in-flight request to deduplicate.
    let promise = studioRequestCache.getInflight(cacheKey);
    if (!promise) {
      promise = studioRequestCache.addInflight(cacheKey, dataSource.adapter.getRows(descriptor));
    }

    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- setting loading state when descriptor changes triggers a new fetch
    setIsLoading(true);
    let cancelled = false;

    promise.then(
      (result) => {
        if (!cancelled) {
          setAdapterRows(result.rows);
          setIsLoading(false);
          setIsError(false);
          setErrorMessage('');
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setIsLoading(false);
          setIsError(true);
          setErrorMessage(err instanceof Error ? err.message : 'Failed to load data');
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
      (deferredPartitioned.cross.some(
        (f) => f.sourceWidgetId !== widget.id && f.pageId === activePageId,
      ) ||
        deferredPartitioned.interactive.some(
          (f) => f.sourceWidgetId !== widget.id && f.pageId === activePageId,
        )),
    [hasAdapter, deferredPartitioned, widget.id, activePageId],
  );

  // Separate boolean for chart-click cross-filters only — interactive (filter widget)
  // selections do NOT trigger ghost rendering, regardless of crossFilterMode.
  const hasChartCrossFilters = React.useMemo(
    () =>
      !hasAdapter &&
      deferredPartitioned.cross.some(
        (f) => f.sourceWidgetId !== widget.id && f.pageId === activePageId,
      ),
    [hasAdapter, deferredPartitioned, widget.id, activePageId],
  );

  const crossFilterMode = widget.config?.crossFilterMode ?? 'cross-highlight';

  // Ghost overlay should only render when:
  // 1. The widget is in 'cross-highlight' mode (default)
  // 2. There is a chart-click cross-filter active (never for interactive/filter-widget filters)
  const shouldShowGhost = crossFilterMode === 'cross-highlight' && hasChartCrossFilters;

  const filteredRows = React.useMemo((): Row[] => {
    if (hasAdapter) {
      return adapterRows;
    }
    if (!normalizedDataSource?.rows) {
      return [];
    }
    const pageFilters = deferredPartitioned.page;
    const widgetFilters = (deferredPartitioned.byWidgetId.get(widget.id) ?? []).filter(
      (f) => f.filterMode !== 'rank',
    );
    const crossFilters = deferredPartitioned.cross.filter(
      (f) => f.sourceWidgetId !== widget.id && f.pageId === activePageId,
    );
    const interactiveFilters = deferredPartitioned.interactive.filter(
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
    deferredPartitioned,
    dataSources,
    relationships,
    expressionFields,
    widget.id,
    widget.sourceId,
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
    const pageFilters = deferredPartitioned.page;
    const widgetFilters = (deferredPartitioned.byWidgetId.get(widget.id) ?? []).filter(
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
    deferredPartitioned,
    dataSources,
    relationships,
    expressionFields,
    widget.id,
    widget.sourceId,
    usedFieldIds,
  ]);

  const isRecomputing = !hasAdapter && deferredBasePartitioned !== basePartitioned;

  // ── filteredRowsNoChartCross ────────────────────────────────────────────
  // Page + widget + interactive (filter-widget) filters, but WITHOUT chart-click
  // cross-filters. Used as the "all rows" baseline for table cross-highlight mode:
  // interactive filters always hard-filter (BI norm), chart cross-filters drive the overlay.
  const filteredRowsNoChartCross = React.useMemo((): Row[] => {
    if (hasAdapter) {
      return filteredRows;
    }
    if (!hasChartCrossFilters) {
      // No chart cross-filters — same reference as filteredRows (short-circuit).
      return filteredRows;
    }
    if (!normalizedDataSource?.rows) {
      return [];
    }
    const pageFilters = deferredPartitioned.page;
    const widgetFilters = (deferredPartitioned.byWidgetId.get(widget.id) ?? []).filter(
      (f) => f.filterMode !== 'rank',
    );
    const interactiveFilters = deferredPartitioned.interactive.filter(
      (f) => f.sourceWidgetId !== widget.id && f.pageId === activePageId,
    );
    const allFilters = resolveMetricRefs(
      [...pageFilters, ...widgetFilters, ...interactiveFilters],
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
    hasChartCrossFilters,
    filteredRows,
    normalizedDataSource,
    deferredPartitioned,
    dataSources,
    relationships,
    expressionFields,
    widget.id,
    widget.sourceId,
    activePageId,
    usedFieldIds,
  ]);

  // ── Cross-source column enrichment ─────────────────────────────────────
  // For grid widgets that have columns referencing many-to-one related sources,
  // join field values from those sources onto the primary rows by FK lookup.
  // Columns from sources without in-memory rows (async sources) are skipped.
  const crossSourceColumns = React.useMemo(
    () =>
      (widget.config?.columns ?? []).filter((c) => c.sourceId && c.sourceId !== widget.sourceId),
    [widget.config?.columns, widget.sourceId],
  );

  // For map widgets, collect cross-source field refs from mapCountryField / mapValueField.
  const mapCrossSourceFields = React.useMemo(() => {
    if (widget.kind !== 'map') {
      return [];
    }
    const refs = [];
    const { mapCountryField, mapCountrySourceId, mapValueField, mapValueSourceId } =
      widget.config ?? {};
    if (mapCountryField && mapCountrySourceId && mapCountrySourceId !== widget.sourceId) {
      refs.push({ fieldId: mapCountryField, sourceId: mapCountrySourceId });
    }
    if (mapValueField && mapValueSourceId && mapValueSourceId !== widget.sourceId) {
      refs.push({ fieldId: mapValueField, sourceId: mapValueSourceId });
    }
    return refs;
  }, [widget.kind, widget.config, widget.sourceId]);

  const hasCrossSourceColumns = crossSourceColumns.length > 0 || mapCrossSourceFields.length > 0;

  // Combine grid-column cross-source refs and map field refs into a single list for enrichment
  const allCrossSourceFieldRefs = React.useMemo(() => {
    const colRefs = crossSourceColumns.map((c) => ({ fieldId: c.fieldId, sourceId: c.sourceId! }));
    return [...colRefs, ...mapCrossSourceFields];
  }, [crossSourceColumns, mapCrossSourceFields]);

  const enrichedFilteredRows = React.useMemo(
    () =>
      hasCrossSourceColumns
        ? enrichWithCrossSourceFields(
            filteredRows,
            widget.sourceId,
            allCrossSourceFieldRefs,
            dataSources,
            relationships,
          )
        : filteredRows,
    [
      hasCrossSourceColumns,
      filteredRows,
      widget.sourceId,
      allCrossSourceFieldRefs,
      dataSources,
      relationships,
    ],
  );

  const enrichedFilteredRowsNoCross = React.useMemo(
    () =>
      hasCrossSourceColumns
        ? enrichWithCrossSourceFields(
            filteredRowsNoCross,
            widget.sourceId,
            allCrossSourceFieldRefs,
            dataSources,
            relationships,
          )
        : filteredRowsNoCross,
    [
      hasCrossSourceColumns,
      filteredRowsNoCross,
      widget.sourceId,
      allCrossSourceFieldRefs,
      dataSources,
      relationships,
    ],
  );

  const enrichedFilteredRowsNoChartCross = React.useMemo(
    () =>
      hasCrossSourceColumns
        ? enrichWithCrossSourceFields(
            filteredRowsNoChartCross,
            widget.sourceId,
            allCrossSourceFieldRefs,
            dataSources,
            relationships,
          )
        : filteredRowsNoChartCross,
    [
      hasCrossSourceColumns,
      filteredRowsNoChartCross,
      widget.sourceId,
      allCrossSourceFieldRefs,
      dataSources,
      relationships,
    ],
  );

  const enrichedEffectiveRows =
    crossFilterMode === 'none' ? enrichedFilteredRowsNoCross : enrichedFilteredRows;

  return {
    filteredRows: enrichedFilteredRows,
    filteredRowsNoCross: enrichedFilteredRowsNoCross,
    filteredRowsNoChartCross: enrichedFilteredRowsNoChartCross,
    hasCrossFilters,
    hasChartCrossFilters,
    shouldShowGhost,
    effectiveRows: enrichedEffectiveRows,
    isLoading,
    isRecomputing,
    isError,
    errorMessage,
  };
}
