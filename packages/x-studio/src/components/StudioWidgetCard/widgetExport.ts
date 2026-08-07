import type { StudioController } from '../../store/StudioController';
import { createStudioPipeline, shouldApplyWidgetRankAtL3 } from '../../internals/StudioPipeline';
import { selectAdapterResidualFilters } from '../../internals/filterScoping';
import { exportChartToPng } from '../../internals/widgetPresentation';
import { exportGridToCsv, downloadCsv } from '../../internals/widgetUtils';
import { enrichWithCrossSourceFields } from '../../internals/crossSourceEnrichment';
import { resolveCrossSourceFieldDefs } from '../widgets/StudioGridWidget/StudioGridWidget';
import { buildWidgetQueryDescriptor } from '../../internals/queryDescriptor';
import { getCachedNormalizedDataSource } from '../../internals/normalizedRowsCache';
import { studioRequestCache } from '../../internals/StudioRequestCache';
import { lookup } from '../../utils/safeLookup';
import { getGridViewSortModel } from '../widgets/StudioGridWidget/gridViewSortRegistry';
import type { StudioDataSource, StudioWidget, StudioWidgetConfig } from '../../models';
import type { StudioLocaleText } from '../../internals/localeText';

type Row = Record<string, unknown>;

/**
 * Comparator matching DataGridPremium's default `gridStringOrNumberComparator`, including its
 * `gridNillComparator` prelude (nullish values sort FIRST ascending / LAST descending, because
 * the nil result is produced before the direction multiplier is applied). Reproduced here
 * rather than imported because the Data Grid does not export it, and an approximation that
 * merely "looks sorted" would still hand the user a CSV whose row order differs from the grid
 * it was exported from — the exact class of divergence this is fixing.
 *
 * Normalized `date` / `datetime` cells are canonical `YYYY-MM-DD` / ISO strings by the time
 * they reach here (`getCachedNormalizedDataSource`, and the adapter's own projection), so
 * lexicographic collation of those strings is chronological — no separate date branch needed.
 */
function compareGridCellValues(a: unknown, b: unknown): number {
  if (a == null && b == null) {
    return 0;
  }
  if (a == null) {
    return -1;
  }
  if (b == null) {
    return 1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b));
}

/**
 * Order `rows` the way the grid on screen orders them.
 *
 * The rendered grid drives sorting through a controlled `sortModel` (`StudioGridWidget.tsx`):
 * in edit mode that model is the authored `gridSortField` / `gridSortDirection`; in view mode
 * it is the viewer's own header click, which is component-local state published for this
 * export through `gridViewSortRegistry`. Neither was read here before, so a grid sorted by
 * Revenue desc exported in raw source order.
 *
 * Deliberately NOT reproduced: row grouping (`gridGroupByField`) and the aggregation summary
 * row. Both are presentation structures the Data Grid synthesizes at render time — a group
 * header row and a footer total have no representation in a flat CSV of the underlying
 * records, and inventing one would put rows in the file that exist in no data source. This
 * mirrors the same flat-export reasoning already documented for cross-highlight dimming below.
 */
function applyGridSortModel(rows: Row[], widget: StudioWidget): Row[] {
  const config = widget.config as StudioWidgetConfig;
  const configSortModel = config.gridSortField
    ? [{ field: config.gridSortField, sort: config.gridSortDirection ?? 'asc' }]
    : [];
  // View-mode header clicks win over the authored config, exactly as `sortModel` does in
  // `StudioGridWidget`; an absent registry entry means "no viewer sort" and falls through.
  const sortModel = getGridViewSortModel(widget.id) ?? configSortModel;
  if (sortModel.length === 0) {
    return rows;
  }
  // `slice()` — `rows` may be a memoized/cached array shared with the render path.
  return rows.slice().sort((rowA, rowB) => {
    for (const item of sortModel) {
      if (!item.sort) {
        continue;
      }
      const result = compareGridCellValues(lookup(rowA, item.field), lookup(rowB, item.field));
      if (result !== 0) {
        return item.sort === 'desc' ? -result : result;
      }
    }
    return 0;
  });
}

