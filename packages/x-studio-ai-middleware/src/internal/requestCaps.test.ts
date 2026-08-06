import { describe, expect, it } from 'vitest';
import { capIncomingDashboardState } from './requestCaps';
import { installUnscreened, makeState } from './testFixtures';
import { createDefaultStudioState } from '../models/studioTypes';
import type { StudioState } from '../models/studioTypes';

/**
 * The request trust boundary, tested against the module that owns it.
 *
 * These moved here with `capIncomingDashboardState` itself. They had been living in
 * `executeToolOnState.test.ts` for the same accidental reason the function had been living in
 * `executeToolOnState.ts`: the boundary grew where its first cap happened to be written.
 */
describe('capIncomingDashboardState', () => {
  it('caps oversized dashboard/page/widget titles and filter values', () => {
    const long = 'x'.repeat(1000);
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: long, activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: long, widgetRows: [['w1']] } },
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: long,
            subtitle: long,
            sourceId: long,
            config: { chartType: 'bar', xField: long },
          },
        },
        filters: [
          {
            id: 'f1',
            field: long,
            filterSourceId: long,
            operator: 'equals',
            value: long,
            scope: { kind: 'page', pageId: 'p1' },
          },
        ],
      },
    });

    const capped = capIncomingDashboardState(state);

    expect(capped.doc.dashboard.title.length).toBe(200);
    expect(capped.doc.pages.p1.title.length).toBe(200);
    const w1 = capped.doc.widgets.w1;
    expect(w1.title.length).toBe(200);
    expect(w1.subtitle!.length).toBe(200);
    expect(w1.sourceId!.length).toBe(200);
    expect((w1.config as { xField: string }).xField.length).toBe(200);
    const f1 = capped.doc.filters[0];
    expect(f1.field.length).toBe(200);
    expect(f1.filterSourceId!.length).toBe(200);
    expect((f1.value as string).length).toBe(200);
    // The input is not mutated.
    expect(state.doc.dashboard.title.length).toBe(1000);
  });

  it('caps the number of pages/widgets/filters retained', () => {
    const widgets: Record<string, StudioState['doc']['widgets'][string]> = {};
    for (let i = 0; i < 1100; i += 1) {
      widgets[`w${i}`] = { id: `w${i}`, kind: 'kpi', title: `W${i}`, config: {} };
    }
    const pages: Record<string, StudioState['doc']['pages'][string]> = {};
    for (let i = 0; i < 250; i += 1) {
      pages[`p${i}`] = { id: `p${i}`, title: `P${i}`, widgetRows: [] };
    }
    const filters: StudioState['doc']['filters'] = [];
    for (let i = 0; i < 600; i += 1) {
      filters.push({
        id: `f${i}`,
        field: 'x',
        operator: 'equals',
        value: 1,
        scope: { kind: 'page', pageId: 'p0' },
      });
    }
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p0' },
        pages,
        widgets,
        filters,
      },
    });

    const capped = capIncomingDashboardState(state);
    expect(Object.keys(capped.doc.widgets).length).toBe(1000);
    expect(Object.keys(capped.doc.pages).length).toBe(200);
    expect(capped.doc.filters.length).toBe(500);
  });

  // Tier 1 resource-exhaustion finding: `runtime.dataSources` is interpolated into
  // `<dashboard_state>`'s "## Data Sources" section with no cap of its own —
  // `capIncomingDashboardState` must bound it the same way it already bounds
  // `doc.pages`/`doc.widgets`/`doc.filters`.
  it('caps an oversized runtime.dataSources map (entry count, field count, and free-text length)', () => {
    const long = 'x'.repeat(1000);
    const fields = [];
    for (let i = 0; i < 600; i += 1) {
      fields.push({
        id: `f${i}`,
        label: long,
        type: 'number' as const,
        format: long as never,
        aiDescription: long,
      });
    }
    const dataSources: Record<string, StudioState['runtime']['dataSources'][string]> = {};
    for (let i = 0; i < 600; i += 1) {
      dataSources[`src${i}`] = {
        id: `src${i}`,
        label: long,
        aiDescription: long,
        fields: i === 0 ? fields : [],
      };
    }
    const state = createDefaultStudioState({ runtime: { dataSources } });

    const capped = capIncomingDashboardState(state);

    // Entry count capped.
    expect(Object.keys(capped.runtime.dataSources).length).toBe(500);
    const src0 = capped.runtime.dataSources.src0;
    // Free-text strings capped.
    expect(src0.label.length).toBe(200);
    expect(src0.aiDescription!.length).toBe(200);
    // A short, well-formed id is left byte-for-byte unchanged (only an
    // OVERSIZED id is truncated — see the dedicated `.id` length-cap tests below).
    expect(src0.id).toBe('src0');
    // Field count per source capped.
    expect(src0.fields.length).toBe(500);
    expect(src0.fields[0].label.length).toBe(200);
    expect((src0.fields[0].format as unknown as string).length).toBe(200);
    expect(src0.fields[0].aiDescription!.length).toBe(200);
    // The input is not mutated.
    expect(state.runtime.dataSources.src0.label.length).toBe(1000);
    expect(state.runtime.dataSources.src0.fields.length).toBe(600);
  });
});

