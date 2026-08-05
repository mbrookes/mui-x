import type {
  StudioChartType,
  StudioCrossFilterMode,
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
  StudioState,
  StudioWidget,
} from '../models';
import { isWidgetOfKind, resolveChartType } from '../models';
import { resolveChartRowsForAggregation } from './chartAggregation';
import { selectFiltersForWidget } from './filterScoping';
import { resolveRowsCached } from './resolvedRowsCache';
import { getCachedEnrichedRows } from './enrichedRowsCache';

type Row = Record<string, unknown>;

/**
 * Chart families that re-apply a widget-scoped rank (Top-N) filter POST-aggregation:
 * `useChartWidgetData` runs `applyRankToAggregated` / `applyRankToMultiSeries` /
 * `applyRankToSeriesFieldData` over the aggregated series, and `generateInsight`'s
 * `buildChartWidgetSummary` mirrors that on the AI-facing path.
 *
 * Every OTHER chart family (heatmap / funnel / sankey / gantt / scatter / gauge) aggregates
 * its rows directly in `chartTypeDefs` and never reads the rank filter at all.
 *
 * Consumed only by {@link shouldApplyWidgetRankAtL3} — deliberately not exported, so no caller
 * can re-derive the "is this a chart?" half of the rule on its own and drift from it.
 */
const POST_AGGREGATION_RANK_CHART_TYPES: ReadonlySet<StudioChartType> = new Set<StudioChartType>([
  'bar',
  'bar-stacked',
  'bar-100',
  'line',
  'area',
  'area-stacked',
  'area-100',
  'pie',
  'donut',
  'mixed',
]);

/**
 * Single source of truth for whether a widget's WIDGET-scoped rank (Top-N) filter must be
 * applied at L3, as a dataset-level reduction inside `applyFilters`' "filter then rank".
 *
 * The invariant it upholds: **a widget-scoped rank is applied exactly once**, at either L3 or
 * post-aggregation, never both and never neither.
 *
 * - `true` for every non-chart kind (grid / KPI / map / pivot / filter / text / custom) and for
 *   the chart families that aggregate rows directly with no post-aggregation rank step
 *   (heatmap / funnel / sankey / gantt / scatter / gauge). These have no other enforcement
 *   point, so without L3 their authored Top-N would be silently ignored.
 * - `false` for the xy chart families in {@link POST_AGGREGATION_RANK_CHART_TYPES}, which
 *   re-rank their aggregated series themselves; applying it at L3 too would double-reduce.
 *
 * A chart with no `chartType` resolves to `'bar'` (via `resolveChartType`, the same default
 * `StudioChartWidget` renders), so a config-less chart keeps its widget rank out of L3.
 *
 * Every path that resolves a widget's rows — the React hook (`useWidgetRows`), the CSV export
 * (`widgetExport`), and the AI insight summaries (`generateInsight`) — must route through this
 * helper, so the number the assistant reports can never be computed over a differently-ranked
 * row set than the one the widget renders.
 *
 * @param widget The widget whose rows are being resolved.
 * @returns Whether `includeWidgetRank` should be `true` for this widget's L3 pass.
 */
