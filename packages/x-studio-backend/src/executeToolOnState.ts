/**
 * Server-side tool execution for x-studio-backend.
 *
 * Unlike the client-side `executeTool` (which calls `StudioController` directly),
 * this function operates on a `StudioState` value and returns:
 * - `output`   — JSON string to feed back to the LLM
 * - `mutation` — optional `StateMutation` for the client to apply
 * - `nextState`— the updated state after the tool ran (used to carry state forward
 *                across multiple tool calls in a single agentic loop turn)
 */
import type {
  StudioState,
  StudioCustomWidgetDef,
  StudioWidget,
  StudioFilterOperator,
  StudioDataField,
  StateMutation,
} from '@mui/x-studio';
import { buildAISystemPrompt } from '@mui/x-studio/internals/buildAISystemPrompt';
import { createDefaultWidget } from '@mui/x-studio/internals/widgetUtils';

export interface ToolExecutionResult {
  output: string;
  mutation?: StateMutation;
  nextState: StudioState;
}

/**
 * Execute a single built-in tool against the provided `StudioState`.
 *
 * Returns the tool output string plus an optional state mutation (for write tools).
 * The `nextState` can be fed into subsequent tool calls within the same turn.
 */
export function executeToolOnState(
  toolName: string,
  input: unknown,
  state: StudioState,
  customWidgets?: StudioCustomWidgetDef[],
): ToolExecutionResult {
  const args = (input ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case 'get_dashboard_state': {
      return {
        output: buildAISystemPrompt(state, customWidgets),
        nextState: state,
      };
    }

    case 'add_page': {
      const title = String(args.title ?? 'New Page');
      const id = `page-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const nextState: StudioState = {
        ...state,
        pages: {
          ...state.pages,
          [id]: { id, title, widgetRows: [] },
        },
        dashboard: { ...state.dashboard, activePageId: id },
      };
      return {
        output: JSON.stringify({ success: true, pageId: id, title }),
        mutation: { type: 'addPage', args: { id, title } },
        nextState,
      };
    }

    case 'set_dashboard_title': {
      const title = String(args.title ?? '');
      const nextState: StudioState = {
        ...state,
        dashboard: { ...state.dashboard, title },
      };
      return {
        output: JSON.stringify({ success: true, title }),
        mutation: { type: 'setDashboardTitle', args: { title } },
        nextState,
      };
    }

    case 'add_widget': {
      const kind = String(args.kind ?? 'chart') as StudioWidget['kind'];
      const title = String(args.title ?? '');
      const sourceId = args.sourceId ? String(args.sourceId) : undefined;
      const aiConfig = (args.config ?? {}) as StudioWidget['config'];

      const customDef = customWidgets?.find((d) => d.kind === kind);
      const base = createDefaultWidget(kind);
      const config = {
        ...base.config,
        ...(customDef?.defaultConfig ?? {}),
        ...aiConfig,
      } as StudioWidget['config'];
      const widget: StudioWidget = {
        ...base,
        id: `widget-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title,
        sourceId: sourceId ?? base.sourceId,
        config,
      };

      const activePageId = state.dashboard.activePageId;
      const activePage = state.pages[activePageId];
      const nextState: StudioState = {
        ...state,
        widgets: { ...state.widgets, [widget.id]: widget },
        pages: {
          ...state.pages,
          [activePageId]: {
            ...activePage,
            widgetRows: [...(activePage?.widgetRows ?? []), [widget.id]],
          },
        },
      };
      return {
        output: JSON.stringify({ success: true, widgetId: widget.id, title }),
        mutation: { type: 'addWidget', args: { widget } },
        nextState,
      };
    }

    case 'update_widget': {
      const widgetId = String(args.widgetId ?? '');
      const widget = state.widgets[widgetId];
      if (!widget) {
        return { output: JSON.stringify({ error: `Widget ${widgetId} not found.` }), nextState: state };
      }

      const changes: Partial<Omit<StudioWidget, 'id'>> = {};
      if (args.title !== undefined) changes.title = String(args.title);
      if (args.sourceId !== undefined) changes.sourceId = String(args.sourceId);

      const newConfig =
        args.config !== undefined
          ? ({ ...widget.config, ...(args.config as StudioWidget['config']) } as StudioWidget['config'])
          : undefined;

      const updatedWidget: StudioWidget = {
        ...widget,
        ...changes,
        ...(newConfig !== undefined ? { config: newConfig } : {}),
      };
      const nextState: StudioState = {
        ...state,
        widgets: { ...state.widgets, [widgetId]: updatedWidget },
      };
      return {
        output: JSON.stringify({ success: true, widgetId }),
        mutation: {
          type: 'updateWidget',
          args: { widgetId, changes, ...(newConfig !== undefined ? { config: newConfig } : {}) },
        },
        nextState,
      };
    }

    case 'remove_widget': {
      const widgetId = String(args.widgetId ?? '');
      const nextWidgets = { ...state.widgets };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete nextWidgets[widgetId];

      const nextPages = Object.fromEntries(
        Object.entries(state.pages).map(([pid, page]) => [
          pid,
          {
            ...page,
            widgetRows: (page.widgetRows ?? [])
              .map((row) => row.filter((id) => id !== widgetId))
              .filter((row) => row.length > 0),
          },
        ]),
      );
      const nextState: StudioState = { ...state, widgets: nextWidgets, pages: nextPages };
      return {
        output: JSON.stringify({ success: true, widgetId }),
        mutation: { type: 'removeWidget', args: { widgetId } },
        nextState,
      };
    }

    case 'set_widget_layout': {
      const rows = args.rows as string[][];
      if (!Array.isArray(rows)) {
        return { output: JSON.stringify({ error: 'set_widget_layout requires a "rows" array.' }), nextState: state };
      }
      const activePageId = state.dashboard.activePageId;
      const activePage = state.pages[activePageId];
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      const nextState: StudioState = {
        ...state,
        pages: {
          ...state.pages,
          [activePageId]: { ...activePage, widgetRows: rows },
        },
      };
      return {
        output: JSON.stringify({ success: true, rows }),
        mutation: { type: 'setWidgetLayout', args: { rows } },
        nextState,
      };
    }

    case 'set_widget_width': {
      const { widgetId, columns } = args as { widgetId: string; columns: number | null };
      if (typeof widgetId !== 'string') {
        return { output: JSON.stringify({ error: 'set_widget_width requires a "widgetId" string.' }), nextState: state };
      }
      const activePageId = state.dashboard.activePageId;
      const activePage = state.pages[activePageId];
      const rowWidgetIds =
        activePage?.widgetRows?.find((row) => row.includes(widgetId)) ?? [widgetId];
      const nextColSpans = { ...(activePage?.widgetColSpans ?? {}) };
      if (columns === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete nextColSpans[widgetId];
      } else {
        nextColSpans[widgetId] = columns;
      }
      const nextState: StudioState = {
        ...state,
        pages: {
          ...state.pages,
          [activePageId]: { ...activePage!, widgetColSpans: nextColSpans },
        },
      };
      return {
        output: JSON.stringify({ success: true, widgetId, columns }),
        mutation: { type: 'setWidgetColSpan', args: { widgetId, columns, rowWidgetIds } },
        nextState,
      };
    }

    case 'rename_page': {
      const pageId = String(args.pageId ?? '');
      const title = String(args.title ?? '');
      const page = state.pages[pageId];
      if (!page) {
        return { output: JSON.stringify({ error: `Page ${pageId} not found.` }), nextState: state };
      }
      const nextState: StudioState = {
        ...state,
        pages: { ...state.pages, [pageId]: { ...page, title } },
      };
      return {
        output: JSON.stringify({ success: true, pageId, title }),
        mutation: { type: 'renamePage', args: { pageId, title } },
        nextState,
      };
    }

    case 'remove_page': {
      const pageId = String(args.pageId ?? '');
      const nextPages = { ...state.pages };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete nextPages[pageId];
      const nextState: StudioState = { ...state, pages: nextPages };
      return {
        output: JSON.stringify({ success: true, pageId }),
        mutation: { type: 'removePage', args: { pageId } },
        nextState,
      };
    }

    case 'set_active_page': {
      const pageId = String(args.pageId ?? '');
      const nextState: StudioState = {
        ...state,
        dashboard: { ...state.dashboard, activePageId: pageId },
      };
      return {
        output: JSON.stringify({ success: true, pageId }),
        mutation: { type: 'setActivePage', args: { pageId } },
        nextState,
      };
    }

    case 'add_page_filter': {
      const field = String(args.field ?? '');
      const sourceId = String(args.sourceId ?? '');
      const operator = String(args.operator ?? 'equals') as StudioFilterOperator;
      const value = args.value;
      const fieldType = args.fieldType as StudioDataField['type'] | undefined;
      const filterId = `filter-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const filter = {
        id: filterId,
        field,
        filterSourceId: sourceId,
        operator,
        value,
        fieldType,
        scope: 'page' as const,
        pageId: state.dashboard.activePageId,
      };
      const nextState: StudioState = {
        ...state,
        filters: [...(state.filters ?? []), filter],
      };
      return {
        output: JSON.stringify({ success: true, filterId }),
        mutation: { type: 'addFilter', args: { filter } },
        nextState,
      };
    }

    case 'add_widget_filter': {
      const widgetId = String(args.widgetId ?? '');
      const field = String(args.field ?? '');
      const sourceId = String(args.sourceId ?? '');
      const operator = String(args.operator ?? 'equals') as StudioFilterOperator;
      const value = args.value;
      const fieldType = args.fieldType as StudioDataField['type'] | undefined;
      const filterId = `filter-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const filter = {
        id: filterId,
        field,
        filterSourceId: sourceId,
        operator,
        value,
        fieldType,
        scope: 'widget' as const,
        widgetId,
      };
      const nextState: StudioState = {
        ...state,
        filters: [...(state.filters ?? []), filter],
      };
      return {
        output: JSON.stringify({ success: true, filterId }),
        mutation: { type: 'addFilter', args: { filter } },
        nextState,
      };
    }

    case 'remove_page_filter':
    case 'remove_widget_filter': {
      const filterId = String(args.filterId ?? '');
      const nextState: StudioState = {
        ...state,
        filters: (state.filters ?? []).filter((f) => f.id !== filterId),
      };
      return {
        output: JSON.stringify({ success: true, filterId }),
        mutation: { type: 'removeFilter', args: { filterId } },
        nextState,
      };
    }

    case 'apply_bulk_update': {
      const activePageId = state.dashboard.activePageId;
      const activePage = state.pages[activePageId];
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page found.' }), nextState: state };
      }

      const skipped: string[] = [];
      const applied = { updated: 0, added: 0, removed: 0, layout: false, colSpans: 0 };

      let pageWidgets = { ...state.widgets };
      let widgetRows = activePage.widgetRows.map((row) => [...row]);
      const colSpans = { ...(activePage.widgetColSpans ?? {}) };

      // 1. Removals
      const removals = (args.widgetRemovals as string[] | undefined) ?? [];
      for (const wid of removals) {
        if (!pageWidgets[wid]) { skipped.push(`remove ${wid}: not found`); continue; }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete pageWidgets[wid];
        widgetRows = widgetRows.map((row) => row.filter((id) => id !== wid)).filter((row) => row.length > 0);
        applied.removed += 1;
      }

      // 2. Additions
      const addedTitleToId: Record<string, string> = {};
      const additions = (args.widgetAdditions as Array<{ kind: string; title: string; sourceId?: string; config?: Record<string, unknown> }> | undefined) ?? [];
      for (const addition of additions) {
        const kind = String(addition.kind ?? 'chart') as StudioWidget['kind'];
        const title = String(addition.title ?? '');
        const sourceId = addition.sourceId ? String(addition.sourceId) : undefined;
        const aiConfig = (addition.config ?? {}) as StudioWidget['config'];
        const customDef = customWidgets?.find((d) => d.kind === kind);
        const base = createDefaultWidget(kind);
        const config = {
          ...base.config,
          ...(customDef?.defaultConfig ?? {}),
          ...aiConfig,
        } as StudioWidget['config'];
        const widget: StudioWidget = {
          ...base,
          id: `widget-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title,
          sourceId: sourceId ?? base.sourceId,
          config,
        };
        pageWidgets[widget.id] = widget;
        addedTitleToId[title] = widget.id;
        widgetRows.push([widget.id]);
        applied.added += 1;
      }

      // 3. Updates
      const updates = (args.widgetUpdates as Array<{ widgetId: string; title?: string; sourceId?: string; config?: Record<string, unknown> }> | undefined) ?? [];
      for (const update of updates) {
        const wid = String(update.widgetId ?? '');
        const widget = pageWidgets[wid];
        if (!widget) { skipped.push(`update ${wid}: not found`); continue; }
        pageWidgets[wid] = {
          ...widget,
          ...(update.title !== undefined ? { title: String(update.title) } : {}),
          ...(update.sourceId !== undefined ? { sourceId: String(update.sourceId) } : {}),
          config: update.config
            ? ({ ...widget.config, ...(update.config as StudioWidget['config']) } as StudioWidget['config'])
            : widget.config,
        };
        applied.updated += 1;
      }

      // 4. Layout
      const rawLayout = args.layout as string[][] | undefined;
      if (rawLayout && Array.isArray(rawLayout)) {
        widgetRows = rawLayout.map((row) => row.map((ref) => addedTitleToId[ref] ?? ref)).filter((row) => row.length > 0);
        applied.layout = true;
      }

      // 5. Column spans
      const colSpanPatch = (args.colSpans as Record<string, number> | undefined) ?? {};
      for (const [wid, span] of Object.entries(colSpanPatch)) {
        if (typeof span === 'number' && span >= 3 && span <= 12) {
          colSpans[wid] = span;
          applied.colSpans += 1;
        }
      }

      const nextState: StudioState = {
        ...state,
        widgets: pageWidgets,
        pages: {
          ...state.pages,
          [activePageId]: { ...activePage, widgetRows, widgetColSpans: colSpans },
        },
      };
      return {
        output: JSON.stringify({ success: true, applied, ...(skipped.length > 0 ? { skipped } : {}) }),
        mutation: {
          type: 'applyBulkUpdate',
          args: { widgets: pageWidgets, widgetRows, widgetColSpans: colSpans, activePageId },
        },
        nextState,
      };
    }

    case 'summarise_page': {
      // summarise_page requires runtime data (rows/pipeline) — not available server-side.
      // Return a prompt to the model explaining this limitation; the client-side adapter
      // should handle this tool locally if needed.
      return {
        output: JSON.stringify({
          error:
            'summarise_page requires live row data that is only available client-side. ' +
            'Use get_dashboard_state for structural information instead.',
        }),
        nextState: state,
      };
    }

    default:
      return { output: JSON.stringify({ error: `Unknown tool: ${toolName}` }), nextState: state };
  }
}