// ── Tier 1 architecture-review finding: `capIncomingDashboardState` never capped a
// widget's/page's/data-source's own `.id` field (a field SEPARATE from its map key),
// nor `page.widgetRows`/`page.widgetColSpans` — both are echoed verbatim into
// `<dashboard_state>` by `buildAISystemPrompt.ts` with no length/count bound of its own.
describe('capIncomingDashboardState: entity id and layout caps', () => {
  it('caps an oversized widget.id, page.id, and runtime data-source.id', () => {
    const long = 'x'.repeat(1000);
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'Page', widgetRows: [['w1']] } },
        widgets: {
          w1: { id: 'w1', kind: 'kpi', title: 'W', config: {} },
        },
      },
      runtime: {
        dataSources: {
          src1: { id: 'src1', label: 'Sales', fields: [] },
        },
      },
    });
    // Oversized ids installed post-factory: `screenDoc` reconciles an entity id back to its
    // map key, so writing them through the factory would hand the cap a 2-char id.
    installUnscreened(state.doc.pages, 'p1', { ...state.doc.pages.p1, id: long });
    installUnscreened(state.doc.widgets, 'w1', { ...state.doc.widgets.w1, id: long });
    installUnscreened(state.runtime.dataSources, 'src1', {
      ...state.runtime.dataSources.src1,
      id: long,
    });

    const capped = capIncomingDashboardState(state);

    expect(capped.doc.pages.p1.id.length).toBe(200);
    expect(capped.doc.widgets.w1.id.length).toBe(200);
    expect(capped.runtime.dataSources.src1.id.length).toBe(200);
    // The input is not mutated.
    expect(state.doc.pages.p1.id.length).toBe(1000);
  });

  it('leaves short, well-formed ids byte-for-byte unchanged', () => {
    const state = makeState();
    const capped = capIncomingDashboardState(state);
    expect(capped.doc.pages['page-1'].id).toBe('page-1');
    expect(capped.doc.widgets['widget-1'].id).toBe('widget-1');
    expect(capped.runtime.dataSources.src1.id).toBe('src1');
  });

  it('caps the number of rows and cells-per-row in an oversized page.widgetRows layout matrix', () => {
    const hugeRows = Array.from({ length: 500 }, (_, i) => [`row${i}-cell`]);
    const hugeRow = Array.from({ length: 500 }, (_, i) => `cell${i}`);
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: {
          p1: { id: 'p1', title: 'Page', widgetRows: [...hugeRows, hugeRow] },
        },
      },
    });

    const capped = capIncomingDashboardState(state);

    const cappedRows = capped.doc.pages.p1.widgetRows;
    // Row count capped to MAX_LAYOUT_ROWS (200).
    expect(cappedRows.length).toBe(200);
    // The input is not mutated.
    expect(state.doc.pages.p1.widgetRows.length).toBe(501);
  });

  it('caps the number of cells retained in a single pathological widgetRows row', () => {
    const hugeRow = Array.from({ length: 500 }, (_, i) => `cell${i}`);
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'Page', widgetRows: [hugeRow] } },
      },
    });

    const capped = capIncomingDashboardState(state);

    expect(capped.doc.pages.p1.widgetRows[0].length).toBe(50);
  });

  it('caps oversized widget-id cell strings inside widgetRows', () => {
    const long = 'w'.repeat(1000);
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'Page', widgetRows: [[long]] } },
      },
    });

    const capped = capIncomingDashboardState(state);

    expect(capped.doc.pages.p1.widgetRows[0][0].length).toBe(200);
  });

  it('caps the number of entries retained in an oversized page.widgetColSpans map', () => {
    const widgetColSpans: Record<string, number> = {};
    for (let i = 0; i < 1100; i += 1) {
      widgetColSpans[`w${i}`] = 12;
    }
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'Page', widgetRows: [], widgetColSpans } },
      },
    });

    const capped = capIncomingDashboardState(state);

    expect(Object.keys(capped.doc.pages.p1.widgetColSpans!).length).toBe(1000);
    // The input is not mutated.
    expect(Object.keys(state.doc.pages.p1.widgetColSpans!).length).toBe(1100);
  });
});

