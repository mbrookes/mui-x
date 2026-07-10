'use client';

import * as React from 'react';
import type { StudioDataSource, StudioWidget, StudioWidgetConfig } from '../models';
import { isWidgetOfKind } from '../models';
import {
  useStudioSelector,
  selectFilters,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSources,
  makeSelectPartitionedFiltersForPage,
  makeSelectPartitionedBaseFiltersForPage,
  selectGlobalCrossFilterMode,
  selectCrossFilterAllPages,
} from '../context';
import { resolveRowsCached } from './resolvedRowsCache';
import { collectSelectFields } from './queryDescriptor';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { selectFiltersForWidget } from './filterScoping';
import { getCachedNormalizedDataSource } from './normalizedRowsCache';
import { useAdapterRows } from './useAdapterRows';
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
 * Encapsulates pipeline layers L2 (enrichment) and L3 (filtering) for a
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
  // For a many-to-many relationship the junction (bridge) source is included too, so a
  // junction-owned expression field targeted by a filter can be routed/enriched at L3
  // instead of being invisible here (mirrors `getReachableSourceIds`; finding 2.1).
  // Completely unrelated sources (e.g. PRODUCTS for an ORDER_ITEMS widget) are
  // excluded so that adding expressions there doesn't trigger a re-render here.
  const relevantSourceIds = React.useMemo(() => {
    const ids = new Set<string>();
    if (widget.sourceId) {
      ids.add(widget.sourceId);
      for (const rel of relationships) {
        if (rel.sourceId === widget.sourceId) {
          ids.add(rel.targetId);
          if (rel.type === 'many-to-many' && rel.junctionSourceId) {
            ids.add(rel.junctionSourceId);
          }
        } else if (rel.targetId === widget.sourceId) {
          ids.add(rel.sourceId);
          if (rel.type === 'many-to-many' && rel.junctionSourceId) {
            ids.add(rel.junctionSourceId);
          }
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

  const globalCrossFilterMode = useStudioSelector(selectGlobalCrossFilterMode);
  const crossFilterAllPages = useStudioSelector(selectCrossFilterAllPages);

  // ── Async adapter path ──────────────────────────────────────────────────
  const hasAdapter = Boolean(dataSource?.adapter);

  // Descriptor building, request-cache seeding/dedup, and async loading/error state are
  // encapsulated in useAdapterRows (behavior-preserving extraction).
  const { adapterRows, isLoading, isError, errorMessage } = useAdapterRows(
    widget,
    dataSource,
    pageId,
    filters,
    expressionFields,
    relationships,
    crossFilterAllPages,
  );

  // ── Sync (in-memory) path ───────────────────────────────────────────────

  // The filters that can actually reach this widget — same page/widget/cross/
  // interactive scoping `computeFilteredRows` applies below (via
  // `selectFiltersForWidget`), built from the already-partitioned buckets.
  // Used ONLY to derive `usedFieldIds` below; deliberately NOT deferred so the
  // field set stays correct even while the (deferred) row computation lags.
  const reachableFilters = React.useMemo(
    () =>
      selectFiltersForWidget(
        [
          ...partitioned.page,
          ...(partitioned.byWidgetId.get(widget.id) ?? []),
          ...partitioned.cross,
          ...partitioned.interactive,
        ],
        {
          widgetId: widget.id,
          widgetSourceId: widget.sourceId,
          activePageId: pageId,
          include: 'all',
          crossFilterAllPages,
        },
      ),
    [partitioned, widget.id, widget.sourceId, pageId, crossFilterAllPages],
  );

  // `selectFiltersForWidget`'s own 'widget' scope case unconditionally excludes
  // `filterMode === 'rank'` filters (handled as a special post-aggregation reduction
  // elsewhere, e.g. `useChartWidgetData`'s own `widgetRankFilter` lookup, not as an ordinary row
  // predicate) — so a WIDGET-scoped rank filter never appears in `reachableFilters` above.
  // Collected directly from the already page/widget-scoped `partitioned.byWidgetId` bucket (not
  // the raw dashboard-wide `filters`) so a widget-scoped "top N by measure" filter's field
  // widening below isn't silently skipped, while still never widening on a rank filter that
  // belongs to a DIFFERENT widget (finding 2.5).
  const widgetScopedRankFilters = React.useMemo(
    () =>
      (partitioned.byWidgetId.get(widget.id) ?? []).filter(
        (f) => !f.disabled && (f.filterMode ?? 'condition') === 'rank',
      ),
    [partitioned, widget.id],
  );

  // Compute the set of field IDs this widget actually uses in its config.
  // Passed to resolveRowsCached so enrichment is lazy-by-widget — adding an
  // unused expression field for the same source won't invalidate this widget's
  // enriched-rows cache slot. Scoped to `reachableFilters` (not the raw,
  // dashboard-wide `filters` array) so a filter on a different page, or a
  // widget-scoped filter that belongs to a different widget, can never widen
  // this widget's field set or change its cache key.
  const usedFieldIds = React.useMemo((): ReadonlySet<string> => {
    const ids = new Set(collectSelectFields(widget));
    // Also include any fields referenced in filters that can reach this widget
    // (they need to be enriched so the filter can evaluate against them).
    for (const f of [...reachableFilters, ...widgetScopedRankFilters]) {
      if (f.field) {
        ids.add(f.field);
      }
      // A rank-by-measure filter (e.g. "top 5 by profit") reduces on `rankByField`, a
      // field that need not otherwise appear anywhere in the widget's config or in `f.field`
      // (the group-by/dimension column). Without this, `rankByField` never enters L1/L2
      // enrichment scope, so its raw values are missing from the normalized/enriched row set
      // the rank reduction reads from (finding 2.5).
      if (f.rankByField) {
        ids.add(f.rankByField);
      }
    }
    return ids;
  }, [widget, reachableFilters, widgetScopedRankFilters]);

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
      deferredPartitioned.cross.some(
        (f) =>
          !f.disabled &&
          f.scope.kind === 'cross-filter' &&
          f.scope.sourceWidgetId !== widget.id &&
          (crossFilterAllPages || f.scope.pageId === pageId),
      ) ||
      deferredPartitioned.interactive.some(
        (f) =>
          f.scope.kind === 'interactive' &&
          f.scope.sourceWidgetId !== widget.id &&
          f.scope.pageId === pageId,
      ),
    [deferredPartitioned, widget.id, pageId, crossFilterAllPages],
  );

  // Separate boolean for chart-click cross-filters only — interactive (filter widget)
  // selections do NOT trigger ghost rendering, regardless of crossFilterMode.
  const hasChartCrossFilters = React.useMemo(
    () =>
      deferredPartitioned.cross.some(
        (f) =>
          !f.disabled &&
          f.scope.kind === 'cross-filter' &&
          f.scope.sourceWidgetId !== widget.id &&
          (crossFilterAllPages || f.scope.pageId === pageId),
      ),
    [deferredPartitioned, widget.id, pageId, crossFilterAllPages],
  );

  const crossFilterMode =
    globalCrossFilterMode ??
    (widget.config as StudioWidgetConfig)?.crossFilterMode ??
    'cross-highlight';

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

  // ── Filtered rows (sync + adapter unified) ──────────────────────────────
  // One closure both data paths call through `selectFiltersForWidget`
  // (filterScoping.ts, the single source of truth for filter scoping) so the three
  // scoping modes stay consistent across the sync and async-adapter paths instead of
  // each hand-encoding the page/widget/cross/interactive predicates (which previously
  // handled `crossFilterAllPages` and the `disabled` flag inconsistently on the
  // adapter path).
  //
  // include:
  //   'all'            → page + widget + cross-filter + interactive
  //   'no-cross'       → page + widget only
  //   'no-chart-cross' → page + widget + interactive (no chart-click cross-filters)
  const computeFilteredRows = React.useCallback(
    (include: 'all' | 'no-cross' | 'no-chart-cross'): Row[] => {
      if (hasAdapter) {
        // Page/widget filters were baked into descriptor.filter by the adapter; the
        // descriptor deliberately EXCLUDES cross-filters + interactive filters (built
        // with include:'no-cross' in buildQueryDescriptor), so this client-side pass is
        // the SOLE enforcement point for them — a chart cross-filter never triggers a
        // server round-trip or churns the request cacheKey. Routing through
        // selectFiltersForWidget keeps crossFilterAllPages / disabled / source-widget
        // handling identical to the sync path.
        if (!widget.sourceId) {
          return enrichedAdapterRows;
        }
        // Page-scoped rank filters (top/bottom-N) are stripped from the server descriptor
        // (`buildQueryDescriptor`) because the wire protocol can't express a rank reduction —
        // so they must be re-applied here, client-side, exactly as the sync path does via
        // `applyFilters` (finding 1.6). Non-rank page/widget filters were already enforced
        // server-side and are deliberately NOT re-applied.
        const pageRankFilters = deferredPartitioned.page.filter(
          (f) => (f.filterMode ?? 'condition') === 'rank',
        );
        const scoped = selectFiltersForWidget(
          [...pageRankFilters, ...deferredPartitioned.cross, ...deferredPartitioned.interactive],
          {
            widgetId: widget.id,
            widgetSourceId: widget.sourceId,
            activePageId: pageId,
            include,
            crossFilterAllPages,
          },
        );
        if (scoped.length === 0) {
          // Same reference — downstream memos short-circuit automatically.
          return enrichedAdapterRows;
        }
        return resolveRowsCached(
          enrichedAdapterRows,
          widget.sourceId,
          scoped,
          dataSources,
          relationships,
          expressionFields,
          usedFieldIds,
        );
      }
      if (!normalizedDataSource?.rows) {
        return [];
      }
      const scoped = selectFiltersForWidget(
        [
          ...deferredPartitioned.page,
          ...(deferredPartitioned.byWidgetId.get(widget.id) ?? []),
          ...deferredPartitioned.cross,
          ...deferredPartitioned.interactive,
        ],
        {
          widgetId: widget.id,
          widgetSourceId: widget.sourceId,
          activePageId: pageId,
          include,
          crossFilterAllPages,
        },
      );
      return resolveRowsCached(
        normalizedDataSource.rows,
        widget.sourceId,
        scoped,
        dataSources,
        relationships,
        expressionFields,
        usedFieldIds,
      );
    },
    [
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
      crossFilterAllPages,
      usedFieldIds,
    ],
  );

  const filteredRows = React.useMemo(() => computeFilteredRows('all'), [computeFilteredRows]);

  const filteredRowsNoCross = React.useMemo((): Row[] => {
    // No incoming cross/interactive filters → this baseline equals filteredRows;
    // return the same reference so downstream memos short-circuit automatically.
    if (!hasCrossFilters) {
      return filteredRows;
    }
    return computeFilteredRows('no-cross');
  }, [hasCrossFilters, filteredRows, computeFilteredRows]);

  const isRecomputing = !hasAdapter && deferredBasePartitioned !== basePartitioned;

  // ── filteredRowsNoChartCross ────────────────────────────────────────────
  // Page + widget + interactive (filter-widget) filters, but WITHOUT chart-click
  // cross-filters. Used as the "all rows" baseline for table cross-highlight mode:
  // interactive filters always hard-filter (BI norm), chart cross-filters drive the overlay.
  const filteredRowsNoChartCross = React.useMemo((): Row[] => {
    // No chart cross-filters → same reference as filteredRows (short-circuit).
    if (!hasChartCrossFilters) {
      return filteredRows;
    }
    return computeFilteredRows('no-chart-cross');
  }, [hasChartCrossFilters, filteredRows, computeFilteredRows]);

  // ── Cross-source column enrichment ─────────────────────────────────────
  // For grid widgets that have columns referencing many-to-one related sources,
  // join field values from those sources onto the primary rows by FK lookup.
  // Columns from sources without in-memory rows (async sources) are skipped.
  // Grid-column cross-source enrichment reads `columns` regardless of the widget's
  // kind (a non-grid widget simply has no `columns`), so read it through the flat
  // cross-kind `StudioWidgetConfig` patch type.
  const gridColumns = (widget.config as StudioWidgetConfig)?.columns;
  const crossSourceColumns = React.useMemo(
    () => (gridColumns ?? []).filter((c) => c.sourceId && c.sourceId !== widget.sourceId),
    [gridColumns, widget.sourceId],
  );

  // For map widgets, collect cross-source field refs from mapCountryField / mapValueField.
  const mapCrossSourceFields = React.useMemo(() => {
    if (!isWidgetOfKind(widget, 'map')) {
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
  }, [widget]);

  const hasCrossSourceColumns = crossSourceColumns.length > 0 || mapCrossSourceFields.length > 0;

  // Combine grid-column cross-source refs and map field refs into a single list for enrichment
  const allCrossSourceFieldRefs = React.useMemo(() => {
    const colRefs = crossSourceColumns.map((c) => ({ fieldId: c.fieldId, sourceId: c.sourceId! }));
    return [...colRefs, ...mapCrossSourceFields];
  }, [crossSourceColumns, mapCrossSourceFields]);

  // Shared cross-source enrichment: join FK-referenced columns from related sources
  // onto the primary rows. A no-op (returns the input reference) when the widget has
  // no cross-source columns, preserving reference stability for downstream memos.
  const enrichIfNeeded = React.useCallback(
    (rows: Row[]): Row[] =>
      hasCrossSourceColumns
        ? enrichWithCrossSourceFields(
            rows,
            widget.sourceId,
            allCrossSourceFieldRefs,
            dataSources,
            relationships,
          )
        : rows,
    [hasCrossSourceColumns, widget.sourceId, allCrossSourceFieldRefs, dataSources, relationships],
  );

  const enrichedFilteredRows = React.useMemo(
    () => enrichIfNeeded(filteredRows),
    [enrichIfNeeded, filteredRows],
  );

  const enrichedFilteredRowsNoCross = React.useMemo(
    () => enrichIfNeeded(filteredRowsNoCross),
    [enrichIfNeeded, filteredRowsNoCross],
  );

  const enrichedFilteredRowsNoChartCross = React.useMemo(
    () => enrichIfNeeded(filteredRowsNoChartCross),
    [enrichIfNeeded, filteredRowsNoChartCross],
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
