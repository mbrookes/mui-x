/**
 * Builds the active page's widget layout and cross-filter graph from dashboard
 * state alone — no row data required.
 *
 * This mirrors the page-layout section of the client-side `buildRichContext`
 * (`@mui/x-studio`) so the browser chat and the MCP server expose the same
 * distilled structure. It lives server-side because, unlike field statistics,
 * the layout is pure structure and needs no live pipeline rows.
 */
import type { StudioState } from './models/studioTypes';
import type {
  StudioAIPageLayout,
  StudioAILayoutWidget,
  StudioAICrossFilterEdge,
} from './models/aiTypes';

/**
 * @param {StudioState} state - The dashboard state to read the active page from.
 * @returns {StudioAIPageLayout | undefined} The active page's layout and
 *   cross-filter graph, or `undefined` when the page has no widgets and no
 *   cross-filter edges.
 */
export function buildPageLayoutContext(state: StudioState): StudioAIPageLayout | undefined {
  const pageId = state.dashboard.activePageId;
  const page = pageId ? state.pages[pageId] : undefined;
  if (!page) {
    return undefined;
  }

  const rows: StudioAILayoutWidget[][] = (page.widgetRows ?? []).map((row) =>
    row.flatMap((widgetId) => {
      const w = state.widgets[widgetId];
      if (!w) {
        return [];
      }
      const entry: StudioAILayoutWidget = { widgetId, kind: w.kind, title: w.title ?? '' };
      const chartType = (w.config as { chartType?: string } | undefined)?.chartType;
      if (chartType) {
        entry.chartType = chartType;
      }
      const colSpan = page.widgetColSpans?.[widgetId];
      if (colSpan != null) {
        entry.colSpan = colSpan;
      }
      return [entry];
    }),
  );

  const crossFilters: StudioAICrossFilterEdge[] = state.filters.flatMap((f) => {
    if (
      (f.scope === 'cross-filter' || f.scope === 'interactive') &&
      f.pageId === pageId &&
      f.sourceWidgetId
    ) {
      return [{ sourceWidgetId: f.sourceWidgetId, field: f.field, scope: f.scope }];
    }
    return [];
  });

  if (rows.every((r) => r.length === 0) && crossFilters.length === 0) {
    return undefined;
  }

  return { pageId, rows, crossFilters };
}
