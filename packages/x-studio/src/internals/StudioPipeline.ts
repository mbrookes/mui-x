import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
  StudioState,
} from '../models';
import { resolveDateRangePresets, resolveChartRowsForAggregation } from './chartUtils';
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
}

export interface StudioPipeline {
  /**
   * Layers L1 + L3: resolve metric-ref filter values, enrich rows with expression columns,
   * and apply all scoped filters (page, widget, cross-filter, interactive) for a given
   * widget on a page.
   *
   * Rank filters (`filterMode === 'rank'`) are excluded — apply them after aggregation
   * using your own logic.
   *
   * @param widgetId   Widget ID used to scope widget-level and cross-filter exclusions.
   * @param sourceId   The widget's primary source ID.
   * @param rows       Raw (pre-normalized) rows from `dataSources[sourceId].rows`.
   * @param pageId     Active page ID, used to scope cross-filters and interactive filters.
   */
  resolveWidgetRows(widgetId: string, sourceId: string, rows: Row[], pageId?: string): Row[];

  /**
   * Layer L4: re-anchor rows to the correct aggregation grain for a chart widget.
   * Only required when chart fields span multiple related sources.
   *
   * @param filteredRows  Output of `resolveWidgetRows`.
   * @param sourceId      Widget's primary source ID.
   * @param xField        Chart x-axis field ID.
   * @param yFields       Chart y-axis field IDs (deduplicated).
   * @param seriesField   Optional series grouping field ID.
   */
  resolveChartRows(
    filteredRows: Row[],
    sourceId: string,
    xField: string | undefined,
    yFields: string[],
    seriesField: string | undefined,
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
  const { dataSources, relationships, expressionFields, filters } = state;

  return {
    resolveWidgetRows(widgetId, sourceId, rows, pageId) {
      const pageFilters = filters.filter((f) => f.scope === 'page');
      const widgetFilters = filters.filter(
        (f) => f.scope === 'widget' && f.widgetId === widgetId && f.filterMode !== 'rank',
      );
      const crossFilters = filters.filter(
        (f) =>
          f.scope === 'cross-filter' &&
          f.sourceWidgetId !== widgetId &&
          (pageId === undefined || f.pageId === pageId),
      );
      const interactiveFilters = filters.filter(
        (f) =>
          f.scope === 'interactive' &&
          f.sourceWidgetId !== widgetId &&
          (pageId === undefined || f.pageId === pageId),
      );
      const allFilters = resolveDateRangePresets([
        ...pageFilters,
        ...widgetFilters,
        ...crossFilters,
        ...interactiveFilters,
      ]);
      return resolveRowsCached(
        rows,
        sourceId,
        allFilters,
        dataSources,
        relationships,
        expressionFields,
      );
    },

    resolveChartRows(filteredRows, sourceId, xField, yFields, seriesField) {
      return resolveChartRowsForAggregation(
        filteredRows,
        sourceId,
        xField,
        yFields,
        seriesField,
        dataSources,
        relationships,
        expressionFields,
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
