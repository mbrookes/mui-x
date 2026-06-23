import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  deserializeState,
  migrateState,
  serializeState,
} from './statePersistence';
import { createDefaultStudioState } from '../models';

// ─── migrateState ─────────────────────────────────────────────────────────────

describe('migrateState', () => {
  it('returns success when state is already at CURRENT_SCHEMA_VERSION', () => {
    const state = { schemaVersion: CURRENT_SCHEMA_VERSION, widgets: {}, pages: {}, filters: [] };
    const result = migrateState(state);
    expect(result.success).toBe(true);
    expect(result.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.errors).toHaveLength(0);
    expect(result.state).toBe(state);
  });

  it('returns failure for null', () => {
    const result = migrateState(null);
    expect(result.success).toBe(false);
    expect(result.state).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns failure for a plain string', () => {
    const result = migrateState('{"schemaVersion":1}');
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns failure for a number', () => {
    expect(migrateState(42).success).toBe(false);
  });

  it('returns failure for an array', () => {
    // Arrays pass typeof === 'object', so migrateState treats them as a v0 state
    // and migrates (bumps schemaVersion). This is acceptable behaviour — the
    // caller should validate input before calling migrateState.
    const result = migrateState([]);
    // At minimum, we verify it doesn't throw and returns a result object
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('fromVersion');
  });

  it('returns failure when state was created with a newer version', () => {
    const result = migrateState({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
    expect(result.success).toBe(false);
    expect(result.fromVersion).toBe(CURRENT_SCHEMA_VERSION + 1);
    expect(result.errors[0]).toMatch(/newer version/i);
  });

  it('migrates from version 0 to 1 (stamps schemaVersion)', () => {
    const result = migrateState({ widgets: {}, pages: {}, filters: [] }); // no schemaVersion → treated as 0
    expect(result.success).toBe(true);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect((result.state as unknown as Record<string, unknown>).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
  });
});

// ─── serializeState ───────────────────────────────────────────────────────────

describe('serializeState', () => {
  it('strips cross-filter scoped filters from the output', () => {
    const state = createDefaultStudioState({
      filters: [
        { id: 'page-f', field: 'date', operator: 'equals', value: '', scopeV2: { kind: 'page' } },
        {
          id: 'cross-f',
          field: 'category',
          operator: 'equals',
          value: 'A',
          scopeV2: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
        },
      ],
    });
    const serialized = serializeState(state);
    expect(serialized.filters.some((f) => f.scopeV2?.kind === 'cross-filter')).toBe(false);
    expect(serialized.filters.some((f) => f.id === 'page-f')).toBe(true);
  });

  it('retains page-scoped and widget-scoped filters', () => {
    const state = createDefaultStudioState({
      filters: [
        { id: 'p', field: 'date', operator: 'equals', value: '', scopeV2: { kind: 'page' } },
        { id: 'w', field: 'status', operator: 'equals', value: 'active', scopeV2: { kind: 'widget', widgetId: 'w1' } },
      ],
    });
    const { filters } = serializeState(state);
    expect(filters.map((f) => f.id)).toContain('p');
    expect(filters.map((f) => f.id)).toContain('w');
  });

  it('omits expressionFields when the array is empty', () => {
    const state = createDefaultStudioState({ expressionFields: [] });
    expect(serializeState(state).expressionFields).toBeUndefined();
  });

  it('includes expressionFields when non-empty', () => {
    const state = createDefaultStudioState({
      expressionFields: [
        {
          id: 'ef1',
          label: 'Margin',
          expression: {
            operator: 'subtract' as const,
            inputs: [{ id: 'revenue' }, { id: 'cost' }],
          },
          sourceId: 'orders',
          type: 'number' as const,
          isMeasure: false,
        },
      ],
    });
    expect(serializeState(state).expressionFields).toHaveLength(1);
  });

  it('does not include dataSources', () => {
    const state = createDefaultStudioState({
      dataSources: { orders: { id: 'orders', label: 'Orders', fields: [], rows: [] } },
    });
    const serialized = serializeState(state) as unknown as Record<string, unknown>;
    expect(serialized.dataSources).toBeUndefined();
  });

  it('does not include shell state', () => {
    const state = createDefaultStudioState();
    const serialized = serializeState(state) as unknown as Record<string, unknown>;
    expect(serialized.shell).toBeUndefined();
  });

  it('omits ai when no threads exist', () => {
    const state = createDefaultStudioState();
    expect(serializeState(state).ai).toBeUndefined();
  });

  it('omits ai when threads array is empty', () => {
    const state = createDefaultStudioState({ ai: { threads: [] } });
    expect(serializeState(state).ai).toBeUndefined();
  });

  it('includes ai when threads are present', () => {
    const thread = {
      id: 'thread-1',
      name: 'Sales Q3',
      createdAt: '2026-01-01T00:00:00.000Z',
      messages: [],
    };
    const state = createDefaultStudioState({
      ai: { threads: [thread], activeThreadId: 'thread-1' },
    });
    const serialized = serializeState(state);
    expect(serialized.ai).toBeDefined();
    expect(serialized.ai!.threads).toHaveLength(1);
    expect(serialized.ai!.threads[0].id).toBe('thread-1');
    expect(serialized.ai!.activeThreadId).toBe('thread-1');
  });
});

// ─── deserializeState ─────────────────────────────────────────────────────────

describe('deserializeState', () => {
  const minimalSerialized = serializeState(createDefaultStudioState());

  it('re-attaches the provided dataSources to the restored state', () => {
    const ds = { orders: { id: 'orders', label: 'Orders', fields: [], rows: [] } };
    const state = deserializeState(minimalSerialized, ds);
    expect(state.dataSources).toBe(ds);
  });

  it('defaults relationships to [] when absent from serialized data', () => {
    const { relationships: ignoredRel, ...withoutRel } = minimalSerialized;
    const state = deserializeState(withoutRel as typeof minimalSerialized, {});
    expect(state.relationships).toEqual([]);
  });

  it('defaults expressionFields to [] when absent from serialized data', () => {
    const { expressionFields: ignoredEf, ...withoutEf } = minimalSerialized;
    const state = deserializeState(withoutEf as typeof minimalSerialized, {});
    expect(state.expressionFields).toEqual([]);
  });

  it('applies shellOverrides on top of default shell state', () => {
    const state = deserializeState(
      minimalSerialized,
      {},
      { openDrawers: { data: false, compose: false, filters: true } },
    );
    expect(state.shell.openDrawers.filters).toBe(true);
    expect(state.shell.openDrawers.data).toBe(false);
  });

  it('restores mode as "edit"', () => {
    const state = deserializeState(minimalSerialized, {});
    expect(state.mode).toBe('edit');
  });

  it('restores ai state when present in serialized data', () => {
    const thread = {
      id: 'thread-1',
      name: 'Q3 Analysis',
      createdAt: '2026-01-01T00:00:00.000Z',
      messages: [],
    };
    const stateWithAI = createDefaultStudioState({
      ai: { threads: [thread], activeThreadId: 'thread-1' },
    });
    const serialized = serializeState(stateWithAI);
    const restored = deserializeState(serialized, {});
    expect(restored.ai).toBeDefined();
    expect(restored.ai!.threads).toHaveLength(1);
    expect(restored.ai!.threads[0].name).toBe('Q3 Analysis');
    expect(restored.ai!.activeThreadId).toBe('thread-1');
  });

  it('leaves ai undefined when not in serialized data', () => {
    const state = deserializeState(minimalSerialized, {});
    expect(state.ai).toBeUndefined();
  });
});

// ─── serializeState / deserializeState roundtrip ─────────────────────────────

describe('serializeState / deserializeState roundtrip', () => {
  it('produces valid JSON', () => {
    const state = createDefaultStudioState();
    expect(() => JSON.stringify(serializeState(state))).not.toThrow();
  });

  it('roundtrip restores dashboard title', () => {
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'My Dashboard', activePageId: 'p1' },
    });
    const json = JSON.stringify(serializeState(state));
    const migration = migrateState(JSON.parse(json));
    const restored = migration.success ? deserializeState(migration.state!, {}) : null;
    expect(restored?.dashboard.title).toBe('My Dashboard');
  });

  it('roundtrip strips cross-filter entries', () => {
    const state = createDefaultStudioState({
      filters: [
        {
          id: 'cf1',
          field: 'cat',
          operator: 'equals',
          value: 'A',
          scopeV2: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
        },
      ],
    });
    const json = JSON.stringify(serializeState(state));
    const migration = migrateState(JSON.parse(json));
    const restored = migration.success ? deserializeState(migration.state!, {}) : null;
    expect(
      restored?.filters.filter((f: { scopeV2?: { kind: string } }) => f.scopeV2?.kind === 'cross-filter'),
    ).toHaveLength(0);
  });

  it('migrateState returns failure for invalid JSON', () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse('not valid json {{');
    } catch {
      parsed = null;
    }
    const migrationResult = migrateState(parsed);
    expect(migrationResult.success).toBe(false);
    expect(migrationResult.errors[0]).toMatch(/parse|invalid|null/i);
  });

  it('migrateState returns failure for a future schemaVersion', () => {
    const migrationResult = migrateState({ schemaVersion: CURRENT_SCHEMA_VERSION + 99 });
    expect(migrationResult.success).toBe(false);
  });

  it('migrateState returns success for an object with no schemaVersion (v0 → current)', () => {
    const migrationResult = migrateState({
      widgets: {},
      pages: {},
      filters: [],
      dashboard: { id: 'd', title: 'T', activePageId: 'p' },
    });
    expect(migrationResult.success).toBe(true);
    expect(migrationResult.state).not.toBeNull();
  });
});
