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

/**
 * The `apply` (state transition) and `label` (human-readable log line) logic for
 * a single mutation kind, co-located so the two can never drift apart.
 */
type MutationHandler<M extends StateMutation> = {
  apply: (state: StudioState, args: M['args']) => StudioState;
  label: (args: M['args']) => string;
};

/**
 * Exhaustive dispatch table over every `StateMutation` variant. The mapped type
 * `{ [M in StateMutation as M['type']]: MutationHandler<M> }` forces one entry
 * per mutation kind: omitting an entry for any variant — or adding a new variant
 * without a handler — is a compile-time error in this single place, rather than
 * a silent runtime fallback spread across two parallel switch statements.
 */
const MUTATION_HANDLERS: { [M in StateMutation as M['type']]: MutationHandler<M> } = {
  addPage: {
    apply: (state, args) => {
      const { id, title } = args;
      return {
        ...state,
        pages: {
          ...state.pages,
          [id]: { id, title, widgetRows: [] },
        },
        dashboard: { ...state.dashboard, activePageId: id },
      };
    },
    label: (args) => `addPage:${args.id}`,
  },

  setDashboardTitle: {
    apply: (state, args) => {
      return {
        ...state,
        dashboard: { ...state.dashboard, title: args.title },
      };
    },
    label: () => 'setDashboardTitle',
  },

  addWidget: {
    apply: (state, args) => {
      const { widget } = args;
      // Explicit, server-chosen target page — falls back to the active page for
      // legacy payloads. Never relies on "whatever page happens to be active on
      // the applying side", which is the page-targeting divergence this fixes.
      const pageId = args.pageId ?? state.dashboard.activePageId;
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
    },
    label: (args) => `addWidget:${args.widget.kind}:${args.widget.id}`,
  },

  updateWidget: {
    apply: (state, args) => {
      const { widgetId, changes, config } = args;
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
    },
    label: (args) => `updateWidget:${args.widgetId}`,
  },

  removeWidget: {
    apply: (state, args) => {
      const { widgetId } = args;
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
    },
    label: (args) => `removeWidget:${args.widgetId}`,
  },

  setWidgetLayout: {
    apply: (state, args) => {
      const activePageId = state.dashboard.activePageId;
      const activePage = state.pages[activePageId];
      if (!activePage) {
        return state;
      }
      return {
        ...state,
        pages: {
          ...state.pages,
          [activePageId]: { ...activePage, widgetRows: args.rows },
        },
      };
    },
    label: () => 'setWidgetLayout',
  },

  setWidgetColSpan: {
    apply: (state, args) => {
      const { widgetId, columns, rowWidgetIds } = args;
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
    },
    label: (args) => `setWidgetColSpan:${args.widgetId}`,
  },

  renamePage: {
    apply: (state, args) => {
      const { pageId, title } = args;
      const page = state.pages[pageId];
      if (!page) {
        return state;
      }
      return {
        ...state,
        pages: { ...state.pages, [pageId]: { ...page, title } },
      };
    },
    label: (args) => `renamePage:${args.pageId}`,
  },

  removePage: {
    apply: (state, args) => {
      const { pageId } = args;
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
    },
    label: (args) => `removePage:${args.pageId}`,
  },

  setActivePage: {
    apply: (state, args) => {
      const { pageId } = args;
      if (!state.pages[pageId]) {
        return state;
      }
      return {
        ...state,
        dashboard: { ...state.dashboard, activePageId: pageId },
      };
    },
    label: (args) => `setActivePage:${args.pageId}`,
  },

  addFilter: {
    apply: (state, args) => {
      // Applied verbatim — the filter already carries its target scope/page
      // (chosen server-side), so it is NOT re-stamped with the applying side's
      // active page (that would reintroduce a page-targeting divergence).
      return {
        ...state,
        filters: [...state.filters, args.filter],
      };
    },
    label: (args) => `addFilter:${args.filter.field}`,
  },

  removeFilter: {
    apply: (state, args) => {
      const { filterId } = args;
      const nextFilters = state.filters.filter((f: StudioFilterState) => f.id !== filterId);
      return nextFilters.length !== state.filters.length
        ? { ...state, filters: nextFilters }
        : state;
    },
    label: (args) => `removeFilter:${args.filterId}`,
  },

  applyBulkUpdate: {
    apply: (state, args) => {
      const { widgets, widgetRows, widgetColSpans, activePageId } = args;
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
    },
    label: () => 'applyBulkUpdate',
  },

  renameAIThread: {
    apply: (state, args) => {
      const activeThreadId = state.ai?.activeThreadId;
      if (!state.ai || !activeThreadId) {
        return state;
      }
      // `updatedAt` is stamped once by the producer (server-side) and carried in
      // the mutation, so the server-computed and client-applied results agree.
      // The reducer must never call `new Date()` itself (would be non-deterministic).
      const updatedThreads = (state.ai.threads ?? []).map((t) =>
        t.id === activeThreadId ? { ...t, name: args.name, updatedAt: args.updatedAt } : t,
      );
      return {
        ...state,
        ai: { ...state.ai, threads: updatedThreads },
      };
    },
    label: () => 'renameAIThread',
  },
};

export function applyMutation(state: StudioState, mutation: StateMutation): StudioState {
  // A single cast at the dispatch boundary: TS cannot prove that
  // `MUTATION_HANDLERS[mutation.type]` and `mutation.args` share the same `M`
  // (the correlation is lost once `mutation.type` is read), so we assert the
  // handler as the general shape. The mapped type above still guarantees a
  // handler exists for every variant known at compile time — but a value
  // arriving over the wire (SSE payload, legacy/forward-incompatible client)
  // is not guaranteed to match, so guard the lookup at runtime too.
  const handler = MUTATION_HANDLERS[mutation.type] as MutationHandler<StateMutation> | undefined;
  return handler ? handler.apply(state, mutation.args) : state;
}

/**
 * Compact, human-readable label for a mutation, used for the AI recent-mutation
 * log (client-side undo/redo history label + MCP `get_recent_changes`).
 */
export function mutationLabel(mutation: StateMutation): string {
  const handler = MUTATION_HANDLERS[mutation.type] as MutationHandler<StateMutation> | undefined;
  return handler ? handler.label(mutation.args) : (mutation as { type: string }).type;
}
