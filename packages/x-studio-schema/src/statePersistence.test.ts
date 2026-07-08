import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  REGISTERED_MIGRATION_VERSIONS,
  deserializeState,
  migrateState,
  serializeState,
} from './statePersistence';
import { createDefaultStudioState } from './factories';

// A minimal but STRUCTURALLY COMPLETE serialized doc (all four required top-level
// fields), for tests exercising migration success paths now that `migrateState`
// validates structure fail-closed.
function completeSerialized(overrides: Record<string, unknown> = {}) {
  return {
    dashboard: { id: 'd', title: 'T', activePageId: 'p' },
    pages: {},
    widgets: {},
    filters: [],
    ...overrides,
  };
}

// ─── migrateState ─────────────────────────────────────────────────────────────

describe('migrateState', () => {
  it('returns success when state is already at CURRENT_SCHEMA_VERSION', () => {
    const state = completeSerialized({ schemaVersion: CURRENT_SCHEMA_VERSION });
    const result = migrateState(state);
    expect(result.success).toBe(true);
    expect(result.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.errors).toHaveLength(0);
    // Fast path: the already-current success path returns the SAME reference.
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

  it('returns failure for an array (fails the fail-closed structure check)', () => {
    // An array passes `typeof === 'object'` so it is treated as a v0 state, but the
    // post-migration structure check now rejects it (no `dashboard`/`pages`/…).
    const result = migrateState([]);
    expect(result.success).toBe(false);
    expect(result.state).toBeNull();
  });

  it('returns failure when state was created with a newer version', () => {
    const result = migrateState({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
    expect(result.success).toBe(false);
    expect(result.fromVersion).toBe(CURRENT_SCHEMA_VERSION + 1);
    expect(result.errors[0]).toMatch(/newer version/i);
  });

  it('migrates from version 0 to 1 (stamps schemaVersion)', () => {
    const result = migrateState(completeSerialized()); // no schemaVersion → treated as 0
    expect(result.success).toBe(true);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect((result.state as unknown as Record<string, unknown>).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
  });

  // ── fail-closed structural validation (1.3) ──────────────────────────────────
  it('fails a partial doc missing "dashboard" instead of letting deserializeState crash', () => {
    const result = migrateState({ schemaVersion: CURRENT_SCHEMA_VERSION });
    expect(result.success).toBe(false);
    expect(result.state).toBeNull();
    expect(result.errors.join(' ')).toMatch(/dashboard/);
  });

  it('fails a doc missing "filters" naming the field', () => {
    const result = migrateState({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      dashboard: { id: 'd', title: 'T', activePageId: 'p' },
      pages: {},
      widgets: {},
    });
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/filters/);
  });

  it('a full valid doc still succeeds', () => {
    expect(
      migrateState(completeSerialized({ schemaVersion: CURRENT_SCHEMA_VERSION })).success,
    ).toBe(true);
  });

  // ── mutate-in-place contract: migrateState must not touch the caller's object (1.9)
  it('does not mutate the caller-provided object and returns a fresh object', () => {
    const input = completeSerialized({
      widgets: { w1: { id: 'w1', config: { nested: { keep: true } } } },
      filters: [{ id: 'f1', scope: { kind: 'page' } }],
    }); // no schemaVersion → runs the migration path (not the fast return)
    const before = JSON.stringify(input);
    const result = migrateState(input);
    expect(result.success).toBe(true);
    expect(JSON.stringify(input)).toBe(before); // caller's object untouched
    expect(result.state).not.toBe(input); // migrated result is a fresh (deep) copy
  });

  // ── missing-migration completeness pin (1.4) ─────────────────────────────────
  it('every version step 0 … CURRENT_SCHEMA_VERSION-1 has a registered migration', () => {
    const registered = new Set(REGISTERED_MIGRATION_VERSIONS);
    for (let v = 0; v < CURRENT_SCHEMA_VERSION; v += 1) {
      expect(registered.has(v)).toBe(true);
    }
  });
});

// ─── serializeState ───────────────────────────────────────────────────────────

describe('serializeState', () => {
  it('strips cross-filter scoped filters from the output', () => {
    const state = createDefaultStudioState({
      doc: {
        filters: [
          { id: 'page-f', field: 'date', operator: 'equals', value: '', scope: { kind: 'page' } },
          {
            id: 'cross-f',
            field: 'category',
            operator: 'equals',
            value: 'A',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
          },
        ],
      },
    });
    const serialized = serializeState(state);
    expect(serialized.filters.some((f) => f.scope?.kind === 'cross-filter')).toBe(false);
    expect(serialized.filters.some((f) => f.id === 'page-f')).toBe(true);
  });

  it('strips both cross-filter and interactive scoped filters from the output', () => {
    const state = createDefaultStudioState({
      doc: {
        filters: [
          { id: 'page-f', field: 'date', operator: 'equals', value: '', scope: { kind: 'page' } },
          {
            id: 'cross-f',
            field: 'category',
            operator: 'equals',
            value: 'A',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
          },
          {
            id: 'interactive-f',
            field: 'region',
            operator: 'equals',
            value: 'EMEA',
            scope: { kind: 'interactive', sourceWidgetId: 'w2', pageId: 'page-1' },
          },
          {
            id: 'range-f',
            field: 'date',
            operator: 'equals',
            value: '',
            scope: { kind: 'dashboard-date-range', sourceId: 'orders', pageId: 'page-1' },
          },
        ],
      },
    });
    const serialized = serializeState(state);
    // Only the non-transient scope kinds survive persistence.
    expect(serialized.filters.map((f) => f.id)).toEqual(['page-f', 'range-f']);
    expect(serialized.filters.some((f) => f.scope?.kind === 'cross-filter')).toBe(false);
    expect(serialized.filters.some((f) => f.scope?.kind === 'interactive')).toBe(false);
  });

  it('retains page-scoped and widget-scoped filters', () => {
    const state = createDefaultStudioState({
      doc: {
        filters: [
          { id: 'p', field: 'date', operator: 'equals', value: '', scope: { kind: 'page' } },
          {
            id: 'w',
            field: 'status',
            operator: 'equals',
            value: 'active',
            scope: { kind: 'widget', widgetId: 'w1' },
          },
        ],
      },
    });
    const { filters } = serializeState(state);
    expect(filters.map((f) => f.id)).toContain('p');
    expect(filters.map((f) => f.id)).toContain('w');
  });

  it('omits expressionFields when the array is empty', () => {
    const state = createDefaultStudioState({ doc: { expressionFields: [] } });
    expect(serializeState(state).expressionFields).toBeUndefined();
  });

  it('includes expressionFields when non-empty', () => {
    const state = createDefaultStudioState({
      doc: {
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
      },
    });
    expect(serializeState(state).expressionFields).toHaveLength(1);
  });

  it('does not include dataSources', () => {
    const state = createDefaultStudioState({
      runtime: {
        dataSources: { orders: { id: 'orders', label: 'Orders', fields: [], rows: [] } },
      },
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
    const state = createDefaultStudioState({ doc: { ai: { threads: [] } } });
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
      doc: {
        ai: { threads: [thread], activeThreadId: 'thread-1' },
      },
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
    expect(state.runtime.dataSources).toBe(ds);
  });

  it('defaults relationships to [] when absent from serialized data', () => {
    const { relationships: ignoredRel, ...withoutRel } = minimalSerialized;
    const state = deserializeState(withoutRel as typeof minimalSerialized, {});
    expect(state.doc.relationships).toEqual([]);
  });

  it('defaults expressionFields to [] when absent from serialized data', () => {
    const { expressionFields: ignoredEf, ...withoutEf } = minimalSerialized;
    const state = deserializeState(withoutEf as typeof minimalSerialized, {});
    expect(state.doc.expressionFields).toEqual([]);
  });

  it('applies shellOverrides on top of default shell state', () => {
    const state = deserializeState(
      minimalSerialized,
      {},
      { openDrawers: { data: false, compose: false, filters: true } },
    );
    expect(state.session.shell.openDrawers.filters).toBe(true);
    expect(state.session.shell.openDrawers.data).toBe(false);
  });

  it('restores mode as "edit"', () => {
    const state = deserializeState(minimalSerialized, {});
    expect(state.session.mode).toBe('edit');
  });

  it('restores ai state when present in serialized data', () => {
    const thread = {
      id: 'thread-1',
      name: 'Q3 Analysis',
      createdAt: '2026-01-01T00:00:00.000Z',
      messages: [],
    };
    const stateWithAI = createDefaultStudioState({
      doc: {
        ai: { threads: [thread], activeThreadId: 'thread-1' },
      },
    });
    const serialized = serializeState(stateWithAI);
    const restored = deserializeState(serialized, {});
    expect(restored.doc.ai).toBeDefined();
    expect(restored.doc.ai!.threads).toHaveLength(1);
    expect(restored.doc.ai!.threads[0].name).toBe('Q3 Analysis');
    expect(restored.doc.ai!.activeThreadId).toBe('thread-1');
  });

  it('leaves ai undefined when not in serialized data', () => {
    const state = deserializeState(minimalSerialized, {});
    expect(state.doc.ai).toBeUndefined();
  });

  // 2.4: the restored doc is stamped at CURRENT_SCHEMA_VERSION (deserialize only runs
  // on migrated state), even if the serialized object carried no schemaVersion.
  it('stamps doc.schemaVersion as CURRENT_SCHEMA_VERSION', () => {
    const { schemaVersion: ignored, ...withoutVersion } = minimalSerialized;
    const state = deserializeState(withoutVersion as typeof minimalSerialized, {});
    expect(state.doc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  // 2.3: chart ySeries carrying the legacy `seriesType` alias is normalized to `type`.
  it('normalizes a widget config.ySeries via normalizeChartSeries', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {
        c1: {
          id: 'c1',
          kind: 'chart',
          title: 'Chart',
          config: {
            chartType: 'line',
            ySeries: [{ fieldId: 'rev', seriesType: 'line' }],
          },
        },
      },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    const ySeries = (
      state.doc.widgets.c1.config as unknown as { ySeries: Array<Record<string, unknown>> }
    ).ySeries;
    expect(ySeries[0].type).toBe('line');
    expect('seriesType' in ySeries[0]).toBe(false);
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
      doc: {
        dashboard: { id: 'd1', title: 'My Dashboard', activePageId: 'p1' },
      },
    });
    const json = JSON.stringify(serializeState(state));
    const migration = migrateState(JSON.parse(json));
    const restored = migration.success ? deserializeState(migration.state!, {}) : null;
    expect(restored?.doc.dashboard.title).toBe('My Dashboard');
  });

  it('roundtrip strips cross-filter entries', () => {
    const state = createDefaultStudioState({
      doc: {
        filters: [
          {
            id: 'cf1',
            field: 'cat',
            operator: 'equals',
            value: 'A',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
          },
        ],
      },
    });
    const json = JSON.stringify(serializeState(state));
    const migration = migrateState(JSON.parse(json));
    const restored = migration.success ? deserializeState(migration.state!, {}) : null;
    expect(
      restored?.doc.filters.filter(
        (f: { scope?: { kind: string } }) => f.scope?.kind === 'cross-filter',
      ),
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

// ─── doc-completeness gate ────────────────────────────────────────────────────
// These pin the persistence boundary against the two bugs the lifetime-partition
// split targets: (1) a hand-picked serialize field list silently dropping a new
// StudioDoc field, and (2) cross-filter entries leaking into persisted state.

describe('serializeState / deserializeState — doc completeness', () => {
  // A doc that populates EVERY StudioDoc field (including the omitted-when-empty
  // ones) so nothing is normalized away on the round-trip and identity holds.
  function fullDocState() {
    return createDefaultStudioState({
      doc: {
        dashboard: { id: 'd', title: 'Full', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } } },
        relationships: [
          {
            id: 'rel1',
            sourceId: 'orders',
            sourceField: 'customerId',
            targetId: 'customers',
            targetField: 'id',
            type: 'many-to-one',
          },
        ],
        filters: [
          {
            id: 'pf',
            field: 'date',
            operator: 'equals',
            value: '',
            scope: { kind: 'page', pageId: 'p1' },
          },
        ],
        expressionFields: [
          {
            id: 'ef1',
            label: 'Margin',
            expression: { operator: 'subtract', inputs: [{ id: 'revenue' }, { id: 'cost' }] },
            sourceId: 'orders',
            type: 'number',
            isMeasure: false,
          },
        ],
        filterPresets: [
          {
            id: 'preset-1',
            name: 'My preset',
            filters: [
              {
                id: 'pf-x',
                field: 'date',
                operator: 'equals',
                value: '',
                scope: { kind: 'page', pageId: 'p1' },
              },
            ],
          },
        ],
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Thread', createdAt: '2026-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      },
    });
  }

  it('a doc field cannot be forgotten: full doc round-trips to an identical doc', () => {
    const state = fullDocState();
    const roundTripped = deserializeState(serializeState(state), {});

    // Deep identity (minus stripped cross-filter entries — there are none here).
    expect(roundTripped.doc).toEqual(state.doc);
    // Key-set equality: a StudioDoc field added without a matching persistence path
    // would show up as a missing key here and fail loudly.
    expect(new Set(Object.keys(roundTripped.doc))).toEqual(new Set(Object.keys(state.doc)));
  });

  it('cross-filter entries are never persisted; other filter scopes are', () => {
    const state = createDefaultStudioState({
      doc: {
        filters: [
          {
            id: 'cf',
            field: 'cat',
            operator: 'equals',
            value: 'A',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'p1' },
          },
          {
            id: 'pf',
            field: 'date',
            operator: 'equals',
            value: '',
            scope: { kind: 'page', pageId: 'p1' },
          },
          {
            id: 'wf',
            field: 'status',
            operator: 'equals',
            value: 'x',
            scope: { kind: 'widget', widgetId: 'w1' },
          },
        ],
      },
    });
    const serialized = serializeState(state);
    expect(serialized.filters.map((f) => f.id)).toEqual(['pf', 'wf']);
    expect(serialized.filters.some((f) => f.scope.kind === 'cross-filter')).toBe(false);
  });
});
