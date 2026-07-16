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
import type { StudioState, StudioDoc, StudioFilterState } from './stateTypes';
import type { StudioChartSeries, StudioWidget } from './widgetTypes';
import type { StateMutation } from './aiTypes';
import { normalizeChartSeries } from './factories';
import { isSafeKey } from './unsafeKeys';
import { hasUnsafeOwnKeys } from './parseStateMutation';

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

/**
 * Local name for the shared {@link isSafeKey} guard (`unsafeKeys.ts`): rejects the
 * prototype-polluting `__proto__`/`constructor`/`prototype` keys. Guarded wherever the
 * reducer rebuilds a record key-by-key from untrusted input (`updateWidget`'s
 * `config`/`changes` loops, `applyBulkUpdate`'s span rebuild and widget inserts). The
 * wire boundary (`parseStateMutation`) rejects these too — this is the defense-in-depth
 * copy for mutations the server constructs WITHOUT the parser (`executeToolOnState`
 * builds them straight from LLM tool arguments).
 */
const isSafePatchKey = isSafeKey;

/**
 * Value-equality for two `widgetRows` matrices. Used by the layout handlers to honor
 * the reducer's reference-equality no-op contract: rebuilding a page with rows that
 * are element-for-element identical to the current ones must return the SAME doc so
 * `commitDocPatch`'s no-op guard skips a spurious undo entry.
 */
function rowsEqual(a: string[][], b: string[][]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const rowA = a[i];
    const rowB = b[i];
    if (rowA.length !== rowB.length) {
      return false;
    }
    for (let j = 0; j < rowA.length; j += 1) {
      if (rowA[j] !== rowB[j]) {
        return false;
      }
    }
  }
  return true;
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
function shallowRecordEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
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

/**
 * Value-equality for two `widgetColSpans` records (either may be `undefined`).
 * `enforceLayoutColSpans` and the `setWidgetColSpan` rebuild both mint a fresh object
 * even when the contents are unchanged, so the layout handlers compare by value (not
 * reference) to detect a no-op and preserve the same-doc contract. The
 * `undefined`-tolerant wrapper over the shared {@link shallowRecordEqual} core.
 */
function spansEqual(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return shallowRecordEqual(a, b);
}

/**
 * Drop duplicate widget ids from a layout matrix — first occurrence wins, across the
 * WHOLE matrix (a duplicate within a single row OR spread across rows). A widget id
 * appearing twice renders the same widget twice (a duplicate React key in
 * `StudioCanvas`) and double-counts its span in `enforceLayoutColSpans`'s overflow sum
 * (e.g. `[['w1','w1']]` with `w1: 13` sums to 26 > 24 and would delete a valid span).
 * Rows left empty after de-duplication are dropped. Callers pair this with the
 * phantom-id filter in their existing sanitization pass, so the layout handlers reject
 * both unknown ids and duplicates in one place.
 */
function dedupeLayoutRows(rows: string[][]): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const row of rows) {
    const deduped: string[] = [];
    for (const id of row) {
      if (!seen.has(id)) {
        seen.add(id);
        deduped.push(id);
      }
    }
    if (deduped.length > 0) {
      result.push(deduped);
    }
  }
  return result;
}

/**
 * Normalizes the deprecated `seriesType` alias to the canonical `type` on a config's
 * `ySeries`, so the alias never survives a LIVE write (`updateWidget`/`addWidget`) —
 * `deserializeState` normalizes only at the load boundary, so without this a widget
 * written with `seriesType` would keep the alias until the next reload. Reference-
 * stable: returns the SAME config when there is no `ySeries` or every entry is
 * already canonical, so the reducer's no-op detection is preserved. Runs across kinds
 * by design (only chart configs carry `ySeries`), reading the flat config shape.
 */
function normalizeConfigChartSeries<C extends object>(config: C): C {
  // Tolerate a non-record `config` (e.g. `null` from a server-built `addWidget`/
  // `applyBulkUpdate.addedWidgets` that bypassed `parseStateMutation`): reading
  // `.ySeries` off `null` would throw `Cannot read properties of null`. A non-record
  // carries no `ySeries` to normalize, so return it unchanged — defense-in-depth
  // matching the file's other "server bypasses the parser" guards.
  if (config === null || typeof config !== 'object') {
    return config;
  }
  const ySeries = (config as { ySeries?: unknown }).ySeries;
  if (!Array.isArray(ySeries)) {
    return config;
  }
  let changed = false;
  const nextSeries = (ySeries as StudioChartSeries[]).map((series) => {
    const normalized = normalizeChartSeries(series);
    if (normalized !== series) {
      changed = true;
    }
    return normalized;
  });
  return changed ? ({ ...config, ySeries: nextSeries } as C) : config;
}

/**
 * A plain object (not `null`, not an array, not a primitive). The single shared
 * "is this a usable widget `config`" predicate for this reducer, mirroring the
 * sibling `isRecord` in `parseStateMutation.ts` and the load-boundary coercion in
 * `statePersistence.ts` — every config-accepting channel in this file uses this
 * exact shape rather than an ad-hoc `typeof`/truthiness check (T2-2): a non-record
 * `config` (`null`, an array, or a truthy primitive like a string) is treated as
 * ABSENT, never as a record to merge or install.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strip the prototype-polluting own keys (`__proto__`/`constructor`/`prototype`) from a
 * config record that is about to be installed WHOLESALE onto a widget (T2-3). The
 * `config`-PATCH loop in `updateWidget` already screens each key via `isSafePatchKey`
 * before a bare bracket-assign, but the two spread/merge channels —
 * `updateWidget`'s `changes.config` wholesale replace and `applyBulkUpdate`'s
 * `updatedWidgets[].config` shallow-merge — install a spread result directly. Object
 * spread uses DEFINE semantics (so it never pollutes a live prototype), but it RETAINS
 * an unsafe key as an own DATA property; on the NEXT load `deserializeState`'s
 * `hasUnsafeOwnKeys(cfg)` screen would then drop the ENTIRE widget → silent data loss.
 * This is reachable via the AI bulk tool for CUSTOM widget kinds (whose per-kind config
 * validation imposes no key restriction). Routing both channels through this step keeps
 * all THREE config channels honoring the same defense-in-depth key screen. Reference-
 * stable: returns the SAME object when it carries no unsafe own key.
 */
function stripUnsafeConfigKeys(config: Record<string, unknown>): Record<string, unknown> {
  if (!hasUnsafeOwnKeys(config)) {
    return config;
  }
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSafePatchKey(key)) {
      safe[key] = value;
    }
  }
  return safe;
}

