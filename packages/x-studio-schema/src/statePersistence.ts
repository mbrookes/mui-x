import { createDefaultStudioState, normalizeGridColumn, normalizeChartSeries } from './factories';
import { CURRENT_SCHEMA_VERSION } from './stateTypes';
import type { StudioState, StudioDoc, StudioSession, StudioRuntime } from './stateTypes';
import type { StudioExpressionField } from './expressionTypes';
import type { StudioWidgetConfig } from './widgetTypes';
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

/**
 * The top-level fields a fully-migrated `SerializedStudioState` must carry, checked
 * fail-closed AFTER migration so a partial persisted doc is rejected cleanly here
 * (with a named field) instead of crashing later inside `deserializeState`. Returns
 * the name of the first missing/mis-typed field, or `null` when all are present.
 */
function findMissingRequiredField(state: Record<string, unknown>): string | null {
  const isRecord = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
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

  const fromVersion = typeof state.schemaVersion === 'number' ? state.schemaVersion : 0;

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
  // safe and total.
  let currentState = structuredClone(state) as Record<string, unknown>;
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
 * empties-are-omitted fields. The two scope kinds have DIFFERENT undo semantics but are
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

  return {
    doc: {
      // `deserializeState` only ever runs on migrated state (a guarantee `migrateState`
      // now makes real by failing closed), so the doc IS at the current schema version.
      // Stamping the constant keeps the compile-time tie the previous `as 1` cast erased
      // — a version bump now forces this to follow via the type system.
      schemaVersion: CURRENT_SCHEMA_VERSION,
      dashboard: serialized.dashboard,
      pages: serialized.pages,
      widgets: Object.fromEntries(
        Object.entries(serialized.widgets).map(([id, widget]) => {
          // Normalize legacy leaf shapes at the load boundary: grid `columns` (legacy
          // string field ids) and chart `ySeries` (legacy `seriesType` alias). Rebuild
          // `config` only when one is present; otherwise return the widget untouched
          // (keeping reference stability for the common case). This runs across kinds
          // by design (a load-boundary normalizer that doesn't branch on `widget.kind`),
          // so it reads through the flat cross-kind `StudioWidgetConfig` patch type.
          const config = widget.config as StudioWidgetConfig;
          const columns = config?.columns;
          const ySeries = config?.ySeries;
          if (!columns && !ySeries) {
            return [id, widget];
          }
          return [
            id,
            {
              ...widget,
              config: {
                ...widget.config,
                ...(columns ? { columns: columns.map(normalizeGridColumn) } : {}),
                ...(ySeries ? { ySeries: ySeries.map(normalizeChartSeries) } : {}),
              },
            },
          ];
        }),
      ),
      filters: serialized.filters,
      relationships: serialized.relationships ?? [],
      expressionFields: serialized.expressionFields ?? [],
      filterPresets: serialized.filterPresets ?? [],
      ai: serialized.ai,
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
