/**
 * The single semantic authority for applying a `StateMutation` to `StudioState`.
 *
 * Both transports use this pure reducer for the state-transformation step:
 *  - the AI middleware server computes `nextState = applyMutation(state, mutation)`
 *    in `executeToolOnState` (threading it to the model and, for MCP, to the state box);
 *  - the client applies the same function inside `StudioController.applyExternalMutation`
 *    when a `state-mutation` SSE event arrives.
 *
 * One implementation of every mutation's effect is what keeps the server-threaded state
 * and the client-applied state in agreement.
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
import {
  hasInvalidChartTypeInConfig,
  hasUnsafeOwnKeys,
  isStringArray,
  isValidFilterScope,
} from './parseStateMutation';
import { getAllowedConfigKeys } from './configKeyValidation';
import {
  isStudioFilterOperator,
  isTitleModeValue,
  REQUIRED_STUDIO_WIDGET_FIELDS,
  STUDIO_WIDGET_FIELDS,
} from './widgetTypeGuards';
// The optional-scalar screen is shared with the persistence load boundary — see
// `docScreening.ts`, which owns every per-entry screen a `StudioDoc` must pass.
import { hasResolvableFilterAnchors, screenOptionalWidgetScalars } from './docScreening';
// Rank-filter page-scope resolution and the per-page uniqueness sweep. These lived HERE until
// the factory (the fourth trust boundary) needed them too and could not import this module —
// `applyMutation.ts` imports `factories.ts`, so the arrow cannot run both ways. They now live
// in a dependency-free module all four boundaries can read; see `rankFilterScope.ts`.
import { dedupeRankFilters, hasConflictingRankFilter } from './rankFilterScope';
// The three guards the wire boundary (`parseStateMutation.ts`), the load boundary
// (`statePersistence.ts`) and this reducer all need, kept in `internalGuards.ts` as ONE
// implementation each so the three trust boundaries cannot drift apart:
//  - `isPlainRecord` — the shared "is this a usable record" predicate. A non-record
//    `config`/`widget`/`filter` (`null`, an array, or a truthy primitive like a string) is
//    treated as ABSENT, never as a record to merge or install.
//  - `stripUnsafeOwnKeys` (imported as `stripUnsafeConfigKeys`) — the record own-key
//    screen. Strips `__proto__`/`constructor`/`prototype` before a record is installed
//    WHOLESALE onto a widget, so it never round-trips as an own DATA property that later
//    poisons a spread or gets the whole widget dropped on the next load.
//  - `repairFilterDependsOn` — strips a malformed `dependsOn` from a filter about to be
//    installed verbatim, rather than sinking the whole filter.
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
 * correct single home for the constant — there is no cycle risk.
 *
 * The AI `set_widget_width` tool flows through the `setWidgetColSpan` handler
 * below, so it clamps and rebalances in the SAME 24-column unit system the canvas
 * uses; a mismatched unit system would let a user drag-resize and an AI resize
 * corrupt each other's layout.
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
function resolveTargetId(id: unknown, fallback: string | undefined): string | undefined {
  if (id === undefined || id === null) {
    return fallback;
  }
  return typeof id === 'string' ? id : undefined;
}

function resolveTargetPageId(doc: StudioDoc, pageId: unknown): string | undefined {
  return resolveTargetId(pageId, doc.dashboard.activePageId);
}

/**
 * The `ai.threads` counterpart of {@link resolveTargetPageId}, with the identical
 * three-state shape: nullish ⇒ the applying side's active thread (the legacy
 * threadId-less fallback), a `string` ⇒ that thread, anything else ⇒ `undefined` so the
 * caller no-ops.
 *
 * `renameAIThread` was the ONE handler of the fourteen missing the string-id rule: its
 * `args.threadId ?? state.ai.activeThreadId` accepts ANY non-nullish value, so a
 * `threadId: 42` neither fell back to the active thread nor matched any thread's string
 * `id` — a silent no-op that looked like a successful rename to the producer. Routing it
 * through this resolver makes the non-string case an explicit, documented no-op instead.
 */
