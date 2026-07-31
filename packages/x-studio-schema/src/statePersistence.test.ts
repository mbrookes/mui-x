import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATION_REGISTRY_FOR_TESTS,
  REGISTERED_MIGRATION_VERSIONS,
  deserializeState,
  migrateState,
  serializeDoc,
  serializeState,
} from './statePersistence';
import { createDefaultStudioState } from './factories';
import { applyDocMutation } from './applyMutation';
import type { StudioWidget } from './widgetTypes';
import type { StudioDoc } from './stateTypes';

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
    // The already-current path now DEEP-COPIES like the migration path, so both entry
    // paths offer one isolation guarantee: the returned state never aliases the caller's
    // object. It used to return the SAME reference here — and since
    // `CURRENT_SCHEMA_VERSION` is 1 that fast path is the overwhelmingly common case, so
    // the live, undoable doc aliased the host's retained persisted object.
    expect(result.state).not.toBe(state);
    expect(result.state).toEqual(state);
  });

  it('the already-current path does not alias the caller-provided object (M12)', () => {
    const state = completeSerialized({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      widgets: { w1: { id: 'w1', kind: 'chart', title: 'A', config: { chartType: 'bar' } } },
      relationships: [
        {
          id: 'r1',
          sourceId: 'a',
          sourceField: 'x',
          targetId: 'b',
          targetField: 'y',
          type: 'many-to-one',
        },
      ],
    });
    const result = migrateState(state);
    expect(result.success).toBe(true);
    const migrated = result.state as unknown as Record<string, unknown>;
    // Nested sub-objects are copies too — a host mutating its own persisted object must
    // not reach into live state (or any undo snapshot sharing those sub-objects).
    expect((migrated.widgets as Record<string, unknown>).w1).not.toBe(
      (state.widgets as Record<string, unknown>).w1,
    );
    expect(migrated.relationships).not.toBe(
      (state as unknown as Record<string, unknown>).relationships,
    );
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

  // ── nested per-entry shape validation (finding 1.1) ──────────────────────────
  // `findMissingRequiredField` checks one level deeper than the four top-level fields for
  // the shapes that would otherwise crash a no-optional-chaining read (a null/non-record
  // page value, a null/non-record filter entry). For the shapes that a load-boundary
  // handler ALREADY repairs gracefully and per-entry (a non-array `pages[*].widgetRows`, a
  // malformed `filters[*].scope`), it now degrades to that per-entry repair instead of
  // hard-failing the whole doc — matching the widgets-path precedent below.
  it('succeeds a doc whose page has a non-array widgetRows, leaving the per-entry coercion to deserializeState (finding 1.1)', () => {
    // `normalizePersistedPages` coerces a junk `widgetRows` to `[]` per-page (verified in the
    // sibling `deserializeState` describe block), so hard-failing the WHOLE dashboard over
    // ONE page's junk rows was strictly worse. `migrateState` now succeeds.
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        pages: { p1: { id: 'p1', title: 'P', widgetRows: 'junk' } },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.state).not.toBeNull();
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

  // T3 finding (iteration 22): a null widget value / non-record widget config used to
  // hard-fail the WHOLE doc here, even though `deserializeState`'s own widget pipeline
  // already repairs both shapes gracefully per-entry (drops a non-record widget; coerces a
  // non-record `config` to `{}`) — sinking every other page/widget in the dashboard over
  // ONE bad widget entry was strictly worse than the graceful repair `deserializeState`
  // already provides. `migrateState` now succeeds for both shapes (leaving the per-entry
  // repair to `deserializeState`, verified in the sibling `deserializeState` describe block
  // below), matching the graceful-repair convention this file already applies to
  // `relationships`/`expressionFields`/`filterPresets`/`ai.threads` per-entry junk.
  it('succeeds a doc with a null widget value, leaving the per-entry repair to deserializeState (finding 1.1 / T3)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        widgets: { w1: null },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('succeeds a doc whose widget has a non-record config, leaving the per-entry repair to deserializeState (finding 1.1 / T3)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        widgets: { w1: { id: 'w1', kind: 'chart', title: 'C', config: 'junk' } },
      }),
    );
    expect(result.success).toBe(true);
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

  // ── per-entry `filters` shape validation (Tier 1) ────────────────────────────
  // A non-record `filters` entry (`filters: [null]` / a primitive) stays a hard, named
  // migration failure: it would crash a no-optional-chaining `f.id`/`f.scope` read before the
  // load boundary could act. But a malformed `filters[*].scope` (a non-record `scope`, or one
  // whose `kind` is not a string) now degrades to a per-entry DROP: `deserializeState`'s
  // per-entry `isValidFilterScope` screen already drops such an entry while loading everything
  // else (verified in the sibling `deserializeState` describe block), and it runs before
  // `serializeDoc`/the reducer ever read `f.scope.kind`, so hard-failing the whole doc was
  // strictly worse than dropping just that filter.
  it('fails a doc with a null filters entry, naming the field (Tier 1)', () => {
    const result = migrateState(
      completeSerialized({ schemaVersion: CURRENT_SCHEMA_VERSION, filters: [null] }),
    );
    expect(result.success).toBe(false);
    expect(result.state).toBeNull();
    expect(result.errors.join(' ')).toMatch(/filters\[0\]/);
  });

  it('succeeds a doc with a filters entry whose scope is null, leaving the per-entry drop to deserializeState (Tier 1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        filters: [{ id: 'f1', field: 'x', operator: 'equals', value: '', scope: null }],
      }),
    );
    expect(result.success).toBe(true);
    expect(result.state).not.toBeNull();
  });

  // A well-formed-but-INCOMPLETE scope (a record scope with a string `kind` but a missing
  // required id) also migrates successfully; `deserializeState` (below) drops just that filter.
  it('does NOT fail a doc whose scope is a record with a string kind but a missing required id', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        filters: [
          {
            id: 'f1',
            field: 'date',
            operator: 'between',
            value: '',
            // `kind` is a string and `scope` is a record, but `widgetId` (required for a
            // `widget` scope) is absent. Migrates; `deserializeState` drops the entry.
            scope: { kind: 'widget' },
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
    expect(result.state).not.toBeNull();
  });

  // A scope whose `kind` is not a string no longer sinks the whole doc either — it degrades to
  // the same per-entry drop in `deserializeState`, matching the `pages[*].widgetRows` relaxation.
  it('succeeds a doc whose scope.kind is not a string, leaving the per-entry drop to deserializeState (Tier 1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        filters: [{ id: 'f1', field: 'x', operator: 'equals', value: '', scope: { kind: 42 } }],
      }),
    );
    expect(result.success).toBe(true);
    expect(result.state).not.toBeNull();
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

  // ── per-entry named rejection of the three optional collections (Finding 1) ──
  // Mirrors the filters treatment above: `migrateState` reports the junk field by NAME
  // rather than letting it load and crash the client on first use.
  it('fails a doc with a junk relationships entry, naming the field (Finding 1)', () => {
    const result = migrateState(
      completeSerialized({ schemaVersion: CURRENT_SCHEMA_VERSION, relationships: [null] }),
    );
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/relationships\[0\]/);
  });

  it('fails a doc with a junk expressionFields entry, naming the field (Finding 1)', () => {
    const result = migrateState(
      completeSerialized({ schemaVersion: CURRENT_SCHEMA_VERSION, expressionFields: [42] }),
    );
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/expressionFields\[0\]/);
  });

  it('fails a doc whose filterPreset has a non-array filters, naming the field (Finding 1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        filterPresets: [{ id: 'p1', name: 'P', filters: 'junk' }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/filterPresets\[0\]/);
  });

  it('fails a doc whose filterPreset has a null inner filter, naming the nested field (Finding 1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        filterPresets: [{ id: 'p1', name: 'P', filters: [null] }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/filterPresets\[0\]\.filters\[0\]/);
  });

  it('a doc with well-formed relationships / expressionFields / filterPresets still succeeds (Finding 1)', () => {
    const result = migrateState(
      completeSerialized({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        relationships: [{ id: 'r1', sourceId: 'a', targetId: 'b' }],
        expressionFields: [{ id: 'ef1', name: 'Rev', sourceId: 'a' }],
        filterPresets: [
          {
            id: 'p1',
            name: 'P',
            filters: [
              { id: 'f1', field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } },
            ],
          },
        ],
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

  // The fourth member of the empty→`undefined` family. Its three siblings
  // (`relationships`, `expressionFields`, `ai`) each have this pair; `filterPresets`
  // had neither half, so the collapse could be dropped and an empty array would start
  // being written into every persisted doc unnoticed.
  it('omits filterPresets when the array is empty', () => {
    const state = createDefaultStudioState({ doc: { filterPresets: [] } });
    expect(serializeState(state).filterPresets).toBeUndefined();
    expect(serializeDoc(state.doc).filterPresets).toBeUndefined();
  });

  it('includes filterPresets when non-empty', () => {
    const state = createDefaultStudioState({
      doc: { filterPresets: [{ id: 'p1', name: 'P', filters: [] }] },
    });
    expect(serializeState(state).filterPresets).toHaveLength(1);
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

  // ── total over a malformed top-level shape (finding 2) ───────────────────────
  // `deserializeState` is a public, directly-callable export documented as total over a
  // malformed `SerializedStudioState`. A caller passing `{}` (or a doc missing one of the
  // four top-level containers `widgets`/`pages`/`filters`/`dashboard`) previously hit an
  // uncaught `TypeError` (`Object.entries(undefined)`, `.map` on a missing `filters`,
  // `Object.keys(undefined)` inside `stripUnsafeOwnKeys`). Each absent container now coerces
  // to its empty default, matching `migrateState`'s never-throw contract.
  it('does not throw on an empty object, coercing every top-level container to its default (finding 2)', () => {
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState({} as typeof minimalSerialized, {});
    }).not.toThrow();
    expect(state.doc.widgets).toEqual({});
    expect(state.doc.filters).toEqual([]);
    // `pages` is the ONE container that does not coerce to empty: a doc must always carry
    // at least one page, so an absent/empty page map synthesizes the factory's default one.
    expect(state.doc.pages).toEqual({
      'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
    });
    // A missing `dashboard` heals to a usable shape: title falls back and activePageId
    // points at the synthesized page.
    expect(state.doc.dashboard.title).toBe('Untitled Dashboard');
    expect(state.doc.dashboard.activePageId).toBe('page-1');
  });

  it('does not throw when an individual top-level container is missing (finding 2)', () => {
    const { widgets: ignoredW, pages: ignoredP, filters: ignoredF, ...rest } = minimalSerialized;
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState(rest as typeof minimalSerialized, {});
    }).not.toThrow();
    expect(state.doc.widgets).toEqual({});
    expect(Object.keys(state.doc.pages)).toEqual(['page-1']);
    expect(state.doc.filters).toEqual([]);
  });

  it('drops a filters entry whose scope is null while loading the rest (finding 1)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        { id: 'bad', field: 'x', operator: 'equals', value: '', scope: null },
        { id: 'ok', field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } },
      ],
    };
    const state = deserializeState(serialized as typeof minimalSerialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['ok']);
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

  // T2-3: the ai load guard validated `threads` is an array but not each ENTRY, so a
  // `null` thread entry loaded verbatim and then threw in `renameAIThread`'s `t.id` read.
  it('drops a non-record ai.threads entry on load so a later rename does not throw (T2-3)', () => {
    const goodThread = {
      id: 'thread-1',
      name: 'Kept',
      createdAt: '2026-01-01T00:00:00.000Z',
      messages: [],
    };
    const serialized = {
      ...minimalSerialized,
      // `null` and a primitive are junk entries that the container `Array.isArray` check
      // alone would let through.
      ai: { threads: [null, goodThread, 'junk'], activeThreadId: 'thread-1' },
    } as unknown as typeof minimalSerialized;
    let restored!: ReturnType<typeof deserializeState>;
    expect(() => {
      restored = deserializeState(serialized, {});
    }).not.toThrow();
    // Only the record entry survives; the `null`/primitive entries are dropped.
    expect(restored.doc.ai!.threads).toHaveLength(1);
    expect(restored.doc.ai!.threads[0].id).toBe('thread-1');
    // The whole point: a rename over the loaded doc no longer throws on a null entry.
    let renamed!: typeof restored.doc;
    expect(() => {
      renamed = applyDocMutation(restored.doc, {
        type: 'renameAIThread',
        args: { name: 'Renamed', updatedAt: '2026-02-01T00:00:00.000Z', threadId: 'thread-1' },
      });
    }).not.toThrow();
    expect(renamed.ai!.threads[0].name).toBe('Renamed');
  });

  // F1: the T2-3 screen above validated "is a record" but never the LEAF shapes of a
  // surviving thread — a `messages` that is a non-array (e.g. a string) or a `name`
  // that is a non-string passed through verbatim, later crashing `<ChatBox messages=…>`
  // (`.map` on a string) or React's child renderer (a non-string `name`). Repair-in-
  // place: coerce `messages` to `[]` and `name` to a fallback string, rather than
  // dropping the whole thread.
  it('repairs a thread with a non-array messages and a non-string name on load (F1)', () => {
    const serialized = {
      ...minimalSerialized,
      ai: {
        threads: [
          {
            id: 'thread-1',
            name: 42,
            createdAt: '2026-01-01T00:00:00.000Z',
            messages: 'not-an-array',
          },
        ],
        activeThreadId: 'thread-1',
      },
    } as unknown as typeof minimalSerialized;
    const restored = deserializeState(serialized, {});
    expect(restored.doc.ai!.threads).toHaveLength(1);
    const thread = restored.doc.ai!.threads[0];
    expect(thread.id).toBe('thread-1');
    expect(Array.isArray(thread.messages)).toBe(true);
    expect(thread.messages).toEqual([]);
    expect(typeof thread.name).toBe('string');
  });

  // F1: a well-formed `ai.threads` (every thread already carrying an array `messages`
  // and a string `name`) must not be repaired/re-wrapped — reference stability for the
  // common case.
  it('keeps a well-formed ai.threads reference-stable on load (F1)', () => {
    const thread = {
      id: 'thread-1',
      name: 'Kept',
      createdAt: '2026-01-01T00:00:00.000Z',
      messages: [],
    };
    const serialized = {
      ...minimalSerialized,
      ai: { threads: [thread], activeThreadId: 'thread-1' },
    } as unknown as typeof minimalSerialized;
    const restored = deserializeState(serialized, {});
    expect(restored.doc.ai!.threads[0]).toBe(thread);
  });

  // `repairThreadLeafShapes`' TIMESTAMP arms. Every sibling repair in that helper
  // (`messages`, `name`) is pinned above; the two timestamp arms were not, even though
  // they guard a documented crash: `useChatThreads` sorts threads with
  // `bTime.localeCompare(aTime)`, so a non-string `createdAt`/`updatedAt` reaching the
  // comparator throws a `TypeError` inside the sort `useMemo` and takes the whole chat
  // panel down on mount.
  it.each([
    ['a non-string createdAt', { createdAt: 42 }],
    ['a missing createdAt', {}],
  ])('coerces %s to the epoch default on load', (_label, createdAtField) => {
    const serialized = {
      ...minimalSerialized,
      ai: {
        threads: [{ id: 'thread-1', name: 'T', messages: [], ...createdAtField }],
        activeThreadId: 'thread-1',
      },
    } as unknown as typeof minimalSerialized;
    const restored = deserializeState(serialized, {});
    expect(restored.doc.ai!.threads[0].createdAt).toBe('1970-01-01T00:00:00.000Z');
  });

  // `updatedAt` is optional, so a junk one is DELETED rather than coerced — the sort then
  // falls back to `createdAt`, which the arm above guarantees is a string. Asserting on
  // `in` (not on `=== undefined`) is what distinguishes a deleted key from one that
  // survived as an explicit `undefined`.
  it('deletes a non-string updatedAt on load rather than passing it through', () => {
    const serialized = {
      ...minimalSerialized,
      ai: {
        threads: [
          {
            id: 'thread-1',
            name: 'T',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: 42,
            messages: [],
          },
        ],
        activeThreadId: 'thread-1',
      },
    } as unknown as typeof minimalSerialized;
    const restored = deserializeState(serialized, {});
    const thread = restored.doc.ai!.threads[0];
    expect('updatedAt' in thread).toBe(false);
    expect(thread.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  // The crash this repair exists for, reproduced end-to-end: the comparator only runs
  // with 2+ threads, so a single-thread fixture would pass even with the repair removed.
  it('leaves every loaded thread sortable by the chat panel comparator (2+ threads)', () => {
    const serialized = {
      ...minimalSerialized,
      ai: {
        threads: [
          { id: 'thread-1', name: 'A', createdAt: 42, messages: [] },
          { id: 'thread-2', name: 'B', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: 7 },
        ],
        activeThreadId: 'thread-1',
      },
    } as unknown as typeof minimalSerialized;
    const restored = deserializeState(serialized, {});
    const threads = restored.doc.ai!.threads;
    expect(threads).toHaveLength(2);
    // `useChatThreads`' comparator, verbatim: it reads `updatedAt ?? createdAt` and calls
    // `localeCompare`, which throws on a non-string receiver or argument.
    const sortKey = (t: (typeof threads)[number]) => t.updatedAt ?? t.createdAt;
    expect(threads.map(sortKey).every((key) => typeof key === 'string')).toBe(true);
    expect(() => [...threads].sort((a, b) => sortKey(b).localeCompare(sortKey(a)))).not.toThrow();
  });

  // Tier2 finding: unlike `dashboard.activePageId` (reconciled against `normalizedPages`
  // just above in the file) and `filters[].id` (deduped just below), a dangling
  // `ai.activeThreadId` was never validated against the final surviving `threads` array —
  // a hand-edited/foreign doc, or one orphaned when a thread was dropped, loaded with the
  // chat panel silently pointed at a thread that no longer exists.
  it('clears a dangling activeThreadId that names no surviving thread (Tier2)', () => {
    const thread = {
      id: 'thread-1',
      name: 'Kept',
      createdAt: '2026-01-01T00:00:00.000Z',
      messages: [],
    };
    const serialized = {
      ...minimalSerialized,
      ai: { threads: [thread], activeThreadId: 'ghost-thread' },
    } as unknown as typeof minimalSerialized;
    const restored = deserializeState(serialized, {});
    expect(restored.doc.ai!.threads).toHaveLength(1);
    expect(restored.doc.ai!.activeThreadId).toBeUndefined();
  });

  // Same finding, the "thread was dropped out from under it" flavor: `activeThreadId`
  // named a thread that WAS present in the raw payload but got screened out (here, a
  // non-string `id` — see the next test) before this reconciliation runs, so it must be
  // treated exactly like a never-existed id, not left dangling.
  it('clears activeThreadId when the thread it named was itself dropped for an invalid id (Tier2)', () => {
    const serialized = {
      ...minimalSerialized,
      ai: {
        threads: [
          { id: 42, name: 'Bad id', createdAt: '2026-01-01T00:00:00.000Z', messages: [] },
          { id: 'thread-2', name: 'Good', createdAt: '2026-01-01T00:00:00.000Z', messages: [] },
        ],
        activeThreadId: 'thread-2',
      },
    } as unknown as typeof minimalSerialized;
    const restored = deserializeState(serialized, {});
    expect(restored.doc.ai!.threads.map((t) => t.id)).toEqual(['thread-2']);
    // thread-2 is a real surviving thread, so activeThreadId is left alone.
    expect(restored.doc.ai!.activeThreadId).toBe('thread-2');
  });

  // Tier2 finding: a thread with a non-string (or empty-string) `id` was never screened —
  // `renameAIThread`'s `t.id === threadId` lookup compares against a STRING, so a numeric
  // id could never be targeted for rename, and it would round-trip as permanent dead
  // weight in the thread selector.
  it('drops a thread with a non-string id (Tier2)', () => {
    const serialized = {
      ...minimalSerialized,
      ai: {
        threads: [
          { id: 42, name: 'Numeric id', createdAt: '2026-01-01T00:00:00.000Z', messages: [] },
          { id: '', name: 'Empty id', createdAt: '2026-01-01T00:00:00.000Z', messages: [] },
          { id: 'thread-1', name: 'Good', createdAt: '2026-01-01T00:00:00.000Z', messages: [] },
        ],
        activeThreadId: 'thread-1',
      },
    } as unknown as typeof minimalSerialized;
    const restored = deserializeState(serialized, {});
    expect(restored.doc.ai!.threads).toHaveLength(1);
    expect(restored.doc.ai!.threads[0].id).toBe('thread-1');
  });

  // Tier2 finding: two threads sharing the same `id` — mirroring the `filters[].id`
  // load-boundary dedup (Finding 3) — must collapse to the first occurrence, not load
  // both. Duplicate thread ids would desync `renameAIThread`'s single-thread-by-id lookup
  // from whichever copy the thread selector happened to render.
  it('de-dups threads sharing the same id, keeping the first occurrence (Tier2)', () => {
    const serialized = {
      ...minimalSerialized,
      ai: {
        threads: [
          { id: 't1', name: 'First', createdAt: '2026-01-01T00:00:00.000Z', messages: [] },
          {
            id: 't1',
            name: 'Second (duplicate)',
            createdAt: '2026-01-02T00:00:00.000Z',
            messages: [],
          },
        ],
        activeThreadId: 't1',
      },
    } as unknown as typeof minimalSerialized;
    const restored = deserializeState(serialized, {});
    expect(restored.doc.ai!.threads).toHaveLength(1);
    expect(restored.doc.ai!.threads[0].name).toBe('First');
    expect(restored.doc.ai!.activeThreadId).toBe('t1');
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

  it('drops all spans of a shared row whose persisted colSpans sum past GRID_COLS (T2-1)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: chart('w1'), w2: chart('w2') },
      pages: {
        'page-1': {
          id: 'page-1',
          // w1 and w2 SHARE one row. Both spans are individually in range (20 ≤ 24),
          // safe, and non-orphaned — the per-key clamp loop leaves them untouched — but
          // together they sum to 40 > GRID_COLS (24), overflowing the row. The load
          // boundary must run `enforceLayoutColSpans` (the row-overflow invariant), which
          // drops every span in the offending row so it falls back to equal flex.
          title: 'P1',
          widgetRows: [['w1', 'w2']],
          widgetColSpans: { w1: 20, w2: 20 },
        },
      },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // Both spans dropped → the emptied map collapses to `undefined`.
    expect(state.doc.pages['page-1'].widgetColSpans).toBeUndefined();
  });

  it('drops a shared row whose spans overflow only AFTER the clamp (T2-1)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: chart('w1'), w2: chart('w2') },
      pages: {
        'page-1': {
          id: 'page-1',
          // The clamp itself CREATES the overflow: `{ w1: 40, w2: 6 }` on a shared row
          // clamps to `{ w1: 24, w2: 6 }` (sum 30 > 24). Without the post-clamp overflow
          // pass this installs verbatim and renders a 30/24 row.
          title: 'P1',
          widgetRows: [['w1', 'w2']],
          widgetColSpans: { w1: 40, w2: 6 },
        },
      },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.pages['page-1'].widgetColSpans).toBeUndefined();
  });

  it('keeps a pre-existing intentional singleton span on load (T2-1 oldRows=[] contract)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: chart('w1') },
      pages: {
        'page-1': {
          // A lone widget in its own row with a deliberate narrow span must NOT be
          // collapsed by the load-boundary `enforceLayoutColSpans([], …)` — `oldRows=[]`
          // means the 2→1-collapse branch never fires for a pre-existing singleton.
          id: 'page-1',
          title: 'P1',
          widgetRows: [['w1']],
          widgetColSpans: { w1: 12 },
        },
      },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
  });

  // Finding 1: a persisted `page.title`/`dashboard.title` that is missing or non-string
  // previously passed `migrateState`'s validation unchanged (`findMissingRequiredField`
  // only checks `pages[*].widgetRows`) and installed verbatim, later crashing React
  // render (e.g. `StudioWidgetCardActionsOverlay` renders `page.title` as text). Contrast
  // with `addPage`/`renamePage`, which already require a string `title` at the wire/
  // reducer boundary — this closed the persisted-load gap those mutations don't cover.
  it('coerces a non-string persisted page title to the "Untitled Page" fallback (finding 1)', () => {
    const serialized = {
      ...minimalSerialized,
      pages: { 'page-1': { id: 'page-1', title: 42, widgetRows: [] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.pages['page-1'].title).toBe('Untitled Page');
  });

  it('coerces a missing persisted page title to the "Untitled Page" fallback (finding 1)', () => {
    const pageWithoutTitle = { id: 'page-1', widgetRows: [] };
    const serialized = {
      ...minimalSerialized,
      pages: { 'page-1': pageWithoutTitle },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.pages['page-1'].title).toBe('Untitled Page');
  });

  it('coerces a non-string persisted dashboard title to the "Untitled Dashboard" fallback (finding 1)', () => {
    const serialized = {
      ...minimalSerialized,
      dashboard: { ...minimalSerialized.dashboard, title: null },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.dashboard.title).toBe('Untitled Dashboard');
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

  it('drops a widget value that is an exotic object masquerading as a valid record (isPlainRecord bypass)', () => {
    // A class instance with own `id`/`kind`/`title`/`config` data properties that all pass
    // their OWN individual checks. The old `widget !== null && typeof widget === 'object' &&
    // !Array.isArray(widget)` check (no prototype check) accepted this as a usable widget
    // record, and nothing downstream in `screenWidgets`' `.map()` step rebuilds a widget
    // whose `id` already matches its key and whose `config` is already record-shaped — so
    // the exotic instance would have been embedded DIRECTLY into `state.doc.widgets`,
    // silently different from the plain-object shape every other widget has. `isPlainRecord`
    // rejects it up front (its prototype isn't `Object.prototype`), dropping it like any
    // other malformed widget entry instead.
    class FakeWidget {
      id = 'w1';
      kind = 'chart';
      title = 'Evil';
      config = { chartType: 'bar' };
    }
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: new FakeWidget() },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(Object.hasOwn(state.doc.widgets, 'w1')).toBe(false);
  });

  it('drops a PAGE value that is an exotic object masquerading as a valid record (isPlainRecord bypass)', () => {
    // The page-channel twin of the widget test above, and the last screen in the package that
    // still spelled the record check out by hand: `normalizePersistedPages` used
    // `page === null || typeof page !== 'object' || Array.isArray(page)`, which is FALSE for a
    // class instance, so the exotic page passed. Nothing downstream repaired it either — the
    // sweep's rebuild is skipped precisely when `id`/`title`/`widgetRows` already look valid,
    // so the instance was embedded into `doc.pages` by REFERENCE.
    //
    // That made the four boundaries disagree on one byte-identical input: the FACTORY
    // (`screenPagesShape`, which routes through `isPlainRecord`) dropped it, this LOADER kept
    // it. Both now drop.
    class FakePage {
      id = 'p-exotic';
      title = 'Exotic';
      widgetRows: string[][] = [];
    }
    const serialized = {
      ...minimalSerialized,
      widgets: {},
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
        'p-exotic': new FakePage(),
      },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(Object.hasOwn(state.doc.pages, 'p-exotic')).toBe(false);
    expect(state.doc.pages['page-1']).toBeDefined();
    // Every surviving page is a plain data bag, the shape every consumer assumes.
    expect(
      Object.values(state.doc.pages).every(
        (page) => Object.getPrototypeOf(page) === Object.prototype,
      ),
    ).toBe(true);
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

  // The exact line the denylist draws, pinned on the PAGE channel because that is where the
  // "we converted every lookup to `Object.hasOwn`, so a prototype-member-named id is safe to
  // KEEP" argument keeps resurfacing. Both halves are deliberate:
  //
  //  - The three `UNSAFE_KEYS` are dropped. `constructor`/`prototype` cannot pollute through
  //    the `Object.fromEntries` rebuild any more than `toString` can — the reason they go is
  //    that the WIRE boundary rejects them (`isValidId`) and the REDUCER refuses to mint them
  //    (`addPage`'s `isSafePatchKey` gate, whose own comment names deferred data loss as the
  //    motive). A boundary that KEPT them here would be the only one, and would hand a page
  //    back to a doc that no supported edit can reach. The tradeoff is stated plainly: this
  //    IS data loss for a page a hand-edit named `constructor`, accepted so that all four
  //    boundaries give one answer instead of three.
  //  - Every OTHER `Object.prototype` member name is KEPT. That is what the `Object.hasOwn`
  //    conversion bought, and it is the reason `isSafeKey` is a three-element denylist rather
  //    than "anything that appears on `Object.prototype`".
  it.each(['constructor', 'prototype'])(
    'drops a persisted "%s" page key, matching the wire and reducer boundaries',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        widgets: { w1: chart('w1') },
        pages: JSON.parse(
          `{"page-1":{"id":"page-1","title":"P1","widgetRows":[["w1"]]},` +
            `"${key}":{"id":"${key}","title":"Odd","widgetRows":[]}}`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(Object.hasOwn(state.doc.pages, key)).toBe(false);
      expect(state.doc.pages['page-1']).toBeDefined();
    },
  );

  it.each(['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'])(
    'KEEPS a persisted page legitimately keyed "%s" (not a pollution vector)',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        widgets: { w1: chart('w1') },
        pages: JSON.parse(
          `{"page-1":{"id":"page-1","title":"P1","widgetRows":[["w1"]]},` +
            `"${key}":{"id":"${key}","title":"Odd","widgetRows":[]}}`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(Object.keys(state.doc.pages).sort()).toEqual([key, 'page-1'].sort());
      expect(state.doc.pages[key]).toMatchObject({ id: key, title: 'Odd' });
    },
  );

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

  // ── widget/page/filter OBJECT own-key screen on load (T2-1 / T2-2) ────────────
  // The crafted input from the finding: a persisted widget carrying `__proto__` as a
  // real own DATA property (not the record KEY — that is the test above, and not the
  // config own key — that is a separate screen). Such a widget previously passed load
  // verbatim, round-tripped through `serializeDoc`, and a later spread of it poisoned
  // the target's prototype. `deserializeState` now drops the whole widget, symmetric
  // with the wire boundary's `hasUnsafeOwnKeys(widget)` rejection in `validateWidget`.
  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops a persisted widget carrying an own "%s" top-level key, sparing valid siblings (T2-1)',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        widgets: JSON.parse(
          `{"w1":{"id":"w1","kind":"chart","title":"C","config":{"chartType":"bar"}},` +
            `"w9":{"id":"w9","kind":"kpi","title":"T","config":{},"${key}":{"polluted":true}}}`,
        ),
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      // The polluted widget is dropped; the valid sibling survives; nothing reached the
      // prototype (a poisoned `Object.prototype.polluted` would leak onto every object).
      expect(state.doc.widgets.w9).toBeUndefined();
      expect(state.doc.widgets.w1).toBeDefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      // And the surviving doc round-trips through serialization without carrying the key.
      const roundTripped = serializeState(state);
      expect(Object.hasOwn(roundTripped.widgets, 'w9')).toBe(false);
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops a persisted page carrying an own "%s" top-level key, sparing valid siblings (T2-1)',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        widgets: { w1: chart('w1') },
        pages: JSON.parse(
          `{"page-1":{"id":"page-1","title":"P1","widgetRows":[["w1"]]},` +
            `"page-9":{"id":"page-9","title":"Bad","widgetRows":[],"${key}":{"polluted":true}}}`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(state.doc.pages['page-9']).toBeUndefined();
      expect(state.doc.pages['page-1']).toBeDefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops a persisted filter carrying an own "%s" top-level key, sparing valid siblings (T2-2)',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        filters: JSON.parse(
          `[{"id":"page-f","field":"date","operator":"equals","value":"","scope":{"kind":"page"}},` +
            `{"id":"bad","field":"x","operator":"equals","value":1,"scope":{"kind":"page"},"${key}":{"polluted":true}}]`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(state.doc.filters.map((f) => f.id)).toEqual(['page-f']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  // ── load-boundary own-key screen extended to the remaining channels (T2-4) ────
  // `dashboard`/`relationships`/`expressionFields`/`ai`(+threads)/preset inner filters were
  // previously loaded verbatim (no own-key screen), so a shared/hand-edited doc carrying an own
  // `__proto__`/`constructor`/`prototype` DATA key round-tripped forever and could poison a later
  // spread. The screen is now symmetric with the widgets/pages/filters channels.
  it.each(['__proto__', 'constructor', 'prototype'])(
    'strips an own "%s" key from the persisted dashboard, keeping the rest (T2-4)',
    (key) => {
      const activePageId = Object.keys(minimalSerialized.pages)[0];
      const serialized = {
        ...minimalSerialized,
        dashboard: JSON.parse(
          `{"id":"d","title":"T","activePageId":"${activePageId}","${key}":{"polluted":true}}`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(Object.hasOwn(state.doc.dashboard, key)).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(state.doc.dashboard.title).toBe('T');
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops a persisted relationships entry carrying an own "%s" key (T2-4)',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        relationships: JSON.parse(
          `[{"id":"r1","sourceId":"a","sourceField":"x","targetId":"b","targetField":"y","type":"many-to-one"},` +
            `{"id":"r2","sourceId":"c","sourceField":"x","targetId":"d","targetField":"y","type":"many-to-one","${key}":{"polluted":true}}]`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(state.doc.relationships.map((r) => r.id)).toEqual(['r1']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops a persisted expressionFields entry carrying an own "%s" key (T2-4)',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        expressionFields: JSON.parse(
          `[{"id":"ef1","label":"A","sourceId":"a","isMeasure":false,"expression":{"id":"amount"}},` +
            `{"id":"ef2","label":"B","sourceId":"b","isMeasure":false,"expression":{"id":"amount"},"${key}":{"polluted":true}}]`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(state.doc.expressionFields.map((ef) => ef.id)).toEqual(['ef1']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'strips an own "%s" key from the persisted ai container, keeping its threads (T2-4)',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        ai: JSON.parse(
          `{"threads":[{"id":"t1","name":"T1"}],"activeThreadId":"t1","${key}":{"polluted":true}}`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(Object.hasOwn(state.doc.ai!, key)).toBe(false);
      expect(state.doc.ai!.threads.map((t) => t.id)).toEqual(['t1']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops a persisted ai thread carrying an own "%s" key (T2-4)',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        ai: JSON.parse(
          `{"threads":[{"id":"t1","name":"T1"},{"id":"t2","name":"T2","${key}":{"polluted":true}}],"activeThreadId":"t1"}`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(state.doc.ai!.threads.map((t) => t.id)).toEqual(['t1']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops a preset inner filter carrying an own "%s" key so applyFilterPreset never rematerializes it (T2-4)',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        filterPresets: JSON.parse(
          `[{"id":"p1","name":"P","filters":[` +
            `{"id":"f1","field":"x","operator":"equals","value":1},` +
            `{"id":"f2","field":"y","operator":"equals","value":2,"${key}":{"polluted":true}}]}]`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(state.doc.filterPresets![0].filters.map((f) => f.id)).toEqual(['f1']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  // The last gap in this file's own-key coverage: the preset CONTAINER itself was the only
  // entry-level record not screened. Its two array siblings (`relationships[i]`,
  // `expressionFields[i]`, via `screenRecordArray`) and the level BELOW it (the preset's
  // inner filters, just above) both screened. Not exploitable today — every rewrite of a
  // preset uses spread/define semantics (`docTransforms`' `renameFilterPreset` does
  // `{ ...p, name }`) — but the key round-trips through every autosave forever.
  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops a filterPreset carrying an own "%s" key (finding 7)',
    (key) => {
      const serialized = {
        ...minimalSerialized,
        filterPresets: JSON.parse(
          `[{"id":"p1","name":"P","filters":[]},` +
            `{"id":"p2","name":"Q","filters":[],"${key}":{"polluted":true}}]`,
        ),
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(state.doc.filterPresets!.map((p) => p.id)).toEqual(['p1']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      // And the drop survives the round trip, rather than being re-persisted.
      expect(serializeDoc(state.doc).filterPresets!.map((p) => p.id)).toEqual(['p1']);
    },
  );

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

  // T3-2: an orphan `widget`-scoped filter whose `widgetId` names no loaded widget is dead weight
  // the reducer can never clean up, so it is dropped on load (symmetric with the reducer's
  // `addFilter` guard) — while a widget-scoped filter naming a real widget is kept.
  it('drops an orphan widget-scoped filter but keeps one whose widgetId exists (T3-2)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: { id: 'w1', kind: 'chart', title: 'C', config: { chartType: 'bar' } } },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      dashboard: { id: 'd', title: 'T', activePageId: 'page-1' },
      filters: [
        {
          id: 'kept',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'widget', widgetId: 'w1' },
        },
        {
          id: 'orphan',
          field: 'y',
          operator: 'equals',
          value: 2,
          scope: { kind: 'widget', widgetId: 'ghost' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['kept']);
  });

  // Iteration-20 finding: the load boundary already dropped an orphan WIDGET-scoped
  // filter (the test above), but had no equivalent cleanup for a filter anchored to a
  // `pageId` that no longer exists — the PAGE-anchor mirror of that same widget-anchor
  // check, mirroring the reducer's `removePage` cleanup (`applyMutation.ts`'s
  // `filtersAfterPageDrop`).
  it('drops a page-scoped filter whose pageId names no loaded page, but keeps one whose page exists (page-anchor cleanup)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {},
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      dashboard: { id: 'd', title: 'T', activePageId: 'page-1' },
      filters: [
        {
          id: 'kept',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'page', pageId: 'page-1' },
        },
        {
          id: 'orphan-page',
          field: 'y',
          operator: 'equals',
          value: 2,
          scope: { kind: 'page', pageId: 'ghost-page' },
        },
        // A `page`-scoped filter with NO `pageId` (legacy "applies on every page") is
        // never dropped by this cleanup.
        {
          id: 'no-page-id',
          field: 'z',
          operator: 'equals',
          value: 3,
          scope: { kind: 'page' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id).sort()).toEqual(['kept', 'no-page-id']);
  });

  it('drops a dashboard-date-range filter whose pageId names no loaded page', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {},
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      dashboard: { id: 'd', title: 'T', activePageId: 'page-1' },
      filters: [
        {
          id: 'orphan-range',
          field: 'date',
          operator: 'equals',
          value: '',
          scope: { kind: 'dashboard-date-range', sourceId: 'orders', pageId: 'ghost-page' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters).toEqual([]);
  });

  // Finding 1 (iteration-27): a `page`-scoped filter's `pageId` is OPTIONAL, so it was
  // never type-checked anywhere, and the load-boundary page-anchor screen's
  // `Object.hasOwn(normalizedPages, scope.pageId)` COERCES a numeric `pageId` to match a
  // string-keyed page — a numeric `pageId` matching an existing page key would otherwise
  // round-trip through serialize/deserialize forever instead of being dropped/repaired.
  // `isValidFilterScope` (shared with the wire boundary) now type-checks the `page` kind's
  // optional `pageId` too, so a numeric value is rejected before this screen ever runs.
  it('drops a persisted page-scoped filter whose pageId is a number, even when it numerically matches a page key', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {},
      pages: { '1': { id: '1', title: 'P1', widgetRows: [] } },
      dashboard: { id: 'd', title: 'T', activePageId: '1' },
      filters: [
        {
          id: 'numeric-page-id',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'page', pageId: 1 },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters).toEqual([]);
    // Round-tripping again must not resurrect it either.
    const reserialized = serializeDoc(state.doc);
    expect(reserialized.filters).toEqual([]);
  });

  // Iteration-20 finding: the wire boundary (`parseStateMutation.ts`'s `validateWidget`)
  // already rejects a widget with a missing/non-string `kind`/`title`, but the load
  // boundary accepted the same shape. The persisted widget is now dropped whole, matching
  // this file's other fail-closed structural checks in this same filter.
  it('drops a persisted widget with a non-string kind', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: { id: 'w1', kind: 42, title: 'C', config: {} } },
      pages: {},
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.widgets.w1).toBeUndefined();
  });

  it('drops a persisted widget with a missing title', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: { id: 'w1', kind: 'chart', config: { chartType: 'bar' } } },
      pages: {},
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.widgets.w1).toBeUndefined();
  });

  it('keeps a well-formed persisted widget with a string kind/title', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: chart('w1') },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.widgets.w1).toBeDefined();
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

  // Tier2 finding: `scope` was the one nested record never screened for the prototype-
  // hazard denylist at the load boundary — the filter's OWN top-level keys, a widget, and
  // a widget's config were all already screened, but `isValidFilterScope` (reused from the
  // wire boundary) only checked `kind`/required id fields, not unsafe own keys, on `scope`
  // itself. A hand-edited/shared doc carrying an own `__proto__`/`constructor`/`prototype`
  // key on `scope` previously loaded verbatim and would poison a later spread of it.
  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops a persisted filter whose scope carries an own "%s" key',
    (key) => {
      // Computed-key object-literal syntax (`{ [key]: … }`) creates an OWN data property
      // even for `key === '__proto__'` (unlike the non-computed `{ __proto__: … }` literal,
      // which sets the real prototype) — the same shape `JSON.parse` produces on a
      // shared/hand-edited doc.
      const serialized = {
        ...minimalSerialized,
        filters: [
          {
            id: 'bad',
            field: 'x',
            operator: 'equals',
            value: '',
            scope: { kind: 'page', pageId: 'page-1', [key]: { polluted: true } },
          },
          { id: 'page-f', field: 'date', operator: 'equals', value: '', scope: { kind: 'page' } },
        ],
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(state.doc.filters.map((f) => f.id)).toEqual(['page-f']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  // T2-1 (revert): a doc whose ONLY defect is one filter with a well-formed-but-incomplete
  // scope (`scope: { kind: 'widget' }`, no `widgetId`) must NOT be lost. `migrateState`'s
  // crash-prevention gate lets it through, and `deserializeState`'s per-entry
  // `isValidFilterScope` screen drops JUST that one filter while every page / widget /
  // expression field / other filter loads intact.
  it('migrates and loads a doc, dropping only a filter with an incomplete widget scope (T2-1)', () => {
    const serialized = completeSerialized({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      dashboard: { id: 'd', title: 'T', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      widgets: { w1: { id: 'w1', kind: 'chart', title: 'C', config: { chartType: 'bar' } } },
      expressionFields: [
        {
          id: 'ef1',
          sourceId: 's1',
          label: 'total',
          isMeasure: false,
          expression: { operator: 'add', inputs: [{ id: 'a' }, { id: 'b' }] },
        },
      ],
      filters: [
        // The sole defect: a well-formed-but-incomplete scope (missing `widgetId`).
        { id: 'bad', field: 'x', operator: 'equals', value: '', scope: { kind: 'widget' } },
        // A fully valid page-scoped filter that MUST survive.
        { id: 'page-f', field: 'date', operator: 'equals', value: '', scope: { kind: 'page' } },
      ],
    });

    // Previously this migrate FAILED (returned null) and the whole dashboard was lost.
    const migration = migrateState(serialized);
    expect(migration.success).toBe(true);
    expect(migration.state).not.toBeNull();

    const state = deserializeState(migration.state as typeof minimalSerialized, {});
    // Only the incomplete filter is dropped; the valid one survives.
    expect(state.doc.filters.map((f) => f.id)).toEqual(['page-f']);
    // Everything else is intact.
    expect(Object.keys(state.doc.pages)).toEqual(['page-1']);
    expect(state.doc.widgets.w1).toBeDefined();
    expect(state.doc.expressionFields.map((ef) => ef.id)).toEqual(['ef1']);
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

  // Finding 1b: `Object.hasOwn(normalizedPages, dashboard.activePageId)` COERCES a
  // numeric `activePageId` to match a string-keyed page entry (`42` matching key
  // `"42"`), so without a `typeof … === 'string'` guard this numeric value would be
  // treated as "valid" and round-trip through this reconciliation forever, never
  // healed to a real string page id — the bug survives a `setActivePage` reducer fix
  // (Finding 1) that no longer PRODUCES this state, but a pre-existing/hand-edited
  // persisted doc could still carry one.
  it('reconciles a numeric activePageId matching a string page key to a valid string (Finding 1b)', () => {
    const serialized = {
      ...minimalSerialized,
      dashboard: { id: 'd', title: 'T', activePageId: 42 },
      pages: { '42': { id: '42', title: 'P42', widgetRows: [] } },
      widgets: {},
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.dashboard.activePageId).toBe('42');
    expect(typeof state.doc.dashboard.activePageId).toBe('string');
  });

  it('synthesizes the default page and points activePageId at it when the page map is empty', () => {
    const serialized = {
      ...minimalSerialized,
      dashboard: { id: 'd', title: 'T', activePageId: 'nope' },
      pages: {},
      widgets: {},
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(Object.keys(state.doc.pages)).toEqual(['page-1']);
    expect(state.doc.dashboard.activePageId).toBe('page-1');
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

  // ── per-entry screening of the three collections on load (Finding 1) ─────────
  // The prior code coerced only the CONTAINER, so a junk ENTRY (`[null]`) installed
  // verbatim, crashed the client on first use, and round-tripped through every autosave.
  it('drops non-record relationships / expressionFields entries on load (Finding 1)', () => {
    const goodRel = {
      id: 'r1',
      sourceId: 'a',
      sourceField: 'x',
      targetId: 'b',
      targetField: 'y',
      type: 'many-to-one',
    };
    const goodEf = {
      id: 'ef1',
      label: 'Rev',
      sourceId: 'a',
      isMeasure: false,
      expression: { id: 'amount' },
    };
    const serialized = {
      ...minimalSerialized,
      relationships: [null, goodRel, 'junk'],
      expressionFields: [goodEf, 42],
    } as unknown as typeof minimalSerialized;
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState(serialized, {});
    }).not.toThrow();
    // Only the record entries survive; primitives/null are dropped.
    expect(state.doc.relationships).toEqual([goodRel]);
    expect(state.doc.expressionFields).toEqual([goodEf]);
    // The cleaned doc round-trips without re-persisting the junk.
    expect(() => serializeState(state)).not.toThrow();
  });

  it("drops a non-record filterPreset and screens a preset's inner filters (Finding 1)", () => {
    const goodFilter = {
      id: 'pf',
      field: 'x',
      operator: 'equals',
      value: '',
      scope: { kind: 'page' },
    };
    const serialized = {
      ...minimalSerialized,
      filterPresets: [
        null,
        { id: 'p1', name: 'Preset 1', filters: [null, goodFilter] },
        // A preset with no `filters` array is itself junk and is dropped.
        { id: 'p2', name: 'No filters array' },
      ],
    } as unknown as typeof minimalSerialized;
    let state!: ReturnType<typeof deserializeState>;
    expect(() => {
      state = deserializeState(serialized, {});
    }).not.toThrow();
    expect(state.doc.filterPresets).toHaveLength(1);
    expect(state.doc.filterPresets![0].id).toBe('p1');
    // The `null` inner filter entry is screened out; only the record survives.
    expect(state.doc.filterPresets![0].filters).toHaveLength(1);
    expect(state.doc.filterPresets![0].filters[0].id).toBe('pf');
  });

  // F1: `screenFilterPresets` validated the preset container (record + array `filters`)
  // but never `preset.name`, which `StudioFiltersDrawer` renders VERBATIM as a Chip
  // `label` — a non-string `name` crashes that render as an invalid React child.
  // Repair-in-place (coerce to a fallback string) rather than drop the whole preset.
  it('coerces a non-string filterPreset name to a fallback on load (F1)', () => {
    const serialized = {
      ...minimalSerialized,
      filterPresets: [{ id: 'p1', name: 42, filters: [] }],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filterPresets).toHaveLength(1);
    expect(state.doc.filterPresets![0].id).toBe('p1');
    expect(typeof state.doc.filterPresets![0].name).toBe('string');
  });

  it('leaves well-formed relationships / filterPresets reference-stable (Finding 1)', () => {
    const relationships = [
      {
        id: 'r1',
        sourceId: 'a',
        sourceField: 'x',
        targetId: 'b',
        targetField: 'y',
        type: 'many-to-one',
      },
    ];
    const filterPresets = [
      {
        id: 'p1',
        name: 'P',
        filters: [{ id: 'f', field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } }],
      },
    ];
    const serialized = {
      ...minimalSerialized,
      relationships,
      filterPresets,
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // Nothing was dropped, so the SAME array references are carried through (no churn).
    expect(state.doc.relationships).toBe(relationships);
    expect(state.doc.filterPresets).toBe(filterPresets);
    expect(state.doc.filterPresets![0].filters).toBe(filterPresets[0].filters);
  });

  // ── closed-union leaf membership at the load boundary (Finding 2) ────────────
  it('drops a filter whose operator is not a member of the closed union (Finding 2)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        // `equal` is a plausible typo for `equals` — an active chip that filters nothing.
        { id: 'bad-op', field: 'x', operator: 'equal', value: '', scope: { kind: 'page' } },
        { id: 'ok', field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['ok']);
  });

  it('drops a filter whose present operator2 is not a member (Finding 2)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        {
          id: 'bad-op2',
          field: 'x',
          operator: 'equals',
          operator2: 'nope',
          value: '',
          scope: { kind: 'page' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters).toHaveLength(0);
  });

  it('drops a doc.filter whose field is not a string (T2-3, symmetric with the wire boundary)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        // `field: 42` would install an active-but-unevaluable filter that silently renders
        // every widget in scope empty — the wire boundary (`parseStateMutation`) rejects the
        // identical payload, so the load boundary must too.
        { id: 'bad-field', field: 42, operator: 'equals', value: '', scope: { kind: 'page' } },
        { id: 'ok', field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['ok']);
  });

  it('drops a persisted filter whose id is not a string (Finding 3.2, symmetric with the wire boundary)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        // A non-string `id` can NEVER be matched by wire `removeFilter` (`f.id !== filterId`
        // compares against a string), so it would install a permanently-unremovable filter —
        // the wire boundary (`isSafeId`) rejects the identical payload, so the load boundary
        // must too.
        { id: 42, field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } },
        { id: 'ok', field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['ok']);
  });

  it("screens a preset's inner filters for a junk operator/field (T2-3)", () => {
    // A preset carries only RECORD-checked inner filters through `migrateState`, but
    // `applyFilterPreset` rematerializes them VERBATIM (minus id/scope) into live
    // `doc.filters`, so a junk `operator: 'equal'` (typo for 'equals') or a non-string
    // `field` must be screened at load — one indirection past the `doc.filters` screen.
    const serialized = {
      ...minimalSerialized,
      filterPresets: [
        {
          id: 'p1',
          name: 'Preset 1',
          filters: [
            { id: 'bad-op', field: 'x', operator: 'equal', value: 'EU', scope: { kind: 'page' } },
            {
              id: 'bad-field',
              field: 42,
              operator: 'equals',
              value: 'EU',
              scope: { kind: 'page' },
            },
            {
              id: 'bad-op2',
              field: 'x',
              operator: 'equals',
              operator2: 'nope',
              value: 'EU',
              scope: { kind: 'page' },
            },
            { id: 'ok', field: 'region', operator: 'equals', value: 'EU', scope: { kind: 'page' } },
          ],
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filterPresets).toHaveLength(1);
    // Only the well-formed inner filter survives; the three junk ones are dropped.
    expect(state.doc.filterPresets![0].filters.map((f) => f.id)).toEqual(['ok']);
  });

  it('drops a filter whose scope.kind is not a member of the closed union (Finding 2)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        // `pages` (typo for `page`) would otherwise survive as a permanent inert entry.
        { id: 'bad-scope', field: 'x', operator: 'equals', value: '', scope: { kind: 'pages' } },
        { id: 'ok', field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['ok']);
  });

  // Iteration-22 finding (Tier 2 #2): `parseStateMutation.ts`'s `validateFilter` rejects a
  // live `addFilter` whose `dependsOn` is not a `string[]`, but neither this load screen nor
  // `isPresetFilterSafe` applied the same check — so a persisted doc with a malformed
  // `dependsOn` (e.g. a bare string) loaded successfully and later crashed
  // `StudioFiltersDrawer`'s `dependsOn.map(...)` the first time the filter rendered. The KEY
  // is repaired (dropped) rather than the whole filter, mirroring how a bad widget
  // `titleMode`/`subtitleMode` is stripped rather than dropping the widget.
  it('repairs (drops) a malformed dependsOn on a persisted filter instead of dropping the whole filter or crashing (T2 finding)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        {
          id: 'f1',
          field: 'x',
          operator: 'equals',
          value: '',
          scope: { kind: 'page' },
          dependsOn: 'not-an-array',
        },
        {
          id: 'f2',
          field: 'y',
          operator: 'equals',
          value: '',
          scope: { kind: 'page' },
          dependsOn: ['f1', 42],
        },
        {
          id: 'f3',
          field: 'z',
          operator: 'equals',
          value: '',
          scope: { kind: 'page' },
          dependsOn: ['f1'],
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // All three filters survive — a malformed `dependsOn` is repaired, not treated as
    // grounds to drop the whole filter.
    expect(state.doc.filters.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    const [f1, f2, f3] = state.doc.filters;
    expect(f1.dependsOn).toBeUndefined();
    expect(f2.dependsOn).toBeUndefined();
    // A well-formed dependsOn is left untouched.
    expect(f3.dependsOn).toEqual(['f1']);
  });

  // Entropy-audit finding: this load screen shares its shape check with the wire boundary
  // (`isStringArray`-equivalent), but had no SIZE cap of its own — a persisted/shared doc
  // is exactly the untrusted boundary an unbounded `dependsOn` array is a DoS shape against.
  //
  // Every id in the oversized `dependsOn` below names a REAL filter this doc also carries
  // (`w0`..`w500`), so the separate dangling-reference prune (`pruneDependsOn`, which runs
  // AFTER this repair and would otherwise strip every entry as an orphan reference, masking
  // whether the size cap itself did anything) cannot be what drops them — isolating the size
  // cap as the only mechanism that can produce this test's expectation.
  it('repairs (drops) an oversized dependsOn on a persisted filter (dependsOn size cap)', () => {
    const dependsOnIds = Array.from({ length: 501 }, (_, i) => `w${i}`);
    const serialized = {
      ...minimalSerialized,
      filters: [
        {
          id: 'f1',
          field: 'x',
          operator: 'equals',
          value: '',
          scope: { kind: 'page' },
          dependsOn: dependsOnIds,
        },
        ...dependsOnIds.map((id) => ({
          id,
          field: 'y',
          operator: 'equals',
          value: '',
          scope: { kind: 'page' },
        })),
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters).toHaveLength(1 + dependsOnIds.length);
    const f1 = state.doc.filters.find((f) => f.id === 'f1');
    expect(f1?.dependsOn).toBeUndefined();
  });

  it('repairs (drops) a malformed dependsOn on a preset inner filter (T2 finding)', () => {
    const serialized = {
      ...minimalSerialized,
      filterPresets: [
        {
          id: 'p1',
          name: 'Preset 1',
          filters: [
            {
              id: 'pf1',
              field: 'x',
              operator: 'equals',
              value: 'EU',
              scope: { kind: 'page' },
              dependsOn: 'not-an-array',
            },
          ],
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filterPresets).toHaveLength(1);
    // The preset filter survives, but the malformed dependsOn is gone.
    expect(state.doc.filterPresets![0].filters.map((f) => f.id)).toEqual(['pf1']);
    expect((state.doc.filterPresets![0].filters[0] as { dependsOn?: unknown }).dependsOn).toBe(
      undefined,
    );
  });

  // Iteration-22 finding (T3 #9): `addFilter` enforces "at most one rank filter per page
  // context" on every LIVE add (`hasConflictingRankFilter`), but that invariant was never
  // re-checked at the load boundary — a hand-edited/foreign doc could load with two
  // conflicting rank filters on the same page.
  it('drops a second conflicting rank filter on the same page at load, keeping the first (T3 finding)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        {
          id: 'rank-1',
          field: 'x',
          operator: 'equals',
          value: '',
          filterMode: 'rank',
          scope: { kind: 'page', pageId: 'page-1' },
        },
        {
          id: 'rank-2',
          field: 'y',
          operator: 'equals',
          value: '',
          filterMode: 'rank',
          scope: { kind: 'page', pageId: 'page-1' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['rank-1']);
  });

  // Finding 3 (iteration-28): the load boundary never deduped filters sharing an `id`,
  // which also defeated the rank-uniqueness dedup (`hasConflictingRankFilter` self-excludes
  // the entry whose id it checks, so two identical-id rank filters both survived). First
  // occurrence must win, mirroring the `dedupeLayoutRows` convention.
  it('drops a duplicate filter id at load, keeping the first occurrence (Finding 3)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        {
          id: 'dup',
          field: 'x',
          operator: 'equals',
          value: 'first',
          scope: { kind: 'page', pageId: 'page-1' },
        },
        {
          id: 'dup',
          field: 'y',
          operator: 'equals',
          value: 'second',
          scope: { kind: 'page', pageId: 'page-1' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['dup']);
    expect(state.doc.filters[0].value).toBe('first');
  });

  // The dedup CLAIM must happen only after every other drop-check has passed. Claiming it
  // where the duplicate test runs meant an entry that was subsequently DROPPED had already
  // consumed its id, so a later, perfectly valid filter sharing that id was rejected as a
  // duplicate — both lost, silently, and the next autosave persisted the loss.
  //
  // One case per drop-check that runs after the dedup test, so a future reordering that
  // reintroduces an early claim fails here rather than in production.
  it.each([
    [
      'a stripped cross-filter scope',
      { kind: 'cross-filter', sourceWidgetId: 'w-gone', pageId: 'page-1' },
      'x',
      'equals',
    ],
    ['an orphan page anchor', { kind: 'page', pageId: 'page-that-does-not-exist' }, 'x', 'equals'],
    ['an orphan widget anchor', { kind: 'widget', widgetId: 'w-gone' }, 'x', 'equals'],
    ['a non-string field', { kind: 'page', pageId: 'page-1' }, 42, 'equals'],
    ['an unknown operator', { kind: 'page', pageId: 'page-1' }, 'x', 'equal'],
  ])(
    'does not let a filter dropped for %s consume its id (the valid duplicate survives)',
    (_label, scope, field, operator) => {
      const serialized = {
        ...minimalSerialized,
        filters: [
          { id: 'f1', field, operator, value: 'dropped', scope },
          {
            id: 'f1',
            field: 'country',
            operator: 'equals',
            value: 'kept',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      } as unknown as typeof minimalSerialized;
      const state = deserializeState(serialized, {});
      expect(state.doc.filters).toHaveLength(1);
      expect(state.doc.filters[0].value).toBe('kept');
    },
  );

  it('still drops a duplicate of a filter that SURVIVED the whole screen', () => {
    // The complement of the cases above: when the first occurrence is kept, the second must
    // still be rejected — the dedup is moved, not weakened.
    const serialized = {
      ...minimalSerialized,
      filters: [
        {
          id: 'f1',
          field: 'a',
          operator: 'equals',
          value: 'first',
          scope: { kind: 'page', pageId: 'page-1' },
        },
        {
          id: 'f1',
          field: 'b',
          operator: 'equals',
          value: 'second',
          scope: { kind: 'page', pageId: 'page-1' },
        },
        {
          id: 'f1',
          field: 'c',
          operator: 'equals',
          value: 'third',
          scope: { kind: 'page', pageId: 'page-1' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.value)).toEqual(['first']);
  });

  it('drops two identical-id rank filters down to the first at load (Finding 3, rank-dedup escape)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        {
          id: 'rank-dup',
          field: 'x',
          operator: 'equals',
          value: '',
          filterMode: 'rank',
          scope: { kind: 'page', pageId: 'page-1' },
        },
        {
          id: 'rank-dup',
          field: 'x',
          operator: 'equals',
          value: '',
          filterMode: 'rank',
          scope: { kind: 'page', pageId: 'page-1' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters).toHaveLength(1);
    expect(state.doc.filters[0].id).toBe('rank-dup');
  });

  it('keeps two rank filters on DIFFERENT pages at load (not a global uniqueness constraint)', () => {
    const serialized = {
      ...minimalSerialized,
      pages: {
        ...minimalSerialized.pages,
        'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
      },
      filters: [
        {
          id: 'rank-1',
          field: 'x',
          operator: 'equals',
          value: '',
          filterMode: 'rank',
          scope: { kind: 'page', pageId: 'page-1' },
        },
        {
          id: 'rank-2',
          field: 'y',
          operator: 'equals',
          value: '',
          filterMode: 'rank',
          scope: { kind: 'page', pageId: 'page-2' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['rank-1', 'rank-2']);
  });

  // Finding 3 (iteration-27): the load-boundary rank dedup reused `hasConflictingRankFilter`,
  // whose existing-filter loop previously excluded only `cross-filter` scopes (not
  // `interactive`/`dashboard-date-range`). A hand-edited/foreign doc's `filterMode: 'rank'`
  // filter on a `dashboard-date-range` scope resolves to a `null` page context, which
  // conflicts with — and is conflicted by — every other rank filter, so it must not cause a
  // legitimate `page`-scoped rank filter to be dropped on load.
  it('a persisted rank-mode filter on a dashboard-date-range scope does not poison a legitimate page rank filter at load', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        {
          id: 'date-range-rank',
          field: 'date',
          operator: 'equals',
          value: '',
          filterMode: 'rank',
          scope: { kind: 'dashboard-date-range', sourceId: 'orders', pageId: 'page-1' },
        },
        {
          id: 'page-rank',
          field: 'x',
          operator: 'equals',
          value: '',
          filterMode: 'rank',
          scope: { kind: 'page', pageId: 'page-1' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id).sort()).toEqual(['date-range-rank', 'page-rank']);
  });

  // ── load↔wire filter-scope symmetry (T3-1) ───────────────────────────────────
  // The wire boundary (`parseStateMutation`'s `isValidFilterScope`) rejects a scope that
  // is missing a required id field; the load boundary now shares that predicate. A
  // `dashboard-date-range` scope without `sourceId` would otherwise mis-apply a date
  // window, so it must be dropped on load exactly as the byte-identical wire payload is
  // rejected.
  it('drops a persisted dashboard-date-range filter whose scope is missing sourceId (T3-1)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        // No `sourceId` — an invalid `dashboard-date-range` scope the wire boundary rejects.
        {
          id: 'bad-range',
          field: 'date',
          operator: 'between',
          value: '',
          scope: { kind: 'dashboard-date-range', pageId: 'page-1' },
        },
        { id: 'ok', field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['ok']);
  });

  it('keeps a well-formed persisted dashboard-date-range filter on load (T3-1)', () => {
    const serialized = {
      ...minimalSerialized,
      filters: [
        {
          id: 'range',
          field: 'date',
          operator: 'between',
          value: '',
          scope: { kind: 'dashboard-date-range', sourceId: 'orders', pageId: 'page-1' },
        },
      ],
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['range']);
  });

  it('drops a non-member config.chartType key, keeping the widget for the bar fallback (Finding 2)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {
        w1: {
          id: 'w1',
          kind: 'chart',
          title: 'C',
          config: { chartType: 'trendline', xField: 'a' },
        },
      },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // The widget survives (not dropped), the junk chartType key is removed so
    // `resolveChartType`'s 'bar' fallback applies, and sibling keys are preserved.
    expect(state.doc.widgets.w1).toBeDefined();
    expect(Object.hasOwn(state.doc.widgets.w1.config, 'chartType')).toBe(false);
    expect((state.doc.widgets.w1.config as { xField?: string }).xField).toBe('a');
    expect(() => serializeState(state)).not.toThrow();
  });

  it('keeps a valid config.chartType untouched (Finding 2)', () => {
    const widget = {
      id: 'w1',
      kind: 'chart',
      title: 'C',
      config: { chartType: 'line' },
    };
    const serialized = {
      ...minimalSerialized,
      widgets: { w1: widget },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // A valid chartType with no legacy columns/ySeries to normalize is a pure no-op:
    // the SAME widget reference is carried through.
    expect(state.doc.widgets.w1).toBe(serialized.widgets.w1);
  });

  // T3-1: the load boundary screens the widget-level `titleMode`/`subtitleMode`, symmetric
  // with the wire boundary's `isTitleModeValue` gate. A persisted `titleMode: 42` loads
  // with the key DROPPED (mirroring the junk-`chartType` key-drop), the rest of the widget
  // intact, so the client's auto-title `'auto'` default applies.
  it('drops a non-auto/manual titleMode on a persisted widget, keeping the rest (T3-1)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {
        w1: {
          id: 'w1',
          kind: 'chart',
          title: 'C',
          titleMode: 42,
          subtitleMode: 'manual',
          config: { chartType: 'bar' },
        },
      },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    const w1 = state.doc.widgets.w1 as StudioWidget;
    // The junk `titleMode` key is removed; the valid `subtitleMode` and the rest survive.
    expect(w1).toBeDefined();
    expect(Object.hasOwn(w1, 'titleMode')).toBe(false);
    expect(w1.subtitleMode).toBe('manual');
    expect(w1.title).toBe('C');
    expect((w1.config as { chartType?: string }).chartType).toBe('bar');
    expect(() => serializeState(state)).not.toThrow();
  });

  // Finding 3: the load boundary screens the widget-level `subtitle`/`sourceId`, symmetric
  // with the wire boundary's `isOptionalString` gates in `validateWidget`
  // (`parseStateMutation.ts`). A persisted `subtitle: 42`/`sourceId: 42` loads with the
  // offending key DROPPED (mirroring the `titleMode`/`subtitleMode` key-drop above), the
  // rest of the widget intact — a junk `subtitle` previously crashed
  // `StudioWidgetEditDialog` (rendered directly as text), and a junk `sourceId` silently
  // broke the widget-to-data-source lookup with no self-heal.
  it('drops a non-string subtitle/sourceId on a persisted widget, keeping the rest (finding 3)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {
        w1: {
          id: 'w1',
          kind: 'chart',
          title: 'C',
          subtitle: 42,
          sourceId: 42,
          config: { chartType: 'bar' },
        },
      },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    const w1 = state.doc.widgets.w1 as StudioWidget;
    expect(w1).toBeDefined();
    expect(Object.hasOwn(w1, 'subtitle')).toBe(false);
    expect(Object.hasOwn(w1, 'sourceId')).toBe(false);
    expect(w1.title).toBe('C');
    expect(() => serializeState(state)).not.toThrow();
  });

  it('keeps a valid string subtitle/sourceId on a persisted widget (finding 3)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {
        w1: {
          id: 'w1',
          kind: 'chart',
          title: 'C',
          subtitle: 'Sub',
          sourceId: 'src-1',
          config: { chartType: 'bar' },
        },
      },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    const w1 = state.doc.widgets.w1 as StudioWidget;
    expect(w1.subtitle).toBe('Sub');
    expect(w1.sourceId).toBe('src-1');
  });

  // Finding 3.2: the load boundary screens a persisted widget's OWN `config` keys for the
  // prototype-hazard denylist, symmetric with the wire boundary's `hasUnsafeOwnKeys` gate.
  // Following the fail-closed drop-invalid-entry convention, the whole widget is dropped.
  it('drops a persisted widget whose config carries an own __proto__ key (Finding 3.2)', () => {
    const serialized = {
      ...minimalSerialized,
      widgets: {
        // A `JSON.parse`d config carrying an own `__proto__` key — the wire boundary rejects
        // the identical payload, so the load boundary drops the offending widget entry.
        w1: {
          id: 'w1',
          kind: 'chart',
          title: 'Bad',
          config: JSON.parse('{"chartType":"bar","__proto__":{"x":1}}'),
        },
        w2: { id: 'w2', kind: 'chart', title: 'Good', config: { chartType: 'bar' } },
      },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1'], ['w2']] } },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    // Only the clean widget survives; the unsafe-config widget is dropped.
    expect(Object.keys(state.doc.widgets)).toEqual(['w2']);
    expect(() => serializeState(state)).not.toThrow();
  });

  // ── identity-preserving normalization for already-canonical config (Finding 5)
  // A non-empty but already-canonical `columns`/`ySeries` must NOT mint a fresh array
  // (and hence a fresh config/widget) on every load — that defeats cross-load memoization.
  it('leaves a widget with non-empty already-canonical columns reference-stable (Finding 5)', () => {
    const widget = {
      id: 'g1',
      kind: 'grid',
      title: 'Grid',
      // Object columns are already canonical — `normalizeGridColumn` returns them as-is.
      config: { columns: [{ fieldId: 'a' }, { fieldId: 'b' }] },
    };
    const serialized = {
      ...minimalSerialized,
      widgets: { g1: widget },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.widgets.g1).toBe(serialized.widgets.g1);
  });

  it('leaves a widget with non-empty already-canonical ySeries reference-stable (Finding 5)', () => {
    const widget = {
      id: 'c1',
      kind: 'chart',
      title: 'C',
      // `type` already set, no `seriesType` alias — `normalizeChartSeries` is a no-op.
      config: { chartType: 'line', ySeries: [{ fieldId: 'rev', type: 'line' }] },
    };
    const serialized = {
      ...minimalSerialized,
      widgets: { c1: widget },
    } as unknown as typeof minimalSerialized;
    const state = deserializeState(serialized, {});
    expect(state.doc.widgets.c1).toBe(serialized.widgets.c1);
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

  // Named for what it actually checks. The old name was "returns failure for invalid
  // JSON", but no invalid JSON ever reached `migrateState`: the test's own try/catch
  // absorbed the `SyntaxError` and handed over `null`, and the assertion then matched the
  // word "Invalid" inside an unrelated message. `migrateState` takes a PARSED value, so
  // `null` — what a caller's own failed parse hands it — is the real boundary input.
  it('migrateState returns failure for a null (unparseable) input', () => {
    const migrationResult = migrateState(null);
    expect(migrationResult.success).toBe(false);
    expect(migrationResult.state).toBeNull();
    expect(migrationResult.errors).not.toHaveLength(0);
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

  // The authoritative `StudioDoc` key set, locked to the INTERFACE rather than to any
  // fixture. `serializeDoc` is spread-based, so it carries a new doc field automatically,
  // but `deserializeState` rebuilds the doc from an explicit field literal — so a field
  // added to `StudioDoc` is serialized and then silently dropped on load unless that
  // literal is updated too. A REQUIRED new field fails to compile in `deserializeState`
  // (its return type is `StudioState`); an OPTIONAL one does not, which is the gap this
  // list closes: `satisfies Record<keyof StudioDoc, true>` makes adding ANY field to the
  // interface fail to compile here until it is listed, and the assertion below then fails
  // at runtime until `deserializeState` actually produces it.
  const STUDIO_DOC_KEYS = {
    schemaVersion: true,
    dashboard: true,
    pages: true,
    widgets: true,
    relationships: true,
    filters: true,
    expressionFields: true,
    filterPresets: true,
    ai: true,
  } satisfies Record<keyof StudioDoc, true>;

  it('a doc field cannot be forgotten: full doc round-trips to an identical doc', () => {
    const state = fullDocState();
    const roundTripped = deserializeState(serializeState(state), {});

    // Deep identity (minus stripped cross-filter entries — there are none here).
    expect(roundTripped.doc).toEqual(state.doc);
    // Key-set equality against the interface-locked list, NOT against the fixture: a
    // fixture-to-fixture comparison passes vacuously for a new optional field, since a
    // field nobody adds to `fullDocState` is absent from both sides.
    expect(new Set(Object.keys(roundTripped.doc))).toEqual(new Set(Object.keys(STUDIO_DOC_KEYS)));
    // The fixture is still required to populate every field, so the deep-identity
    // assertion above is meaningful for all of them rather than only the populated ones.
    expect(new Set(Object.keys(state.doc))).toEqual(new Set(Object.keys(STUDIO_DOC_KEYS)));
  });

  it('deserializeState emits every StudioDoc key even for a doc that populates none of the optional ones', () => {
    // The optional fields (`filterPresets`, `ai`) are the ones the fixture-driven gate
    // could not see. `deserializeState` assigns them unconditionally — as `undefined` when
    // absent — so the loaded doc's key set is the full interface regardless of input.
    const loaded = deserializeState(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        dashboard: { id: 'd', title: 'T', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [] } },
        widgets: {},
        filters: [],
      },
      {},
    );

    expect(new Set(Object.keys(loaded.doc))).toEqual(new Set(Object.keys(STUDIO_DOC_KEYS)));
    // `filterPresets` normalizes an absent value to the empty array (`screenFilterPresets`);
    // `ai` stays `undefined`, its documented "no threads yet" value.
    expect(loaded.doc.filterPresets).toEqual([]);
    expect(loaded.doc.ai).toBeUndefined();
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

// ─── M1: required-leaf screens at the load boundary ──────────────────────────
// The screens validated record-ness but not the leaves consumers dereference unguarded, so
// e.g. an `expressionFields` entry with no `expression` loaded with `success: true` and
// then crashed `expressionEvaluator`'s `'joinSourceId' in expr` on first use — with no
// self-heal, since `serializeDoc` re-persisted the junk forever.
describe('deserializeState required-leaf screens (M1)', () => {
  const minimal = serializeState(createDefaultStudioState());
  const goodEf = {
    id: 'ef1',
    label: 'Margin',
    sourceId: 's1',
    isMeasure: false,
    expression: { operator: 'subtract', inputs: [{ id: 'revenue' }, { id: 'cost' }] },
  };
  const goodRel = {
    id: 'r1',
    sourceId: 'orders',
    sourceField: 'customerId',
    targetId: 'customers',
    targetField: 'id',
    type: 'many-to-one',
  };

  it('drops an expressionFields entry with a missing/non-record expression', () => {
    const serialized = {
      ...minimal,
      expressionFields: [
        goodEf,
        // The exact reported shape: everything but `expression`.
        { id: 'e1', label: 'Margin', sourceId: 's1', isMeasure: false },
        { ...goodEf, id: 'ef3', expression: '1 + 1' },
      ],
    } as unknown as typeof minimal;
    const state = deserializeState(serialized, {});
    expect(state.doc.expressionFields.map((ef) => ef.id)).toEqual(['ef1']);
    // Self-heals: the junk is not re-persisted.
    expect(serializeState(state).expressionFields).toEqual([goodEf]);
  });

  it('drops an expressionFields entry with a non-string id/sourceId', () => {
    const serialized = {
      ...minimal,
      expressionFields: [goodEf, { ...goodEf, id: 42 }, { ...goodEf, id: 'ef3', sourceId: null }],
    } as unknown as typeof minimal;
    expect(deserializeState(serialized, {}).doc.expressionFields.map((ef) => ef.id)).toEqual([
      'ef1',
    ]);
  });

  it('drops a relationships entry missing an endpoint field or carrying an unknown type', () => {
    const serialized = {
      ...minimal,
      relationships: [
        goodRel,
        { ...goodRel, id: 'r2', targetField: undefined },
        { ...goodRel, id: 'r3', type: 'many-to-many-ish' },
      ],
    } as unknown as typeof minimal;
    expect(deserializeState(serialized, {}).doc.relationships.map((r) => r.id)).toEqual(['r1']);
  });

  it.each(['many-to-one', 'one-to-one', 'many-to-many'])(
    'keeps a relationship whose type is the known member "%s"',
    (type) => {
      const serialized = {
        ...minimal,
        relationships: [{ ...goodRel, type }],
      } as unknown as typeof minimal;
      expect(deserializeState(serialized, {}).doc.relationships).toHaveLength(1);
    },
  );

  it('screens ai.threads[*].messages entries, keeping the well-formed ones', () => {
    const serialized = {
      ...minimal,
      ai: {
        activeThreadId: 't1',
        threads: [
          {
            id: 't1',
            name: 'T',
            createdAt: '2026-01-01T00:00:00.000Z',
            messages: [{ role: 'user', content: 'hi' }, null, 'junk'],
          },
        ],
      },
    } as unknown as typeof minimal;
    const state = deserializeState(serialized, {});
    expect(state.doc.ai?.threads[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  // M1: `isRelationshipSafe` screened all four endpoint ids/fields and `type`, but omitted
  // the `id` check BOTH its siblings make (`isExpressionFieldSafe`, and the preset-inner
  // screen whose own comment calls `id` "the one field it shares with that screen"). `id` is
  // REQUIRED by `StudioRelationship` and is how the entry is addressed:
  // `StudioController.updateRelationship(id, patch)`/`removeRelationship(id)` key off
  // `rel.id`, and `RelationshipPanel` wires its delete button to
  // `removeRelationship(rel.id)`. A persisted relationship with no `id` (or `id: 42`)
  // therefore loaded, rendered in the data drawer, and was permanently unremovable and
  // unupdatable — re-persisted forever with no self-heal — while two such entries also
  // collided on the React list key.
  it('drops a relationships entry with a missing or non-string id (M1)', () => {
    const { id: omittedId, ...relWithoutId } = goodRel;
    expect(omittedId).toBe('r1');
    const serialized = {
      ...minimal,
      relationships: [goodRel, relWithoutId, { ...goodRel, id: 42 }],
    } as unknown as typeof minimal;
    const state = deserializeState(serialized, {});
    expect(state.doc.relationships.map((r) => r.id)).toEqual(['r1']);
    // Self-heals: the unaddressable entries are not re-persisted.
    expect(serializeState(state).relationships).toEqual([goodRel]);
  });

  // The OUTER sibling of the preset-inner-filter `id` screen just below, and of M1's:
  // `docTransforms`' `applyFilterPreset`/`removeFilterPreset`/rename all locate a preset with
  // `p.id === presetId` (a strict compare that never coerces) and the drawer keys its rows
  // off it, so a preset with no `id` loads, renders a chip, and can never be applied,
  // renamed or removed.
  it('drops a filterPresets entry whose own id is not a string', () => {
    const serialized = {
      ...minimal,
      filterPresets: [
        { id: 'p1', name: 'Kept', filters: [] },
        { name: 'No id', filters: [] },
        { id: 42, name: 'Numeric id', filters: [] },
      ],
    } as unknown as typeof minimal;
    const state = deserializeState(serialized, {});
    expect(state.doc.filterPresets?.map((p) => p.id)).toEqual(['p1']);
  });

  it('drops a preset inner filter whose id is not a string', () => {
    const serialized = {
      ...minimal,
      filterPresets: [
        {
          id: 'p1',
          name: 'P',
          filters: [
            { id: 'pf-ok', field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } },
            { id: 42, field: 'x', operator: 'equals', value: '', scope: { kind: 'page' } },
          ],
        },
      ],
    } as unknown as typeof minimal;
    const state = deserializeState(serialized, {});
    expect(state.doc.filterPresets?.[0].filters.map((f) => f.id)).toEqual(['pf-ok']);
  });
});

// ─── M4: deserializeState must refuse a NEWER schemaVersion ──────────────────
// `migrateState` has always rejected `fromVersion > CURRENT_SCHEMA_VERSION`, but
// `deserializeState` is a public export a host can call directly on
// `JSON.parse(localStorage.getItem(k))`. It used to read only the fields this version
// knows, drop every newer one, and stamp `schemaVersion: CURRENT_SCHEMA_VERSION` back —
// the host's next save then wrote the downgraded doc, permanently losing the newer data.
describe('deserializeState schemaVersion gate (M4)', () => {
  const minimal = serializeState(createDefaultStudioState());

  it('throws for a doc written by a NEWER Studio instead of silently downgrading', () => {
    const newer = {
      ...minimal,
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
    } as unknown as typeof minimal;
    expect(() => deserializeState(newer, {})).toThrow(/newer version of X Studio/);
    expect(() => deserializeState(newer, {})).toThrow(
      new RegExp(`schema version ${CURRENT_SCHEMA_VERSION + 1} to ${CURRENT_SCHEMA_VERSION}`),
    );
  });

  it('still loads the current version, an absent version, and a non-number version', () => {
    expect(() => deserializeState(minimal, {})).not.toThrow();
    const { schemaVersion: ignored, ...withoutVersion } = minimal;
    expect(() => deserializeState(withoutVersion as typeof minimal, {})).not.toThrow();
    // A junk (non-number) version is `migrateState`'s business, not a reason to refuse.
    expect(() =>
      deserializeState({ ...minimal, schemaVersion: 'v2' } as unknown as typeof minimal, {}),
    ).not.toThrow();
  });

  // L4: `deserializeState` is documented as TOTAL over a malformed `SerializedStudioState`
  // and as "a public export a host may call directly on
  // `JSON.parse(localStorage.getItem(k))`" — which returns `null` for a missing key. The
  // version read already anticipated that with `?.schemaVersion`, but the container reads
  // just below then threw `Cannot read properties of null (reading 'widgets')`: total over
  // every nested corruption, and not over the single most likely input. The whole argument
  // is now coerced to `{}` when it is not a record, so a nullish call yields exactly the
  // default state a `{}` argument already produced.
  it.each([null, undefined, 'junk', 42, []])(
    'is total over a non-record argument (%p) instead of throwing (L4)',
    (bogus) => {
      expect(() => deserializeState(bogus as unknown as typeof minimal, {})).not.toThrow();
      const state = deserializeState(bogus as unknown as typeof minimal, {});
      // The "at least one page always exists" invariant still holds …
      expect(Object.keys(state.doc.pages).length).toBeGreaterThan(0);
      expect(Object.hasOwn(state.doc.pages, state.doc.dashboard.activePageId)).toBe(true);
      // … and every other container is its empty default.
      expect(state.doc.widgets).toEqual({});
      expect(state.doc.filters).toEqual([]);
      expect(state.doc.relationships).toEqual([]);
      expect(state.doc.ai).toBeUndefined();
    },
  );
});

// ─── L3 / H2 at the load boundary ────────────────────────────────────────────
describe('deserializeState dashboard.id fallback and dependsOn prune', () => {
  const minimal = serializeState(createDefaultStudioState());

  it('coerces a missing/non-string dashboard.id to the factory default (L3)', () => {
    const noId = {
      ...minimal,
      dashboard: { title: 'T', activePageId: Object.keys(minimal.pages)[0] },
    } as unknown as typeof minimal;
    expect(deserializeState(noId, {}).doc.dashboard.id).toBe('dashboard-1');
    const junkId = {
      ...minimal,
      dashboard: { ...minimal.dashboard, id: 42 },
    } as unknown as typeof minimal;
    expect(deserializeState(junkId, {}).doc.dashboard.id).toBe('dashboard-1');
  });

  it('leaves a well-formed dashboard reference-stable (no churn)', () => {
    const state = deserializeState(minimal, {});
    expect(state.doc.dashboard).toBe(minimal.dashboard);
  });

  it('prunes a dependsOn pointing at a filter the load-boundary screen dropped (H2)', () => {
    const pageId = Object.keys(minimal.pages)[0];
    const serialized = {
      ...minimal,
      filters: [
        // Dropped: its `operator` is not a member of the closed union.
        { id: 'f-bad', field: 'country', operator: 'equal', value: 'FR', scope: { kind: 'page' } },
        {
          id: 'f-city',
          field: 'city',
          operator: 'equals',
          value: 'Paris',
          dependsOn: ['f-bad'],
          scope: { kind: 'page', pageId },
        },
      ],
    } as unknown as typeof minimal;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['f-city']);
    expect(state.doc.filters[0].dependsOn).toBeUndefined();
  });

  it('leaves a satisfiable dependsOn intact, keeping each entry object identity', () => {
    const pageId = Object.keys(minimal.pages)[0];
    const filters = [
      {
        id: 'f-country',
        field: 'country',
        operator: 'equals',
        value: 'FR',
        scope: { kind: 'page', pageId },
      },
      {
        id: 'f-city',
        field: 'city',
        operator: 'equals',
        value: 'Paris',
        dependsOn: ['f-country'],
        scope: { kind: 'page', pageId },
      },
    ];
    const serialized = { ...minimal, filters } as unknown as typeof minimal;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['f-country', 'f-city']);
    // Nothing was pruned, so `pruneDependsOn` returned each entry unchanged by identity.
    expect(state.doc.filters[1]).toBe(filters[1]);
    expect(state.doc.filters[1].dependsOn).toEqual(['f-country']);
  });
});

// ─── H1 at the load boundary: the rank dedup must stop dropping good filters ─
// `deserializeState` runs `hasConflictingRankFilter` in ARRAY ORDER, so when an
// unplaced-widget rank filter came FIRST its `null`-resolved page context "conflicted"
// with the user's legitimate rank filter and DROPPED it — and the next `serializeDoc`
// persisted the loss permanently.
describe('deserializeState rank-filter dedup with an unplaced widget (H1)', () => {
  const base = serializeState(
    createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        widgets: {
          'w-unplaced': {
            id: 'w-unplaced',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar' },
          },
        },
      },
    }),
  );

  it('keeps a legitimate page rank filter listed AFTER an unplaced-widget rank filter', () => {
    const serialized = {
      ...base,
      filters: [
        {
          id: 'r-unplaced',
          field: 'country',
          operator: 'equals',
          value: null,
          filterMode: 'rank',
          scope: { kind: 'widget', widgetId: 'w-unplaced' },
        },
        {
          id: 'r-page-1',
          field: 'country',
          operator: 'equals',
          value: null,
          filterMode: 'rank',
          scope: { kind: 'page', pageId: 'page-1' },
        },
      ],
    } as unknown as typeof base;
    const state = deserializeState(serialized, {});
    expect(state.doc.filters.map((f) => f.id)).toEqual(['r-unplaced', 'r-page-1']);
  });

  it('still drops a genuine second rank filter on the same page', () => {
    const rank = (id: string) => ({
      id,
      field: 'country',
      operator: 'equals',
      value: null,
      filterMode: 'rank',
      scope: { kind: 'page', pageId: 'page-1' },
    });
    const serialized = { ...base, filters: [rank('r1'), rank('r2')] } as unknown as typeof base;
    expect(deserializeState(serialized, {}).doc.filters.map((f) => f.id)).toEqual(['r1']);
  });
});

// ─── the at-least-one-page invariant at the load boundary ────────────────────
// `removePage` refuses to delete the final page because every legacy pageId-less mutation
// resolves its target through `Object.hasOwn(state.pages, dashboard.activePageId)`, which
// nothing satisfies once the map is empty. The loader used to mint exactly that state, and
// unlike the reducer — which must stay deterministic and therefore declines to synthesize a
// fresh page id — it is free to repair it.
describe('deserializeState at-least-one-page invariant', () => {
  const zeroPageDoc = (pages: unknown) =>
    ({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      dashboard: { id: 'd', title: 'T', activePageId: 'p1' },
      pages,
      widgets: {},
      filters: [],
    }) as unknown as ReturnType<typeof serializeState>;

  it('synthesizes the factory default page for a doc whose page map is empty', () => {
    const state = deserializeState(zeroPageDoc({}), {});
    expect(state.doc.pages).toEqual({
      'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
    });
    expect(state.doc.dashboard.activePageId).toBe('page-1');
  });

  it("synthesizes a page when the persisted sweep drops the doc's only page", () => {
    // Reachable without hand-editing the page map to `{}`: `normalizePersistedPages`
    // legitimately drops a page whose value is not a record.
    const state = deserializeState(zeroPageDoc({ p1: null }), {});
    expect(Object.keys(state.doc.pages)).toEqual(['page-1']);
    expect(state.doc.dashboard.activePageId).toBe('page-1');
  });

  it('a zero-page doc loads into a state whose pageId-less mutations still apply', () => {
    // The consequence the invariant protects against: with `activePageId: ''` every legacy
    // pageId-less mutation silently no-op'd forever, with no error and no way to recover.
    const state = deserializeState(zeroPageDoc({}), {});
    const widget = {
      id: 'w1',
      kind: 'chart',
      title: 'C',
      config: { chartType: 'bar' },
    } as StudioWidget;

    const next = applyDocMutation(state.doc, { type: 'addWidget', args: { widget } });

    expect(next).not.toBe(state.doc);
    expect(next.widgets.w1).toBeDefined();
    expect(next.pages['page-1'].widgetRows.flat()).toContain('w1');
  });

  it('leaves a doc that already has a page untouched', () => {
    const serialized = serializeState(createDefaultStudioState());
    const state = deserializeState(serialized, {});
    expect(Object.keys(state.doc.pages)).toEqual(['page-1']);
    expect(state.doc.pages).toEqual(serialized.pages);
  });
});

// ─── expression-field interiors at the load boundary ─────────────────────────
// `expressionFields[i].expression` is the only RECURSIVE shape crossing this boundary. It
// used to be screened for record-ness alone, so an unknown operator (which every
// `expressionEvaluator` walker falls through to its `default:` case for, silently evaluating
// the whole computed column to `null`), a non-array `inputs`, and unbounded nesting (which
// overflows the stack in the un-bounded `collectExpressionRefs`/`collectJoinSourceIds`
// walkers) all loaded with `success: true` and were re-persisted by `serializeDoc` forever.
describe('deserializeState expression-field interior screen', () => {
  const minimal = serializeState(createDefaultStudioState());
  const goodEf = {
    id: 'ef1',
    label: 'Margin',
    sourceId: 's1',
    isMeasure: false,
    expression: { operator: 'subtract', inputs: [{ id: 'revenue' }, { id: 'cost' }] },
  };
  const load = (expressionFields: unknown[]) =>
    deserializeState({ ...minimal, expressionFields } as unknown as typeof minimal, {});

  it('keeps a well-formed entry and every valid expression-node member', () => {
    const entries = [
      goodEf,
      { ...goodEf, id: 'value', expression: { type: 'number', value: 1 } },
      { ...goodEf, id: 'field', expression: { id: 'revenue', aggregation: 'sum' } },
      { ...goodEf, id: 'join', expression: { joinSourceId: 'customers', fieldId: 'country' } },
      // `isMeasure` is documented as defaulting to `false`, so an absent one stays legal.
      { id: 'no-measure', label: 'L', sourceId: 's1', expression: { id: 'revenue' } },
    ];
    expect(load(entries).doc.expressionFields.map((ef) => ef.id)).toEqual([
      'ef1',
      'value',
      'field',
      'join',
      'no-measure',
    ]);
  });

  it('drops a function node with no inputs, a non-array inputs, or a junk input entry', () => {
    const entries = [
      goodEf,
      { ...goodEf, id: 'e1', expression: { operator: 'add' } },
      { ...goodEf, id: 'e2', expression: { operator: 'add', inputs: 'nope' } },
      { ...goodEf, id: 'e3', expression: { operator: 'add', inputs: [{ id: 'a' }, null] } },
    ];
    expect(load(entries).doc.expressionFields.map((ef) => ef.id)).toEqual(['ef1']);
  });

  it('drops an unknown operator the way the sibling relationship type check does', () => {
    const entries = [
      goodEf,
      { ...goodEf, id: 'bogus-op', expression: { operator: 'NOT_A_REAL_OP', inputs: [] } },
      // Nested one level down — the screen recurses rather than checking only the root.
      {
        ...goodEf,
        id: 'bogus-nested',
        expression: { operator: 'add', inputs: [{ id: 'a' }, { operator: 'nope', inputs: [] }] },
      },
    ];
    const state = load(entries);
    expect(state.doc.expressionFields.map((ef) => ef.id)).toEqual(['ef1']);
    // Self-heals: the junk is not re-persisted.
    expect(serializeState(state).expressionFields).toEqual([goodEf]);
  });

  it.each([
    ['add', true],
    ['datediff', true],
    ['isNotNull', true],
    ['negate', true],
    ['pow', false],
    ['equal', false],
  ])('operator "%s" is a known member: %s', (operator, kept) => {
    const entry = { ...goodEf, id: 'op', expression: { operator, inputs: [] } };
    expect(load([entry]).doc.expressionFields).toHaveLength(kept ? 1 : 0);
  });

  it('drops an entry whose label is missing or not a string', () => {
    const { label: ignoredLabel, ...noLabel } = goodEf;
    const entries = [goodEf, { ...noLabel, id: 'e1' }, { ...goodEf, id: 'e2', label: 42 }];
    expect(load(entries).doc.expressionFields.map((ef) => ef.id)).toEqual(['ef1']);
  });

  it('drops an entry whose present isMeasure is not a boolean', () => {
    // A truthy junk value silently loads a calculated column as a whole-dataset measure.
    const entries = [goodEf, { ...goodEf, id: 'e1', isMeasure: 'no' }];
    expect(load(entries).doc.expressionFields.map((ef) => ef.id)).toEqual(['ef1']);
  });

  it('drops a value node with an unknown type and a partial join node', () => {
    const entries = [
      goodEf,
      { ...goodEf, id: 'e1', expression: { type: 'date', value: '2026-01-01' } },
      // Neither a join node (no `fieldId`) nor any other member: unresolvable.
      { ...goodEf, id: 'e2', expression: { joinSourceId: 'customers' } },
      // Matches no member at all.
      { ...goodEf, id: 'e3', expression: {} },
    ];
    expect(load(entries).doc.expressionFields.map((ef) => ef.id)).toEqual(['ef1']);
  });

  it('drops an expression tree nested past the depth bound, keeping one just inside it', () => {
    const nest = (depth: number) => {
      let node: Record<string, unknown> = { id: 'leaf' };
      for (let i = 0; i < depth; i += 1) {
        node = { operator: 'add', inputs: [node] };
      }
      return node;
    };
    // The leaf of a `depth`-deep chain sits at nesting level `depth`; 32 is the bound.
    const entries = [
      { ...goodEf, id: 'deep-ok', expression: nest(32) },
      { ...goodEf, id: 'too-deep', expression: nest(33) },
    ];
    expect(load(entries).doc.expressionFields.map((ef) => ef.id)).toEqual(['deep-ok']);
  });
});

// R3-F4: `serializeDoc` strips cross-filter/interactive entries but used to leave the
// survivors' `dependsOn` pointing at them. `deserializeState`'s own `pruneDependsOn` then
// removed the now-dangling reference, so a user-authored cascade was silently SHORTENED by
// a reload. ARCHITECTURE.md's "every path that drops a filter prunes `dependsOn` against
// the survivors" enumerated the drop paths and omitted this one, which is also a drop path.
describe('serializeDoc prunes dependsOn against the filters it keeps (R3-F4)', () => {
  const docWithCascade = () =>
    createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [['w1']] } },
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        } as unknown as StudioDoc['widgets'],
        filters: [
          {
            id: 'x1',
            field: 'a',
            operator: 'equals',
            value: 1,
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'p1' },
          },
          {
            id: 'f2',
            field: 'b',
            operator: 'equals',
            value: 2,
            scope: { kind: 'page', pageId: 'p1' },
          },
          {
            id: 'f1',
            field: 'c',
            operator: 'equals',
            value: 3,
            scope: { kind: 'page', pageId: 'p1' },
            dependsOn: ['x1', 'f2'],
          },
        ],
      },
    }).doc;

  it('drops a dependsOn reference to a stripped cross-filter entry', () => {
    const doc = docWithCascade();
    // Live state legitimately carries the cross-filter reference.
    expect(doc.filters.find((f) => f.id === 'f1')?.dependsOn).toEqual(['x1', 'f2']);
    const serialized = serializeDoc(doc);
    // The serialized doc is self-consistent: no `dependsOn` names a filter it does not carry.
    expect(serialized.filters.find((f) => f.id === 'f1')?.dependsOn).toEqual(['f2']);
  });

  it('what a reload restores now equals what was written', () => {
    const serialized = JSON.parse(JSON.stringify(serializeDoc(docWithCascade())));
    const loaded = deserializeState(serialized, {});
    expect(loaded.doc.filters.find((f) => f.id === 'f1')?.dependsOn).toEqual(
      serialized.filters.find((f: { id: string }) => f.id === 'f1').dependsOn,
    );
  });

  it('deletes the dependsOn KEY when the prune empties it, never writes dependsOn: []', () => {
    const doc = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [['w1']] } },
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        } as unknown as StudioDoc['widgets'],
        filters: [
          {
            id: 'x1',
            field: 'a',
            operator: 'equals',
            value: 1,
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'p1' },
          },
          {
            id: 'f1',
            field: 'c',
            operator: 'equals',
            value: 3,
            scope: { kind: 'page', pageId: 'p1' },
            dependsOn: ['x1'],
          },
        ],
      },
    }).doc;
    const survivor = serializeDoc(doc).filters.find((f) => f.id === 'f1')!;
    expect('dependsOn' in survivor).toBe(false);
  });

  it('leaves a well-formed doc alone, keeping every filter entry reference-stable', () => {
    const doc = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [] } },
        filters: [
          {
            id: 'f2',
            field: 'b',
            operator: 'equals',
            value: 2,
            scope: { kind: 'page', pageId: 'p1' },
          },
          {
            id: 'f1',
            field: 'c',
            operator: 'equals',
            value: 3,
            scope: { kind: 'page', pageId: 'p1' },
            dependsOn: ['f2'],
          },
        ],
      },
    }).doc;
    const serialized = serializeDoc(doc);
    expect(serialized.filters[1]).toBe(doc.filters[1]);
    expect(serialized.filters[1].dependsOn).toEqual(['f2']);
  });
});

