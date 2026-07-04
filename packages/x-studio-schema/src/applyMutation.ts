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
 * Widget column-span unit system, and the single source of truth for it.
 * `canvasGridConstants.ts` (what `StudioCanvas` renders) and `StudioController`
 * (what the drag-resize handle `setAdjacentWidgetColSpans` commits) in
 * `@mui/x-studio` both import these exact values from here.
 *
 * The dependency arrow runs `x-studio` → `x-studio-schema` (the client depends on
 * the schema package, never the reverse), so this dependency-free package is the
 * correct single home for the constant — there is no cycle risk, and the previous
 * four-way duplication (this file + `canvasGridConstants.ts` + `StudioController`
 * + the round-trip test) is consolidated here.
 *
 * The AI `set_widget_width` tool flows through the `setWidgetColSpan` handler
 * below, so it must clamp/rebalance in the SAME 24-column unit system the canvas
 * uses; otherwise a user drag-resize (24-col) and an AI resize (formerly 12-col)
 * would corrupt each other's layout.
 */
export const GRID_COLS = 24;
/** Minimum column span any widget can be clamped to (~1/4 of the full row width). */
export const MIN_SPAN = Math.round(GRID_COLS / 4);

/** Clamp a widget column span to the supported `MIN_SPAN`–`GRID_COLS` range. */
function clampSpan(span: number): number {
  // Guard non-finite input (a malformed wire payload can carry `NaN`, which would
  // otherwise survive clamping and serialize to `null` via JSON).
  if (!Number.isFinite(span)) {
    return MIN_SPAN;
  }
  return Math.max(MIN_SPAN, Math.min(GRID_COLS, Math.round(span)));
}

// Drop widget/interactive/cross-filter-scoped filters anchored to any removed
// widget. Extracted from `removeWidget` so `applyBulkUpdate` can enforce the same
// invariant for every widget its bulk replacement drops (a removed source widget
// would otherwise leave the page permanently filtered with no clearing affordance).
// Returns the same array reference when nothing is dropped, preserving the
// reference-stable no-op behaviour callers rely on.
function dropWidgetScopedFilters(
  filters: StudioFilterState[],
  isRemoved: (widgetId: string) => boolean,
): StudioFilterState[] {
  const next = filters.filter(
    (f) =>
      !(f.scope.kind === 'widget' && isRemoved(f.scope.widgetId)) &&
      !(f.scope.kind === 'interactive' && isRemoved(f.scope.sourceWidgetId)) &&
      !(f.scope.kind === 'cross-filter' && isRemoved(f.scope.sourceWidgetId)),
  );
  return next.length === filters.length ? filters : next;
}

/**
 * Remove the given widget ids' entries from a page's `widgetColSpans`, collapsing
 * an emptied map to `undefined`. Returns the same reference when no entry matched
 * (so callers can skip rebuilding the page). `ids` is looked up via a `Set` so an
 * untrusted id (`'constructor'`, `'__proto__'`) can never reach into the record's
 * prototype chain. Shared by `removeWidget` (its own span + orphaned sole-occupant
 * spans) and `applyBulkUpdate` (removed widgets' stale spans on other pages).
 */