// ── Tier 1 architecture-review finding: `customWidgets[].defaultConfig` must go
// through the SAME key-allowlist/value-shape validation as `args.config` ──────
describe('capIncomingDashboardState: data-source field caps (findings H1c/H1d)', () => {
  const long = 'x'.repeat(5_000);

  it('caps a field `id`, `capabilities`, and `defaultAggregationFn`', () => {
    const state = createDefaultStudioState({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            fields: [
              {
                id: long,
                label: 'Revenue',
                type: 'number' as const,
                capabilities: Array.from({ length: 100 }, () => long) as never,
                defaultAggregationFn: long as never,
              },
            ],
          },
        },
      },
    });

    const field = capIncomingDashboardState(state).runtime.dataSources.src1.fields[0];
    // Every one of these is echoed into EVERY field rendering, on every request —
    // `serializeFieldForAI` interpolates `f.id`, `capabilities.join('+')`, and
    // `default:<defaultAggregationFn>`; only `label`/`format`/`aiDescription` were
    // capped before.
    expect(field.id.length).toBe(200);
    expect(field.capabilities!.length).toBe(20);
    expect((field.capabilities![0] as string).length).toBe(200);
    expect((field.defaultAggregationFn as unknown as string).length).toBe(200);
  });

  it('caps `fieldDistinctValues` values, which `capDataSource` never touched', () => {
    const state = createDefaultStudioState({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            fields: [{ id: 'status', label: 'Status', type: 'string' as const }],
            // ≤ 8 values render IN FULL in the system prompt, so one huge value
            // passed straight through unbounded.
            fieldDistinctValues: { status: ['ok', long] },
          },
        },
      },
    });

    const capped = capIncomingDashboardState(state).runtime.dataSources.src1;
    expect(capped.fieldDistinctValues!.status[1].length).toBe(200);
    // The input is not mutated.
    expect(state.runtime.dataSources.src1.fieldDistinctValues!.status[1].length).toBe(5_000);
  });

  it('preserves the >30-value rendering semantics while bounding the retained array', () => {
    const many = Array.from({ length: 5_000 }, (_, i) => `v${i}`);
    const state = createDefaultStudioState({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            fields: [{ id: 'status', label: 'Status', type: 'string' as const }],
            fieldDistinctValues: { status: many },
          },
        },
      },
    });

    const capped = capIncomingDashboardState(state).runtime.dataSources.src1;
    // Bounded, but still ABOVE the 30-value "omit as high-cardinality" threshold, so
    // the field renders exactly as it did before the cap (rather than being rewritten
    // into a plausible-but-false "20 values" cardinality hint).
    expect(capped.fieldDistinctValues!.status.length).toBe(50);
  });

  it('drops a malformed (non-array) distinct-values entry rather than inventing `0` values', () => {
    const state = createDefaultStudioState({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            fields: [{ id: 'status', label: 'Status', type: 'string' as const }],
            fieldDistinctValues: { status: 'nope' as unknown as string[] },
          },
        },
      },
    });
    const capped = capIncomingDashboardState(state).runtime.dataSources.src1;
    expect(capped.fieldDistinctValues!.status).toBeUndefined();
  });
});

