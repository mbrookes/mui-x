/**
 * Server-side tool execution for x-studio-ai-middleware.
 *
 * Unlike the client-side `executeTool` (which calls `StudioController` directly),
 * this function operates on a `StudioState` value and returns:
 * - `output`   — JSON string to feed back to the LLM
 * - `mutation` — optional `StateMutation` for the client to apply
 * - `nextState`— the updated state after the tool ran (used to carry state forward
 *                across multiple tool calls in a single agentic loop turn)
 */
import { applyMutation, createDefaultWidget } from '@mui/x-studio-schema';
import type {
  StudioState,
  StudioCustomWidgetDef,
  StudioWidget,
  StudioFilterOperator,
  StudioDataField,
  StudioFilterState,
} from './models/studioTypes';
import type { StateMutation } from './models/aiTypes';
// Shared pure functions: the widget factory (so AI-created and UI-created widgets
// share defaults) and the single mutation reducer (so the server-threaded state
// and the client-applied state are computed by the exact same code).

export interface ToolExecutionResult {
  output: string;
  mutation?: StateMutation;
  nextState: StudioState;
}

/**
 * Builds a `StudioWidget` from AI-tool arguments, layering config in one canonical
 * order — factory defaults → custom-widget `defaultConfig` → model-supplied config —
 * and minting the id through the shared `createDefaultWidget` (its
 * `createWidgetId` scheme is collision-resistant). Used by both `add_widget` and
 * `apply_bulk_update`'s additions so the two paths cannot drift (they were
 * previously character-for-character duplicates, including a hand-copied id scheme).
 */