export interface RunWidgetExportParams {
  /** The widget being exported. */
  widget: StudioWidget;
  /** The widget's resolved data source, if any. */
  source: StudioDataSource | undefined;
  /** Controller used to read live state lazily at export time (no reactive subscription needed). */
  controller: StudioController;
  /** ID of the page the widget card belongs to — scopes filter resolution for grid CSV export. */
  pageId: string;
  /** Whether the widget is a consumer-registered custom kind (exports via `imperativeExport`). */
  isCustomKind: boolean;
  /** The DOM element holding a chart widget's SVG, used by the PNG exporter. */
  chartContainer: HTMLElement | null;
  /** Imperative export handler owned by pivot/custom widgets (populated via `exportRef`). */
  imperativeExport: (() => void) | null;
  /** Background colour applied behind an exported chart PNG. */
  chartBackgroundColor?: string;
  /** Resolved locale text, used for the "no data yet" CSV placeholder message. */
  localeText: StudioLocaleText;
}

/**
 * Dispatches a widget export to the correct per-kind exporter. Kept out of
 * `StudioWidgetCard` so the card no longer holds kind-specific export branches inline —
 * mirroring how each widget kind owns its `setupPanel`.
 *
 * - `grid`  → computes filtered rows lazily (honouring the widget's cross-filter mode) and
 *   downloads a CSV.
 * - `chart` → renders the live chart SVG to a PNG download.
 * - `pivot` / custom kinds → delegate to the widget's own imperative export handler.
 */
