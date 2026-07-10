import { createDefaultStudioState, normalizeGridColumn, normalizeChartSeries } from './factories';
import { normalizePersistedPages } from './applyMutation';
import { isSafeKey } from './unsafeKeys';
import { CURRENT_SCHEMA_VERSION } from './stateTypes';
import type { StudioState, StudioDoc, StudioSession, StudioRuntime } from './stateTypes';
import type { StudioExpressionField } from './expressionTypes';
import type { StudioWidget, StudioWidgetConfig } from './widgetTypes';
import type { StudioAIState } from './aiTypes';

// `CURRENT_SCHEMA_VERSION` is defined in `stateTypes.ts` (the single source of truth —
// it must be a value there so `factories.ts` can stamp a fresh doc without forming an
// import cycle). Re-exported here so every existing `import { CURRENT_SCHEMA_VERSION }
// from './statePersistence'` site (index.ts, StudioController, examples) is unaffected.
export { CURRENT_SCHEMA_VERSION };

/**
 * Serializable state format for persistence.
 * Contains only user-authored dashboard config — data sources are provided by
 * the host app at runtime and are never persisted.
 */
export interface SerializedStudioState {
  schemaVersion: number;
  dashboard: StudioDoc['dashboard'];
  pages: StudioDoc['pages'];
  widgets: StudioDoc['widgets'];
  filters: StudioDoc['filters'];
  relationships?: StudioDoc['relationships'];
  expressionFields?: StudioExpressionField[];
  filterPresets?: StudioDoc['filterPresets'];
  /**
   * AI conversation threads. Optional — omitted when no threads exist.
   * Populated by `StudioChatPanel` and passed back via `StudioProvider.onAIStateChange`.
   */
  ai?: StudioAIState;
}

/**
 * One snapshot in a {@link SerializedStudioSession} — a serialized `StudioDoc` plus the
 * `mode` the editing session was in when the snapshot was taken.
 *
 * Since the lifetime-partition split, `mode` lives in {@link StudioSession} and is
 * NOT undoable, so it is no longer meaningfully time-travelled per history entry:
 * every snapshot in a saved session carries the SAME `mode` (the session mode at save
 * time). The field is retained on the snapshot shape for on-disk backward
 * compatibility, but `restoreSession` reads mode from the present entry only and
 * applies it to `session.mode` — it never varies mode across undo/redo history.
 */
export interface SerializedStudioSnapshot {
  mode: StudioSession['mode'];
  state: SerializedStudioState;
}

/**
 * Serializable full editing *session*: the present state plus the undo/redo stacks.
 *
 * Each entry strips data sources (re-injected on restore). Use this instead of
 * {@link SerializedStudioState} when the undo/redo history must survive a reload, not just
 * the current dashboard.
 */
export interface SerializedStudioSession {
  schemaVersion: number;
  /** The current (present) snapshot. */
  present: SerializedStudioSnapshot;
  /** Undo stack, oldest first. */
  past: SerializedStudioSnapshot[];
  /** Redo stack, oldest first. */
  future: SerializedStudioSnapshot[];
}

/**
 * Result of a state migration operation
 */
export interface MigrationResult {
  success: boolean;
  state: SerializedStudioState | null;
  fromVersion: number;
  toVersion: number;
  errors: string[];
}

/**
 * Migration function type
 */
