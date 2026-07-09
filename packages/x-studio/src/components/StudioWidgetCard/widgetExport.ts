import type { StudioController } from '../../store/StudioController';
import { createStudioPipeline } from '../../internals/StudioPipeline';
import { exportGridToCsv, exportChartToPng, downloadCsv } from '../../internals/widgetUtils';
import { enrichWithCrossSourceFields } from '../../internals/crossSourceEnrichment';
import { buildQueryDescriptor } from '../../internals/queryDescriptor';
import { studioRequestCache } from '../../internals/StudioRequestCache';
import type { StudioDataSource, StudioWidget, StudioWidgetConfig } from '../../models';

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
}: RunWidgetExportParams): void {
  if (widget.kind === 'grid' && widget.sourceId) {
    // Compute filtered rows lazily at export time — no need for a reactive subscription.
    const state = controller.getState();
    const pipeline = createStudioPipeline(state);
    const hasAdapter = Boolean(source?.adapter);

    // Adapter-backed sources never populate `source.rows` — fetched rows live only in
    // the on-screen grid's local `useAdapterRows` state, seeded from (and written back
    // to) the module-singleton `studioRequestCache`. Exporting `source?.rows ?? []`
    // unconditionally was therefore always an empty array for an adapter source, with
    // no indication to the user why the CSV came out empty (finding 2.9). Rebuild the
    // EXACT descriptor `useAdapterRows` builds for the on-screen grid so this reads the
    // SAME cache entry instead of silently exporting nothing.
    let sourceRows: Record<string, unknown>[];
    let cacheMiss = false;
    if (hasAdapter) {
      const descriptor = buildQueryDescriptor(
        widget,
        state.doc.filters,
        pageId,
        source?.tableName,
        state.doc.expressionFields,
      );
      const cached = studioRequestCache.get(descriptor.cacheKey);
      cacheMiss = cached === undefined;
      sourceRows = cached?.rows ?? [];
    } else {
      sourceRows = source?.rows ?? [];
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
      downloadCsv(
        'No data available to export yet. Open the grid so it can load data from the server, then try exporting again.',
        `${widget.title}_export.csv`,
      );
      return;
    }

    // NOTE (finding 2.19, cross-highlight mode): when `hasChartCrossFilters` is true and the
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
        ? pipeline.resolveWidgetRows(widget.id, widget.sourceId, sourceRows, pageId, {
            // `crossFilterMode` is a cross-kind key, read via the flat cross-kind config type.
            widgetCrossFilterMode: (widget.config as StudioWidgetConfig).crossFilterMode,
          })
        : [];

    // Cross-source display columns (grid columns whose `sourceId` differs from the widget's
    // primary source) are joined onto rows for DISPLAY by `useWidgetRows.ts`'s
    // `enrichWithCrossSourceFields` call, but that enrichment previously never ran on the
    // export path — a cross-source column rendered correctly on screen but exported as an
    // empty column (finding 2.19). Mirror the same enrichment here so the exported CSV matches
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
          )
        : rows;

    // Fold in the widget's own-source expression fields so the CSV header/format for a
    // calculated-field column matches the on-screen grid instead of falling back to the
    // raw field id with no number/currency formatting (finding — grid CSV export drifts
    // from on-screen rendering for expression-field columns).
    const ownExpressionFields = state.doc.expressionFields.filter(
      (ef) => ef.sourceId === widget.sourceId,
    );

    exportGridToCsv(widget, source, enrichedRows, ownExpressionFields);
  } else if (widget.kind === 'chart') {
    exportChartToPng(widget, chartContainer, chartBackgroundColor);
  } else if (widget.kind === 'pivot' || isCustomKind) {
    imperativeExport?.();
  }
}
