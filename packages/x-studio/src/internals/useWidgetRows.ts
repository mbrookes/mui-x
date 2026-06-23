'use client';

import * as React from 'react';
import type { StudioDataSource, StudioWidget } from '../models';
import {
  useStudioSelector,
  selectFilters,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSources,
  makeSelectPartitionedFiltersForPage,
  makeSelectPartitionedBaseFiltersForPage,
} from '../context';
import { resolveRowsCached } from './resolvedRowsCache';
import { buildQueryDescriptor, collectSelectFields } from './queryDescriptor';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { selectFiltersForWidget } from './filterScoping';
import { getCachedNormalizedDataSource } from './normalizedRowsCache';
import { studioRequestCache } from './StudioRequestCache';
import { enrichWithCrossSourceFields } from './crossSourceEnrichment';

type Row = Record<string, unknown>;

interface UseWidgetRowsResult {
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
 * @param pageId  The ID of the page this widget belongs to. Used to scope page-level and
 *   cross-filters so that mounted-but-inactive pages see only their own page's filters.
 */
export function useWidgetRows(
  widget: StudioWidget,
  dataSource: StudioDataSource | undefined,
  pageId: string,
): UseWidgetRowsResult {
  const filters = useStudioSelector(selectFilters);

  // Per-page filter selectors — scoped to this widget's own page, not the globally active page.
  // This ensures that mounted-but-hidden pages don't pick up the wrong page's filters.
  const selectPartitioned = React.useMemo(
    () => makeSelectPartitionedFiltersForPage(pageId),
    [pageId],
  );
  const selectBasePartitioned = React.useMemo(
    () => makeSelectPartitionedBaseFiltersForPage(pageId),
    [pageId],
  );

  const partitioned = useStudioSelector(selectPartitioned);
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
  const basePartitioned = useStudioSelector(selectBasePartitioned);
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

  // ── Async adapter path ──────────────────────────────────────────────────
  const hasAdapter = Boolean(dataSource?.adapter);

  // Descriptor is rebuilt whenever any state that affects it changes.
  const descriptor = React.useMemo(() => {
    if (!hasAdapter || !widget.sourceId) {
      return null;
    }
    return buildQueryDescriptor(widget, filters, pageId, dataSource?.tableName, expressionFields);
  }, [hasAdapter, widget, filters, pageId, dataSource, expressionFields]);

  // Async state: rows fetched from adapter.
  const [adapterRows, setAdapterRows] = React.useState<Row[]>(() => {
    if (!hasAdapter) {
      return [];
    }
    // Seed from cache synchronously on mount.
    const cached = descriptor ? studioRequestCache.get(descriptor.cacheKey) : undefined;
    if (cached) {
      return cached.rows;
    }
    // Fall back to source.rows as a display placeholder so the widget doesn't
    // flash empty while the adapter re-fetches on a cold cache (e.g. after page
    // navigation when source.rows was pre-populated by setDataSourceRows).
    return (dataSource?.rows as Row[] | undefined) ?? [];
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
        (f) => f.scopeV2.kind === 'cross-filter' && f.scopeV2.sourceWidgetId !== widget.id && f.scopeV2.pageId === pageId,
      ) ||
        deferredPartitioned.interactive.some(
          (f) => f.scopeV2.kind === 'interactive' && f.scopeV2.sourceWidgetId !== widget.id && f.scopeV2.pageId === pageId,
        )),
    [hasAdapter, deferredPartitioned, widget.id, pageId],
  );

  // Separate boolean for chart-click cross-filters only — interactive (filter widget)
  // selections do NOT trigger ghost rendering, regardless of crossFilterMode.
  const hasChartCrossFilters = React.useMemo(
    () =>
      !hasAdapter &&
      deferredPartitioned.cross.some((f) => f.scopeV2.kind === 'cross-filter' && f.scopeV2.sourceWidgetId !== widget.id && f.scopeV2.pageId === pageId),
    [hasAdapter, deferredPartitioned, widget.id, pageId],
  );

  const crossFilterMode = widget.config?.crossFilterMode ?? 'cross-highlight';

  // Ghost overlay should only render when:
  // 1. The widget is in 'cross-highlight' mode (default)
  // 2. There is a chart-click cross-filter active (never for interactive/filter-widget filters)
  const shouldShowGhost = crossFilterMode === 'cross-highlight' && hasChartCrossFilters;

  // Adapter/server responses contain only physical columns — expression (calculated)
  // fields are a client-side concept the server cannot produce. Enrich the returned raw
  // rows with expression columns here so KPIs/charts using a calculated value field (e.g.
  // `price - cost`) aggregate against real values instead of `undefined` (which renders $0).
  // No-op for aggregated responses where the requested fields are already physical.
  const enrichedAdapterRows = React.useMemo((): Row[] => {
    if (!hasAdapter || !widget.sourceId || adapterRows.length === 0) {
      return adapterRows;
    }
    return getCachedEnrichedRows(
      adapterRows,
      widget.sourceId,
      expressionFields,
      dataSources,
      relationships,
      usedFieldIds,
    );
  }, [
    hasAdapter,
    adapterRows,
    widget.sourceId,
    expressionFields,
    dataSources,
    relationships,
    usedFieldIds,
  ]);

  const filteredRows = React.useMemo((): Row[] => {
    if (hasAdapter) {
      return enrichedAdapterRows;
    }
    if (!normalizedDataSource?.rows) {
      return [];
    }
    const allFilters = selectFiltersForWidget(
      [
        ...deferredPartitioned.page,
        ...(deferredPartitioned.byWidgetId.get(widget.id) ?? []),
        ...deferredPartitioned.cross,
        ...deferredPartitioned.interactive,
      ],
      { widgetId: widget.id, widgetSourceId: widget.sourceId, activePageId: pageId },
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
    enrichedAdapterRows,
    normalizedDataSource,
    deferredPartitioned,
    dataSources,
    relationships,
    expressionFields,
    widget.id,
    widget.sourceId,
    pageId,
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
    const allFilters = selectFiltersForWidget(
      [
        ...deferredPartitioned.page,
        ...(deferredPartitioned.byWidgetId.get(widget.id) ?? []),
      ],
      { widgetId: widget.id, widgetSourceId: widget.sourceId, activePageId: pageId, include: 'no-cross' },
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
    const allFilters = selectFiltersForWidget(
      [
        ...deferredPartitioned.page,
        ...(deferredPartitioned.byWidgetId.get(widget.id) ?? []),
        ...deferredPartitioned.interactive,
      ],
      { widgetId: widget.id, widgetSourceId: widget.sourceId, activePageId: pageId, include: 'no-chart-cross' },
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
    pageId,
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
