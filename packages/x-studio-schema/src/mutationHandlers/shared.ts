/**
 * The pieces more than one mutation domain needs.
 *
 * Deliberately small. The domain tables under this directory are almost fully separable, so
 * anything landing here should be genuinely cross-cutting rather than merely convenient.
 *
 * `removeWidgetIds` is why this is not smaller: removing a PAGE removes the widgets on it, so
 * "drop these widget ids, and reconcile the spans and filters that referenced them" is an
 * operation both the page domain and the widget domain perform. One implementation, not two that
 * agree by inspection.
 */
import type { StateMutation } from '../aiTypes';
import { pruneDependsOnAgainstSelf } from '../dependsOnCascade';
import { dedupeRankFilters } from '../rankFilterScope';
import type { StudioDoc, StudioFilterState } from '../stateTypes';
import { isSafeKey } from '../unsafeKeys';
import { removeSpanEntries, withSpans } from './layout';

/**
 * Local name for the shared {@link isSafeKey} guard (`unsafeKeys.ts`): rejects the
 * prototype-polluting `__proto__`/`constructor`/`prototype` keys. Guarded wherever the
 * reducer rebuilds a record key-by-key from untrusted input (`updateWidget`'s
 * `config`/`changes` loops, `applyBulkUpdate`'s span rebuild and widget inserts). The
 * wire boundary (`parseStateMutation`) rejects these too — this is the defense-in-depth
 * copy for mutations the server constructs WITHOUT the parser (`executeToolOnState`
 * builds them straight from LLM tool arguments).
 */
export const isSafePatchKey = isSafeKey;

/*
 * Shape-guard convention used throughout the handlers below.
 *
 * Most mutations reach this reducer through `parseStateMutation`, which type-checks every
 * field. But the AI middleware's `executeToolOnState` builds mutations straight from LLM
 * tool arguments WITHOUT the parser, so each handler re-checks the shapes it depends on and
 * returns the input `state` reference — the reducer's documented no-op — for anything it
 * cannot apply. Three recurring reasons a guard exists, referenced by name below rather
 * than re-argued at each site:
 *
 *  - **crash prevention** — the handler would throw reading the field (`args.rows.map` on a
 *    non-array, `widget.id` on `undefined`), and a reducer that throws mid-apply leaves the
 *    server-threaded and client-applied states diverged.
 *  - **id-coercion desync** — `Object.hasOwn(record, key)` COERCES its key to a string,
 *    while `===`, `Array.prototype.includes` and `Set` membership never do. A non-string id
 *    therefore matches the flat map (`Object.hasOwn(widgets, 42)` finds widget `"42"`) but
 *    misses every row/filter/span comparison keyed off the string — a half-applied mutation.
 *    Requiring `typeof id === 'string'` up front is what keeps the two agreeing.
 *  - **deferred data loss** — the value installs fine now, and then `deserializeState`'s
 *    load-boundary screen drops the key (or the whole widget/filter) on the next load. The
 *    write-time guard makes the reducer and the load boundary agree, so nothing silently
 *    disappears on reload.
 */

/**
 * Resolve a mutation's target page: the explicit, server-chosen `args.pageId` when it names
 * one, else the applying side's active page (the legacy pageId-less fallback).
 *
 * The ONE implementation of that resolution, shared by `addWidget`, `setWidgetLayout` and
 * `setWidgetColSpan`, so the string-id rule is applied to `args.pageId` uniformly. A
 * non-string explicit `pageId` returns `undefined` (the caller no-ops) rather than being
 * handed to the COERCING `Object.hasOwn(state.pages, pageId)` existence check: a numeric
 * `42` would otherwise resolve to a page keyed `"42"` and the mutation would apply to it.
 * Those three handlers happen to be safe under coercion today — each writes back through
 * the same bracket key it read, so read and write agree — but that is a property of their
 * current bodies, not of the resolution, and one added `Set.has`/`===`/`.includes` (exactly
 * what broke `removeWidget`/`removePage`/`setWidgetColSpan`) would silently split them.
 *
 * `null` is treated as ABSENT alongside `undefined`, preserving the `??` semantics these
 * call sites had: a producer that spells "no explicit page" as JSON `null` still gets the
 * active-page fallback rather than a no-op.
 */
/**
 * Shared three-state resolution used by {@link resolveTargetPageId} and
 * {@link resolveTargetThreadId}: nullish `id` ⇒ `fallback`, a `string` `id` ⇒ that id,
 * anything else (a non-string, non-nullish value) ⇒ `undefined` so the caller no-ops
 * rather than being handed to a COERCING lookup (see the callers' docs for why that
 * matters).
 */
export function resolveTargetId(id: unknown, fallback: string | undefined): string | undefined {
  if (id === undefined || id === null) {
    return fallback;
  }
  return typeof id === 'string' ? id : undefined;
}