export function shouldApplyWidgetRankAtL3(widget: StudioWidget): boolean {
  if (!isWidgetOfKind(widget, 'chart')) {
    return true;
  }
  // `?? {}` mirrors the previous `(widget.config as StudioWidgetConfig)?.chartType ?? 'bar'`:
  // a chart whose config has not been authored yet still resolves to the rendered `'bar'`
  // default rather than throwing.
  return !POST_AGGREGATION_RANK_CHART_TYPES.has(resolveChartType(widget.config ?? {}));
}

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
   * Dashboard-level cross-filter settings, always honoured by `resolveWidgetRows`.
   *
   * Optional only so bare pipeline-state snapshots (tests, benchmarks) keep compiling — an
   * omitted field means "unset", i.e. `crossFilterAllPages: false` and no global mode
   * override. When a full `StudioState` is passed they are read from `doc.dashboard`
   * automatically, so **prefer passing the `StudioState`**: a hand-built
   * `StudioPipelineState` that forgets these two fields silently resolves cross-filters as
   * if the user had never touched either dashboard setting.
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
   * "filter then rank" reduction regardless.
   *
   * WIDGET-scoped rank filters follow {@link shouldApplyWidgetRankAtL3}, which is the single
   * rule deciding whether a widget's Top-N is reduced at L3 or post-aggregation. **Pass the
   * `StudioWidget` object as the first argument** and that rule is applied automatically — a
   * new caller gets the correct behaviour without having to know the rule exists.
   *
   * Passing a bare widget ID string cannot resolve the rule (there is no `kind`/`config` to
   * read), so it falls back to `includeWidgetRank: false` — correct only for the xy chart
   * families. Prefer the widget overload; the string form exists for callers that genuinely
   * have no widget object, such as `richContext`'s dashboard-wide field stats, which uses a
   * synthetic widget ID that no widget-scoped filter can ever match.
   *
   * @param widget     The widget whose rows are being resolved, or its bare ID (see above).
   *   Used to scope widget-level and cross-filter exclusions.
   * @param sourceId   The widget's primary source ID.
   * @param rows       Raw (pre-normalized) rows from `dataSources[sourceId].rows`.
   * @param pageId     Active page ID, used to scope cross-filters and interactive filters.
   * The dashboard's `crossFilterAllPages` and `globalCrossFilterMode` (from the state this
   * pipeline closes over) are ALWAYS honoured — passing `options` is not what turns them on.
   * The effective cross-filter mode resolves as
   * `state.globalCrossFilterMode ?? options?.widgetCrossFilterMode ?? 'cross-highlight'`, and
   * an effective mode of `'none'` coerces `include` to `'no-chart-cross'` — chart-click
   * cross-filters are ignored, but interactive (filter-widget) hard-filters still apply.
   *
   * @param options    Per-call overrides. Every field is optional and omitting the argument
   *   entirely is the normal case for a caller with no widget-specific override.
   *
   *   `options.widgetCrossFilterMode` is the emitting widget's own `config.crossFilterMode`;
   *   it is only consulted when the dashboard has no `globalCrossFilterMode` override.
   *   `options.include` is an explicit escape hatch that always wins over the resolved mode —
   *   pass `'no-cross'` to deliberately ignore both cross and interactive filters.
   *
   *   `options.includeWidgetRank` OVERRIDES the {@link shouldApplyWidgetRankAtL3} default. The
   *   only legitimate reason to pass it is a caller that reproduces a *different* stage of the
   *   pipeline than the widget's own render path — e.g. a comparison baseline that must mirror
   *   another `resolveWidgetRows` call's flag verbatim. Passing it to "make the numbers match
   *   the chart" is always wrong: the helper already does that.
   */
  resolveWidgetRows(
    widget: StudioWidget | string,
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
   *   `undefined`. Defaults to `[]`, matching the underlying function's own
   *   default — omitting it preserves prior behaviour.
   * @param widgetFilters The widget's fully resolved/scoped filter set (exactly what was passed to
   *   `resolveWidgetRows` to produce `filteredRows` — e.g. via `selectFiltersForWidget`). Only the
   *   subset targeting the anchor source is re-applied to the anchor rows before the expansion
   *   join, so a filter L3 enforced as a semi-join isn't silently re-widened back to every anchor
   *   row per surviving widget row. Defaults to `[]`, matching the underlying
   *   function's own default — omitting it preserves prior (pre-fix) behaviour, so existing
   *   callers of this public façade are unaffected until they opt in.
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
 * // Pass the widget itself, not `widget.id` — that is what lets `resolveWidgetRows` apply
 * // `shouldApplyWidgetRankAtL3` for you.
 * const rows = pipeline.resolveWidgetRows(widget, widget.sourceId, source.rows, activePageId);
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
    resolveWidgetRows(widget, sourceId, rows, pageId, options) {
      const isWidgetObject = typeof widget !== 'string';
      const scopeOpts: Parameters<typeof selectFiltersForWidget>[1] = {
        widgetId: isWidgetObject ? widget.id : widget,
        widgetSourceId: sourceId,
        activePageId: pageId,
        // Whether a WIDGET-scoped rank (Top-N) filter is reduced here at L3 or left to the
        // chart's post-aggregation `applyRankTo*` pass is decided in exactly one place. When a
        // widget object is available the rule resolves itself; a bare ID has no `kind`/`config`
        // to read, so it keeps the legacy `false`. An explicit option always wins.
        includeWidgetRank:
          options?.includeWidgetRank ??
          (isWidgetObject ? shouldApplyWidgetRankAtL3(widget) : false),
      };
      // The dashboard's cross-filter settings are honoured UNCONDITIONALLY — this used to be
      // gated behind "did the caller pass `options`?", which made the corrected behaviour
      // opt-in and therefore left the WRONG behaviour as the default every new caller
      // inherits. `options` is now purely the per-widget override channel.
      scopeOpts.crossFilterAllPages = crossFilterAllPages;
      // Precedence mirrors `useWidgetRows` / `StudioGridWidget` / `applyCrossFilter`: the
      // dashboard-wide override wins over the emitting widget's own config, which wins over
      // the built-in default. A caller with no widget context simply omits
      // `widgetCrossFilterMode` and lands on `globalCrossFilterMode ?? 'cross-highlight'`.
      const effectiveMode =
        globalCrossFilterMode ?? options?.widgetCrossFilterMode ?? 'cross-highlight';
      // Explicit include wins; otherwise 'none' excludes chart cross-filters only — interactive
      // (hard) filters still apply, matching the documented hard-filter invariant.
      scopeOpts.include = options?.include ?? (effectiveMode === 'none' ? 'no-chart-cross' : 'all');
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
