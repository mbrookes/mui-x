/**
 * The single mutation reducer, and the table it dispatches through.
 *
 * The handlers themselves live in `mutationHandlers/`, one module per domain. They were one
 * 3,355-line table here until the client's 25 bypass writers were migrated onto the reducer,
 * which was the right destination and left this file the largest in the package. The split is by
 * domain because the domains turned out to be almost fully separable: of twenty-four private
 * helpers, seventeen belonged to widgets alone and only four crossed a domain boundary.
 *
 * What did NOT change is the guarantee. `MUTATION_HANDLERS` is still annotated with the mapped
 * type over the whole `StateMutation` union, so the domain tables together must cover every
 * variant; and each domain's own `HandlersFor<…>` annotation pins which variants it owns. A new
 * mutation still fails to compile until it is implemented — the error now names the file.
 */
import type { StudioDoc, StudioState } from './stateTypes';
import type { StateMutation } from './aiTypes';
import { DASHBOARD_MUTATION_HANDLERS } from './mutationHandlers/dashboard';
import { PAGE_MUTATION_HANDLERS } from './mutationHandlers/page';
import { WIDGET_MUTATION_HANDLERS } from './mutationHandlers/widget';
import { FILTER_MUTATION_HANDLERS } from './mutationHandlers/filter';
import { PRESET_MUTATION_HANDLERS } from './mutationHandlers/preset';
import { MODEL_MUTATION_HANDLERS } from './mutationHandlers/model';
import { AI_MUTATION_HANDLERS } from './mutationHandlers/ai';
import { isPlainRecord } from './internalGuards';
import { hasUnsafeOwnKeys } from './parseStateMutation';
import type { MutationHandler } from './mutationHandlers/shared';
import { isSafePatchKey } from './mutationHandlers/shared';
import {
  clampSpan,
  dedupeLayoutRows,
  enforceLayoutColSpans,
  rowsEqual,
  spansEqual,
  withSpans,
} from './mutationHandlers/layout';

// Re-exported from `mutationHandlers/layout.ts`, which owns the grid arithmetic. Kept on this
// module's surface because every existing consumer imports them from here.
export { GRID_COLS, MIN_SPAN } from './mutationHandlers/layout';

/**
 * Every mutation handler, assembled from the per-domain tables.
 *
 * The annotation is the exhaustiveness check: it demands a key for every `StateMutation` type,
 * so a variant no domain claimed is a compile error here, and a domain that claimed one it did
 * not implement is a compile error in its own file.
 */
const MUTATION_HANDLERS: { [M in StateMutation as M['type']]: MutationHandler<M> } = {
  ...DASHBOARD_MUTATION_HANDLERS,
  ...PAGE_MUTATION_HANDLERS,
  ...WIDGET_MUTATION_HANDLERS,
  ...FILTER_MUTATION_HANDLERS,
  ...PRESET_MUTATION_HANDLERS,
  ...MODEL_MUTATION_HANDLERS,
  ...AI_MUTATION_HANDLERS,
};

/**
 * Load-time layout normalization sweep for a persisted `pages` map. Every LIVE mutation
 * path maintains the layout invariants (rows reference real widgets, no duplicate ids,
 * spans are in range and orphan-free), but a corrupted or hand-edited persisted doc can
 * violate them — phantom `widgetRows` ids with no `widgets` entry, duplicate ids, or
 * out-of-range/orphan `widgetColSpans` — which renders blank cards and wrong widths until
 * some later layout mutation happens to prune them. A cheap DEFENSIVE sweep at the load
 * boundary, NOT a schema migration: the doc SHAPE is unchanged, so no version bump.
 *
 * Per page it filters rows against `widgets`, dedupes duplicate ids (first occurrence
 * wins), clamps each span into the valid `MIN_SPAN`–`GRID_COLS` range, and drops spans
 * for unsafe keys or widgets no longer present in the sanitized rows. Reference-stable:
 * returns the SAME `pages` object (and the SAME page objects within it) when nothing
 * needed fixing, so a well-formed persisted doc loads without churn.
 *
 * It is also TOTAL over a corrupted/hand-edited persisted doc rather than throwing on the
 * first non-conforming shape it meets: a prototype-hazard page KEY (`"__proto__"` etc.)
 * or a non-record page value is dropped, a non-array `widgetRows` is coerced to `[]`, and
 * non-array rows / non-string ids inside it are filtered out. The rebuild is done via
 * `Object.fromEntries` (not a `nextPages[pid] = …` bracket assignment) so a stray unsafe
 * key can never invoke the inherited prototype accessor and re-prototype the pages map.
 */