// Coerce a widget whose `config` is not a record (e.g. `config: null` from a
// server-built `addWidget`/`applyBulkUpdate.addedWidgets` that bypassed
// `parseStateMutation`) into one carrying `config: {}`, mirroring the load-boundary
// coercion (`deserializeState`, finding 2.4). `normalizeConfigChartSeries` already
// tolerates a non-record config so the IMMEDIATE add doesn't throw, but storing the
// widget with `config: null` verbatim leaves a landmine: the NEXT config-touching
// mutation does `Object.keys(existing.config)` / `shallowRecordEqual(existing.config, …)`
// and throws `Cannot convert undefined or null to object`. Neutralizing it at the add
// site (not just the immediate normalize call) closes that deferred throw (T2-2).
// Reference-stable when the config is already a record.
function coerceWidgetConfig(widget: StudioWidget): StudioWidget {
  const { config } = widget;
  if (isPlainRecord(config)) {
    return widget;
  }
  return { ...widget, config: {} } as StudioWidget;
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
 * the layout it replaced. This reducer is the SOLE implementation of the col-span
 * invariants: every layout path — user drag/drop, keyboard reorder, and AI-driven
 * `setWidgetLayout`/`applyBulkUpdate` — reaches them through here. Three invariants:
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
 * Load-time layout normalization sweep for a persisted `pages` map. Every LIVE mutation
 * path maintains the layout invariants (rows reference real widgets, no duplicate ids,
 * spans are in range and orphan-free), but a corrupted or hand-edited persisted doc can
 * violate them: `deserializeState` previously installed `pages` verbatim, so phantom
 * `widgetRows` ids (no `widgets` entry), duplicate ids, or out-of-range/orphan
 * `widgetColSpans` loaded as-is and rendered blank cards / wrong widths until the next
 * layout mutation happened to prune them. This is a cheap DEFENSIVE sweep applied at the
 * load boundary — NOT a schema migration: the doc SHAPE is unchanged, so no version bump.
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
    if (!isSafePatchKey(pid) || page === null || typeof page !== 'object' || Array.isArray(page)) {
      pagesChanged = true;
      continue;
    }
    // Screen the page object's OWN top-level keys against the prototype-hazard denylist
    // (Finding T2-1), symmetric with the page-KEY screen just above and with the load
    // boundary's widget own-key screen. The rebuild below spreads `{ ...page, id: pid, … }`
    // with DEFINE semantics, so an own `"__proto__"`/`"constructor"`/`"prototype"` DATA
    // property (as `JSON.parse` materializes it on a shared/hand-edited doc) is copied
    // straight through onto the rebuilt page and later poisons a spread/`Object.assign` of
    // it. Drop the whole page (matching the unsafe-page-KEY drop above). Reuses the SAME
    // `hasUnsafeOwnKeys` predicate the wire and load boundaries use.
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
    const spansWereRecord =
      page.widgetColSpans === undefined ||
      (typeof page.widgetColSpans === 'object' &&
        page.widgetColSpans !== null &&
        !Array.isArray(page.widgetColSpans));
    let nextSpans: Record<string, number> | undefined = spansWereRecord
      ? page.widgetColSpans
      : undefined;
    if (page.widgetColSpans && spansWereRecord) {
      const rebuilt: Record<string, number> = {};
      for (const key of Object.keys(page.widgetColSpans)) {
        // Drop prototype-polluting keys and spans orphaned by the row filter/dedupe
        // above; clamp survivors into range (guards a hand-corrupted `3` or `40`).
        if (isSafePatchKey(key) && present.has(key)) {
          rebuilt[key] = clampSpan(page.widgetColSpans[key]);
        }
      }
      // Enforce the row-overflow col-span invariant on load (T2-1): the clamp loop bounds
      // each span INDIVIDUALLY but never checks a shared row's span SUM, so a hand-edited
      // doc whose row's colSpans sum past `GRID_COLS` (`{ w1: 20, w2: 20 }` on one row) —
      // or a doc the clamp itself pushes past it (`{ w1: 40, w2: 6 }` → `{ w1: 24, w2: 6 }`,
      // sum 30 > 24) — would otherwise install verbatim and render an overflowing row until
      // the next LIVE layout mutation happened to prune it. Run the same
      // `enforceLayoutColSpans([], …)` pass every other layout-installing site uses (the
      // SOLE implementation of these invariants): `oldRows = []` so a pre-existing
      // intentional singleton span is never collapsed, while row-overflow drop, orphan
      // drop, and empty→`undefined` collapse all apply. Reference stability is preserved by
      // the `spansEqual` comparison below (and `enforceLayoutColSpans` collapses an empty
      // result to `undefined`, matching the prior explicit fallback).
      nextSpans = enforceLayoutColSpans([], sanitizedRows, rebuilt);
    }
    // Reconcile the page's own `id` field with its record KEY (finding 2.1), the page
    // analogue of the widget id↔key reconciliation in `deserializeState`. Every reducer
    // path that targets a page keys off the record KEY (`state.pages[pageId]`), so a
    // hand-edited/shared doc where the desync ALREADY exists (`pages: { "p-a": { "id":
    // "p-b", … } }`) would render from the key while any affordance carrying `page.id`
    // silently missed. The key is the source of truth; re-stamp `id: pid` (preserving the
    // page rather than dropping it) and force a rebuild so the corrected id lands.
    const idDesynced = page.id !== pid;
    if (
      idDesynced ||
      !rowsWereArray ||
      !spansWereRecord ||
      !rowsEqual(currentRows, sanitizedRows) ||
      !spansEqual(nextSpans, page.widgetColSpans)
    ) {
      nextEntries.push([
        pid,
        { ...page, id: pid, widgetRows: sanitizedRows, widgetColSpans: nextSpans },
      ]);
      pagesChanged = true;
    } else {
      nextEntries.push([pid, page]);
    }
  }
  return pagesChanged ? (Object.fromEntries(nextEntries) as StudioDoc['pages']) : pages;
}

/**
 * Shared widget-removal primitive. Given `pages` ALREADY carrying the caller's row
 * edits (rows stripped, a page dropped, or a layout replaced), it finishes the job
 * every removal path shares: it computes which of `candidateIds` are *genuinely gone*
 * (no longer referenced on ANY surviving page's rows), then
 *   - deletes those ids from `widgets`,
 *   - drops their widget/interactive/cross-filter-scoped filters, and
 *   - prunes their stale `widgetColSpans` entries from every page.
 * A candidate still referenced on some other page is preserved (its widget entry,
 * filters, and spans all survive) — this is the cross-page guard `removeWidget`,
 * `removePage`, and `applyBulkUpdate` all need. Returns the SAME `pages`/`widgets`/
 * `filters` references when nothing was genuinely removed, preserving the callers'
 * reference-stable no-op contract.
 */
