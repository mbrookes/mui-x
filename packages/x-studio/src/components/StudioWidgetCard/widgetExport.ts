import type { StudioController } from '../../store/StudioController';
import { createStudioPipeline } from '../../internals/StudioPipeline';
import { exportGridToCsv, exportChartToPng } from '../../internals/widgetUtils';
import { enrichWithCrossSourceFields } from '../../internals/crossSourceEnrichment';
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
    const sourceRows = source?.rows ?? [];
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

    exportGridToCsv(widget, source, enrichedRows);
  } else if (widget.kind === 'chart') {
    exportChartToPng(widget, chartContainer, chartBackgroundColor);
  } else if (widget.kind === 'pivot' || isCustomKind) {
    imperativeExport?.();
  }
}