/**
 * Shallow key-by-key `===` value-equality for two records: same key count, and every
 * key of `a` present in `b` with a `===` value. Object-valued keys are compared by
 * reference — matching the `config`-patch branch's own `nextConfig[key] !== value`
 * check — so re-supplying a value-equal but reference-different nested value (e.g. a
 * fresh `ySeries` array) still counts as a change.
 *
 * Used directly by the widget-merge handlers (`updateWidget`'s `changes.config`
 * wholesale replacement and `applyBulkUpdate`'s `updatedWidgets` config merge) to
 * honor the reference-equality no-op contract, and it is the single shared core of the
 * `undefined`-tolerant {@link spansEqual} wrapper — one implementation so the two can
 * never drift (e.g. one gaining a tolerance the other lacks).
 */
export function shallowRecordEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  if (a === b) {
    return true;
  }
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

// Drop widget/interactive/cross-filter-scoped filters anchored to any removed widget.
// Shared by `removeWidget` and `applyBulkUpdate` so both enforce the same invariant: a
// removed source widget must not leave its page permanently filtered with no clearing
// affordance. Returns the same array reference when nothing is dropped, preserving the
// reference-stable no-op behaviour callers rely on.
export function dropWidgetScopedFilters(
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
 * Enforce per-page rank-filter uniqueness across a whole filter array, keeping the FIRST
 * rank filter for each page context in array order and dropping any later one that
 * conflicts with it (then cascading those drops into the survivors' `dependsOn`).
 *
 * `addFilter` can only gate the filter it is installing, against the page context that
 * filter resolves to AT THAT MOMENT. A `widget`-scoped rank filter whose widget sits on no
 * page resolves to `resolveRankFilterPageId`'s UNRESOLVABLE sentinel and is therefore
 * accepted unconditionally — so a later PLACEMENT of that widget (a `setWidgetLayout`, or an
 * `applyBulkUpdate` carrying rows) can move it onto a page that already has a rank filter
 * and create the conflict after the fact. The layout handlers run this sweep so the
 * invariant is restored in the same commit that breaks it, instead of the doc staying live-
 * valid but load-invalid until `deserializeState`'s identical dedup silently deletes the
 * filter on the next reload.
 *
 * The sweep itself is the shared `dedupeRankFilters` in `rankFilterScope.ts`, so the
 * predicate and the array-order tie-break are byte-identical across all three enforcement
 * sites (this one, `statePersistence.ts`'s load-boundary dedup, and `factories.ts`'s override
 * screen) and cannot drift. What this wrapper adds is the `dependsOn` cascade, which only the
 * reducer and the load boundary do (`pruneDependsOn` lives here, out of that module's reach).
 * Reference-stable: returns the SAME array when nothing conflicts.
 */
export function dropConflictingRankFilters(
  filters: StudioFilterState[],
  pages: StudioDoc['pages'],
): StudioFilterState[] {
  const { filters: kept, changed } = dedupeRankFilters(filters, pages);
  return changed ? pruneDependsOnAgainstSelf(kept) : filters;
}

/**
 * Shared widget-removal primitive. Given `pages` ALREADY carrying the caller's row
 * edits (rows stripped, a page dropped, or a layout replaced), it finishes the job
 * every removal path shares: it computes which of `candidateIds` are *genuinely gone*
 * (no longer referenced on ANY surviving page's rows), then
 *   - deletes those ids from `widgets`,
 *   - drops their widget/interactive/cross-filter-scoped filters (and cascades that drop
 *     into every surviving filter's `dependsOn`), and
 *   - prunes their stale `widgetColSpans` entries from every page.
 *
 * The "genuinely gone" step (`stillReferenced`) is load-bearing for `removePage` ONLY.
 * That caller hands in `pages` with the removed page DELETED but every surviving page's
 * rows untouched, so a widget that also lives on another page must keep its `widgets`
 * entry, its widget-anchored filters, and its spans — that is the cross-page guard. The
 * other two callers (`removeWidget` and `applyBulkUpdate`) pre-strip the candidate ids from
 * ALL pages' rows before calling in, so for them `stillReferenced` can never contain a
 * candidate and the step is inert. That is deliberate on both sides: those two delete the
 * widget from `doc.widgets` outright, so leaving it on another page's rows would strand a
 * dangling row reference. The step stays here (rather than being deleted as inert for two
 * of three callers) because it IS the whole contract for `removePage` and the correct
 * default for any future caller that does not pre-strip.
 *
 * Returns the SAME `pages`/`widgets`/`filters` references when nothing was genuinely
 * removed, preserving the callers' reference-stable no-op contract.
 */
export function removeWidgetIds(
  pages: StudioDoc['pages'],
  widgets: StudioDoc['widgets'],
  filters: StudioFilterState[],
  candidateIds: Iterable<string>,
): {
  pages: StudioDoc['pages'];
  widgets: StudioDoc['widgets'];
  filters: StudioFilterState[];
  removedIds: Set<string>;
} {
  // (a) which ids still appear on some page's rows after the caller's edits.
  const stillReferenced = new Set<string>();
  for (const p of Object.values(pages)) {
    for (const row of p.widgetRows ?? []) {
      for (const id of row) {
        stillReferenced.add(id);
      }
    }
  }
  // (b) genuinely-removed = candidates no page references any longer.
  const removedIds = new Set<string>();
  for (const id of candidateIds) {
    if (!stillReferenced.has(id)) {
      removedIds.add(id);
    }
  }
  if (removedIds.size === 0) {
    return { pages, widgets, filters, removedIds };
  }
  // (c) drop the removed widgets from the flat widgets record — but only rebuild it when at
  // least one removed id is an OWN key of `widgets`. A re-delivered removal bulk (SSE
  // at-least-once) whose `removedWidgetIds` names an already-gone widget is classified
  // "genuinely removed" here (no surviving page references it), and `{ ...widgets }` + a
  // no-op `delete` would mint a fresh, content-identical record — flipping the caller's
  // `widgetsChanged` gate and pushing a spurious undo entry. Returning the ORIGINAL `widgets`
  // reference when nothing was actually deleted preserves the reference-stable no-op contract.
  let anyOwnKey = false;
  for (const id of removedIds) {
    if (Object.hasOwn(widgets, id)) {
      anyOwnKey = true;
      break;
    }
  }
  let nextWidgets = widgets;
  if (anyOwnKey) {
    nextWidgets = { ...widgets };
    for (const id of removedIds) {
      delete nextWidgets[id];
    }
  }
  // (d) drop widget/interactive/cross-filter-scoped filters anchored to a removed id, then
  // cascade that drop into every SURVIVING filter's `dependsOn` (the shared
  // `pruneDependsOn` invariant): a page filter `f-city` with `dependsOn: ['f-country']`
  // would otherwise keep pointing at `f-country` after `removeWidget('w1')` dropped that
  // widget-scoped filter, and the cascade drawer would gate option-narrowing on a filter
  // that no longer exists. Both helpers are reference-stable, so a removal that drops no
  // filter (and a doc with no `dependsOn` at all) still returns the SAME array.
  const nextFilters = pruneDependsOnAgainstSelf(
    dropWidgetScopedFilters(filters, (id) => removedIds.has(id)),
  );
  // (e) prune each removed id's stale span entry from every page (reference-stable).
  // Rebuilt via `Object.fromEntries` (not a `nextPages[pid] = …` bracket assignment) so a
  // stray unsafe page key can never invoke the inherited prototype accessor — matching the
  // load-boundary sweep in `normalizePersistedPages`.
  let pagesChanged = false;
  const nextEntries: [string, StudioDoc['pages'][string]][] = [];
  for (const [pid, p] of Object.entries(pages)) {
    const prunedSpans = removeSpanEntries(p.widgetColSpans, removedIds);
    if (prunedSpans !== p.widgetColSpans) {
      nextEntries.push([pid, withSpans(p, prunedSpans)]);
      pagesChanged = true;
    } else {
      nextEntries.push([pid, p]);
    }
  }
  return {
    pages: pagesChanged ? (Object.fromEntries(nextEntries) as StudioDoc['pages']) : pages,
    widgets: nextWidgets,
    filters: nextFilters,
    removedIds,
  };
}

/**
 * The `apply` (state transition) and `label` (human-readable log line) logic for
 * a single mutation kind, co-located so the two can never drift apart.
 *
 * Handlers operate on the persisted `StudioDoc` partition ONLY — they can read and
 * return `dashboard`/`pages`/`widgets`/`filters`/`expressionFields`/`ai`, but they
 * have no access to `session` (mode/shell) or `runtime` (dataSources). That access
 * boundary is a compile-time guarantee: if a handler tried to reach into a
 * session/runtime field it would not exist on `StudioDoc`, and TypeScript would
 * reject it. (Handler bodies name the parameter `state` for historical reasons;
 * its type is `StudioDoc`, not `StudioState`.)
 */
export type MutationHandler<M extends StateMutation> = {
  apply: (doc: StudioDoc, args: M['args']) => StudioDoc;
  label: (args: M['args']) => string;
};

/**
 * The handler table a single domain owns, keyed by exactly the mutation types it names.
 *
 * This is what keeps the split from weakening the guarantee the one-table version gave. Each
 * domain annotates its table with `HandlersFor<'a' | 'b' | …>`, so the compiler rejects a domain
 * that implements a type it did not claim or omits one it did; and `applyMutation.ts` annotates
 * the MERGED table with the full `{ [M in StateMutation as M['type']]: … }` mapped type, so the
 * domains together must still cover every mutation. A new `StateMutation` variant fails to
 * compile until some domain adopts it — the same error the single table produced, now naming
 * which file has to change.
 */
export type HandlersFor<T extends StateMutation['type']> = {
  [M in Extract<StateMutation, { type: T }> as M['type']]: MutationHandler<M>;
};
