/**
 * Widget mutations, and the layout arithmetic only they need.
 *
 * By far the largest domain — seven handlers, seventeen private helpers, and `applyBulkUpdate`
 * alone the size of most other domains put together. That concentration is why the reducer was
 * split here rather than left as one table: everything in this file is about placing widgets in
 * rows and reconciling their column spans, and nothing outside it needs any of it.
 */
import { getAllowedConfigKeys } from '../configKeyValidation';
import { screenOptionalWidgetScalars } from '../docScreening';
import * as docTransforms from '../docTransforms';
import { normalizeChartSeries } from '../factories';
import { isPlainRecord, stripUnsafeOwnKeys as stripUnsafeConfigKeys } from '../internalGuards';
import {
  hasInvalidChartTypeInConfig,
  hasUnsafeOwnKeys,
  isStringArray,
} from '../parseStateMutation';
import type { StudioDoc } from '../stateTypes';
import {
  REQUIRED_STUDIO_WIDGET_FIELDS,
  STUDIO_WIDGET_FIELDS,
  isTitleModeValue,
} from '../widgetTypeGuards';
import type { StudioChartSeries, StudioWidget } from '../widgetTypes';
import {
  clampSpan,
  dedupeLayoutRows,
  enforceLayoutColSpans,
  rebalanceRowSpans,
  removeSpanEntries,
  rowsEqual,
  spansEqual,
  withSpans,
} from './layout';
import {
  dropConflictingRankFilters,
  isSafePatchKey,
  removeWidgetIds,
  resolveTargetId,
  shallowRecordEqual,
} from './shared';
import type { HandlersFor } from './shared';

export function resolveTargetPageId(doc: StudioDoc, pageId: unknown): string | undefined {
  return resolveTargetId(pageId, doc.dashboard.activePageId);
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
export function widgetsValueEqual(a: StudioWidget, b: StudioWidget): boolean {
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
 * Normalizes the deprecated `seriesType` alias to the canonical `type` on a config's
 * `ySeries`, so the alias never survives a LIVE write (`updateWidget`/`addWidget`).
 * `deserializeState` normalizes at the load boundary only, so a widget written with
 * `seriesType` would otherwise keep the alias until the next reload. Reference-stable:
 * returns the SAME config when there is no `ySeries` or every entry is already canonical,
 * preserving the reducer's no-op detection. Runs across kinds by design (only chart
 * configs carry `ySeries`), reading the flat config shape.
 */
export function normalizeConfigChartSeries<C extends object>(config: C): C {
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
export function stripInvalidChartType<C extends object>(config: C): C {
  if (!hasInvalidChartTypeInConfig(config as unknown as Record<string, unknown>)) {
    return config;
  }
  const next = { ...config } as Record<string, unknown>;
  delete next.chartType;
  return next as C;
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
export function coerceWidgetConfig(widget: StudioWidget): StudioWidget {
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
export function isInsertableAddedWidget(widget: unknown): widget is StudioWidget {
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
export const MERGEABLE_WIDGET_CHANGE_KEYS: ReadonlySet<string> = new Set<string>(
  STUDIO_WIDGET_FIELDS.filter((field) => field !== 'id'),
);

/**
 * The REQUIRED `StudioWidget` fields, as a `Set` for the `unsetFields` denylist — the
 * mirror image of {@link MERGEABLE_WIDGET_CHANGE_KEYS}, derived from the SAME compile-locked
 * tuples so the two can never disagree about which fields exist. A `Set` (not a chain of
 * `!==` comparisons) so an untrusted key can never resolve up a prototype chain.
 */
export const REQUIRED_WIDGET_FIELD_SET: ReadonlySet<string> = new Set<string>(
  REQUIRED_STUDIO_WIDGET_FIELDS,
);

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
export function stripWidgetIdsFromPages(
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

export const WIDGET_MUTATION_HANDLERS: HandlersFor<
  | 'addWidget'
  | 'updateWidget'
  | 'removeWidget'
  | 'setWidgetLayout'
  | 'setWidgetColSpan'
  | 'setWidgetDateRange'
  | 'applyBulkUpdate'
> = {
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

  setWidgetDateRange: {
    apply: (state, args) =>
      typeof args.widgetId === 'string'
        ? docTransforms.setWidgetDateRange(
            state,
            args.widgetId,
            args.fieldId,
            args.sourceId,
            args.fieldType,
            args.preset,
            args.customFrom,
            args.customTo,
          )
        : state,
    label: (args) => `setWidgetDateRange:${args.widgetId}`,
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
};
