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
import type { StudioState, StudioDoc, StudioFilterState, StudioFilterScope } from './stateTypes';
import type { StudioChartSeries, StudioWidget } from './widgetTypes';
import type { StateMutation } from './aiTypes';
import { normalizeChartSeries } from './factories';
import { isSafeKey } from './unsafeKeys';
import { hasUnsafeOwnKeys, isStringArray } from './parseStateMutation';
import { getAllowedConfigKeys } from './configKeyValidation';
import { isStudioFilterOperator } from './widgetTypeGuards';
// `isPlainRecord` (the single shared "is this a usable record" predicate: a non-record
// `config`/`widget`/`filter` — `null`, an array, or a truthy primitive like a string —
// is treated as ABSENT, never as a record to merge or install), `stripUnsafeConfigKeys`
// (the config-record own-key screen: strips `__proto__`/`constructor`/`prototype` before
// a record is installed WHOLESALE onto a widget, so it never round-trips as an own DATA
// property that later poisons a spread or gets the whole widget dropped on the next
// load), and `repairFilterDependsOn` (strips a malformed `dependsOn` from a filter about
// to be installed verbatim, rather than sinking the whole filter) were each independently
// duplicated across this file, `parseStateMutation.ts`, and `statePersistence.ts`
// (finding 3.2). Consolidated in `internalGuards.ts` so the three trust boundaries can no
// longer drift; imported here under this file's established local names (`isPlainRecord`,
// `stripUnsafeConfigKeys`) so every existing call site below is unchanged.
import {
  isPlainRecord,
  stripUnsafeOwnKeys as stripUnsafeConfigKeys,
  repairFilterDependsOn,
} from './internalGuards';

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
 * Strip prototype-polluting own keys (`__proto__`/`constructor`/`prototype`) from a
 * filter object about to be appended to `state.filters` VERBATIM (F5 finding,
 * `addFilter`). The wire boundary (`parseStateMutation`'s `validateFilter`) already
 * rejects such a filter outright via its own `hasUnsafeOwnKeys(filter)` check, but
 * `addFilter` is also reachable from a server-built mutation that bypasses the parser
 * (the `executeToolOnState` path every other ADD channel in this file — `addWidget`,
 * `applyBulkUpdate.addedWidgets` — already defends against via `coerceWidgetConfig`/
 * `stripUnsafeConfigKeys`). Without this, such a filter would install with an own
 * `"__proto__"` key that round-trips through `serializeDoc` and poisons the next
 * `{ ...filter }` spread (e.g. `removeFilter`'s producer, or a future edit). Reuses
 * the exact `stripUnsafeConfigKeys` implementation — the check is identical regardless
 * of whether the record is a widget config or a filter. Reference-stable when the
 * filter carries no unsafe own key.
 */
function stripUnsafeFilterKeys(filter: StudioFilterState): StudioFilterState {
  const safe = stripUnsafeConfigKeys(filter as unknown as Record<string, unknown>);
  const safeFilter =
    safe === (filter as unknown as Record<string, unknown>)
      ? filter
      : (safe as unknown as StudioFilterState);
  // Descend into `scope` (Tier2 finding): `scope` is a record nested one level inside
  // `filter`, and every OTHER nested record this reducer installs verbatim (a widget's
  // `config` via `coerceWidgetConfig`) already gets this same defense-in-depth strip for a
  // server-built mutation bypassing `parseStateMutation`. Without this, a scope carrying an
  // own `__proto__`/`constructor`/`prototype` key would append verbatim and round-trip
  // through `serializeDoc`, later poisoning a spread of the scope object. Reference-stable
  // when `scope` is not a record (the crash-prevention shape guard in `addFilter.apply`
  // already handles a non-record scope before this helper runs) or carries no unsafe key.
  const { scope } = safeFilter;
  if (!isPlainRecord(scope)) {
    return safeFilter;
  }
  const safeScope = stripUnsafeConfigKeys(scope as unknown as Record<string, unknown>);
  if (safeScope === (scope as unknown as Record<string, unknown>)) {
    return safeFilter;
  }
  return { ...safeFilter, scope: safeScope as unknown as StudioFilterScope };
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
//
// It ALSO strips prototype-polluting own keys from a record config (T2-2), so the two ADD
// channels (`addWidget`, `applyBulkUpdate.addedWidgets`) honor the SAME defense-in-depth key
// screen `stripUnsafeConfigKeys` already gives the two UPDATE channels. A server-built
// `addWidget` bypassing `parseStateMutation` (the `executeToolOnState` path — reachable for a
// host-registered CUSTOM widget kind, whose `validateConfigKeysForKind` imposes no key
// restriction) could otherwise install a config carrying an own `"__proto__"` key verbatim;
// the NEXT `deserializeState` load then drops the ENTIRE widget on its config own-key screen —
// deferred silent data loss. Reference-stable when the config is already a record with no
// unsafe own key.
function coerceWidgetConfig(widget: StudioWidget): StudioWidget {
  const { config } = widget;
  if (!isPlainRecord(config)) {
    return { ...widget, config: {} } as StudioWidget;
  }
  const safeConfig = stripUnsafeConfigKeys(config);
  return safeConfig === config ? widget : ({ ...widget, config: safeConfig } as StudioWidget);
}

// Key-strip the OPTIONAL widget scalars a parser-bypassing ADD channel (`addWidget`,
// `applyBulkUpdate.addedWidgets`) never validated (Finding 1). The wire boundary's
// `validateWidget` (`parseStateMutation.ts`) membership-checks all four — `subtitle`/
// `sourceId` via `isOptionalString`, `titleMode`/`subtitleMode` via `isOptionalTitleMode`
// — and the load boundary (`deserializeState`) drops each offending KEY. But a server-
// built add bypassing the parser installed e.g. `subtitle: 42`/`titleMode: 'weird'`
// verbatim, only for the very next load's key-drop to silently discard it — deferred data
// loss rather than a write-time repair. Mirror the load boundary's "strip the key, don't
// sink the whole widget" convention (these are optional, so an invalid value degrades to
// the field's default, not a widget no-op): delete a non-string `subtitle`/`sourceId` and
// a non-`'auto'|'manual'` `titleMode`/`subtitleMode`. Reference-stable when all four are
// valid or absent (the only shape the wire boundary itself ever lets through).
function screenOptionalWidgetScalars(widget: StudioWidget): StudioWidget {
  let base = widget;
  for (const modeKey of ['titleMode', 'subtitleMode'] as const) {
    const modeValue = (base as unknown as Record<string, unknown>)[modeKey];
    if (modeValue !== undefined && modeValue !== 'auto' && modeValue !== 'manual') {
      const nextBase = { ...base };
      delete (nextBase as unknown as Record<string, unknown>)[modeKey];
      base = nextBase as StudioWidget;
    }
  }
  for (const stringKey of ['subtitle', 'sourceId'] as const) {
    const stringValue = (base as unknown as Record<string, unknown>)[stringKey];
    if (stringValue !== undefined && typeof stringValue !== 'string') {
      const nextBase = { ...base };
      delete (nextBase as unknown as Record<string, unknown>)[stringKey];
      base = nextBase as StudioWidget;
    }
  }
  return base;
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
 * Strip every id in `idsToRemove` from every page's `widgetRows`, dropping any row
 * left empty and clearing the stale span of a former row-mate a removal leaves as
 * the SOLE occupant of a row it used to share (that survivor's stored span is a
 * multi-widget-era leftover — mirrors `enforceLayoutColSpans`'s 2→1 collapse). A
 * pre-existing single-widget-row span is untouched (only a row that shrank FROM 2+
 * TO 1 because of this removal counts). Generalizes the single-id row-edit step
 * `removeWidget` used to inline, so `applyBulkUpdate.removedWidgetIds` (a batch of
 * ids, not just one) can share the identical row-placement cleanup rather than
 * leaving removed widgets referenced on rows nobody touched (finding: bulk removals
 * were a no-op against `widgetRows` because nothing ever stripped the id from any
 * page's rows before the removal primitive ran).
 */
function stripWidgetIdsFromPages(
  pages: StudioDoc['pages'],
  idsToRemove: ReadonlySet<string>,
): StudioDoc['pages'] {
  if (idsToRemove.size === 0) {
    return pages;
  }
  let anyPageChanged = false;
  const nextEntries = Object.entries(pages).map(([pid, page]) => {
    const oldRows = page.widgetRows ?? [];
    const orphanedSoleOccupants: string[] = [];
    let pageHeldWidget = false;
    const newRows: string[][] = [];
    for (const row of oldRows) {
      const filtered = row.filter((id) => !idsToRemove.has(id));
      if (filtered.length === row.length) {
        newRows.push(row);
        continue;
      }
      pageHeldWidget = true;
      if (row.length >= 2 && filtered.length === 1) {
        orphanedSoleOccupants.push(filtered[0]);
      }
      if (filtered.length > 0) {
        newRows.push(filtered);
      }
    }
    if (!pageHeldWidget) {
      return [pid, page] as const;
    }
    anyPageChanged = true;
    const nextSpans =
      orphanedSoleOccupants.length > 0
        ? removeSpanEntries(page.widgetColSpans, orphanedSoleOccupants)
        : page.widgetColSpans;
    return [pid, { ...page, widgetRows: newRows, widgetColSpans: nextSpans }] as const;
  });
  return anyPageChanged ? (Object.fromEntries(nextEntries) as StudioDoc['pages']) : pages;
}

/**
 * Resolves the page a rank-eligible filter applies to, for the per-page
 * rank-uniqueness guard (finding: `addFilter` didn't enforce it):
 *  - `page` scope → its explicit `pageId`, or `null` for a legacy pageId-less page
 *    filter (which applies on EVERY page, so it must conflict everywhere).
 *  - `widget` scope → the id of the page whose `widgetRows` contain the widget, or
 *    `null` when the widget is not placed on any page.
 *  - other scope kinds are never rank filters and are excluded by the caller.
 *
 * Duplicated (not imported) from `@mui/x-studio`'s `internals/rankFilterScope.ts`:
 * the dependency arrow runs `x-studio` → `x-studio-schema`, never the reverse, so
 * this dependency-free package cannot import the client's copy. The reducer is the
 * mutation-semantics source of truth, so it needs its own copy of the invariant
 * rather than trusting every caller (`StudioController`'s five call sites) to
 * enforce it first.
 *
 * Exported (not duplicated a second time) so `statePersistence.ts`'s load boundary can
 * reuse the SAME resolution logic to re-check rank-filter uniqueness on a persisted doc
 * (finding: the invariant was enforced only on the live `addFilter` mutation path, never
 * re-checked on load, so a hand-edited/foreign doc could load with two conflicting rank
 * filters on the same page). Both live in this package, so there is no cross-package
 * import-direction concern the `x-studio` duplication comment above is guarding against.
 */
export function resolveRankFilterPageId(
  filter: StudioFilterState,
  pages: StudioDoc['pages'],
): string | null {
  const { scope } = filter;
  if (scope.kind === 'page') {
    return scope.pageId ?? null;
  }
  if (scope.kind === 'widget') {
    for (const page of Object.values(pages)) {
      if ((page.widgetRows ?? []).some((row) => row.includes(scope.widgetId))) {
        return page.id;
      }
    }
    return null;
  }
  return null;
}

/**
 * True when another rank filter already occupies `target`'s page context. Rank
 * uniqueness is per-page — a rank filter on page-1 does not block one on page-2 —
 * because page filters gate on `pageId === activePageId` and widget rank filters
 * are per-widget. A `null` resolved page (a pageId-less page filter, applied
 * everywhere) conflicts with — and is conflicted by — any other rank filter.
 *
 * Only `page`/`widget` scopes are rank-eligible (matching {@link resolveRankFilterPageId}'s
 * doc comment: "other scope kinds are never rank filters and are excluded by the
 * caller"). The existing-filter loop below therefore excludes every OTHER scope kind,
 * not just `cross-filter` — previously only `cross-filter` was excluded here, so an
 * `interactive`- or `dashboard-date-range`-scoped filter with `filterMode: 'rank'`
 * (wire-valid: the wire boundary never restricts `filterMode` to a scope kind) resolved
 * via `resolveRankFilterPageId`'s catch-all `return null`, and a `null` page context
 * conflicts with — and is conflicted by — EVERY other rank filter, so a single such
 * filter would silently reject every legitimate `page`/`widget` rank filter on every
 * page thereafter. The caller (`addFilter`) mirrors this by skipping the conflict gate
 * entirely for a non-`page`/`widget` scope, so this exclusion is defense-in-depth for
 * any other caller (e.g. the load-boundary dedup in `statePersistence.ts`).
 *
 * Exported for reuse by `statePersistence.ts`'s load-boundary rank-filter dedup sweep
 * (see {@link resolveRankFilterPageId}'s export comment).
 */
export function hasConflictingRankFilter(
  filterId: string,
  target: StudioFilterState,
  filters: StudioFilterState[],
  pages: StudioDoc['pages'],
): boolean {
  const targetPageId = resolveRankFilterPageId(target, pages);
  return filters.some((filter) => {
    if (
      filter.id === filterId ||
      (filter.scope.kind !== 'page' && filter.scope.kind !== 'widget') ||
      filter.filterMode !== 'rank'
    ) {
      return false;
    }
    const otherPageId = resolveRankFilterPageId(filter, pages);
    return targetPageId === null || otherPageId === null || otherPageId === targetPageId;
  });
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
    // Coerce a missing/non-string `title` to the same `'Untitled Page'` fallback the
    // factory uses (finding: a persisted doc with junk `page.title` — `null`, `42`, an
    // object — previously passed `migrateState`'s validation, which only checks
    // `widgetRows`, and installed verbatim. Every consumer of `page.title` (e.g.
    // `StudioWidgetCardActionsOverlay`) renders it directly as text with no fallback of
    // its own, so a non-string title crashed React on first render of the page picker.
    // `addPage`/`renamePage` already require a string `title` at the wire/reducer
    // boundary — parseStateMutation.ts's `isString(args.title)` gate — so this closes
    // the ONE remaining gap: a persisted doc loaded directly, bypassing those mutations.
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
        {
          ...page,
          id: pid,
          title: safeTitle,
          widgetRows: sanitizedRows,
          widgetColSpans: nextSpans,
        },
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
  // (c) drop the removed widgets from the flat widgets record — but only rebuild it when at
  // least one removed id is an OWN key of `widgets` (T2-1). A re-delivered removal bulk (SSE
  // at-least-once) whose `removedWidgetIds` names an already-gone widget classifies it as
  // "genuinely removed" here (no surviving page references it), yet `{ ...widgets }` + a no-op
  // `delete` would mint a fresh, content-identical record — flipping the caller's
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
      // Require a STRING id (T2-3). A parser-bypassing server-built `addPage` with `id`
      // absent would otherwise pass `isSafePatchKey(undefined)` (the denylist has no
      // `undefined` member) and mint a page keyed `"undefined"` with `id: undefined`,
      // simultaneously setting `dashboard.activePageId` to `undefined` — strictly worse than a
      // no-op. The wire boundary already requires a safe string id; mirror it here.
      if (typeof id !== 'string') {
        return state;
      }
      // Require a STRING title (T3 finding, parser-bypass parity with the wire boundary's
      // `isString(args.title)` gate in `parseStateMutation.ts`). Without this, a server-built
      // `addPage` bypassing the parser with a non-string `title` (e.g. `undefined`, `42`) would
      // install a page whose `title` violates `StudioDoc['pages'][string].title: string` — no
      // immediate throw, but a value the canvas's page-tab renderer and `serializeDoc`'s
      // round-trip both assume is a string, corrupting the doc until the next load boundary
      // (which has no per-page title screen to catch it). No-op instead, mirroring the
      // sibling `renamePage` fix and `addWidget`'s `typeof widget.id !== 'string'` guard.
      if (typeof title !== 'string') {
        return state;
      }
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
      // Require a STRING title (finding 2.2, parser-bypass parity with `addPage`/
      // `renamePage`'s `typeof title !== 'string'` guards and the wire boundary's
      // `isString(args.title)` gate in `parseStateMutation.ts`). Without this, a
      // server-built `setDashboardTitle` bypassing the parser with a non-string
      // `title` (e.g. `undefined`, `42`) would install it verbatim — no immediate
      // throw, but a value that violates `StudioDoc['dashboard'].title: string`,
      // corrupting the dashboard title until something downstream (the page-header
      // renderer, `serializeDoc`'s round-trip) trips over the non-string value.
      if (typeof args.title !== 'string') {
        return state;
      }
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
      // Require a record `widget` (T2-3). A parser-bypassing server-built `addWidget` with
      // `widget` absent/non-record would throw on the `widget.id` read below; no-op instead,
      // mirroring the wire boundary's `validateWidget` record check.
      if (!isPlainRecord(widget)) {
        return state;
      }
      // Require a STRING id (mirrors `addPage`'s `typeof id !== 'string'` guard). Only
      // `isSafePatchKey` was checked below, but `isSafeKey` takes any `unknown` and a
      // non-string (e.g. `widget.id: 42`) never matches the denylist's string members,
      // so it fell through and installed a widget keyed by the STRINGIFIED id (`"42"`)
      // while `widget.id` itself stayed numeric — a desync between the map key and the
      // `id` field identical to the one `addPage` already guards against.
      if (typeof widget.id !== 'string') {
        return state;
      }
      // Screen the widget id against the shared prototype-hazard denylist before the
      // literal inserts below (matching `applyBulkUpdate.addedWidgets` and the load
      // boundary). No prototype pollution risk (literal define-semantics), but a
      // `'__proto__'` id would create a real own entry that silently vanishes on the next
      // load (the load-boundary key screen drops it) — transient data loss. Reject it up
      // front, uniform with the sibling handler.
      if (!isSafePatchKey(widget.id)) {
        return state;
      }
      // Require STRING `kind`/`title` (Finding 2 — this is the ADD-channel sibling of
      // `updateWidget`'s `changes.kind`/`changes.title` guard and `applyBulkUpdate`'s
      // `updatedWidgets` `title` guard above, and mirrors the wire boundary's own
      // `isString(widget.kind)`/`isString(widget.title)` checks in `validateWidget`).
      // Without this, a parser-bypassing `addWidget` with e.g. `kind: 42` installed
      // verbatim now, only for `deserializeState`'s widget screen to silently drop the
      // ENTIRE widget on the very next load — deferred silent data loss rather than a
      // rejection at write time.
      if (typeof widget.kind !== 'string' || typeof widget.title !== 'string') {
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
      // Key-strip the optional scalars (`subtitle`/`sourceId`/`titleMode`/
      // `subtitleMode`) the wire boundary validates but this ADD channel didn't
      // (Finding 1) BEFORE installing, so an invalid value never lands verbatim to be
      // silently dropped on the next load.
      const safeWidget = screenOptionalWidgetScalars(coerceWidgetConfig(widget));
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
    // T3 finding: `mutationLabel` is only guarded against a non-record TOP-LEVEL `args`
    // (`isPlainRecord(mutation.args)` in `mutationLabel`) — it never guaranteed `args.widget`
    // itself is a record, so a server-built mutation bypassing `parseStateMutation` with
    // `args: { widget: undefined }` (a record `args`, but no usable `widget`) would throw
    // `Cannot read properties of undefined (reading 'kind')` reading `args.widget.kind` below
    // — an uncaught exception, not a graceful fallback label, breaking the "mutationLabel
    // never throws" contract `mutationLabel`'s own doc-comment relies on for the AI
    // recent-mutation log. Fall back to `'unknown'` for a missing/non-string `kind`/`id`
    // exactly as `apply` falls back to a no-op for the same malformed shape.
    label: (args) => {
      const widget = args.widget;
      const kind =
        isPlainRecord(widget) && typeof widget.kind === 'string' ? widget.kind : 'unknown';
      const id = isPlainRecord(widget) && typeof widget.id === 'string' ? widget.id : 'unknown';
      return `addWidget:${kind}:${id}`;
    },
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
      //
      // `isPlainRecord` (not bare truthiness — F2 finding): the sibling config channels
      // (`config`-patch above, `changes.config`/`applyBulkUpdate.updatedWidgets[].config`
      // below) all gate on `isPlainRecord`, but this bag was gated on `if (changes)` alone.
      // A truthy non-record `changes` (a string or array from a parser-bypassing
      // server-built mutation) is iterable via `Object.entries`, which produces
      // index-keyed junk properties (`"0"`, `"1"`, …) that would merge onto the widget
      // below. Treat a non-record `changes` as ABSENT, matching every other channel.
      if (isPlainRecord(changes)) {
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
          // `title`/`kind`/`subtitle`/`sourceId` must be a STRING (defense-in-depth,
          // mirroring the wire boundary's `isString(widget.kind)`/`isString(widget.title)`/
          // `isOptionalString(widget.subtitle)`/`isOptionalString(widget.sourceId)` gates in
          // `validateWidget`): `title`/`kind` are load-bearing with no fallback (the widget
          // factory/renderer key off `kind`, the canvas card renders `title`), and
          // `deserializeState` drops the ENTIRE widget on the NEXT load if either is
          // non-string. `subtitle` is rendered directly as text by
          // `StudioWidgetEditDialog` with no fallback, and `sourceId` drives the
          // widget-to-data-source lookup — a non-string value silently breaks that lookup
          // with no self-heal. Without this guard, a parser-bypassing `changes: { title: 42
          // }`/`{ subtitle: 42 }`/`{ sourceId: 42 }` would merge verbatim below and install
          // fine now, only to crash on render (`subtitle`) or silently misbehave
          // (`sourceId`) — or, for `title`/`kind`, vanish entirely the moment the doc is
          // next persisted and reloaded. Reject (skip) the field rather than let bad data
          // linger until (or past) the load boundary catches it.
          if (
            (key === 'title' || key === 'kind' || key === 'subtitle' || key === 'sourceId') &&
            typeof value !== 'string'
          ) {
            continue;
          }
          // `titleMode`/`subtitleMode` must be exactly `'auto'` or `'manual'`
          // (defense-in-depth, mirroring the wire boundary's `isOptionalTitleMode` gate in
          // `parseStateMutation.ts`, which only allows `'auto' | 'manual' | undefined`). The
          // load boundary (`deserializeState`) strips a non-`'auto'|'manual'` value from
          // these same two fields rather than let it load verbatim, since the client's
          // auto-title logic branches directly on `widget.titleMode`/`subtitleMode`. Without
          // this guard, a parser-bypassing `changes: { titleMode: 42 }` would merge verbatim
          // below and steer that logic until the value is stripped on the next load. Reject
          // (skip) the field rather than let bad data linger until the load boundary catches it.
          if (
            (key === 'titleMode' || key === 'subtitleMode') &&
            value !== 'auto' &&
            value !== 'manual'
          ) {
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
      // Kind-coherence reconciliation: `changes.kind` can flip a widget's `kind` (e.g.
      // chart → grid) with the config left as whatever the `config`-patch/`changes.config`
      // branches above produced — which may still carry the OLD kind's keys (e.g. a grid
      // widget left with a leftover chart-only `xField`), a config/kind mismatch nothing
      // downstream reconciles. Reuse `getAllowedConfigKeys` (`configKeyValidation.ts`) —
      // the same per-kind key allow-list `validateConfigKeysForKind`/`stripForeignFamilyKeys`
      // are built from — to strip any config key not valid for the NEW kind whenever the
      // kind actually changed. `null` means a custom/consumer-defined kind, which has no
      // built-in key restriction, so the config is left untouched for it.
      if (updated.kind !== existing.kind) {
        const allowedKeys = getAllowedConfigKeys(updated.kind);
        if (allowedKeys !== null) {
          const reconciledConfig: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(updated.config as Record<string, unknown>)) {
            if (allowedKeys.has(key)) {
              reconciledConfig[key] = value;
            }
          }
          updated = { ...updated, config: reconciledConfig as StudioWidget['config'] };
        }
      }
      // `unsetConfigKeys` — delete the named keys from the (post-merge) config.
      // The wire-safe equivalent of a `config`-patch `undefined` value: a key
      // NAME survives `JSON.stringify` where an `undefined` value is dropped.
      //
      // `isStringArray` (not bare truthiness — F3 finding): a truthy non-array STRING
      // (e.g. a parser-bypassing `unsetConfigKeys: 'title'`) is also truthy and has a
      // `.length`, so the old `unsetConfigKeys && unsetConfigKeys.length > 0` gate let it
      // through and `for (const key of unsetConfigKeys)` iterated it char-by-char,
      // deleting single-character config keys instead of the intended key name. An
      // array-like RECORD (`{ 0: 'a', length: 1 }`) is also truthy-with-`.length` but is
      // not iterable, so it threw `TypeError: … is not iterable`. `isStringArray`
      // rejects both, matching the wire boundary's own `isStringArray(args.unsetConfigKeys)`
      // check in `parseStateMutation.ts`.
      if (isStringArray(unsetConfigKeys) && unsetConfigKeys.length > 0) {
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
      //
      // `isStringArray` (not bare truthiness — F3 finding, same class as
      // `unsetConfigKeys` above): a truthy non-array string is iterable char-by-char and
      // an array-like record is not iterable at all; both would misbehave under the old
      // `unsetFields && unsetFields.length > 0` truthiness gate. `isStringArray` rejects
      // both.
      if (isStringArray(unsetFields) && unsetFields.length > 0) {
        const nextWidget = { ...updated } as Record<string, unknown>;
        let changedWidget = false;
        // Iterate as `string[]` (explicit cast): `isStringArray`'s `value is string[]`
        // predicate narrows `unsetFields` to `OptionalWidgetField[]` here (TS intersects
        // the guard's type with the pre-existing declared type, which excludes the
        // required `id`/`config`/`kind`/`title` members by construction), so the runtime
        // denylist comparisons below would otherwise be flagged as a compile-time-
        // impossible comparison. The comparisons ARE necessary at runtime: a value
        // arriving over the wire is not type-checked, so the denylist is load-bearing
        // for an untrusted payload that names one of those fields despite the type.
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
      // Require a STRING `widgetId` (parser-bypass parity with `addPage`/`addWidget`/
      // `setWidgetColSpan`'s `typeof id !== 'string'` guards): `Object.hasOwn` below
      // COERCES a numeric `widgetId` to match a string-keyed `state.widgets` entry, but
      // every downstream comparison in `stripWidgetIdsFromPages`/`removeWidgetIds`
      // (`Set.has`, `row.includes`) uses strict `===`/`Set` membership, which never
      // coerces. A numeric `widgetId` (e.g. `42`) would therefore pass the existence
      // check below (matching widget `"42"`) and get deleted from `state.widgets`, but
      // `new Set([42])` would miss every page reference and scoped-filter/span cleanup
      // keyed off the STRING id — a half-applied removal that orphans page references,
      // filters, and spans. No-op instead.
      if (typeof widgetId !== 'string') {
        return state;
      }
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
      // shared `removeWidgetIds` primitive below, on every page. `stripWidgetIdsFromPages`
      // is the shared (single-id-set-sized) implementation `applyBulkUpdate.removedWidgetIds`
      // also uses, so a single removal and a batch removal edit rows identically.
      const rowEditedPages = stripWidgetIdsFromPages(state.pages, new Set([widgetId]));

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
      // Require an array `rows` (T2-3). A parser-bypassing server-built `setWidgetLayout`
      // with `rows` absent/non-array would throw on the `args.rows.map(...)` below; no-op
      // instead, mirroring the wire boundary's `isStringMatrix(args.rows)` check.
      if (!Array.isArray(args.rows)) {
        return state;
      }
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
      // row it empties. `.filter((row): row is string[] => Array.isArray(row))` first
      // (mirroring `normalizePersistedPages`/`applyBulkUpdate`'s identical row-array
      // guard): `args.rows` is itself an array here, but a parser-bypassing server-built
      // mutation can still supply a non-array ROW ENTRY (e.g. `rows: ['w1']` or `rows:
      // [null]`), and `row.filter(...)` on a non-array row throws a `TypeError` instead
      // of the graceful no-op every sibling row-sanitizing site provides.
      // `typeof id === 'string'` BEFORE `Object.hasOwn` (T3 finding): `Object.hasOwn(obj,
      // key)` coerces a non-string `key` to a string when checking property existence, so a
      // parser-bypassing row entry carrying a NUMBER (e.g. `42`) would silently pass this
      // filter whenever `state.widgets` happens to have a widget keyed `"42"` — but the
      // NUMBER `42`, not the string `"42"`, is what lands in `sanitizedRows`, violating the
      // `string[][]` invariant every other row-processing site in this file assumes (a
      // `===` id comparison, a `Set<string>` membership check, or `JSON.stringify` round-trip
      // elsewhere would then silently miss it). Mirrors the same guard `normalizePersistedPages`
      // already applies to persisted rows.
      const sanitizedRows = dedupeLayoutRows(
        args.rows
          .filter((row): row is string[] => Array.isArray(row))
          .map((row) =>
            row.filter((id) => typeof id === 'string' && Object.hasOwn(state.widgets, id)),
          ),
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
      // Require a STRING `widgetId` (finding 2.1, parser-bypass parity with `addPage`/
      // `addWidget`'s `typeof id !== 'string'` guards): every downstream check below —
      // `Object.hasOwn(state.widgets, widgetId)`, `row.includes(widgetId)` against the
      // page's `string[][]` rows — either coerces its key to a STRING (`Object.hasOwn`)
      // or compares by strict `===` (`row.includes`, never coerces). A numeric
      // `widgetId` (e.g. `42`) would therefore fail EVERY `row.includes(42)` row-
      // membership check (since rows only ever hold strings) while still passing
      // `Object.hasOwn(state.widgets, 42)` whenever a widget `"42"` exists — exactly the
      // condition the "on another page" orphan-span guard below relies on `currentRow`
      // correctly reflecting, bypassing it and persisting a dead `widgetColSpans[42]`
      // entry (a `number`-keyed record property, coerced to `"42"` on write) on the
      // WRONG page. No-op instead.
      if (typeof widgetId !== 'string') {
        return state;
      }
      // Prototype-hazard guard before the `newSpans[widgetId] = clamped` bracket-write
      // below (Tier3/4 consistency finding), matching every other key-by-key rebuild in
      // this reducer (`updateWidget`/`applyBulkUpdate` inserts, the span rebuild). The
      // `Object.hasOwn(state.widgets, widgetId)` check below already rejects a `'__proto__'`
      // id in practice (no widget carries such an own key post-`addWidget` screen), but the
      // explicit guard keeps this bracket-write uniform with its siblings.
      if (!isSafePatchKey(widgetId)) {
        return state;
      }
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
      //
      // `Array.isArray(args.rowWidgetIds)` guards the fallback itself (finding 2.5
      // follow-up): the `?? [widgetId]` above only covers an ABSENT `rowWidgetIds`, but a
      // parser-bypassing partial payload can supply a truthy NON-array value (e.g. a
      // string), which would otherwise flow into `rowWidgetIds.filter(...)` below and
      // throw. Treat a non-array value the same as absent — fall back to `[widgetId]` —
      // rather than throwing mid-apply.
      const rowWidgetIds =
        currentRow ?? (Array.isArray(args.rowWidgetIds) ? args.rowWidgetIds : [widgetId]);
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
      // Require a STRING title (T3 finding, parser-bypass parity with the wire boundary's
      // `isString(args.title)` gate in `parseStateMutation.ts`, mirroring the `addPage` fix
      // above). Without this, a server-built `renamePage` bypassing the parser with a
      // non-string `title` would install it verbatim — no immediate throw, but a value that
      // violates `StudioDoc['pages'][string].title: string`, corrupting the page's title
      // until something downstream trips over the non-string value.
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
      // Require a STRING `pageId` (parser-bypass parity with `removeWidget`/`addPage`'s
      // `typeof id !== 'string'` guards): `Object.hasOwn` below COERCES a numeric
      // `pageId` to match a string-keyed `state.pages` entry, but the cleanup below
      // compares by strict `===` (`f.scope.pageId !== pageId`, `dashboard.activePageId
      // === pageId`), which never coerces. A numeric `pageId` would pass the existence
      // check (matching page `"42"`) and get the page deleted, but its page-scoped
      // filters would survive (the strict compare misses) and a dangling
      // `activePageId` would never be reassigned. No-op instead.
      if (typeof pageId !== 'string') {
        return state;
      }
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
      // Require a STRING `pageId` (parser-bypass parity with `removeWidget`/`removePage`'s
      // `typeof id !== 'string'` guards): `Object.hasOwn` below COERCES a numeric `pageId`
      // to match a string-keyed `state.pages` entry, so a numeric `pageId` (e.g. `42`)
      // would pass the existence check and get installed verbatim as
      // `dashboard.activePageId`, violating its `string` type. Unlike a numeric
      // `widgetId`/removed-page `pageId`, this one does NOT self-heal on
      // serialize/deserialize either (see `deserializeState`'s reconciliation) — no-op
      // instead of letting a numeric value linger indefinitely.
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

  addFilter: {
    apply: (state, args) => {
      // Require a record `filter` (T2-3). A parser-bypassing server-built `addFilter` with
      // `filter` absent/non-record would throw on the `args.filter.id` read below; no-op
      // instead, mirroring the wire boundary's `validateFilter` record check.
      if (!isPlainRecord(args.filter)) {
        return state;
      }
      // Require a record `scope` carrying a STRING `kind` (T3 finding, parser-bypass parity
      // with the wire boundary's `isValidFilterScope`/`validateFilterScope` gate in
      // `parseStateMutation.ts`). Without this, a server-built `addFilter` bypassing the
      // parser with `filter.scope` absent/non-record would throw reading `scope.kind` below
      // (`Cannot read properties of undefined (reading 'kind')`) instead of the graceful
      // no-op every sibling malformed-shape guard in this handler provides. This is a
      // crash-prevention shape check only (mirroring `migrateState`'s deliberately-weaker
      // scope gate) — full scope semantic validity (kind membership, required id fields) is
      // the wire boundary's job; the reducer only needs "safe to read `.kind` off of".
      if (!isPlainRecord(args.filter.scope) || typeof args.filter.scope.kind !== 'string') {
        return state;
      }
      // Require a STRING `filter.id` (parser-bypass parity with `removeWidget`/
      // `removePage`/`setActivePage`'s `typeof id !== 'string'` guards). Without this, a
      // numeric `filter.id` installs, but `removeFilter`'s strict `f.id !== filterId`
      // compare (never coerces) can never match it, making it unremovable in-session —
      // until the load boundary's non-string-id filter screen (`statePersistence.ts`)
      // silently drops the whole filter on the next load. No-op instead of installing.
      if (typeof args.filter.id !== 'string') {
        return state;
      }
      // Screen `field`/`operator`/`operator2` (Finding 2), parser-bypass parity with the
      // wire boundary's `validateFilter` gate in `parseStateMutation.ts`, which
      // membership-checks all three. Without this, a server-built `addFilter` bypassing
      // the parser with `field: 42` or an invalid `operator` installs VERBATIM, only for
      // the load boundary (`deserializeState`) to drop the WHOLE filter on the next load —
      // deferred silent data loss and, worse, a live filter whose junk `operator` steers
      // the client's evaluator until then. No-op instead of installing: `field` must be a
      // string, `operator` must be a valid `StudioFilterOperator`, and `operator2` — when
      // present — must be one too. Mirrors the load boundary's `isStudioFilterOperator`
      // check on these same fields.
      if (typeof args.filter.field !== 'string') {
        return state;
      }
      if (!isStudioFilterOperator(args.filter.operator)) {
        return state;
      }
      if (args.filter.operator2 !== undefined && !isStudioFilterOperator(args.filter.operator2)) {
        return state;
      }
      // Idempotent: re-delivery of the same addFilter SSE event must not append a
      // duplicate (unlike a fresh filter, the id already exists).
      if (state.filters.some((f) => f.id === args.filter.id)) {
        return state;
      }
      // Reject an ORPHAN scoped filter (finding 2.1 / T3-2): the cross-filter/interactive scopes
      // carry a `sourceWidgetId`, and the `widget` scope carries a `widgetId` — for all three,
      // the reducer's ONLY cleanup path (`dropWidgetScopedFilters`) fires when that anchor widget
      // is REMOVED. A filter naming an anchor widget the doc never had would therefore filter its
      // page forever with no clearing affordance — exactly the orphan state `deserializeState`
      // drops on load. Screen it here so the wire/reducer boundary and the load boundary agree.
      // "Existing widget" is the reducer's own notion — `Object.hasOwn(state.widgets, id)` —
      // matching every other id-keyed guard here (`updateWidget`/`removeWidget`), and an untrusted
      // id can't match a prototype member. No-op-return the input `state` reference, the dominant
      // convention for an unresolvable-target mutation in this reducer (`updateWidget`/
      // `removePage`/`setActivePage` unknown-id cases).
      const { scope } = args.filter;
      // Require the scope's own ANCHOR ids to be STRINGS before they are ever compared via
      // a coercing `Object.hasOwn(state.widgets/pages, …)` lookup below — the same
      // coercion-desync class Iteration 26 closed for `filter.id` above, one level down
      // inside the scope payload. Without this, e.g. a numeric `scope.sourceWidgetId: 9`
      // would pass `Object.hasOwn(state.widgets, 9)` (which coerces the key to `"9"`) and
      // install verbatim, while every downstream consumer that compares by strict `===`/
      // `Set` membership instead of `Object.hasOwn` (`dropWidgetScopedFilters`'s
      // `isRemoved(scope.sourceWidgetId)`, `removeWidgetIds`'s `stillReferenced` set) can
      // never match the numeric value — a half-applied orphan that survives every removal
      // path, exactly the class Iteration 26 closed for the mutation-level id.
      if (scope.kind === 'widget' && typeof scope.widgetId !== 'string') {
        return state;
      }
      if (
        (scope.kind === 'cross-filter' || scope.kind === 'interactive') &&
        typeof scope.sourceWidgetId !== 'string'
      ) {
        return state;
      }
      // `dashboard-date-range` scope's `pageId` is REQUIRED by the type
      // (`FILTER_SCOPE_REQUIRED_IDS` in `stateTypes.ts` lists `pageId` for it), so it must
      // be a STRING outright — reject a missing/non-string one (Finding 4). The previous
      // `scope.pageId !== undefined` exemption (borrowed from `page` scope's genuinely
      // OPTIONAL `pageId`) wrongly let a parser-bypassing `dashboard-date-range` filter
      // with NO `pageId` through, where it would then slip past the orphan check below
      // (also gated on `!== undefined`) and install anchored to nothing.
      if (scope.kind === 'dashboard-date-range' && typeof scope.pageId !== 'string') {
        return state;
      }
      // `page` scope's `pageId` is OPTIONAL (a legacy pageId-less filter applies on every
      // page), so only screen it for string-ness when present.
      if (scope.kind === 'page' && scope.pageId !== undefined && typeof scope.pageId !== 'string') {
        return state;
      }
      let orphanAnchorId: string | undefined;
      if (scope.kind === 'cross-filter' || scope.kind === 'interactive') {
        orphanAnchorId = scope.sourceWidgetId;
      } else if (scope.kind === 'widget') {
        orphanAnchorId = scope.widgetId;
      }
      if (orphanAnchorId !== undefined && !Object.hasOwn(state.widgets, orphanAnchorId)) {
        return state;
      }
      // Reject an ORPHAN `page`-scoped (or `dashboard-date-range`-scoped) filter naming a
      // `pageId` the doc doesn't contain — the PAGE-anchor mirror of the widget-anchor
      // orphan check just above. A `page`-scoped filter with an explicit `pageId` (the
      // legacy "applies on every page" shape has NO `pageId` and is left alone) would
      // otherwise filter a page that doesn't exist forever, with no clearing affordance.
      // `dashboard-date-range` scope (finding 2) carries a REQUIRED `pageId` — unlike
      // `page` scope's optional one, it always names one — so it is included in this same
      // check rather than a separate `scope.pageId !== undefined` gate. `removePage`'s
      // cleanup (`filtersAfterPageDrop`'s generic `'pageId' in f.scope` check) already
      // drops both scope kinds when their page is removed LIVE, but neither scope kind's
      // orphan-at-ADD-TIME case was screened here before this fix — a filter naming a
      // nonexistent page from the start would install and stay forever, never removed
      // (`removePage`'s cleanup only fires for a page that WAS present and got removed).
      // The load boundary (`deserializeState`'s `(scope.kind === 'page' || scope.kind ===
      // 'dashboard-date-range') … !Object.hasOwn(normalizedPages, scope.pageId)` screen)
      // already drops this on the NEXT load, so accepting it here would just be dead
      // weight until reload — screen it here so the wire/reducer boundary and the load
      // boundary agree. `Object.hasOwn` so an untrusted `pageId` can't match a prototype
      // member.
      if (
        (scope.kind === 'page' || scope.kind === 'dashboard-date-range') &&
        scope.pageId !== undefined &&
        !Object.hasOwn(state.pages, scope.pageId)
      ) {
        return state;
      }
      // Reject a SECOND rank-mode filter on the same page context (finding: the reducer
      // never enforced "at most one rank filter per page", even though `StudioController`
      // enforces it in FIVE separate call sites before ever calling this reducer — e.g.
      // `updateFilter`'s switch-to-rank guard, the widget-clone dedup). The controller's
      // guards are UI-layer conveniences, not the contract boundary; the reducer is the
      // single source of truth for mutation semantics, so a caller that skips (or a future
      // caller that never learns) the controller's check must still not be able to violate
      // the invariant. Mirrors `hasConflictingRankFilter`/`resolveRankFilterPageId` from
      // `@mui/x-studio`'s `internals/rankFilterScope.ts` (duplicated, not imported — see
      // this file's own copies above the `dropWidgetScopedFilters` helper). Only `page`/
      // `widget` scopes are rank-eligible (`resolveRankFilterPageId`'s doc comment: "other
      // scope kinds are never rank filters and are excluded by the caller") — the wire
      // boundary never restricts `filterMode` to a scope kind, so a `rank`-mode filter on
      // e.g. a `dashboard-date-range` scope is wire-valid and would otherwise resolve to a
      // `null` page context via `resolveRankFilterPageId`'s catch-all `return null`, which
      // conflicts with every other rank filter and would silently reject every legitimate
      // `page`/`widget` rank filter on every page thereafter. Skip the gate entirely for
      // any other scope kind, matching `hasConflictingRankFilter`'s own exclusion below.
      if (
        args.filter.filterMode === 'rank' &&
        (scope.kind === 'page' || scope.kind === 'widget') &&
        hasConflictingRankFilter(args.filter.id, args.filter, state.filters, state.pages)
      ) {
        return state;
      }
      // Strip unsafe own keys and repair a malformed `dependsOn` (F5 finding) BEFORE
      // the append — the filter otherwise carries its target scope/page verbatim
      // (chosen server-side), so it is NOT re-stamped with the applying side's active
      // page (that would reintroduce a page-targeting divergence). Both helpers are
      // reference-stable when the filter is already clean, so a well-formed filter
      // (the common case, and the only shape the wire boundary itself ever lets
      // through) still appends the SAME object.
      const safeFilter = repairFilterDependsOn(stripUnsafeFilterKeys(args.filter));
      return {
        ...state,
        filters: [...state.filters, safeFilter],
      };
    },
    // T3 finding (mirrors `addWidget`'s label fix above): `args.filter` is only guaranteed
    // to be a record by THIS handler's own `apply` guard, not by `mutationLabel`'s top-level
    // `isPlainRecord(mutation.args)` check — a server-built mutation bypassing
    // `parseStateMutation` with `args: { filter: undefined }` would otherwise throw reading
    // `args.filter.field`. Fall back to `'unknown'` for a missing/non-string `field`.
    label: (args) => {
      const { filter } = args;
      const field =
        isPlainRecord(filter) && typeof filter.field === 'string' ? filter.field : 'unknown';
      return `addFilter:${field}`;
    },
  },

  removeFilter: {
    apply: (state, args) => {
      const { filterId } = args;
      // Require a STRING `filterId` (parser-bypass parity with `removeWidget`/`removePage`'s
      // `typeof id !== 'string'` guards). The comparison below is a strict `===` that never
      // coerces, so a non-string `filterId` (e.g. `42`) simply never matches any `f.id` and
      // this is already a harmless no-op — but every other id-bearing handler in this file
      // guards explicitly rather than relying on that incidental behavior. No-op instead, for
      // uniformity with the sibling handlers.
      if (typeof filterId !== 'string') {
        return state;
      }
      const nextFilters = state.filters.filter((f: StudioFilterState) => f.id !== filterId);
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      // Cascade the removal to every remaining filter's `dependsOn` (Tier3 finding):
      // `StudioFilterState.dependsOn` (`stateTypes.ts`) lists OTHER filter ids this filter
      // cascades from — "purely a UX hint" per its own doc comment, but the client's cascade
      // drawer maps over it directly, so a dangling id left pointing at a just-removed filter
      // would silently point the UI at a filter that no longer exists. Drop the whole array
      // (rather than leave `dependsOn: []`) when the prune empties it, mirroring
      // `docTransforms.ts`'s own `remappedDependsOn.length > 0 ? … : undefined` convention for
      // this exact field, and `repairFilterDependsOn`'s "absent is the canonical empty state"
      // treatment. Reference-stable per-entry: a filter with no reference to the removed id
      // keeps its existing object identity.
      const prunedFilters = nextFilters.map((f) => {
        if (!f.dependsOn?.includes(filterId)) {
          return f;
        }
        const remainingDependsOn = f.dependsOn.filter((id) => id !== filterId);
        return {
          ...f,
          dependsOn: remainingDependsOn.length > 0 ? remainingDependsOn : undefined,
        };
      });
      return { ...state, filters: prunedFilters };
    },
    label: (args) => `removeFilter:${args.filterId}`,
  },

  applyBulkUpdate: {
    apply: (state, args) => {
      const { removedWidgetIds: rawRemovedWidgetIds, addedWidgets, updatedWidgets } = args;
      const { activePageId } = args;
      // Require a real ARRAY `removedWidgetIds` (T2-3, defense-in-depth copy of the wire
      // boundary's `isStringArray(args.removedWidgetIds)` check in `parseStateMutation.ts`):
      // `new Set(str)` iterates a STRING char-by-char, so a parser-bypassing server-built
      // mutation with `removedWidgetIds: 'w1'` would silently delete widgets literally named
      // `'w'` and `'1'` below instead of the intended widget `'w1'`. `Array.isArray` rejects a
      // non-array value outright — treated the same as an absent/empty list — rather than
      // iterating it.
      //
      // Also drop (not reject wholesale) any non-string ENTRY (finding 2.1): every downstream
      // consumer of this array — `removeWidgetIds`'s `stillReferenced` `Set<string>` membership
      // check, `stripWidgetIdsFromPages`'s per-row `Set<string>.has`, and the `Object.hasOwn`
      // lookups on `widgets`/`widgetColSpans` — either compares by strict `===` (never coerces)
      // or coerces its key to a STRING (`Object.hasOwn`). A numeric candidate like `42` would
      // therefore never match a `Set<string>` built from string row ids, yet WOULD match a
      // widget/span keyed `"42"` via `Object.hasOwn`'s coercion — the "genuinely gone" cross-page
      // guard silently bypassed, deleting a widget/span/filter still referenced (as a string) on
      // another page's rows. Filtering to `typeof id === 'string'` here (rather than rejecting the
      // whole array the way `isStringArray` would) keeps every well-formed id in a partially-junk
      // payload usable, matching this handler's own "no-op the bad, keep the good" convention for
      // `addedWidgets`/`updatedWidgets` entries elsewhere in this same handler.
      const removedWidgetIds = (
        Array.isArray(rawRemovedWidgetIds) ? rawRemovedWidgetIds : []
      ).filter((id): id is string => typeof id === 'string');

      // Require real ARRAYS for `addedWidgets`/`updatedWidgets` too (F3 finding, same
      // class as `removedWidgetIds` just above): both are typed as REQUIRED arrays on
      // the wire mutation, but every use below previously defaulted only with `?? []`
      // — which guards `null`/`undefined` but lets a TRUTHY non-array (e.g. a
      // parser-bypassing `addedWidgets: {}` or `updatedWidgets: 'junk'`) straight
      // through to a `for...of`, throwing `TypeError: … is not iterable` instead of the
      // graceful no-op every sibling malformed-shape guard in this handler provides.
      // Coerce once here so every downstream `for (const widget of addedWidgets ?? [])`
      // site below can read from the guaranteed-array `safeAddedWidgets`/
      // `safeUpdatedWidgets` instead.
      const safeAddedWidgets = Array.isArray(addedWidgets) ? addedWidgets : [];
      const safeUpdatedWidgets = Array.isArray(updatedWidgets) ? updatedWidgets : [];

      // Ids named in BOTH `removedWidgetIds` and `addedWidgets` in this SAME payload —
      // a remove+re-add of the same widget id, i.e. a "replace" (F4 finding), not a
      // genuine removal followed by an unrelated fresh insert. Computed ONCE, up front,
      // so every downstream step that used to treat this case inconsistently — the
      // active-page row pre-strip, the layout block's own row-placement exclusion, and
      // the `addedWidgets` insert loop's idempotent-add guard — agrees on the SAME
      // semantics regardless of whether this bulk also supplied `widgetRows`: the
      // widget's placement, cross-filters, and spans are preserved (by never actually
      // stripping its row / letting `removeWidgetIds`'s "stillReferenced" check see it
      // survive), and its definition (title/config) is updated to the new value.
      const removedWidgetIdSet = new Set(removedWidgetIds);
      const reAddedWidgetIds = new Set<string>();
      for (const widget of safeAddedWidgets) {
        if (
          isPlainRecord(widget) &&
          isSafePatchKey(widget.id) &&
          removedWidgetIdSet.has(widget.id)
        ) {
          reAddedWidgetIds.add(widget.id);
        }
      }

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
      //
      // Require a STRING `activePageId` (parser-bypass parity with the `typeof id !==
      // 'string'` guards other id-bearing handlers use, e.g. `addPage.id`,
      // `removeWidget.widgetId`): `Object.hasOwn` below COERCES a non-string
      // `activePageId` (e.g. `42`) to its string property key, which could coincidentally
      // match an existing page keyed `"42"`. Not independently exploitable here — every
      // downstream use of `activePageId` is itself gated on `pageExists`/`Object.hasOwn`
      // and it is never persisted to `dashboard.activePageId` — but requiring the type up
      // front keeps this handler uniform with the rest of the file's convention rather
      // than relying on incidental coercion behavior.
      const pageExists =
        typeof activePageId === 'string' && Object.hasOwn(state.pages, activePageId);
      // Strip `removedWidgetIds` from the ACTIVE page's rows FIRST, unconditionally —
      // not only when the producer also supplied `widgetRows` (finding: a bulk that
      // removes widgets but omits `widgetRows` — the common updates/removals-only case,
      // with no layout change at all — left the active page's OWN rows still naming a
      // widget THIS SAME mutation explicitly asked to remove; the "stillReferenced" check
      // `removeWidgetIds` runs below then saw it as still-live on the very page the
      // removal targeted and silently no-op'd the whole removal). Scoped to ONLY the
      // active page: a genuinely DIFFERENT page this bulk never touches that still
      // references the id is a deliberate cross-page-collision guard (`removeWidgetIds`'s
      // own "stillReferenced" check, exercised by the "does NOT remove a widget … that
      // still lives on another page" test) and must NOT be stripped here — only the page
      // this bulk actually targets gets its rows edited.
      //
      // EXCEPT an id also named in `reAddedWidgetIds` (F4 finding): stripping it here
      // UNCONDITIONALLY — regardless of `widgetRows` presence — is exactly the divergence
      // F4 closes. The `hasLayoutUpdate` block below already carried this same exception
      // for its OWN row-placement resolution (`validRowIds`), but this pre-strip (which
      // runs for EVERY bulk, including one that never enters that block) did not, so a
      // remove+re-add bulk WITHOUT `widgetRows` stripped the row here unconditionally,
      // making `removeWidgetIds` below see the widget as genuinely gone — deleting its
      // widget entry, filters, and spans — while the WITH-`widgetRows` branch preserved
      // them but then silently discarded the new definition (fixed separately in the
      // `addedWidgets` insert loop's idempotent-add guard). Leaving the row intact here
      // for a re-added id keeps both branches agreeing: placement/filters/spans survive.
      let layoutPages: StudioDoc['pages'] = state.pages;
      const idsToPreStrip = removedWidgetIds.filter((id) => !reAddedWidgetIds.has(id));
      if (pageExists && idsToPreStrip.length > 0) {
        const strippedActivePage = stripWidgetIdsFromPages(
          { [activePageId]: state.pages[activePageId] },
          new Set(idsToPreStrip),
        )[activePageId];
        // Finding 3.3: also prune each pre-stripped id's OWN `widgetColSpans` entry on
        // the active page. `stripWidgetIdsFromPages` only clears a SURVIVING row-mate's
        // now-stale span (the "orphaned sole occupant" case) — pruning the removed id's
        // OWN span entry is normally left to `removeWidgetIds`'s cross-page "genuinely
        // gone" check further below. But an id still referenced on ANOTHER page is NOT
        // genuinely gone, so that check never fires for it — leaving the id's own span
        // entry orphaned on THIS page, which it has already left (its row entry was
        // just stripped above), regardless of whether it survives doc-wide. Reuses
        // `removeSpanEntries` (reference-stable when nothing matched), so a bulk that
        // never actually touched this page's spans still returns the SAME page object.
        const spansPruned = removeSpanEntries(strippedActivePage.widgetColSpans, idsToPreStrip);
        const finalActivePage =
          spansPruned === strippedActivePage.widgetColSpans
            ? strippedActivePage
            : { ...strippedActivePage, widgetColSpans: spansPruned };
        if (finalActivePage !== state.pages[activePageId]) {
          layoutPages = { ...state.pages, [activePageId]: finalActivePage };
        }
      }
      if (pageExists && hasLayoutUpdate) {
        const page = layoutPages[activePageId];

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
        // Also allow this bulk's own `addedWidgets` ids: they are inserted below in the
        // same handler, so a producer-supplied row may legitimately reference a
        // not-yet-inserted added widget.
        for (const widget of safeAddedWidgets) {
          // Per-entry `isPlainRecord` skip (F3 finding): a `null`/primitive entry in
          // `addedWidgets` (e.g. from a parser-bypassing payload) would otherwise throw
          // reading `.id` below instead of being gracefully skipped, like every other
          // malformed-entry guard in this handler.
          if (isPlainRecord(widget) && typeof widget.id === 'string' && isSafePatchKey(widget.id)) {
            validRowIds.add(widget.id);
          }
        }
        // Exclude ids THIS SAME payload is removing (T2 finding): a bulk update naming
        // both `removedWidgetIds: ['w1']` and a `widgetRows` row still containing `'w1'`
        // must not keep that row entry alive — an explicit removal in the same mutation
        // takes precedence over a stale row the payload also happens to carry. The
        // current producer strips removed ids out of `widgetRows` before calling this,
        // but the reducer is the single source of truth for mutation validity and must
        // not depend on that caller discipline: a future/adversarial producer that
        // forgets to strip them must still see the removal honored.
        //
        // EXCEPT an id that is ALSO named in `addedWidgets` (finding 4, F4): a bulk that
        // removes and re-adds the SAME widget id in one payload (a reorder/replace) is
        // not "genuinely gone" — the widget survives this mutation under the same id, so
        // its row placement must survive too. Deleting it here unconditionally stripped
        // the row entry as a "phantom" BEFORE the re-add took effect, losing the widget's
        // placement to the bottom-row default-placement fallback further below. Reuses
        // the SHARED `reAddedWidgetIds` computed once at the top of this handler (F4
        // finding) — the pre-strip step above and the `addedWidgets` insert loop below
        // now agree on the exact same set, instead of each computing (or omitting) their
        // own notion of "re-added".
        for (const id of removedWidgetIds) {
          if (!reAddedWidgetIds.has(id)) {
            validRowIds.delete(id);
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
            .map((row) => row.filter((id) => typeof id === 'string' && validRowIds.has(id))),
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
            ...layoutPages,
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
      // widget the other page still renders — the guard the pre-strip above deliberately
      // leaves intact for every page except the active one). The primitive deletes
      // genuinely-removed ids from `state.widgets`, drops their widget/interactive/
      // cross-filter-scoped filters, and prunes their stale col-spans on every page.
      const {
        pages: nextPages,
        widgets: prunedWidgets,
        filters: nextFilters,
      } = removeWidgetIds(layoutPages, state.widgets, state.filters, removedWidgetIds);

      // Apply the add/update deltas on top of the pruned widgets — never a turn-start
      // snapshot — so any widget the user concurrently created or edited (on this page
      // or any other) while the agentic turn was running survives. Copy first, because
      // the primitive returns `state.widgets` by reference on a no-op removal.
      // `widgetsChanged` tracks whether the record actually diverged from `state.widgets`
      // (a removal, an accepted add, or an applied update), so a bulk that touches no
      // widget can return the SAME doc (reference-equality no-op contract).
      let widgetsChanged = prunedWidgets !== state.widgets;
      const nextWidgets = { ...prunedWidgets };
      // Ids this call genuinely inserted into `nextWidgets` (as opposed to an
      // idempotent-skipped re-delivery of an already-applied add) — the candidates for
      // the default row-placement step below. Tracked separately from `addedWidgets`
      // itself so a duplicate/idempotent entry is never re-placed onto a page (it may
      // have since been legitimately moved or removed by the user).
      const newlyInsertedWidgetIds: string[] = [];
      for (const widget of safeAddedWidgets) {
        // Require a plain-record entry (F3 finding): a `null`/primitive entry in
        // `addedWidgets` (e.g. from a parser-bypassing payload) would otherwise throw
        // reading `.id` below instead of being gracefully skipped, matching the
        // per-entry `isPlainRecord` guard `updatedWidgets` gets further down.
        if (!isPlainRecord(widget)) {
          continue;
        }
        // Require a STRING id (mirrors `addPage`/`addWidget`'s `typeof id !== 'string'`
        // guard): `isSafePatchKey` alone accepts any non-string (it only denies the
        // three string denylist members), so a hand-built `widget.id: 42` would install
        // under the STRINGIFIED key while `widget.id` itself stayed numeric — a
        // key/field desync identical to the one `addPage` already guards against.
        if (typeof widget.id !== 'string') {
          continue;
        }
        // `isSafePatchKey` before the bracket assignment (matching every other handler
        // and the `UNSAFE_KEYS` convention): `nextWidgets['__proto__'] = widget` would
        // re-prototype the record rather than add an own key. The wire path is already
        // shielded by `parseStateMutation`'s `isSafeId` check on `addedWidgets[].id`;
        // this is the defense-in-depth copy for a server-built mutation bypassing it.
        if (!isSafePatchKey(widget.id)) {
          continue;
        }
        // Require STRING `kind`/`title` (Finding 2 — the `addedWidgets` sibling of
        // `addWidget`'s identical guard above and `updatedWidgets`' `title` guard below,
        // mirroring the wire boundary's `isString(widget.kind)`/`isString(widget.title)`
        // checks in `validateWidget`). Without this, a parser-bypassing entry with e.g.
        // `kind: 42` installed verbatim now, only for `deserializeState`'s widget screen
        // to silently drop the ENTIRE widget on the very next load.
        if (typeof widget.kind !== 'string' || typeof widget.title !== 'string') {
          continue;
        }
        // Idempotent add: existence anywhere in `nextWidgets` means this widget was
        // already applied, so a re-delivery (an SSE at-least-once retry, or an AI retry
        // re-issuing the same bulk envelope) must be a no-op — mirrors `addWidget`'s
        // guard. Overwriting would revert a concurrent user edit to a widget this bulk
        // originally added. `Object.hasOwn` (not truthy access) so an untrusted id can't
        // match a prototype member.
        //
        // EXCEPT when this SAME payload also named `widget.id` in `removedWidgetIds`
        // (F4 finding, `isReplace`): that is a remove+re-add of the same id — a
        // "replace" — not a genuine idempotent re-delivery. The pre-strip/layout steps
        // above deliberately left this id's row (and hence its `removeWidgetIds`
        // "stillReferenced" status, filters, and spans) untouched precisely so the
        // widget's PLACEMENT survives; the widget's already-present entry in
        // `nextWidgets` is therefore still the OLD definition and must be overwritten
        // with the new one below, not skipped. Without this exception, a "replace" bulk
        // silently discarded the new title/config and became a placement-only no-op —
        // the exact divergence from the widgetRows-absent branch (which genuinely
        // deleted-then-reinserted, losing placement/filters/spans instead) that F4
        // closes by making both branches preserve placement/filters/spans AND apply the
        // new definition.
        const alreadyPresent = Object.hasOwn(nextWidgets, widget.id);
        const isReplace = reAddedWidgetIds.has(widget.id);
        if (alreadyPresent && !isReplace) {
          continue;
        }
        // Coerce a non-record `config` to `{}` BEFORE installing (T2-2), mirroring
        // `addWidget` and the load boundary — otherwise a hand-built `config: null`
        // added widget detonates on the next config-touching mutation.
        // Key-strip the optional scalars (`subtitle`/`sourceId`/`titleMode`/
        // `subtitleMode`) the wire boundary validates but this ADD channel didn't
        // (Finding 1) BEFORE installing, mirroring `addWidget` and the load boundary.
        const safeWidget = screenOptionalWidgetScalars(coerceWidgetConfig(widget));
        // Normalize the deprecated `seriesType` alias on write (reference-stable when
        // already canonical), so a bulk-added widget matches the load-boundary shape.
        const normalizedConfig = normalizeConfigChartSeries(safeWidget.config);
        nextWidgets[widget.id] =
          normalizedConfig === safeWidget.config
            ? safeWidget
            : ({ ...safeWidget, config: normalizedConfig } as StudioWidget);
        widgetsChanged = true;
        // Only a genuinely NEW entry (never present before this loop iteration) is a
        // candidate for the default row-placement step below — a "replace" already has
        // a preserved placement (F4), so pushing it here would be redundant (the
        // `referenced` filter in that step would exclude it anyway, but tracking it
        // accurately here keeps `newlyInsertedWidgetIds`'s name honest).
        if (!alreadyPresent) {
          newlyInsertedWidgetIds.push(widget.id);
        }
      }
      // Default row-placement for a newly-inserted widget the layout portion above
      // didn't already place (finding: when the bulk omits `widgetRows` — an
      // updates/adds-only batch, the common case for a producer that isn't also
      // touching layout — `hasLayoutUpdate` is `false` and the ENTIRE layout-replacement
      // block is skipped, so an added widget landed in `nextWidgets` but was never
      // appended to any page's rows: an orphan that exists but never renders anywhere).
      // Scoped to `pageExists` (the same active-page-existence guard the layout portion
      // uses) — if the target page was deleted mid-turn there is no sensible page to
      // default onto, so the widget stays in `nextWidgets` unplaced rather than
      // guessing a page, matching this handler's existing "apply the widget deltas even
      // when the page-scoped layout can't be" precedent.
      let placementPages = nextPages;
      if (newlyInsertedWidgetIds.length > 0 && pageExists) {
        const referenced = new Set<string>();
        for (const p of Object.values(nextPages)) {
          for (const row of p.widgetRows ?? []) {
            for (const id of row) {
              referenced.add(id);
            }
          }
        }
        // Only ids the producer's OWN `widgetRows` (when present) didn't already place
        // somewhere — a bulk that supplies both `addedWidgets` and a `widgetRows` naming
        // them is already handled by the layout-replacement block above and must not be
        // double-placed here (that would render the widget twice).
        const unplacedIds = newlyInsertedWidgetIds.filter((id) => !referenced.has(id));
        if (unplacedIds.length > 0) {
          const activePage = nextPages[activePageId];
          placementPages = {
            ...nextPages,
            [activePageId]: {
              ...activePage,
              widgetRows: [...(activePage.widgetRows ?? []), ...unplacedIds.map((id) => [id])],
            },
          };
        }
      }
      for (const update of safeUpdatedWidgets) {
        // Require a plain-record entry (F3 finding): a `null`/primitive entry in
        // `updatedWidgets` (e.g. from a parser-bypassing payload) would otherwise throw
        // reading `.widgetId` below instead of being gracefully skipped.
        if (!isPlainRecord(update)) {
          continue;
        }
        // Prototype-hazard guard before the `nextWidgets[update.widgetId] = patchedWidget`
        // bracket-write below (Tier3/4 consistency finding), keeping this write uniform with
        // every other key-by-key rebuild in the reducer. The `Object.hasOwn` existence check
        // just below already rejects an unsafe key in practice, but the explicit guard makes
        // the intent local to the write.
        if (!isSafePatchKey(update.widgetId)) {
          continue;
        }
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
        //
        // `typeof update.title === 'string'` (defense-in-depth, mirroring `updateWidget`'s
        // `changes.title`/`changes.kind` guard and the wire boundary's `isString(widget.title)`
        // gate): `title` is typed as `string | undefined` on the wire mutation, but a
        // parser-bypassing server-built bulk (the `executeToolOnState` pattern) can still
        // carry a non-string value, which would install verbatim here and then be dropped
        // — the WHOLE widget — by `deserializeState`'s non-string-title screen on the next
        // load. Skip a non-string value instead of merging it.
        if (
          update.title !== undefined &&
          typeof update.title === 'string' &&
          update.title !== existing.title
        ) {
          patchedWidget = { ...patchedWidget, title: update.title };
        }
        // `typeof update.sourceId === 'string'` (finding 3, the `sourceId` sibling of the
        // `title` guard just above): `sourceId` is typed as `string | undefined` on the
        // wire mutation, but a parser-bypassing server-built bulk can still carry a
        // non-string value. Unlike `title`, a junk `sourceId` is NOT caught by any load-
        // boundary screen (`deserializeState` drops the key gracefully rather than the
        // whole widget), so without this guard it would install verbatim and silently
        // break the widget-to-data-source lookup with no self-heal. Skip a non-string
        // value instead of merging it.
        if (
          update.sourceId !== undefined &&
          typeof update.sourceId === 'string' &&
          update.sourceId !== existing.sourceId
        ) {
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
      // `commitDocPatch`'s no-op guard skips a spurious undo entry. `placementPages`
      // (not `nextPages`) is the up-to-date pages reference — it equals `nextPages` by
      // identity unless the default-placement step above actually appended a row.
      if (!widgetsChanged && placementPages === state.pages && nextFilters === state.filters) {
        return state;
      }

      return {
        ...state,
        widgets: widgetsChanged ? nextWidgets : state.widgets,
        pages: placementPages,
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
      // Require STRING `name`/`updatedAt` (finding 2.2, parser-bypass parity with the
      // wire boundary's `isString(args.name)`/`isString(args.updatedAt)` gates in
      // `parseStateMutation.ts`). Without this, a server-built `renameAIThread`
      // bypassing the parser with a non-string `name`/`updatedAt` would install it
      // verbatim onto the thread — no immediate throw, but a value that violates the
      // thread's `name: string`/`updatedAt: string` shape, corrupting the thread entry
      // (the chat panel's thread selector renders `name` directly as text with no
      // fallback) until something downstream trips over the non-string value.
      if (typeof args.name !== 'string' || typeof args.updatedAt !== 'string') {
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
  // Totality guard before the `mutation.type` read below (T2 finding), the mutation-level
  // sibling of the `isPlainRecord(mutation.args)` gate further down. A server-built value
  // bypassing `parseStateMutation` (the `executeToolOnState` path) could hand a non-record
  // `mutation` (`null`, `undefined`, a primitive), on which `Object.hasOwn(…, mutation.type)`
  // throws. Gate it here so the reducer stays total and returns the documented no-op `doc`.
  if (!isPlainRecord(mutation)) {
    return doc;
  }
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
  if (!handler) {
    return doc;
  }
  // Every mutation's `args` is a record (each `StateMutation` variant types it as an object);
  // the wire boundary (`parseStateMutation`) enforces that. A server-built mutation bypassing
  // the parser (the `executeToolOnState` path) could hand a non-record `args` (`undefined`, a
  // primitive), on which every handler's first field read (`args.rows`, `args.widget`,
  // `args.filter`, …) throws. Gate it once here so the reducer stays TOTAL and returns the
  // documented no-op `doc` reference (T2-3), rather than repeating the guard in each handler.
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
 * Compact, human-readable label for a mutation, used for the AI recent-mutation
 * log (client-side undo/redo history label + MCP `get_recent_changes`).
 */
export function mutationLabel(mutation: StateMutation): string {
  // Totality guard before the `mutation.type` read below (T2 finding), the mutation-level
  // sibling of the `isPlainRecord(mutation.args)` gate below and matching `applyDocMutation`'s
  // own new mutation-level gate. A non-record `mutation` (`null`/primitive) would otherwise
  // throw on `Object.hasOwn(…, mutation.type)`, breaking the "mutationLabel never throws"
  // contract the AI recent-mutation log relies on. Fall back to a static `'unknown'` label
  // (there is no readable `type` to echo), mirroring the per-handler `'unknown'` fallbacks.
  if (!isPlainRecord(mutation)) {
    return 'unknown';
  }
  // `Object.hasOwn` before the bracket read (T2-1), same reasoning as `applyDocMutation`:
  // a `type` naming an `Object.prototype` member would otherwise resolve to a prototype
  // function and throw `handler.label is not a function` instead of returning the raw type
  // string the contract promises for an unrecognized `type`.
  const handler = Object.hasOwn(MUTATION_HANDLERS, mutation.type)
    ? (MUTATION_HANDLERS[mutation.type] as MutationHandler<StateMutation>)
    : undefined;
  // A non-record `args` (a parser-bypassing server-built mutation) would throw in the label
  // builders that reach into it (`addWidget:${args.widget.kind}`, `addFilter:${args.filter.field}`);
  // fall back to the raw type string, matching the unrecognized-`type` contract (T2-3).
  if (!handler || !isPlainRecord(mutation.args)) {
    return (mutation as { type: string }).type;
  }
  return handler.label(mutation.args);
}
