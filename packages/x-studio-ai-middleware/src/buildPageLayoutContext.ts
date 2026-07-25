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
 * `Object.hasOwn`-guarded page lookup (mirrors `executeToolOnState.ts`'s
 * `getWidget`/`getPage`). `state.doc.pages` is a plain object keyed by the
 * client-supplied `activePageId`, so a bare `pages[id]` walks the prototype
 * chain: a prototype-member id (`"__proto__"`, `"constructor"`) resolves to a
 * truthy inherited value instead of "no active page" (finding T2-1).
 */
function getPage(state: StudioState, id: string): StudioState['doc']['pages'][string] | undefined {
  return Object.hasOwn(state.doc.pages, id) ? state.doc.pages[id] : undefined;
}

/** `Object.hasOwn`-guarded widget lookup (see `getPage`). */
function getWidget(
  state: StudioState,
  id: string,
): StudioState['doc']['widgets'][string] | undefined {
  return Object.hasOwn(state.doc.widgets, id) ? state.doc.widgets[id] : undefined;
}

/**
 * `Object.hasOwn`-guarded column-span lookup (finding M1, sibling of the guards
 * above and of `buildAISystemPrompt.ts`'s `getDistinctValues`).
 *
 * `widgetColSpans` is a plain object keyed by client-controlled widget ids, so a
 * bare `widgetColSpans[widgetId]` walked the prototype chain: a widget id of
 * `"constructor"` resolved to the `Object` constructor — non-null, so it was
 * emitted as this widget's `colSpan` and rendered into `<dashboard_context>` as a
 * phantom span. `buildAISystemPrompt.ts`'s own layout block already guards this
 * exact map; this mirror of it did not.
 */
function getColSpan(
  widgetColSpans: Record<string, number> | undefined,
  widgetId: string,
): number | undefined {
  if (!widgetColSpans || !Object.hasOwn(widgetColSpans, widgetId)) {
    return undefined;
  }
  const span = widgetColSpans[widgetId];
  return typeof span === 'number' ? span : undefined;
}

/**
 * @param {StudioState} state - The dashboard state to read the active page from.
 * @returns {StudioAIPageLayout | undefined} The active page's layout and
 *   cross-filter graph, or `undefined` when the page has no widgets and no
 *   cross-filter edges.
 */
export function buildPageLayoutContext(state: StudioState): StudioAIPageLayout | undefined {
  const pageId = state.doc.dashboard.activePageId;
  const page = pageId ? getPage(state, pageId) : undefined;
  if (!page) {
    return undefined;
  }

  const rows: StudioAILayoutWidget[][] = (
    Array.isArray(page.widgetRows) ? page.widgetRows : []
  ).map((row) =>
    (Array.isArray(row) ? row : []).flatMap((widgetId) => {
      const w = getWidget(state, widgetId);
      if (!w) {
        return [];
      }
      const entry: StudioAILayoutWidget = { widgetId, kind: w.kind, title: w.title ?? '' };
      const chartType = (w.config as { chartType?: string } | undefined)?.chartType;
      if (chartType) {
        entry.chartType = chartType;
      }
      // `Object.hasOwn`-guarded (finding M1) — see `getColSpan`.
      const colSpan = getColSpan(page.widgetColSpans, widgetId);
      if (colSpan != null) {
        entry.colSpan = colSpan;
      }
      return [entry];
    }),
  );

  const crossFilters: StudioAICrossFilterEdge[] = state.doc.filters.flatMap((f) => {
    // `f?.scope?.` (finding M3): `filters` is unvalidated client JSON, and a
    // scope-less (or `null`) entry threw a raw `TypeError` here — the same hole the
    // sibling filter loop in `buildAISystemPrompt.ts` had.
    if (
      (f?.scope?.kind === 'cross-filter' || f?.scope?.kind === 'interactive') &&
      f.scope.pageId === pageId
    ) {
      return [{ sourceWidgetId: f.scope.sourceWidgetId, field: f.field, scope: f.scope.kind }];
    }
    return [];
  });

  if (rows.every((r) => r.length === 0) && crossFilters.length === 0) {
    return undefined;
  }

  return { pageId, rows, crossFilters };
}
