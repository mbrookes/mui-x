import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  REGISTERED_MIGRATION_VERSIONS,
  deserializeState,
  migrateState,
  serializeState,
} from './statePersistence';
import { createDefaultStudioState } from './factories';
import type { StudioWidget } from './widgetTypes';

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

  // ── non-cloneable input on the migration path (review 3.1) ───────────────────
  it('returns a failed result (not an uncaught throw) for non-cloneable input on the migration path (review 3.1)', () => {
    // A live object carrying a function (e.g. a state with an attached
    // `dataSources.adapter`) is not `structuredClone`-able. On the migration path this
    // used to throw an uncaught DataCloneError; every other `migrateState` failure mode
    // returns a failed `MigrationResult`, so this must too.
    const input = completeSerialized({ adapter: () => 'not cloneable' }); // no schemaVersion → migration path
    let result!: ReturnType<typeof migrateState>;
    expect(() => {
      result = migrateState(input);
    }).not.toThrow();
    expect(result.success).toBe(false);
    expect(result.state).toBeNull();
    expect(result.errors.join(' ')).toMatch(/clone/i);
  });

  // ── fail-closed nested per-entry shape validation (finding 1.1) ──────────────
  // `findMissingRequiredField` now checks one level deeper than the four top-level
  // fields, so a nested-corrupt doc is rejected here with a NAMED field rather than
  // passing migration and then throwing an uncaught TypeError inside `deserializeState`.
  it('fails a doc whose page has a non-array widgetRows, naming the field (finding 1.1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        pages: { p1: { id: 'p1', title: 'P', widgetRows: 'junk' } },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.state).toBeNull();
    expect(result.errors.join(' ')).toMatch(/pages\["p1"\]\.widgetRows/);
  });

  it('fails a doc with a null page value, naming the field (finding 1.1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        pages: { p1: null },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/pages\["p1"\]/);
  });

  it('fails a doc with a null widget value, naming the field (finding 1.1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        widgets: { w1: null },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/widgets\["w1"\]/);
  });

  it('fails a doc whose widget has a non-record config, naming the field (finding 1.1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        widgets: { w1: { id: 'w1', kind: 'chart', title: 'C', config: 'junk' } },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/widgets\["w1"\]\.config/);
  });

  it('a doc with well-formed nested pages/widgets still succeeds (finding 1.1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        pages: { p1: { id: 'p1', title: 'P', widgetRows: [['w1']] } },
        widgets: { w1: { id: 'w1', kind: 'chart', title: 'C', config: {} } },
      }),
    );
    expect(result.success).toBe(true);
  });

  // ── fail-closed per-entry `filters` shape validation (Tier 1) ────────────────
  // A `filters: [null]` (or scope-less / `scope: null`) entry used to pass migration
  // (only `Array.isArray(filters)` was checked), load successfully, then throw an
  // uncaught TypeError in `serializeDoc` (autosave AND undo-snapshot) and the reducer on
  // the very next commit. It must now be rejected here with a NAMED field.
  it('fails a doc with a null filters entry, naming the field (Tier 1)', () => {
    const result = migrateState(
      completeSerialized({ schemaVersion: CURRENT_SCHEMA_VERSION, filters: [null] }),
    );
    expect(result.success).toBe(false);
    expect(result.state).toBeNull();
    expect(result.errors.join(' ')).toMatch(/filters\[0\]/);
  });

  it('fails a doc with a filters entry whose scope is null, naming the field (Tier 1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        filters: [{ id: 'f1', field: 'x', operator: 'equals', value: '', scope: null }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/filters\[0\]\.scope/);
  });

  it('fails a doc with a primitive filters entry, naming the field (Tier 1)', () => {
    const result = migrateState(
      completeSerialized({ schemaVersion: CURRENT_SCHEMA_VERSION, filters: ['junk'] }),
    );
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/filters\[0\]/);
  });

  it('a doc with a well-formed filters entry still succeeds (Tier 1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        filters: [{ id: 'f1', field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } }],
      }),
    );
    expect(result.success).toBe(true);
  });

  // ── fail-closed on non-integer schemaVersion (finding 3 / review 2.1) ────────
  // `typeof NaN === 'number'` used to fail OPEN: `NaN === CURRENT` / `NaN > CURRENT`
  // are both false and the migration loop never runs, so a `schemaVersion: NaN` doc
  // passed through un-migrated with `success: true`. It must now fail closed.
  it('fails closed for a NaN schemaVersion instead of passing through un-migrated (finding 3)', () => {
    const result = migrateState(completeSerialized({ schemaVersion: NaN }));
    expect(result.success).toBe(false);
    expect(result.state).toBeNull();
    expect(result.errors.join(' ')).toMatch(/schemaVersion/);
  });

  it('fails closed for a fractional schemaVersion (finding 3)', () => {
    const result = migrateState(completeSerialized({ schemaVersion: 0.5 }));
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/schemaVersion/);
  });

  it('still treats an absent schemaVersion as legacy v0 (finding 3)', () => {
    // `undefined` remains the legacy pre-versioning sentinel — only genuinely invalid
    // (non-integer) versions fail closed.
    const result = migrateState(completeSerialized());
    expect(result.success).toBe(true);
    expect(result.fromVersion).toBe(0);
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

  // Architecture review T3.2: `relationships` was always serialized (even when
  // empty), asymmetric with `expressionFields`/`filterPresets`/`ai`, which are
  // omitted when empty. Symmetry restored: an empty array is now omitted too.
  it('omits relationships when the array is empty (T3.2)', () => {
    const state = createDefaultStudioState({ doc: { relationships: [] } });
    expect(serializeState(state).relationships).toBeUndefined();
  });

  it('includes relationships when non-empty (T3.2)', () => {
    const state = createDefaultStudioState({
      doc: {
        relationships: [
          {
            id: 'r1',
            sourceId: 'orders',
            targetId: 'customers',
            sourceField: 'customerId',
            targetField: 'id',
            type: 'many-to-one' as const,
          },
        ],
      },
    });
    expect(serializeState(state).relationships).toHaveLength(1);
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

  // 3.2: legacy-shape detection uses `Array.isArray` + a non-empty guard, not
  // truthiness. An empty `columns: []`/`ySeries: []` (the factory defaults) has
  // nothing to normalize and must be returned untouched (reference-stable), and a
  // hand-corrupted non-array must not crash on `.map`.
  it('returns a widget with empty columns/ySeries arrays untouched (same reference) (3.2)', () => {
    const widget = {
      id: 'g1',
      kind: 'grid',
      title: 'Grid',
      config: { columns: [], ySeries: [] },
    };
    const serialized = {
      ...minimalSerialized,
      widgets: { g1: widget },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // The exact same widget object is carried through — no needless config rebuild.
    expect(state.doc.widgets.g1).toBe(serialized.widgets.g1);
  });

  it('does not throw on a hand-corrupted non-array columns config (3.2)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {
        g1: { id: 'g1', kind: 'grid', title: 'Grid', config: { columns: 'junk' } },
      },
    } as unknown as typeof minimalSerialized;
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState(serialized, {});
    }).not.toThrow();
    // Left untouched — deep config validation is out of scope for this package.
    expect((state.doc.widgets.g1.config as unknown as { columns: unknown }).columns).toBe('junk');
  });

  // ── defensive load-time layout normalization (review 3.2) ────────────────────
  // The reducer maintains layout invariants on every LIVE write, but a corrupted or
  // hand-edited persisted doc can violate them. `deserializeState` now runs a cheap
  // normalization sweep (NOT a schema migration — the doc shape is unchanged).
  const chart = (id: string) => ({ id, kind: 'chart', title: 'C', config: { chartType: 'bar' } });

  it('drops a persisted widgetRows id that has no matching widget (review 3.2)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: chart('w1') },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1', 'ghost'], ['ghost']] },
      },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // The phantom `ghost` id is filtered out and the row it emptied is dropped.
    expect(state.doc.pages['page-1'].widgetRows).toEqual([['w1']]);
  });

  it('deduplicates a persisted widgetRows id repeated across a row (review 3.2)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: chart('w1'), w2: chart('w2') },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1', 'w1', 'w2']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.pages['page-1'].widgetRows).toEqual([['w1', 'w2']]);
  });

  it('clamps out-of-range persisted spans and drops orphan spans (review 3.2)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: chart('w1'), w2: chart('w2') },
      pages: {
        'page-1': {
          id: 'page-1',
          title: 'P1',
          widgetRows: [['w1'], ['w2']],
          // w1: 40 clamps down to GRID_COLS (24); w2: 2 clamps up to MIN_SPAN (6);
          // `ghost` is on no row, so its orphan span is dropped.
          widgetColSpans: { w1: 40, w2: 2, ghost: 10 },
        },
      },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.pages['page-1'].widgetColSpans).toEqual({ w1: 24, w2: 6 });
  });

  it('leaves a well-formed persisted pages map reference-stable (no churn) (review 3.2)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: chart('w1') },
      pages: {
        'page-1': {
          id: 'page-1',
          title: 'P1',
          widgetRows: [['w1']],
          widgetColSpans: { w1: 12 },
        },
      },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // Nothing needed fixing, so the same page object is carried through untouched.
    expect(state.doc.pages['page-1']).toBe(serialized.pages['page-1']);
  });

  // ── total over nested-corrupt docs, direct deserializeState call (finding 1.1) ─
  // `deserializeState` is a public API callable on a `SerializedStudioState` directly
  // (not just via `migrateState`), so its load-boundary sweeps must not throw an
  // uncaught TypeError on a hand-edited/foreign doc with a junk shape one level down.
  it('does not throw on a non-array widgetRows, coercing it away (finding 1.1)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: chart('w1') },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: 'junk' } },
    } as unknown as typeof minimalSerialized;
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState(serialized, {});
    }).not.toThrow();
    expect(state.doc.pages['page-1'].widgetRows).toEqual([]);
  });

  it('does not throw on a null page value, dropping it (finding 1.1)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {},
      pages: { 'page-1': null, good: { id: 'good', title: 'G', widgetRows: [] } },
    } as unknown as typeof minimalSerialized;
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState(serialized, {});
    }).not.toThrow();
    expect(Object.hasOwn(state.doc.pages, 'page-1')).toBe(false);
    expect(Object.hasOwn(state.doc.pages, 'good')).toBe(true);
  });

  it('does not throw on a null widget value, dropping it (finding 1.1)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: null, w2: chart('w2') },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
    } as unknown as typeof minimalSerialized;
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState(serialized, {});
    }).not.toThrow();
    expect(Object.hasOwn(state.doc.widgets, 'w1')).toBe(false);
    expect(Object.hasOwn(state.doc.widgets, 'w2')).toBe(true);
  });

  // ── prototype-hazard keys in persisted maps (finding 1.2) ────────────────────
  it('drops a persisted "__proto__" page key and does not re-prototype the pages map (finding 1.2)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: chart('w1') },
      pages: JSON.parse(
        // JSON.parse produces a genuine own `"__proto__"` key (an object literal would not).
        '{"page-1":{"id":"page-1","title":"P1","widgetRows":[["w1"]]},' +
          '"__proto__":{"id":"evil","title":"Evil","widgetRows":[]}}',
      ),
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // The unsafe page entry is dropped and the map's prototype is untouched — no
    // inherited-property leak (`doc.pages.title` must not read back as 'Evil').
    expect(Object.getPrototypeOf(state.doc.pages)).toBe(Object.prototype);
    expect(Object.hasOwn(state.doc.pages, '__proto__')).toBe(false);
    expect((state.doc.pages as Record<string, unknown>).title).toBeUndefined();
    expect(state.doc.pages['page-1']).toBeDefined();
  });

  it('drops a persisted "__proto__" widget key from the widgets map (finding 1.2)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: JSON.parse(
        '{"w1":{"id":"w1","kind":"chart","title":"C","config":{"chartType":"bar"}},' +
          '"__proto__":{"id":"evil","kind":"chart","title":"Evil","config":{}}}',
      ),
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(Object.getPrototypeOf(state.doc.widgets)).toBe(Object.prototype);
    expect(Object.hasOwn(state.doc.widgets, '__proto__')).toBe(false);
    expect(state.doc.widgets.w1).toBeDefined();
  });

  // ── symmetric filter strip on load (finding 4 / review 2.2) ──────────────────
  it('strips a hand-carried cross-filter/interactive filter on load, symmetric with serializeDoc (finding 4)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        { id: 'page-f', field: 'date', operator: 'equals', value: '', scope: { kind: 'page' } },
        {
          id: 'cross-f',
          field: 'category',
          operator: 'equals',
          value: 'A',
          scope: { kind: 'cross-filter', sourceWidgetId: 'ghost', pageId: 'page-1' },
        },
        {
          id: 'interactive-f',
          field: 'region',
          operator: 'equals',
          value: 'EMEA',
          scope: { kind: 'interactive', sourceWidgetId: 'ghost2', pageId: 'page-1' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // The orphaned session-flavoured filters must not install into live `doc.filters`
    // (they would permanently filter the page with no clearing affordance).
    expect(state.doc.filters.some((f) => f.scope?.kind === 'cross-filter')).toBe(false);
    expect(state.doc.filters.some((f) => f.scope?.kind === 'interactive')).toBe(false);
    expect(state.doc.filters.some((f) => f.id === 'page-f')).toBe(true);
  });

  // ── total over corrupt `filters` entries, direct deserializeState call (Tier 1) ─
  // `deserializeState` is a public API callable on a `SerializedStudioState` directly, so
  // a hand-edited/foreign doc with a junk `filters` entry must not install it into live
  // `doc.filters` (where it would then crash `serializeDoc` and the reducer on the next
  // commit). The entry is defensively DROPPED here.
  it('does not throw on a null filters entry, dropping it (Tier 1)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        null,
        { id: 'page-f', field: 'date', operator: 'equals', value: '', scope: { kind: 'page' } },
      ],
    } as unknown as typeof minimalSerialized;
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState(serialized, {});
    }).not.toThrow();
    expect(state.doc.filters).toHaveLength(1);
    expect(state.doc.filters[0].id).toBe('page-f');
    // The surviving doc must round-trip through `serializeDoc` without throwing.
    expect(() => serializeState(state)).not.toThrow();
  });

  it('does not throw on a filters entry whose scope is null, dropping it (Tier 1)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        { id: 'bad', field: 'x', operator: 'equals', value: '', scope: null },
        { id: 'page-f', field: 'date', operator: 'equals', value: '', scope: { kind: 'page' } },
      ],
    } as unknown as typeof minimalSerialized;
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState(serialized, {});
    }).not.toThrow();
    expect(state.doc.filters.map((f) => f.id)).toEqual(['page-f']);
    expect(() => serializeState(state)).not.toThrow();
  });

  // ── dangling activePageId reconciliation at the load boundary (Tier 2) ───────
  // The factory and `removePage` both reconcile a dangling `activePageId`; the load
  // boundary did not. A hand-edited `activePageId` naming no page must fall back to the
  // first page id, mirroring the existing fallback pattern.
  it('reconciles a dangling dashboard.activePageId to the first page id (Tier 2)', () => {
    const serialized = {
      ...minimalSerialized,
      dashboard: { id: 'd', title: 'T', activePageId: 'nope' },
      pages: { p1: { id: 'p1', title: 'P1', widgetRows: [] } },
      widgets: {},
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.dashboard.activePageId).toBe('p1');
  });

  it('re-points activePageId when the load-boundary sweep drops its (corrupt) page (Tier 2)', () => {
    // `normalizePersistedPages` legitimately drops a `null` page; nothing used to
    // re-point `activePageId` afterward, leaving a blank canvas.
    const serialized = {
      ...minimalSerialized,
      dashboard: { id: 'd', title: 'T', activePageId: 'gone' },
      pages: { gone: null, good: { id: 'good', title: 'G', widgetRows: [] } },
      widgets: {},
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(Object.hasOwn(state.doc.pages, 'gone')).toBe(false);
    expect(state.doc.dashboard.activePageId).toBe('good');
  });

  it('leaves a valid activePageId untouched (Tier 2)', () => {
    const serialized = {
      ...minimalSerialized,
      dashboard: { id: 'd', title: 'T', activePageId: 'p2' },
      pages: {
        p1: { id: 'p1', title: 'P1', widgetRows: [] },
        p2: { id: 'p2', title: 'P2', widgetRows: [] },
      },
      widgets: {},
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.dashboard.activePageId).toBe('p2');
  });

  it('falls back activePageId to "" when the pages map is empty (Tier 2)', () => {
    const serialized = {
      ...minimalSerialized,
      dashboard: { id: 'd', title: 'T', activePageId: 'nope' },
      pages: {},
      widgets: {},
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.dashboard.activePageId).toBe('');
  });

  // ── junk doc.ai shape validation at the load boundary (Tier 2) ───────────────
  // `renameAIThread` does `(state.ai.threads ?? []).map(…)` — the `??` guards nullish
  // but NOT a truthy non-array. A junk `ai.threads` used to install verbatim and
  // round-trip through `serializeDoc`. It must be dropped to `undefined` here.
  it('drops a doc.ai whose threads is a non-array (Tier 2)', () => {
    const serialized = {
      ...minimalSerialized,
      ai: { threads: 'junk', activeThreadId: 't1' },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.ai).toBeUndefined();
    expect(() => serializeState(state)).not.toThrow();
  });

  it('drops a doc.ai that is a primitive (Tier 2)', () => {
    const serialized = {
      ...minimalSerialized,
      ai: 'junk',
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.ai).toBeUndefined();
  });

  it('keeps a well-formed doc.ai (Tier 2)', () => {
    const serialized = {
      ...minimalSerialized,
      ai: {
        threads: [{ id: 't1', name: 'Chat', createdAt: '2026-01-01T00:00:00.000Z', messages: [] }],
        activeThreadId: 't1',
      },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.ai).toBeDefined();
    expect(state.doc.ai!.threads).toHaveLength(1);
  });

  // ── non-array optional collections coerced to [] (Tier 3) ────────────────────
  it('coerces a non-array relationships/expressionFields/filterPresets to [] (Tier 3)', () => {
    const serialized = {
      ...minimalSerialized,
      relationships: 'junk',
      expressionFields: {},
      filterPresets: 42,
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.relationships).toEqual([]);
    expect(state.doc.expressionFields).toEqual([]);
    expect(state.doc.filterPresets).toEqual([]);
  });

  // ── id↔record-key reconciliation at the load boundary (finding 2.1) ──────────
  // The reducer keys every id-based lookup/delete/cross-filter-cleanup off the RECORD
  // KEY, and both the wire boundary and the reducer reject a `changes.id` to keep
  // `widget.id`/`page.id` in sync with their key. A hand-edited/shared doc where the
  // desync ALREADY exists must be reconciled here (re-stamp id ← key), or every edit of
  // that widget/page silently no-ops. The KEY wins.
  it('re-stamps a widget whose id field disagrees with its record key (finding 2.1)', () => {
    const serialized = {
      ...minimalSerialized,
      // Record key is `w-a`, but the widget's own `id` field claims `w-b`.
      widgets: { 'w-a': { id: 'w-b', kind: 'chart', title: 'C', config: { chartType: 'bar' } } },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w-a']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.widgets['w-a'].id).toBe('w-a');
    // The canvas renders from the key; a subsequent edit that passes `widget.id` back now
    // matches the record key, so it is no longer a silent no-op.
    expect(() => serializeState(state)).not.toThrow();
  });

  it('leaves a widget whose id field already matches its key reference-stable (finding 2.1)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: { id: 'w1', kind: 'chart', title: 'C', config: { chartType: 'bar' } } },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.widgets.w1.id).toBe('w1');
  });

  it('re-stamps a page whose id field disagrees with its record key (finding 2.1)', () => {
    const serialized = {
      ...minimalSerialized,
      dashboard: { id: 'd', title: 'T', activePageId: 'p-a' },
      // Record key is `p-a`, but the page's own `id` field claims `p-b`.
      pages: { 'p-a': { id: 'p-b', title: 'P', widgetRows: [] } },
      widgets: {},
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.pages['p-a'].id).toBe('p-a');
    // The reconciled key still names a real page, so `activePageId` is left untouched.
    expect(state.doc.dashboard.activePageId).toBe('p-a');
  });

  // ── null widget config coerced at the direct-call load surface (finding 2.4) ──
  // `deserializeState` is a public "total over nested-corrupt docs" surface. A record
  // widget whose `config` is `null` used to sail through (the normalize reads use `?.`)
  // and install a live widget whose first render throws on `config.chartType`. Coerce the
  // junk config to `{}` here, mirroring the relationships-style coercion.
  it('coerces a widget whose config is null to {} instead of installing a crashing widget (finding 2.4)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: { id: 'w1', kind: 'chart', title: '', config: null } },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    } as unknown as typeof minimalSerialized;
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState(serialized, {});
    }).not.toThrow();
    expect(state.doc.widgets.w1).toBeDefined();
    expect(state.doc.widgets.w1.config).toEqual({});
    // The coerced widget must round-trip without throwing.
    expect(() => serializeState(state)).not.toThrow();
  });

  it('coerces a widget whose config is a non-record primitive to {} (finding 2.4)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: { id: 'w1', kind: 'chart', title: '', config: 'junk' } },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.widgets.w1.config).toEqual({});
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

  // Architecture review T3.2: an empty `relationships` must round-trip through the
  // "omitted when empty" serialized shape back to `[]`, exactly like the sibling
  // omitted-when-empty collections (`expressionFields`/`filterPresets`).
  it('roundtrip: empty relationships is omitted on the wire and restored as [] (T3.2)', () => {
    const state = createDefaultStudioState({ doc: { relationships: [] } });
    const serialized = serializeState(state);
    expect(serialized.relationships).toBeUndefined();
    const json = JSON.stringify(serialized);
    const migration = migrateState(JSON.parse(json));
    const restored = migration.success ? deserializeState(migration.state!, {}) : null;
    expect(restored?.doc.relationships).toEqual([]);
  });

  it('roundtrip: non-empty relationships survives serialize/deserialize (T3.2)', () => {
    const relationships = [
      {
        id: 'rel1',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
        type: 'many-to-one' as const,
      },
    ];
    const state = createDefaultStudioState({ doc: { relationships } });
    const json = JSON.stringify(serializeState(state));
    const migration = migrateState(JSON.parse(json));
    const restored = migration.success ? deserializeState(migration.state!, {}) : null;
    expect(restored?.doc.relationships).toEqual(relationships);
  });

  it('retains chart config keys left over from a previously-selected chartType', () => {
    // A widget switched bar → gauge keeps `xField` in its stored config (deliberate
    // merge-not-replace UX; no migration strips it). That retention must survive
    // persistence byte-for-byte, not just live state.
    const retainedConfig = { chartType: 'gauge', xField: 'leftover-from-bar', gaugeMax: 200 };
    const state = createDefaultStudioState({
      doc: {
        widgets: {
          // A gauge config retaining a bar-era `xField` is intentionally NOT expressible
          // as a typed literal — the `StudioChartWidgetConfig` discriminated union forbids
          // a foreign-family key on a gauge. It is nonetheless a legitimate RUNTIME state
          // (merge-not-replace on chartType switch); that persistence round-trips it
          // byte-for-byte is exactly what this test pins, hence the deliberate cast.
          c1: {
            id: 'c1',
            kind: 'chart',
            title: 'W',
            config: { ...retainedConfig },
          } as unknown as StudioWidget,
        },
      },
    });
    const json = JSON.stringify(serializeState(state));
    const migration = migrateState(JSON.parse(json));
    const restored = migration.success ? deserializeState(migration.state!, {}) : null;
    expect(restored).not.toBeNull();
    expect(restored!.doc.widgets.c1.config).toEqual(retainedConfig);
    // And the leftover key specifically survives — it is not stripped on the way out.
    expect((restored!.doc.widgets.c1.config as { xField?: string }).xField).toBe(
      'leftover-from-bar',
    );
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
