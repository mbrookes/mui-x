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

  it('falls back to an empty activePageId when a doc.pages override is empty', () => {
    const state = createDefaultStudioState({ doc: { pages: {} } });
    // Mirrors `removePage`'s `remainingPageIds[0] ?? ''` when no page survives.
    expect(state.doc.dashboard.activePageId).toBe('');
  });
});
