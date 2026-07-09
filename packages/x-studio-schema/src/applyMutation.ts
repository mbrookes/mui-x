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
 * Value-equality for two `widgetColSpans` records (either may be `undefined`).
 * `enforceLayoutColSpans` and the `setWidgetColSpan` rebuild both mint a fresh object
 * even when the contents are unchanged, so the layout handlers compare by value (not
 * reference) to detect a no-op and preserve the same-doc contract.
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
 * Shallow value-equality for two config-like records. Used by the widget-merge
 * handlers (`updateWidget`'s `changes.config` wholesale replacement and
 * `applyBulkUpdate`'s `updatedWidgets` config merge) to honor the reference-equality
 * no-op contract: a merge/replacement that is key-for-key identical to the current
 * config must NOT rewrap the widget (which would push a spurious undo entry).
 * Object-valued keys are compared by reference — matching the `config`-patch branch's
 * own `nextConfig[key] !== value` check — so re-supplying a value-equal but
 * reference-different nested value (e.g. a fresh `ySeries` array) is still a change.
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
 * Normalizes the deprecated `seriesType` alias to the canonical `type` on a config's
 * `ySeries`, so the alias never survives a LIVE write (`updateWidget`/`addWidget`) —
 * `deserializeState` normalizes only at the load boundary, so without this a widget
 * written with `seriesType` would keep the alias until the next reload. Reference-
 * stable: returns the SAME config when there is no `ySeries` or every entry is
 * already canonical, so the reducer's no-op detection is preserved. Runs across kinds
 * by design (only chart configs carry `ySeries`), reading the flat config shape.
 */
function normalizeConfigChartSeries<C extends object>(config: C): C {
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
  let pagesChanged = false;
  const nextPages: StudioDoc['pages'] = {};
  for (const [pid, p] of Object.entries(pages)) {
    const prunedSpans = removeSpanEntries(p.widgetColSpans, removedIds);
    if (prunedSpans !== p.widgetColSpans) {
      nextPages[pid] = { ...p, widgetColSpans: prunedSpans };
      pagesChanged = true;
    } else {
      nextPages[pid] = p;
    }
  }
  return {
    pages: pagesChanged ? nextPages : pages,
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
      // Normalize the deprecated `seriesType` alias to canonical `type` on write, so
      // the alias never survives a live add (it is otherwise only normalized at the
      // load boundary in `deserializeState`). Reference-stable when already canonical.
      const normalizedConfig = normalizeConfigChartSeries(widget.config);
      const normalizedWidget =
        normalizedConfig === widget.config
          ? widget
          : ({ ...widget, config: normalizedConfig } as StudioWidget);
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
      if (config !== undefined) {
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
            // `value && typeof value === 'object'` is a defense-in-depth guard (mirroring
            // this file's other unsafe-key guards for the "server bypasses the parser"
            // case): `parseStateMutation` already rejects a non-object `changes.config`
            // at the wire boundary, but without this guard a server-built mutation with
            // `changes: { config: null }` would fall through to a bare `value !==
            // updated.config` comparison and assign `config = null`, corrupting the
            // widget. A non-object value is simply ignored rather than applied.
            if (value && typeof value === 'object') {
              const normalized = normalizeConfigChartSeries(value as Record<string, unknown>);
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
      const sanitizedRows = args.rows
        .map((row) => row.filter((id) => Object.hasOwn(state.widgets, id)))
        .filter((row) => row.length > 0);
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
      const sanitizedRows = widgetRows
        .map((row) => row.filter((id) => validRowIds.has(id)))
        .filter((row) => row.length > 0);

      // Normalize the producer-supplied active-page spans through the SAME invariants
      // every other layout path enforces (previously they were stored verbatim, so a
      // bad producer could persist an out-of-range or overflowing span): clamp each
      // span to the valid range and drop unsafe keys (so the rebuild can't reintroduce
      // prototype pollution), then run `enforceLayoutColSpans`. `oldRows = []` so the
      // 2→1 collapse never fires — the producer supplied rows and spans together, so a
      // singleton span is intentional — while the row-overflow drop, orphaned-span
      // drop, and empty→undefined collapse all apply. Feeding the SANITIZED rows here
      // means a span for a dropped phantom id is pruned as an orphan.
      const clampedSpans: Record<string, number> = {};
      for (const key of Object.keys(widgetColSpans)) {
        if (!isSafePatchKey(key)) {
          continue;
        }
        clampedSpans[key] = clampSpan(widgetColSpans[key]);
      }
      const normalizedActiveSpans = enforceLayoutColSpans([], sanitizedRows, clampedSpans);

      // Reference-equality no-op tracking: only rebuild the active page when its rows or
      // spans actually changed (by value), so a re-delivered bulk carrying the current
      // layout doesn't churn the page reference and push a spurious undo entry.
      const layoutChanged =
        !rowsEqual(page.widgetRows ?? [], sanitizedRows) ||
        !spansEqual(normalizedActiveSpans, page.widgetColSpans);
      const layoutPages: StudioDoc['pages'] = layoutChanged
        ? {
            ...state.pages,
            [activePageId]: {
              ...page,
              widgetRows: sanitizedRows,
              widgetColSpans: normalizedActiveSpans,
            },
          }
        : state.pages;

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
        // Normalize the deprecated `seriesType` alias on write (reference-stable when
        // already canonical), so a bulk-added widget matches the load-boundary shape.
        const normalizedConfig = normalizeConfigChartSeries(widget.config);
        nextWidgets[widget.id] =
          normalizedConfig === widget.config
            ? widget
            : ({ ...widget, config: normalizedConfig } as StudioWidget);
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
        if (update.config) {
          const mergedConfig = normalizeConfigChartSeries({
            ...existing.config,
            ...update.config,
          }) as StudioWidget['config'];
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
  const handler = MUTATION_HANDLERS[mutation.type] as MutationHandler<StateMutation> | undefined;
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
  const handler = MUTATION_HANDLERS[mutation.type] as MutationHandler<StateMutation> | undefined;
  return handler ? handler.label(mutation.args) : (mutation as { type: string }).type;
}
