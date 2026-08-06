/**
 * Page mutations — add, rename, remove, reorder, and the active-page pointer.
 *
 * Removing a page is the one that reaches outside its own partition, because a page owns the
 * widgets on it and orphaning them is the failure mode.
 */
import { pruneDependsOnAgainstSelf } from '../dependsOnCascade';
import { isPlainRecord } from '../internalGuards';
import type { StudioFilterState } from '../stateTypes';
import { dropConflictingRankFilters, isSafePatchKey, removeWidgetIds } from './shared';
import type { HandlersFor } from './shared';

export const PAGE_MUTATION_HANDLERS: HandlersFor<
  | 'addPage'
  | 'renamePage'
  | 'removePage'
  | 'setActivePage'
  | 'reorderPages'
  | 'updateActivePage'
  | 'setPageStackBreakpoint'
> = {
  addPage: {
    apply: (state, args) => {
      const { id, title } = args;
      // Require a STRING id: an absent one passes `isSafePatchKey(undefined)` (the denylist
      // has no `undefined` member) and would mint a page keyed `"undefined"` with
      // `id: undefined`, while also setting `dashboard.activePageId` to `undefined` —
      // strictly worse than a no-op.
      if (typeof id !== 'string') {
        return state;
      }
      // Require a STRING title: `StudioDoc['pages'][string].title` is `string`, the canvas
      // page-tab renderer reads it directly, and no load-boundary screen catches a
      // non-string page title, so a bad value would corrupt the doc indefinitely.
      if (typeof title !== 'string') {
        return state;
      }
      // Screen the id against the prototype-hazard denylist. The literal
      // `{ ...pages, [id]: … }` uses define-semantics so there is no pollution risk, but an
      // `id` of `'__proto__'` would create a real own entry that the load-boundary key
      // screen drops on the next load — deferred data loss.
      if (!isSafePatchKey(id)) {
        return state;
      }
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

  renamePage: {
    apply: (state, args) => {
      const { pageId, title } = args;
      // Require a STRING `pageId` BEFORE the coercing existence check (string-id rule),
      // uniform with `removePage`/`setActivePage`. Benign today — the rename writes back
      // through the same bracket key the check matched — but the invariant is what keeps a
      // future non-coercing comparison from desyncing read and write here.
      if (typeof pageId !== 'string') {
        return state;
      }
      // `Object.hasOwn` guard so an untrusted `pageId` can't match a prototype member.
      if (!Object.hasOwn(state.pages, pageId)) {
        return state;
      }
      // Require a STRING title, same reasoning as `addPage`: `StudioDoc['pages'][string]
      // .title` is `string` and consumers render it directly with no fallback.
      if (typeof title !== 'string') {
        return state;
      }
      const page = state.pages[pageId];
      // Reference-equality no-op: writing the identical title returns the SAME doc so
      // `commitDocPatch`'s no-op guard skips a spurious undo entry.
      if (page.title === title) {
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
      // Require a STRING `pageId` (id-coercion desync): a numeric `42` would pass the
      // `Object.hasOwn` existence check (matching page `"42"`) and get the page deleted,
      // while the cleanup below compares by strict `===` (`f.scope.pageId !== pageId`,
      // `dashboard.activePageId === pageId`) and would therefore leave the page's filters
      // behind and never reassign the now-dangling `activePageId`.
      if (typeof pageId !== 'string') {
        return state;
      }
      // `Object.hasOwn` guard so an untrusted `pageId` can't match a prototype member.
      if (!Object.hasOwn(state.pages, pageId)) {
        return state;
      }
      // Refuse to remove the LAST page. "At least one page always exists" is a real
      // invariant of this doc shape: `createDefaultStudioState` seeds one, and every legacy
      // pageId-less mutation (`addWidget`/`setWidgetLayout`/`setWidgetColSpan` without an
      // explicit `pageId`) resolves its target through
      // `Object.hasOwn(state.pages, dashboard.activePageId)`. Removing the final page leaves
      // `activePageId: ''`, which satisfies no such guard — every one of those mutations
      // then no-ops forever with no error and no affordance to recover (the canvas renders
      // nothing, and `deserializeState` faithfully reconciles back to the same `''`).
      //
      // Synthesizing a replacement page instead is not an option: a fresh page needs a fresh
      // id, and this reducer must stay DETERMINISTIC so the server-threaded state
      // (`executeToolOnState`) and the client-applied state
      // (`StudioController.applyExternalMutation`) cannot diverge. A caller that wants an
      // empty dashboard adds the replacement page first, then removes this one.
      if (Object.keys(state.pages).length <= 1) {
        return state;
      }
      const page = state.pages[pageId];
      // Full cleanup, matching StudioController.removePage:
      //   drop the page, remove widgets that lived ONLY on it, drop page-scoped
      //   filters for it, and reassign activePageId when it was the active page.
      const widgetIdsOnPage = new Set((page.widgetRows ?? []).flat());

      const nextPages = { ...state.pages };
      delete nextPages[pageId];

      // Caller-specific first pass: drop every filter that loses its home the moment
      // this page is gone REGARDLESS of whether its anchor widget survives elsewhere —
      // page-scoped filters carrying this `pageId`, and any cross-filter/interactive
      // filter whose `scope.pageId` is the removed page (they are homeless whether or
      // not the source widget lives on another page). A `{ kind: 'widget' }` scope
      // carries no `pageId`, and a cross-filter/interactive scope pinned to a DIFFERENT
      // page is handled by `removeWidgetIds` below — but only if its source widget is
      // genuinely removed.
      const droppedPageFilters = state.filters.filter((f: StudioFilterState) => {
        const p = 'pageId' in f.scope ? f.scope.pageId : undefined;
        return p !== pageId;
      });
      // Cascade that drop into every surviving filter's `dependsOn` (the shared
      // `pruneDependsOn` invariant), or the cascade drawer stays pointed at a filter this
      // page removal just took away. Applied HERE rather than left to `removeWidgetIds`
      // below, because that primitive short-circuits and returns its input `filters`
      // untouched when the page held no exclusively-owned widget. Reference-stable, so a
      // page with no filters (or no `dependsOn` anywhere) still returns the SAME array.
      const filtersAfterPageDrop =
        droppedPageFilters.length === state.filters.length
          ? state.filters
          : pruneDependsOnAgainstSelf(droppedPageFilters);

      // Remove the page's widgets, but only those NOT still referenced on a surviving page:
      // a widget shared across pages keeps its `widgets` entry AND its widget-anchored
      // filters/spans — this is the one caller that relies on `removeWidgetIds`' cross-page
      // guard. The primitive also prunes genuinely-removed widgets'
      // widget/interactive/cross-filter-scoped filters and their stale spans everywhere.
      const {
        pages: prunedPages,
        widgets: nextWidgets,
        filters: nextFilters,
      } = removeWidgetIds(nextPages, state.widgets, filtersAfterPageDrop, widgetIdsOnPage);

      // Removing a page can RE-RESOLVE a surviving `widget`-scoped rank filter onto a
      // different page: a widget placed on both `p1` and `p2` resolves to `p1` while `p1`
      // exists, and to `p2` once it does not. If `p2` already holds a rank filter, the doc
      // is now live-valid and load-invalid, and the load boundary silently deletes one of
      // them. Same sweep the layout handlers run, for the same reason — the reducer and
      // the load boundary must agree at commit time, not at reload.
      const rankResolvedFilters = dropConflictingRankFilters(nextFilters, prunedPages);

      const remainingPageIds = Object.keys(prunedPages);
      // `?? ''` is unreachable — the last-page guard above guarantees a survivor — but is
      // kept as a total fallback rather than a non-null assertion.
      const nextActivePageId =
        state.dashboard.activePageId === pageId
          ? (remainingPageIds[0] ?? '')
          : state.dashboard.activePageId;

      return {
        ...state,
        pages: prunedPages,
        widgets: nextWidgets,
        filters: rankResolvedFilters,
        dashboard: { ...state.dashboard, activePageId: nextActivePageId },
      };
    },
    label: (args) => `removePage:${args.pageId}`,
  },

  setActivePage: {
    apply: (state, args) => {
      const { pageId } = args;
      // Require a STRING `pageId` (id-coercion desync): a numeric `42` passes the
      // `Object.hasOwn` existence check (matching page `"42"`) and would install verbatim as
      // `dashboard.activePageId`, violating its `string` type. Unlike a numeric
      // `widgetId`/removed-page `pageId`, this one does NOT self-heal on
      // serialize/deserialize either (see `deserializeState`'s reconciliation).
      if (typeof pageId !== 'string') {
        return state;
      }
      // `Object.hasOwn` guard so an untrusted `pageId` can't match a prototype member.
      if (!Object.hasOwn(state.pages, pageId)) {
        return state;
      }
      // Reference-equality no-op: activating the already-active page returns the SAME
      // doc (mirrors `addPage`'s same-page handling) so `commitDocPatch`'s no-op guard
      // skips a spurious undo entry.
      if (state.dashboard.activePageId === pageId) {
        return state;
      }
      return {
        ...state,
        dashboard: { ...state.dashboard, activePageId: pageId },
      };
    },
    label: (args) => `setActivePage:${args.pageId}`,
  },

  reorderPages: {
    apply: (state, args) => {
      const { pageIds } = args;
      if (!Array.isArray(pageIds)) {
        return state;
      }
      // Named ids first, in the given order; then every page the caller did not name, so a
      // partial list reorders what it mentions and never drops what it omits.
      //
      // BOTH record indexes need `Object.hasOwn`, for two different reasons:
      //
      // 1. `state.pages[id]` — `pageIds` is caller-authored and reaches here from the public
      //    `StudioHandle`. `['constructor', realPageId]` used to pass a truthiness check
      //    (`pages.constructor` is the inherited `Object` FUNCTION) and write that function into
      //    the result as a page, which was then committed straight into `doc.pages`: every later
      //    `Object.values(doc.pages)` iterated a function and the page tabs rendered a bogus
      //    entry — a prototype value persisted into the document.
      // 2. `!reordered[id]` — `reordered` starts as a plain `{}`, so a genuine page legitimately
      //    named `constructor`/`toString` read back as a truthy inherited function and was
      //    silently SKIPPED by the append-omitted-pages fallback, i.e. dropped entirely.
      const reordered: typeof state.pages = {};
      pageIds.forEach((id) => {
        if (typeof id === 'string' && Object.hasOwn(state.pages, id)) {
          reordered[id] = state.pages[id];
        }
      });
      Object.keys(state.pages).forEach((id) => {
        if (!Object.hasOwn(reordered, id)) {
          reordered[id] = state.pages[id];
        }
      });
      const currentKeys = Object.keys(state.pages);
      const nextKeys = Object.keys(reordered);
      const unchanged =
        currentKeys.length === nextKeys.length && currentKeys.every((k, i) => k === nextKeys[i]);
      return unchanged ? state : { ...state, pages: reordered };
    },
    label: () => 'reorderPages',
  },

  updateActivePage: {
    apply: (state, args) => {
      const { pageId, changes } = args;
      if (typeof pageId !== 'string' || !isPlainRecord(changes)) {
        return state;
      }
      const page = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
      if (!page) {
        return state;
      }
      // `id`/`widgetRows`/`widgetColSpans` are excluded by the args TYPE and re-excluded here:
      // writing them through this path would bypass row membership, duplicate-id and per-row
      // column-budget invariants that `setWidgetLayout`/`setAdjacentWidgetColSpans` own.
      // Dropped by KEY rather than by destructuring, so no throwaway bindings are introduced for
      // values that are deliberately ignored.
      const excluded = new Set(['id', 'widgetRows', 'widgetColSpans']);
      const safe: Record<string, unknown> = {};
      Object.keys(changes).forEach((key) => {
        if (!excluded.has(key)) {
          safe[key] = (changes as Record<string, unknown>)[key];
        }
      });
      const keys = Object.keys(safe);
      if (keys.length === 0 || keys.every((key) => safe[key] === (page as never)[key])) {
        return state;
      }
      return { ...state, pages: { ...state.pages, [pageId]: { ...page, ...safe } } };
    },
    label: (args) => `updateActivePage:${args.pageId}`,
  },

  setPageStackBreakpoint: {
    apply: (state, args) => {
      const { pageId, breakpoint } = args;
      if (typeof pageId !== 'string' || !Object.hasOwn(state.pages, pageId)) {
        return state;
      }
      const page = state.pages[pageId];
      if (page.stackBreakpoint === breakpoint) {
        return state;
      }
      return {
        ...state,
        pages: { ...state.pages, [pageId]: { ...page, stackBreakpoint: breakpoint } },
      };
    },
    label: (args) => `setPageStackBreakpoint:${args.pageId}`,
  },
};
