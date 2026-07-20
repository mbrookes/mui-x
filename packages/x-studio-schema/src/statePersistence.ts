import { createDefaultStudioState, normalizeGridColumn, normalizeChartSeries } from './factories';
import { normalizePersistedPages, hasConflictingRankFilter } from './applyMutation';
import { isSafeKey } from './unsafeKeys';
import { isValidFilterScope, hasUnsafeOwnKeys, isStringArray } from './parseStateMutation';
import { isStudioChartType, isStudioFilterOperator } from './widgetTypeGuards';
import { CURRENT_SCHEMA_VERSION } from './stateTypes';
import type {
  StudioState,
  StudioDoc,
  StudioSession,
  StudioRuntime,
  StudioFilterState,
} from './stateTypes';
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
 * NOTE — the `1→2` examples below illustrate the NEXT bump, not the current registry
 * state: `CURRENT_SCHEMA_VERSION` is presently `1`, so the only registered migration is
 * the `0→1` identity entry in `migrations`. The `1:` snippets show the shape a future
 * `1→2` migration would take when the schema next changes; they are not yet registered.
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
 * Screen each ENTRY of a persisted array with `isRecord`, dropping non-record junk
 * (Finding 1) — the same per-entry screen the `filters`/`ai.threads` load paths already
 * apply, extended to `relationships` and `expressionFields`, whose entries the client
 * iterates on hot paths (`ef.sourceId`, `r.sourceId`) with no optional chaining. A
 * non-array coerces to `[]` (symmetric with the prior container-only coercion).
 * Reference-STABLE: returns the SAME array when every entry survives, so a well-formed
 * doc keeps its identity for cross-load memoization.
 */
const screenRecordArray = <T>(value: unknown): T[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  // Reject non-record entries AND entries carrying a prototype-hazard OWN key (T2-4). The
  // client spreads a relationship/expression-field on hot paths (`{ ...ef }`, `Object.assign`),
  // so an own `"__proto__"`/`"constructor"`/`"prototype"` DATA key (as `JSON.parse` materializes
  // it on a shared/hand-edited doc) is a pollution hazard the wire boundary would reject — drop
  // the whole entry, matching the widgets/filters own-key screen. Reuses the SAME predicate.
  const safe = value.filter((entry) => isRecord(entry) && !hasUnsafeOwnKeys(entry));
  return (safe.length === value.length ? value : safe) as T[];
};

/**
 * Return `record` with any prototype-hazard OWN key ({@link UNSAFE_KEYS}) removed, reference-
 * stable when it carries none (T2-4). Used for the persisted `dashboard`, which `deserializeState`
 * spreads/uses verbatim: a shared/hand-edited doc can carry an own `"__proto__"`/`"constructor"`/
 * `"prototype"` DATA key that would round-trip forever and later poison an `Object.assign`/spread
 * of the dashboard. Drops the offending keys (the widget/filter own-key convention) while keeping
 * the rest of the user's data.
 */
const stripUnsafeOwnKeys = <T extends object>(record: T): T => {
  if (!hasUnsafeOwnKeys(record)) {
    return record;
  }
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSafeKey(key)) {
      safe[key] = value;
    }
  }
  return safe as T;
};

/**
 * Repair (not drop) a persisted/preset filter's `dependsOn` field when it fails the
 * array-shape screen `parseStateMutation.ts`'s `validateFilter` already applies to a LIVE
 * `addFilter` mutation (T2 finding): the wire boundary rejects a malformed `dependsOn`
 * (`dependsOn: 'w1'`, `dependsOn: [1, 2]`) outright, but neither `deserializeState`'s
 * `doc.filters` load screen nor {@link isPresetFilterSafe} applied the same check — so a
 * persisted or preset doc with a malformed `dependsOn` loaded successfully and then crashed
 * `StudioFiltersDrawer`'s `dependsOn.map(...)` the first time the filter rendered.
 * `dependsOn` is optional cascade metadata, not identity data, so — mirroring how a bad
 * widget `titleMode`/`subtitleMode` key is stripped rather than dropping the whole widget —
 * the malformed KEY is dropped from the filter rather than sinking the whole filter entry.
 * Non-record input is returned as-is; the caller's own record screen handles it. Reference-
 * stable when `dependsOn` is absent or already a valid `string[]`.
 */