// `tableName` is the only field on an incoming data source that is forwarded to the
// host's `queryDataSource` rather than merely rendered into the prompt. It used to
// ride through `capDataSource`'s `...source` spread untouched, so a client body could
// hand the host a value that is not a table name at all.
describe('capIncomingDashboardState: data-source `tableName` normalization', () => {
  function sourceWithTableName(tableName: unknown) {
    return createDefaultStudioState({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            tableName: tableName as string,
            fields: [{ id: 'status', label: 'Status', type: 'string' as const }],
          },
        },
      },
    });
  }

  it('drops an object `tableName` instead of forwarding it to the host', () => {
    // A Knex host doing `db(params.tableName)` reads an object as an ALIAS MAP and
    // queries whichever table the caller named, so this must never survive.
    const capped = capIncomingDashboardState(sourceWithTableName({ orders: 'secrets' })).runtime
      .dataSources.src1;
    expect(capped.tableName).toBeUndefined();
  });

  it.each([
    ['array', ['orders']],
    ['number', 42],
    ['empty string', ''],
  ])('drops a %s `tableName`', (_label, value) => {
    const capped = capIncomingDashboardState(sourceWithTableName(value)).runtime.dataSources.src1;
    expect(capped.tableName).toBeUndefined();
  });

  it('drops — never truncates — an over-long `tableName`', () => {
    // Truncating would name a DIFFERENT table than the one configured; dropping makes
    // the source unqueryable, which every resolver already reports cleanly.
    const capped = capIncomingDashboardState(sourceWithTableName('t'.repeat(5_000))).runtime
      .dataSources.src1;
    expect(capped.tableName).toBeUndefined();
  });

  it('passes an ordinary string `tableName` through untouched', () => {
    const capped = capIncomingDashboardState(sourceWithTableName('orders')).runtime.dataSources
      .src1;
    expect(capped.tableName).toBe('orders');
  });
});

// ── Finding L1: `__proto__`-keyed entries were silently dropped ───────────────
describe('capIncomingDashboardState: prototype-named map keys (finding L1)', () => {
  /**
   * Build a map with an OWN, enumerable `__proto__` key — what `JSON.parse` yields
   * for a request body containing one. An object LITERAL cannot express this:
   * `{ __proto__: v }` sets the prototype instead of creating a property.
   */

  it('retains a widget/page/data-source keyed `__proto__` instead of dropping it', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: '__proto__' },
        pages: {},
        widgets: {},
      },
      runtime: { dataSources: {} },
    });
    installUnscreened(state.doc.pages, '__proto__', {
      id: '__proto__',
      title: 'Page',
      widgetRows: [['__proto__']],
    });
    installUnscreened(state.doc.widgets, '__proto__', {
      id: '__proto__',
      kind: 'kpi',
      title: 'W',
      config: {},
    });
    installUnscreened(state.runtime.dataSources, '__proto__', {
      id: '__proto__',
      label: 'Sales',
      fields: [],
    });

    const capped = capIncomingDashboardState(state);

    // With a plain `{}` accumulator these assignments were swallowed by the
    // prototype setter, so the entities silently vanished from the prompt.
    expect(Object.hasOwn(capped.doc.widgets, '__proto__')).toBe(true);
    expect(Object.hasOwn(capped.doc.pages, '__proto__')).toBe(true);
    expect(Object.hasOwn(capped.runtime.dataSources, '__proto__')).toBe(true);
    // …and nothing leaked onto the real prototype.
    expect(({} as Record<string, unknown>).title).toBeUndefined();
  });

  it('caps an oversized map KEY, not just the entity `.id` field', () => {
    const long = 'x'.repeat(5_000);
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'Page', widgetRows: [] } },
        widgets: { [long]: { id: 'w1', kind: 'kpi', title: 'W', config: {} } },
      },
    });

    const capped = capIncomingDashboardState(state);
    expect(Object.keys(capped.doc.widgets)[0].length).toBe(200);
  });
});

