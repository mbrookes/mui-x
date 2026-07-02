/**
 * The single semantic authority for applying a `StateMutation` to `StudioState`.
 *
 * Both transports use this pure reducer for the state-transformation step:
 *  - the AI middleware server computes `nextState = applyMutation(state, mutation)`
 *    in `executeToolOnState` (threading it to the model and, for MCP, to the state box);
 *  - the client applies the same function inside `StudioController.applyExternalMutation`
 *    when a `state-mutation` SSE event arrives.
 *
 * Because it is the one implementation of every mutation's effect, the
 * server-threaded state and the client-applied state can no longer disagree.
 *
 * Side effects a pure reducer cannot own (undo-stack management, title
 * inference from live data sources, React shell selection) are intentionally
 * NOT performed here — they stay in `StudioController`. This reducer captures
 * only the persisted state-shape transformation.
 */
import type { StudioState, StudioFilterState } from './stateTypes';
import type { StudioWidget } from './widgetTypes';
import type { StateMutation } from './aiTypes';

/** Clamp a widget column span to the supported 3–12 range. */
function clampSpan(span: number): number {
  return Math.max(3, Math.min(12, Math.round(span)));
}

export function applyMutation(state: StudioState, mutation: StateMutation): StudioState {
  switch (mutation.type) {
    case 'addPage': {
      const { id, title } = mutation.args;
      return {
        ...state,
        pages: {
          ...state.pages,
          [id]: { id, title, widgetRows: [] },
        },
        dashboard: { ...state.dashboard, activePageId: id },
      };
    }

    case 'setDashboardTitle': {
      return {
        ...state,
        dashboard: { ...state.dashboard, title: mutation.args.title },
      };
    }

    case 'addWidget': {
      const { widget } = mutation.args;
      // Explicit, server-chosen target page — falls back to the active page for
      // legacy payloads. Never relies on "whatever page happens to be active on
      // the applying side", which is the page-targeting divergence this fixes.
      const pageId = mutation.args.pageId ?? state.dashboard.activePageId;
      const page = state.pages[pageId];
      if (!page) {
        return state;
      }
      return {
        ...state,
        widgets: { ...state.widgets, [widget.id]: widget },
        pages: {
          ...state.pages,
          [pageId]: {
            ...page,
            widgetRows: [...(page.widgetRows ?? []), [widget.id]],
          },
        },
      };
    }

    case 'updateWidget': {
      const { widgetId, changes, config } = mutation.args;
      const existing = state.widgets[widgetId];
      if (!existing) {
        return state;
      }
      let updated: StudioWidget = existing;
      // `config` is a partial config patch (mirrors `updateWidgetConfig`):
      // keys with an `undefined` value are removed.
      if (config !== undefined) {
        const nextConfig = { ...existing.config } as Record<string, unknown>;
        for (const [key, value] of Object.entries(config)) {
          if (value === undefined) {
            delete nextConfig[key];
          } else {
            nextConfig[key] = value;
          }
        }
        updated = { ...updated, config: nextConfig as StudioWidget['config'] };
      }
      // `changes` is a shallow merge onto the widget (may itself carry a full
      // `config` object, which replaces the partial-merge result above — this
      // matches the historical client dispatch order).
      if (changes && Object.keys(changes).length > 0) {
        updated = { ...updated, ...changes };
      }
      return {
        ...state,
        widgets: { ...state.widgets, [widgetId]: updated },
      };
    }

    case 'removeWidget': {
      const { widgetId } = mutation.args;
      if (!state.widgets[widgetId]) {
        return state;
      }
      const nextWidgets = { ...state.widgets };
      delete nextWidgets[widgetId];

      // Remove the widget from every page's rows (drop now-empty rows).
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

      // Drop filters that only made sense while the widget existed
      // (widget-scoped conditions and interactive cross-filters it emitted).
      const nextFilters = state.filters.filter(
        (f: StudioFilterState) =>
          !(f.scope.kind === 'widget' && f.scope.widgetId === widgetId) &&
          !(f.scope.kind === 'interactive' && f.scope.sourceWidgetId === widgetId),
      );

      return {
        ...state,
        widgets: nextWidgets,
        pages: nextPages,
        filters: nextFilters.length !== state.filters.length ? nextFilters : state.filters,
      };
    }

    case 'setWidgetLayout': {
      const activePageId = state.dashboard.activePageId;
      const activePage = state.pages[activePageId];
      if (!activePage) {
        return state;
      }
      return {
        ...state,
        pages: {
          ...state.pages,
          [activePageId]: { ...activePage, widgetRows: mutation.args.rows },
        },
      };
    }

    case 'setWidgetColSpan': {
      const { widgetId, columns, rowWidgetIds } = mutation.args;
      const activePageId = state.dashboard.activePageId;
      const activePage = state.pages[activePageId];
      if (!activePage) {
        return state;
      }
      const clamped = columns == null ? null : clampSpan(columns);
      const newSpans: Record<string, number> = { ...(activePage.widgetColSpans ?? {}) };

      if (clamped == null) {
        delete newSpans[widgetId];
      } else {
        newSpans[widgetId] = clamped;
        const otherIds = rowWidgetIds.filter((id) => id !== widgetId);
        const otherTotal = otherIds.reduce((sum, id) => sum + (newSpans[id] ?? 0), 0);
        if (clamped + otherTotal > 12) {
          if (otherIds.length === 1) {
            const remaining = 12 - clamped;
            if (remaining >= 3) {
              newSpans[otherIds[0]] = remaining;
            } else {
              delete newSpans[otherIds[0]];
            }
          } else {
            for (const id of otherIds) {
              delete newSpans[id];
            }
          }
        }
      }

      return {
        ...state,
        pages: {
          ...state.pages,
          [activePageId]: {
            ...activePage,
            widgetColSpans: Object.keys(newSpans).length > 0 ? newSpans : undefined,
          },
        },
      };
    }

    case 'renamePage': {
      const { pageId, title } = mutation.args;
      const page = state.pages[pageId];
      if (!page) {
        return state;
      }
      return {
        ...state,
        pages: { ...state.pages, [pageId]: { ...page, title } },
      };
    }

    case 'removePage': {
      const { pageId } = mutation.args;
      const page = state.pages[pageId];
      if (!page) {
        return state;
      }
      // Full cleanup, matching StudioController.removePage:
      //   drop the page, remove widgets that lived on it, drop page-scoped
      //   filters for it, and reassign activePageId when it was the active page.
      const widgetIdsOnPage = new Set((page.widgetRows ?? []).flat());

      const nextPages = { ...state.pages };
      delete nextPages[pageId];

      const nextWidgets = Object.fromEntries(
        Object.entries(state.widgets).filter(([id]) => !widgetIdsOnPage.has(id)),
      );

      const nextFilters = state.filters.filter((f: StudioFilterState) => {
        const p = 'pageId' in f.scope ? f.scope.pageId : undefined;
        return p !== pageId;
      });

      const remainingPageIds = Object.keys(nextPages);
      const nextActivePageId =
        state.dashboard.activePageId === pageId
          ? (remainingPageIds[0] ?? '')
          : state.dashboard.activePageId;

      return {
        ...state,
        pages: nextPages,
        widgets: nextWidgets,
        filters: nextFilters,
        dashboard: { ...state.dashboard, activePageId: nextActivePageId },
      };
    }

    case 'setActivePage': {
      const { pageId } = mutation.args;
      if (!state.pages[pageId]) {
        return state;
      }
      return {
        ...state,
        dashboard: { ...state.dashboard, activePageId: pageId },
      };
    }

    case 'addFilter': {
      // Applied verbatim — the filter already carries its target scope/page
      // (chosen server-side), so it is NOT re-stamped with the applying side's
      // active page (that would reintroduce a page-targeting divergence).
      return {
        ...state,
        filters: [...state.filters, mutation.args.filter],
      };
    }

    case 'removeFilter': {
      const { filterId } = mutation.args;
      const nextFilters = state.filters.filter((f: StudioFilterState) => f.id !== filterId);
      return nextFilters.length !== state.filters.length
        ? { ...state, filters: nextFilters }
        : state;
    }

    case 'applyBulkUpdate': {
      const { widgets, widgetRows, widgetColSpans, activePageId } = mutation.args;
      const page = state.pages[activePageId];
      if (!page) {
        return state;
      }
      return {
        ...state,
        widgets,
        pages: {
          ...state.pages,
          [activePageId]: { ...page, widgetRows, widgetColSpans },
        },
      };
    }

    case 'renameAIThread': {
      const activeThreadId = state.ai?.activeThreadId;
      if (!state.ai || !activeThreadId) {
        return state;
      }
      const updatedThreads = (state.ai.threads ?? []).map((t) =>
        t.id === activeThreadId
          ? { ...t, name: mutation.args.name, updatedAt: new Date().toISOString() }
          : t,
      );
      return {
        ...state,
        ai: { ...state.ai, threads: updatedThreads },
      };
    }

    default: {
      // Exhaustiveness guard — a new mutation type without a case is a compile error.
      const exhaustiveCheck: never = mutation;
      void exhaustiveCheck;
      return state;
    }
  }
}

