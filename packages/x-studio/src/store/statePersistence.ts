import { createDefaultStudioState, type StudioDataSource, type StudioState, type StudioWidget } from '../models';

/**
 * Current schema version for the studio state
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Serializable state format for persistence (excludes transient shell state)
 */
export interface SerializedStudioState {
  schemaVersion: number;
  dashboard: StudioState['dashboard'];
  pages: StudioState['pages'];
  widgets: StudioState['widgets'];
  dataSources: StudioState['dataSources'];
  filters: StudioState['filters'];
  relationships?: StudioState['relationships'];
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
 * Strips runtime-only data from a data source for serialization.
 * The `rows` are provided by the host app at runtime and must not be persisted.
 */
function serializeDataSource({ rows: _rows, ...rest }: StudioDataSource): Omit<StudioDataSource, 'rows'> {
  return rest;
}

/**
 * Strips runtime-only fields from a widget for serialization.
 * `bindings` mirror the source's fields and are re-derived at load time.
 */
function serializeWidget({ bindings: _bindings, ...rest }: StudioWidget): Omit<StudioWidget, 'bindings'> {
  return rest;
}

/**
 * Serializes the studio state for persistence
 * Excludes transient shell state (selection, drawer open state),
 * runtime data (dataSource rows), and derived fields (widget bindings).
 */
export function serializeState(state: StudioState): SerializedStudioState {
  const dataSources = Object.fromEntries(
    Object.entries(state.dataSources).map(([id, ds]) => [id, serializeDataSource(ds)]),
  ) as StudioState['dataSources'];

  const widgets = Object.fromEntries(
    Object.entries(state.widgets).map(([id, w]) => [id, serializeWidget(w)]),
  ) as StudioState['widgets'];

  return {
    schemaVersion: state.schemaVersion,
    dashboard: state.dashboard,
    pages: state.pages,
    widgets,
    dataSources,
    filters: state.filters.filter((f) => f.scope !== 'cross-filter'), // Don't persist cross-filters
    relationships: state.relationships,
  };
}

/**
 * Deserializes and restores a persisted state
 * Returns the full StudioState with default shell state.
 * Widget bindings are re-derived from their data source fields since they
 * are not persisted.
 */
export function deserializeState(
  serialized: SerializedStudioState,
  shellOverrides?: Partial<StudioState['shell']>,
): StudioState {
  const defaultState = createDefaultStudioState();

  // Re-derive bindings for each widget from its source's field definitions.
  const widgets = Object.fromEntries(
    Object.entries(serialized.widgets).map(([id, widget]) => {
      const source = widget.sourceId ? serialized.dataSources[widget.sourceId] : undefined;
      const bindings = source?.fields.map((f) => ({ field: f.id, label: f.label })) ?? [];
      return [id, { ...widget, bindings }];
    }),
  ) as StudioState['widgets'];

  return {
    schemaVersion: serialized.schemaVersion as 1,
    mode: 'edit',
    dashboard: serialized.dashboard,
    pages: serialized.pages,
    widgets,
    dataSources: serialized.dataSources,
    filters: serialized.filters,
    relationships: serialized.relationships ?? [],
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

  const state = deserializeState(migrationResult.state);
  return { state, migrationResult };
}

/**
 * Downloads state as a JSON file
 */
export function downloadState(state: StudioState, filename?: string): void {
  const json = stateToJson(state);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename ?? `${state.dashboard.title.replace(/[^a-z0-9]/gi, '_')}_dashboard.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Prompts user to select a JSON file and loads state from it
 */
export function uploadState(): Promise<{
  state: StudioState | null;
  migrationResult: MigrationResult;
}> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve({
          state: null,
          migrationResult: {
            success: false,
            state: null,
            fromVersion: 0,
            toVersion: CURRENT_SCHEMA_VERSION,
            errors: ['No file selected'],
          },
        });
        return;
      }

      try {
        const text = await file.text();
        const result = jsonToState(text);
        resolve(result);
      } catch (error) {
        resolve({
          state: null,
          migrationResult: {
            success: false,
            state: null,
            fromVersion: 0,
            toVersion: CURRENT_SCHEMA_VERSION,
            errors: [
              `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            ],
          },
        });
      }
    };

    input.click();
  });
}
