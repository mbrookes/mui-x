import type { StudioController } from '../../store/StudioController';
import { createStudioPipeline } from '../../internals/StudioPipeline';
import { exportGridToCsv, exportChartToPng } from '../../internals/widgetUtils';
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
    const rows =
      sourceRows.length > 0
        ? pipeline.resolveWidgetRows(widget.id, widget.sourceId, sourceRows, pageId, {
            // `crossFilterMode` is a cross-kind key, read via the flat cross-kind config type.
            widgetCrossFilterMode: (widget.config as StudioWidgetConfig).crossFilterMode,
          })
        : [];
    exportGridToCsv(widget, source, rows);
  } else if (widget.kind === 'chart') {
    exportChartToPng(widget, chartContainer, chartBackgroundColor);
  } else if (widget.kind === 'pivot' || isCustomKind) {
    imperativeExport?.();
  }
}