/**
 * Compact, human-readable label for a mutation, used for the AI recent-mutation
 * log (client-side undo/redo history label + MCP `get_recent_changes`).
 */
export function mutationLabel(mutation: StateMutation): string {
  switch (mutation.type) {
    case 'addPage':
      return `addPage:${mutation.args.id}`;
    case 'setDashboardTitle':
      return 'setDashboardTitle';
    case 'addWidget':
      return `addWidget:${mutation.args.widget.kind}:${mutation.args.widget.id}`;
    case 'updateWidget':
      return `updateWidget:${mutation.args.widgetId}`;
    case 'removeWidget':
      return `removeWidget:${mutation.args.widgetId}`;
    case 'setWidgetLayout':
      return 'setWidgetLayout';
    case 'setWidgetColSpan':
      return `setWidgetColSpan:${mutation.args.widgetId}`;
    case 'renamePage':
      return `renamePage:${mutation.args.pageId}`;
    case 'removePage':
      return `removePage:${mutation.args.pageId}`;
    case 'setActivePage':
      return `setActivePage:${mutation.args.pageId}`;
    case 'addFilter':
      return `addFilter:${mutation.args.filter.field}`;
    case 'removeFilter':
      return `removeFilter:${mutation.args.filterId}`;
    case 'applyBulkUpdate':
      return 'applyBulkUpdate';
    case 'renameAIThread':
      return 'renameAIThread';
    default:
      return (mutation as { type: string }).type;
  }
}