function resolveTargetThreadId(ai: StudioDoc['ai'], threadId: unknown): string | undefined {
  return resolveTargetId(threadId, ai?.activeThreadId);
}

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
 * Value-equality for two whole widgets: every own top-level key compared by `===`, except
 * `config`, which is compared with the shared {@link shallowRecordEqual} core (the config
 * bag is rebuilt by `coerceWidgetConfig`/`normalizeConfigChartSeries` on every add, so it
 * is never reference-equal even when nothing changed).
 *
 * Used by `applyBulkUpdate`'s REPLACE branch to honor the reducer's reference-equality
 * no-op contract. That branch previously assigned the incoming widget with NO comparison
 * at all, so an at-least-once SSE re-delivery of a remove+re-add bulk flipped
 * `widgetsChanged` and pushed a phantom undo entry — the one add/update channel in this
 * file that did not value-compare first (`addWidget`'s idempotency guard, and the
 * `updatedWidgets` loop's per-field comparisons, both do).
 *
 * Shallow by design, matching `shallowRecordEqual`'s own contract: a re-delivery carries a
 * value-identical payload whose nested values are re-created by `JSON.parse`, so a nested
 * object compares unequal and the widget is (conservatively) treated as changed.
 */
function widgetsValueEqual(a: StudioWidget, b: StudioWidget): boolean {
  if (a === b) {
    return true;
  }
  const aRecord = a as unknown as Record<string, unknown>;
  const bRecord = b as unknown as Record<string, unknown>;
  const keysA = Object.keys(aRecord);
  if (keysA.length !== Object.keys(bRecord).length) {
    return false;
  }
  for (const key of keysA) {
    if (!Object.hasOwn(bRecord, key)) {
      return false;
    }
    if (key === 'config') {
      if (
        !isPlainRecord(aRecord.config) ||
        !isPlainRecord(bRecord.config) ||
        !shallowRecordEqual(aRecord.config, bRecord.config)
      ) {
        return false;
      }
    } else if (aRecord[key] !== bRecord[key]) {
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
 * `ySeries`, so the alias never survives a LIVE write (`updateWidget`/`addWidget`).
 * `deserializeState` normalizes at the load boundary only, so a widget written with
 * `seriesType` would otherwise keep the alias until the next reload. Reference-stable:
 * returns the SAME config when there is no `ySeries` or every entry is already canonical,
 * preserving the reducer's no-op detection. Runs across kinds by design (only chart
 * configs carry `ySeries`), reading the flat config shape.
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
 * Delete an INCOMING config's `chartType` when it is present but not a member of the closed
 * `StudioChartType` union, using the wire boundary's own `hasInvalidChartTypeInConfig`
 * predicate (`parseStateMutation.ts`) rather than a re-spelled copy.
 *
 * The reducer was the ONLY one of the four trust boundaries with no `chartType` membership
 * screen, so one payload got three different answers: the wire boundary REJECTED
 * `config: { chartType: 'trendline' }` / `{ chartType: 42 }`, this reducer installed it
 * VERBATIM, and the next `deserializeState` STRIPPED the key. That is the deferred-data-loss
 * class, not a cosmetic asymmetry — the widget renders blank, every later AI `update_widget`
 * hard-errors in `executeToolOnState` on the unknown stored chartType, and the widget then
 * silently becomes a bar chart on the next reload.
 *
 * Applied to the three UPDATE-shaped channels (`updateWidget`'s `config` patch and
 * `changes.config`, and `applyBulkUpdate.updatedWidgets[].config`) — exactly the three the
 * wire boundary routes through the same predicate. The two ADD channels get the equivalent
 * strip from the shared `screenOptionalWidgetScalars`, which is also the load boundary's own
 * screen, so all four boundaries now answer identically.
 *
 * `chartType: undefined` is left alone: in a patch it is the sanctioned delete of the key,
 * and in a wholesale replacement it resolves through `resolveChartType`'s `'bar'` default.
 * Reference-stable when there is nothing to strip.
 */
function stripInvalidChartType<C extends object>(config: C): C {
  if (!hasInvalidChartTypeInConfig(config as unknown as Record<string, unknown>)) {
    return config;
  }
  const next = { ...config } as Record<string, unknown>;
  delete next.chartType;
  return next as C;
}

/**
 * Strip prototype-polluting own keys (`__proto__`/`constructor`/`prototype`) from a
 * filter object `addFilter` appends to `state.filters` VERBATIM.
 *
 * The wire boundary (`parseStateMutation`'s `validateFilter`) rejects such a filter
 * outright via its own `hasUnsafeOwnKeys(filter)` check, but `addFilter` is also reachable
 * from a server-built mutation that bypasses the parser (the `executeToolOnState` path,
 * which every other ADD channel in this file — `addWidget`, `applyBulkUpdate.addedWidgets`
 * — defends against via `coerceWidgetConfig`/`stripUnsafeConfigKeys`). Such a filter would
 * otherwise install with an own `"__proto__"` key that round-trips through `serializeDoc`
 * and poisons the next `{ ...filter }` spread (e.g. `removeFilter`'s producer). Reuses the
 * exact `stripUnsafeConfigKeys` implementation — the check is identical whether the record
 * is a widget config or a filter. Reference-stable when the filter carries no unsafe own
 * key.
 */
function stripUnsafeFilterKeys(filter: StudioFilterState): StudioFilterState {
  const safe = stripUnsafeConfigKeys(filter as unknown as Record<string, unknown>);
  const safeFilter =
    safe === (filter as unknown as Record<string, unknown>)
      ? filter
      : (safe as unknown as StudioFilterState);
  // Descend into `scope`: it is a record nested one level inside `filter`, and every OTHER
  // nested record this reducer installs verbatim (a widget's `config` via
  // `coerceWidgetConfig`) gets the same strip. A scope carrying an own
  // `__proto__`/`constructor`/`prototype` key would otherwise append verbatim, round-trip
  // through `serializeDoc`, and later poison a spread of the scope object. Reference-stable
  // when `scope` is not a record (the crash-prevention shape guard in `addFilter.apply`
  // handles a non-record scope before this helper runs) or carries no unsafe key.
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

// Make a widget's `config` safe to STORE, for the two ADD channels (`addWidget`,
// `applyBulkUpdate.addedWidgets`). Two repairs, both mirroring the load boundary:
//
//  - a non-record `config` (e.g. `config: null` from a server-built mutation that bypassed
//    `parseStateMutation`) becomes `{}`. `normalizeConfigChartSeries` tolerates a non-record
//    config so the IMMEDIATE add doesn't throw, but storing `config: null` verbatim leaves a
//    landmine: the NEXT config-touching mutation does `Object.keys(existing.config)` /
//    `shallowRecordEqual(existing.config, …)` and throws `Cannot convert undefined or null
//    to object`.
//  - prototype-polluting own keys are stripped from a record config, the SAME key screen
//    `stripUnsafeConfigKeys` gives the two UPDATE channels. A server-built `addWidget`
//    bypassing the parser (reachable for a host-registered CUSTOM widget kind, whose
//    `validateConfigKeysForKind` imposes no key restriction) could otherwise install a
//    config carrying an own `"__proto__"` key, and the next `deserializeState` load drops
//    the ENTIRE widget on its config own-key screen — deferred silent data loss.
//
// Reference-stable when the config is already a record with no unsafe own key.
function coerceWidgetConfig(widget: StudioWidget): StudioWidget {
  const { config } = widget;
  if (!isPlainRecord(config)) {
    return { ...widget, config: {} } as StudioWidget;
  }
  const safeConfig = stripUnsafeConfigKeys(config);
  return safeConfig === config ? widget : ({ ...widget, config: safeConfig } as StudioWidget);
}

/**
 * Will `applyBulkUpdate`'s insert loop actually install this `addedWidgets` entry?
 *
 * The ONE acceptance test for that question, so the two blocks that must agree about it
 * cannot drift: the layout block's `validRowIds` population (which admits a not-yet-inserted
 * added widget's id into the sanitized rows) and the insert loop itself. The `validRowIds`
 * step runs FIRST and therefore PREDICTS the insert loop's verdict; every condition the
 * insert loop applies must live here or the prediction is wrong in exactly one direction —
 * a row installs naming a widget the insert loop then skips, which is the "page renders a
 * widget that does not exist" state `validRowIds` exists to prevent. It survives
 * `serializeDoc` and is healed only by `normalizePersistedPages` on the NEXT load.
 *
 * The conditions, and why each one costs the whole entry rather than a repaired key:
 *  - a non-record entry would throw on the `.id` read;
 *  - a non-string `id` would install under the STRINGIFIED bracket key while `widget.id`
 *    stayed numeric, desyncing the record key from the widget (see the string-id rule);
 *  - an unsafe `id` would re-prototype the record instead of adding an own key;
 *  - a non-string `kind`/`title` is dropped by `deserializeState`'s widget screen, which
 *    drops the ENTIRE widget — so installing one just defers the loss to the next load.
 *
 * Same screens `addWidget` applies to its single widget, in the same order.
 */
function isInsertableAddedWidget(widget: unknown): widget is StudioWidget {
  return (
    isPlainRecord(widget) &&
    // Screen the WIDGET OBJECT's own top-level keys against the prototype-hazard
    // denylist, symmetric with the wire boundary's `hasUnsafeOwnKeys(widget)` rejection
    // in `validateWidget` and the load boundary's `screenWidgets`. A
    // `JSON.parse`-built widget from a server-built mutation that bypasses
    // `parseStateMutation` can materialize a real own `"__proto__"` DATA property (an
    // object literal never would); installing it verbatim would round-trip through
    // `serializeDoc` only to be dropped wholesale by `deserializeState`'s widget screen
    // on the next load — deferred data loss. Drop the whole widget rather than strip
    // and keep, matching this predicate's other required-field checks below.
    !hasUnsafeOwnKeys(widget) &&
    typeof widget.id === 'string' &&
    isSafePatchKey(widget.id) &&
    typeof widget.kind === 'string' &&
    typeof widget.title === 'string'
  );
}

// Drop widget/interactive/cross-filter-scoped filters anchored to any removed widget.
// Shared by `removeWidget` and `applyBulkUpdate` so both enforce the same invariant: a
// removed source widget must not leave its page permanently filtered with no clearing
// affordance. Returns the same array reference when nothing is dropped, preserving the
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
 * The `StudioWidget` fields an `updateWidget.args.changes` bag may merge onto a widget —
 * every non-`id` field of `StudioWidgetOf` (`widgetTypes.ts`).
 *
 * Fail-closed: a key outside this set is never merged. No boundary downstream would ever
 * strip it — the wire boundary tolerates unknown keys BY POLICY (forward compatibility with
 * a newer server's additive field) and `deserializeState` does not screen unknown widget
 * keys either — so `changes: { evil: { a: 1 }, widgetRows: 'x' }` would otherwise land on
 * the widget and round-trip through `serializeDoc` forever. This also makes the patch
 * channel symmetric with the `config` channel one level down, which is fail-closed via
 * `validateConfigKeysForKind`.
 *
 * Scoped to the PATCH channel only. The full-widget CREATE channels
 * (`addWidget`/`applyBulkUpdate.addedWidgets`) install a whole `StudioWidget` and keep their
 * unknown-key tolerance, which is where the forward-compatibility argument applies: an older
 * client receiving a newer server's widget must not silently strip a field it does not yet
 * know about. A patch bag has no such round-trip to preserve.
 *
 * A `Set` (not an array/object literal) so an untrusted key can never resolve up a
 * prototype chain.
 *
 * DERIVED from the compile-locked `STUDIO_WIDGET_FIELDS` (`widgetTypeGuards.ts`) rather
 * than re-listed by hand. Re-listing is what made this the sharpest of the five unlocked
 * `StudioWidgetOf` enumerations: adding a field to the interface compiled cleanly while
 * `updateWidget` silently no-opped on it forever (the `.has(key)` test below is `false`),
 * with nothing failing to compile and no runtime error to notice.
 */
const MERGEABLE_WIDGET_CHANGE_KEYS: ReadonlySet<string> = new Set<string>(
  STUDIO_WIDGET_FIELDS.filter((field) => field !== 'id'),
);

/**
 * The REQUIRED `StudioWidget` fields, as a `Set` for the `unsetFields` denylist — the
 * mirror image of {@link MERGEABLE_WIDGET_CHANGE_KEYS}, derived from the SAME compile-locked
 * tuples so the two can never disagree about which fields exist. A `Set` (not a chain of
 * `!==` comparisons) so an untrusted key can never resolve up a prototype chain.
 */
const REQUIRED_WIDGET_FIELD_SET: ReadonlySet<string> = new Set<string>(
  REQUIRED_STUDIO_WIDGET_FIELDS,
);

/**
 * Drop every `dependsOn` id that no longer names a surviving filter.
 *
 * `StudioFilterState.dependsOn` (`stateTypes.ts`) lists OTHER filter ids this filter
 * cascades from — "purely a UX hint" per its own doc comment, but the client's cascade
 * drawer maps over it directly, so a dangling id left pointing at a filter that is gone
 * silently gates option-narrowing on a filter that no longer exists.
 *
 * The ONE implementation of that referential-integrity invariant, so every path that drops a filter
 * enforces it — in BOTH packages. In this one: `removeFilter`, `dropWidgetScopedFilters` via
 * `removeWidget`/`applyBulkUpdate`, `removePage`'s page-anchor drop, the layout handlers' rank
 * sweep, and — via `statePersistence.ts`'s import — the load boundary's filter screen and rank
 * dedup plus `serializeDoc`'s session-scope strip. In `@mui/x-studio`, whose filter drops bypass
 * this reducer entirely and commit through `commitDocPatch`: `StudioController`'s
 * `clearPageFilters`/`clearCrossFilter`/ `clearAllCrossFilters`/`clearInteractiveFilter` and
 * `docTransforms`' `applyFilterPreset`/`setDashboardDateRange`/`setDashboardDateRangeAll`/
 * `setWidgetDateRange`, which reach it through {@link pruneDependsOnAgainstSelf} on the package
 * index (before that, those eight left the LIVE doc carrying dangling ids that only `serializeDoc`
 * pruned, so the in-memory cascade and the saved one disagreed until the next reload).
 *
 * Drops the whole `dependsOn` array (rather than leaving `dependsOn: []`) when the prune
 * empties it, mirroring `docTransforms.ts`'s own `remappedDependsOn.length > 0 ? … :
 * undefined` convention for this exact field and `repairFilterDependsOn`'s "absent is the
 * canonical empty state" treatment. "Drops" means the KEY is `delete`d, not set to
 * `undefined` — see the comment at the site. Reference-stable at BOTH levels: the SAME array is
 * returned when nothing needed pruning, and a filter with no dangling reference keeps its
 * existing object identity.
 */
export function pruneDependsOn(
  filters: StudioFilterState[],
  survivingIds: ReadonlySet<string>,
): StudioFilterState[] {
  let changed = false;
  const next = filters.map((f) => {
    if (!f.dependsOn?.some((id) => !survivingIds.has(id))) {
      return f;
    }
    changed = true;
    const remainingDependsOn = f.dependsOn.filter((id) => survivingIds.has(id));
    if (remainingDependsOn.length > 0) {
      return { ...f, dependsOn: remainingDependsOn };
    }
    // DELETE the key rather than writing `dependsOn: undefined`. Spreading an explicit
    // `undefined` leaves the key present as an own property, so `Object.keys(filter)` and
    // `'dependsOn' in filter` both still report it and the in-memory shape differs from a
    // filter that never carried one — the same distinction `deserializeState`'s
    // `activeThreadId` reconciliation deliberately preserves with its own `delete`. Nothing
    // observes the difference today only because `JSON.stringify` erases it at the
    // persistence boundary.
    const pruned = { ...f };
    delete pruned.dependsOn;
    return pruned;
  });
  return changed ? next : filters;
}

/**
 * {@link pruneDependsOn} against the ids `filters` itself still carries — the shape every
 * "some filters were just dropped from this array" call site wants. Kept as a separate
 * tiny wrapper so the primitive keeps its explicit surviving-id-set signature (which the
 * load boundary needs, since it prunes against a set it computes itself).
 *
 * Exported (and re-exported from the package index) because `@mui/x-studio`'s eight
 * non-reducer filter-drop paths need exactly this shape — see {@link pruneDependsOn}.
 * Reference-stable: returns the SAME array when nothing dangled, so a caller's
 * identity-preservation guard is unaffected.
 */
export function pruneDependsOnAgainstSelf(filters: StudioFilterState[]): StudioFilterState[] {
  return pruneDependsOn(filters, new Set(filters.map((f) => f.id)));
}

/**
 * Rebuild a page with `overrides` applied and its `widgetColSpans` set to `spans` — or,
 * when `spans` is `undefined`, with the KEY DELETED rather than written as an explicit
 * `undefined`.
 *
 * The ONE implementation of that convention for `widgetColSpans`, shared by every site
 * that installs a span map (`stripWidgetIdsFromPages`, `removeWidgetIds`,
 * `normalizePersistedPages`, `setWidgetLayout`, `setWidgetColSpan`, `applyBulkUpdate`).
 * `removeSpanEntries` and `enforceLayoutColSpans` both correctly COLLAPSE an emptied map
 * to `undefined`, but their callers then re-materialized it as an own key via
 * `{ ...page, widgetColSpans: nextSpans }` — contradicting this file's own stated rule
 * (see {@link pruneDependsOn}: "'Drops' means the KEY is `delete`d … not spread as an
 * explicit `undefined`"), so `Object.keys(page)` and `'widgetColSpans' in page` both still
 * reported a span map on a page that has none. Nothing observes the difference today only
 * because `JSON.stringify` erases it at the persistence boundary.
 */
function withSpans(
  page: StudioDoc['pages'][string],
  spans: Record<string, number> | undefined,
  overrides?: Partial<StudioDoc['pages'][string]>,
): StudioDoc['pages'][string] {
  const next = { ...page, ...overrides };
  if (spans === undefined) {
    delete next.widgetColSpans;
  } else {
    next.widgetColSpans = spans;
  }
  return next;
}

/**
 * Strip every id in `idsToRemove` from every page's `widgetRows`, dropping any row
 * left empty and clearing the stale span of a former row-mate a removal leaves as
 * the SOLE occupant of a row it used to share (that survivor's stored span is a
 * multi-widget-era leftover — mirrors `enforceLayoutColSpans`'s 2→1 collapse). A
 * pre-existing single-widget-row span is untouched (only a row that shrank FROM 2+
 * TO 1 because of this removal counts).
 *
 * Takes an id SET rather than a single id so `removeWidget` and
 * `applyBulkUpdate.removedWidgetIds` share the identical row-placement cleanup. Both must
 * run it: `removeWidgetIds`' "genuinely gone" check below reads the rows, so a removal
 * target still named on some page's rows would be classified as still-live and silently
 * survive.
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
    return [pid, withSpans(page, nextSpans, { widgetRows: newRows })] as const;
  });
  return anyPageChanged ? (Object.fromEntries(nextEntries) as StudioDoc['pages']) : pages;
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
function dropConflictingRankFilters(
  filters: StudioFilterState[],
  pages: StudioDoc['pages'],
): StudioFilterState[] {
  const { filters: kept, changed } = dedupeRankFilters(filters, pages);
  return changed ? pruneDependsOnAgainstSelf(kept) : filters;
}

/**
 * Remove the given widget ids' entries from a page's `widgetColSpans`, collapsing
 * an emptied map to `undefined`. Returns the same reference when no entry matched
 * (so callers can skip rebuilding the page). `ids` is looked up via a `Set` so an
 * untrusted id (`'constructor'`, `'__proto__'`) can never reach into the record's
 * prototype chain. Shared by `removeWidget` (its own span + orphaned sole-occupant
 * spans) and `applyBulkUpdate` (removed widgets' stale spans on other pages).
 *
 * The rebuild also screens each surviving KEY with `isSafePatchKey`, the way every other
 * key-by-key `Record` rebuild in this package does (`normalizePersistedPages`' span
 * rebuild, `applyBulkUpdate`'s `clampedSpans`, `updateWidget`'s config patch loop,
 * `stripUnsafeOwnKeys`). Defense in depth rather than a live vector: the one producer of
 * an unscreened `pages` map is the public `Studio initialState` prop, which
 * `createDefaultStudioState({ doc: { pages } })` installs verbatim, and a `__proto__` span
 * key from there would be copied into a fresh record by `rest[key] = …` — re-prototyping it
 * instead of adding an own key.
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
    if (idSet.has(key) || !isSafePatchKey(key)) {
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
 * Decides whether a span may be persisted for one row member.
 *
 * Named rather than inlined in `rebalanceRowSpans`' signature so its own parameter is
 * documented here, on the callback, instead of being attributed to the enclosing function.
 *
 * @param id A row member whose span is about to be written.
 * @returns `true` when that id is a real widget safe to persist a span for.
 */
type CanWriteSpan = (id: string) => boolean;

/**
 * Fit ONE layout row's column spans inside `GRID_COLS`, in place, around the spans a
 * mutation explicitly asked for.
 *
 * `anchorIds` are the row members whose span this mutation is setting; every other member
 * of `rowIds` is an ABSORBER whose stored span may be reduced or cleared to make room. The
 * resolution, in order:
 *
 *  - **anchors overflow on their own** (a payload naming several widths in one row that sum
 *    past `GRID_COLS`): grant each anchor, in row order, as much of the row budget as is
 *    left, and clear the span of any anchor that cannot be granted at least `MIN_SPAN`.
 *  - **exactly one absorber**: it takes the remainder, or loses its span entirely when the
 *    remainder is below `MIN_SPAN` (a sub-minimum span is not a legal width).
 *  - **two or more absorbers**: there is no non-arbitrary way to split the remainder
 *    between them, so all their spans are cleared and the row falls back to equal flex for
 *    them.
 *
 * A span is only ever WRITTEN for an id `canWriteSpan` accepts, so a row-mate that is not a
 * real widget (or carries a prototype-hazard key) can never receive a persisted span.
 *
 * Shared by the two write paths that set a widget's width — `setWidgetColSpan` and
 * `applyBulkUpdate`'s col-spans merge — so an AI `set_widget_width` and an
 * `apply_bulk_update` carrying the same width resolve a row overflow identically. Without
 * it the bulk path fell through to `enforceLayoutColSpans`' drop-EVERY-span-in-the-row
 * rule, which discards the widths of widgets the payload never mentioned.
 */
function rebalanceRowSpans(
  spans: Record<string, number>,
  rowIds: readonly string[],
  anchorIds: ReadonlySet<string>,
  canWriteSpan: CanWriteSpan,
): void {
  // `Object.hasOwn` per id (not `spans[id] ?? 0`) so an untrusted row id reads 0, never an
  // `Object` prototype member (which would poison the sums below with `NaN`).
  const readSpan = (id: string) => (Object.hasOwn(spans, id) ? spans[id] : 0);
  const anchorRowIds = rowIds.filter((id) => anchorIds.has(id));
  const absorberIds = rowIds.filter((id) => !anchorIds.has(id));
  let anchorTotal = anchorRowIds.reduce((sum, id) => sum + readSpan(id), 0);
  if (anchorTotal > GRID_COLS) {
    let budget = GRID_COLS;
    for (const id of anchorRowIds) {
      const granted = Math.min(readSpan(id), budget);
      if (granted >= MIN_SPAN && canWriteSpan(id)) {
        spans[id] = granted;
        budget -= granted;
      } else {
        delete spans[id];
      }
    }
    anchorTotal = GRID_COLS - budget;
  }
  const absorberTotal = absorberIds.reduce((sum, id) => sum + readSpan(id), 0);
  if (anchorTotal + absorberTotal <= GRID_COLS) {
    return;
  }
  const remaining = GRID_COLS - anchorTotal;
  if (absorberIds.length === 1 && remaining >= MIN_SPAN) {
    if (canWriteSpan(absorberIds[0])) {
      spans[absorberIds[0]] = remaining;
    }
    return;
  }
  for (const id of absorberIds) {
    delete spans[id];
  }
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

  setDashboardTitle: {
    apply: (state, args) => {
      // Require a STRING title: `StudioDoc['dashboard'].title` is `string` and the
      // page-header renderer reads it directly, so a non-string value corrupts the title
      // until something downstream trips over it.
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
      // Crash prevention: the `widget.id` read below throws on an absent/non-record widget.
      if (!isPlainRecord(widget)) {
        return state;
      }
      // Screen the widget object's OWN top-level keys against the prototype-hazard
      // denylist, symmetric with `isInsertableAddedWidget` (the same test
      // `applyBulkUpdate.addedWidgets` applies) and with the wire/load boundaries'
      // `hasUnsafeOwnKeys(widget)` rejections (`validateWidget`, `screenWidgets` — Finding
      // A `JSON.parse`-built widget from a server-built mutation that bypasses
      // `parseStateMutation` can materialize a real own `"__proto__"` DATA property; the
      // literal inserts below use define-semantics so there is no IMMEDIATE pollution
      // risk, but installing such a widget verbatim would round-trip through
      // `serializeDoc` only to be dropped wholesale by `deserializeState`'s widget screen
      // on the next load — deferred data loss, not a crash. Drop the whole widget rather
      // than strip and keep, matching the missing-required-field checks below.
      if (hasUnsafeOwnKeys(widget)) {
        return state;
      }
      // Require a STRING id. `isSafePatchKey` alone accepts any non-string (it only denies
      // three string denylist members), so `widget.id: 42` would install under the
      // STRINGIFIED key `"42"` while `widget.id` itself stayed numeric — a map-key/field
      // desync that splits every id-keyed invariant.
      if (typeof widget.id !== 'string') {
        return state;
      }
      // Screen the widget id against the prototype-hazard denylist. The literal inserts
      // below use define-semantics so there is no pollution risk, but a `'__proto__'` id
      // would create a real own entry the load-boundary key screen drops on the next load.
      if (!isSafePatchKey(widget.id)) {
        return state;
      }
      // Require STRING `kind`/`title`: the widget factory/renderer keys off `kind` and the
      // canvas card renders `title`, and `deserializeState`'s widget screen drops the ENTIRE
      // widget on the next load if either is non-string.
      if (typeof widget.kind !== 'string' || typeof widget.title !== 'string') {
        return state;
      }
      // Explicit, server-chosen target page — falls back to the active page for legacy
      // payloads. Targeting an explicit page, rather than whatever page happens to be active
      // on the applying side, is what keeps the server-threaded and client-applied results
      // pointing at the same page.
      // Resolved through the shared helper, so a NON-STRING explicit `pageId` no-ops rather
      // than reaching the coercing `Object.hasOwn` below (string-id rule).
      const pageId = resolveTargetPageId(state, args.pageId);
      // `Object.hasOwn` existence check (not truthy `state.pages[pageId]`) so an
      // untrusted `pageId` like `'constructor'` resolves to "no such page" instead
      // of the `Object` prototype member (which would be treated as a page object).
      if (pageId === undefined || !Object.hasOwn(state.pages, pageId)) {
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
      // Repair the widget BEFORE installing: `coerceWidgetConfig` makes a non-record config
      // safe to store and strips unsafe own keys from it; `screenOptionalWidgetScalars`
      // drops an invalid `subtitle`/`sourceId`/`titleMode`/`subtitleMode`. Both mirror the
      // load boundary, so nothing installs here only to be dropped on the next load.
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
    // `mutationLabel` guards only the TOP-LEVEL `args` record, not `args.widget`, so a
    // malformed `args: { widget: undefined }` reaches here. Fall back to `'unknown'` for a
    // missing/non-string `kind`/`id` — the same graceful degradation `apply` gives the same
    // shape, and what the "mutationLabel never throws" contract requires.
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
      // Require a STRING `widgetId` BEFORE the coercing existence check (string-id rule).
      // Every write this handler performs happens to be a bracket assignment through the
      // same coerced key `Object.hasOwn` matched, so a numeric `42` is benign TODAY — but
      // that is a property of the current body, not a guarantee, and the guard is what stops
      // one added non-coercing comparison from silently splitting read and write the way it
      // did for `removeWidget`/`removePage`/`setWidgetColSpan`.
      if (typeof widgetId !== 'string') {
        return state;
      }
      // `Object.hasOwn` (not truthy `state.widgets[widgetId]`) so an untrusted
      // `widgetId` like `'constructor'` is a clean "unknown id" no-op rather than
      // resolving to the `Object` prototype member and corrupting a write.
      if (!Object.hasOwn(state.widgets, widgetId)) {
        return state;
      }
      const existing = state.widgets[widgetId];
      let updated: StudioWidget = existing;
      // The config keys THIS mutation installs, collected across BOTH config-touching
      // paths (the `config` patch loop and a wholesale `changes.config`) so the
      // kind-coherence step below can screen them against the FINAL `updated.kind`
      // — a kind this handler may not know yet while those paths run, because
      // `changes.kind` is merged after the patch. Screening only the INCOMING keys
      // (rather than the whole config) is what keeps the pre-existing
      // retention-across-chartType-switch keys a stored config legitimately carries
      // (see `StudioChartConfig`'s doc) untouched by an unrelated edit.
      const incomingConfigKeys = new Set<string>();
      // Order of operations (documented, load-bearing): config patch → changes
      // merge → config-key unsets → field unsets. Unsets are applied LAST so an
      // explicit clear always wins over a set of the same key in the same mutation.
      //
      // `config` is a partial config patch (mirrors `updateWidgetConfig`):
      // keys with an `undefined` value are removed.
      //
      // Require a record: a non-record `config` (`null`, an array, or a primitive) is
      // treated as ABSENT rather than applied. `Object.entries(null)` throws, and
      // `Object.entries([...])` would merge index keys ("0", "1", …) into the widget's live
      // config. Every config channel in this file gates on `isPlainRecord` the same way.
      if (isPlainRecord(config)) {
        // Normalize the deprecated `seriesType` alias on the incoming patch's
        // `ySeries` to canonical `type`, so the alias never survives a live write
        // (it is otherwise only normalized at the load boundary in
        // `deserializeState`). Scoped to the patch — a pre-existing alias the patch
        // doesn't touch is left as-is so a no-op patch stays a no-op.
        // …and drop an unknown `chartType` from the patch, the same membership screen the
        // wire boundary applies to this exact channel (see `stripInvalidChartType`). Scoped
        // to the PATCH, so a pre-existing stored `chartType` the patch doesn't name is left
        // for the load boundary — the reducer only refuses to INSTALL a new bad one.
        const patch = stripInvalidChartType(normalizeConfigChartSeries(config));
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
            continue;
          }
          // Every non-deleting key this patch names is INCOMING for the kind-coherence
          // screen below — including one re-set to its CURRENT value. On an
          // at-least-once re-delivery of a kind-flipping mutation the key is already
          // installed, so counting only the keys that CHANGED is exactly what let a
          // foreign key survive the second delivery permanently.
          incomingConfigKeys.add(key);
          if (!Object.hasOwn(nextConfig, key) || nextConfig[key] !== value) {
            nextConfig[key] = value;
            changedConfig = true;
          }
        }
        if (changedConfig) {
          updated = { ...updated, config: nextConfig as StudioWidget['config'] };
        }
      }
      // `changes` is a shallow merge onto the widget (it may itself carry a full `config`
      // object, which replaces the partial-merge result above — matching the client's
      // dispatch order). Keys whose value is `undefined` are skipped so a caller cannot void
      // a required field (e.g. `changes: { title: undefined }`) through the shallow merge;
      // the sanctioned way to void a field is `unsetFields`/`unsetConfigKeys` below, which
      // survive JSON (an `undefined` value never does).
      //
      // `isPlainRecord`, not bare truthiness: a truthy non-record `changes` (a string or
      // array) is still iterable via `Object.entries`, which produces index-keyed junk
      // properties (`"0"`, `"1"`, …) that would merge onto the widget. A non-record `changes`
      // is ABSENT, matching every other channel in this file.
      if (isPlainRecord(changes)) {
        const definedChanges: Record<string, unknown> = {};
        const updatedRecord = updated as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(changes)) {
          // Skip unsafe keys (the spread below copies own props only, so this is a latent
          // rather than live pollution vector) and `undefined` values. Also skip `id`: it is
          // the `state.widgets` map key, so a `changes.id` would desync `widget.id` from its
          // key and split every id-keyed invariant — matching the `unsetFields` `id` denylist.
          if (key === 'id' || !isSafePatchKey(key) || value === undefined) {
            continue;
          }
          // Fail-closed allow-list: only a real, mergeable `StudioWidget` field lands on the
          // widget. See {@link MERGEABLE_WIDGET_CHANGE_KEYS}. `id` is denied above (it is the
          // map key), so it is deliberately absent from the set rather than filtered twice.
          if (!MERGEABLE_WIDGET_CHANGE_KEYS.has(key)) {
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
            // `isPlainRecord(value)`: `changes: { config: null }` would otherwise assign
            // `config = null` and corrupt the widget, and `changes: { config: [...] }` would
            // install the array AS the widget's `config` (both `normalizeConfigChartSeries`
            // and `shallowRecordEqual` are array-tolerant). A non-record value is ignored.
            if (isPlainRecord(value)) {
              // Strip prototype-polluting own keys before installing wholesale — the same
              // screen the `config`-patch loop applies per-key. An unsafe key surviving as an
              // own config property makes the next load drop the whole widget.
              const safeValue = stripUnsafeConfigKeys(value as Record<string, unknown>);
              // …and drop an unknown `chartType`, the same membership screen the wire
              // boundary applies to this exact channel (see `stripInvalidChartType`).
              const normalized = stripInvalidChartType(normalizeConfigChartSeries(safeValue));
              // Every key of a wholesale replacement is INCOMING for the kind-coherence
              // screen below, whether or not the replacement differs by value from the
              // config it replaces — same reasoning as the patch loop above.
              for (const configKey of Object.keys(normalized)) {
                incomingConfigKeys.add(configKey);
              }
              if (!shallowRecordEqual(updated.config as Record<string, unknown>, normalized)) {
                definedChanges.config = normalized;
              }
            }
            continue;
          }
          // `title`/`kind`/`subtitle`/`sourceId` must be a STRING. Each is consumed with no
          // fallback: the widget factory/renderer keys off `kind`, the canvas card renders
          // `title`, `StudioWidgetEditDialog` renders `subtitle` directly as text, and
          // `sourceId` drives the widget-to-data-source lookup. `deserializeState` drops the
          // ENTIRE widget on the next load for a non-string `title`/`kind`, and never
          // repairs `sourceId` at all. Skip the field rather than merge a bad value.
          if (
            (key === 'title' || key === 'kind' || key === 'subtitle' || key === 'sourceId') &&
            typeof value !== 'string'
          ) {
            continue;
          }
          // `titleMode`/`subtitleMode` must be exactly `'auto'` or `'manual'`: the client's
          // auto-title logic branches directly on them, and `deserializeState` strips any
          // other value on the next load. Skip the field rather than steer that logic with a
          // value the load boundary will discard anyway.
          if ((key === 'titleMode' || key === 'subtitleMode') && !isTitleModeValue(value)) {
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
      // Kind-coherence reconciliation. `changes.kind` can flip a widget's `kind` (e.g.
      // chart → grid) while the config keeps whatever the branches above produced, which may
      // still carry the OLD kind's keys (a grid widget left with a chart-only `xField`) —
      // a config/kind mismatch nothing downstream reconciles (`screenWidgets` does no
      // per-kind key check, and `serializeDoc` persists it forever). Strips the offending
      // config keys using `getAllowedConfigKeys` (`configKeyValidation.ts`), the same
      // per-kind allow-list `validateConfigKeysForKind`/`stripForeignFamilyKeys` are built
      // from. `null` means a custom/consumer-defined kind, which has no built-in key
      // restriction, so its config is left untouched.
      //
      // IDEMPOTENCY IS WHY THIS IS NOT GATED ON `updated.kind !== existing.kind`. It used to
      // be, and the gate made one mutation that BOTH flips `kind` and supplies a config
      // non-idempotent in the worst direction: the first delivery stripped the config keys
      // the branches above had just installed, so the SECOND delivery — where `kind` no
      // longer changes and the gate is false — installed those same foreign keys
      // PERMANENTLY. Both `{ changes: { kind }, config }` and
      // `{ changes: { kind, config } }` reproduce it, and both pass `parseStateMutation`. SSE
      // is at-least-once (see this file's header), so the client-applied doc diverged from
      // the server-threaded one and landed in exactly the mismatch this step exists to
      // prevent.
      //
      // The two screens differ in SCOPE, and deliberately:
      //  - `kind` changed ⇒ screen the WHOLE config. Keys authored under the old kind are
      //    all foreign now, whether or not this mutation touched them.
      //  - `kind` unchanged ⇒ screen only the keys THIS mutation named
      //    (`incomingConfigKeys`). A stored config legitimately carries keys retained
      //    across a chartType switch (see `StudioChartConfig`'s doc, and the wire boundary's
      //    matching "preserve, never strip" stance), so an unrelated edit must not sweep
      //    them — but it must not INSTALL a fresh foreign one either.
      //
      // `isPlainRecord` guard: a live widget whose `config` is not a record (never produced
      // by the add channels, which run `coerceWidgetConfig`, but reachable for a doc built
      // outside them) would otherwise THROW here on `Object.keys(null)` — and a boundary
      // must repair or no-op, never throw.
      const allowedKeys = getAllowedConfigKeys(updated.kind);
      if (allowedKeys !== null && isPlainRecord(updated.config)) {
        const currentConfig = updated.config as Record<string, unknown>;
        const keysToScreen =
          updated.kind !== existing.kind ? Object.keys(currentConfig) : incomingConfigKeys;
        const foreignKeys: string[] = [];
        for (const key of keysToScreen) {
          if (!allowedKeys.has(key) && Object.hasOwn(currentConfig, key)) {
            foreignKeys.push(key);
          }
        }
        if (foreignKeys.length > 0) {
          const reconciledConfig = { ...currentConfig };
          for (const key of foreignKeys) {
            delete reconciledConfig[key];
          }
          updated = { ...updated, config: reconciledConfig as StudioWidget['config'] };
        }
      }
      // `unsetConfigKeys` — delete the named keys from the (post-merge) config.
      // The wire-safe equivalent of a `config`-patch `undefined` value: a key
      // NAME survives `JSON.stringify` where an `undefined` value is dropped.
      //
      // `isStringArray`, not bare truthiness: a non-array STRING (`unsetConfigKeys: 'title'`)
      // is truthy and has a `.length`, and `for…of` iterates it char-by-char — deleting
      // single-character config keys instead of the intended name. An array-like RECORD
      // (`{ 0: 'a', length: 1 }`) is truthy-with-`.length` but not iterable at all, and
      // throws. `isStringArray` rejects both.
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
      // `isStringArray`, not bare truthiness — same reasoning as `unsetConfigKeys` above.
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
        //
        // The denylist is `REQUIRED_STUDIO_WIDGET_FIELDS` (`widgetTypeGuards.ts`), DERIVED
        // as `STUDIO_WIDGET_FIELDS` minus `OPTIONAL_STUDIO_WIDGET_FIELDS` and compile-locked
        // for completeness, rather than the four names re-spelled here: a field that becomes
        // required must not silently stay unsettable.
        for (const key of unsetFields as string[]) {
          if (!REQUIRED_WIDGET_FIELD_SET.has(key) && Object.hasOwn(nextWidget, key)) {
            delete nextWidget[key];
            changedWidget = true;
          }
        }
        if (changedWidget) {
          updated = nextWidget as unknown as StudioWidget;
        }
      }
      // No-op check: if no branch above changed the widget (an empty or identical-value
      // config patch, an unset of absent keys, …), return the SAME state reference so
      // `commitDocPatch`'s no-op guard skips pushing an undo entry.
      //
      // A VALUE comparison (`widgetsValueEqual`, the same helper
      // `applyBulkUpdate.addedWidgets` uses for its replace path), not the bare
      // `updated === existing` this used to be. The branches above can each rewrap the
      // widget and then have their effect undone by a LATER branch in the same mutation —
      // the kind-coherence screen stripping exactly the config key the patch loop just
      // installed is the canonical case — leaving a fresh, value-identical object. That
      // returned a new doc reference for a mutation that changed nothing, so an
      // at-least-once SSE re-delivery pushed a phantom undo entry, violating this file's
      // reference-equality no-op contract ("EVERY handler returns its input reference
      // unchanged when nothing changed"). Shallow by design, matching every other
      // value-compare in this file: a re-delivery whose nested config value is re-created
      // by `JSON.parse` compares unequal and is conservatively treated as a change.
      if (widgetsValueEqual(updated, existing)) {
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
      // Require a STRING `widgetId` (id-coercion desync): a numeric `42` would pass the
      // `Object.hasOwn` existence check below (matching widget `"42"`) and get deleted from
      // `state.widgets`, while `new Set([42])` missed every page reference, scoped filter and
      // span keyed off the STRING id — a half-applied removal leaving all three orphaned.
      if (typeof widgetId !== 'string') {
        return state;
      }
      // `Object.hasOwn` (not truthy `state.widgets[widgetId]`) so an untrusted
      // `widgetId` like `'constructor'`/`'__proto__'` is a clean no-op instead of
      // matching a prototype member and deleting/cleaning against a phantom widget.
      if (!Object.hasOwn(state.widgets, widgetId)) {
        return state;
      }

      // Row-edit step: strip the widget from every page's rows (dropping an emptied row),
      // and clear the stale span of a former row-mate this removal leaves as the SOLE
      // occupant of the row they shared — that widget now auto-fills the row, so its
      // multi-widget-era span is dead. Deliberately scoped: a pre-existing single-widget-row
      // span (e.g. an AI `set_widget_width` narrowing a lone widget) is intentional and
      // survives. The removed widget's OWN stale spans are pruned by `removeWidgetIds` below,
      // on every page. `stripWidgetIdsFromPages` is shared with
      // `applyBulkUpdate.removedWidgetIds`, so a single removal and a batch removal edit rows
      // identically.
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
      // Crash prevention: the `args.rows.map(...)` below throws on an absent/non-array value.
      if (!Array.isArray(args.rows)) {
        return state;
      }
      // Explicit, server-chosen target page — falls back to the active page for
      // legacy payloads, mirroring `addWidget.pageId`.
      const targetPageId = resolveTargetPageId(state, args.pageId);
      // `Object.hasOwn` guard (not truthy `state.pages[targetPageId]`) so an
      // untrusted `pageId` can't resolve to a prototype member; `undefined` is the shared
      // resolver's "explicit but non-string `pageId`" no-op (string-id rule).
      if (targetPageId === undefined || !Object.hasOwn(state.pages, targetPageId)) {
        return state;
      }
      const targetPage = state.pages[targetPageId];
      const currentRows = targetPage.widgetRows ?? [];
      // Sanitize the producer-supplied rows, three screens in one pass (the same shape
      // `normalizePersistedPages` and `applyBulkUpdate` apply to their own rows):
      //  - `Array.isArray(row)` — `args.rows` is an array here, but a ROW ENTRY can still be
      //    a non-array (`rows: ['w1']`, `rows: [null]`), on which `row.filter(...)` throws.
      //  - `typeof id === 'string'` BEFORE `Object.hasOwn` — `Object.hasOwn` coerces its key,
      //    so a NUMBER row entry `42` would pass whenever a widget `"42"` exists and land in
      //    `sanitizedRows` as a number, violating the `string[][]` invariant every other
      //    row-processing site assumes (`===`, `Set<string>`, JSON round-trips all miss it).
      //  - `Object.hasOwn(state.widgets, id)` — a phantom id would leave the page rendering
      //    a widget that does not exist.
      // `dedupeLayoutRows` then drops a repeated id (first occurrence wins) and any row it
      // empties: the same id twice renders the widget twice (duplicate React key) and
      // double-counts its span in the overflow sum below.
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
      // so `commitDocPatch`'s no-op guard skips a spurious undo entry. Rank-filter
      // resolution depends only on row membership, so unchanged rows also mean unchanged
      // rank conflicts — nothing for the sweep below to find.
      if (
        rowsEqual(currentRows, sanitizedRows) &&
        spansEqual(nextSpans, targetPage.widgetColSpans)
      ) {
        return state;
      }
      const nextPages = {
        ...state.pages,
        [targetPageId]: withSpans(targetPage, nextSpans, { widgetRows: sanitizedRows }),
      };
      // Re-check per-page rank-filter uniqueness against the NEW placement: placing a
      // widget whose `widget`-scoped rank filter previously resolved to nothing can drop it
      // onto a page that already has one. Enforcing it here keeps the live doc and the load
      // boundary in agreement at commit time — see `dropConflictingRankFilters`.
      return {
        ...state,
        pages: nextPages,
        filters: dropConflictingRankFilters(state.filters, nextPages),
      };
    },
    label: () => 'setWidgetLayout',
  },

  setWidgetColSpan: {
    apply: (state, args) => {
      const { widgetId, columns } = args;
      // Require a STRING `widgetId`. Every check below either coerces its key to a STRING
      // (`Object.hasOwn(state.widgets, widgetId)`) or compares by strict `===`
      // (`row.includes(widgetId)` against the page's `string[][]` rows, which never
      // coerces). A numeric `widgetId` (e.g. `42`) would therefore match widget `"42"` in
      // the flat map while failing every row-membership check — bypassing the placement
      // guard below and persisting a dead `widgetColSpans[42]` entry on the wrong page.
      if (typeof widgetId !== 'string') {
        return state;
      }
      // Prototype-hazard guard before the `newSpans[widgetId] = clamped` bracket-write
      // below, matching every other key-by-key rebuild in this reducer. The
      // `Object.hasOwn(state.widgets, widgetId)` check below already rejects a
      // `'__proto__'` id in practice (no widget carries such an own key past the
      // `addWidget` screen); this keeps the intent local to the write.
      if (!isSafePatchKey(widgetId)) {
        return state;
      }
      // Explicit, server-chosen target page — falls back to the active page for
      // legacy payloads, mirroring `addWidget.pageId`.
      const targetPageId = resolveTargetPageId(state, args.pageId);
      // `Object.hasOwn` guard (not truthy `state.pages[targetPageId]`) so an
      // untrusted `pageId` can't resolve to a prototype member; `undefined` is the shared
      // resolver's "explicit but non-string `pageId`" no-op (string-id rule).
      if (targetPageId === undefined || !Object.hasOwn(state.pages, targetPageId)) {
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
      // The producer (`executeToolOnState`'s `set_widget_width`) computes `rowWidgetIds`
      // from the server's turn-start snapshot; if the user drags widgets between rows on
      // the client while an agentic turn is still running, that wire-supplied grouping
      // goes stale, and rebalancing/clearing spans against it would touch widgets that no
      // longer share this widget's row. Same stale-snapshot class the explicit `pageId`
      // arg addresses for page targeting.
      const currentRow = (targetPage.widgetRows ?? []).find((row) => row.includes(widgetId));
      // A span only means something for a widget this page's rows actually hold. Two ways
      // `currentRow` comes back `undefined`, and both must be a no-op:
      //  - the widget lives on ANOTHER page (a legacy payload without `pageId` applied
      //    while the user is on a different page, or a server-stamped `pageId` racing a
      //    concurrent move) — writing here would persist a dead entry on the wrong page;
      //  - the widget is on NO page at all (not yet placed) — a span written for it is an
      //    orphan by the SAME rule `enforceLayoutColSpans` and `normalizePersistedPages`
      //    both enforce, so it would be deleted by the next layout mutation or the next
      //    load, silently reverting the width the caller just set.
      // `args.rowWidgetIds` is therefore never consulted: the live rows are the only
      // membership signal this handler trusts.
      if (currentRow === undefined) {
        return state;
      }
      const clamped = columns == null ? null : clampSpan(columns);
      const newSpans: Record<string, number> = { ...(targetPage.widgetColSpans ?? {}) };

      if (clamped == null) {
        delete newSpans[widgetId];
      } else {
        newSpans[widgetId] = clamped;
        // Fit the row around the requested width via the shared helper — the same step
        // `applyBulkUpdate`'s col-spans merge runs, so `set_widget_width` and
        // `apply_bulk_update` resolve an overflowing row identically.
        rebalanceRowSpans(
          newSpans,
          currentRow,
          new Set([widgetId]),
          (id) => Object.hasOwn(state.widgets, id) && isSafePatchKey(id),
        );
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
          [targetPageId]: withSpans(targetPage, finalSpans),
        },
      };
    },
    label: (args) => `setWidgetColSpan:${args.widgetId}`,
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

  addFilter: {
    apply: (state, args) => {
      // Crash prevention: the `args.filter.id` read below throws on an absent/non-record
      // filter.
      if (!isPlainRecord(args.filter)) {
        return state;
      }
      // Crash prevention for the `scope` reads below. Only "is this a record" here; full
      // scope WELLFORMEDNESS is checked once, against the stripped scope, further down via
      // the shared `isValidFilterScope`.
      if (!isPlainRecord(args.filter.scope)) {
        return state;
      }
      // Require a STRING `filter.id` (id-coercion desync): a numeric id installs, but
      // `removeFilter`'s strict `f.id !== filterId` compare never matches it, making the
      // filter unremovable in-session — until the load boundary's non-string-id screen drops
      // the whole filter on the next load.
      if (typeof args.filter.id !== 'string') {
        return state;
      }
      // Screen `field`/`operator`/`operator2`: `field` must be a string and both operators
      // must be valid `StudioFilterOperator`s. A junk `operator` steers the client's
      // evaluator live, and the load boundary drops the WHOLE filter for either — so
      // accepting one here just defers the loss to the next reload.
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
      // ── Scope screening, in two stages ───────────────────────────────────────────────
      // Stage 1 — WELLFORMEDNESS, delegated to `isValidFilterScope`, the SAME predicate the
      // wire boundary (`validateFilterScope`) and the load boundary (`deserializeState`'s
      // filter screen) already use. Hand-rolling a per-kind id check here is what let the
      // three boundaries disagree: this handler once screened only `typeof scope.kind ===
      // 'string'`, so a `{ kind: 'pages' }` (any unknown kind) or a `dashboard-date-range`
      // missing its REQUIRED `sourceId` installed live, and then either escaped every
      // cleanup path forever (all of `dropWidgetScopedFilters`, `removePage`'s page-anchor
      // drop and `removeWidgetIds` key off the five KNOWN kinds) or was silently dropped by
      // this very predicate on the next load. Both are the deferred-data-loss class the
      // "all three boundaries must agree on the same payload" rule exists to prevent, and
      // both are reachable without the parser — `executeToolOnState.ts` builds mutations
      // straight from LLM tool arguments, and `StudioController.addFilter` commits straight
      // to this reducer. The shared predicate covers kind membership, every required id
      // field per kind (`FILTER_SCOPE_REQUIRED_IDS` in `parseStateMutation.ts`), `page`
      // scope's genuinely OPTIONAL `pageId` (string when present), the scope's own
      // prototype-hazard key screen, and the size bound.
      //
      // Run against the STRIPPED filter, not `args.filter`: a scope carrying an own
      // `__proto__`/`constructor`/`prototype` key is REPAIRED (the key removed) rather than
      // sinking the whole add — the strip-don't-drop response this handler has always given
      // that shape — and the wellformedness check then runs on exactly the object that will
      // be installed. Both repairs are reference-stable, so a well-formed wire-validated
      // filter is still appended as the SAME object.
      const safeFilter = repairFilterDependsOn(stripUnsafeFilterKeys(args.filter));
      const { scope } = safeFilter;
      if (!isValidFilterScope(scope)) {
        return state;
      }
      // Stage 2 — EXISTENCE, delegated to the shared `hasResolvableFilterAnchors`. What the
      // wire boundary structurally cannot check: it validates a payload in isolation and has
      // no doc to look ids up in. It lives in `docScreening.ts` rather than inline here so the
      // OTHER writer that installs a scope — `@mui/x-studio`'s `StudioController.updateFilter`,
      // which re-points an existing filter's scope through `commitDocPatch` and never reaches
      // this reducer — enforces the identical rule instead of accepting an orphan live and
      // losing the whole filter on the next load. See that function for the full
      // rationale (widget anchor, page anchor, why an unresolvable one is unclearable dead
      // weight, and why `page` scope's optional `pageId` is exempt).
      if (!hasResolvableFilterAnchors(scope, state)) {
        return state;
      }
      // Reject a SECOND rank-mode filter on the same page context. `StudioController`
      // enforces "at most one rank filter per page" at five call sites before ever reaching
      // this reducer, but those are UI-layer conveniences, not the contract boundary — the
      // reducer is the single source of truth for mutation semantics, so a caller that skips
      // the controller's check still must not be able to violate the invariant.
      //
      // Gated to `page`/`widget` scopes, the only rank-eligible kinds. A `rank`-mode filter
      // on e.g. a `dashboard-date-range` scope is wire-valid (the wire boundary never
      // restricts `filterMode` to a scope kind) but is not a rank window over a page, so it
      // is neither gated here nor counted as a conflict by `hasConflictingRankFilter`.
      // The scope clause is therefore REDUNDANT with that callee (which returns false for an
      // unresolvable target) rather than load-bearing — it is kept, like the mirroring clause
      // in `dedupeRankFilters`, as a local statement of the eligibility rule.
      //
      // This gate resolves the incoming filter's page context ONCE, at add time. A
      // `widget`-scoped filter whose widget is unplaced has no page context yet and is
      // accepted; the layout handlers re-run the sweep when a placement gives it one — see
      // {@link dropConflictingRankFilters}.
      if (
        safeFilter.filterMode === 'rank' &&
        (scope.kind === 'page' || scope.kind === 'widget') &&
        hasConflictingRankFilter(safeFilter.id, safeFilter, state.filters, state.pages)
      ) {
        return state;
      }
      // Append the (already stripped/repaired) filter. It otherwise appends VERBATIM: its
      // target scope/page was chosen server-side and is deliberately NOT re-stamped with the
      // applying side's active page, which would reintroduce a page-targeting divergence.
      return {
        ...state,
        filters: [...state.filters, safeFilter],
      };
    },
    // `mutationLabel` guards only the TOP-LEVEL `args` record, not `args.filter` (same as
    // `addWidget`'s label above), so fall back to `'unknown'` for a missing/non-string
    // `field` rather than throwing.
    label: (args) => {
      const { filter } = args;
      const field =
        isPlainRecord(filter) && typeof filter.field === 'string' ? filter.field : 'unknown';
      return `addFilter:${field}`;
    },
  },

  /*
   * ── The client-only filter writes ──────────────────────────────────────────────────────
   *
   * Six writes `@mui/x-studio`'s controller performed through `commitDocPatch`, outside the
   * reducer, each therefore outside the `dependsOn` cascade every reducer-routed drop path
   * enforces. That is not hypothetical: eight client filter-drop paths were found re-persisting
   * dangling `dependsOn` references, and the cascade helper had to be PUBLISHED from this
   * package so those paths could re-implement by hand what routing here would have given them.
   *
   * They live on `InternalStateMutation`, so `parseStateMutation` has no validator entry for
   * them and a server cannot make a client apply one. The reducer owns the write; the wire
   * still cannot reach it.
   */
  clearPageFilters: {
    apply: (state, args) => {
      const { pageId } = args;
      if (typeof pageId !== 'string') {
        return state;
      }
      // Retention predicate, identical to `docTransforms.applyFilterPreset`'s: everything not
      // page-scoped, every LEGACY pageId-less page filter (`scope: { kind: 'page' }` with no
      // `pageId`, predating the per-page scope model — `selectFiltersForWidget`'s `!sv2.pageId`
      // branch and `filterScoping.ts` both treat those as applying to EVERY page), and every page
      // filter belonging to another page.
      //
      // Regression note: this once retained only page filters whose `pageId` was BOTH set and
      // different. An all-pages filter satisfied neither disjunct, so "Clear all" on ONE page
      // deleted it from the doc entirely and silently un-filtered every OTHER page too. Clearing
      // one page's filters must never touch an all-pages filter's effect on the rest of the
      // dashboard.
      const nextFilters = state.filters.filter(
        (f: StudioFilterState) => !(f.scope.kind === 'page' && f.scope.pageId === pageId),
      );
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      return { ...state, filters: pruneDependsOnAgainstSelf(nextFilters) };
    },
    label: (args) => `clearPageFilters:${args.pageId}`,
  },
  clearCrossFilter: {
    apply: (state, args) => {
      const { sourceWidgetId } = args;
      if (typeof sourceWidgetId !== 'string') {
        return state;
      }
      const nextFilters = state.filters.filter(
        (f: StudioFilterState) =>
          !(f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === sourceWidgetId),
      );
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      return { ...state, filters: pruneDependsOnAgainstSelf(nextFilters) };
    },
    label: (args) => `clearCrossFilter:${args.sourceWidgetId}`,
  },
  clearAllCrossFilters: {
    apply: (state) => {
      const nextFilters = state.filters.filter(
        (f: StudioFilterState) => f.scope.kind !== 'cross-filter',
      );
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      return { ...state, filters: pruneDependsOnAgainstSelf(nextFilters) };
    },
    label: () => 'clearAllCrossFilters',
  },
  clearInteractiveFilter: {
    apply: (state, args) => {
      const { sourceWidgetId } = args;
      if (typeof sourceWidgetId !== 'string') {
        return state;
      }
      const nextFilters = state.filters.filter(
        (f: StudioFilterState) =>
          !(f.scope.kind === 'interactive' && f.scope.sourceWidgetId === sourceWidgetId),
      );
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      return { ...state, filters: pruneDependsOnAgainstSelf(nextFilters) };
    },
    label: (args) => `clearInteractiveFilter:${args.sourceWidgetId}`,
  },
  toggleFilter: {
    apply: (state, args) => {
      const { filterId } = args;
      if (typeof filterId !== 'string') {
        return state;
      }
      let changed = false;
      const nextFilters = state.filters.map((f: StudioFilterState) => {
        if (f.id !== filterId) {
          return f;
        }
        changed = true;
        return { ...f, disabled: !f.disabled };
      });
      // Reference-equality no-op contract: an unknown id returns the SAME doc, so the commit
      // choke point sees no change and pushes no undo entry.
      return changed ? { ...state, filters: nextFilters } : state;
    },
    label: (args) => `toggleFilter:${args.filterId}`,
  },
  updateFilter: {
    apply: (state, args) => {
      const { filterId, changes } = args;
      if (typeof filterId !== 'string' || !isPlainRecord(changes)) {
        return state;
      }
      const target = state.filters.find((f: StudioFilterState) => f.id === filterId);
      if (!target) {
        return state;
      }
      // A `scope` arriving in `changes` is screened to the SAME standard `addFilter` applies —
      // wellformedness then existence — rather than the weaker hand-rolled check the bypassing
      // writer used to carry. An unusable scope leaves the existing one in place instead of
      // installing one the load boundary would silently drop on the next reload.
      let nextScope = target.scope;
      if (changes.scope !== undefined) {
        const incoming = changes.scope;
        const usable = isValidFilterScope(incoming) && hasResolvableFilterAnchors(incoming, state);
        // An unusable scope leaves the EXISTING one in place rather than installing one the load
        // boundary would silently drop on the next reload. The controller's `updateFilter` rejects
        // such a payload outright with a reason; this is the same rule for any other caller, which
        // has no channel to report one.
        nextScope = usable ? incoming : target.scope;
      }
      const merged = { ...target, ...changes, scope: nextScope };
      // Reference-equality no-op contract. `commitDocPatch`'s `===` guard cannot see a
      // fresh-but-equivalent object, which is why the bypassing writer carried its own
      // hand-rolled value comparison; routing here makes that the reducer's job. `scope` is
      // compared by reference deliberately — `nextScope` is `target.scope` itself unless a
      // NEW, screened scope arrived, so an unchanged scope is always reference-equal.
      if (
        shallowRecordEqual(
          target as unknown as Record<string, unknown>,
          merged as unknown as Record<string, unknown>,
        )
      ) {
        return state;
      }
      return {
        ...state,
        filters: state.filters.map((f: StudioFilterState) => (f.id === filterId ? merged : f)),
      };
    },
    label: (args) => `updateFilter:${args.filterId}`,
  },
  removeFilter: {
    apply: (state, args) => {
      const { filterId } = args;
      // Require a STRING `filterId`. The comparison below is a strict `===` that never
      // coerces, so a non-string value is already a harmless no-op — the explicit guard is
      // for uniformity with every other id-bearing handler rather than for that behaviour.
      if (typeof filterId !== 'string') {
        return state;
      }
      const nextFilters = state.filters.filter((f: StudioFilterState) => f.id !== filterId);
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      // Cascade the removal to every remaining filter's `dependsOn` via the SHARED
      // `pruneDependsOn` helper — the same one every other filter-dropping path uses. Drops
      // the whole array rather than leaving `dependsOn: []`, and keeps each untouched
      // filter's object identity.
      const prunedFilters = pruneDependsOnAgainstSelf(nextFilters);
      return { ...state, filters: prunedFilters };
    },
    label: (args) => `removeFilter:${args.filterId}`,
  },

  applyBulkUpdate: {
    apply: (state, args) => {
      const { removedWidgetIds: rawRemovedWidgetIds, addedWidgets, updatedWidgets } = args;
      const { activePageId } = args;
      // Require a real ARRAY `removedWidgetIds`, then drop any non-string ENTRY.
      //
      // `new Set(str)` iterates a STRING char-by-char, so `removedWidgetIds: 'w1'` would
      // delete widgets literally named `'w'` and `'1'` instead of `'w1'`. A non-array value
      // is therefore treated as an absent/empty list.
      //
      // The per-entry filter is the id-coercion desync one level down: a numeric `42` never
      // matches the `Set<string>` membership checks built from string row ids
      // (`removeWidgetIds`' `stillReferenced`, `stripWidgetIdsFromPages`' per-row `has`) yet
      // DOES match a widget/span keyed `"42"` through `Object.hasOwn`'s coercion — bypassing
      // the "genuinely gone" cross-page guard and deleting a widget still referenced (as a
      // string) on another page. Junk entries are dropped rather than rejecting the whole
      // array, matching this handler's "skip the bad entry, keep the good ones" convention
      // for `addedWidgets`/`updatedWidgets`.
      const removedWidgetIds = (
        Array.isArray(rawRemovedWidgetIds) ? rawRemovedWidgetIds : []
      ).filter((id): id is string => typeof id === 'string');

      // Crash prevention for `addedWidgets`/`updatedWidgets`: `?? []` guards `null`/
      // `undefined` but lets a TRUTHY non-array (`addedWidgets: {}`, `updatedWidgets:
      // 'junk'`) reach a `for…of`, which throws `TypeError: … is not iterable`. Coerced once
      // here so every downstream loop reads a guaranteed array.
      const safeAddedWidgets = Array.isArray(addedWidgets) ? addedWidgets : [];
      const safeUpdatedWidgets = Array.isArray(updatedWidgets) ? updatedWidgets : [];

      // Ids named in BOTH `removedWidgetIds` and `addedWidgets` in this SAME payload: a
      // remove+re-add of one id is a "replace", not a removal followed by an unrelated fresh
      // insert. Computed ONCE, up front, so the FOUR steps that must agree on it — the row
      // pre-strip, the `removeWidgetIds` candidate list, the layout block's row-placement
      // resolution, and the `addedWidgets` insert loop's idempotent-add guard — share one
      // definition and produce the same outcome whether or not the bulk also supplied
      // `widgetRows`: the widget's placement, cross-filters and spans survive, and its
      // definition is updated to the new value.
      //
      // This set deliberately uses a LOOSER screen than `isInsertableAddedWidget`: it answers
      // "does this payload intend to keep this id alive?", not "will the insert loop install
      // it?". A re-add whose new definition is junk (a non-string `kind`, say) is skipped by
      // the insert loop, and membership here is what makes the OLD widget — its entry, row,
      // filters and spans — survive intact instead of the removal half of a rejected replace
      // deleting the user's widget. `removedWidgetIds` is already string-filtered, so
      // `has(widget.id)` implies a string id.
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

      // `widgetRows`/`widgetColSpans` are typed as REQUIRED on the wire mutation, but read as
      // runtime-optional: a hand-built partial payload (the `executeToolOnState` pattern) can
      // omit either, and the reducer must stay total over that.
      const widgetRows = args.widgetRows as string[][] | undefined;
      const widgetColSpans = args.widgetColSpans as Record<string, number> | undefined;
      // The whole layout-replacement block is SKIPPED when BOTH layout fields are absent.
      // Defaulting an absent `widgetRows` to `[]` would WIPE the active page's layout for a
      // batch that merely omitted the field — strictly worse than throwing. The producer
      // attaches them only for a batch that changed layout, so an updates-only bulk leaves
      // layout untouched. When present, array/record-ness is coerced below.
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
      // Require a STRING `activePageId`: `Object.hasOwn` COERCES a non-string value (`42`)
      // to its string property key, which could coincidentally match a page keyed `"42"`.
      // Not independently exploitable here — every downstream use is itself gated on
      // `pageExists`, and it is never persisted to `dashboard.activePageId` — but the
      // explicit type check keeps this handler uniform with the rest of the file rather than
      // resting on incidental coercion behaviour.
      const pageExists =
        typeof activePageId === 'string' && Object.hasOwn(state.pages, activePageId);
      // Strip `removedWidgetIds` from EVERY page's rows FIRST, unconditionally.
      //
      // Unconditionally, because `removeWidgetIds`' "stillReferenced" check below reads the
      // rows: a removals-only bulk that omits `widgetRows` would otherwise leave every page's
      // rows still naming the widget it asked to remove, and the removal would silently
      // no-op. Every page rather than just the active one, because `removedWidgetIds` names
      // widgets to remove doc-wide and a widget can be dragged to a DIFFERENT page mid-turn
      // while an agentic bulk computed against an earlier snapshot is in flight — the same
      // cross-page guarantee `removeWidget`'s own `stripWidgetIdsFromPages(state.pages, …)`
      // call gives a single removal.
      //
      // EXCEPT an id in `reAddedWidgetIds`: a remove+re-add is a replace, and the widget
      // survives this mutation under the same id, so its row must survive too. Stripping it
      // would make `removeWidgetIds` see it as genuinely gone and delete its widget entry,
      // filters and spans.
      let layoutPages: StudioDoc['pages'] = state.pages;
      const idsToPreStrip = removedWidgetIds.filter((id) => !reAddedWidgetIds.has(id));
      if (idsToPreStrip.length > 0) {
        // Strip every page's rows in one pass — `stripWidgetIdsFromPages` already
        // iterates the whole `pages` record and is reference-stable (returns the SAME
        // object) when no page actually held any of `idsToPreStrip`, so a bulk whose
        // targets never appear on any page's rows churns nothing here.
        layoutPages = stripWidgetIdsFromPages(state.pages, new Set(idsToPreStrip));
        if (pageExists) {
          // Also prune each pre-stripped id's OWN `widgetColSpans` entry on the active page.
          // `stripWidgetIdsFromPages` clears only a SURVIVING row-mate's now-stale span (the
          // "orphaned sole occupant" case); the removed id's own span is otherwise left to
          // `removeWidgetIds`' "genuinely gone" check below, which prunes it on every page
          // it does not rebuild here. The active page's object was just rebuilt above, so it
          // needs the pruning applied directly. `removeSpanEntries` is reference-stable, so a
          // bulk that touched none of this page's spans still returns the SAME page object.
          //
          // Installed through `withSpans`, like every other span-install site. The bare
          // `{ ...page, widgetColSpans: spansPruned }` this used to do RE-MATERIALIZES the key
          // as an own property when `removeSpanEntries` collapsed the map to `undefined`, so
          // `Object.keys(page)` and `'widgetColSpans' in page` both still reported a span map
          // on a page that has none — the exact shape `withSpans` exists to eliminate, and the
          // one install site that still produced it. `removeWidgetIds`' later pass never
          // healed it either: it short-circuits on `if (!spans) return spans`. In-memory only
          // (`JSON.stringify` erases an `undefined` value), which is precisely why it needed a
          // structural fix rather than a remembered one.
          const strippedActivePage = layoutPages[activePageId];
          const spansPruned = removeSpanEntries(strippedActivePage.widgetColSpans, idsToPreStrip);
          if (spansPruned !== strippedActivePage.widgetColSpans) {
            layoutPages = {
              ...layoutPages,
              [activePageId]: withSpans(strippedActivePage, spansPruned),
            };
          }
        }
      }
      if (pageExists && hasLayoutUpdate) {
        const page = layoutPages[activePageId];

        // The ids the producer's rows may legitimately name: the widgets that will exist
        // once this bulk applies — existing widgets PLUS this bulk's own `addedWidgets` ids,
        // which are inserted below in the same handler. Unlike `setWidgetLayout`, which
        // filters against `state.widgets` alone, the bulk's rows can reference a
        // not-yet-inserted added widget. Anything else is a phantom that would persist in
        // `widgetRows` with no `widgets` entry, the "page renders a widget that does not
        // exist" state. A `Set` lookup keeps an untrusted id off the prototype chain.
        //
        // Admission uses the SHARED `isInsertableAddedWidget` predicate, not a re-listed
        // subset of the insert loop's screens: this step PREDICTS that loop's verdict, and
        // any condition it fails to mirror leaves a row naming a widget the loop then skips.
        // That was a real gap — this block screened record-ness/string-id/safe-key while the
        // insert loop ADDITIONALLY required a string `kind`/`title`, so a
        // `{ id: 'w9', kind: 42 }` entry with a `widgetRows: [['w9']]` installed the row and
        // no widget.
        const validRowIds = new Set<string>(Object.keys(state.widgets));
        for (const widget of safeAddedWidgets) {
          if (isInsertableAddedWidget(widget)) {
            validRowIds.add(widget.id);
          }
        }
        // Exclude ids THIS SAME payload is removing: an explicit removal takes precedence
        // over a stale row the payload also happens to carry. The current producer strips
        // removed ids out of `widgetRows` before calling, but the reducer is the source of
        // truth for mutation validity and must not depend on that caller discipline.
        //
        // EXCEPT an id in `reAddedWidgetIds` — a replace, whose widget survives this mutation
        // under the same id, so its row placement must survive too. Dropping it here as a
        // "phantom" before the re-add takes effect would lose the placement to the bottom-row
        // default-placement fallback further below. The SHARED set computed at the top of
        // this handler is what keeps this step, the pre-strip above, and the insert loop
        // below agreeing on exactly which ids are re-added.
        for (const id of removedWidgetIds) {
          if (!reAddedWidgetIds.has(id)) {
            validRowIds.delete(id);
          }
        }
        // Which rows to reconcile against — total over all three payload shapes:
        //  - `widgetRows` present and an ARRAY ⇒ install it (the normal case).
        //  - `widgetRows` ABSENT (a spans-only bulk) ⇒ reconcile against the page's EXISTING
        //    rows, never `[]`. Defaulting to `[]` un-places EVERY widget on the active page,
        //    and `enforceLayoutColSpans` then drops the very spans this bulk carries as
        //    orphans against the now-empty rows — a mutation that only meant to change a
        //    width would blank the page.
        //  - `widgetRows` present but a NON-array (hand-built junk like `null`) ⇒ treated as
        //    ABSENT, same as above. The `widgetColSpans → {}` coercion is harmless (spans
        //    merge or replace), but a `widgetRows → []` coercion is destructive in exactly
        //    the way just described.
        //
        // `rowsProvided` is ONE predicate serving both the resolution above and the
        // merge-vs-replace decision further down, so junk `widgetRows: null` is ABSENT for
        // both. Keying the spans decision on `widgetRows === undefined` instead would let
        // such a payload wholesale-REPLACE the receiver's span map — wiping another widget's
        // concurrent span even though rows were never re-placed.
        //
        // `dedupeLayoutRows` then drops repeated ids (first occurrence wins) and any emptied
        // row: the same id twice renders the widget twice and double-counts its span in
        // `enforceLayoutColSpans`' overflow sum.
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
        // every other layout path enforces, so a bad producer can never persist an
        // out-of-range or overflowing span: clamp each span to the valid range and drop
        // unsafe keys (so the rebuild can't reintroduce prototype pollution), then run
        // `enforceLayoutColSpans` against the SANITIZED rows, which prunes a span for a
        // dropped phantom id as an orphan.
        //
        // ONE presence predicate for `widgetColSpans`, mirroring `rowsProvided` above: a
        // present-but-junk value (`null`, an array, a primitive from a hand-built payload)
        // counts as ABSENT everywhere, so it can neither be read (`Object.keys` would
        // throw) nor flip the merge-vs-replace decision below.
        const spansProvided = isPlainRecord(widgetColSpans);
        const safeSpans: Record<string, number> = spansProvided ? widgetColSpans : {};
        const clampedSpans: Record<string, number> = {};
        for (const key of Object.keys(safeSpans)) {
          if (!isSafePatchKey(key)) {
            continue;
          }
          clampedSpans[key] = clampSpan(safeSpans[key]);
        }

        // REPLACE vs MERGE for the span map. Replace applies ONLY when the producer shipped
        // rows AND spans together — then the wire spans genuinely ARE the intended full map
        // for the new placement. Any other shape MERGES the incoming entries onto the page's
        // EXISTING spans (incoming keys win, untouched keys survive), because the producer
        // ships a turn-start snapshot: wholesale-replacing the receiver's map with it
        // reverts a concurrent client drag-resize of a widget this batch never named, and a
        // rows-only payload (an absent `widgetColSpans` coercing to `{}`) would replace the
        // whole map with nothing — making `applyBulkUpdate { widgetRows: [['w2','w1']] }`
        // and `setWidgetLayout { rows: [['w2','w1']] }` disagree on every widget's width.
        // Keyed on the SAME `rowsProvided`/`spansProvided` predicates the row-placement
        // resolution uses, so junk (`widgetRows: null`) is classified identically here.
        const spansToEnforce: Record<string, number> =
          rowsProvided && spansProvided
            ? clampedSpans
            : { ...(page.widgetColSpans ?? {}), ...clampedSpans };
        // A merged row can sum past `GRID_COLS` even though every individual span is in
        // range — the incoming width plus a width already on the page. Resolve that around
        // the widths this payload actually asked for, via the SAME helper
        // `setWidgetColSpan` uses, so `set_widget_width` and `apply_bulk_update` carrying
        // the same width produce the same row. Without it the merged row falls through to
        // `enforceLayoutColSpans`' drop-EVERY-span rule, which discards the width of a
        // widget this payload never mentioned and drops the row to equal flex.
        //
        // Scoped to the merge branch: on the replace branch every span in the row came from
        // this one payload, so there is no pre-existing width to protect and no non-arbitrary
        // anchor — an internally-inconsistent full snapshot keeps the documented drop-to-flex
        // resolution. Rows with no incoming entry have no anchor either and are left alone.
        if (spansProvided && !rowsProvided) {
          const anchorIds = new Set(Object.keys(clampedSpans));
          for (const row of sanitizedRows) {
            if (row.some((id) => anchorIds.has(id))) {
              rebalanceRowSpans(
                spansToEnforce,
                row,
                anchorIds,
                (id) => validRowIds.has(id) && isSafePatchKey(id),
              );
            }
          }
        }
        // `oldRows` for the col-span invariants. Normally `[]` so the 2→1 collapse never
        // fires — a producer shipping rows AND spans together meant the singleton spans it
        // sent. But a rows-ONLY bulk is semantically a `setWidgetLayout`: the surviving spans
        // are the page's own, so a widget this re-placement leaves alone in a row it used to
        // share has a stale multi-widget-era span that must be cleared, exactly as
        // `setWidgetLayout` does by diffing against the page's real previous rows.
        const oldRowsForSpans = rowsProvided && !spansProvided ? (page.widgetRows ?? []) : [];
        const normalizedActiveSpans = enforceLayoutColSpans(
          oldRowsForSpans,
          sanitizedRows,
          spansToEnforce,
        );

        // Reference-equality no-op tracking: only rebuild the active page when its rows or
        // spans actually changed (by value), so a re-delivered bulk carrying the current
        // layout doesn't churn the page reference and push a spurious undo entry.
        const layoutChanged =
          !rowsEqual(page.widgetRows ?? [], sanitizedRows) ||
          !spansEqual(normalizedActiveSpans, page.widgetColSpans);
        if (layoutChanged) {
          layoutPages = {
            ...layoutPages,
            [activePageId]: withSpans(page, normalizedActiveSpans, {
              widgetRows: sanitizedRows,
            }),
          };
        }
      }

      // Remove every genuinely-gone widget via the shared primitive: it deletes the ids
      // from `state.widgets`, drops their widget/interactive/cross-filter-scoped filters
      // (cascading into surviving filters' `dependsOn`), and prunes their stale col-spans
      // on every page.
      //
      // The primitive's own "still referenced on some OTHER page's rows" guard is inert
      // here, intentionally: the pre-strip above already removed every non-re-added id from
      // EVERY page's rows, exactly as `removeWidget` does. Both handlers delete the widget
      // from `doc.widgets` entirely, so leaving it on another page's rows would strand a
      // dangling row reference — narrowing the pre-strip back to the active page would
      // reintroduce that. The guard exists for `removePage`, the one caller that needs it;
      // see `removeWidgetIds`'s doc comment.
      //
      // The candidate list is `idsToPreStrip`, NOT `removedWidgetIds`: a re-added id is a
      // REPLACE and must be excluded EXPLICITLY. Handing the full list in and relying on the
      // re-added id's surviving ROW to make `stillReferenced` classify it as live worked only
      // for a PLACED widget. A widget in `doc.widgets` but on no page's rows has no row to
      // survive, so it was classified as genuinely removed and `dropWidgetScopedFilters` took
      // its `widget`/`interactive`/`cross-filter` filters away moments before the insert loop
      // re-added it — a replace of an unplaced widget silently losing its scoped filters. For
      // the placed case the two are equivalent (the surviving row already vetoed the removal),
      // so this only narrows the list to what the design always meant.
      const {
        pages: nextPages,
        widgets: prunedWidgets,
        filters: nextFilters,
      } = removeWidgetIds(layoutPages, state.widgets, state.filters, idsToPreStrip);

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
        // The same screens `addWidget` applies, per entry — a malformed entry is skipped
        // rather than sinking the whole bulk. Held in `isInsertableAddedWidget` so the
        // `validRowIds` step above, which must predict this verdict to avoid installing a
        // row for a widget that never lands, applies the IDENTICAL test.
        if (!isInsertableAddedWidget(widget)) {
          continue;
        }
        // Idempotent add: existence anywhere in `nextWidgets` means this widget was
        // already applied, so a re-delivery (an SSE at-least-once retry, or an AI retry
        // re-issuing the same bulk envelope) must be a no-op — mirrors `addWidget`'s
        // guard. Overwriting would revert a concurrent user edit to a widget this bulk
        // originally added. `Object.hasOwn` (not truthy access) so an untrusted id can't
        // match a prototype member.
        //
        // EXCEPT a `reAddedWidgetIds` member: a remove+re-add of the same id is a REPLACE,
        // not a re-delivery. The pre-strip and layout steps above deliberately left that
        // id's row (and hence its `removeWidgetIds` "stillReferenced" status, filters and
        // spans) untouched so the widget's PLACEMENT survives, which means its entry in
        // `nextWidgets` is still the OLD definition and must be overwritten below. Skipping
        // it would make a replace bulk a placement-only no-op that discards the new
        // title/config.
        const alreadyPresent = Object.hasOwn(nextWidgets, widget.id);
        const isReplace = reAddedWidgetIds.has(widget.id);
        if (alreadyPresent && !isReplace) {
          continue;
        }
        // Repair the widget before installing, exactly as `addWidget` does: make a
        // non-record config safe to store and strip its unsafe own keys, then drop an
        // invalid `subtitle`/`sourceId`/`titleMode`/`subtitleMode`.
        const safeWidget = screenOptionalWidgetScalars(coerceWidgetConfig(widget));
        // Normalize the deprecated `seriesType` alias on write (reference-stable when
        // already canonical), so a bulk-added widget matches the load-boundary shape.
        const normalizedConfig = normalizeConfigChartSeries(safeWidget.config);
        const nextWidget =
          normalizedConfig === safeWidget.config
            ? safeWidget
            : ({ ...safeWidget, config: normalizedConfig } as StudioWidget);
        // Value-compare before installing on the REPLACE path, mirroring the
        // `updatedWidgets` loop below (and every other channel in this file): the widget
        // is already present, so an at-least-once SSE re-delivery of the same remove+re-add
        // bulk would otherwise assign a fresh, value-identical object, flip `widgetsChanged`
        // and push a phantom undo entry. A genuinely NEW insert has nothing to compare
        // against and always installs.
        if (alreadyPresent && widgetsValueEqual(nextWidgets[widget.id], nextWidget)) {
          continue;
        }
        nextWidgets[widget.id] = nextWidget;
        widgetsChanged = true;
        // Only a genuinely NEW entry is a candidate for the default row-placement step
        // below; a replace already has a preserved placement.
        if (!alreadyPresent) {
          newlyInsertedWidgetIds.push(widget.id);
        }
      }
      // Default row-placement for a newly-inserted widget the layout portion above didn't
      // place. An adds-only batch omits `widgetRows`, so `hasLayoutUpdate` is `false` and the
      // layout-replacement block never runs — the added widget would land in `nextWidgets`
      // but appear on no page's rows: an orphan that exists and never renders. Scoped to
      // `pageExists`: if the target page was deleted mid-turn there is no sensible page to
      // default onto, so the widget stays unplaced rather than guessing, matching this
      // handler's "apply the widget deltas even when the page-scoped layout can't be" rule.
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
        // Crash prevention: the `.widgetId` read below throws on a `null`/primitive entry.
        if (!isPlainRecord(update)) {
          continue;
        }
        // STRING `widgetId` before the coercing `Object.hasOwn` below (string-id rule):
        // `isSafePatchKey` only screens the denylist and accepts any non-string, so a numeric
        // `42` would otherwise match a widget keyed `"42"`. Uniform with `updateWidget`, the
        // single-widget channel this loop mirrors.
        if (typeof update.widgetId !== 'string') {
          continue;
        }
        // Prototype-hazard guard before the `nextWidgets[update.widgetId] = patchedWidget`
        // bracket-write below. The `Object.hasOwn` existence check just below already rejects
        // an unsafe key in practice; this keeps the intent local to the write.
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
        // Each field below is applied only when it genuinely DIFFERS from the widget's
        // current value, so a re-delivered bulk (SSE at-least-once) carrying a
        // value-identical or field-less `{ widgetId }` entry doesn't churn the doc and push a
        // spurious undo entry.
        //
        // `title` must be a STRING: `deserializeState`'s non-string-title screen drops the
        // WHOLE widget on the next load, so merging a junk value defers the loss to reload.
        if (
          update.title !== undefined &&
          typeof update.title === 'string' &&
          update.title !== existing.title
        ) {
          patchedWidget = { ...patchedWidget, title: update.title };
        }
        // `sourceId` must be a STRING too, for the opposite reason: no load-boundary screen
        // catches a junk one (`deserializeState` drops the key gracefully rather than the
        // widget), so it would silently break the widget-to-data-source lookup with no
        // self-heal at all.
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
        // `isPlainRecord`, not bare truthiness: `{ ...existing.config, ...update.config }`
        // would spread an array's or string's index keys ("0", "1", …) into the merged
        // config. A non-record `update.config` is skipped, same as an absent one.
        if (isPlainRecord(update.config)) {
          // Strip prototype-polluting own keys from the merge result before installing — the
          // same screen `updateWidget`'s config-patch loop applies per-key. An unsafe key
          // surviving as an own config property makes the next load drop the whole widget.
          //
          // An unknown `chartType` is dropped from the INCOMING patch, BEFORE the merge, not
          // from the merge result: the same membership screen the wire boundary applies to
          // this exact channel (see `stripInvalidChartType`), while leaving the widget's
          // existing VALID `chartType` in place rather than clearing it too.
          const mergedConfig = normalizeConfigChartSeries(
            stripUnsafeConfigKeys({
              ...existing.config,
              ...stripInvalidChartType(update.config),
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

      // Re-check per-page rank-filter uniqueness against the FINAL placement. This bulk
      // can move a widget onto a page (its own `widgetRows`, or the default row-placement
      // step above), and a `widget`-scoped rank filter that resolved to nothing while its
      // widget was unplaced then lands on a page that may already have one. Enforcing it
      // here keeps the live doc and the load boundary in agreement at commit time — see
      // `dropConflictingRankFilters`. Reference-stable, so a bulk that changes no
      // placement (or a doc with no rank filters) leaves `nextFilters`' identity intact
      // and the no-op check below still fires.
      const rankScreenedFilters = dropConflictingRankFilters(nextFilters, placementPages);

      // Reference-equality no-op: a bulk that removed nothing, added/updated no widget,
      // and left the active-page layout unchanged returns the SAME doc so
      // `commitDocPatch`'s no-op guard skips a spurious undo entry. `placementPages`
      // (not `nextPages`) is the up-to-date pages reference — it equals `nextPages` by
      // identity unless the default-placement step above actually appended a row.
      if (
        !widgetsChanged &&
        placementPages === state.pages &&
        rankScreenedFilters === state.filters
      ) {
        return state;
      }

      return {
        ...state,
        widgets: widgetsChanged ? nextWidgets : state.widgets,
        pages: placementPages,
        filters: rankScreenedFilters,
      };
    },
    label: () => 'applyBulkUpdate',
  },

  renameAIThread: {
    apply: (state, args) => {
      if (!state.ai) {
        return state;
      }
      // Require STRING `name`/`updatedAt`: the thread's `name`/`updatedAt` are typed
      // `string`, and the chat panel's thread selector renders `name` directly as text with
      // no fallback of its own.
      if (typeof args.name !== 'string' || typeof args.updatedAt !== 'string') {
        return state;
      }
      // Explicit, server-stamped target thread — falls back to the applying side's
      // active thread only for legacy payloads. Targeting an explicit id keeps the
      // rename on the thread the request belongs to even if the user switched
      // threads while the model was running.
      //
      // Resolved through the shared helper so a NON-STRING explicit `threadId` no-ops
      // rather than being compared against every thread's string `id` (string-id rule),
      // exactly as `resolveTargetPageId` does for the three page-targeting handlers.
      const targetThreadId = resolveTargetThreadId(state.ai, args.threadId);
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