type MigrationFn = (state: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registry of migrations from version N to N+1.
 *
 * HOW TO ADD A MIGRATION
 * ─────────────────────
 * 1. Increment CURRENT_SCHEMA_VERSION (in `stateTypes.ts`).
 * 2. Add an entry here for the OLD version number (e.g. if bumping 1→2, add key `1`).
 *    EVERY version in `0 … CURRENT_SCHEMA_VERSION − 1` must have an entry — even a
 *    no-op bump needs an explicit identity migration (see the `0:` entry below), and
 *    a gap now makes `migrateState` FAIL rather than silently stamp the version. The
 *    `REGISTERED_MIGRATION_VERSIONS` pin in the test suite catches a forgotten entry.
 * 3. The function receives the persisted object and must return a new object with
 *    `schemaVersion` set to N+1. Mutating the input is fine — `migrateState` passes a
 *    deep copy (`structuredClone`) of the caller's object, so nested mutation is safe.
 * 4. Write a test in statePersistence.test.ts that calls migrateState() with a v(N) fixture
 *    and asserts the output matches the v(N+1) shape.
 *
 * NAMING POLICY — never suffix field names with version numbers (e.g. fooV2, barNew).
 * ───────────────────────────────────────────────────────────────────────────────────
 * When a field's shape needs to change (rename, restructure, add a required property):
 *   - Keep the clean target name in the TypeScript interface (e.g. `scope`).
 *   - Bump CURRENT_SCHEMA_VERSION and write a migration that rewrites persisted
 *     state from the old shape to the new shape.
 *   - The running code only ever reads the new shape; old stored state is upgraded
 *     on load before it reaches any application code.
 *
 * This is the correct alternative to adding a parallel `fooV2` field — that pattern
 * forces a second cleanup refactor and leaves dead fields in both code and stored state
 * until someone gets around to it.
 *
 * Example — bumping 1→2 (reshape `filters[].scope` from a string to a discriminated union):
 *
 *   1: (state) => {
 *     const filters = (state['filters'] as Record<string, unknown>[]) ?? [];
 *     for (const f of filters) {
 *       if (typeof f['scope'] === 'string') {
 *         f['scope'] = { kind: f['scope'], widgetId: f['widgetId'] };
 *         delete f['widgetId'];
 *       }
 *     }
 *     return { ...state, schemaVersion: 2 };
 *   },
 *
 * Example — bumping 1→2 (add a required `layout` field to every widget):
 *
 *   1: (state) => {
 *     const widgets = state['widgets'] as Record<string, Record<string, unknown>>;
 *     for (const w of Object.values(widgets)) {
 *       if (!w['layout']) {
 *         w['layout'] = { x: 0, y: 0, w: 4, h: 3 };
 *       }
 *     }
 *     return { ...state, schemaVersion: 2 };
 *   },
 */
const migrations: Record<number, MigrationFn> = {
  // v0 → v1: first versioned schema. No structural changes needed; just stamp version.
  // An explicit identity migration — registering it (rather than relying on a silent
  // bump) is exactly the pattern every future no-op version bump must follow.
  0: (state) => ({ ...state, schemaVersion: 1 }),
};

/**
 * The old-version numbers the migration registry covers, exported so a completeness
 * test can pin that every version in `0 … CURRENT_SCHEMA_VERSION − 1` has a migration
 * entry — the check that actually catches a forgotten entry when the version is bumped.
 */
export const REGISTERED_MIGRATION_VERSIONS = Object.keys(migrations).map(Number);

/**
 * Validates that a state object has the minimum required structure
 */
function validateStateStructure(state: unknown): state is Record<string, unknown> {
  if (!state || typeof state !== 'object') {
    return false;
  }
  return true;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The fields a fully-migrated `SerializedStudioState` must carry, checked fail-closed
 * AFTER migration so a partial or nested-corrupt persisted doc is rejected cleanly here
 * (with a named field) instead of crashing later inside `deserializeState`. Returns the
 * name of the first missing/mis-typed field, or `null` when all are present.
 *
 * The check is not only top-level: `migrateState`'s documented contract is that a corrupt
 * doc is rejected here with a NAMED field rather than crashing in `deserializeState`, so a
 * shallow per-entry shape check is applied too — each `pages[*]` must be a record with an
 * array `widgetRows`, and each `widgets[*]` must be a record with a record `config`. A
 * junk shape one level down (`pages.p1.widgetRows: "junk"`, `widgets.w1: null`) previously
 * passed migration and then threw an uncaught `TypeError` inside the load-boundary sweep.
 */
function findMissingRequiredField(state: Record<string, unknown>): string | null {
  if (!isRecord(state.dashboard)) {
    return 'dashboard';
  }
  if (!isRecord(state.pages)) {
    return 'pages';
  }
  if (!isRecord(state.widgets)) {
    return 'widgets';
  }
  if (!Array.isArray(state.filters)) {
    return 'filters';
  }
  for (const [pageId, page] of Object.entries(state.pages)) {
    if (!isRecord(page)) {
      return `pages["${pageId}"]`;
    }
    if (!Array.isArray(page.widgetRows)) {
      return `pages["${pageId}"].widgetRows`;
    }
  }
  for (const [widgetId, widget] of Object.entries(state.widgets)) {
    if (!isRecord(widget)) {
      return `widgets["${widgetId}"]`;
    }
    if (!isRecord(widget.config)) {
      return `widgets["${widgetId}"].config`;
    }
  }
  // Per-entry shape check for `filters`, the same one-level-down validation applied to
  // `pages`/`widgets` above. `serializeDoc` (the autosave AND undo-snapshot path) and the
  // reducer (`dropWidgetScopedFilters`, `addFilter`, `removePage`) all read `f.scope.kind`
  // / `f.id` with NO optional chaining, so a `filters: [null]` (or a scope-less / `scope:
  // null` entry) that slipped through migration would load fine and then throw an uncaught
  // `TypeError` on every subsequent save, undo snapshot, and widget removal — deferred,
  // repeated data loss, strictly worse than being rejected at load. Reject it here with a
  // named field instead, matching the pages/widgets treatment.
  for (let i = 0; i < state.filters.length; i += 1) {
    const filter = state.filters[i];
    if (!isRecord(filter)) {
      return `filters[${i}]`;
    }
    if (!isRecord(filter.scope) || typeof filter.scope.kind !== 'string') {
      return `filters[${i}].scope`;
    }
  }
  return null;
}

/**
 * Migrates state from an older schema version to the current version
 */
export function migrateState(state: unknown): MigrationResult {
  const errors: string[] = [];

  if (!validateStateStructure(state)) {
    return {
      success: false,
      state: null,
      fromVersion: 0,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors: ['Invalid state structure: expected an object'],
    };
  }

  // Derive the source version fail-CLOSED. `undefined` is a legacy pre-versioning doc
  // (treated as v0); an integer is used as-is. Anything else — a non-finite `NaN`, a
  // fractional `0.5`, or a non-number — is rejected here rather than silently passed
  // through: `typeof NaN === 'number'` combined with the `NaN === CURRENT` / `NaN > CURRENT`
  // comparisons both being false and the migration loop's `NaN < CURRENT` guard never
  // running would otherwise let a `schemaVersion: NaN` doc through UN-MIGRATED with
  // `success: true` (a fail-OPEN hole in the otherwise fail-closed version handling).
  const rawVersion = state.schemaVersion;
  if (rawVersion !== undefined && !Number.isInteger(rawVersion)) {
    return {
      success: false,
      state: null,
      fromVersion: 0,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors: [
        `Invalid persisted state: "schemaVersion" must be an integer or absent, ` +
          `received ${typeof rawVersion === 'number' ? String(rawVersion) : JSON.stringify(rawVersion)}. ` +
          `A non-integer version cannot be matched to a migration step, so the doc cannot be safely upgraded.`,
      ],
    };
  }
  const fromVersion = typeof rawVersion === 'number' ? rawVersion : 0;

  // Already at current version — still validate structure fail-closed, so a partial
  // persisted doc is rejected here (with a named field) rather than crashing later in
  // `deserializeState`. On success return the SAME reference (the fast path).
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    const missing = findMissingRequiredField(state);
    if (missing) {
      return {
        success: false,
        state: null,
        fromVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        errors: [`Invalid persisted state: missing required field "${missing}".`],
      };
    }
    return {
      success: true,
      state: state as unknown as SerializedStudioState,
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors: [],
    };
  }

  // Cannot migrate from a newer version
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    return {
      success: false,
      state: null,
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors: [
        `Cannot migrate from schema version ${fromVersion} to ${CURRENT_SCHEMA_VERSION}. ` +
          'The state was created with a newer version of X Studio.',
      ],
    };
  }

  // Apply migrations sequentially, on a DEEP copy of the caller's object: a migration
  // may (and the registry examples encourage it to) mutate nested state in place, so a
  // shallow spread would leak those edits back to the caller. `StudioController`'s
  // `restoreSession`/`loadSerializedState` both retain the object they pass in.
  // Persisted state is JSON, so `structuredClone` (Node ≥ 17, met by the toolchain) is
  // safe and total for real persisted input. But `migrateState(state: unknown)` is a
  // public API whose every OTHER failure mode returns a failed `MigrationResult`; a
  // caller that mistakenly passes a live object carrying a non-cloneable value (e.g. a
  // function on an attached `dataSources.adapter`) would otherwise get an uncaught
  // `DataCloneError` on the migration path only. Catch it and fail closed in the same
  // error style, so the function is total.
  let currentState: Record<string, unknown>;
  try {
    currentState = structuredClone(state) as Record<string, unknown>;
  } catch (error) {
    return {
      success: false,
      state: null,
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors: [
        `Failed to clone state for migration: ${
          error instanceof Error ? error.message : String(error)
        }. Persisted state must be JSON-serializable (no functions, class instances, or other non-cloneable values).`,
      ],
    };
  }
  for (let version = fromVersion; version < CURRENT_SCHEMA_VERSION; version += 1) {
    const migrateFn = migrations[version];
    if (!migrateFn) {
      // A gap in the registry is a HARD failure — never a silent version bump, which
      // would ship un-transformed state stamped under a newer version number.
      errors.push(
        `No migration registered from v${version} to v${version + 1}. ` +
          'Every version step needs an explicit migration entry (an identity migration when no transform is required).',
      );
      return {
        success: false,
        state: null,
        fromVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        errors,
      };
    }
    try {
      currentState = migrateFn(currentState);
    } catch (error) {
      errors.push(
        `Migration from v${version} to v${version + 1} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        success: false,
        state: null,
        fromVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        errors,
      };
    }
  }

  // Validate structure fail-closed on the POST-migration result, so a migration that
  // synthesizes a required field still passes and a genuinely-partial doc fails here.
  const missing = findMissingRequiredField(currentState);
  if (missing) {
    errors.push(`Invalid persisted state: missing required field "${missing}".`);
    return {
      success: false,
      state: null,
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors,
    };
  }

  return {
    success: true,
    state: currentState as unknown as SerializedStudioState,
    fromVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
    errors,
  };
}

/**
 * Serializes a {@link StudioDoc} for persistence — the doc-only inner logic shared by
 * {@link serializeState} and by `StudioController`'s undo/redo session snapshotting.
 *
 * The persisted JSON shape is exactly `StudioDoc` MINUS its ephemeral cross-filter and
 * interactive-scoped filter entries: it spreads every doc field (so a newly-added
 * `StudioDoc` field is carried automatically — no hand-picked field list to forget it
 * from), stripping the cross-filter- and interactive-scoped filters and normalizing the
 * empties-are-omitted fields (`relationships`, `expressionFields`, `filterPresets`, `ai`
 * are all omitted from the serialized shape when empty, keeping persisted payloads
 * minimal and symmetric across every optional collection). The two scope kinds have
 * DIFFERENT undo semantics but are
 * both session-scoped and both stripped here: cross-filters are undoable but
 * session-scoped (they time-travel with the doc, so `StudioController` does NOT carry
 * them across undo/redo); interactive entries are carried across undo/redo by
 * `StudioController.carryTransientDocState`. Either way, neither belongs in on-disk
 * state, so both are stripped at this persistence boundary.
 */
export function serializeDoc(doc: StudioDoc): SerializedStudioState {
  const { filters, ...rest } = doc;
  return {
    ...rest,
    filters: filters.filter(
      (f) => f.scope.kind !== 'cross-filter' && f.scope.kind !== 'interactive',
    ),
    relationships: doc.relationships.length > 0 ? doc.relationships : undefined,
    expressionFields: doc.expressionFields.length > 0 ? doc.expressionFields : undefined,
    filterPresets: (doc.filterPresets?.length ?? 0) > 0 ? doc.filterPresets : undefined,
    ai: doc.ai?.threads && doc.ai.threads.length > 0 ? doc.ai : undefined,
  };
}

/**
 * Serializes the studio state for persistence. Reads exclusively from `state.doc`
 * (the only persisted partition), so transient session state (mode/shell), host-app
 * data sources (runtime), and cross-filter/interactive filter entries are all excluded.
 */
export function serializeState(state: StudioState): SerializedStudioState {
  return serializeDoc(state.doc);
}

/**
 * Deserializes and restores a persisted state.
 * Returns the full StudioState with default shell state.
 * @param dataSources - The host app's data sources; not persisted so must be passed in.
 */
export function deserializeState(
  serialized: SerializedStudioState,
  dataSources: StudioRuntime['dataSources'],
  shellOverrides?: Partial<StudioSession['shell']>,
): StudioState {
  const defaultState = createDefaultStudioState();

  const normalizedWidgets = Object.fromEntries(
    Object.entries(serialized.widgets)
      // Screen the persisted widget-record KEYS against the shared prototype-hazard
      // denylist and drop non-record entries. `JSON.parse` happily produces an own
      // `"__proto__"` widget key (and a foreign/hand-edited doc can carry a `null`
      // widget); an unsafe key would survive `Object.fromEntries` as an own property and
      // then get inconsistent downstream treatment in the reducer, and a `null` widget
      // would throw `Cannot read properties of null (reading 'config')` in the map below.
      // Persisted docs are an untrusted boundary (shared/hand-edited dashboards), so this
      // mirrors the wire boundary's own-key screening — dropping the offending entry.
      .filter(
        ([id, widget]) =>
          isSafeKey(id) && widget !== null && typeof widget === 'object' && !Array.isArray(widget),
      )
      .map(([id, widget]) => {
        // Reconcile the widget's own `id` field with its record KEY (finding 2.1) and
        // coerce a non-record `config` (finding 2.4) BEFORE the legacy-shape normalization
        // below. Both are load-boundary invariants the reducer relies on but never gets a
        // chance to enforce for a hand-edited/shared doc:
        //  - The reducer's every id-keyed lookup/delete/cross-filter-cleanup keys off the
        //    RECORD KEY, and BOTH the wire boundary and the reducer reject a `changes.id`
        //    precisely to keep `widget.id` in sync with its key. A doc where the desync
        //    ALREADY exists (`widgets: { "w-a": { "id": "w-b", … } }`) would otherwise load
        //    verbatim and silently no-op every subsequent edit/delete of that widget (each
        //    passes `widget.id` back, which no `Object.hasOwn(widgets, id)` guard matches),
        //    and a cross-filter it emits could never be cleaned up. The KEY is the source of
        //    truth, so re-stamp `id: key` (preserving the user's data, matching the
        //    `activePageId` reconciliation style rather than dropping the widget).
        //  - A record widget whose `config` is not a record (a hand-edited `config: null`)
        //    passes the record-widget `.filter` above and, because the reads below use
        //    optional chaining, installs a live widget whose first render throws
        //    (`config.chartType` off `null`). `deserializeState` is a public, directly-
        //    callable "total over nested-corrupt docs" surface, so coerce the junk config to
        //    `{}` here — the gentler, relationships-style coercion — instead of shipping a
        //    widget that crashes the canvas at first paint.
        const rawConfig = (widget as { config?: unknown }).config;
        const configIsRecord =
          rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig);
        let base = widget;
        if (base.id !== id) {
          base = { ...base, id } as StudioWidget;
        }
        if (!configIsRecord) {
          base = { ...base, config: {} } as StudioWidget;
        }
        // Normalize legacy leaf shapes at the load boundary: grid `columns` (legacy
        // string field ids) and chart `ySeries` (legacy `seriesType` alias). Rebuild
        // `config` only when one is present; otherwise return the widget untouched
        // (keeping reference stability for the common case). This runs across kinds
        // by design (a load-boundary normalizer that doesn't branch on `widget.kind`),
        // so it reads through the flat cross-kind `StudioWidgetConfig` patch type.
        const config = base.config as StudioWidgetConfig;
        const columns = config?.columns;
        const ySeries = config?.ySeries;
        // `Array.isArray` (not truthiness) with a non-empty guard: an empty
        // `columns: []`/`ySeries: []` (the factory defaults) is truthy, so the old
        // `!columns && !ySeries` check rebuilt a fresh, identical config on every
        // load — needless reference churn that defeated the "return the widget
        // untouched" intent. A truthy non-array (a hand-corrupted `columns: "junk"`)
        // was also truthy and then crashed on `.map`; `Array.isArray` leaves it
        // untouched instead (deep config validation is out of scope for this package).
        const hasColumns = Array.isArray(columns) && columns.length > 0;
        const hasYSeries = Array.isArray(ySeries) && ySeries.length > 0;
        if (!hasColumns && !hasYSeries) {
          return [id, base];
        }
        return [
          id,
          {
            ...base,
            config: {
              ...base.config,
              ...(hasColumns ? { columns: columns.map(normalizeGridColumn) } : {}),
              ...(hasYSeries ? { ySeries: ySeries.map(normalizeChartSeries) } : {}),
            },
          },
        ];
      }),
  ) as StudioDoc['widgets'];

  // Sweep the persisted pages (drop prototype-hazard keys / non-record values, clamp
  // layout) BEFORE reconciling `activePageId`, so a page the sweep legitimately drops
  // (a `null` page, a `"__proto__"` key) is accounted for by the reconciliation below.
  const normalizedPages = normalizePersistedPages(serialized.pages, normalizedWidgets);

  // Reconcile a dangling `dashboard.activePageId` at the load boundary, mirroring the
  // exact fallback the factory (`createDefaultStudioState`) and `removePage` already use:
  // the invariant "the active page exists" is enforced everywhere EXCEPT here. A
  // hand-edited `activePageId`, or one orphaned when the sweep above dropped its page,
  // would otherwise render a blank canvas and silently no-op every legacy mutation that
  // falls back to the active page (`addWidget`/`setWidgetLayout` without an explicit
  // `pageId`). `Object.hasOwn` (not `in`) so an untrusted id can't match a prototype member.
  const { dashboard } = serialized;
  const reconciledDashboard = Object.hasOwn(normalizedPages, dashboard.activePageId)
    ? dashboard
    : { ...dashboard, activePageId: Object.keys(normalizedPages)[0] ?? '' };

  // Validate `doc.ai` at the load boundary: keep it only when it is a record whose
  // `threads` is an array, AND screen each thread ENTRY (T2-3) — not just the container.
  // `renameAIThread` does `(state.ai.threads ?? []).map((t) => t.id …)` with NO optional
  // chaining, so a `threads: [null, {…}]` that passes the container `Array.isArray` check
  // still throws `Cannot read properties of null (reading 'id')` on the first rename, and
  // `serializeDoc` re-persists the junk verbatim (`threads.length > 0`), round-tripping the
  // corruption. Drop non-record entries the SAME way the sibling `filters` per-entry screen
  // below does, rather than loading them verbatim. Reference-stable when every surviving
  // thread is already a record; the whole `ai` is dropped to `undefined` when absent/junk.
  let normalizedAi: StudioAIState | undefined;
  if (isRecord(serialized.ai) && Array.isArray((serialized.ai as StudioAIState).threads)) {
    const ai = serialized.ai as StudioAIState;
    const safeThreads = ai.threads.filter((thread) => isRecord(thread));
    normalizedAi = safeThreads.length === ai.threads.length ? ai : { ...ai, threads: safeThreads };
  }

  return {
    doc: {
      // `deserializeState` only ever runs on migrated state (a guarantee `migrateState`
      // now makes real by failing closed), so the doc IS at the current schema version.
      // Stamping the constant keeps the compile-time tie the previous `as 1` cast erased
      // — a version bump now forces this to follow via the type system.
      schemaVersion: CURRENT_SCHEMA_VERSION,
      dashboard: reconciledDashboard,
      // Defensive load-time layout normalization: the reducer maintains layout
      // invariants on every LIVE write, but a corrupted or hand-edited persisted doc can
      // carry phantom `widgetRows` ids, duplicate ids, or out-of-range/orphan
      // `widgetColSpans` that would render blank cards / wrong widths until the next
      // layout mutation happened to prune them. This sweep filters rows against the
      // actual widgets, dedupes ids, clamps spans, and drops orphans — NOT a schema
      // migration (the doc shape is unchanged). Reference-stable for a well-formed doc.
      pages: normalizedPages,
      widgets: normalizedWidgets,
      // Symmetric with `serializeDoc`'s strip: cross-filter- and interactive-scoped
      // filters are session-flavoured and never written to disk, so a hand-edited or
      // foreign doc carrying them must not install them into live `doc.filters` on load.
      // An orphaned cross-filter (whose `scope.sourceWidgetId` names a widget the doc
      // doesn't contain) would otherwise permanently filter its page: the reducer's
      // cleanup for such filters only fires when the source widget is REMOVED, and it was
      // never present, so the page would load pre-filtered with no affordance to clear it.
      //
      // Also DROP any entry that is not a record with a record `scope`: `migrateState`
      // rejects such junk up front, but `deserializeState` is a public API callable on a
      // `SerializedStudioState` directly (its documented "total over nested-corrupt docs"
      // surface), so a `filters: [null]` / `scope: null` entry must be defensively removed
      // here too — otherwise it installs into live `doc.filters` and then throws in
      // `serializeDoc` and the reducer on the next commit.
      filters: serialized.filters.filter(
        (f) =>
          isRecord(f) &&
          isRecord((f as { scope?: unknown }).scope) &&
          (f as { scope: { kind?: unknown } }).scope.kind !== 'cross-filter' &&
          (f as { scope: { kind?: unknown } }).scope.kind !== 'interactive',
      ),
      // Defensive container validation, symmetric with the pages/widgets/filters screening:
      // `?? []` only defaults an ABSENT value, so a hand-edited `relationships: "junk"` /
      // `{}` would install verbatim and then break any client code iterating it (and
      // `serializeDoc`'s `.length > 0` would silently collapse a non-array to `undefined`,
      // discarding it). Coerce a non-array to `[]`.
      relationships: Array.isArray(serialized.relationships) ? serialized.relationships : [],
      expressionFields: Array.isArray(serialized.expressionFields)
        ? serialized.expressionFields
        : [],
      filterPresets: Array.isArray(serialized.filterPresets) ? serialized.filterPresets : [],
      // `doc.ai` validation (container + per-entry) is computed as `normalizedAi` above.
      ai: normalizedAi,
    },
    session: {
      mode: 'edit',
      shell: {
        ...defaultState.session.shell,
        ...shellOverrides,
      },
    },
    runtime: { dataSources },
  };
}