// ── Finding M3: malformed sub-entity shapes must not throw raw TypeErrors ─────
describe('capIncomingDashboardState: malformed sub-entities (finding M3)', () => {
  it('does not throw on null widget/page/filter entries or a malformed widgetRows', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: {
          p1: { id: 'p1', title: 'P', widgetRows: 'abc' as unknown as string[][] },
          p2: null as never,
        },
        widgets: { w1: null as never },
        filters: [null as never],
      },
      runtime: {
        dataSources: {
          src1: { id: 'src1', label: 'S', fields: [null as never] },
        },
      },
    });

    expect(() => capIncomingDashboardState(state)).not.toThrow();
  });

  it('defaults a missing widget `config` to an empty object', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P', widgetRows: [['w1']] } },
        widgets: { w1: { id: 'w1', kind: 'chart', title: 'W' } as never },
      },
    });
    expect(capIncomingDashboardState(state).doc.widgets.w1.config).toEqual({});
  });
});

// ── Finding H4: `String()`/`Number()` on a model-supplied object threw a raw TypeError ─
//
// `String(x)` is not total: for a JSON object whose `toString` is a NON-callable own
// property — `{"toString": 1}`, which `JSON.parse` accepts verbatim, so it survives both
// a raw tool-call `arguments` buffer and the request body — `ToPrimitive` skips the
// uncallable `toString`, falls back to `Object.prototype.valueOf` (which returns the
// object) and throws `TypeError: Cannot convert object to primitive value`. `Number()`
// has the mirror form `{"valueOf": 1, "toString": 2}`.
//
// The "`executeToolOnState` is pure and never throws by design" invariant is stated in
// comments (`toolPolicy.ts`, `agenticLoop/toolDispatch.ts`) but was never asserted
// anywhere. These assert it.
describe('capIncomingDashboardState: non-primitive-coercible strings (finding H4)', () => {
  const UNSTRINGABLE = JSON.parse('{"toString": 1}') as unknown;

  it('does not throw on an unstringable title/id anywhere in the incoming doc', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: UNSTRINGABLE as string, activePageId: 'p1' },
        pages: {
          p1: { id: UNSTRINGABLE as string, title: UNSTRINGABLE as string, widgetRows: [] },
        },
        widgets: {
          w1: {
            id: UNSTRINGABLE,
            kind: 'kpi',
            title: UNSTRINGABLE,
            sourceId: UNSTRINGABLE,
            config: {},
          } as never,
        },
        filters: [{ id: 'f1', field: UNSTRINGABLE, operator: 'equals', value: 1 } as never],
      },
      runtime: {
        dataSources: {
          src1: {
            id: UNSTRINGABLE,
            label: UNSTRINGABLE,
            fields: [{ id: UNSTRINGABLE, label: UNSTRINGABLE, type: 'number' }],
          } as never,
        },
      },
    });

    expect(() => capIncomingDashboardState(state)).not.toThrow();
  });

  it('normalizes the unusable value to an empty string rather than "[object Object]"', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P', widgetRows: [] } },
        widgets: {},
      },
    });
    // Post-factory: `screenDoc` replaces a non-string title with the default, so writing
    // it through the factory would test the factory rather than the cap.
    installUnscreened(state.doc.dashboard, 'title', UNSTRINGABLE);
    // "[object Object]" would be a fabricated dashboard title interpolated into
    // `<dashboard_state>` on every subsequent request.
    expect(capIncomingDashboardState(state).doc.dashboard.title).toBe('');
  });
});

