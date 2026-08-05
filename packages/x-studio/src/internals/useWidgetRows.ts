'use client';

import * as React from 'react';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioWidget,
  StudioWidgetConfig,
} from '../models';
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
import { selectFiltersForWidget, selectAdapterResidualFilters } from './filterScoping';
import { getCachedNormalizedDataSource } from './normalizedRowsCache';
import { shouldApplyWidgetRankAtL3 } from './StudioPipeline';
import { useAdapterRows } from './useAdapterRows';
import { enrichWithCrossSourceFields } from './crossSourceEnrichment';
import type { CrossSourceFieldRef } from './crossSourceEnrichment';

type Row = Record<string, unknown>;

/**
 * Reference-stable empty cross-source field list. Returning a fresh `[]` from the
 * `mapCrossSourceFields` memo for every non-map widget would invalidate every downstream
 * enrichment memo on each render.
 */
const EMPTY_CROSS_SOURCE_FIELD_REFS: CrossSourceFieldRef[] = [];

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
   * - `'none'` mode: equals `filteredRowsNoChartCross` (chart cross-filters are ignored, but
   *   interactive/hard filters still apply — see `shouldShowGhost` doc above)
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
  /**
   * The widget's fully resolved/scoped filter set for `include: 'all'` (page + widget +
   * cross-filter + interactive), derived from the SAME deferred filter snapshot the rows were
   * produced from. Consumers doing L4 re-anchoring (chart `useChartRows`, KPI grain-anchoring)
   * must use this rather than re-deriving from the live `selectFilters` array, so a deferred-window
   * render never pairs stale rows with a newer filter list. Pairs with `filteredRows`.
   *
   * EXCLUDES widget-scoped RANK (Top-N) filters. `selectFiltersForWidget` drops
   * `filterMode === 'rank'` unless `includeWidgetRank` is set, and these sets are built
   * without it — deliberately, because chart consumers re-rank post-aggregation and must
   * not see rank as an ordinary predicate (that is what `widgetScopedRankFilters` is for).
   * So for a non-chart kind, where `shouldApplyWidgetRankAtL3` is true, the ROWS were
   * additionally reduced by a rank filter this list does not contain. "Pairs with" below
   * means the same deferred SNAPSHOT, not an identical filter list: a non-chart consumer
   * that needs the full effective set must append `widgetScopedRankFilters`.
   */
  resolvedFiltersAll: StudioFilterState[];
  /**
   * The widget's resolved/scoped filter set for `include: 'no-cross'` (page + widget only),
   * derived from the same deferred snapshot as the rows. Pairs with `filteredRowsNoCross`.
   *
   * EXCLUDES widget-scoped RANK (Top-N) filters. `selectFiltersForWidget` drops
   * `filterMode === 'rank'` unless `includeWidgetRank` is set, and these sets are built
   * without it — deliberately, because chart consumers re-rank post-aggregation and must
   * not see rank as an ordinary predicate (that is what `widgetScopedRankFilters` is for).
   * So for a non-chart kind, where `shouldApplyWidgetRankAtL3` is true, the ROWS were
   * additionally reduced by a rank filter this list does not contain. "Pairs with" below
   * means the same deferred SNAPSHOT, not an identical filter list: a non-chart consumer
   * that needs the full effective set must append `widgetScopedRankFilters`.
   */
  resolvedFiltersNoCross: StudioFilterState[];
  /**
   * The widget's resolved/scoped filter set for `include: 'no-chart-cross'` (page + widget +
   * interactive, no chart-click cross-filters), derived from the same deferred snapshot as the
   * rows. Pairs with `filteredRowsNoChartCross` — the correct chart ghost/tooltip "all rows"
   * baseline.
   *
   * EXCLUDES widget-scoped RANK (Top-N) filters. `selectFiltersForWidget` drops
   * `filterMode === 'rank'` unless `includeWidgetRank` is set, and these sets are built
   * without it — deliberately, because chart consumers re-rank post-aggregation and must
   * not see rank as an ordinary predicate (that is what `widgetScopedRankFilters` is for).
   * So for a non-chart kind, where `shouldApplyWidgetRankAtL3` is true, the ROWS were
   * additionally reduced by a rank filter this list does not contain. "Pairs with" below
   * means the same deferred SNAPSHOT, not an identical filter list: a non-chart consumer
   * that needs the full effective set must append `widgetScopedRankFilters`.
   */
  resolvedFiltersNoChartCross: StudioFilterState[];
  /**
   * The widget's own WIDGET-scoped rank (Top-N) filters, derived from the same deferred snapshot
   * as the rows. Exposed so the chart's post-aggregation rank re-application consumes the deferred
   * filter list rather than re-deriving from the live `selectFilters` array. Empty
   * for widgets with no widget-scoped rank filter.
   */
  widgetScopedRankFilters: StudioFilterState[];
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
  // When cross-filters OR interactive (filter-widget) filters are being *removed* (live count
  // < deferred count), use the live value immediately — there's no heavy computation and the
  // extra deferred render cycle makes removal feel sluggish. Only defer when adding filters
  // (which requires a new row-filtering pass that may be expensive). The interactive partition
  // is mirrored alongside `cross` here: clearing a filter-widget selection has the
  // same "removal is cheap" rationale as clearing a chart cross-filter, so it takes the fast
  // path too instead of lagging through the deferred cycle.
  const isFilterRemoval =
    partitioned.cross.length < rawDeferredPartitioned.cross.length ||
    partitioned.interactive.length < rawDeferredPartitioned.interactive.length;
  const deferredPartitioned = isFilterRemoval ? partitioned : rawDeferredPartitioned;
  // Separate deferred for isRecomputing — only triggers the loading overlay
  // for page/widget filter changes, not cross-filter or interactive changes.
  const basePartitioned = useStudioSelector(selectBasePartitioned);
  const deferredBasePartitioned = React.useDeferredValue(basePartitioned);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  // expressionFields: subscribe to own source + all directly related sources. Own source is needed
  // for self-enrichment; related sources are needed so that resolveRows can enrich foreign source
  // rows when evaluating cross-filters (e.g. expr-order-country on ORDERS when this widget is on
  // ORDER_ITEMS). For a many-to-many relationship the junction (bridge) source is included too, so
  // a junction-owned expression field targeted by a filter can be routed/enriched at L3 instead of
  // being invisible here (mirrors `getReachableSourceIds`). Completely unrelated sources (e.g.
  // PRODUCTS for an ORDER_ITEMS widget) are excluded so that adding expressions there doesn't
  // trigger a re-render here.
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
  const {
    adapterRows,
    isPlaceholder: adapterRowsArePlaceholder,
    isLoading,
    isError,
    errorMessage,
  } = useAdapterRows(
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
  // Used ONLY to derive `usedFieldIds` below; built from `deferredPartitioned`
  // (NOT the live `partitioned`) so the enrichment field set is driven by the SAME
  // filter snapshot the row-filtering path actually consumes below.
  // If this used the live filters instead, then during the deferred window a removed/
  // disabled expression-field-only filter would drop its field from `usedFieldIds` on
  // the urgent render while the still-deferred row filtering evaluated that filter against
  // rows no longer enriched for the field — a transient flash-to-blank plus a guaranteed
  // cache miss (the field-set segment of the cache key changed). Deriving from
  // `deferredPartitioned` keeps enrichment an exact superset of what filtering references
  // at every render, without over-widening in steady state (live === deferred there).
  const reachableFilters = React.useMemo(
    () =>
      selectFiltersForWidget(
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
          include: 'all',
          crossFilterAllPages,
        },
      ),
    [deferredPartitioned, widget.id, widget.sourceId, pageId, crossFilterAllPages],
  );

  // The 'no-cross' companion to `reachableFilters` (page + widget only), built from the SAME
  // `deferredPartitioned` snapshot. Exposed as `resolvedFiltersNoCross` so L4 re-anchoring
  // consumers (chart / KPI) can pair the filter set with `filteredRowsNoCross` — which came from
  // the same deferred snapshot — instead of re-deriving from the live `selectFilters` array and
  // skewing during a deferred window. `reachableFilters` (include:'all') is exposed
  // as `resolvedFiltersAll`.
  const resolvedFiltersNoCross = React.useMemo(
    () =>
      selectFiltersForWidget(
        [...deferredPartitioned.page, ...(deferredPartitioned.byWidgetId.get(widget.id) ?? [])],
        {
          widgetId: widget.id,
          widgetSourceId: widget.sourceId,
          activePageId: pageId,
          include: 'no-cross',
          crossFilterAllPages,
        },
      ),
    [deferredPartitioned, widget.id, widget.sourceId, pageId, crossFilterAllPages],
  );

  // The 'no-chart-cross' companion (page + widget + interactive, but WITHOUT chart-click
  // cross-filters), built from the SAME `deferredPartitioned` snapshot. Exposed as
  // `resolvedFiltersNoChartCross` so the chart ghost/tooltip L4 re-anchoring can pair this filter
  // set with `filteredRowsNoChartCross` (which came from the same snapshot) — interactive
  // filter-widget selections are always hard-filtered per BI norm, so the chart "all rows"
  // baseline must keep them while excluding chart cross-filters. Includes the
  // `interactive` bucket (unlike `resolvedFiltersNoCross`) since `include: 'no-chart-cross'`
  // keeps interactive filters.
  const resolvedFiltersNoChartCross = React.useMemo(
    () =>
      selectFiltersForWidget(
        [
          ...deferredPartitioned.page,
          ...(deferredPartitioned.byWidgetId.get(widget.id) ?? []),
          ...deferredPartitioned.interactive,
        ],
        {
          widgetId: widget.id,
          widgetSourceId: widget.sourceId,
          activePageId: pageId,
          include: 'no-chart-cross',
          crossFilterAllPages,
        },
      ),
    [deferredPartitioned, widget.id, widget.sourceId, pageId, crossFilterAllPages],
  );

  // `selectFiltersForWidget`'s own 'widget' scope case unconditionally excludes
  // `filterMode === 'rank'` filters (handled as a special post-aggregation reduction
  // elsewhere, e.g. `useChartWidgetData`'s own `widgetRankFilter` lookup, not as an ordinary row
  // predicate) — so a WIDGET-scoped rank filter never appears in `reachableFilters` above.
  // Collected directly from the already page/widget-scoped `deferredPartitioned.byWidgetId`
  // bucket (not the raw dashboard-wide `filters`) so a widget-scoped "top N by measure" filter's
  // field widening below isn't silently skipped, while still never widening on a rank filter that
  // belongs to a DIFFERENT widget. Uses `deferredPartitioned` (not live) to stay in
  // lockstep with the row-filtering snapshot, exactly like `reachableFilters` above.
  const widgetScopedRankFilters = React.useMemo(
    () =>
      (deferredPartitioned.byWidgetId.get(widget.id) ?? []).filter(
        (f) => !f.disabled && (f.filterMode ?? 'condition') === 'rank',
      ),
    [deferredPartitioned, widget.id],
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
      // the rank reduction reads from.
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

  // The adapter path needs L1 just as much as the sync path does — arguably more, since the
  // shapes L1 exists to canonicalize are exactly what a SQL driver hands back. Adapter rows used
  // to go straight into L2/L3 unnormalized, so:
  //   - a zone-less `'2024-01-15T23:30:00'` (what MySQL/SQLite drivers routinely return, called
  //     out by name in `temporalUtils`' `CANONICAL_DATETIME`) denotes no definite instant: the
  //     filter engine reads it as LOCAL time (`filterUtils.toComparable` → `normalizeToDateOnlyString`)
  //     while chart grouping reads its UTC components (`truncateToPeriod`), so for a viewer behind
  //     UTC one timestamp landed in two different day buckets — and the SAME dashboard on an
  //     in-memory source (which does get L1) agreed with neither;
  //   - a raw `Date` (a host reviving JSON dates) mixed with canonical strings in one column
  //     split a single calendar day into two axis buckets — precisely the failure
  //     `isFieldAlreadyCanonical` was written to prevent.
  // Wrapping the adapter rows in a synthetic source and running the SAME
  // `getCachedNormalizedDataSource` call restores the package-wide invariant that every
  // foreign-source read goes through L1 (it also builds `fieldDistinctValues` for these rows, so
  // a filter widget over an adapter-backed source stops re-scanning per render).
  //
  // The synthetic source is built inside this memo — keyed on `adapterRows` identity — because
  // the L1 cache is a `WeakMap` on the rows array: rebuilding `{ ...dataSource, rows }` every
  // render would still hit that WeakMap (same rows ref, same `fields` ref), but the memo keeps
  // the returned row array reference-stable for the downstream L2/L3 memos too.
  // Cold-cache placeholder rows ARE `dataSource.rows`, so they reuse the sync path's own
  // normalized source — the identical cache slot, no second clone of the row array.
  const normalizedAdapterRows = React.useMemo((): Row[] => {
    if (!hasAdapter || !dataSource || adapterRows.length === 0) {
      return adapterRows;
    }
    const source =
      adapterRows === dataSource.rows ? dataSource : { ...dataSource, rows: adapterRows };
    return (
      (getCachedNormalizedDataSource(source, usedFieldIds).rows as Row[] | undefined) ?? adapterRows
    );
  }, [hasAdapter, dataSource, adapterRows, usedFieldIds]);

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
          // `!f.disabled`: `partitionFilters` keeps disabled filters and `toggleFilter`
          // can disable an interactive one, so without this a lingering disabled
          // interactive filter would make `hasCrossFilters` spuriously true — costing
          // the `filteredRowsNoCross` reference short-circuit and skipping chart
          // entrance animations. Mirrors the `cross` branch above and the parallel
          // `hasChartCrossFilters` / KPI `hasIgnoredInteractiveFilters` guards.
          !f.disabled &&
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

  // Whether this widget's WIDGET-scoped rank (Top-N) filter is reduced at L3 (here) or left to
  // the chart's post-aggregation `applyRankTo*` pass. `shouldApplyWidgetRankAtL3` is the single
  // source of truth for that rule — shared with the CSV export and the AI insight summaries — so
  // the rendered rows and the rows those paths report over can never disagree.
  const includeWidgetRank = shouldApplyWidgetRankAtL3(widget);

  // Ghost overlay should only render when:
  // 1. The widget is in 'cross-highlight' mode (default)
  // 2. There is a chart-click cross-filter active (never for interactive/filter-widget filters)
  const shouldShowGhost = crossFilterMode === 'cross-highlight' && hasChartCrossFilters;

  // Adapter/server responses contain only physical columns — expression (calculated)
  // fields are a client-side concept the server cannot produce. Enrich the L1-normalized
  // rows with expression columns here so KPIs/charts using a calculated value field (e.g.
  // `price - cost`) aggregate against real values instead of `undefined` (which renders $0).
  // No-op for aggregated responses where the requested fields are already physical.
  //
  // Reads `normalizedAdapterRows`, never the raw `adapterRows`: L2 (and L3 below) must sit on
  // top of L1 on this path exactly as it does on the sync path, or the two paths bucket the same
  // timestamp into different days (see `normalizedAdapterRows`).
  const enrichedAdapterRows = React.useMemo((): Row[] => {
    if (!hasAdapter || !widget.sourceId || normalizedAdapterRows.length === 0) {
      return normalizedAdapterRows;
    }
    return getCachedEnrichedRows(
      normalizedAdapterRows,
      widget.sourceId,
      expressionFields,
      dataSources,
      relationships,
      usedFieldIds,
    );
  }, [
    hasAdapter,
    normalizedAdapterRows,
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
  //   'no-cross'       → page + widget
  //   'no-chart-cross' → page + widget + interactive (no chart-click cross-filters)
  //
  // Every one of the three ALSO carries the dashboard date range: `selectFiltersForWidget`
  // gates its `dashboard-date-range` branch on neither `include` value, deliberately, because
  // that range is the dashboard's own period rather than a cross-filter anyone can opt out of.
  // `useBlendedSeriesRows` depends on exactly that — it asks for `'no-cross'` to get "page +
  // dashboard-date-range for this source".
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
        if (adapterRowsArePlaceholder) {
          // COLD-CACHE PLACEHOLDER: these rows are `dataSource.rows` shown so the widget
          // doesn't flash empty — they never went to the server, so the premise the residual
          // pass below rests on ("page/widget filters were already baked into
          // descriptor.filter") is false for them. Applying only the rank/cross/interactive
          // residual rendered the FULL dataset — and KPI totals computed from it — on every
          // page load of a dashboard with e.g. a "last 30 days" range, until the fetch
          // resolved. Run the complete local filter chain instead, exactly as the sync path
          // does; the first real response flips `isPlaceholder` false and restores the
          // residual-only pass.
          const scopedLocal = selectFiltersForWidget(
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
              includeWidgetRank,
            },
          );
          if (scopedLocal.length === 0) {
            return enrichedAdapterRows;
          }
          return resolveRowsCached(
            enrichedAdapterRows,
            widget.sourceId,
            scopedLocal,
            dataSources,
            relationships,
            expressionFields,
            usedFieldIds,
          );
        }
        // Only the RESIDUAL — the filters `buildQueryDescriptor` could NOT put into the wire
        // request, so this client-side pass is their sole enforcement point: rank (top/bottom-N)
        // reductions of any authored scope, which have no wire representation, plus cross-filters
        // and interactive selections, which are deliberately kept off the descriptor. Non-rank
        // page/widget/date-range filters were already enforced server-side and must NOT be
        // re-applied — the response only projects `descriptor.select`, so re-running them evaluates
        // against columns the server never returned and drops every row.
        //
        // `selectAdapterResidualFilters` (filterScoping.ts) is the ONE implementation of that
        // rule, shared with the CSV export (`widgetExport.ts`), which used to carry a
        // hand-maintained transcription of this block. It returns candidates only; the
        // page/source/`disabled`/`include` scoping still happens in `selectFiltersForWidget`
        // below, exactly as before.
        const scoped = selectFiltersForWidget(
          selectAdapterResidualFilters(
            [
              ...deferredPartitioned.page,
              ...(deferredPartitioned.byWidgetId.get(widget.id) ?? []),
              ...deferredPartitioned.cross,
              ...deferredPartitioned.interactive,
            ],
            { widgetId: widget.id, includeWidgetRank },
          ),
          {
            widgetId: widget.id,
            widgetSourceId: widget.sourceId,
            activePageId: pageId,
            include,
            crossFilterAllPages,
            includeWidgetRank,
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
          includeWidgetRank,
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
      adapterRowsArePlaceholder,
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
      includeWidgetRank,
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
  // Deps are the four config values actually read (plus the kind), NOT the whole `widget`
  // object — mirroring `crossSourceColumns` just above. Depending on `widget` meant every
  // widget mutation (a resize drag emits one per pointer frame) produced a fresh `[]` for the
  // non-map case, busting `allCrossSourceFieldRefs` → `enrichIfNeeded` → all three `enriched*`
  // memos. That matters more here than elsewhere because `enrichWithCrossSourceFields` is the
  // one pipeline stage with no content-addressed cache, so the join re-ran per frame.
  const isMapWidget = isWidgetOfKind(widget, 'map');
  const mapConfig = widget.config as StudioWidgetConfig | undefined;
  const mapCountryField = mapConfig?.mapCountryField;
  const mapCountrySourceId = mapConfig?.mapCountrySourceId;
  const mapValueField = mapConfig?.mapValueField;
  const mapValueSourceId = mapConfig?.mapValueSourceId;
  const mapCrossSourceFields = React.useMemo((): CrossSourceFieldRef[] => {
    if (!isMapWidget) {
      // Shared module-level constant, so the non-map case is reference-stable across renders.
      return EMPTY_CROSS_SOURCE_FIELD_REFS;
    }
    const refs: CrossSourceFieldRef[] = [];
    if (mapCountryField && mapCountrySourceId && mapCountrySourceId !== widget.sourceId) {
      refs.push({ fieldId: mapCountryField, sourceId: mapCountrySourceId });
    }
    if (mapValueField && mapValueSourceId && mapValueSourceId !== widget.sourceId) {
      refs.push({ fieldId: mapValueField, sourceId: mapValueSourceId });
    }
    return refs;
  }, [
    isMapWidget,
    mapCountryField,
    mapCountrySourceId,
    mapValueField,
    mapValueSourceId,
    widget.sourceId,
  ]);

  const hasCrossSourceColumns = crossSourceColumns.length > 0 || mapCrossSourceFields.length > 0;

  // Combine grid-column cross-source refs and map field refs into a single list for enrichment
  const allCrossSourceFieldRefs = React.useMemo(() => {
    const colRefs = crossSourceColumns.map((c) => ({ fieldId: c.fieldId, sourceId: c.sourceId! }));
    return [...colRefs, ...mapCrossSourceFields];
  }, [crossSourceColumns, mapCrossSourceFields]);

  // Shared cross-source enrichment: join FK-referenced columns from related sources
  // onto the primary rows. A no-op (returns the input reference) when the widget has
  // no cross-source columns, preserving reference stability for downstream memos.
  //
  // `expressionFields` is threaded through so this SHARED pass performs the L2 enrichment
  // that gates a related-source *calculated* (expression) column referenced by a grid
  // column or a map's `mapCountryField`/`mapValueField`. Without it the
  // related source's RAW rows are indexed and the calculated column copies `undefined`
  // onto every widget row — a blank map / spurious "No data" while the setup panel reports
  // the config is valid. `enrichWithCrossSourceFields` scopes the L2 pass to only the
  // requested calculated-column ids, so passing the full (own + related) list here is cheap,
  // and physical cross-source columns are unaffected. This is the single fix point every
  // widget kind routes through — it replaces the former grid-only supplemental pass.
  const enrichIfNeeded = React.useCallback(
    (rows: Row[]): Row[] =>
      hasCrossSourceColumns
        ? enrichWithCrossSourceFields(
            rows,
            widget.sourceId,
            allCrossSourceFieldRefs,
            dataSources,
            relationships,
            expressionFields,
          )
        : rows,
    [
      hasCrossSourceColumns,
      widget.sourceId,
      allCrossSourceFieldRefs,
      dataSources,
      relationships,
      expressionFields,
    ],
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
    crossFilterMode === 'none' ? enrichedFilteredRowsNoChartCross : enrichedFilteredRows;

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
    // `reachableFilters` is exactly the include:'all' scoped set.
    resolvedFiltersAll: reachableFilters,
    resolvedFiltersNoCross,
    resolvedFiltersNoChartCross,
    widgetScopedRankFilters,
  };
}
