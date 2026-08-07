import type { StudioPage } from '../models';

/**
 * Resolves the id of the page that owns `widgetId` by scanning every page's
 * layout (`widgetRows`). Falls back to `activePageId` when the widget isn't
 * placed on any page's layout (e.g. a widget that was just created but not
 * yet placed on the canvas, or one whose page was just removed).
 *
 * Pure `(pages, activePageId, widgetId) → pageId` so it can be shared between
 * the store layer (`StudioController.resolveWidgetPageIdInDoc`, used when
 * stamping interactive/cross-filter mutations with the emitting widget's own
 * page) and a component (`BuiltinWidgetPreview`, which needs the widget's own
 * page — not necessarily the active page — to read back its own interactive
 * filter selection) without either hand-rolling the same scan-and-fallback.
 */
export function resolveWidgetPageId(
  pages: Record<string, StudioPage>,
  activePageId: string,
  widgetId: string,
): string {
  for (const [pageId, page] of Object.entries(pages)) {
    for (const row of page.widgetRows ?? []) {
      if (row.includes(widgetId)) {
        return pageId;
      }
    }
  }
  return activePageId;
}