// ── Finding H6: the wrong-page guard skipped the omitted-`pageId` form ────────
describe('capIncomingDashboardState: remaining uncapped prompt strings (finding L1)', () => {
  const long = 'z'.repeat(5_000);

  const stateWith = (overrides: Partial<StudioState>): StudioState => ({
    ...createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P', widgetRows: [['w1']] } },
        widgets: { w1: { id: 'w1', kind: 'chart', title: 'W', config: {} } },
      },
    }),
    ...overrides,
  });

  it('caps `session.mode`', () => {
    const base = stateWith({});
    const state: StudioState = { ...base, session: { ...base.session, mode: long as never } };
    expect(capIncomingDashboardState(state).session.mode.length).toBe(200);
  });

  it('leaves a well-formed `session.mode` unchanged', () => {
    const base = stateWith({});
    expect(capIncomingDashboardState(base).session.mode).toBe(base.session.mode);
  });

  it('caps `widget.kind`', () => {
    const base = stateWith({});
    const state: StudioState = {
      ...base,
      doc: {
        ...base.doc,
        widgets: { w1: { ...base.doc.widgets.w1, kind: long as never } },
      },
    };
    expect(capIncomingDashboardState(state).doc.widgets.w1.kind.length).toBe(200);
  });

  it('caps `filter.id`, `filter.operator` and `filter.scope.widgetId`', () => {
    const base = stateWith({});
    const state: StudioState = {
      ...base,
      doc: {
        ...base.doc,
        filters: [
          {
            id: long,
            field: 'region',
            operator: long as never,
            value: 'EU',
            scope: { kind: 'widget', widgetId: long },
          },
        ],
      },
    };
    const [f] = capIncomingDashboardState(state).doc.filters;
    expect(f.id.length).toBe(200);
    expect(f.operator.length).toBe(200);
    expect((f.scope as { widgetId: string }).widgetId.length).toBe(200);
  });

  it('leaves a well-formed filter byte-for-byte unchanged', () => {
    const base = stateWith({});
    const state: StudioState = {
      ...base,
      doc: {
        ...base.doc,
        filters: [
          {
            id: 'f1',
            field: 'region',
            operator: 'equals',
            value: 'EU',
            scope: { kind: 'widget', widgetId: 'w1' },
          },
        ],
      },
    };
    expect(capIncomingDashboardState(state).doc.filters[0]).toEqual(state.doc.filters[0]);
  });

  it('does not invent a `kind` / `operator` for an entity that has none', () => {
    const base = stateWith({});
    const state: StudioState = {
      ...base,
      doc: {
        ...base.doc,
        widgets: { w1: { id: 'w1', title: 'W', config: {} } as never },
        filters: [{ field: 'region', value: 'EU', scope: { kind: 'page', pageId: 'p1' } } as never],
      },
    };
    const capped = capIncomingDashboardState(state);
    expect('kind' in capped.doc.widgets.w1).toBe(false);
    expect('operator' in capped.doc.filters[0]).toBe(false);
  });
});

// ── Finding F4 (round 3): private mode was not enforced on tool-result EGRESS ──
//
// Under `privateMode` the `<dashboard_state>` block is withheld from the system
// prompt and the four `privateModeExcluded` read tools are never advertised. But
// three WRITE tools that stay advertised interpolated withheld state straight into
// their rejection strings — and a tool result is not a one-shot value on the chat
// transport: it is appended to the conversation and re-sent to the provider on every
// remaining turn. The rejections are still actionable, they just have to state the
// CONSTRAINT rather than the current state, exactly as `set_widget_layout`'s
// unknown-id branch already does.