export function normalizePersistedPages(
  pages: StudioDoc['pages'],
  widgets: StudioDoc['widgets'],
): StudioDoc['pages'] {
  let pagesChanged = false;
  const nextEntries: [string, StudioDoc['pages'][string]][] = [];
  for (const [pid, page] of Object.entries(pages)) {
    // Drop prototype-hazard page keys and non-record page values. A shared/hand-edited
    // persisted doc is an untrusted boundary: `JSON.parse` can produce an own
    // `"__proto__"` page key or a `null`/primitive page value, either of which would
    // corrupt the rebuild or crash the sweep below.
    //
    // `isPlainRecord`, not a hand-rolled `typeof === 'object' && !null && !isArray`: this
    // was the LAST page/widget screen still spelling the check out by hand, and the two
    // differ exactly on the EXOTIC-object case (a `Date`/`Map`/class instance is a non-null
    // non-array `object`). The factory's own `pages` screen (`screenPagesShape`) and the
    // widget channel (`screenWidgets`) both route through `isPlainRecord` already, so an
    // exotic page value was DROPPED by the factory and KEPT — verbatim, same reference,
    // still a class instance — by this loader. That is the boundary-disagreement class:
    // downstream every page is treated as a plain data bag (spread by `withSpans`, read by
    // arbitrary key, re-serialized), and an exotic one embedded straight into `doc.pages`
    // silently differs in shape from every other page. It also could not be repaired here:
    // the rebuild below is skipped precisely when the instance's `id`/`title`/`widgetRows`
    // already look valid. Delegating makes the four boundaries answer identically and lets
    // the next tightening of `isPlainRecord` land here too.
    if (!isSafePatchKey(pid) || !isPlainRecord(page)) {
      pagesChanged = true;
      continue;
    }
    // Screen the page object's OWN top-level keys against the prototype-hazard denylist,
    // symmetric with the page-KEY screen just above and with the load boundary's widget
    // own-key screen. The rebuild below spreads `{ ...page, id: pid, … }` with DEFINE
    // semantics, so an own `"__proto__"`/`"constructor"`/`"prototype"` DATA property (as
    // `JSON.parse` materializes it on a shared/hand-edited doc) would copy straight through
    // onto the rebuilt page and later poison a spread/`Object.assign` of it. Drop the whole
    // page, matching the unsafe-page-KEY drop above. Reuses the SAME `hasUnsafeOwnKeys`
    // predicate the wire and load boundaries use.
    if (hasUnsafeOwnKeys(page)) {
      pagesChanged = true;
      continue;
    }
    // `widgetRows` may be junk (`"junk"`, `null`, an array with non-array rows). Coerce
    // defensively so the sweep is total: non-array → `[]`, non-array rows filtered, and
    // each id kept only when it is a string naming a real widget. A non-array
    // `widgetRows` (or `widgetColSpans`) always forces a rebuild so the junk is dropped
    // rather than carried through by the value-equality no-op check below.
    const rowsWereArray = Array.isArray(page.widgetRows);
    const currentRows = rowsWereArray ? page.widgetRows : [];
    const sanitizedRows = dedupeLayoutRows(
      currentRows
        .filter((row): row is string[] => Array.isArray(row))
        .map((row) => row.filter((id) => typeof id === 'string' && Object.hasOwn(widgets, id))),
    );
    const present = new Set<string>();
    for (const row of sanitizedRows) {
      for (const id of row) {
        present.add(id);
      }
    }
    const spansWereRecord = page.widgetColSpans === undefined || isPlainRecord(page.widgetColSpans);
    let nextSpans: Record<string, number> | undefined = spansWereRecord
      ? page.widgetColSpans
      : undefined;
    if (page.widgetColSpans && spansWereRecord) {
      const rebuilt: Record<string, number> = {};
      for (const key of Object.keys(page.widgetColSpans)) {
        // Drop prototype-polluting keys — load-bearing, since `rebuilt[key] = …` is a bare
        // bracket assignment on an untrusted persisted key — and clamp survivors into range
        // (guards a hand-corrupted `3` or `40`).
        //
        // The `present.has(key)` half is REDUNDANT: `enforceLayoutColSpans` on the next line
        // drops every span whose id is absent from the rows, so an orphan filtered here would
        // have been dropped there anyway. It is kept so this loop never allocates an entry it
        // is about to discard, and so the invariant reads at the site that builds the record.
        if (isSafePatchKey(key) && present.has(key)) {
          rebuilt[key] = clampSpan(page.widgetColSpans[key]);
        }
      }
      // Enforce the row-overflow col-span invariant on load. The clamp loop above bounds
      // each span INDIVIDUALLY but never checks a shared row's span SUM, so a hand-edited
      // doc whose row's colSpans sum past `GRID_COLS` (`{ w1: 20, w2: 20 }` on one row) —
      // or one the clamp itself pushes past it (`{ w1: 40, w2: 6 }` → `{ w1: 24, w2: 6 }`,
      // sum 30 > 24) — would install verbatim and render an overflowing row until some
      // later LIVE layout mutation pruned it. Runs the same `enforceLayoutColSpans([], …)`
      // pass every other layout-installing site uses: `oldRows = []` so a pre-existing
      // intentional singleton span is never collapsed, while row-overflow drop, orphan
      // drop, and empty→`undefined` collapse all apply. The `spansEqual` comparison below
      // preserves reference stability.
      nextSpans = enforceLayoutColSpans([], sanitizedRows, rebuilt);
    }
    // Reconcile the page's own `id` field with its record KEY, the page analogue of the
    // widget id↔key reconciliation in `deserializeState`. Every reducer path that targets a
    // page keys off the record KEY (`state.pages[pageId]`), so a hand-edited/shared doc
    // carrying the desync (`pages: { "p-a": { "id": "p-b", … } }`) renders from the key
    // while any affordance carrying `page.id` silently misses. The key is the source of
    // truth: re-stamp `id: pid` (preserving the page rather than dropping it) and force a
    // rebuild so the corrected id lands.
    const idDesynced = page.id !== pid;
    // Coerce a missing/non-string `title` to the same `'Untitled Page'` fallback the factory
    // uses. `migrateState`'s validation only checks `widgetRows`, so junk `page.title`
    // (`null`, `42`, an object) reaches here; every consumer renders it directly as text
    // with no fallback of its own (e.g. `StudioWidgetCardActionsOverlay`), crashing React on
    // first render of the page picker. `addPage`/`renamePage` require a string `title` at
    // the wire/reducer boundary, so a directly-loaded persisted doc is the one way in.
    const titleIsString = typeof page.title === 'string';
    const safeTitle = titleIsString ? page.title : 'Untitled Page';
    if (
      idDesynced ||
      !titleIsString ||
      !rowsWereArray ||
      !spansWereRecord ||
      !rowsEqual(currentRows, sanitizedRows) ||
      !spansEqual(nextSpans, page.widgetColSpans)
    ) {
      nextEntries.push([
        pid,
        withSpans(page, nextSpans, {
          id: pid,
          title: safeTitle,
          widgetRows: sanitizedRows,
        }),
      ]);
      pagesChanged = true;
    } else {
      nextEntries.push([pid, page]);
    }
  }
  return pagesChanged ? (Object.fromEntries(nextEntries) as StudioDoc['pages']) : pages;
}

