import { createDefaultStudioState, normalizeGridColumn, type StudioState, type StudioExpressionField } from '../models';

/**
 * Current schema version for the studio state
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Serializable state format for persistence.
 * Contains only user-authored dashboard config — data sources are provided by
 * the host app at runtime and are never persisted.
 */
export interface SerializedStudioState {
  schemaVersion: number;
  dashboard: StudioState['dashboard'];
  pages: StudioState['pages'];
  widgets: StudioState['widgets'];
  filters: StudioState['filters'];
  relationships?: StudioState['relationships'];
  expressionFields?: StudioExpressionField[];
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
 * Registry of migrations from version N to N+1
 */
const migrations: Record<number, MigrationFn> = {
  // Example: migration from v0 to v1 (if we had a v0)
  // 0: (state) => {
  //   return {
  //     ...state,
  //     schemaVersion: 1,
  //     // Add new fields, transform existing ones
  //   };
  // },
};

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

  // Already at current version
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
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

  // Apply migrations sequentially
  let currentState = { ...state };
  for (let version = fromVersion; version < CURRENT_SCHEMA_VERSION; version += 1) {
    const migrateFn = migrations[version];
    if (migrateFn) {
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
    } else {
      // No migration needed, just bump version
      currentState = {
        ...currentState,
        schemaVersion: version + 1,
      };
    }
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
 * Serializes the studio state for persistence.
 * Excludes transient shell state, data sources (host-app-provided), and
 * cross-filter runtime state.
 */
export function serializeState(state: StudioState): SerializedStudioState {
  return {
    schemaVersion: state.schemaVersion,
    dashboard: state.dashboard,
    pages: state.pages,
    widgets: state.widgets,
    filters: state.filters.filter((f) => f.scope !== 'cross-filter'),
    relationships: state.relationships,
    expressionFields: state.expressionFields.length > 0 ? state.expressionFields : undefined,
  };
}

/**
 * Deserializes and restores a persisted state.
 * Returns the full StudioState with default shell state.
 * @param dataSources - The host app's data sources; not persisted so must be passed in.
 */
export function deserializeState(
  serialized: SerializedStudioState,
  dataSources: StudioState['dataSources'],
  shellOverrides?: Partial<StudioState['shell']>,
): StudioState {
  const defaultState = createDefaultStudioState();

  return {
    schemaVersion: serialized.schemaVersion as 1,
    mode: 'edit',
    dashboard: serialized.dashboard,
    pages: serialized.pages,
    widgets: Object.fromEntries(
      Object.entries(serialized.widgets).map(([id, widget]) => [
        id,
        widget.config?.columns
          ? {
              ...widget,
              config: {
                ...widget.config,
                columns: widget.config.columns.map(normalizeGridColumn),
              },
            }
          : widget,
      ]),
    ),
    dataSources,
    filters: serialized.filters,
    relationships: serialized.relationships ?? [],
    expressionFields: serialized.expressionFields ?? [],
    shell: {
      ...defaultState.shell,
      ...shellOverrides,
    },
  };
}

/**
 * Converts state to a JSON string for storage
 */
export function stateToJson(state: StudioState): string {
  const serialized = serializeState(state);
  return JSON.stringify(serialized, null, 2);
}

/**
 * Parses JSON and restores state with migration support
 */
export function jsonToState(json: string): {
  state: StudioState | null;
  migrationResult: MigrationResult;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      state: null,
      migrationResult: {
        success: false,
        state: null,
        fromVersion: 0,
        toVersion: CURRENT_SCHEMA_VERSION,
        errors: [`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`],
      },
    };
  }

  const migrationResult = migrateState(parsed);

  if (!migrationResult.success || !migrationResult.state) {
    return { state: null, migrationResult };
  }

  const state = deserializeState(migrationResult.state, {});
  return { state, migrationResult };
}
