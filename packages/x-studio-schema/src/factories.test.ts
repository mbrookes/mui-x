import { describe, expect, it } from 'vitest';
import {
  createDefaultWidget,
  createDefaultStudioState,
  createWidgetId,
  createMutationId,
  createPageId,
  createPresetId,
  createFilterId,
  createIdFactory,
  createMutationEnvelope,
  normalizeChartSeries,
} from './factories';
import { applyDocMutation } from './applyMutation';
import { deserializeState, serializeDoc } from './statePersistence';
import { CURRENT_SCHEMA_VERSION } from './stateTypes';
import type { StudioDoc } from './stateTypes';

// The per-kind default title/config below is transcribed directly from the current
// `BUILTIN_WIDGET_DEFAULTS` table in `factories.ts` (it is a file-private const, not
// exported, so these tests cannot import and assert against it programmatically).
// If that table changes, these pinning assertions must be updated to match.
describe('createDefaultWidget', () => {
  it('grid: title "" and config.columns: []', () => {
    const widget = createDefaultWidget('grid');
    expect(widget.title).toBe('');
    expect(widget.config).toEqual({ columns: [] });
  });

  it('chart: title "" and config.chartType: "bar"', () => {
    const widget = createDefaultWidget('chart');
    expect(widget.title).toBe('');
    expect(widget.config).toEqual({ chartType: 'bar' });
  });

  it('kpi: title "" and config.kpiAggregation: "sum"', () => {
    const widget = createDefaultWidget('kpi');
    expect(widget.title).toBe('');
    expect(widget.config).toEqual({ kpiAggregation: 'sum' });
  });

  it('text: title "Text block" and empty textSubtitle/textBody', () => {
    const widget = createDefaultWidget('text');
    expect(widget.title).toBe('Text block');
    expect(widget.config).toEqual({ textSubtitle: '', textBody: '' });
  });

  it('filter: title "Filter" and config.filterWidgetType: "multi-select"', () => {
    const widget = createDefaultWidget('filter');
    expect(widget.title).toBe('Filter');
    expect(widget.config).toEqual({ filterWidgetType: 'multi-select' });
  });

  it('pivot: title "" and config.pivotAggregation: "sum"', () => {
    const widget = createDefaultWidget('pivot');
    expect(widget.title).toBe('');
    expect(widget.config).toEqual({ pivotAggregation: 'sum' });
  });

  it('map: title "" and config.mapAggregation: "sum"', () => {
    const widget = createDefaultWidget('map');
    expect(widget.title).toBe('');
    expect(widget.config).toEqual({ mapAggregation: 'sum' });
  });

  it('an unrecognized (custom) kind defaults title to the kind string and customConfig to {}', () => {
    const widget = createDefaultWidget('acme-weather');
    expect(widget.kind).toBe('acme-weather');
    expect(widget.title).toBe('acme-weather');
    expect(widget.config).toEqual({ customConfig: {} });
  });

  it.each(['constructor', '__proto__', 'hasOwnProperty', 'toString'])(
    'treats prototype-chain name %j as an unknown custom kind, not a built-in (no corrupted widget)',
    (kind) => {
      // Regression: `kind in BUILTIN_WIDGET_DEFAULTS` returned true for these
      // (prototype-chain lookup), so an untrusted/LLM-supplied kind resolved to
      // `Object.prototype[kind]` and produced a widget with `title: undefined` /
      // `config: undefined` that crashes on the first `widget.config.*` access.
      const widget = createDefaultWidget(kind);
      expect(widget.kind).toBe(kind);
      // Handled via the unknown-custom-kind branch: title defaults to the kind and
      // config is a well-formed `{ customConfig: {} }`, never `undefined`.
      expect(widget.title).toBe(kind);
      expect(widget.config).toEqual({ customConfig: {} });
    },
  );

  it('a custom kind honors overrides.customConfig when provided', () => {
    const widget = createDefaultWidget('acme-weather', { customConfig: { units: 'metric' } });
    expect(widget.config).toEqual({ customConfig: { units: 'metric' } });
  });

  it('a built-in kind also honors overrides.customConfig, merging it into the default config (3.4)', () => {
    // Regression: the built-in branch dropped `overrides.customConfig` silently; it is
    // a valid key on the shared widget config for every kind, so it must be threaded in.
    const widget = createDefaultWidget('grid', { customConfig: { density: 'compact' } });
    expect(widget.config).toEqual({ columns: [], customConfig: { density: 'compact' } });
  });

  it('overrides.title is respected for both built-in and custom kinds', () => {
    expect(createDefaultWidget('grid', { title: 'My Grid' }).title).toBe('My Grid');
    expect(createDefaultWidget('acme-weather', { title: 'My Widget' }).title).toBe('My Widget');
  });

  it('two calls for the same kind produce configs whose mutable containers are not the same reference', () => {
    const widgetA = createDefaultWidget('grid');
    const widgetB = createDefaultWidget('grid');
    expect(widgetA.config.columns).toEqual(widgetB.config.columns);
    expect(widgetA.config.columns).not.toBe(widgetB.config.columns);
  });

  it('mints unique ids across a tight loop (would flake under the old Date.now()-only scheme)', () => {
    const ids = Array.from({ length: 1000 }, () => createDefaultWidget('chart').id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('createWidgetId', () => {
  it('is collision-resistant across a tight loop', () => {
    const ids = Array.from({ length: 1000 }, () => createWidgetId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces ids with the `widget-` prefix', () => {
    expect(createWidgetId()).toMatch(/^widget-/);
  });
});

describe('createMutationId', () => {
  it('is collision-resistant across a tight loop', () => {
    const ids = Array.from({ length: 1000 }, () => createMutationId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces ids with the `mut-` prefix', () => {
    expect(createMutationId()).toMatch(/^mut-/);
  });
});

describe('createPageId', () => {
  it('is collision-resistant across a tight loop', () => {
    const ids = Array.from({ length: 1000 }, () => createPageId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces ids with the `page-` prefix', () => {
    expect(createPageId()).toMatch(/^page-/);
  });
});

describe('createPresetId', () => {
  it('is collision-resistant across a tight loop', () => {
    const ids = Array.from({ length: 1000 }, () => createPresetId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces ids with the `preset-` prefix', () => {
    expect(createPresetId()).toMatch(/^preset-/);
  });
});

describe('createFilterId', () => {
  it('is collision-resistant across a tight loop', () => {
    const ids = Array.from({ length: 1000 }, () => createFilterId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces ids with the `filter-` prefix', () => {
    expect(createFilterId()).toMatch(/^filter-/);
  });
});

describe('createIdFactory', () => {
  it('is collision-resistant across a tight loop', () => {
    const createAnnotationId = createIdFactory('ann');
    const ids = Array.from({ length: 1000 }, () => createAnnotationId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces ids carrying the given prefix', () => {
    const createRelationshipId = createIdFactory('rel');
    expect(createRelationshipId()).toMatch(/^rel-/);
  });

  it('gives independent factories for different prefixes their own counters', () => {
    const createA = createIdFactory('a');
    const createB = createIdFactory('b');
    const ids = [createA(), createB(), createA(), createB()];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// Review 3.3: the five id factories are now built from a single `makeIdFactory(prefix)`
// helper. Each must still carry its own independent counter, so interleaving calls
// across factories can never collide (a shared counter would be a regression risk).
describe('id factories share makeIdFactory but keep independent counters (review 3.3)', () => {
  it('interleaved ids across all five factories are unique and keep their prefixes', () => {
    const ids: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      ids.push(
        createWidgetId(),
        createMutationId(),
        createPageId(),
        createPresetId(),
        createFilterId(),
      );
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.startsWith('widget-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('mut-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('page-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('preset-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('filter-'))).toBe(true);
  });
});

describe('createMutationEnvelope', () => {
  const mutation = { type: 'setDashboardTitle', args: { title: 'Q3 Revenue' } } as const;

  it('wraps the mutation unchanged under `mutation`', () => {
    const envelope = createMutationEnvelope(mutation);
    expect(envelope.mutation).toBe(mutation);
  });

  it('stamps a `mut-`-prefixed id and an ISO 8601 `at` timestamp', () => {
    const envelope = createMutationEnvelope(mutation);
    expect(envelope.id).toMatch(/^mut-/);
    expect(() => new Date(envelope.at).toISOString()).not.toThrow();
    expect(new Date(envelope.at).toISOString()).toBe(envelope.at);
  });

  it('mints a distinct id for every call', () => {
    const first = createMutationEnvelope(mutation);
    const second = createMutationEnvelope(mutation);
    expect(first.id).not.toBe(second.id);
  });
});

describe('normalizeChartSeries', () => {
  it('leaves a series that already uses the canonical `type` unchanged (same reference)', () => {
    const series = { fieldId: 'revenue', type: 'line' as const };
    expect(normalizeChartSeries(series)).toBe(series);
  });

  it('promotes the deprecated `seriesType` alias to canonical `type` and drops the alias', () => {
    const result = normalizeChartSeries({ fieldId: 'revenue', seriesType: 'line' });
    expect(result.type).toBe('line');
    expect('seriesType' in result).toBe(false);
  });

  it('prefers `type` over `seriesType` when both are present', () => {
    const result = normalizeChartSeries({ fieldId: 'revenue', seriesType: 'bar', type: 'line' });
    expect(result.type).toBe('line');
    expect('seriesType' in result).toBe(false);
  });

  it('leaves a series carrying neither spelling unchanged (same reference)', () => {
    const series = { fieldId: 'revenue' };
    expect(normalizeChartSeries(series)).toBe(series);
  });

  it('is total over junk input: null / non-object entries are returned unchanged, not thrown on (1.1)', () => {
    // A malformed `ySeries` entry (e.g. `[null]` from a wire payload whose config
    // interior the parser leaves as an unvalidated leaf) reaches this normalizer via
    // the reducer. Reading `.type` off `null` used to throw a TypeError mid-apply.
    expect(normalizeChartSeries(null as never)).toBeNull();
    expect(normalizeChartSeries(undefined as never)).toBeUndefined();
    expect(normalizeChartSeries(42 as never)).toBe(42);
    expect(normalizeChartSeries('bar' as never)).toBe('bar');
  });

  it('omits `type` for a nullish `seriesType` alias rather than promoting it to `type: null` (review 3.1)', () => {
    // A `seriesType: null` leaf (possible via the unvalidated config interior) must be
    // stripped, and — with no canonical `type` to fall back to — the result must OMIT
    // `type` rather than promote the junk into a canonical `type: null`.
    const result = normalizeChartSeries({ fieldId: 'revenue', seriesType: null } as never);
    expect('seriesType' in result).toBe(false);
    expect('type' in result).toBe(false);
  });

  it('drops a nullish `seriesType` alias while keeping a present canonical `type` (review 3.1)', () => {
    const result = normalizeChartSeries({
      fieldId: 'revenue',
      type: 'line',
      seriesType: null,
    } as never);
    expect(result.type).toBe('line');
    expect('seriesType' in result).toBe(false);
  });
});

describe('createDefaultStudioState', () => {
  it('deep-merges a partial session.shell.openDrawers override, leaving other shell flags at their defaults', () => {
    const state = createDefaultStudioState({
      session: { shell: { openDrawers: { filters: true } } } as any,
    });
    // The overridden flag takes effect...
    expect(state.session.shell.openDrawers.filters).toBe(true);
    // ...while sibling flags in the same openDrawers record keep their defaults.
    expect(state.session.shell.openDrawers.data).toBe(true);
    expect(state.session.shell.openDrawers.compose).toBe(true);
    // ...and other shell fields (not part of the override) also keep their defaults.
    expect(state.session.shell.selectedWidgetId).toBeNull();
    expect(state.session.shell.selectedFieldId).toBeNull();
    expect(state.session.shell.selectedSourceId).toBeNull();
  });

  it('deep-merges a partial doc.dashboard override rather than replacing it wholesale', () => {
    const state = createDefaultStudioState({
      doc: { dashboard: { title: 'Custom Title' } } as any,
    });
    expect(state.doc.dashboard.title).toBe('Custom Title');
    // id and activePageId are not part of the override, so they keep their defaults.
    expect(state.doc.dashboard.id).toBe('dashboard-1');
    expect(state.doc.dashboard.activePageId).toBe('page-1');
  });

  it('a `doc.pages` override replaces the default page map wholesale rather than merging with it', () => {
    const customPages = {
      'custom-page': { id: 'custom-page', title: 'Custom', widgetRows: [] },
    };
    const state = createDefaultStudioState({ doc: { pages: customPages } });
    expect(state.doc.pages).toEqual(customPages);
    // The default page is gone entirely — not merged alongside the custom one.
    expect(state.doc.pages['page-1']).toBeUndefined();
  });

  it('reconciles a dangling activePageId when a doc.pages override omits the active page (review 3.5/finding 5)', () => {
    // The pages override replaces the map wholesale but leaves `activePageId` at its
    // default (`page-1`), which no longer exists — a blank canvas until the user
    // switches pages. It must fall back to the first page id, like `removePage` does.
    const customPages = {
      'custom-page': { id: 'custom-page', title: 'Custom', widgetRows: [] },
      'second-page': { id: 'second-page', title: 'Second', widgetRows: [] },
    };
    const state = createDefaultStudioState({ doc: { pages: customPages } });
    expect(state.doc.dashboard.activePageId).toBe('custom-page');
  });

  it('leaves an explicitly-supplied valid activePageId untouched', () => {
    const customPages = {
      'custom-page': { id: 'custom-page', title: 'Custom', widgetRows: [] },
      'second-page': { id: 'second-page', title: 'Second', widgetRows: [] },
    };
    const state = createDefaultStudioState({
      doc: { pages: customPages, dashboard: { activePageId: 'second-page' } as any },
    });
    // A caller who kept the two in sync is respected — no spurious first-page fallback.
    expect(state.doc.dashboard.activePageId).toBe('second-page');
  });

  it('synthesizes the default page when a doc.pages override is empty', () => {
    const state = createDefaultStudioState({ doc: { pages: {} } });
    // A zero-page doc is unrecoverable: `activePageId` would be `''`, which no
    // `Object.hasOwn(pages, activePageId)` guard satisfies, so every pageId-less
    // mutation silently no-ops forever. `removePage` refuses to delete the final page
    // and `deserializeState` re-synthesizes one; the factory now does the same.
    expect(Object.keys(state.doc.pages)).toEqual(['page-1']);
    expect(state.doc.dashboard.activePageId).toBe('page-1');
  });

  it('synthesizes the default page even when the empty override supplies its own activePageId', () => {
    const state = createDefaultStudioState({
      doc: { pages: {}, dashboard: { activePageId: 'ghost-page' } as any },
    });
    // The supplied id names no page, so it must still be reconciled onto the
    // synthesized page rather than left dangling.
    expect(Object.keys(state.doc.pages)).toEqual(['page-1']);
    expect(state.doc.dashboard.activePageId).toBe('page-1');
  });

  it('heals a NUMERIC activePageId that Object.hasOwn would coerce into a match', () => {
    // `Object.hasOwn(pages, 2)` coerces the key, so a numeric `activePageId: 2` "matches"
    // the string-keyed page `"2"` and used to be treated as valid — installing a number
    // into a string-typed field. Nothing downstream recovers: `removePage`'s strict `===`
    // compare never matches it, so removing page `"2"` leaves `activePageId: 2` dangling
    // and every legacy pageId-less mutation no-ops forever. Mirror the load boundary's
    // `typeof === 'string'` clause instead.
    const state = createDefaultStudioState({
      doc: {
        pages: { 2: { id: '2', title: 'Two', widgetRows: [] } },
        dashboard: { activePageId: 2 } as any,
      },
    });
    expect(typeof state.doc.dashboard.activePageId).toBe('string');
    expect(state.doc.dashboard.activePageId).toBe('2');
    // The consequence the guard exists to prevent: with the numeric value installed,
    // `removePage`'s `!==` filter kept the page and the doc was stuck forever.
    const afterRemove = applyDocMutation(state.doc, {
      type: 'removePage',
      args: { pageId: '2' },
    } as any);
    expect(Object.hasOwn(afterRemove.pages, afterRemove.dashboard.activePageId)).toBe(true);
  });

  it('stamps schemaVersion at CURRENT_SCHEMA_VERSION, ignoring a doc override that carries one', () => {
    // Every other doc producer stamps the version: `deserializeState` writes
    // `CURRENT_SCHEMA_VERSION` unconditionally and no reducer handler writes it at all.
    // The factory used to let `{ ...baseDoc, ...docOverrides }` carry an override's value
    // straight into live state — reachable via the realistic
    // `initialState={{ doc: JSON.parse(saved) as StudioDoc }}` cast.
    const state = createDefaultStudioState({ doc: { schemaVersion: 2 } as any });
    expect(state.doc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('a doc override carrying a NEWER schemaVersion does not produce a permanently unloadable doc', () => {
    // The end-to-end consequence: the disk value rides into live state, `serializeDoc`
    // spreads it back out on the first autosave, and the NEXT load hits
    // `deserializeState`'s deliberate newer-than-current throw — a doc this build made
    // itself and can never read back.
    const state = createDefaultStudioState({
      doc: { schemaVersion: CURRENT_SCHEMA_VERSION + 1 } as any,
    });
    const saved = serializeDoc(state.doc);
    expect(saved.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => deserializeState(saved, {})).not.toThrow();
  });
});

// `createDefaultStudioState` is the third producer of a `StudioDoc`, and it was the only
// unscreened one — yet its `overrides.doc` bag is reachable straight from the public
// `Studio initialState` prop (`new StudioController(initialState)`). It now runs the SAME
// per-entry screens the persistence load boundary applies (`docScreening.ts`).
describe('createDefaultStudioState screens its doc override', () => {
  // The three defects the review traced end-to-end, each asserted at the point it used to
  // throw rather than merely on the screened shape.
  it('drops a filter with no scope (used to throw in serializeDoc on the first autosave)', () => {
    const state = createDefaultStudioState({
      doc: { filters: [{ id: 'f1', field: 'x', operator: 'equals', value: 1 }] as any },
    });
    expect(state.doc.filters).toEqual([]);
    // The crash site: `serializeDoc` reads `f.scope.kind` with no optional chaining, on
    // every autosave AND every undo snapshot.
    expect(() => serializeDoc(state.doc)).not.toThrow();
  });

  it('coerces a widget config: null to {} (used to throw mid-reduce in shallowRecordEqual)', () => {
    const state = createDefaultStudioState({
      doc: { widgets: { w1: { id: 'w1', kind: 'chart', title: 'T', config: null } } as any },
    });
    expect(state.doc.widgets.w1.config).toEqual({});
    // The crash site: the next config-touching mutation does
    // `shallowRecordEqual(existing.config, …)`, which throws on `null`.
    expect(() =>
      applyDocMutation(state.doc, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { config: { chartType: 'line' } } },
      } as any),
    ).not.toThrow();
  });

  it('drops a junk ai.threads (used to throw `map is not a function` in renameAIThread)', () => {
    const state = createDefaultStudioState({ doc: { ai: { threads: 'junk' } as any } });
    expect(state.doc.ai).toBeUndefined();
    expect(() =>
      applyDocMutation(state.doc, {
        type: 'renameAIThread',
        args: { name: 'X', updatedAt: '2024-01-01T00:00:00.000Z', threadId: 't1' },
      } as any),
    ).not.toThrow();
  });

  it('drops junk relationships / expressionFields / filterPresets entries', () => {
    const state = createDefaultStudioState({
      doc: {
        relationships: [null, { id: 'r1' }] as any,
        expressionFields: [{ id: 'e1', sourceId: 's', label: 'L' }] as any,
        filterPresets: [{ name: 'no id', filters: [] }] as any,
      },
    });
    expect(state.doc.relationships).toEqual([]);
    expect(state.doc.expressionFields).toEqual([]);
    expect(state.doc.filterPresets).toEqual([]);
  });

  it('coerces a junk dashboard title/id to the factory fallbacks', () => {
    const state = createDefaultStudioState({ doc: { dashboard: { title: 42, id: null } as any } });
    expect(state.doc.dashboard.title).toBe('Untitled Dashboard');
    expect(state.doc.dashboard.id).toBe('dashboard-1');
  });

  // The two screens the factory deliberately does NOT apply, because it produces LIVE
  // state rather than reading from disk. Pinned so a future "make it match
  // `deserializeState` exactly" change has to argue with a test.
  it('KEEPS cross-filter and interactive scoped filters (they are live state, not disk state)', () => {
    const state = createDefaultStudioState({
      doc: {
        widgets: { w1: { id: 'w1', kind: 'chart', title: 'T', config: {} } } as any,
        filters: [
          {
            id: 'xf',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
          },
          {
            id: 'ia',
            field: 'y',
            operator: 'equals',
            value: 2,
            scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
          },
        ] as any,
      },
    });
    expect(state.doc.filters.map((f) => f.id)).toEqual(['xf', 'ia']);
  });

  it('KEEPS a filter anchored to the default page (no orphan-anchor check)', () => {
    // The `pages`/`widgets` overrides merge onto the defaults AFTER the screen runs, so an
    // anchor check here would wrongly drop a filter pointing at the default `page-1`.
    const state = createDefaultStudioState({
      doc: {
        filters: [
          {
            id: 'f1',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ] as any,
      },
    });
    expect(state.doc.filters.map((f) => f.id)).toEqual(['f1']);
  });

  it('leaves an absent override field at its factory default (the merge contract is unchanged)', () => {
    // The screen touches only the keys the bag actually carries, so a bag naming just
    // `dashboard` must not stamp `filterPresets: []` / `ai: undefined` onto the doc.
    const state = createDefaultStudioState({ doc: { dashboard: { title: 'Mine' } as any } });
    expect(Object.hasOwn(state.doc, 'filterPresets')).toBe(false);
    expect(Object.hasOwn(state.doc, 'ai')).toBe(false);
    expect(state.doc.filters).toEqual([]);
    expect(state.doc.dashboard.title).toBe('Mine');
  });

  it('leaves a well-formed doc override untouched', () => {
    const filters = [
      {
        id: 'f1',
        field: 'x',
        operator: 'equals' as const,
        value: 1,
        scope: { kind: 'page' as const, pageId: 'page-1' },
      },
    ];
    const state = createDefaultStudioState({ doc: { filters } });
    // Per-entry reference stability: a clean filter keeps its object identity.
    expect(state.doc.filters[0]).toBe(filters[0]);
  });

  // Rank-filter per-page uniqueness. The reducer enforces it on every live add
  // (`addFilter`) and re-sweeps it in its three layout handlers precisely so a doc is never
  // "live-valid and load-invalid"; the load boundary re-checks it too. The factory was the
  // one producer that skipped it, so an `initialState` with two conflicting rank filters
  // installed both and the next layout mutation (or reload) silently dropped one.
  it('drops a later rank filter that conflicts with an earlier one on the same page context', () => {
    const state = createDefaultStudioState({
      doc: {
        filters: [
          {
            id: 'r1',
            field: 'x',
            operator: 'equals',
            value: 1,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-1' },
          },
          {
            id: 'r2',
            field: 'y',
            operator: 'equals',
            value: 2,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ] as any,
      },
    });
    // First-in-array-order wins, the exact tie-break the reducer and the load boundary use.
    expect(state.doc.filters.map((f) => f.id)).toEqual(['r1']);
    // Live-valid ⇒ load-valid: a round trip through the load boundary's own rank sweep
    // must now be a no-op rather than a silent extra deletion.
    expect(deserializeState(serializeDoc(state.doc), {}).doc.filters.map((f) => f.id)).toEqual([
      'r1',
    ]);
  });

  it('keeps rank filters that resolve to DIFFERENT page contexts', () => {
    const state = createDefaultStudioState({
      doc: {
        pages: {
          'page-a': { id: 'page-a', title: 'A', widgetRows: [] },
          'page-b': { id: 'page-b', title: 'B', widgetRows: [] },
        },
        filters: [
          {
            id: 'r1',
            field: 'x',
            operator: 'equals',
            value: 1,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-a' },
          },
          {
            id: 'r2',
            field: 'y',
            operator: 'equals',
            value: 2,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-b' },
          },
        ] as any,
      },
    });
    // Rank uniqueness is PER PAGE — page-a's window does not block page-b's.
    expect(state.doc.filters.map((f) => f.id)).toEqual(['r1', 'r2']);
  });

  it('leaves a non-rank-eligible scope alone even with filterMode: rank', () => {
    // A `dashboard-date-range` scope resolves to the UNRESOLVABLE sentinel, so it must
    // neither be dropped nor block the legitimate page rank filter after it — matching
    // `hasConflictingRankFilter`'s own exclusion and the load boundary's identical gate.
    const state = createDefaultStudioState({
      doc: {
        filters: [
          {
            id: 'dr',
            field: 'd',
            operator: 'equals',
            value: 1,
            filterMode: 'rank',
            scope: { kind: 'dashboard-date-range', sourceId: 's1', pageId: 'page-1' },
          },
          {
            id: 'r1',
            field: 'x',
            operator: 'equals',
            value: 1,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ] as any,
      },
    });
    expect(state.doc.filters.map((f) => f.id)).toEqual(['dr', 'r1']);
  });

  it('keeps the filters array reference-stable when no rank conflict exists', () => {
    const filters = [
      {
        id: 'r1',
        field: 'x',
        operator: 'equals' as const,
        value: 1,
        filterMode: 'rank' as const,
        scope: { kind: 'page' as const, pageId: 'page-1' },
      },
    ];
    const state = createDefaultStudioState({ doc: { filters } });
    expect(state.doc.filters[0]).toBe(filters[0]);
  });
});

// R3-F2: `pages` was the ONE `StudioDoc` field `screenDoc` skipped, which made it the one
// field where a `doc` override could make the factory THROW rather than repair — the repair
// convention's only sanctioned throw is a doc claiming a newer `schemaVersion`. All three
// payloads below are reachable from the public `Studio initialState` prop.
describe('createDefaultStudioState screens its pages override shape (R3-F2)', () => {
  it('an explicit `pages: undefined` falls back to the default page instead of throwing', () => {
    // Type-checks cleanly: `Partial<StudioDoc>` accepts an explicit `undefined`. Every OTHER
    // field with an explicit `undefined` was already repaired by `screenDoc`.
    const partial: Partial<StudioDoc> = {
      pages: undefined,
      widgets: undefined,
      filters: undefined,
    };
    let state!: ReturnType<typeof createDefaultStudioState>;
    // Used to throw `TypeError: Cannot convert undefined or null to object` from the
    // factory's own `Object.keys(mergedDoc.pages)` zero-page check.
    expect(() => {
      state = createDefaultStudioState({ doc: partial });
    }).not.toThrow();
    expect(Object.keys(state.doc.pages).length).toBeGreaterThan(0);
    expect(Object.hasOwn(state.doc.pages, state.doc.dashboard.activePageId)).toBe(true);
  });

  it('a non-record `pages` coerces to the default page map instead of installing verbatim', () => {
    // `pages: 'junk'` used to install the STRING as the page map, with `activePageId: '0'`
    // (its first "key"); the reducer then threw on the first `addWidget`.
    const state = createDefaultStudioState({
      doc: { pages: 'junk' as unknown as StudioDoc['pages'] },
    });
    expect(typeof state.doc.pages).toBe('object');
    expect(Object.keys(state.doc.pages).length).toBeGreaterThan(0);
    expect(Object.hasOwn(state.doc.pages, state.doc.dashboard.activePageId)).toBe(true);
    expect(() =>
      applyDocMutation(state.doc, {
        type: 'addWidget',
        args: { widget: { id: 'w1', kind: 'chart', title: 'T', config: { chartType: 'bar' } } },
      } as any),
    ).not.toThrow();
  });

  it('drops a null page value, so the rank-filter sweep the factory itself runs cannot throw', () => {
    // The crash site: `resolveRankFilterPageId` reads `page.widgetRows` with no optional
    // chaining, reached via the factory's own `dedupeRankFilters` sweep. The load boundary is
    // immune only because `normalizePersistedPages` drops the null page BEFORE that sweep.
    let state!: ReturnType<typeof createDefaultStudioState>;
    expect(() => {
      state = createDefaultStudioState({
        doc: {
          pages: { p1: null } as unknown as StudioDoc['pages'],
          filters: [
            {
              id: 'f1',
              field: 'x',
              operator: 'equals',
              value: 1,
              filterMode: 'rank',
              scope: { kind: 'widget', widgetId: 'w1' },
            },
          ] as any,
        },
      });
    }).not.toThrow();
    expect(state.doc.pages).not.toHaveProperty('p1');
    // The map emptied by the drop, so the "at least one page always exists" invariant
    // re-synthesizes the default page.
    expect(Object.keys(state.doc.pages).length).toBeGreaterThan(0);
  });

  it('drops a prototype-hazard page key and a page carrying a prototype-hazard own key', () => {
    const state = createDefaultStudioState({
      doc: {
        pages: JSON.parse(
          '{"p1":{"id":"p1","title":"Keep","widgetRows":[]},' +
            '"constructor":{"id":"constructor","title":"Bad","widgetRows":[]},' +
            '"p2":{"id":"p2","title":"Bad","widgetRows":[],"__proto__":{"polluted":true}}}',
        ) as StudioDoc['pages'],
      },
    });
    expect(Object.keys(state.doc.pages)).toEqual(['p1']);
  });

  it('keeps the pages record reference-stable when every page survives', () => {
    const pages = { p1: { id: 'p1', title: 'P1', widgetRows: [] } };
    const state = createDefaultStudioState({ doc: { pages } });
    expect(state.doc.pages).toBe(pages);
  });
});