function removeSpanEntries(
  spans: Record<string, number> | undefined,
  ids: Iterable<string>,
): Record<string, number> | undefined {
  if (!spans) {
    return spans;
  }
  const idSet = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
  let changed = false;
  const rest: Record<string, number> = {};
  for (const key of Object.keys(spans)) {
    if (idSet.has(key)) {
      changed = true;
    } else {
      rest[key] = spans[key];
    }
  }
  if (!changed) {
    return spans;
  }
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Enforce the col-span invariants a fresh `widgetRows` layout must satisfy, given
 * the layout it replaced. Used by `setWidgetLayout`, whose AI-driven path was
 * previously the only layout mutation that skipped the cleanup the user
 * drag-and-drop path (`pruneWidgetColSpan` in `StudioCanvas`) and `removeWidget`
 * both perform. Three invariants, matching the existing paths' semantics:
 *
 *  - **2→1 collapse:** a widget left alone in a row that it previously shared with
 *    others has a stale multi-widget-era span, so its span is cleared (mirrors
 *    `removeWidget`'s sole-occupant handling). A widget that was *already* a lone
 *    occupant keeps its intentional span (e.g. an AI `set_widget_width` narrowing).
 *  - **row overflow:** a row whose members' spans sum to more than `GRID_COLS` is
 *    invalid; with no explicit anchor to rebalance around, every span in that row
 *    is dropped so it falls back to equal flex distribution — matching
 *    `setWidgetColSpan`'s multi-other-widget overflow branch (which drops all
 *    sibling spans rather than inventing new clamping).
 *  - **orphaned span:** a span for a widget no longer present in this page's rows
 *    is dead weight and is dropped.
 */
function enforceLayoutColSpans(
  oldRows: string[][],
  newRows: string[][],
  spans: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!spans) {
    return spans;
  }
  const oldRowLenByWidget = new Map<string, number>();
  for (const row of oldRows) {
    for (const id of row) {
      oldRowLenByWidget.set(id, row.length);
    }
  }
  const next: Record<string, number> = { ...spans };
  const present = new Set<string>();
  for (const row of newRows) {
    for (const id of row) {
      present.add(id);
    }
    if (row.length === 1) {
      const id = row[0];
      // Clear a survivor's stale span only when its row actually collapsed from
      // several widgets to one — never a pre-existing intentional singleton span.
      if (Object.hasOwn(next, id) && (oldRowLenByWidget.get(id) ?? 1) >= 2) {
        delete next[id];
      }
    } else if (row.length >= 2) {
      const sum = row.reduce((acc, id) => acc + (Object.hasOwn(next, id) ? next[id] : 0), 0);
      if (sum > GRID_COLS) {
        for (const id of row) {
          delete next[id];
        }
      }
    }
  }
  for (const id of Object.keys(next)) {
    if (!present.has(id)) {
      delete next[id];
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
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

          // Drop the removed widget's own span plus any survivor's now-stale span,
          // via the shared `removeSpanEntries` helper (Set-based lookup, so an
          // untrusted `widgetId` can't reach the record's prototype chain the way a
          // bare `widgetId in oldSpans` could).
          const nextSpans = removeSpanEntries(page.widgetColSpans, [
            widgetId,
            ...orphanedSoleOccupants,
          ]);

          return [pid, { ...page, widgetRows: newRows, widgetColSpans: nextSpans }];
        }),
      );

      // Drop filters that only made sense while the widget existed: widget-scoped
      // conditions, the interactive filters it emitted, and the cross-filters it
      // emitted (a removed source widget would otherwise leave the whole page
      // filtered with no way to clear it — its clearing affordance is gone).
      const nextFilters = dropWidgetScopedFilters(state.filters, (id) => id === widgetId);

      return {
        ...state,
        widgets: nextWidgets,
        pages: nextPages,
        filters: nextFilters,
      };
    },
    label: (args) => `removeWidget:${args.widgetId}`,
  },

  setWidgetLayout: {
    apply: (state, args) => {
      // Explicit, server-chosen target page — falls back to the active page for
      // legacy payloads, mirroring `addWidget.pageId`.
      const targetPageId = args.pageId ?? state.dashboard.activePageId;
      // `Object.hasOwn` guard (not truthy `state.pages[targetPageId]`) so an
      // untrusted `pageId` can't resolve to a prototype member.
      if (!Object.hasOwn(state.pages, targetPageId)) {
        return state;
      }
      const targetPage = state.pages[targetPageId];
      // Replacing a page's rows verbatim can leave the col-spans invalid: a row
      // collapsed to a sole occupant keeps its stale multi-widget span, and a row
      // merged from two widgets can sum past `GRID_COLS`. Enforce the same
      // invariants the user drag-and-drop path (`pruneWidgetColSpan`) and
      // `removeWidget` already do, diffing the old rows against the new ones.
      const nextSpans = enforceLayoutColSpans(
        targetPage.widgetRows ?? [],
        args.rows,
        targetPage.widgetColSpans,
      );
      return {
        ...state,
        pages: {
          ...state.pages,
          [targetPageId]: { ...targetPage, widgetRows: args.rows, widgetColSpans: nextSpans },
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
      const { removedWidgetIds, addedWidgets, updatedWidgets, widgetRows, widgetColSpans } = args;
      const { activePageId } = args;
      // `Object.hasOwn` guard so an untrusted `activePageId` can't match a prototype member.
      if (!Object.hasOwn(state.pages, activePageId)) {
        return state;
      }
      const page = state.pages[activePageId];

      const nextPages: StudioState['pages'] = {
        ...state.pages,
        [activePageId]: { ...page, widgetRows, widgetColSpans },
      };

      // A widget named in `removedWidgetIds` is only *genuinely gone* if it doesn't
      // still appear on some OTHER page's rows. The producer already restricts
      // `removedWidgetIds` to widgets that were on `activePageId`, so this only
      // matters for the rare case of the same id also living on another page (a
      // pre-existing cross-page id collision) — deleting it from `state.widgets`
      // in that case would leave a dangling id in the other page's rows (blank
      // card), so it must be preserved, not removed.
      const removedIds = new Set<string>();
      if (removedWidgetIds && removedWidgetIds.length > 0) {
        const stillReferenced = new Set<string>();
        for (const p of Object.values(nextPages)) {
          for (const row of p.widgetRows ?? []) {
            for (const id of row) {
              stillReferenced.add(id);
            }
          }
        }
        for (const id of removedWidgetIds) {
          if (!stillReferenced.has(id)) {
            removedIds.add(id);
          }
        }
      }

      // Apply the widget deltas on top of the CURRENT `state.widgets` — never a
      // turn-start snapshot — so any widget the user concurrently created or edited
      // (on this page or any other) while the agentic turn was running survives.
      // Only genuinely-removed ids are deleted; added/updated targets are applied
      // as specified.
      const nextWidgets = { ...state.widgets };
      for (const id of removedIds) {
        delete nextWidgets[id];
      }
      for (const widget of addedWidgets ?? []) {
        nextWidgets[widget.id] = widget;
      }
      for (const update of updatedWidgets ?? []) {
        const existing = nextWidgets[update.widgetId];
        // Skip patches for widgets that no longer exist (e.g. removed out from under
        // the update by a concurrent edit) rather than resurrecting a partial widget.
        if (!existing) {
          continue;
        }
        nextWidgets[update.widgetId] = {
          ...existing,
          ...(update.title !== undefined ? { title: update.title } : {}),
          ...(update.sourceId !== undefined ? { sourceId: update.sourceId } : {}),
          // `config` is a shallow-merge patch onto the LIVE widget's config, so a
          // concurrent edit to a different config key is preserved.
          ...(update.config
            ? { config: { ...existing.config, ...update.config } as StudioWidget['config'] }
            : {}),
        };
      }

      // Mirror `removeWidget`'s per-widget cleanup for each genuinely-removed widget:
      // drop its widget/interactive/cross-filter-scoped filters, and prune any stale
      // col-span entry it left on OTHER pages (the active page's spans are replaced
      // wholesale above, so only other pages can still carry them).
      if (removedIds.size > 0) {
        for (const [pid, p] of Object.entries(nextPages)) {
          if (pid === activePageId) {
            continue;
          }
          const prunedSpans = removeSpanEntries(p.widgetColSpans, removedIds);
          if (prunedSpans !== p.widgetColSpans) {
            nextPages[pid] = { ...p, widgetColSpans: prunedSpans };
          }
        }
      }

      const nextFilters =
        removedIds.size > 0
          ? dropWidgetScopedFilters(state.filters, (id) => removedIds.has(id))
          : state.filters;

      return {
        ...state,
        widgets: nextWidgets,
        pages: nextPages,
        filters: nextFilters,
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
