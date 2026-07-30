import { createDefaultStudioState, normalizeGridColumn, normalizeChartSeries } from './factories';
import { normalizePersistedPages, pruneDependsOn } from './applyMutation';
// The rank-uniqueness sweep is shared with the reducer's layout handlers AND with
// `factories.ts` — see `rankFilterScope.ts` for why it lives in its own dependency-free
// module rather than in `applyMutation.ts` where it started.
import { dedupeRankFilters } from './rankFilterScope';
import { isPlainRecord as isRecord } from './internalGuards';
// The per-ENTRY screens a `StudioDoc` must pass are shared with the OTHER producer of a doc
// (`createDefaultStudioState`, reachable from the public `Studio initialState` prop) — see
// `docScreening.ts`. This file keeps only the three things that module cannot own: the
// legacy leaf-shape normalization (which lives in `factories.ts`), the page sweep and rank
// re-check (which live in `applyMutation.ts`), and the id reconciliations that need the
// FINAL page map.
import {
  screenAIState,
  screenDashboard,
  screenExpressionFields,
  screenFilterPresets,
  screenFilters,
  screenRelationships,
  screenWidgets,
} from './docScreening';
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
  //
  // THE IDENTITY IS DELIBERATE, NOT AN OVERSIGHT. v0 is a PRE-RELEASE version: `@mui/x-studio`
  // has never shipped a released state format, so no persisted doc anywhere is at v0 and there
  // is nothing for this step to transform. In particular, the reshape `StudioFilterScope`'s
  // `dashboard-date-range` doc comment refers to (`{ isDashboardDateRange: true,
  // filterSourceId }` → `{ kind: 'dashboard-date-range', sourceId, pageId }`) happened while
  // the schema was still in development — `git log -S isDashboardDateRange` shows the field
  // introduced and removed entirely within the unreleased window, before this package existed
  // — so it needs NO migration entry and MUST NOT get a version bump: bumping to v2 for a shape
  // no persisted doc can contain would only add a migration step that can never fire, plus a
  // fixture test asserting a transform of data that does not exist.
  //
  // The moment the state format DOES ship, the policy in this registry's doc comment applies
  // in full: any breaking `StudioDoc` reshape gets a `CURRENT_SCHEMA_VERSION` bump, a real
  // migration keyed by the OLD version, and a v(N) fixture test.
  0: (state) => ({ ...state, schemaVersion: 1 }),
};

/**
 * The old-version numbers the migration registry covers, exported so a completeness
 * test can pin that every version in `0 … CURRENT_SCHEMA_VERSION − 1` has a migration
 * entry — the check that actually catches a forgotten entry when the version is bumped.
 */
export const REGISTERED_MIGRATION_VERSIONS = Object.keys(migrations).map(Number);

/**
 * The migration registry itself, exported for TESTS ONLY (deliberately NOT re-exported from
 * `index.ts`, unlike every other name in this file's public surface).
 *
 * `migrateState`'s fail-closed guarantees are about what a REGISTERED migration may do wrong
 * — throw, leave a required field missing, forget to stamp `schemaVersion` — and every one of
 * those is unreachable from the outside while the only registered entry is the well-behaved
 * `0 → 1` identity. A test that cannot register a misbehaving migration cannot exercise those
 * guards at all, which is how the `schemaVersion` post-condition came to be the one clause of
 * the registry's documented contract with no check behind it.
 *
 * A test that mutates this MUST restore the original entry afterwards (the object is shared
 * module state).
 */
export const MIGRATION_REGISTRY_FOR_TESTS = migrations;

