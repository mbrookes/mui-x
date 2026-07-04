import { describe, expect, it } from 'vitest';
import {
  createDefaultWidget,
  createDefaultStudioState,
  createWidgetId,
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
});

describe('createDefaultStudioState', () => {
  it('deep-merges a partial shell.openDrawers override, leaving other shell flags at their defaults', () => {
    const state = createDefaultStudioState({
      shell: { openDrawers: { filters: true } } as any,
    });
    // The overridden flag takes effect...
    expect(state.shell.openDrawers.filters).toBe(true);
    // ...while sibling flags in the same openDrawers record keep their defaults.
    expect(state.shell.openDrawers.data).toBe(true);
    expect(state.shell.openDrawers.compose).toBe(true);
    // ...and other shell fields (not part of the override) also keep their defaults.
    expect(state.shell.selectedWidgetId).toBeNull();
    expect(state.shell.selectedFieldId).toBeNull();
    expect(state.shell.selectedSourceId).toBeNull();
  });

  it('deep-merges a partial dashboard override rather than replacing it wholesale', () => {
    const state = createDefaultStudioState({
      dashboard: { title: 'Custom Title' } as any,
    });
    expect(state.dashboard.title).toBe('Custom Title');
    // id and activePageId are not part of the override, so they keep their defaults.
    expect(state.dashboard.id).toBe('dashboard-1');
    expect(state.dashboard.activePageId).toBe('page-1');
  });

  it('a `pages` override replaces the default page map wholesale rather than merging with it', () => {
    const customPages = {
      'custom-page': { id: 'custom-page', title: 'Custom', widgetRows: [] },
    };
    const state = createDefaultStudioState({ pages: customPages });
    expect(state.pages).toEqual(customPages);
    // The default page is gone entirely — not merged alongside the custom one.
    expect(state.pages['page-1']).toBeUndefined();
  });
});