/**
 * The mutation-type discriminants the reducer knows how to apply, derived at
 * runtime from the `MUTATION_HANDLERS` table's own keys. Exported so a runtime
 * table-sync test can pin that `parseStateMutation`'s validator table covers
 * exactly these variants — the mapped types on both tables already guarantee
 * this at compile time, but this turns it into an observable assertion a
 * reviewer can read, not just a type a reviewer must trust.
 */
export const MUTATION_TYPES = Object.keys(MUTATION_HANDLERS) as StateMutation['type'][];

/**
 * The canonical reducer: applies a `StateMutation` to a `StudioDoc`, returning the
 * next doc. This is the single semantic authority for every mutation's effect on
 * the persisted document.
 *
 * Reference-equality no-op contract: when a mutation changes nothing (an unknown
 * id, an already-applied idempotent event, …) the SAME `doc` reference is returned,
 * not a fresh object — callers rely on `next === doc` to detect a no-op.
 */
export function applyDocMutation(doc: StudioDoc, mutation: StateMutation): StudioDoc {
  // Crash prevention: `Object.hasOwn(…, mutation.type)` below throws on a non-record
  // `mutation` (`null`, `undefined`, a primitive).
  if (!isPlainRecord(mutation)) {
    return doc;
  }
  // A single cast at the dispatch boundary: TS cannot prove that
  // `MUTATION_HANDLERS[mutation.type]` and `mutation.args` share the same `M` (the
  // correlation is lost once `mutation.type` is read), so the handler is asserted as the
  // general shape. The mapped type above guarantees a handler exists for every variant known
  // at compile time, but a value arriving over the wire (SSE payload, legacy or
  // forward-incompatible client) is not guaranteed to match, hence the runtime lookup guard.
  //
  // `Object.hasOwn` before the bracket read, matching the lookup discipline every other
  // table in this package uses. A `mutation.type` naming an `Object.prototype` member
  // (`'constructor'`/`'toString'`/`'__proto__'`) otherwise resolves UP the prototype chain
  // instead of to `undefined`, defeating the `handler ? … : doc` guard: `type: 'constructor'`
  // would call `Object.apply(doc, args)` and replace the whole doc with a bogus `{}`, and
  // `'__proto__'`/`'valueOf'` would throw mid-apply.
  const handler = Object.hasOwn(MUTATION_HANDLERS, mutation.type)
    ? (MUTATION_HANDLERS[mutation.type] as MutationHandler<StateMutation>)
    : undefined;
  if (!handler) {
    return doc;
  }
  // Crash prevention, once here rather than in each handler: every handler's first field
  // read (`args.rows`, `args.widget`, `args.filter`, …) throws on a non-record `args`.
  if (!isPlainRecord(mutation.args)) {
    return doc;
  }
  return handler.apply(doc, mutation.args);
}