/**
 * Validates that a persisted state value has the minimum required structure to be read as a
 * record — the shape guard `migrateState` runs before any keyed access.
 *
 * Delegates to the SHARED `isPlainRecord`, like every other boundary in this package. The
 * hand-rolled `!state || typeof state !== 'object'` it used to be made the
 * `state is Record<string, unknown>` predicate UNSOUND: an array and an exotic object
 * (`Date`/`Map`/class instance) both pass `typeof … === 'object'`, so both were narrowed to
 * a plain record they are not. Harmless in practice — `findMissingRequiredField` rejects an
 * array on the very next line, for a missing `"dashboard"` — but an unsound predicate is a
 * trap for the next reader, and this was the one boundary not reading the shared guard.
 */
function validateStateStructure(state: unknown): state is Record<string, unknown> {
  return isRecord(state);
}

/**
 * The fields a fully-migrated `SerializedStudioState` must carry, checked fail-closed
 * AFTER migration so a partial or nested-corrupt persisted doc is rejected cleanly here
 * (with a named field) instead of crashing later inside `deserializeState`. Returns the
 * name of the first missing/mis-typed field, or `null` when all are present.
 *
 * The check is not only top-level: `migrateState`'s documented contract is that a corrupt
 * doc is rejected here with a NAMED field rather than crashing in `deserializeState`, so a
 * shallow per-entry shape check is applied for the shapes that would CRASH a
 * no-optional-chaining read before the load boundary could repair them — a `pages[*]` that is
 * not a record, a `filters[*]` that is not a record.
 *
 * The line between "hard-fail the whole doc" and "degrade to a per-entry repair" is drawn by
 * one rule: if a load-boundary handler ALREADY repairs the defect gracefully and per-entry
 * (dropping/coercing just the bad entry) BEFORE any crash-prone read runs, hard-failing the
 * WHOLE dashboard over that one entry is strictly worse, so it is NOT rejected here. Cases
 * that fall on the graceful-degradation side and are therefore deliberately NOT checked:
 *  - `widgets[*]` (T3 finding): a non-record widget is dropped and a non-record `config` is
 *    coerced to `{}` by `deserializeState`'s widget pipeline.
 *  - `pages[*].widgetRows` (this fix): a non-array `widgetRows` is coerced to `[]` per-page by
 *    `normalizePersistedPages`.
 *  - `filters[*].scope` (this fix): a non-record `scope` (or one whose `kind` is not a string)
 *    is dropped per-entry by `deserializeState`'s `isValidFilterScope` screen, which runs
 *    before `serializeDoc`/the reducer ever read `f.scope.kind`.
 * All three mirror the SAME graceful-repair-over-hard-fail choice this file already makes for
 * `relationships`/`expressionFields`/`filterPresets`/`ai.threads` per-entry junk.
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
    // NOTE (iteration 22 precedent): a non-array `page.widgetRows` is deliberately NOT
    // hard-failed here. `normalizePersistedPages` (the load boundary) already coerces a junk
    // `widgetRows` to `[]` gracefully and per-entry (non-array → `[]`, non-array/orphan rows
    // filtered) when it runs, so sinking the WHOLE dashboard to `{success:false,state:null}`
    // over ONE page's junk `widgetRows` was strictly worse than letting it load with just
    // that page's rows coerced and every other page/widget in the dashboard intact. This
    // mirrors the SAME graceful-repair-over-hard-fail choice already made one level up for a
    // null/non-record widget value (see the `widgets` note above) and for
    // `relationships`/`expressionFields`/`filterPresets`/`ai.threads` per-entry junk.
  }
  // Per-entry shape check for `filters`, the same one-level-down validation applied to
  // `pages`/`widgets` above. `serializeDoc` (the autosave AND undo-snapshot path) and the
  // reducer (`dropWidgetScopedFilters`, `addFilter`, `removePage`) all read `f.id` (and
  // `f.scope.kind`) with NO optional chaining, so a non-record `filters` entry (`filters:
  // [null]` / a primitive) that slipped through migration would load fine and then throw an
  // uncaught `TypeError` on every subsequent save, undo snapshot, and widget removal —
  // deferred, repeated data loss, strictly worse than being rejected at load. Reject the
  // non-record entry here with a named field, matching the pages/widgets treatment. (A
  // malformed `scope` on an OTHERWISE-record entry is handled per-entry by `deserializeState`
  // and deliberately not hard-failed — see the note inside the loop.)
  for (let i = 0; i < state.filters.length; i += 1) {
    const filter = state.filters[i];
    if (!isRecord(filter)) {
      return `filters[${i}]`;
    }
    // NOTE (same iteration-22 precedent as `pages[*].widgetRows` above): a malformed
    // `filter.scope` (a non-record `scope`, or one whose `scope.kind` is not a string) is
    // deliberately NOT hard-failed here. `deserializeState`'s per-entry filter screen already
    // DROPS any entry failing `isValidFilterScope` while loading everything else, when it
    // runs — and it runs BEFORE `serializeDoc`/the reducer ever read `f.scope.kind`, so the
    // bad-scope entry never reaches the no-optional-chaining reads that motivated the old
    // hard-fail. Sinking the WHOLE dashboard over ONE filter's bad scope was strictly worse
    // than dropping just that filter, so degrade to per-entry drop here too — matching the
    // graceful-repair choice made for the `widgets`/`pages[*].widgetRows` paths above and for
    // `relationships`/`expressionFields`/`filterPresets`/`ai.threads` per-entry junk. (A
    // non-record `filter` itself is still rejected above: `deserializeState`'s screen drops it
    // too, but this finding scoped the relaxation to `scope` only.)
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
 * Migrates state from an older schema version to the current version.
 *
 * Every string this returns in `MigrationResult.errors` is prefixed `MUI X Studio:` and
 * follows the same what-happened / why-it-matters / how-to-fix shape as a THROWN error,
 * even though these are returned data rather than thrown (so they carry no error code and
 * are not minified). The newer-version case in particular reuses `deserializeState`'s
 * thrown text verbatim: it is the one failure both entry points can report, `migrateState`
 * is the entry point the reference hosts actually call, and the two had drifted — the
 * returned copy had lost both the prefix and the "upgrade @mui/x-studio" clause that tells
 * the user what to do about it.
 */