export function runWidgetExport({
  widget,
  source,
  controller,
  pageId,
  isCustomKind,
  chartContainer,
  imperativeExport,
  chartBackgroundColor,
  localeText,
}: RunWidgetExportParams): void {
  if (widget.kind === 'grid' && widget.sourceId) {
    // Compute filtered rows lazily at export time — no need for a reactive subscription.
    const state = controller.getState();
    const hasAdapter = Boolean(source?.adapter);

    // Adapter-backed rows come back ALREADY reduced by the widget's authored page/widget/
    // date-range filters (they were baked into the wire descriptor), and the response only
    // projects `descriptor.select`. Running the full filter set over them a second time
    // therefore evaluates authored filters against columns the server never returned and
    // silently drops every row — a dashboard date range produced a headers-only CSV beside a
    // populated grid. Feed the pipeline only the RESIDUAL filter set for that
    // case, which is precisely what the on-screen adapter path applies
    // (`useWidgetRows.ts`'s adapter branch). The sync path keeps the full set: it starts from
    // raw, fully-projected source rows, so every authored filter must be applied here.
    //
    // `selectAdapterResidualFilters` is the SHARED implementation in `internals/filterScoping.ts`
    // that `useWidgetRows` also calls — this file used to carry a hand-maintained transcription
    // of it, which had already drifted (it excluded rank-mode `dashboard-date-range` filters
    // that the render path applies). `includeWidgetRank` is passed explicitly rather than left
    // to the downstream gate: `resolveWidgetRows` below resolves the very same
    // `shouldApplyWidgetRankAtL3(widget)` for its own `selectFiltersForWidget` call, so stating
    // it here makes the two gates the same value by construction instead of by coincidence.
    const pipeline = createStudioPipeline(
      hasAdapter
        ? {
            dataSources: state.runtime.dataSources,
            relationships: state.doc.relationships,
            expressionFields: state.doc.expressionFields,
            filters: selectAdapterResidualFilters(state.doc.filters, {
              widgetId: widget.id,
              includeWidgetRank: shouldApplyWidgetRankAtL3(widget),
            }),
            crossFilterAllPages: state.doc.dashboard.crossFilterAllPages,
            globalCrossFilterMode: state.doc.dashboard.globalCrossFilterMode,
          }
        : state,
    );

    // Adapter-backed sources never populate `source.rows` — fetched rows live only in the on-screen
    // grid's local `useAdapterRows` state, seeded from (and written back to) the module-singleton
    // `studioRequestCache`. Exporting `source?.rows ?? []` unconditionally was therefore always an
    // empty array for an adapter source, with no indication to the user why the CSV came out empty.
    // Rebuild the EXACT descriptor `useAdapterRows` builds for the on-screen grid so this reads the
    // SAME cache entry instead of silently exporting nothing. Go through the shared
    // `buildWidgetQueryDescriptor` helper (rather than calling `buildQueryDescriptor` directly) so
    // this can never again omit `relationships` / `crossFilterAllPages` — both feed the cacheKey,
    // so omitting either produces a descriptor with a DIFFERENT cacheKey than the live grid's, and
    // this cache lookup misses despite the exact same data already being cached under the live
    // path's key.
    let sourceRows: Record<string, unknown>[];
    let cacheMiss = false;
    if (hasAdapter) {
      const descriptor = buildWidgetQueryDescriptor(widget, pageId, source?.tableName, {
        filters: state.doc.filters,
        expressionFields: state.doc.expressionFields,
        relationships: state.doc.relationships,
        crossFilterAllPages: state.doc.dashboard.crossFilterAllPages ?? false,
      });
      // Pass the live adapter so this export reads only the cache entry written by its OWN
      // adapter — two `<Studio>` instances sharing a `sourceId` but backed by different
      // adapters must not serve each other's rows.
      const cached = studioRequestCache.get(descriptor.cacheKey, source?.adapter);
      cacheMiss = cached === undefined;
      sourceRows = cached?.rows ?? [];
    } else {
      // Normalize the raw source rows through the SAME L1 pass the on-screen grid uses
      // (`getCachedNormalizedDataSource`, via `useWidgetRows`) before feeding them to
      // `resolveWidgetRows` — whose contract is raw, pre-normalized rows. Without this, exported
      // date/datetime cells keep their raw ingestion form instead of the canonical YYYY-MM-DD / ISO
      // the grid renders. All fields are normalized (the '*' slot) since a CSV export
      // includes every column.
      sourceRows = source ? (getCachedNormalizedDataSource(source).rows ?? []) : [];
    }

    // The grid hasn't fetched (or its cache entry was invalidated) — there is genuinely
    // no data to export yet, as opposed to a query that legitimately returned zero rows
    // (a `cached.rows.length === 0` cache HIT proceeds normally below and exports a
    // headers-only CSV, which correctly represents "no rows"). Rather than silently
    // downloading an empty file, download a short explanatory message instead — there is
    // no snackbar/toast in x-studio (see `StudioGridWidget.tsx`'s write-back error
    // handling for the same constraint) so this is the only user-visible channel
    // available from here.
    if (hasAdapter && cacheMiss) {
      downloadCsv(localeText.widgetExportNoDataMessage, `${widget.title}_export.csv`);
      return;
    }

    // NOTE: when `hasChartCrossFilters` is true and the
    // widget's effective mode is `cross-highlight`, the on-screen grid (`StudioGridWidget.tsx`)
    // shows ALL baseline rows (page/widget/interactive filters only) and dims the ones the
    // chart cross-filter doesn't match — see `filteredRowsNoChartCross` in `useWidgetRows.ts`.
    // `resolveWidgetRows` below has no concept of "dimmed" rows: passing `widgetCrossFilterMode`
    // resolves the effective mode and, for anything other than `'none'`, applies the cross-filter
    // as a HARD filter (`include: 'all'`), so the export only contains the highlighted subset —
    // not every row the grid visibly renders. This mirrors the CSV's nature as a flat data
    // export (a "dimmed" row has no natural CSV representation, unlike a highlight overlay in
    // the UI) and is treated as the intended behavior here; it is called out explicitly since it
    // was previously undocumented and easy to mistake for a bug.
    const rows =
      sourceRows.length > 0
        ? // Passing the widget OBJECT (not `widget.id`) lets `resolveWidgetRows` resolve
          // `shouldApplyWidgetRankAtL3` itself, so a widget-scoped Top-N is enforced at L3 for
          // this grid exactly as it is for the on-screen grid — the CSV can't export all rows
          // while the widget shows only the top N. No `includeWidgetRank` override belongs here.
          pipeline.resolveWidgetRows(widget, widget.sourceId, sourceRows, pageId, {
            // `crossFilterMode` is a cross-kind key, read via the flat cross-kind config type.
            widgetCrossFilterMode: (widget.config as StudioWidgetConfig).crossFilterMode,
          })
        : [];

    // Cross-source display columns (grid columns whose `sourceId` differs from the widget's
    // primary source) are joined onto rows for DISPLAY by `useWidgetRows.ts`'s
    // `enrichWithCrossSourceFields` call, but that enrichment previously never ran on the
    // export path — a cross-source column rendered correctly on screen but exported as an
    // empty column. Mirror the same enrichment here so the exported CSV matches
    // what's shown.
    const gridColumns = (widget.config as StudioWidgetConfig).columns;
    const crossSourceFieldRefs = (gridColumns ?? []).flatMap((c) =>
      c.sourceId && c.sourceId !== widget.sourceId
        ? [{ fieldId: c.fieldId, sourceId: c.sourceId }]
        : [],
    );
    const enrichedRows =
      crossSourceFieldRefs.length > 0
        ? enrichWithCrossSourceFields(
            rows,
            widget.sourceId,
            crossSourceFieldRefs,
            state.runtime.dataSources,
            state.doc.relationships,
            // A related-source *calculated* column needs an L2 pass over the related
            // source before its value exists — pass all expression fields so
            // it resolves in the export exactly as it does on screen.
            state.doc.expressionFields,
          )
        : rows;

    // Fold in the widget's own-source expression fields so the CSV header/format for a
    // calculated-field column matches the on-screen grid instead of falling back to the
    // raw field id with no number/currency formatting (finding — grid CSV export drifts
    // from on-screen rendering for expression-field columns).
    const ownExpressionFields = state.doc.expressionFields.filter(
      (ef) => ef.sourceId === widget.sourceId,
    );

    // Resolve each cross-source column's field def (physical field, or the related
    // source's calculated column) exactly as `StudioGridWidget` does on screen, so the
    // CSV header label and number/currency formatting match the rendered grid instead of
    // drifting to the raw field id.
    const crossSourceFieldDefs = Array.from(
      resolveCrossSourceFieldDefs(
        gridColumns,
        widget.sourceId,
        state.runtime.dataSources,
        state.doc.expressionFields,
      ).values(),
    );

    // Order the file the way the user is looking at the grid. Everything above this point
    // reproduces WHICH rows the grid shows; without this the CSV still disagreed with the
    // screen on the order they appear in.
    const sortedRows = applyGridSortModel(enrichedRows, widget);

    exportGridToCsv(widget, source, sortedRows, ownExpressionFields, crossSourceFieldDefs);
  } else if (widget.kind === 'chart') {
    // `canExport` gates purely on kind — every chart widget declares `export: 'png'` — so the
    // export button is offered for a chart with no chart surface on screen: an unconfigured
    // chart renders a plain Box + Typography, and a no-data/errored chart renders a status
    // overlay. `exportChartToPng` returns `false` in exactly those states (previously it just
    // returned silently, so the click did literally nothing — indistinguishable from a failed
    // download, and the only branch here that broke this module's "the export button never does
    // nothing" rule). Report it through the same channel the other three branches use.
    if (!exportChartToPng(widget, chartContainer, chartBackgroundColor)) {
      downloadCsv(localeText.widgetExportUnavailableMessage, `${widget.title}_export.csv`);
    }
  } else if (widget.kind === 'pivot' || isCustomKind) {
    // A pivot/custom widget exports through the handler it registered on `exportRef`. That ref
    // is null whenever the widget has nothing to export yet (the pivot nulls it while `matrix`
    // is null) or when a custom kind never registered one at all. `canExport` is derived from
    // the widget DEF's declared capability, not from the ref, so the button is offered in both
    // of those states — and `imperativeExport?.()` then did nothing at all, leaving the user to
    // conclude the export silently failed. Report it the same way the adapter
    // cache-miss above does.
    if (!imperativeExport) {
      downloadCsv(localeText.widgetExportUnavailableMessage, `${widget.title}_export.csv`);
      return;
    }
    imperativeExport();
  } else if (widget.kind === 'grid') {
    // Reached only when a grid widget has no `sourceId`. `canExport` gates purely on kind, so
    // the export button is shown for an unconfigured grid; before this branch existed the
    // click fell through EVERY branch and returned silently, indistinguishable from a failed
    // download. There is no snackbar/toast in x-studio, so — exactly as the
    // adapter cache-miss path above — the explanation is delivered as the file itself.
    downloadCsv(localeText.widgetExportUnavailableMessage, `${widget.title}_export.csv`);
  }
}