function removeWidgetIds(
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
  // (c) drop the removed widgets from the flat widgets record.
  const nextWidgets = { ...widgets };
  for (const id of removedIds) {
    delete nextWidgets[id];
  }
  // (d) drop widget/interactive/cross-filter-scoped filters anchored to a removed id.
  const nextFilters = dropWidgetScopedFilters(filters, (id) => removedIds.has(id));
  // (e) prune each removed id's stale span entry from every page (reference-stable).
  // Rebuilt via `Object.fromEntries` (not a `nextPages[pid] = …` bracket assignment) so a
  // stray unsafe page key can never invoke the inherited prototype accessor — matching the
  // load-boundary sweep in `normalizePersistedPages`.
  let pagesChanged = false;
  const nextEntries: [string, StudioDoc['pages'][string]][] = [];
  for (const [pid, p] of Object.entries(pages)) {
    const prunedSpans = removeSpanEntries(p.widgetColSpans, removedIds);
    if (prunedSpans !== p.widgetColSpans) {
      nextEntries.push([pid, { ...p, widgetColSpans: prunedSpans }]);
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
type MutationHandler<M extends StateMutation> = {
  apply: (doc: StudioDoc, args: M['args']) => StudioDoc;
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
      // Screen the id against the shared prototype-hazard denylist before the literal
      // insert below (matching `applyBulkUpdate.addedWidgets` and the load boundary). The
      // literal `{ ...pages, [id]: … }` uses define-semantics, so there is no prototype
      // pollution — but an `id` of `'__proto__'` would create a real own entry that
      // silently VANISHES on the next load (the load-boundary key screen drops it):
      // transient data loss. Reject it up front, uniform with the sibling handler.
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

  setDashboardTitle: {
    apply: (state, args) => {
      // Reference-equality no-op: re-writing the identical title returns the SAME doc
      // so `commitDocPatch`'s no-op guard skips a spurious undo entry.
      if (state.dashboard.title === args.title) {
        return state;
      }
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
      // Screen the widget id against the shared prototype-hazard denylist before the
      // literal inserts below (matching `applyBulkUpdate.addedWidgets` and the load
      // boundary). No prototype pollution risk (literal define-semantics), but a
      // `'__proto__'` id would create a real own entry that silently vanishes on the next
      // load (the load-boundary key screen drops it) — transient data loss. Reject it up
      // front, uniform with the sibling handler.
      if (!isSafePatchKey(widget.id)) {
        return state;
      }
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
      // Idempotent: existence anywhere in `state.widgets` means this addWidget event
      // was already applied, so a re-delivery (e.g. an SSE at-least-once retry, or an
      // AI retry loop re-issuing the same `add_widget`) must be a no-op — regardless
      // of where the widget now lives. Keying only off the flat `widgets` record (not
      // the target page's rows) is deliberate: if the user has since moved the widget
      // to another page or edited it, re-appending a `[widget.id]` row here would
      // render it twice and overwriting would revert their edit. `Object.hasOwn` (not
      // truthy access) so an untrusted `widget.id` can't match a prototype member.
      if (Object.hasOwn(state.widgets, widget.id)) {
        return state;
      }
      // Coerce a non-record `config` to `{}` BEFORE installing (T2-2), so a widget with a
      // hand-built `config: null` never lands in `state.widgets` verbatim to detonate on
      // the next config-touching mutation. Mirrors `deserializeState`'s load-boundary
      // coercion (finding 2.4).
      const safeWidget = coerceWidgetConfig(widget);
      // Normalize the deprecated `seriesType` alias to canonical `type` on write, so
      // the alias never survives a live add (it is otherwise only normalized at the
      // load boundary in `deserializeState`). Reference-stable when already canonical.
      const normalizedConfig = normalizeConfigChartSeries(safeWidget.config);
      const normalizedWidget =
        normalizedConfig === safeWidget.config
          ? safeWidget
          : ({ ...safeWidget, config: normalizedConfig } as StudioWidget);
      return {
        ...state,
        widgets: { ...state.widgets, [normalizedWidget.id]: normalizedWidget },
        pages: {
          ...state.pages,
          [pageId]: {
            ...page,
            widgetRows: [...(page.widgetRows ?? []), [normalizedWidget.id]],
          },
        },
      };
    },
    label: (args) => `addWidget:${args.widget.kind}:${args.widget.id}`,
  },

  updateWidget: {
    apply: (state, args) => {
      const { widgetId, changes, config, unsetFields, unsetConfigKeys } = args;
      // `Object.hasOwn` (not truthy `state.widgets[widgetId]`) so an untrusted
      // `widgetId` like `'constructor'` is a clean "unknown id" no-op rather than
      // resolving to the `Object` prototype member and corrupting a write.
      if (!Object.hasOwn(state.widgets, widgetId)) {
        return state;
      }
      const existing = state.widgets[widgetId];
      let updated: StudioWidget = existing;
      // Order of operations (documented, load-bearing): config patch → changes
      // merge → config-key unsets → field unsets. Unsets are applied LAST so an
      // explicit clear always wins over a set of the same key in the same mutation.
      //
      // `config` is a partial config patch (mirrors `updateWidgetConfig`):
      // keys with an `undefined` value are removed.
      //
      // Require a record: a non-record `config` (`null`, an array, or a primitive —
      // e.g. from a server-built mutation that bypassed `parseStateMutation`) is
      // treated as ABSENT rather than applied — `Object.entries(null)` would
      // otherwise throw, and `Object.entries([...])` would merge index keys ("0",
      // "1", …) into the widget's live config (T2-2). This mirrors the sibling
      // `changes.config` guard below (T3.3/T2-2), finishing the defense-in-depth pair.
      if (isPlainRecord(config)) {
        // Normalize the deprecated `seriesType` alias on the incoming patch's
        // `ySeries` to canonical `type`, so the alias never survives a live write
        // (it is otherwise only normalized at the load boundary in
        // `deserializeState`). Scoped to the patch — a pre-existing alias the patch
        // doesn't touch is left as-is so a no-op patch stays a no-op.
        const patch = normalizeConfigChartSeries(config);
        const nextConfig = { ...existing.config } as Record<string, unknown>;
        // Track whether any key actually changed (a deletion of a PRESENT key, or a
        // value that differs from the existing one). A patch that changes nothing
        // (`{}`, or every key re-set to its current value) must NOT re-wrap the
        // widget — otherwise `commitDocPatch`'s reference-equality no-op guard on the
        // client would push a spurious undo entry. Mirrors the `changedConfig` flag
        // the `unsetConfigKeys` branch below uses.
        let changedConfig = false;
        for (const [key, value] of Object.entries(patch)) {
          // Skip prototype-polluting keys: `nextConfig['__proto__'] = value` would
          // rewrite the record's prototype rather than add an own key. `nextConfig`
          // is retained as the widget's config, so this is the live pollution vector
          // for a server-built mutation that bypassed `parseStateMutation`.
          if (!isSafePatchKey(key)) {
            continue;
          }
          if (value === undefined) {
            if (Object.hasOwn(nextConfig, key)) {
              delete nextConfig[key];
              changedConfig = true;
            }
          } else if (!Object.hasOwn(nextConfig, key) || nextConfig[key] !== value) {
            nextConfig[key] = value;
            changedConfig = true;
          }
        }
        if (changedConfig) {
          updated = { ...updated, config: nextConfig as StudioWidget['config'] };
        }
      }
      // `changes` is a shallow merge onto the widget (may itself carry a full
      // `config` object, which replaces the partial-merge result above — this
      // matches the historical client dispatch order). Keys whose value is
      // `undefined` are skipped so an in-process caller cannot void a required
      // field (e.g. `changes: { title: undefined }`) via the shallow merge — the
      // sanctioned way to void a field is `unsetFields`/`unsetConfigKeys` below,
      // which survive JSON (an `undefined` value never does).
      if (changes) {
        const definedChanges: Record<string, unknown> = {};
        const updatedRecord = updated as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(changes)) {
          // Skip unsafe keys (defense-in-depth; the spread below copies own props
          // only, so this is a latent rather than live vector) and `undefined` values.
          // Also skip `id`: it is the `state.widgets` map key, so a `changes.id` would
          // desync `widget.id` from its key (splitting every id-keyed invariant). The
          // wire boundary (`parseStateMutation`) rejects a `changes.id` too — this is
          // the defense-in-depth copy for a server-built mutation bypassing the parser,
          // mirroring the `unsetFields` `id` denylist.
          if (key === 'id' || !isSafePatchKey(key) || value === undefined) {
            continue;
          }
          if (key === 'config') {
            // `changes.config` is a wholesale replacement of the widget's config.
            // Normalize the deprecated `seriesType` alias first (matching the `config`
            // patch branch above and `addWidget`/`applyBulkUpdate`; otherwise it would
            // linger until the next load boundary), then include it ONLY when it differs
            // by value from the current config — a value-identical replacement must not
            // rewrap the widget (reference-equality no-op contract). Compared key-by-key,
            // the same way the `config`-patch branch tracks `changedConfig`.
            //
            // `isPlainRecord(value)` is a defense-in-depth guard (mirroring this
            // file's other unsafe-key guards for the "server bypasses the parser"
            // case): `parseStateMutation` already rejects a non-record `changes.config`
            // at the wire boundary, but without this guard a server-built mutation with
            // `changes: { config: null }` would fall through to a bare `value !==
            // updated.config` comparison and assign `config = null`, corrupting the
            // widget — and `changes: { config: [...] }` would install the array AS the
            // widget's `config` verbatim (T2-2), since `normalizeConfigChartSeries` and
            // `shallowRecordEqual` are both array-tolerant. A non-record value is simply
            // ignored rather than applied.
            if (isPlainRecord(value)) {
              // Strip prototype-polluting own keys before installing wholesale (T2-3), the
              // same defense-in-depth the `config`-patch loop applies per-key — otherwise
              // an unsafe key survives as an own config property and the next load drops
              // the whole widget.
              const safeValue = stripUnsafeConfigKeys(value as Record<string, unknown>);
              const normalized = normalizeConfigChartSeries(safeValue);
              if (!shallowRecordEqual(updated.config as Record<string, unknown>, normalized)) {
                definedChanges.config = normalized;
              }
            }
            continue;
          }
          // Scalar field (`title`/`subtitle`/`sourceId`/`kind`/`titleMode`/
          // `subtitleMode`): only a value that differs from the current widget is a real
          // change. Re-setting a field to its current value must not rewrap the widget
          // (reference-equality no-op contract), so a `changes: { title: 'Same' }` on a
          // widget already titled 'Same' returns the SAME doc.
          if (!(Object.hasOwn(updatedRecord, key) && updatedRecord[key] === value)) {
            definedChanges[key] = value;
          }
        }
        if (Object.keys(definedChanges).length > 0) {
          updated = { ...updated, ...(definedChanges as Partial<StudioWidget>) };
        }
      }
      // `unsetConfigKeys` — delete the named keys from the (post-merge) config.
      // The wire-safe equivalent of a `config`-patch `undefined` value: a key
      // NAME survives `JSON.stringify` where an `undefined` value is dropped.
      if (unsetConfigKeys && unsetConfigKeys.length > 0) {
        const nextConfig = { ...updated.config } as Record<string, unknown>;
        let changedConfig = false;
        for (const key of unsetConfigKeys) {
          if (Object.hasOwn(nextConfig, key)) {
            delete nextConfig[key];
            changedConfig = true;
          }
        }
        if (changedConfig) {
          updated = { ...updated, config: nextConfig as StudioWidget['config'] };
        }
      }
      // `unsetFields` — delete the named top-level keys from the widget. The REQUIRED
      // widget fields are never deletable: `id` is also the `state.widgets` map key
      // (dropping it strands the widget); `kind` and `title` are load-bearing for
      // rendering and the widget factory (a widget missing either crashes downstream);
      // and `config` is deliberately clearable via `unsetConfigKeys` only (an unset of
      // the whole bag would leave a widget with no config). Only optional fields
      // (matching the `OptionalWidgetField` type on `unsetFields`) are unsettable.
      if (unsetFields && unsetFields.length > 0) {
        const nextWidget = { ...updated } as Record<string, unknown>;
        let changedWidget = false;
        // Iterate as `string[]`: the compile-time type excludes required fields, but a
        // value arriving over the wire is not type-checked, so the runtime denylist
        // below is load-bearing for an untrusted payload.
        for (const key of unsetFields as string[]) {
          if (
            key !== 'id' &&
            key !== 'config' &&
            key !== 'kind' &&
            key !== 'title' &&
            Object.hasOwn(nextWidget, key)
          ) {
            delete nextWidget[key];
            changedWidget = true;
          }
        }
        if (changedWidget) {
          updated = nextWidget as unknown as StudioWidget;
        }
      }
      // Reference-equality no-op: if no branch above changed the widget (an empty or
      // identical-value config patch, an unset of absent keys, …), return the SAME
      // state reference so `commitDocPatch`'s no-op guard skips pushing an undo entry.
      if (updated === existing) {
        return state;
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

      // Row-edit step (the concern specific to a single-widget removal): strip the
      // widget from every page's rows (dropping an emptied row), and clear the stale
      // span of a *former row-mate this removal leaves as the sole occupant of the row
      // they shared* — that widget now auto-fills the row, so its old multi-widget-era
      // span is dead. This is deliberately scoped: a pre-existing single-widget-row
      // span (e.g. an AI `set_widget_width` narrowing a lone widget) is intentional and
      // must survive. The removed widget's OWN stale span entries are pruned by the
      // shared `removeWidgetIds` primitive below, on every page.
      const rowEditedPages = Object.fromEntries(
        Object.entries(state.pages).map(([pid, page]) => {
          const oldRows = page.widgetRows ?? [];
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
          if (!pageHeldWidget) {
            return [pid, page];
          }
          const nextSpans =
            orphanedSoleOccupants.length > 0
              ? removeSpanEntries(page.widgetColSpans, orphanedSoleOccupants)
              : page.widgetColSpans;
          return [pid, { ...page, widgetRows: newRows, widgetColSpans: nextSpans }];
        }),
      );

      // Finish via the shared primitive: it deletes the (now-unreferenced) widget from
      // the flat record, drops its widget/interactive/cross-filter-scoped filters (a
      // removed source widget would otherwise leave the page permanently filtered with
      // no clearing affordance), and prunes its stale span on every page. This handler
      // is the single implementation of this cleanup; `StudioController.removeWidget`
      // delegates to this reducer, so AI-driven and user-driven removals match.
      const {
        pages: nextPages,
        widgets: nextWidgets,
        filters: nextFilters,
      } = removeWidgetIds(rowEditedPages, state.widgets, state.filters, [widgetId]);

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
      // Drop row entries that name a widget id absent from `state.widgets` (and any row
      // left empty as a result): unlike `updateWidget`/`removeWidget`, this handler
      // previously installed `args.rows` verbatim, so a phantom-widget id would leave
      // the page rendering a widget that does not exist. Mirrors the trust boundary the
      // rest of this file applies to producer-supplied ids.
      const currentRows = targetPage.widgetRows ?? [];
      // Drop phantom-widget ids (absent from `state.widgets`) AND deduplicate ids that
      // appear more than once — the same id twice (in one row or across rows) would
      // render the widget twice (duplicate React key) and double-count its span in the
      // overflow sum below. `dedupeLayoutRows` keeps the first occurrence and drops any
      // row it empties.
      const sanitizedRows = dedupeLayoutRows(
        args.rows.map((row) => row.filter((id) => Object.hasOwn(state.widgets, id))),
      );
      // Replacing a page's rows verbatim can leave the col-spans invalid: a row
      // collapsed to a sole occupant keeps its stale multi-widget span, and a row
      // merged from two widgets can sum past `GRID_COLS`. `enforceLayoutColSpans` (the
      // sole implementation of these invariants) reconciles them, diffing the old rows
      // against the new ones.
      const nextSpans = enforceLayoutColSpans(
        currentRows,
        sanitizedRows,
        targetPage.widgetColSpans,
      );
      // Reference-equality no-op: identical rows and unchanged spans return the SAME doc
      // so `commitDocPatch`'s no-op guard skips a spurious undo entry.
      if (
        rowsEqual(currentRows, sanitizedRows) &&
        spansEqual(nextSpans, targetPage.widgetColSpans)
      ) {
        return state;
      }
      return {
        ...state,
        pages: {
          ...state.pages,
          [targetPageId]: { ...targetPage, widgetRows: sanitizedRows, widgetColSpans: nextSpans },
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
      // Unknown-widget guard (mirrors `updateWidget`/`removeWidget`): a span write for a
      // widget id that exists nowhere in `state.widgets` would otherwise persist an
      // orphan `widgetColSpans` entry (dead weight that serializes) — no-op instead.
      if (!Object.hasOwn(state.widgets, widgetId)) {
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
      // Orphan-span guard: the widget exists in `state.widgets` but is not on THIS
      // page's rows. If it instead lives on ANOTHER page's rows, writing its span here
      // would persist a dead `widgetColSpans` entry on the wrong page — a legacy payload
      // without `pageId` applied while the user is on another page, or an explicit
      // server-stamped `pageId` racing a concurrent user move of the widget to another
      // page mid-turn (the same stale-snapshot class the `currentRow` derivation names).
      // No-op in that case. A widget on NO page at all is the documented not-yet-placed
      // case and keeps the `args.rowWidgetIds` fallback below.
      if (
        currentRow === undefined &&
        Object.values(state.pages).some((p) =>
          (p.widgetRows ?? []).some((row) => row.includes(widgetId)),
        )
      ) {
        return state;
      }
      // `?? [widgetId]` final fallback (finding 2.5): for a not-yet-placed widget (in
      // `state.widgets` but on no page) the derived `currentRow` is `undefined`, and a
      // parser-bypassing partial payload (an `executeToolOnState`-style mutation built by
      // hand, which never runs `parseStateMutation`) can omit `rowWidgetIds` — leaving
      // `rowWidgetIds.filter(...)` below to throw a `TypeError` mid-apply instead of the
      // graceful degraded apply every sibling handler provides. Default to treating the
      // widget as the sole occupant of its row, mirroring the producer's own
      // `currentRow ?? [widgetId]` default (`executeToolOnState`'s `set_widget_width`).
      const rowWidgetIds = currentRow ?? args.rowWidgetIds ?? [widgetId];
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
            const otherId = otherIds[0];
            const remaining = GRID_COLS - clamped;
            if (remaining >= MIN_SPAN) {
              // `Object.hasOwn`/`isSafePatchKey` before the bracket assignment (matching
              // every other id-keyed write in this file): on the fallback branch the row
              // membership comes from the wire-supplied `args.rowWidgetIds`, so a phantom
              // row-mate id must never receive a persisted orphan span, and a prototype-
              // polluting id (`'__proto__'`/`'constructor'`) must never reach the setter.
              if (Object.hasOwn(state.widgets, otherId) && isSafePatchKey(otherId)) {
                newSpans[otherId] = remaining;
              }
            } else {
              delete newSpans[otherId];
            }
          } else {
            for (const id of otherIds) {
              delete newSpans[id];
            }
          }
        }
      }

      const finalSpans = Object.keys(newSpans).length > 0 ? newSpans : undefined;
      // Reference-equality no-op: re-writing the identical span (or clearing a widget
      // that has no span entry) leaves the spans unchanged by value, so return the SAME
      // doc and skip a spurious undo entry.
      if (spansEqual(finalSpans, targetPage.widgetColSpans)) {
        return state;
      }
      return {
        ...state,
        pages: {
          ...state.pages,
          [targetPageId]: {
            ...targetPage,
            widgetColSpans: finalSpans,
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
      // `Object.hasOwn` guard so an untrusted `pageId` can't match a prototype member.
      if (!Object.hasOwn(state.pages, pageId)) {
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
      const filtersAfterPageDrop = state.filters.filter((f: StudioFilterState) => {
        const p = 'pageId' in f.scope ? f.scope.pageId : undefined;
        return p !== pageId;
      });

      // Remove the page's widgets, but only those NOT still referenced on a surviving
      // page: a widget shared across pages keeps its `widgets` entry AND its
      // widget-anchored filters/spans (the 1.5 cross-page guard). The primitive also
      // prunes genuinely-removed widgets' widget/interactive/cross-filter-scoped
      // filters and their stale spans everywhere.
      const {
        pages: prunedPages,
        widgets: nextWidgets,
        filters: nextFilters,
      } = removeWidgetIds(nextPages, state.widgets, filtersAfterPageDrop, widgetIdsOnPage);

      const remainingPageIds = Object.keys(prunedPages);
      const nextActivePageId =
        state.dashboard.activePageId === pageId
          ? (remainingPageIds[0] ?? '')
          : state.dashboard.activePageId;

      return {
        ...state,
        pages: prunedPages,
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

  addFilter: {
    apply: (state, args) => {
      // Idempotent: re-delivery of the same addFilter SSE event must not append a
      // duplicate (unlike a fresh filter, the id already exists).
      if (state.filters.some((f) => f.id === args.filter.id)) {
        return state;
      }
      // Reject an ORPHAN cross-filter/interactive filter (finding 2.1): both scope kinds
      // carry a `sourceWidgetId`, and the reducer's ONLY cleanup path for such filters
      // (`dropWidgetScopedFilters`) fires when that source widget is REMOVED. A filter
      // naming a `sourceWidgetId` that no widget in the doc ever had would therefore
      // filter its page forever with no clearing affordance — exactly the orphan state
      // `deserializeState` drops on load. Screen it here so the wire/reducer boundary and
      // the load boundary agree. "Existing widget" is the reducer's own notion —
      // `Object.hasOwn(state.widgets, id)` — matching every other id-keyed guard here
      // (`updateWidget`/`removeWidget`), and an untrusted id can't match a prototype
      // member. No-op-return the input `state` reference, the dominant convention for an
      // unresolvable-target mutation in this reducer (`updateWidget`/`removePage`/
      // `setActivePage` unknown-id cases).
      const { scope } = args.filter;
      if (
        (scope.kind === 'cross-filter' || scope.kind === 'interactive') &&
        !Object.hasOwn(state.widgets, scope.sourceWidgetId)
      ) {
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
      const { removedWidgetIds, addedWidgets, updatedWidgets } = args;
      const { activePageId } = args;

      // `widgetRows`/`widgetColSpans` are typed as REQUIRED on the wire mutation, but the
      // reducer must stay TOTAL over a parser-bypassing partial payload a future middleware
      // tool builds by hand (the established `executeToolOnState` pattern, which never runs
      // `parseStateMutation`) — exactly as the three widget-delta fields already are
      // (`?? []`). Read them as runtime-optional (finding 2.5).
      const widgetRows = args.widgetRows as string[][] | undefined;
      const widgetColSpans = args.widgetColSpans as Record<string, number> | undefined;
      // The whole layout-replacement block is SKIPPED when BOTH layout fields are absent
      // (finding 2.5 / shared with ai-middleware T2-4): defaulting an absent `widgetRows`
      // to `[]` would silently WIPE the active page's layout when the field is merely
      // omitted from a partial-batch mutation — strictly worse than throwing. So the layout
      // is only replaced when at least one field is actually PRESENT (the producer attaches
      // them only for a batch that changed layout); an updates-only bulk leaves layout
      // untouched. When present, array/record-ness is coerced below so the block stays total.
      const hasLayoutUpdate = widgetRows !== undefined || widgetColSpans !== undefined;

      // The layout portion (`widgetRows`/`widgetColSpans`) targets the ACTIVE PAGE only,
      // but the widget deltas (`removedWidgetIds`/`addedWidgets`/`updatedWidgets`) are
      // page-independent — the lost-update-safe delta shape exists precisely to apply them
      // on top of the receiver's CURRENT widgets. When `activePageId` is stale (the target
      // page was deleted mid-turn), the layout replacement is skipped, but the widget
      // deltas are still applied rather than silently dropping the WHOLE mutation. Only the
      // page-scoped layout is conditional on the page existing. `Object.hasOwn` so an
      // untrusted `activePageId` can't match a prototype member.
      const pageExists = Object.hasOwn(state.pages, activePageId);
      let layoutPages: StudioDoc['pages'] = state.pages;
      if (pageExists && hasLayoutUpdate) {
        const page = state.pages[activePageId];

        // Sanitize the producer-supplied active-page rows against the ids that will
        // actually exist once this bulk applies: existing widgets PLUS this bulk's own
        // `addedWidgets` ids (inserted below in the same handler, so a row legitimately
        // references them) that pass the safe-key gate. Unlike `setWidgetLayout` — which
        // filters against `state.widgets` alone — the bulk's rows may name a not-yet-
        // inserted added widget, so filtering against `state.widgets` alone would wrongly
        // drop them. A phantom id (neither an existing widget nor a safe added-widget id)
        // would otherwise persist in `widgetRows` with no `widgets` entry — exactly the
        // "page renders a widget that does not exist" state `setWidgetLayout` guards
        // against. Removed ids resolve afterwards via `removeWidgetIds` and need no
        // special-casing. A `Set` lookup keeps an untrusted id off the prototype chain.
        const validRowIds = new Set<string>(Object.keys(state.widgets));
        for (const widget of addedWidgets ?? []) {
          if (isSafePatchKey(widget.id)) {
            validRowIds.add(widget.id);
          }
        }
        // Drop phantom ids (not an existing widget nor a safe added-widget id) AND
        // deduplicate ids that appear more than once — the same id twice would render the
        // widget twice and double-count its span in `enforceLayoutColSpans`'s overflow
        // sum. `dedupeLayoutRows` keeps the first occurrence and drops any emptied row.
        //
        // Resolve which rows to reconcile against, TOTAL over all three partial-payload
        // shapes (finding 2.5 closed only two of them; T1-1 closes the third):
        //  - `widgetRows` ABSENT (a spans-only bulk: `widgetColSpans` present, no rows) ⇒
        //    reconcile the span update against the page's EXISTING rows, NOT `[]`.
        //    Defaulting to `[]` here silently un-places EVERY widget on the active page —
        //    and then `enforceLayoutColSpans` drops the very spans this bulk carries as
        //    orphans against the now-empty rows — so a mutation that only meant to change a
        //    width would blank the page (T1-1). Leaving row placement untouched applies the
        //    colSpans-only update, the mirror of the rows-only case below.
        //  - `widgetRows` present and an array ⇒ install it (the normal both-present case).
        //  - `widgetRows` present but a non-array (hand-built junk, e.g. `null`) ⇒ treat it
        //    as ABSENT and reconcile against the page's EXISTING rows, NOT `[]`. The
        //    `widgetColSpans → {}` coercion is harmless (spans merge/replace), but a
        //    `widgetRows → []` coercion is DESTRUCTIVE: it un-places every widget on the
        //    active page and then `enforceLayoutColSpans` drops all their spans as orphans —
        //    the exact blank-page outcome T1-1 established a malformed layout field must
        //    never trigger. `?? []` is equally total (no `.map` throw) and strictly safer.
        // ONE presence predicate for BOTH the row-placement resolution below and the spans
        // merge-vs-replace decision further down (T2-2): a present-but-non-array `widgetRows`
        // (hand-built junk, e.g. `null`, from a parser-bypassing payload) is ABSENT for row
        // placement AND must not flip the spans decision to REPLACE. Keying the spans decision
        // on `widgetRows === undefined` instead let a junk `widgetRows: null` + colSpans payload
        // wholesale-replace the receiver's span map — wiping a DIFFERENT widget's
        // concurrent/unnamed span (the same lost-update class the rows-absent MERGE branch
        // closes), even though rows were NOT re-placed.
        const rowsProvided = Array.isArray(widgetRows);
        const safeRows: string[][] = rowsProvided
          ? (widgetRows as string[][])
          : (page.widgetRows ?? []);
        const sanitizedRows = dedupeLayoutRows(
          safeRows
            .filter((row): row is string[] => Array.isArray(row))
            .map((row) => row.filter((id) => validRowIds.has(id))),
        );

        // Normalize the producer-supplied active-page spans through the SAME invariants
        // every other layout path enforces (previously they were stored verbatim, so a
        // bad producer could persist an out-of-range or overflowing span): clamp each
        // span to the valid range and drop unsafe keys (so the rebuild can't reintroduce
        // prototype pollution), then run `enforceLayoutColSpans`. `oldRows = []` so the
        // 2→1 collapse never fires — the producer supplied rows and spans together, so a
        // singleton span is intentional — while the row-overflow drop, orphaned-span
        // drop, and empty→undefined collapse all apply. Feeding the SANITIZED rows here
        // means a span for a dropped phantom id is pruned as an orphan.
        // Coerce a non-record `widgetColSpans` (absent when only `widgetRows` was supplied,
        // or junk from a hand-built payload) to `{}` so `Object.keys` can't throw (finding 2.5).
        const safeSpans: Record<string, number> =
          widgetColSpans !== null &&
          typeof widgetColSpans === 'object' &&
          !Array.isArray(widgetColSpans)
            ? widgetColSpans
            : {};
        const clampedSpans: Record<string, number> = {};
        for (const key of Object.keys(safeSpans)) {
          if (!isSafePatchKey(key)) {
            continue;
          }
          clampedSpans[key] = clampSpan(safeSpans[key]);
        }

        // T2-2 (residual lost-update): a bulk that did NOT re-place rows (`!rowsProvided` —
        // rows absent OR present-but-non-array junk, keyed on the SAME predicate the
        // row-placement resolution above uses, not a second `widgetRows === undefined` test
        // that would classify `null` differently) must MERGE its span entries onto the page's
        // EXISTING spans, not REPLACE the whole map. The producer ships a turn-start snapshot
        // of the page's spans; wholesale-replacing the receiver's map with it silently reverts
        // a concurrent client drag-resize of a DIFFERENT widget (one not named in this batch) —
        // the same lost-update class T2-4 / 2.3 closed for `widgetRows`, one field over.
        // Merging (incoming keys win, untouched keys survive) is backward compatible with the
        // current full-snapshot producer — a superset merge ≡ replace for the keys it
        // carries — while preserving any client-side span the snapshot doesn't know about.
        // Bulk `colSpans` entries are numbers 6–24 and cannot clear a span, so merge
        // semantics lose nothing. When rows ARE provided the producer genuinely re-placed
        // rows and ships rows+spans together, so the wire spans ARE the intended full map for
        // the new placement and must replace, not merge.
        const spansToEnforce: Record<string, number> = rowsProvided
          ? clampedSpans
          : { ...(page.widgetColSpans ?? {}), ...clampedSpans };
        const normalizedActiveSpans = enforceLayoutColSpans([], sanitizedRows, spansToEnforce);

        // Reference-equality no-op tracking: only rebuild the active page when its rows or
        // spans actually changed (by value), so a re-delivered bulk carrying the current
        // layout doesn't churn the page reference and push a spurious undo entry.
        const layoutChanged =
          !rowsEqual(page.widgetRows ?? [], sanitizedRows) ||
          !spansEqual(normalizedActiveSpans, page.widgetColSpans);
        if (layoutChanged) {
          layoutPages = {
            ...state.pages,
            [activePageId]: {
              ...page,
              widgetRows: sanitizedRows,
              widgetColSpans: normalizedActiveSpans,
            },
          };
        }
      }

      // Remove every genuinely-gone widget via the shared primitive: a widget named in
      // `removedWidgetIds` is only truly removed if it doesn't still appear on some
      // OTHER page's rows (a pre-existing cross-page id collision must not delete a
      // widget the other page still renders). The primitive deletes those ids from
      // `state.widgets`, drops their widget/interactive/cross-filter-scoped filters,
      // and prunes their stale col-spans on every page.
      const {
        pages: nextPages,
        widgets: prunedWidgets,
        filters: nextFilters,
      } = removeWidgetIds(layoutPages, state.widgets, state.filters, removedWidgetIds ?? []);

      // Apply the add/update deltas on top of the pruned widgets — never a turn-start
      // snapshot — so any widget the user concurrently created or edited (on this page
      // or any other) while the agentic turn was running survives. Copy first, because
      // the primitive returns `state.widgets` by reference on a no-op removal.
      // `widgetsChanged` tracks whether the record actually diverged from `state.widgets`
      // (a removal, an accepted add, or an applied update), so a bulk that touches no
      // widget can return the SAME doc (reference-equality no-op contract).
      let widgetsChanged = prunedWidgets !== state.widgets;
      const nextWidgets = { ...prunedWidgets };
      for (const widget of addedWidgets ?? []) {
        // `isSafePatchKey` before the bracket assignment (matching every other handler
        // and the `UNSAFE_KEYS` convention): `nextWidgets['__proto__'] = widget` would
        // re-prototype the record rather than add an own key. The wire path is already
        // shielded by `parseStateMutation`'s `isSafeId` check on `addedWidgets[].id`;
        // this is the defense-in-depth copy for a server-built mutation bypassing it.
        if (!isSafePatchKey(widget.id)) {
          continue;
        }
        // Idempotent add: existence anywhere in `nextWidgets` means this widget was
        // already applied, so a re-delivery (an SSE at-least-once retry, or an AI retry
        // re-issuing the same bulk envelope) must be a no-op — mirrors `addWidget`'s
        // guard. Overwriting would revert a concurrent user edit to a widget this bulk
        // originally added. `Object.hasOwn` (not truthy access) so an untrusted id can't
        // match a prototype member.
        if (Object.hasOwn(nextWidgets, widget.id)) {
          continue;
        }
        // Coerce a non-record `config` to `{}` BEFORE installing (T2-2), mirroring
        // `addWidget` and the load boundary — otherwise a hand-built `config: null`
        // added widget detonates on the next config-touching mutation.
        const safeWidget = coerceWidgetConfig(widget);
        // Normalize the deprecated `seriesType` alias on write (reference-stable when
        // already canonical), so a bulk-added widget matches the load-boundary shape.
        const normalizedConfig = normalizeConfigChartSeries(safeWidget.config);
        nextWidgets[widget.id] =
          normalizedConfig === safeWidget.config
            ? safeWidget
            : ({ ...safeWidget, config: normalizedConfig } as StudioWidget);
        widgetsChanged = true;
      }
      for (const update of updatedWidgets ?? []) {
        // `Object.hasOwn` existence check (not truthy `nextWidgets[update.widgetId]`)
        // so an untrusted `widgetId` like `'constructor'` resolves to "no such widget"
        // instead of the `Object` prototype member (a truthy phantom "existing widget").
        if (!Object.hasOwn(nextWidgets, update.widgetId)) {
          continue;
        }
        const existing = nextWidgets[update.widgetId];
        let patchedWidget = existing;
        // Only rewrap the widget for a field that genuinely DIFFERS from its current
        // value — same idempotency guard the `config`-patch branch of `updateWidget`
        // applies. Without this, a re-delivered bulk (SSE at-least-once) carrying a
        // value-identical or field-less `{ widgetId }` update entry churns the doc and
        // pushes a spurious undo entry, breaking the reference-equality no-op contract.
        if (update.title !== undefined && update.title !== existing.title) {
          patchedWidget = { ...patchedWidget, title: update.title };
        }
        if (update.sourceId !== undefined && update.sourceId !== existing.sourceId) {
          patchedWidget = { ...patchedWidget, sourceId: update.sourceId };
        }
        // `config` is a shallow-merge patch onto the LIVE widget's config, so a
        // concurrent edit to a different config key is preserved. Normalize the merged
        // config's `ySeries` so the deprecated `seriesType` alias never survives a live
        // bulk update (matching `updateWidget`/`addWidget`, so the alias is not left to
        // be normalized only at the next load boundary). Only assign when the merge
        // actually changed a config key by value (compared like the `config`-patch
        // branch), so a value-identical config patch stays a no-op.
        //
        // `isPlainRecord` (not bare truthiness): a bare `if (update.config)` lets an
        // array OR a truthy string through, and `{ ...existing.config, ...update.config }`
        // spreads either one's index keys ("0", "1", …) into the merged config (T2-2).
        // A non-record `update.config` is skipped entirely, same as an absent one.
        if (isPlainRecord(update.config)) {
          // Strip prototype-polluting own keys from the merge result before installing
          // (T2-3), the same defense-in-depth the `updateWidget` config-patch loop applies
          // per-key — otherwise an unsafe key in `update.config` survives as an own config
          // property and `deserializeState` drops the whole widget on the next load.
          const mergedConfig = normalizeConfigChartSeries(
            stripUnsafeConfigKeys({
              ...existing.config,
              ...update.config,
            }),
          ) as StudioWidget['config'];
          if (
            !shallowRecordEqual(
              existing.config as Record<string, unknown>,
              mergedConfig as Record<string, unknown>,
            )
          ) {
            patchedWidget = { ...patchedWidget, config: mergedConfig };
          }
        }
        if (patchedWidget !== existing) {
          nextWidgets[update.widgetId] = patchedWidget;
          widgetsChanged = true;
        }
      }

      // Reference-equality no-op: a bulk that removed nothing, added/updated no widget,
      // and left the active-page layout unchanged returns the SAME doc so
      // `commitDocPatch`'s no-op guard skips a spurious undo entry.
      if (!widgetsChanged && nextPages === state.pages && nextFilters === state.filters) {
        return state;
      }

      return {
        ...state,
        widgets: widgetsChanged ? nextWidgets : state.widgets,
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
      // Reference-equality no-op: a `targetThreadId` matching no thread (the unknown-id
      // case the contract names), or a matched thread whose name+timestamp are already
      // identical, returns the SAME doc so `commitDocPatch`'s no-op guard skips a
      // spurious undo entry.
      let changed = false;
      const updatedThreads = (state.ai.threads ?? []).map((t) => {
        if (t.id !== targetThreadId || (t.name === args.name && t.updatedAt === args.updatedAt)) {
          return t;
        }
        changed = true;
        return { ...t, name: args.name, updatedAt: args.updatedAt };
      });
      if (!changed) {
        return state;
      }
      return {
        ...state,
        ai: { ...state.ai, threads: updatedThreads },
      };
    },
    label: () => 'renameAIThread',
  },
};

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
  // A single cast at the dispatch boundary: TS cannot prove that
  // `MUTATION_HANDLERS[mutation.type]` and `mutation.args` share the same `M`
  // (the correlation is lost once `mutation.type` is read), so we assert the
  // handler as the general shape. The mapped type above still guarantees a
  // handler exists for every variant known at compile time — but a value
  // arriving over the wire (SSE payload, legacy/forward-incompatible client)
  // is not guaranteed to match, so guard the lookup at runtime too.
  // `Object.hasOwn` before the bracket read (T2-1), matching the `Object.hasOwn` discipline
  // every other table lookup in this package uses (`parseStateMutation`'s validator table,
  // `getAllowedConfigKeys`, the reducer's per-widget guards). Without it, a `mutation.type`
  // naming an `Object.prototype` member (`'constructor'`/`'toString'`/`'__proto__'`) resolves
  // UP the prototype chain instead of to `undefined`, defeating the `handler ? … : doc` guard:
  // `type: 'constructor'` would call `Object.apply(doc, args)` and replace the whole doc with
  // a bogus `{}`, and `'__proto__'`/`'valueOf'` would throw mid-apply. Gating on own-property
  // membership restores the documented graceful no-op for an unrecognized `type`.
  const handler = Object.hasOwn(MUTATION_HANDLERS, mutation.type)
    ? (MUTATION_HANDLERS[mutation.type] as MutationHandler<StateMutation>)
    : undefined;
  return handler ? handler.apply(doc, mutation.args) : doc;
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
 * Compact, human-readable label for a mutation, used for the AI recent-mutation
 * log (client-side undo/redo history label + MCP `get_recent_changes`).
 */
export function mutationLabel(mutation: StateMutation): string {
  // `Object.hasOwn` before the bracket read (T2-1), same reasoning as `applyDocMutation`:
  // a `type` naming an `Object.prototype` member would otherwise resolve to a prototype
  // function and throw `handler.label is not a function` instead of returning the raw type
  // string the contract promises for an unrecognized `type`.
  const handler = Object.hasOwn(MUTATION_HANDLERS, mutation.type)
    ? (MUTATION_HANDLERS[mutation.type] as MutationHandler<StateMutation>)
    : undefined;
  return handler ? handler.label(mutation.args) : (mutation as { type: string }).type;
}
