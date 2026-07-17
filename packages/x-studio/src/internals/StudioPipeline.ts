import type {
  StudioCrossFilterMode,
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
  StudioState,
} from '../models';
import { resolveChartRowsForAggregation } from './chartAggregation';
import { selectFiltersForWidget } from './filterScoping';
import { resolveRowsCached } from './resolvedRowsCache';
import { getCachedEnrichedRows } from './enrichedRowsCache';

type Row = Record<string, unknown>;

/**
 * The pipeline context — a snapshot of the store state slices that the pipeline functions
 * need.  Obtained via `controller.getState()` or built manually in tests and benchmarks.
 */
export interface StudioPipelineState {
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  expressionFields: StudioExpressionField[];
  filters: StudioFilterState[];
  /**
   * Dashboard-level cross-filter settings. Optional so bare pipeline-state snapshots
   * (tests, benchmarks) keep working. When a full `StudioState` is passed they are read
   * from `doc.dashboard`; they only affect `resolveWidgetRows` when the caller opts in by
   * passing its `options` argument.
   */
  crossFilterAllPages?: boolean;
  globalCrossFilterMode?: StudioCrossFilterMode | null;
}

export interface StudioPipeline {
  /**
   * Layers L2 + L3: enrich rows with expression-column values and apply all scoped
   * filters (page, widget, cross-filter, interactive) for a given widget on a page.
   *
   * Page-scoped rank (Top-N) filters ARE applied — they flow through `applyFilters`'
   * "filter then rank" reduction regardless. WIDGET-scoped rank filters are excluded by
   * default, because the chart widget re-applies its own widget rank post-aggregation and
   * would otherwise double-reduce it. Non-chart callers (grid / KPI / map / pivot / filter)
   * — which have no post-aggregation rank path — set `options.includeWidgetRank = true` so a
   * widget-scoped rank is enforced at L3 as a dataset-level reduction (finding 2.1).
   *
   * @param widgetId   Widget ID used to scope widget-level and cross-filter exclusions.
   * @param sourceId   The widget's primary source ID.
   * @param rows       Raw (pre-normalized) rows from `dataSources[sourceId].rows`.
   * @param pageId     Active page ID, used to scope cross-filters and interactive filters.
   * @param options    Opt-in cross-filter behaviour. When omitted, behaves exactly as before
   *   (include: 'all', crossFilterAllPages: false, includeWidgetRank: false). When provided
   *   (even `{}`), the dashboard's `crossFilterAllPages` is honoured and the effective
   *   cross-filter mode is resolved as
   *   `state.globalCrossFilterMode ?? options.widgetCrossFilterMode ?? 'cross-highlight'`; an
   *   effective mode of `'none'` coerces `include` to `'no-cross'`. An explicit `options.include`
   *   always wins. `options.includeWidgetRank` (default `false`) applies WIDGET-scoped rank
   *   filters at L3; pass `true` for non-chart widget kinds so their authorable Top-N rank is
   *   enforced (matching the React hook's `!isWidgetOfKind(widget, 'chart')`).
   */
  resolveWidgetRows(
    widgetId: string,
    sourceId: string,
    rows: Row[],
    pageId?: string,
    options?: {
      widgetCrossFilterMode?: StudioCrossFilterMode;
      include?: 'all' | 'no-cross' | 'no-chart-cross';
      includeWidgetRank?: boolean;
    },
  ): Row[];

  /**
   * Layer L4: re-anchor rows to the correct aggregation grain for a chart widget.
   * Only required when chart fields span multiple related sources.
   *
   * @param filteredRows  Output of `resolveWidgetRows`.
   * @param sourceId      Widget's primary source ID.
   * @param xField        Chart x-axis field ID.
   * @param yFields       Chart y-axis field IDs (deduplicated).
   * @param seriesField   Optional series grouping field ID.
   * @param extraFields   Non-xy dimension fields a chart family reads but that aren't expressed
   *   via x/y/series (heatmap `heatYField`, funnel `funnelReachedField`, sankey `sankeyTargetField`,
   *   `gantt*`). Threaded straight through to `resolveChartRowsForAggregation` so a one-hop
   *   cross-source extra dimension is enriched onto the returned rows instead of resolving to
   *   `undefined` (finding 1.9). Defaults to `[]`, matching the underlying function's own
   *   default — omitting it preserves prior behaviour.
   * @param widgetFilters The widget's fully resolved/scoped filter set (exactly what was passed to
   *   `resolveWidgetRows` to produce `filteredRows` — e.g. via `selectFiltersForWidget`). Only the
   *   subset targeting the anchor source is re-applied to the anchor rows before the expansion
   *   join, so a filter L3 enforced as a semi-join isn't silently re-widened back to every anchor
   *   row per surviving widget row (finding 1.4). Defaults to `[]`, matching the underlying
   *   function's own default — omitting it preserves prior (pre-fix) behaviour, so existing
   *   callers of this public façade are unaffected until they opt in (finding 2.2).
   */
  resolveChartRows(
    filteredRows: Row[],
    sourceId: string,
    xField: string | undefined,
    yFields: string[],
    seriesField: string | undefined,
    extraFields?: (string | undefined)[],
    widgetFilters?: StudioFilterState[],
  ): Row[];