const repairFilterDependsOn = <T>(entry: T): T => {
  if (!isRecord(entry)) {
    return entry;
  }
  const dependsOn = (entry as { dependsOn?: unknown }).dependsOn;
  if (dependsOn === undefined || isStringArray(dependsOn)) {
    return entry;
  }
  const rest = { ...(entry as Record<string, unknown>) };
  delete rest.dependsOn;
  return rest as T;
};

/**
 * Screen one preset-embedded filter with the SAME semantic checks the `doc.filters` load
 * pass applies to the fields that travel VERBATIM into live `doc.filters` when a preset is
 * applied (T2-3). `@mui/x-studio`'s `docTransforms.applyFilterPreset` rematerializes each
 * preset filter as `{ ...f, id: fresh, scope: page }` — it re-stamps `id`/`scope` but
 * carries `field`/`operator`/`operator2` through unchanged and performs NO validation of its
 * own — so a junk `operator: 'equal'` (a plausible typo for `'equals'`) or `field: 42` would
 * land in live `doc.filters` as an active, fail-open chip the moment the user clicks "apply
 * preset": displayed data silently unfiltered while the UI claims a filter is applied. Screen
 * for it here at load (scope checks are unnecessary — `applyFilterPreset` re-stamps scope).
 */
const isPresetFilterSafe = (entry: unknown): boolean => {
  if (!isRecord(entry)) {
    return false;
  }
  // Reject a preset inner filter carrying a prototype-hazard OWN key (T2-4). This is the
  // sharpest asymmetry: `applyFilterPreset` rematerializes each preset filter into live
  // `doc.filters` via `{ ...f, id: fresh, scope: page }`, so an own `"__proto__"` key would
  // land on a LIVE filter, and the NEXT load's filter own-key screen then silently drops that
  // whole filter. Screen it here so the two boundaries agree. Reuses the SAME predicate.
  if (hasUnsafeOwnKeys(entry)) {
    return false;
  }
  if (typeof entry.field !== 'string') {
    return false;
  }
  if (!isStudioFilterOperator(entry.operator)) {
    return false;
  }
  if (entry.operator2 !== undefined && !isStudioFilterOperator(entry.operator2)) {
    return false;
  }
  return true;
};

/**
 * Screen persisted `filterPresets` (Finding 1, nested sibling site): drop any entry that
 * is not a record with an array `filters`, AND screen each preset's own `filters` array with
 * {@link isPresetFilterSafe} — record-ness (a `null` inner filter entry crashes
 * `applyFilterPreset`'s id-remap loop `idMap.set(f.id, …)` the same way a top-level junk
 * entry does) PLUS the `field`/`operator`/`operator2` semantic checks (T2-3), because those
 * fields travel verbatim into live `doc.filters` via `applyFilterPreset`, one indirection past
 * the `doc.filters` load screen. Reference-stable at both levels: returns the SAME outer array
 * (and the SAME inner `filters` array on each surviving preset) when nothing is dropped.
 */
const screenFilterPresets = (value: unknown): StudioDoc['filterPresets'] => {
  if (!Array.isArray(value)) {
    return [];
  }
  let changed = false;
  const safe: unknown[] = [];
  for (const preset of value) {
    if (!isRecord(preset) || !Array.isArray(preset.filters)) {
      changed = true;
      continue;
    }
    const innerFilters = preset.filters;
    // Repair a malformed `dependsOn` (T2 finding) BEFORE the `isPresetFilterSafe` gate —
    // `dependsOn` is not one of that predicate's checks, and dropping the KEY rather than
    // rejecting the whole entry keeps a preset filter that is otherwise well-formed.
    const repairedInner = innerFilters.map((entry) => repairFilterDependsOn(entry));
    const safeInner = repairedInner.filter((entry) => isPresetFilterSafe(entry));
    const innerUnchanged =
      safeInner.length === innerFilters.length &&
      safeInner.every((entry, i) => entry === innerFilters[i]);
    if (innerUnchanged) {
      safe.push(preset);
    } else {
      changed = true;
      safe.push({ ...preset, filters: safeInner });
    }
  }
  return (changed ? safe : value) as StudioDoc['filterPresets'];
};