function buildWidgetFromArgs(
  args: { kind?: unknown; title?: unknown; sourceId?: unknown; config?: unknown },
  customWidgets?: StudioCustomWidgetDef[],
): StudioWidget {
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
  return {
    ...base,
    title,
    sourceId: sourceId ?? base.sourceId,
    config,
  };
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
  pageSnapshot?: string,
): ToolExecutionResult {
  const args = (input ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case 'get_dashboard_state': {
      // Canonical output contract, shared with the MCP transport: return the raw
      // `StudioState`. Both `buildStudioMcpServer`'s `get_dashboard_state` handler
      // (mcp.ts) and this chat-path handler now return the state object so the tool
      // means the same thing on both surfaces. The full rendered system prompt is
      // already the chat request's system message, so re-emitting it as tool output
      // was redundant and diverged from MCP.
      return {
        output: JSON.stringify(state),
        nextState: state,
      };
    }

    case 'list_pages': {
      const pageList = Object.values(state.pages).map((page) => {
        const widgetIds = (page.widgetRows ?? []).flat();
        const widgetTitles = widgetIds
          .map((id) => state.widgets[id]?.title)
          .filter((t): t is string => Boolean(t));
        return {
          id: page.id,
          title: page.title,
          widgetCount: widgetIds.length,
          widgetTitles,
          isActive: page.id === state.dashboard.activePageId,
        };
      });
      return {
        output: JSON.stringify({ pages: pageList, activePageId: state.dashboard.activePageId }),
        nextState: state,
      };
    }

    case 'add_page': {
      const title = String(args.title ?? 'New Page');
      const id = `page-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const mutation: StateMutation = { type: 'addPage', args: { id, title } };
      return {
        output: JSON.stringify({ success: true, pageId: id, title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'set_dashboard_title': {
      const title = String(args.title ?? '');
      const mutation: StateMutation = { type: 'setDashboardTitle', args: { title } };
      return {
        output: JSON.stringify({ success: true, title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'add_widget': {
      // Explicitly resolve (and validate) the target page server-side so the
      // widget lands on the same page the model is told about, regardless of
      // where the client's navigation happens to be. Error rather than spread
      // an `undefined` page into state.
      const pageId = state.dashboard.activePageId;
      if (!state.pages[pageId]) {
        return {
          output: JSON.stringify({
            error: 'Cannot add a widget: there is no active page. Call add_page first.',
          }),
          nextState: state,
        };
      }

      const widget = buildWidgetFromArgs(args, customWidgets);
      const mutation: StateMutation = { type: 'addWidget', args: { widget, pageId } };
      return {
        output: JSON.stringify({ success: true, widgetId: widget.id, title: widget.title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'update_widget': {
      const widgetId = String(args.widgetId ?? '');
      const widget = state.widgets[widgetId];
      if (!widget) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }

      const changes: Partial<Omit<StudioWidget, 'id'>> = {};
      if (args.title !== undefined) {
        changes.title = String(args.title);
      }
      if (args.sourceId !== undefined) {
        changes.sourceId = String(args.sourceId);
      }

      const newConfig =
        args.config !== undefined
          ? ({
              ...widget.config,
              ...(args.config as StudioWidget['config']),
            } as StudioWidget['config'])
          : undefined;

      const mutation: StateMutation = {
        type: 'updateWidget',
        args: { widgetId, changes, ...(newConfig !== undefined ? { config: newConfig } : {}) },
      };
      return {
        output: JSON.stringify({ success: true, widgetId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'remove_widget': {
      const widgetId = String(args.widgetId ?? '');
      if (!state.widgets[widgetId]) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }
      const mutation: StateMutation = { type: 'removeWidget', args: { widgetId } };
      return {
        output: JSON.stringify({ success: true, widgetId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'set_widget_layout': {
      const rawRows = args.rows;
      // Validate the SHAPE, not just `Array.isArray`: a flat `["w1","w2"]` (the
      // exact mistake the system prompt warns about) is a valid array but corrupts
      // `widgetRows` — every downstream `row.map`/`row.filter` then throws on a
      // string, killing the next turn's `buildDashboardState`.
      if (
        !Array.isArray(rawRows) ||
        !rawRows.every((row) => Array.isArray(row) && row.every((id) => typeof id === 'string'))
      ) {
        return {
          output: JSON.stringify({
            error:
              'set_widget_layout requires "rows" to be an array of rows, where each row is an ' +
              'array of widget-ID strings (e.g. [["w1","w2"],["w3"]]).',
          }),
          nextState: state,
        };
      }
      const rows = rawRows as string[][];
      const activePageId = state.dashboard.activePageId;
      if (!state.pages[activePageId]) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      // Validate MEMBERSHIP: every id must be a known widget (widgets added earlier
      // this turn are already threaded into `state.widgets`). Unknown ids would
      // otherwise be stored as phantom layout entries (blank cards).
      const unknownIds = [...new Set(rows.flat())].filter((id) => !state.widgets[id]);
      if (unknownIds.length > 0) {
        return {
          output: JSON.stringify({
            error:
              `set_widget_layout received unknown widget IDs: ${unknownIds.join(', ')}. ` +
              'Call get_dashboard_state to get the current widget IDs.',
          }),
          nextState: state,
        };
      }
      const mutation: StateMutation = {
        type: 'setWidgetLayout',
        args: { rows, pageId: activePageId },
      };
      return {
        output: JSON.stringify({ success: true, rows }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'set_widget_width': {
      const { widgetId, columns } = args as { widgetId: string; columns: number | null };
      if (typeof widgetId !== 'string') {
        return {
          output: JSON.stringify({ error: 'set_widget_width requires a "widgetId" string.' }),
          nextState: state,
        };
      }
      const activePageId = state.dashboard.activePageId;
      const activePage = state.pages[activePageId];
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      const rowWidgetIds = activePage.widgetRows?.find((row) => row.includes(widgetId)) ?? [
        widgetId,
      ];
      const mutation: StateMutation = {
        type: 'setWidgetColSpan',
        args: { widgetId, columns, rowWidgetIds, pageId: activePageId },
      };
      return {
        output: JSON.stringify({ success: true, widgetId, columns }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'rename_page': {
      const pageId = String(args.pageId ?? '');
      const title = String(args.title ?? '');
      const page = state.pages[pageId];
      if (!page) {
        return { output: JSON.stringify({ error: `Page ${pageId} not found.` }), nextState: state };
      }
      const mutation: StateMutation = { type: 'renamePage', args: { pageId, title } };
      return {
        output: JSON.stringify({ success: true, pageId, title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'remove_page': {
      const pageId = String(args.pageId ?? '');
      const page = state.pages[pageId];
      if (!page) {
        return { output: JSON.stringify({ error: `Page ${pageId} not found.` }), nextState: state };
      }

      // `applyMutation`'s removePage mirrors `StudioController.removePage`
      // exactly (drop the page, remove its widgets, remove its page-scoped
      // filters, and reassign `activePageId` when the removed page was active),
      // so the server-computed `nextState` matches what the client produces.
      const mutation: StateMutation = { type: 'removePage', args: { pageId } };
      return {
        output: JSON.stringify({ success: true, pageId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'set_active_page': {
      const pageId = String(args.pageId ?? '');
      if (!state.pages[pageId]) {
        return { output: JSON.stringify({ error: `Page ${pageId} not found.` }), nextState: state };
      }
      const mutation: StateMutation = { type: 'setActivePage', args: { pageId } };
      return {
        output: JSON.stringify({ success: true, pageId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'add_page_filter': {
      const field = String(args.field ?? '');
      const sourceId = String(args.sourceId ?? '');
      const operator = String(args.operator ?? 'equals') as StudioFilterOperator;
      const value = args.value;
      const fieldType = args.fieldType as StudioDataField['type'] | undefined;
      const filterId = `filter-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const filter: StudioFilterState = {
        id: filterId,
        field,
        filterSourceId: sourceId,
        operator,
        value,
        fieldType,
        // Page target chosen server-side and carried in the filter's scope, so
        // the client applies it to this page rather than its own active page.
        scope: { kind: 'page', pageId: state.dashboard.activePageId },
      };
      const mutation: StateMutation = { type: 'addFilter', args: { filter } };
      return {
        output: JSON.stringify({ success: true, filterId }),
        mutation,
        nextState: applyMutation(state, mutation),
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
      const filter: StudioFilterState = {
        id: filterId,
        field,
        filterSourceId: sourceId,
        operator,
        value,
        fieldType,
        scope: { kind: 'widget', widgetId },
      };
      const mutation: StateMutation = { type: 'addFilter', args: { filter } };
      return {
        output: JSON.stringify({ success: true, filterId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'remove_page_filter':
    case 'remove_widget_filter': {
      const filterId = String(args.filterId ?? '');
      const mutation: StateMutation = { type: 'removeFilter', args: { filterId } };
      return {
        output: JSON.stringify({ success: true, filterId }),
        mutation,
        nextState: applyMutation(state, mutation),
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

      const pageWidgets = { ...state.widgets };
      let widgetRows = activePage.widgetRows.map((row) => [...row]);
      const colSpans = { ...(activePage.widgetColSpans ?? {}) };

      // 1. Removals
      // `pageWidgets` is the GLOBAL widget record, but this handler only rewrites
      // the ACTIVE page's `widgetRows`. Removing a widget that lives on another
      // page would delete it from `widgets` while leaving a dangling id in that
      // other page's rows (blank card). Only remove widgets that are on the active
      // page; report the rest as `skipped`, mirroring the not-found handling.
      const activePageWidgetIds = new Set(activePage.widgetRows.flat());
      const removals = (args.widgetRemovals as string[] | undefined) ?? [];
      for (const wid of removals) {
        if (!pageWidgets[wid]) {
          skipped.push(`remove ${wid}: not found`);
          continue;
        }
        if (!activePageWidgetIds.has(wid)) {
          skipped.push(`remove ${wid}: not on the active page`);
          continue;
        }
        delete pageWidgets[wid];
        widgetRows = widgetRows
          .map((row) => row.filter((id) => id !== wid))
          .filter((row) => row.length > 0);
        applied.removed += 1;
      }

      // 2. Additions
      const addedTitleToId: Record<string, string> = {};
      const additions =
        (args.widgetAdditions as
          | Array<{
              kind: string;
              title: string;
              sourceId?: string;
              config?: Record<string, unknown>;
            }>
          | undefined) ?? [];
      for (const addition of additions) {
        const widget = buildWidgetFromArgs(addition, customWidgets);
        pageWidgets[widget.id] = widget;
        addedTitleToId[widget.title] = widget.id;
        widgetRows.push([widget.id]);
        applied.added += 1;
      }

      // 3. Updates
      const updates =
        (args.widgetUpdates as
          | Array<{
              widgetId: string;
              title?: string;
              sourceId?: string;
              config?: Record<string, unknown>;
            }>
          | undefined) ?? [];
      for (const update of updates) {
        const wid = String(update.widgetId ?? '');
        const widget = pageWidgets[wid];
        if (!widget) {
          skipped.push(`update ${wid}: not found`);
          continue;
        }
        pageWidgets[wid] = {
          ...widget,
          ...(update.title !== undefined ? { title: String(update.title) } : {}),
          ...(update.sourceId !== undefined ? { sourceId: String(update.sourceId) } : {}),
          config: update.config
            ? ({
                ...widget.config,
                ...(update.config as StudioWidget['config']),
              } as StudioWidget['config'])
            : widget.config,
        };
        applied.updated += 1;
      }

      // 4. Layout
      const rawLayout = args.layout as string[][] | undefined;
      if (rawLayout && Array.isArray(rawLayout)) {
        widgetRows = rawLayout
          .map((row) => row.map((ref) => addedTitleToId[ref] ?? ref))
          .filter((row) => row.length > 0);
        applied.layout = true;
      }

      // 5. Column spans
      // Accept spans in the 24-column unit system the canvas renders (matches
      // `canvasGridConstants.GRID_COLS` = 24 / `MIN_SPAN` = 6 in `@mui/x-studio`
      // and the `setWidgetColSpan` reducer's clamp).
      const colSpanPatch = (args.colSpans as Record<string, number> | undefined) ?? {};
      for (const [wid, span] of Object.entries(colSpanPatch)) {
        if (typeof span === 'number' && span >= 6 && span <= 24) {
          colSpans[wid] = span;
          applied.colSpans += 1;
        }
      }

      const mutation: StateMutation = {
        type: 'applyBulkUpdate',
        args: { widgets: pageWidgets, widgetRows, widgetColSpans: colSpans, activePageId },
      };
      return {
        output: JSON.stringify({
          success: true,
          applied,
          ...(skipped.length > 0 ? { skipped } : {}),
        }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    case 'summarise_page': {
      // On the chat path the only row data available is the client-provided
      // `pageSnapshot`, which is built for the *active* page. Unlike the MCP path
      // (which can query any page's sources live), we cannot honor a `pageId` that
      // points at a non-active page here. The tool schema advertises `pageId`, so
      // rather than silently mislabel the active page's data as the requested page,
      // reject the request with actionable guidance.
      const requestedPageId = args.pageId ? String(args.pageId) : undefined;
      const activePageId = state.dashboard.activePageId;
      if (requestedPageId && requestedPageId !== activePageId) {
        return {
          output: JSON.stringify({
            error:
              `summarise_page cannot summarise page "${requestedPageId}" here. ` +
              'In chat, live row data is only available for the active page, so a non-active ' +
              `pageId cannot be honored. Call set_active_page with "${requestedPageId}" first, ` +
              'then summarise_page, or omit pageId to summarise the active page.',
          }),
          nextState: state,
        };
      }
      if (pageSnapshot) {
        // Return the data snapshot as plain text so the model can read it directly
        // without unwrapping a JSON structure. The tool description instructs the model
        // to follow up with an executive summary of the key insights.
        return {
          output: pageSnapshot,
          nextState: state,
        };
      }
      // No snapshot available — explain the limitation so the model can degrade gracefully.
      return {
        output: JSON.stringify({
          error:
            'summarise_page requires live row data that is only available client-side. ' +
            'Use get_dashboard_state for structural information instead.',
        }),
        nextState: state,
      };
    }

    case 'rename_thread': {
      const { name } = args as { name?: string };
      if (!name || typeof name !== 'string') {
        return {
          output: JSON.stringify({ error: 'rename_thread requires a non-empty name string.' }),
          nextState: state,
        };
      }
      const trimmed = name.trim().slice(0, 40);
      // Stamp the thread the request belongs to (the active thread in the request's
      // state snapshot) so the reducer renames THAT thread on the client, even if
      // the user has since switched threads while the model was running. Falls back
      // to the applying side's active thread for legacy/omitted payloads.
      const threadId = state.ai?.activeThreadId;
      const mutation: StateMutation = {
        type: 'renameAIThread',
        args: {
          name: trimmed,
          updatedAt: new Date().toISOString(),
          ...(threadId ? { threadId } : {}),
        },
      };
      return {
        output: JSON.stringify({ success: true, name: trimmed }),
        mutation,
        // Server state carries no `ai` thread store, so this is a no-op here; the
        // client applies the thread rename via the same reducer.
        nextState: applyMutation(state, mutation),
      };
    }

    case 'set_widget_forecast': {
      const { widgetId, enabled, periods, showConfidenceBands } = args as {
        widgetId?: string;
        enabled?: boolean;
        periods?: number;
        showConfidenceBands?: boolean;
      };
      if (!widgetId || typeof widgetId !== 'string') {
        return {
          output: JSON.stringify({ error: 'set_widget_forecast requires a widgetId.' }),
          nextState: state,
        };
      }
      const widget = state.widgets[widgetId];
      if (!widget) {
        return {
          output: JSON.stringify({ error: `Widget '${widgetId}' not found.` }),
          nextState: state,
        };
      }
      const { chartType } = widget.config;
      if (chartType !== 'line' && chartType !== 'area') {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast only supports chartType 'line' or 'area'. Widget '${widgetId}' has chartType '${chartType ?? '(none)'}'.`,
          }),
          nextState: state,
        };
      }

      const forecastConfig = enabled
        ? {
            enabled: true,
            ...(periods != null ? { periods } : {}),
            method: 'linear' as const,
            ...(showConfidenceBands != null ? { showConfidenceBands } : {}),
          }
        : { enabled: false };

      const mutation: StateMutation = {
        type: 'updateWidget',
        args: { widgetId, changes: { config: { ...widget.config, forecast: forecastConfig } } },
      };
      return {
        output: JSON.stringify({ success: true, widgetId, forecast: forecastConfig }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    }

    default:
      return { output: JSON.stringify({ error: `Unknown tool: ${toolName}` }), nextState: state };
  }
}
