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

/**
 * Widget column-span unit system. This MUST match `canvasGridConstants.ts`
 * (`GRID_COLS` / `MIN_SPAN`) in `@mui/x-studio`, which is what `StudioCanvas`
 * actually renders and what the drag-resize handle
 * (`StudioController.setAdjacentWidgetColSpans`) commits. This package is
 * dependency-free (no React), so it cannot import that module — the constants are
 * mirrored here, and the round-trip test pins the two systems to the same values.
 *
 * The AI `set_widget_width` tool flows through the `setWidgetColSpan` handler
 * below, so it must clamp/rebalance in the SAME 24-column unit system the canvas
 * uses; otherwise a user drag-resize (24-col) and an AI resize (formerly 12-col)
 * would corrupt each other's layout.
 */
const GRID_COLS = 24;
/** Minimum column span any widget can be clamped to (~1/4 of the full row width). */
const MIN_SPAN = Math.round(GRID_COLS / 4);

/** Clamp a widget column span to the supported `MIN_SPAN`–`GRID_COLS` range. */
function clampSpan(span: number): number {
  // Guard non-finite input (a malformed wire payload can carry `NaN`, which would
  // otherwise survive clamping and serialize to `null` via JSON).
  if (!Number.isFinite(span)) {
    return MIN_SPAN;
  }
  return Math.max(MIN_SPAN, Math.min(GRID_COLS, Math.round(span)));
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
      // Idempotent: re-delivery of an addPage event for an existing id must not
      // reset that page's `widgetRows: []` (which would orphan its widgets). Only
      // re-activate it. `Object.hasOwn` (not `id in`/truthy access) so an untrusted
      // id like `'constructor'` can't match a prototype-chain member.
      if (Object.hasOwn(state.pages, id)) {
        return state.dashboard.activePageId === id
          ? state
          : { ...state, dashboard: { ...state.dashboard, activePageId: id } };
      }
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
      // `Object.hasOwn` existence check (not truthy `state.pages[pageId]`) so an
      // untrusted `pageId` like `'constructor'` resolves to "no such page" instead
      // of the `Object` prototype member (which would be treated as a page object).
      if (!Object.hasOwn(state.pages, pageId)) {
        return state;
      }
      const page = state.pages[pageId];
      // Idempotent: re-delivery of the same addWidget event (e.g. an SSE at-least-once
      // re-delivery) must not append a *second* `[widget.id]` row to the target page —
      // that would render the widget twice. Mirrors the existing-id guards in
      // `addPage`/`addFilter`: if the widget already exists AND this page's rows already
      // hold it, the mutation is already applied, so return `state` unchanged.
      if (
        Object.hasOwn(state.widgets, widget.id) &&
        (page.widgetRows ?? []).some((row) => row.includes(widget.id))
      ) {
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
      // `Object.hasOwn` (not truthy `state.widgets[widgetId]`) so an untrusted
      // `widgetId` like `'constructor'` is a clean "unknown id" no-op rather than
      // resolving to the `Object` prototype member and corrupting a write.
      if (!Object.hasOwn(state.widgets, widgetId)) {
        return state;
      }
      const existing = state.widgets[widgetId];
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
      // matches the historical client dispatch order). Keys whose value is
      // `undefined` are skipped so an in-process caller cannot void a required
      // field (e.g. `changes: { title: undefined }`) via the shallow merge.
      if (changes) {
        const definedChanges: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(changes)) {
          if (value !== undefined) {
            definedChanges[key] = value;
          }
        }
        if (Object.keys(definedChanges).length > 0) {
          updated = { ...updated, ...(definedChanges as Partial<StudioWidget>) };
        }
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
      // `Object.hasOwn` (not truthy `state.widgets[widgetId]`) so an untrusted
      // `widgetId` like `'constructor'`/`'__proto__'` is a clean no-op instead of
      // matching a prototype member and deleting/cleaning against a phantom widget.
      if (!Object.hasOwn(state.widgets, widgetId)) {
        return state;
      }
      const nextWidgets = { ...state.widgets };
      delete nextWidgets[widgetId];

      // Remove the widget from its page's rows (drop the now-empty row), and clean
      // up column spans: drop the removed widget's own span, and clear the span of a
      // widget that this removal leaves as the *sole occupant of the row it shared
      // with the removed widget* (that widget now auto-fills the row, so the span it
      // carried from the old multi-widget layout is stale). Mirrors the client's
      // `StudioController.removeWidget` so AI-driven and user-driven removals produce
      // identical layouts.
      //
      // Scoping is deliberate and load-bearing: only the row the widget was actually
      // removed from is collapsed, and only on the page that held it. A pre-existing
      // single-widget row can legitimately carry a stored span (see `setWidgetColSpan`
      // — e.g. an AI `set_widget_width` narrowing a lone widget to half-width), so
      // such spans on other rows/pages, and singleton rows that were already
      // singletons before this removal, must be left untouched. Sweeping every
      // singleton row across every page (the previous behavior) silently wiped those
      // intentional spans dashboard-wide on any unrelated removal.
      const nextPages = Object.fromEntries(
        Object.entries(state.pages).map(([pid, page]) => {
          const oldRows = page.widgetRows ?? [];
          // Widgets left alone in a row *because* this removal took their last
          // sibling — the only widgets whose stored span this removal makes stale.
          const orphanedSoleOccupants: string[] = [];
          let pageHeldWidget = false;
          const newRows: string[][] = [];
          for (const row of oldRows) {
            if (!row.includes(widgetId)) {
              newRows.push(row);
              continue;
            }
            pageHeldWidget = true;
            const filtered = row.filter((id) => id !== widgetId);
            // 2→1 collapse: several widgets shared this row and the removal leaves
            // exactly one behind, so that survivor's stored span is now stale.
            if (row.length >= 2 && filtered.length === 1) {
              orphanedSoleOccupants.push(filtered[0]);
            }
            if (filtered.length > 0) {
              newRows.push(filtered);
            }
          }

          // Only the page that actually held the removed widget can have spans made
          // stale by this removal; leave every other page entirely untouched
          // (including any intentional single-widget-row spans it carries).
          if (!pageHeldWidget) {
            return [pid, page];
          }

          const oldSpans = page.widgetColSpans;
          let nextSpans: Record<string, number> | undefined = oldSpans;
          if (oldSpans && (widgetId in oldSpans || orphanedSoleOccupants.length > 0)) {
            const { [widgetId]: removedSpan, ...rest } = oldSpans;
            void removedSpan;
            for (const soleOccupantId of orphanedSoleOccupants) {
              delete rest[soleOccupantId];
            }
            nextSpans = Object.keys(rest).length > 0 ? rest : undefined;
          }

          return [pid, { ...page, widgetRows: newRows, widgetColSpans: nextSpans }];
        }),
      );

      // Drop filters that only made sense while the widget existed: widget-scoped
      // conditions, the interactive filters it emitted, and the cross-filters it
      // emitted (a removed source widget would otherwise leave the whole page
      // filtered with no way to clear it — its clearing affordance is gone).
      const nextFilters = state.filters.filter(
        (f: StudioFilterState) =>
          !(f.scope.kind === 'widget' && f.scope.widgetId === widgetId) &&
          !(f.scope.kind === 'interactive' && f.scope.sourceWidgetId === widgetId) &&
          !(f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === widgetId),
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
      // Explicit, server-chosen target page — falls back to the active page for
      // legacy payloads, mirroring `addWidget.pageId`.
      const targetPageId = args.pageId ?? state.dashboard.activePageId;
      const targetPage = state.pages[targetPageId];
      if (!targetPage) {
        return state;
      }
      return {
        ...state,
        pages: {
          ...state.pages,
          [targetPageId]: { ...targetPage, widgetRows: args.rows },
        },
      };
    },
    label: () => 'setWidgetLayout',
  },

  setWidgetColSpan: {
    apply: (state, args) => {
      const { widgetId, columns } = args;
      // Explicit, server-chosen target page — falls back to the active page for
      // legacy payloads, mirroring `addWidget.pageId`.
      const targetPageId = args.pageId ?? state.dashboard.activePageId;
      // `Object.hasOwn` guard (not truthy `state.pages[targetPageId]`) so an
      // untrusted `pageId` can't resolve to a prototype member.
      if (!Object.hasOwn(state.pages, targetPageId)) {
        return state;
      }
      const targetPage = state.pages[targetPageId];
      // Derive the row's membership from the *current* state's `widgetRows` (which row
      // actually holds `widgetId` right now) rather than trusting `args.rowWidgetIds`.
      // The producer (`executeToolOnState`'s `set_widget_width`) computed
      // `rowWidgetIds` from the server's turn-start snapshot; if the user drags widgets
      // between rows on the client while an agentic turn is still running, that
      // wire-supplied grouping goes stale, and rebalancing/clearing spans against it
      // would touch widgets that no longer share this widget's row. This is the same
      // stale-snapshot class the explicit `pageId` arg fixed for page targeting.
      // Fall back to `args.rowWidgetIds` only when the widget isn't in any row yet
      // (mirrors the producer's own `?? [widgetId]` fallback for a not-yet-placed
      // widget) — otherwise the derived current row wins.
      const currentRow = (targetPage.widgetRows ?? []).find((row) => row.includes(widgetId));
      const rowWidgetIds = currentRow ?? args.rowWidgetIds;
      const clamped = columns == null ? null : clampSpan(columns);
      const newSpans: Record<string, number> = { ...(targetPage.widgetColSpans ?? {}) };

      if (clamped == null) {
        delete newSpans[widgetId];
      } else {
        newSpans[widgetId] = clamped;
        const otherIds = rowWidgetIds.filter((id) => id !== widgetId);
        // `Object.hasOwn` per id (not `newSpans[id] ?? 0`) so an untrusted id from
        // the wire-supplied `rowWidgetIds` reads 0, never an `Object` prototype
        // member (which would poison the sum with `NaN`).
        const otherTotal = otherIds.reduce(
          (sum, id) => sum + (Object.hasOwn(newSpans, id) ? newSpans[id] : 0),
          0,
        );
        if (clamped + otherTotal > GRID_COLS) {
          if (otherIds.length === 1) {
            const remaining = GRID_COLS - clamped;
            if (remaining >= MIN_SPAN) {
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
          [targetPageId]: {
            ...targetPage,
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
      // `Object.hasOwn` guard so an untrusted `pageId` can't match a prototype member.
      if (!Object.hasOwn(state.pages, pageId)) {
        return state;
      }
      const page = state.pages[pageId];
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
      // `Object.hasOwn` guard so an untrusted `pageId` can't match a prototype member.
      if (!Object.hasOwn(state.pages, pageId)) {
        return state;
      }
      const page = state.pages[pageId];
      // Full cleanup, matching StudioController.removePage:
      //   drop the page, remove widgets that lived on it, drop page-scoped
      //   filters for it, and reassign activePageId when it was the active page.
      const widgetIdsOnPage = new Set((page.widgetRows ?? []).flat());

      const nextPages = { ...state.pages };
      delete nextPages[pageId];

      const nextWidgets = Object.fromEntries(
        Object.entries(state.widgets).filter(([id]) => !widgetIdsOnPage.has(id)),
      );

      // Drop filters that no longer have a home: those scoped directly to the page
      // (they carry `pageId`), plus widget/interactive/cross-filter scopes that
      // target a widget that lived on the removed page. A `{ kind: 'widget' }`
      // scope carries no `pageId`, so without this its filter would survive as a
      // permanent orphan (its anchor widget is gone, so no UI can ever remove it).
      const nextFilters = state.filters.filter((f: StudioFilterState) => {
        const p = 'pageId' in f.scope ? f.scope.pageId : undefined;
        if (p === pageId) {
          return false;
        }
        if (f.scope.kind === 'widget' && widgetIdsOnPage.has(f.scope.widgetId)) {
          return false;
        }
        if (
          (f.scope.kind === 'interactive' || f.scope.kind === 'cross-filter') &&
          widgetIdsOnPage.has(f.scope.sourceWidgetId)
        ) {
          return false;
        }
        return true;
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
      // `Object.hasOwn` guard so an untrusted `pageId` can't match a prototype member.
      if (!Object.hasOwn(state.pages, pageId)) {
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
      // Idempotent: re-delivery of the same addFilter SSE event must not append a
      // duplicate (unlike a fresh filter, the id already exists).
      if (state.filters.some((f) => f.id === args.filter.id)) {
        return state;
      }
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
      if (!state.ai) {
        return state;
      }
      // Explicit, server-stamped target thread — falls back to the applying side's
      // active thread only for legacy payloads. Targeting an explicit id keeps the
      // rename on the thread the request belongs to even if the user switched
      // threads while the model was running.
      const targetThreadId = args.threadId ?? state.ai.activeThreadId;
      if (!targetThreadId) {
        return state;
      }
      // `updatedAt` is stamped once by the producer (server-side) and carried in
      // the mutation, so the server-computed and client-applied results agree.
      // The reducer must never call `new Date()` itself (would be non-deterministic).
      const updatedThreads = (state.ai.threads ?? []).map((t) =>
        t.id === targetThreadId ? { ...t, name: args.name, updatedAt: args.updatedAt } : t,
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