/**
 * The fields a fully-migrated `SerializedStudioState` must carry, checked fail-closed
 * AFTER migration so a partial or nested-corrupt persisted doc is rejected cleanly here
 * (with a named field) instead of crashing later inside `deserializeState`. Returns the
 * name of the first missing/mis-typed field, or `null` when all are present.
 *
 * The check is not only top-level: `migrateState`'s documented contract is that a corrupt
 * doc is rejected here with a NAMED field rather than crashing in `deserializeState`, so a
 * shallow per-entry shape check is applied to `pages[*]` — each must be a record with an
 * array `widgetRows`. A junk shape one level down (`pages.p1.widgetRows: "junk"`) previously
 * passed migration and then threw an uncaught `TypeError` inside the load-boundary sweep.
 *
 * `widgets[*]` gets NO equivalent per-entry hard-fail here (T3 finding — this used to hard-
 * fail the WHOLE doc on `!isRecord(widget)` or `!isRecord(widget.config)`, sinking every
 * page/widget in the dashboard over ONE bad entry). Checked against `deserializeState`'s
 * actual widget pipeline (not assumed): it ALREADY handles both shapes gracefully and
 * per-entry — a non-record widget is dropped (the `isSafeKey(id) && widget !== null &&
 * typeof widget === 'object' && …` screen), and a record widget with a non-record `config`
 * is coerced to `config: {}` (the `configIsRecord` check in the widget `.map`). Hard-failing
 * here for a case the load boundary already repairs one level down is strictly worse than
 * letting it load with the one bad widget dropped/repaired and the rest of the dashboard
 * intact — the SAME graceful-repair-over-hard-fail choice this file makes for
 * `relationships`/`expressionFields`/`filterPresets`/`ai.threads` per-entry junk. (`pages[*]`
 * above is NOT touched by this fix — it is a separate call site, out of this finding's
 * scope, even though `normalizePersistedPages` happens to repair it just as gracefully.)
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
    // CRASH-PREVENTION ONLY — deliberately WEAKER than `isValidFilterScope`. This gate runs
    // inside `migrateState`, the MANDATORY FIRST gate in the load path, and fails HARD (a
    // non-null return sinks the WHOLE dashboard to `{success:false,state:null}`). So it must
    // reject only the shapes that would crash a no-optional-chaining `f.scope.kind` read in
    // `serializeDoc`/the reducer: an entry whose `scope` is not a record, or whose
    // `scope.kind` is not a string. A well-formed-but-incomplete scope (e.g.
    // `scope:{kind:'widget'}` missing `widgetId`) does NOT crash those reads, so it must NOT
    // sink the whole doc here — `deserializeState`'s per-entry `isValidFilterScope` screen
    // (further down) gracefully DROPS just that one filter while loading everything else.
    const scope = filter.scope;
    if (!isRecord(scope) || typeof scope.kind !== 'string') {
      return `filters[${i}].scope`;
    }
  }
  // Per-entry shape checks for the three optional collections (Finding 1), mirroring the
  // `filters` screen above so `migrateState` rejects a junk entry by NAME rather than
  // letting it load and crash the client on first use (and round-trip through every
  // autosave). Each is absent-tolerant (the field is optional in the serialized shape)
  // but, when present, must be an array of records — the client iterates all three on hot
  // paths (`ef.sourceId`, `r.sourceId`, `preset.filters[*].id`) with no optional chaining.
  // `deserializeState` ALSO drops these defensively for its direct-call surface; naming
  // them here is the loud `migrateState` counterpart, exactly as `filters` is treated.
  if (state.relationships !== undefined) {
    if (!Array.isArray(state.relationships)) {
      return 'relationships';
    }
    for (let i = 0; i < state.relationships.length; i += 1) {
      if (!isRecord(state.relationships[i])) {
        return `relationships[${i}]`;
      }
    }
  }
  if (state.expressionFields !== undefined) {
    if (!Array.isArray(state.expressionFields)) {
      return 'expressionFields';
    }
    for (let i = 0; i < state.expressionFields.length; i += 1) {
      if (!isRecord(state.expressionFields[i])) {
        return `expressionFields[${i}]`;
      }
    }
  }
  if (state.filterPresets !== undefined) {
    if (!Array.isArray(state.filterPresets)) {
      return 'filterPresets';
    }
    for (let i = 0; i < state.filterPresets.length; i += 1) {
      const preset = state.filterPresets[i];
      if (!isRecord(preset) || !Array.isArray(preset.filters)) {
        return `filterPresets[${i}]`;
      }
      for (let j = 0; j < preset.filters.length; j += 1) {
        if (!isRecord(preset.filters[j])) {
          return `filterPresets[${i}].filters[${j}]`;
        }
      }
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
      .filter(([id, widget]) => {
        if (
          !(
            isSafeKey(id) &&
            widget !== null &&
            typeof widget === 'object' &&
            !Array.isArray(widget)
          )
        ) {
          return false;
        }
        // Screen the persisted widget object's OWN top-level keys against the
        // prototype-hazard denylist (Finding T2-1), symmetric with the wire boundary's
        // `hasUnsafeOwnKeys(widget)` rejection in `validateWidget`. `JSON.parse` on a
        // shared/hand-edited doc materializes an own `"__proto__"`/`"constructor"`/
        // `"prototype"` key as a real own DATA property (not the inherited accessor); such
        // a widget passes load verbatim today, round-trips through `serializeDoc`, and an
        // `Object.assign({}, loadedWidget)`/spread of it then poisons the target's
        // prototype. The wire boundary already rejects the whole widget for this, so follow
        // the same fail-closed drop-invalid-entry convention here (matching the config-key
        // drop just below). Reuses the SAME `hasUnsafeOwnKeys` predicate.
        if (hasUnsafeOwnKeys(widget)) {
          return false;
        }
        // Screen the persisted widget's OWN `config` keys against the prototype-hazard
        // denylist (Finding 3.2), symmetric with the wire boundary's
        // `hasUnsafeOwnKeys(widget.config)` rejection in `validateWidget`. A hand-edited/
        // shared doc can carry an own `"__proto__"`/`"constructor"`/`"prototype"` config
        // key that `JSON.parse` materializes as a real own property; the reducer rebuilds
        // config key-by-key on later edits, so such a key is a pollution hazard the wire
        // boundary rejects outright. Follow the load boundary's fail-closed drop-invalid-
        // entry convention (as for a `null`/unsafe-KEY widget above): drop the whole
        // widget rather than load a config the wire boundary would refuse. Reuses the SAME
        // `hasUnsafeOwnKeys` predicate the wire boundary uses.
        const cfg = (widget as { config?: unknown }).config;
        if (isRecord(cfg) && hasUnsafeOwnKeys(cfg)) {
          return false;
        }
        // Drop a persisted widget whose `kind`/`title` is missing or non-string,
        // symmetric with the wire boundary's `isString(widget.kind)`/`isString(widget.title)`
        // gate in `validateWidget` (`parseStateMutation.ts`). Both fields are load-bearing —
        // the widget factory/renderer key off `kind`, and the canvas card renders `title` —
        // and are read with no fallback, so a hand-edited/foreign doc carrying `kind: 42` or
        // an absent `title` would otherwise load a widget the byte-identical wire payload is
        // rejected for, and likely crash on first render. Drop the whole widget, matching the
        // fail-closed convention every other structural check in this filter already applies.
        if (
          typeof (widget as { kind?: unknown }).kind !== 'string' ||
          typeof (widget as { title?: unknown }).title !== 'string'
        ) {
          return false;
        }
        return true;
      })
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
        //    callable surface that is total over nested corruption of an otherwise
        //    top-level-well-formed `SerializedStudioState` (it assumes the four top-level
        //    containers are present — that top-level shape is guaranteed upstream by
        //    `migrateState`), so coerce the junk config to `{}` here — the gentler,
        //    relationships-style coercion — instead of shipping a widget that crashes the
        //    canvas at first paint.
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
        // Screen the widget-level `titleMode`/`subtitleMode` at the load boundary (Finding
        // T3-1), symmetric with the wire boundary's `isOptionalTitleMode` gate on these same
        // two fields (`parseStateMutation.ts`). A hand-edited/shared `titleMode: 42` passes
        // the record-widget `.filter` above and would load VERBATIM into the client's
        // auto-title logic, which branches on `widget.titleMode`/`subtitleMode` — so a
        // non-`'auto'|'manual'` value silently steers that logic while the byte-identical
        // wire payload is rejected. Drop the offending KEY (mirroring the junk-`chartType`
        // key-drop below, not a widget-dropping coercion) so the widget loads without it and
        // the `'auto'` default applies. Reference-stable when both fields are already valid.
        for (const modeKey of ['titleMode', 'subtitleMode'] as const) {
          const modeValue = (base as unknown as Record<string, unknown>)[modeKey];
          if (modeValue !== undefined && modeValue !== 'auto' && modeValue !== 'manual') {
            const nextBase = { ...base };
            delete (nextBase as unknown as Record<string, unknown>)[modeKey];
            base = nextBase as StudioWidget;
          }
        }
        // Screen the widget-level `subtitle`/`sourceId` at the load boundary (finding 3),
        // symmetric with the wire boundary's `isOptionalString(widget.subtitle)`/
        // `isOptionalString(widget.sourceId)` gates in `validateWidget` (`parseStateMutation.ts`).
        // Both are OPTIONAL fields the record-widget `.filter` above never checked, so a
        // hand-edited/shared `subtitle: 42` or `sourceId: 42` previously loaded VERBATIM: a
        // junk `subtitle` crashes `StudioWidgetEditDialog`, which renders it directly as
        // text with no fallback, and a junk `sourceId` silently breaks the widget-to-data-
        // source lookup with no self-heal — while the byte-identical wire payload is
        // rejected. Drop the offending KEY (the same "strip, don't sink the whole widget"
        // convention the `titleMode`/`subtitleMode` loop above uses) so the widget loads
        // without it and the "no subtitle"/"no explicit source" fallback applies.
        // Reference-stable when both fields are already valid or absent.
        for (const stringKey of ['subtitle', 'sourceId'] as const) {
          const stringValue = (base as unknown as Record<string, unknown>)[stringKey];
          if (stringValue !== undefined && typeof stringValue !== 'string') {
            const nextBase = { ...base };
            delete (nextBase as unknown as Record<string, unknown>)[stringKey];
            base = nextBase as StudioWidget;
          }
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
        // Membership-check the closed `chartType` union at the load boundary (Finding 2),
        // symmetric with the wire boundary's `isStudioChartType` gate. A hand-edited
        // `chartType: 'trendline'` would otherwise render a blank/default chart AND wedge
        // the next AI `update_widget` (the middleware hard-errors on an unknown stored
        // chartType). Drop the offending key so `resolveChartType`'s `'bar'` fallback
        // applies — the same "leave junk for the fallback/validation" treatment junk
        // `columns` gets, not a widget-dropping coercion.
        const hasBadChartType =
          Object.hasOwn(config, 'chartType') &&
          !(typeof config.chartType === 'string' && isStudioChartType(config.chartType));
        if (!hasColumns && !hasYSeries && !hasBadChartType) {
          return [id, base];
        }
        // Track whether any entry actually changed (the pattern `normalizeConfigChartSeries`
        // uses in `applyMutation.ts`): a non-empty but already-canonical `columns`/`ySeries`
        // — the common case for every configured grid/chart widget — must NOT mint a fresh
        // array (and hence a fresh config and widget) on every load, or cross-load
        // memoization is defeated (Finding 5). `.map(normalize…)` alone always allocates.
        let changed = hasBadChartType;
        let nextColumns = columns;
        if (hasColumns) {
          nextColumns = columns.map((column) => {
            const normalized = normalizeGridColumn(column);
            if (normalized !== column) {
              changed = true;
            }
            return normalized;
          });
        }
        let nextYSeries = ySeries;
        if (hasYSeries) {
          nextYSeries = ySeries.map((series) => {
            const normalized = normalizeChartSeries(series);
            if (normalized !== series) {
              changed = true;
            }
            return normalized;
          });
        }
        if (!changed) {
          return [id, base];
        }
        const nextConfig = {
          ...base.config,
          ...(hasColumns ? { columns: nextColumns } : {}),
          ...(hasYSeries ? { ySeries: nextYSeries } : {}),
        } as StudioWidgetConfig;
        if (hasBadChartType) {
          delete nextConfig.chartType;
        }
        return [id, { ...base, config: nextConfig }];
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
  // Strip prototype-hazard OWN keys from the persisted dashboard (T2-4) BEFORE it is spread
  // into live state below. A shared/hand-edited doc can carry an own `"__proto__"`/
  // `"constructor"`/`"prototype"` DATA key that `deserializeState` would otherwise use verbatim
  // and round-trip forever, later poisoning an `Object.assign`/spread of the dashboard. Drop the
  // offending keys (the widgets/filters own-key convention) rather than the whole dashboard.
  const dashboard = stripUnsafeOwnKeys(serialized.dashboard);
  // Coerce a missing/non-string `dashboard.title` to the same `'Untitled Dashboard'`
  // fallback the factory uses (the dashboard-title sibling of `normalizePersistedPages`'s
  // page-title coercion): `addDashboard`-adjacent mutations (`setDashboardTitle` et al.)
  // already require a string `title` at the wire/reducer boundary, so a non-string value
  // can only reach here via a hand-edited/foreign persisted doc — one `migrateState`'s
  // `findMissingRequiredField` does not check (it only validates `pages[*].widgetRows`).
  // Left uncoerced, the junk value would install verbatim and crash the first component
  // that renders `dashboard.title` as text.
  const safeDashboardTitle =
    typeof dashboard.title === 'string' ? dashboard.title : 'Untitled Dashboard';
  const activePageIdValid = Object.hasOwn(normalizedPages, dashboard.activePageId);
  const reconciledDashboard =
    activePageIdValid && safeDashboardTitle === dashboard.title
      ? dashboard
      : {
          ...dashboard,
          title: safeDashboardTitle,
          activePageId: activePageIdValid
            ? dashboard.activePageId
            : (Object.keys(normalizedPages)[0] ?? ''),
        };

  // Validate `doc.ai` at the load boundary: keep it only when it is a record whose
  // `threads` is an array, AND screen each thread ENTRY (T2-3) — not just the container.
  // `renameAIThread` does `(state.ai.threads ?? []).map((t) => t.id …)` with NO optional
  // chaining, so a `threads: [null, {…}]` that passes the container `Array.isArray` check
  // still throws `Cannot read properties of null (reading 'id')` on the first rename, and
  // `serializeDoc` re-persists the junk verbatim (`threads.length > 0`), round-tripping the
  // corruption. Drop non-record entries the SAME way the sibling `filters` per-entry screen
  // below does, rather than loading them verbatim. Reference-stable when every surviving
  // thread is already a record; the whole `ai` is dropped to `undefined` when absent/junk.
  //
  // Also screen the `ai` container AND each surviving thread for prototype-hazard OWN keys
  // (T2-4): `renameAIThread` spreads both (`{ ...state.ai, threads: … }`, `{ ...t, name }`), so
  // an own `"__proto__"`/`"constructor"`/`"prototype"` DATA key would round-trip forever and
  // poison a later spread. The container's unsafe keys are stripped (keeping the rest of `ai`);
  // a thread carrying one is dropped whole, matching the sibling per-entry own-key screens.
  let normalizedAi: StudioAIState | undefined;
  if (isRecord(serialized.ai) && Array.isArray((serialized.ai as StudioAIState).threads)) {
    const ai = stripUnsafeOwnKeys(serialized.ai as StudioAIState);
    const safeThreads = ai.threads.filter(
      (thread) => isRecord(thread) && !hasUnsafeOwnKeys(thread),
    );
    normalizedAi = safeThreads.length === ai.threads.length ? ai : { ...ai, threads: safeThreads };
  }

  // Repair a malformed `dependsOn` (T2 finding) BEFORE the structural filter screen below:
  // `dependsOn` is optional cascade metadata, not identity data, so a malformed value
  // (`dependsOn: 'w1'`, `dependsOn: [1, 2]`) is stripped from the filter object rather than
  // sinking the whole entry — mirroring how a bad widget `titleMode`/`subtitleMode` key is
  // stripped rather than dropping the whole widget. Left unrepaired, the malformed field
  // would load successfully and later crash `StudioFiltersDrawer`'s `dependsOn.map(...)` the
  // first time the filter rendered. Non-record entries pass through untouched — the
  // structural screen below drops them for other reasons.
  const dependsOnRepairedFilters = serialized.filters.map((f) => repairFilterDependsOn(f));
  // Symmetric with `serializeDoc`'s strip: cross-filter- and interactive-scoped
  // filters are session-flavoured and never written to disk, so a hand-edited or
  // foreign doc carrying them must not install them into live `doc.filters` on load.
  // An orphaned cross-filter (whose `scope.sourceWidgetId` names a widget the doc
  // doesn't contain) would otherwise permanently filter its page: the reducer's
  // cleanup for such filters only fires when the source widget is REMOVED, and it was
  // never present, so the page would load pre-filtered with no affordance to clear it.
  //
  // Also DROP any entry with an invalid `scope`: `migrateState` rejects such junk up
  // front, but `deserializeState` is a public API callable on a `SerializedStudioState`
  // directly (its documented surface is total over nested corruption of an otherwise
  // top-level-well-formed `SerializedStudioState` — it assumes the four top-level
  // containers are present, a shape `migrateState` guarantees upstream), so a
  // `filters: [null]` / `scope: null` entry must be defensively removed here too —
  // otherwise it installs into live `doc.filters` and then throws in `serializeDoc` and
  // the reducer on the next commit.
  const screenedFilters = dependsOnRepairedFilters.filter((f) => {
    if (!isRecord(f)) {
      return false;
    }
    // Screen the persisted filter object's OWN keys against the prototype-hazard
    // denylist (Finding T2-2), symmetric with the wire boundary's `hasUnsafeOwnKeys`
    // gate now added to `validateFilter` in `parseStateMutation.ts`. The reducer's
    // `addFilter` appends a filter verbatim (`[...state.filters, args.filter]`), and a
    // persisted `filters` array is an untrusted boundary (`JSON.parse` on a shared/
    // hand-edited doc materializes an own `"__proto__"`/`"constructor"`/`"prototype"`
    // key as a real own DATA property). Drop the entry here so the byte-identical wire
    // payload and the load payload agree. Reuses the SAME `hasUnsafeOwnKeys` predicate.
    if (hasUnsafeOwnKeys(f)) {
      return false;
    }
    // Drop a persisted filter whose `id` is not a string (Finding 3.2), symmetric with
    // the wire boundary's `isSafeId(filter.id)` gate in `validateFilter`. A non-string
    // `id` (a hand-edited `id: 42`) can NEVER be matched by wire `removeFilter` (whose
    // `f.id !== filterId` compares against a string `filterId`), so it would install a
    // permanently-unremovable filter — exactly the state the wire boundary rejects for
    // the byte-identical payload.
    if (typeof (f as { id?: unknown }).id !== 'string') {
      return false;
    }
    const scope = (f as { scope?: unknown }).scope;
    // Full scope validity — record-ness, kind membership AND every required id field
    // present — via the ONE shared predicate the wire boundary uses (Finding T3-1),
    // replacing the prior record + kind-only check. An unknown kind like `'pages'`
    // would otherwise load as a permanent inert entry that escapes `removePage`/
    // `dropWidgetScopedFilters` cleanup (both key off the known kinds); a scope missing
    // a required id (e.g. a `dashboard-date-range` without `sourceId`, which would
    // mis-apply a date window) is now dropped here exactly as the wire boundary rejects
    // the byte-identical payload.
    if (!isValidFilterScope(scope)) {
      return false;
    }
    // Symmetric with `serializeDoc`'s strip: cross-filter/interactive entries are
    // session-flavoured and never persisted, so an orphaned one hand-carried into a
    // foreign doc must not install (it would permanently filter its page with no
    // affordance to clear it — the reducer's cleanup only fires on widget REMOVAL).
    if (scope.kind === 'cross-filter' || scope.kind === 'interactive') {
      return false;
    }
    // Drop a filter anchored to a `pageId` that no longer exists in `normalizedPages` —
    // the PAGE-anchor mirror of the widget-anchor orphan check just below. A `page`-scoped
    // filter with an explicit `pageId`, or a `dashboard-date-range` filter (whose `pageId`
    // is required), naming a page the doc doesn't contain would otherwise be permanent
    // dead weight with no clearing affordance: the reducer's page-anchor cleanup
    // (`removePage`'s `filtersAfterPageDrop` in `applyMutation.ts`) only runs for a LIVE
    // `removePage` mutation, never for a doc that already lacks the page on load (a
    // hand-edited/foreign doc, or a page dropped by the sweep above for carrying an
    // unsafe key). A `page`-scoped filter with NO `pageId` (the legacy "applies on every
    // page" shape) is left alone. `Object.hasOwn` so an untrusted `pageId` can't match a
    // prototype member.
    if (
      (scope.kind === 'page' || scope.kind === 'dashboard-date-range') &&
      scope.pageId !== undefined &&
      !Object.hasOwn(normalizedPages, scope.pageId)
    ) {
      return false;
    }
    // Drop an ORPHAN `widget`-scoped filter whose `widgetId` names no loaded widget (T3-2),
    // symmetric with the reducer's `addFilter` guard. Its only cleanup path
    // (`dropWidgetScopedFilters`) fires on widget REMOVAL, which never happens for a widget
    // that was never present, so it would otherwise be permanent invisible dead weight that
    // filters its page forever. `Object.hasOwn` so an untrusted `widgetId` can't match a
    // prototype member.
    if (scope.kind === 'widget' && !Object.hasOwn(normalizedWidgets, scope.widgetId)) {
      return false;
    }
    // Field-is-a-string check (T2-3), symmetric with the wire boundary at
    // `parseStateMutation.ts` ("a junk value like `field: 42` … would install an
    // active-but-unevaluable filter that silently renders every widget in scope
    // empty"). A hand-edited `field: 42` in persisted `filters` would otherwise load
    // and produce that exact state, while the identical wire payload is rejected —
    // drop the entry here so the two boundaries agree.
    const record = f as { field?: unknown; operator?: unknown; operator2?: unknown };
    if (typeof record.field !== 'string') {
      return false;
    }
    // Membership-check the closed `operator` union (Finding 2), symmetric with the
    // wire boundary's `isStudioFilterOperator` gate: a hand-edited `operator: 'equal'`
    // (a plausible typo for `'equals'`) would otherwise install a chip that renders as
    // ACTIVE while filtering nothing — a silent fail-open. A present `operator2` is
    // held to the same membership check (absent stays legal).
    if (!isStudioFilterOperator(record.operator)) {
      return false;
    }
    if (record.operator2 !== undefined && !isStudioFilterOperator(record.operator2)) {
      return false;
    }
    return true;
  });

  // Re-check rank-filter per-page uniqueness at the load boundary (finding 9): the
  // reducer's `addFilter` enforces "at most one rank filter per page context" on every
  // LIVE add (`hasConflictingRankFilter`), but that check was never re-run on load, so a
  // hand-edited/foreign doc could load with two conflicting rank filters on the same page
  // (or the legacy pageId-less "applies on every page" shape). Keep the FIRST rank filter
  // for each page context in array order and drop any later one that conflicts with it,
  // reusing the exact predicate `addFilter` uses so load-time and live-mutation-time
  // enforcement agree. Reference-stable: returns the SAME array when nothing conflicts.
  let rankFiltersChanged = false;
  const dedupedFilters: StudioFilterState[] = [];
  for (const filter of screenedFilters) {
    if (
      filter.filterMode === 'rank' &&
      hasConflictingRankFilter(filter.id, filter, dedupedFilters, normalizedPages)
    ) {
      rankFiltersChanged = true;
      continue;
    }
    dedupedFilters.push(filter);
  }
  const finalFilters = rankFiltersChanged ? dedupedFilters : screenedFilters;

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
      filters: finalFilters,
      // Defensive PER-ENTRY screening, symmetric with the pages/widgets/filters/ai.threads
      // screens (Finding 1): the prior code coerced only the CONTAINER (`Array.isArray ?
      // value : []`), so a hand-edited `relationships: [null]` / `expressionFields: [null]`
      // installed verbatim and then crashed the client on first use — `ef.sourceId` /
      // `r.sourceId` are read with NO optional chaining on hot paths — while `serializeDoc`
      // re-persisted the junk forever (its `.length > 0` checks are also container-only).
      // `screenRecordArray` drops non-record entries (and coerces a non-array to `[]`),
      // reference-stable when every entry survives. `filterPresets` additionally requires
      // each entry to carry an array `filters` and screens that nested array too — a
      // well-formed preset with a `null` inner filter crashes `applyFilterPreset` the same way.
      relationships: screenRecordArray<StudioDoc['relationships'][number]>(
        serialized.relationships,
      ),
      expressionFields: screenRecordArray<StudioExpressionField>(serialized.expressionFields),
      filterPresets: screenFilterPresets(serialized.filterPresets),
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