// R3-F6: every other step of `migrateState` is fail-closed (a registry gap, a throwing
// migration and a missing required field all return `success: false`), but the registry's own
// contract clause — "the function must return a new object with `schemaVersion` set to N+1" —
// had no post-condition check. A migration that forgot the stamp returned
// `{ success: true, toVersion: N+1 }` carrying `schemaVersion: N`, and any caller persisting
// `migrateState(...).state` directly (both reference hosts do) re-ran that migration on every
// subsequent load, forever.
describe('migrateState enforces that a migration stamped schemaVersion (R3-F6)', () => {
  const v0Doc = () => ({
    schemaVersion: 0,
    dashboard: { id: 'd', title: 'T', activePageId: 'p1' },
    pages: { p1: { id: 'p1', title: 'P', widgetRows: [] } },
    widgets: {},
    filters: [],
  });

  // Swap the registered 0→1 entry for a forgetful one, run, and always restore.
  function withForgetfulMigration<T>(run: () => T): T {
    const original = MIGRATION_REGISTRY_FOR_TESTS[0];
    MIGRATION_REGISTRY_FOR_TESTS[0] = (state) => ({ ...state });
    try {
      return run();
    } finally {
      MIGRATION_REGISTRY_FOR_TESTS[0] = original;
    }
  }

  it('fails closed when a migration returns state still stamped with the OLD version', () => {
    const result = withForgetfulMigration(() => migrateState(v0Doc()));
    expect(result.success).toBe(false);
    expect(result.state).toBeNull();
    expect(result.errors).toHaveLength(1);
    // The message names the clause that was violated and the version actually found, so the
    // author of the offending migration can act on it.
    expect(result.errors[0]).toContain('schemaVersion');
    expect(result.errors[0]).toContain(String(CURRENT_SCHEMA_VERSION));
  });

  it('fails closed on a migration that stamps a WRONG version, not just a missing one', () => {
    const original = MIGRATION_REGISTRY_FOR_TESTS[0];
    MIGRATION_REGISTRY_FOR_TESTS[0] = (state) => ({ ...state, schemaVersion: 99 });
    try {
      const result = migrateState(v0Doc());
      expect(result.success).toBe(false);
      expect(result.state).toBeNull();
    } finally {
      MIGRATION_REGISTRY_FOR_TESTS[0] = original;
    }
  });

  it('the real registered migration still passes the post-condition', () => {
    const result = migrateState(v0Doc());
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.state?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

// R3-F7: `validateStateStructure`'s `state is Record<string, unknown>` predicate was
// hand-rolled as `!state || typeof state !== 'object'`, which is true for an ARRAY and for
// an exotic object — so the predicate narrowed values that are not plain records. Harmless
// today (`findMissingRequiredField` rejects them on the next line) but unsound, and it was
// the one boundary in the package not reading the shared `isPlainRecord`.
describe('migrateState rejects non-record state through the shared record guard (R3-F7)', () => {
  it.each([
    ['an array', [] as unknown],
    ['a populated array', [{ dashboard: {} }] as unknown],
    ['a Date', new Date() as unknown],
    ['a Map', new Map() as unknown],
    ['null', null as unknown],
    ['a string', 'junk' as unknown],
    ['a number', 42 as unknown],
  ])('rejects %s', (_label, value) => {
    const result = migrateState(value as Parameters<typeof migrateState>[0]);
    expect(result.success).toBe(false);
    expect(result.state).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts an Object.create(null) bag, which IS a legitimate plain record', () => {
    const bag = Object.assign(Object.create(null), completeSerialized({ schemaVersion: 1 }));
    expect(migrateState(bag).success).toBe(true);
  });
});

// R4-F3: `MigrationResult.errors` and the equivalent THROWN message had drifted. The
// newer-version condition produced two different texts for one failure — the thrown one
// (registered as error code 451) carries the `MUI X Studio:` prefix, the consequence and the
// fix ("Upgrade @mui/x-studio…"), while the returned one carried neither. `migrateState` is
// the path the reference hosts actually call, so the thinner message is the one users see.
describe('migrateState error strings stay consistent with the thrown ones (R4-F3)', () => {
  const v0Doc = () => ({
    schemaVersion: 0,
    dashboard: { id: 'd', title: 'T', activePageId: 'p1' },
    pages: { p1: { id: 'p1', title: 'P', widgetRows: [] } },
    widgets: {},
    filters: [],
  });

  function withRegistryEntry<T>(entry: unknown, run: () => T): T {
    const original = MIGRATION_REGISTRY_FOR_TESTS[0];
    MIGRATION_REGISTRY_FOR_TESTS[0] = entry as (typeof MIGRATION_REGISTRY_FOR_TESTS)[0];
    try {
      return run();
    } finally {
      MIGRATION_REGISTRY_FOR_TESTS[0] = original;
    }
  }

  // Every reachable `success: false` return of `migrateState`, one per failure condition.
  function everyFailure(): Array<{ label: string; errors: string[] }> {
    return [
      { label: 'invalid structure', errors: migrateState('junk').errors },
      {
        label: 'non-integer schemaVersion',
        errors: migrateState({ schemaVersion: 0.5 }).errors,
      },
      {
        label: 'newer version',
        errors: migrateState({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }).errors,
      },
      {
        label: 'un-cloneable state',
        errors: migrateState({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          dashboard: { id: 'd', title: 'T', activePageId: 'p' },
          pages: {},
          widgets: {},
          filters: [],
          stray: () => undefined,
        }).errors,
      },
      {
        label: 'missing required field at current version',
        errors: migrateState({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          dashboard: { id: 'd', title: 'T', activePageId: 'p' },
          pages: {},
          widgets: {},
        }).errors,
      },
      {
        label: 'registry gap',
        errors: withRegistryEntry(undefined, () => migrateState(v0Doc()).errors),
      },
      {
        label: 'throwing migration',
        errors: withRegistryEntry(
          () => {
            throw new Error('boom');
          },
          () => migrateState(v0Doc()).errors,
        ),
      },
      {
        label: 'missing required field after migration',
        errors: migrateState({ schemaVersion: 0 }).errors,
      },
      {
        label: 'migration forgot the schemaVersion stamp',
        errors: withRegistryEntry(
          (state: Record<string, unknown>) => ({ ...state }),
          () => migrateState(v0Doc()).errors,
        ),
      },
    ];
  }

  it('reaches every failure condition (guards the cases below against silently passing)', () => {
    for (const { label, errors } of everyFailure()) {
      expect(errors.length, label).toBeGreaterThan(0);
    }
  });

  it('prefixes every returned error with `MUI X Studio:`', () => {
    for (const { label, errors } of everyFailure()) {
      for (const message of errors) {
        expect(message, `${label}: ${message}`).toMatch(/^MUI X Studio: /);
      }
    }
  });

  it('returns the SAME newer-version text `deserializeState` throws', () => {
    const returned = migrateState({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }).errors[0];
    let thrown = '';
    try {
      deserializeState({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 } as never, {} as never);
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).not.toBe('');
    expect(returned).toBe(thrown);
  });

  it('keeps the actionable how-to-fix clause on the returned newer-version error', () => {
    const [message] = migrateState({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }).errors;
    expect(message).toContain('newer version of X Studio');
    expect(message).toContain('Upgrade @mui/x-studio');
  });
});