export function migrateState(state: unknown): MigrationResult {
  const errors: string[] = [];

  if (!validateStateStructure(state)) {
    return {
      success: false,
      state: null,
      fromVersion: 0,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors: ['MUI X Studio: Invalid state structure: expected an object.'],
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
        `MUI X Studio: Invalid persisted state: "schemaVersion" must be an integer or absent, ` +
          `received ${typeof rawVersion === 'number' ? String(rawVersion) : JSON.stringify(rawVersion)}. ` +
          `A non-integer version cannot be matched to a migration step, so the doc cannot be safely upgraded.`,
      ],
    };
  }
  const fromVersion = typeof rawVersion === 'number' ? rawVersion : 0;

  // Cannot migrate from a newer version. Checked BEFORE the clone below so a doc this
  // build can never understand costs nothing to reject.
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    return {
      success: false,
      state: null,
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors: [
        `MUI X Studio: Cannot migrate from schema version ${fromVersion} to ${CURRENT_SCHEMA_VERSION}. ` +
          'The state was created with a newer version of X Studio. ' +
          'Loading it here would read only the fields this version knows, drop the rest, and re-save the ' +
          'result at the older version, permanently losing the newer data. ' +
          'Upgrade @mui/x-studio to a version that understands this schema.',
      ],
    };
  }

  // Deep-copy the caller's object ONCE, for BOTH paths (the already-current fast path and
  // the migration loop), so `migrateState` offers a SINGLE isolation guarantee: the
  // returned state never aliases the caller's object.
  //
  // The fast path used to return `state` by reference while only the migration path
  // cloned. Since `CURRENT_SCHEMA_VERSION` is 1, the fast path is the overwhelmingly
  // common case, so in practice the live doc ALIASED the caller's persisted object —
  // `deserializeState` is reference-stable by design, so `loadedDoc.widgets.w1 ===
  // persisted.widgets.w1` and `loadedDoc.relationships === persisted.relationships` both
  // held, and both `loadSerializedState` and `restoreSession` retain the object they were
  // handed. A host that mutated its own persisted object therefore mutated live state and
  // every undo snapshot sharing those sub-objects. Latent today, but two entry paths with
  // different isolation guarantees is exactly the trap the next migration walks into (a
  // migration may — and this registry's own examples encourage it to — mutate nested state
  // in place, which a shallow spread would leak straight back to the caller).
  //
  // Persisted state is JSON, so `structuredClone` (Node ≥ 17, met by the toolchain) is
  // safe and total for real persisted input. But `migrateState(state: unknown)` is a
  // public API whose every OTHER failure mode returns a failed `MigrationResult`; a
  // caller that mistakenly passes a live object carrying a non-cloneable value (e.g. a
  // function on an attached `dataSources.adapter`) would otherwise get an uncaught
  // `DataCloneError`. Catch it and fail closed in the same error style, so the function
  // stays total — now uniformly on both paths, rather than only on the migration one.
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
        `MUI X Studio: Failed to clone state for migration: ${
          error instanceof Error ? error.message : String(error)
        }. Persisted state must be JSON-serializable (no functions, class instances, or other non-cloneable values).`,
      ],
    };
  }

  // Already at current version — still validate structure fail-closed, so a partial
  // persisted doc is rejected here (with a named field) rather than crashing later in
  // `deserializeState`.
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    const missing = findMissingRequiredField(currentState);
    if (missing) {
      return {
        success: false,
        state: null,
        fromVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        errors: [`MUI X Studio: Invalid persisted state: missing required field "${missing}".`],
      };
    }
    return {
      success: true,
      state: currentState as unknown as SerializedStudioState,
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors: [],
    };
  }

  // Apply migrations sequentially, on the deep copy taken above.
  for (let version = fromVersion; version < CURRENT_SCHEMA_VERSION; version += 1) {
    const migrateFn = migrations[version];
    if (!migrateFn) {
      // A gap in the registry is a HARD failure — never a silent version bump, which
      // would ship un-transformed state stamped under a newer version number.
      errors.push(
        `MUI X Studio: No migration registered from v${version} to v${version + 1}. ` +
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
        `MUI X Studio: Migration from v${version} to v${version + 1} failed: ${
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
    errors.push(`MUI X Studio: Invalid persisted state: missing required field "${missing}".`);
    return {
      success: false,
      state: null,
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors,
    };
  }

  // Enforce the registry's own contract clause — "the function must return a new object with
  // `schemaVersion` set to N+1" — which was the ONE clause with no post-condition check while
  // every other step here is fail-closed (a registry gap, a throwing migration, and a missing
  // required field all return `success: false`).
  //
  // A future migration that forgets the stamp would otherwise return `success: true` with
  // `toVersion: N+1` while the state it carries still says `schemaVersion: N`. Callers that
  // persist `migrateState(...).state` DIRECTLY — the reference hosts in
  // `examples/x-studio-dev-server/src/routes/mcp.ts` and `examples/x-studio-composed/src/App.tsx`
  // both do — would then write the under-stamped doc back to disk and re-run that same
  // migration on every subsequent load, forever.
  //
  // Latent today: the only registered entry is the `0 → 1` identity, which does stamp, and a
  // doc going through `deserializeState` is re-stamped there anyway. But "self-healing on one
  // of the two paths" is not the same as enforced, and a version that lies about the shape it
  // describes is exactly what the rest of this function refuses to produce.
  const stampedVersion = currentState.schemaVersion;
  if (stampedVersion !== CURRENT_SCHEMA_VERSION) {
    errors.push(
      `MUI X Studio: Migration to v${CURRENT_SCHEMA_VERSION} did not stamp "schemaVersion": the migrated state reports ` +
        `${JSON.stringify(stampedVersion)}. ` +
        'Each migration must return a new object with "schemaVersion" set to the version it migrates TO, ' +
        'or the doc is persisted under a version that does not describe its shape and is migrated again on every load.',
    );
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
 *
 * The strip is a filter-DROP path, so it cascades into the survivors' `dependsOn` like
 * every other one — see {@link pruneDependsOn} and the body comment below for the
 * user-visible cascade this used to shorten on every reload.
 */
export function serializeDoc(doc: StudioDoc): SerializedStudioState {
  const { filters, ...rest } = doc;
  const keptFilters = filters.filter(
    (f) => f.scope.kind !== 'cross-filter' && f.scope.kind !== 'interactive',
  );
  return {
    ...rest,
    // Cascade the strip into the survivors' `dependsOn`, via the SAME `pruneDependsOn`
    // helper every other filter-dropping path uses — this one is a drop path too, and was
    // the one that did not enforce the invariant.
    //
    // Without it a user-authored cascade was silently SHORTENED by a reload rather than
    // preserved: the strip left `dependsOn` pointing at the cross-filter/interactive entries
    // it had just removed, and `deserializeState`'s own `pruneDependsOn` — which prunes
    // against the ids the loaded array actually carries — then deleted those references for
    // good.
    //
    //   live        f1.dependsOn = ['x1', 'f2']   (x1 = a cross-filter entry)
    //   serialized  f1.dependsOn = ['x1', 'f2']
    //   loaded      f1.dependsOn = ['f2']
    //
    // Pruning HERE makes the serialized doc self-consistent, so what a reload restores is
    // what was written rather than what survived a second, later prune.
    filters: pruneDependsOn(keptFilters, new Set(keptFilters.map((f) => f.id))),
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
 *
 * @throws when `serialized.schemaVersion` is NEWER than {@link CURRENT_SCHEMA_VERSION}.
 * This is the ONE case this otherwise-total function fails loudly, and the distinction is
 * deliberate: everything else it meets is WITHIN-version corruption it can repair per-entry
 * (drop the junk widget, coerce the junk title, reconcile the dangling id) without losing
 * anything the caller could still want. A doc from a NEWER Studio is different in kind —
 * this build cannot know what its unknown fields mean, so "repairing" it means reading only
 * the fields this version happens to know, silently discarding every newer one, and then
 * stamping `schemaVersion: CURRENT_SCHEMA_VERSION` back onto the result. The host's next
 * save writes that downgraded doc, migrations never re-run against it, and the newer data is
 * gone permanently. `migrateState` has always refused this (`fromVersion >
 * CURRENT_SCHEMA_VERSION`), but the guard lived only there — and `deserializeState` is
 * itself a public export a host can call directly on `JSON.parse(localStorage.getItem(k))`,
 * bypassing it entirely. Fail with the same message rather than downgrade.
 */
export function deserializeState(
  serialized: SerializedStudioState,
  dataSources: StudioRuntime['dataSources'],
  shellOverrides?: Partial<StudioSession['shell']>,
): StudioState {
  // Coerce the WHOLE argument to a record before anything reads off it. `serialized` is
  // typed, but this is a public export a host may call directly on
  // `JSON.parse(localStorage.getItem(key))` — which is `null` for a missing key, and
  // `undefined` if the host forgets the argument entirely. The version read below already
  // anticipated that with `?.`, but the container reads further down then threw
  // `Cannot read properties of null (reading 'widgets')` — a documented-total function that
  // was total over every nested corruption and not over the single most likely input. One
  // coercion here makes every read below unconditionally safe, and the result is exactly the
  // default state a `{}` argument already produced.
  const raw = (isRecord(serialized) ? serialized : {}) as Record<string, unknown>;

  // Read the claimed version BEFORE anything else. Only a NUMBER greater than the current
  // version is rejected: an absent version is a legacy pre-versioning doc (v0), and any
  // other non-number is junk this function's within-version repair convention ignores —
  // both are `migrateState`'s business, not a reason to refuse to load.
  const claimedVersion = raw.schemaVersion;
  if (typeof claimedVersion === 'number' && claimedVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `MUI X Studio: Cannot migrate from schema version ${claimedVersion} to ${CURRENT_SCHEMA_VERSION}. ` +
        'The state was created with a newer version of X Studio. ' +
        'Loading it here would read only the fields this version knows, drop the rest, and re-save the ' +
        'result at the older version, permanently losing the newer data. ' +
        'Upgrade @mui/x-studio to a version that understands this schema.',
    );
  }

  const defaultState = createDefaultStudioState();

  // Coerce the absent/malformed TOP-LEVEL `pages` container to its empty default up front,
  // so this public, directly-callable API is TOTAL over a malformed `SerializedStudioState`
  // — matching `migrateState`, which never throws. Callers that hand-build a
  // `SerializedStudioState`, or pass `{}` / a doc missing a container, previously hit an
  // uncaught `TypeError` (`Object.entries(undefined)` on `pages`). The other containers are
  // coerced by their own `docScreening.ts` screen (non-record `widgets`/`dashboard` → `{}`,
  // non-array `filters`/`relationships`/`expressionFields`/`filterPresets` → `[]`, junk
  // `ai` → `undefined`). `serialized` is typed but untrusted at this boundary, so every
  // read goes through the already-normalised `raw` (see its definition above).
  const serializedPages = (isRecord(raw.pages) ? raw.pages : {}) as StudioDoc['pages'];

  // Per-entry widget screen, shared with `createDefaultStudioState` — see `docScreening.ts`.
  const screenedWidgets = screenWidgets(raw.widgets);

  // Normalize legacy leaf shapes, which is a PERSISTED-shape concern rather than a screen
  // (and lives in `factories.ts`, which `docScreening.ts` cannot import): grid `columns`
  // (legacy string field ids) and chart `ySeries` (legacy `seriesType` alias). Rebuild
  // `config` only when one is present; otherwise keep the widget untouched (reference
  // stability for the common case). Runs across kinds by design (a load-boundary normalizer
  // that doesn't branch on `widget.kind`), so it reads through the flat cross-kind
  // `StudioWidgetConfig` patch type.
  const normalizedWidgets = Object.fromEntries(
    Object.entries(screenedWidgets).map(([id, widget]) => {
      const config = widget.config as StudioWidgetConfig;
      const columns = config?.columns;
      const ySeries = config?.ySeries;
      // `Array.isArray` (not truthiness) with a non-empty guard: an empty
      // `columns: []`/`ySeries: []` (the factory defaults) is truthy, so the old
      // `!columns && !ySeries` check rebuilt a fresh, identical config on every load —
      // needless reference churn that defeated the "return the widget untouched" intent. A
      // truthy non-array (a hand-corrupted `columns: "junk"`) was also truthy and then
      // crashed on `.map`; `Array.isArray` leaves it untouched instead (deep config
      // validation is out of scope for this package).
      const hasColumns = Array.isArray(columns) && columns.length > 0;
      const hasYSeries = Array.isArray(ySeries) && ySeries.length > 0;
      if (!hasColumns && !hasYSeries) {
        return [id, widget];
      }
      // Track whether any entry actually changed (the pattern `normalizeConfigChartSeries`
      // uses in `applyMutation.ts`): a non-empty but already-canonical `columns`/`ySeries` —
      // the common case for every configured grid/chart widget — must NOT mint a fresh array
      // (and hence a fresh config and widget) on every load, or cross-load memoization is
      // defeated (Finding 5). `.map(normalize)` alone always allocates.
      let changed = false;
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
        return [id, widget];
      }
      const nextConfig = {
        ...widget.config,
        ...(hasColumns ? { columns: nextColumns } : {}),
        ...(hasYSeries ? { ySeries: nextYSeries } : {}),
      } as StudioWidgetConfig;
      return [id, { ...widget, config: nextConfig } as StudioWidget];
    }),
  ) as StudioDoc['widgets'];

  // Sweep the persisted pages (drop prototype-hazard keys / non-record values, clamp
  // layout) BEFORE reconciling `activePageId`, so a page the sweep legitimately drops
  // (a `null` page, a `"__proto__"` key) is accounted for by the reconciliation below.
  const sweptPages = normalizePersistedPages(serializedPages, normalizedWidgets);

  // "At least one page always exists" is a real invariant of this doc shape, and this is the
  // last boundary that can uphold it. Every legacy pageId-less mutation
  // (`addWidget`/`setWidgetLayout`/`setWidgetColSpan` without an explicit `pageId`) resolves
  // its target through `Object.hasOwn(state.pages, dashboard.activePageId)`, which no
  // `activePageId` satisfies once the page map is empty — so a zero-page doc silently no-ops
  // every one of those mutations forever, renders nothing, and offers no affordance to
  // recover. `removePage` refuses to delete the final page for exactly this reason, but a
  // persisted doc reaches the same state without any hand-editing: the sweep above
  // legitimately DROPS pages (an unsafe own key, a non-record value), so a doc whose only
  // page is dropped lands here with `pages: {}`.
  //
  // Synthesize the factory's default page instead, and let the `activePageId` reconciliation
  // below point at it. The reducer declined this repair because it must stay DETERMINISTIC —
  // the server-threaded state (`executeToolOnState`) and the client-applied state
  // (`StudioController.applyExternalMutation`) would diverge on a freshly-minted page id —
  // but the loader has no such constraint and already mints replacement values for every
  // other missing required field (`dashboard.id`, `dashboard.title`), so the repair belongs
  // here.
  const normalizedPages = Object.keys(sweptPages).length > 0 ? sweptPages : defaultState.doc.pages;

  // Per-entry dashboard screen (own-key strip + `title`/`id` coercion), shared with
  // `createDefaultStudioState` — see `docScreening.ts`.
  const dashboard = screenDashboard(raw.dashboard);
  // Reconcile a dangling `dashboard.activePageId` at the load boundary, mirroring the
  // exact fallback the factory (`createDefaultStudioState`) and `removePage` already use:
  // the invariant "the active page exists" is enforced everywhere EXCEPT here. A
  // hand-edited `activePageId`, or one orphaned when the sweep above dropped its page,
  // would otherwise render a blank canvas and silently no-op every legacy mutation that
  // falls back to the active page (`addWidget`/`setWidgetLayout` without an explicit
  // `pageId`). Kept HERE rather than in the shared screen because it needs the FINAL page
  // map, which each producer of a doc assembles differently.
  //
  // `typeof ... === 'string'` guards `Object.hasOwn` against its own key-coercion: a
  // numeric `activePageId` (e.g. reachable via `setActivePage`'s reducer-side bug, now
  // fixed, or a hand-edited persisted doc) would otherwise COERCE to match a
  // string-keyed `normalizedPages` entry (`42` matching key `"42"`) and be treated as
  // "valid", round-tripping the type-violating numeric value through this reconciliation
  // forever instead of ever being healed to a real string page id.
  const activePageIdValid =
    typeof dashboard.activePageId === 'string' &&
    Object.hasOwn(normalizedPages, dashboard.activePageId);
  const reconciledDashboard = activePageIdValid
    ? dashboard
    : {
        ...dashboard,
        // `normalizedPages` is guaranteed non-empty by the synthesis above, so this always
        // resolves to a real page id - the `?? ''` is unreachable and kept only because
        // the indexed read is not statically known to be defined.
        activePageId: Object.keys(normalizedPages)[0] ?? '',
      };

  // Per-entry `doc.ai` screen (container + threads + `activeThreadId` reconciliation),
  // shared with `createDefaultStudioState` — see `docScreening.ts`.
  const normalizedAi = screenAIState(raw.ai);

  // Per-entry filter screen, shared with `createDefaultStudioState` — see `docScreening.ts`.
  // The load boundary is the ONLY caller that passes the two extra options:
  //
  //  - `stripSessionScopes`, symmetric with `serializeDoc`'s strip: cross-filter- and
  //    interactive-scoped filters are session-flavoured and never written to disk, so a
  //    hand-edited or foreign doc carrying them must not install them into live
  //    `doc.filters` on load. An orphaned cross-filter (whose `scope.sourceWidgetId` names
  //    a widget the doc doesn't contain) would otherwise permanently filter its page: the
  //    reducer's cleanup for such filters only fires when the source widget is REMOVED, and
  //    it was never present, so the page would load pre-filtered with no affordance to
  //    clear it. An in-process producer legitimately BUILDS live state carrying both kinds,
  //    which is why the option exists rather than the strip being unconditional.
  //  - `anchors`, resolved against the SWEPT page map and the SCREENED widget record, so an
  //    orphan page/widget anchor is told apart from a live one. Only this boundary can
  //    supply them (the factory merges its `pages`/`widgets` onto the defaults AFTER the
  //    screen runs).
  const screenedFilters = screenFilters(raw.filters, {
    stripSessionScopes: true,
    anchors: {
      // `Object.hasOwn` so an untrusted id can't match a prototype member.
      hasPage: (pageId) => Object.hasOwn(normalizedPages, pageId),
      hasWidget: (widgetId) => Object.hasOwn(normalizedWidgets, widgetId),
    },
  });

  // Re-check rank-filter per-page uniqueness at the load boundary (finding 9): the
  // reducer's `addFilter` enforces "at most one rank filter per page context" on every
  // LIVE add (`hasConflictingRankFilter`), but that check was never re-run on load, so a
  // hand-edited/foreign doc could load with two conflicting rank filters on the same page
  // (or the legacy pageId-less "applies on every page" shape). Keep the FIRST rank filter
  // for each page context in array order and drop any later one that conflicts with it,
  // reusing the exact sweep `addFilter`'s layout siblings and `createDefaultStudioState` use
  // (`dedupeRankFilters`), so load-time, live-mutation-time and factory-time enforcement all
  // agree on which filter survives. Reference-stable: returns the SAME array when nothing
  // conflicts.
  const { filters: rankScreenedFilters } = dedupeRankFilters(screenedFilters, normalizedPages);

  // Cascade every drop this whole filter pipeline made into the surviving filters'
  // `dependsOn`, via the SAME `pruneDependsOn` helper the reducer's removal paths use.
  // Until this ran here, the load boundary was the largest of the un-pruned filter-removal
  // sites: it drops entries for a non-string/duplicate `id`, an invalid scope, an orphan
  // page/widget anchor, a bad `field`/`operator`, a stripped cross-filter/interactive entry,
  // AND a rank conflict — every one of which could leave a surviving filter's `dependsOn`
  // pointing at an id that is no longer in the doc, with no self-heal (the next
  // `serializeDoc` re-persisted the dangling reference forever). Applied ONCE, at the end,
  // against the final surviving id set, so it covers every drop above uniformly.
  // Reference-stable, so a well-formed doc keeps `screenedFilters`' identity.
  const finalFilters = pruneDependsOn(
    rankScreenedFilters,
    new Set(rankScreenedFilters.map((f) => f.id)),
  );

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
      // Defensive PER-ENTRY screening for the three optional collections, symmetric with
      // the pages/widgets/filters/ai.threads screens above and shared with
      // `createDefaultStudioState` — see `docScreening.ts` for each screen's rationale.
      relationships: screenRelationships(raw.relationships),
      expressionFields: screenExpressionFields(raw.expressionFields),
      filterPresets: screenFilterPresets(raw.filterPresets),
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