/**
 * Full-state wrapper over {@link applyDocMutation}: applies the mutation to
 * `state.doc` and rewraps, leaving `session` and `runtime` untouched (by
 * construction — the reducer never sees them). Preserves the whole-state
 * reference-equality no-op contract: returns the SAME `state` reference when the
 * doc did not change, so `StudioController`'s no-op detection and the AI middleware's
 * `executeToolOnState` continue to short-circuit unchanged commits.
 */
export function applyMutation(state: StudioState, mutation: StateMutation): StudioState {
  const nextDoc = applyDocMutation(state.doc, mutation);
  return nextDoc === state.doc ? state : { ...state, doc: nextDoc };
}

/**
 * Compact, human-readable label for a mutation, used for the AI recent-mutation log
 * (client-side undo/redo history label + MCP `get_recent_changes`).
 *
 * Never throws, and always returns a `string`: callers use the result as a log line, a React
 * child, or a `.slice()` target. Every guard below serves that contract.
 */
export function mutationLabel(mutation: StateMutation): string {
  // A non-record `mutation` (`null`/primitive) would throw on the `Object.hasOwn` below.
  // There is no readable `type` to echo, so fall back to a static `'unknown'`.
  if (!isPlainRecord(mutation)) {
    return 'unknown';
  }
  // `Object.hasOwn` before the bracket read, same reasoning as `applyDocMutation`: a `type`
  // naming an `Object.prototype` member would resolve to a prototype function and throw
  // `handler.label is not a function` instead of returning the raw type string.
  const handler = Object.hasOwn(MUTATION_HANDLERS, mutation.type)
    ? (MUTATION_HANDLERS[mutation.type] as MutationHandler<StateMutation>)
    : undefined;
  // An unrecognized `type` echoes the type string; so does a non-record `args`, which would
  // throw in the label builders that reach into it (`addWidget:${args.widget.kind}`,
  // `addFilter:${args.filter.field}`).
  //
  // `String(...)` because `mutation.type` is only known to be a string for a RECOGNIZED type,
  // and this is exactly the branch where it is not one — a `type: 42` (or `null`, or an
  // object) would otherwise be returned raw, violating the `: string` contract.
  if (!handler || !isPlainRecord(mutation.args)) {
    return String((mutation as { type: unknown }).type);
  }
  return handler.label(mutation.args);
}