  /**
   * Layer L2: enrich rows with expression-column values for a given source.
   * Useful when you need enriched rows before applying custom filter logic.
   *
   * @param usedFieldIds  Optional set of field IDs to scope enrichment to.
   *   When provided, only expression fields whose IDs (or transitive dependencies)
   *   are in the set are evaluated — matching the lazy-by-widget behaviour used
   *   internally by `useWidgetRows`.
   */
  getEnrichedRows(rows: Row[], sourceId: string, usedFieldIds?: ReadonlySet<string>): Row[];
}

/**
 * Creates a pure-TypeScript data pipeline bound to a snapshot of studio state.
 *
 * Intended for non-React callers: CSV export handlers, benchmarks, and unit tests
 * that need to run the pipeline outside of a React render cycle.
 *
 * The factory is lightweight — it closes over the provided state slices and delegates
 * directly to the same underlying pipeline functions (and module-level caches) that
 * the React hook layer uses.
 *
 * @example
 * ```ts
 * const pipeline = createStudioPipeline(controller.getState());
 * const rows = pipeline.resolveWidgetRows(widget.id, widget.sourceId, source.rows, activePageId);
 * exportGridToCsv(widget, source, rows);
 * ```
 *
 * @example — benchmarks
 * ```ts
 * const pipeline = createStudioPipeline(buildScenario(100_000));
 * bench('full pipeline', () => {
 *   const filtered = pipeline.resolveWidgetRows('w1', 'orders', ordersRows);
 *   pipeline.resolveChartRows(filtered, 'orders', 'date', ['total'], undefined);
 * });
 * ```
 */
export function createStudioPipeline(state: StudioPipelineState | StudioState): StudioPipeline {
  const {
    dataSources,
    relationships,
    expressionFields,
    filters,
    crossFilterAllPages,
    globalCrossFilterMode,
  } =
    'doc' in state
      ? {
          dataSources: state.runtime.dataSources,
          relationships: state.doc.relationships,
          expressionFields: state.doc.expressionFields,
          filters: state.doc.filters,
          crossFilterAllPages: state.doc.dashboard.crossFilterAllPages,
          globalCrossFilterMode: state.doc.dashboard.globalCrossFilterMode,
        }
      : state;

  return {
    resolveWidgetRows(widgetId, sourceId, rows, pageId, options) {
      const scopeOpts: Parameters<typeof selectFiltersForWidget>[1] = {
        widgetId,
        widgetSourceId: sourceId,
        activePageId: pageId,
        // Widget-scoped rank (Top-N) filters are excluded by default (chart re-applies its
        // own post-aggregation); non-chart callers opt in so their rank is enforced at L3.
        includeWidgetRank: options?.includeWidgetRank ?? false,
      };
      // Strict backward compatibility: only engage the corrected cross-filter behaviour
      // when the caller explicitly opts in with `options`. Omitting it preserves today's
      // defaults (include: 'all', crossFilterAllPages: false).
      if (options) {
        scopeOpts.crossFilterAllPages = crossFilterAllPages;
        const effectiveMode =
          globalCrossFilterMode ?? options.widgetCrossFilterMode ?? 'cross-highlight';
        // Explicit include wins; otherwise 'none' excludes chart cross-filters only — interactive
        // (hard) filters still apply, matching the documented hard-filter invariant.
        // eslint-disable-next-line no-nested-ternary
        scopeOpts.include = options.include
          ? options.include
          : effectiveMode === 'none'
            ? 'no-chart-cross'
            : 'all';
      }
      const allFilters = selectFiltersForWidget(filters, scopeOpts);
      return resolveRowsCached(
        rows,
        sourceId,
        allFilters,
        dataSources,
        relationships,
        expressionFields,
      );
    },

    resolveChartRows(
      filteredRows,
      sourceId,
      xField,
      yFields,
      seriesField,
      extraFields,
      widgetFilters,
    ) {
      return resolveChartRowsForAggregation(
        filteredRows,
        sourceId,
        xField,
        yFields,
        seriesField,
        dataSources,
        relationships,
        expressionFields,
        extraFields,
        widgetFilters,
      );
    },

    getEnrichedRows(rows, sourceId, usedFieldIds) {
      return getCachedEnrichedRows(
        rows,
        sourceId,
        expressionFields,
        dataSources,
        relationships,
        usedFieldIds,
      );
    },
  };
}
