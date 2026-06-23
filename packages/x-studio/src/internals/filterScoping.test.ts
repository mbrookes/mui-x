import { describe, expect, it } from 'vitest';
import { selectFiltersForWidget } from './filterScoping';
import type { StudioFilterState } from '../models';

function makeFilter(overrides: Partial<StudioFilterState> & { scopeV2: StudioFilterState['scopeV2'] }): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    value: '',
    ...overrides,
  } as StudioFilterState;
}

const WIDGET_ID = 'w1';
const SOURCE_ID = 's1';
const PAGE_ID = 'p1';

const baseOpts = {
  widgetId: WIDGET_ID,
  widgetSourceId: SOURCE_ID,
  activePageId: PAGE_ID,
};

// ── disabled guard ────────────────────────────────────────────────────────────

describe('selectFiltersForWidget — disabled guard', () => {
  it('excludes disabled page filters', () => {
    const f = makeFilter({ id: 'f1', scopeV2: { kind: 'page' }, disabled: true, value: 'x' });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it('includes non-disabled page filters', () => {
    const f = makeFilter({ id: 'f1', scopeV2: { kind: 'page' }, value: 'x' });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });
});

// ── dashboard-date-range source guard ─────────────────────────────────────────

describe("selectFiltersForWidget — scope: 'dashboard-date-range' source guard", () => {
  it('excludes date-range filter targeting a different source', () => {
    const f = makeFilter({
      id: 'ddr',
      scopeV2: { kind: 'dashboard-date-range', sourceId: 'other-source', pageId: PAGE_ID },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it('includes date-range filter targeting the widget source', () => {
    const f = makeFilter({
      id: 'ddr',
      scopeV2: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it('includes date-range filter with no filterSourceId (page-scoped fallback)', () => {
    const f = makeFilter({
      id: 'ddr',
      scopeV2: { kind: 'page', pageId: PAGE_ID },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it('regression d00c343d: date-range filter for source A excluded when widget is on source B', () => {
    const filters = [
      makeFilter({
        id: 'ddr-a',
        scopeV2: { kind: 'dashboard-date-range', sourceId: 'source-a', pageId: PAGE_ID },
        value: { from: '2024-01-01', to: '2024-12-31' },
      }),
      makeFilter({
        id: 'ddr-b',
        scopeV2: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
        value: { from: '2024-01-01', to: '2024-12-31' },
      }),
    ];
    const result = selectFiltersForWidget(filters, baseOpts);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ddr-b');
  });
});

// ── scope: 'page' ─────────────────────────────────────────────────────────────

describe("selectFiltersForWidget — scope: 'page'", () => {
  it('includes page filters in all include modes', () => {
    const f = makeFilter({ id: 'p', scopeV2: { kind: 'page' }, value: 'x' });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(1);
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-cross' })).toHaveLength(1);
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(1);
  });
});

// ── scope: 'widget' ───────────────────────────────────────────────────────────

describe("selectFiltersForWidget — scope: 'widget'", () => {
  it('includes widget filter for this widget', () => {
    const f = makeFilter({ id: 'w', scopeV2: { kind: 'widget', widgetId: WIDGET_ID }, value: 'x' });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it('excludes widget filter for a different widget', () => {
    const f = makeFilter({ id: 'w', scopeV2: { kind: 'widget', widgetId: 'other-widget' }, value: 'x' });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it('excludes rank-mode widget filters', () => {
    const f = makeFilter({
      id: 'r',
      scopeV2: { kind: 'widget', widgetId: WIDGET_ID },
      filterMode: 'rank',
      value: 5,
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it('includes selection-mode widget filters', () => {
    const f = makeFilter({
      id: 's',
      scopeV2: { kind: 'widget', widgetId: WIDGET_ID },
      filterMode: 'selection',
      value: ['a'],
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });
});

// ── scope: 'cross-filter' ─────────────────────────────────────────────────────

describe("selectFiltersForWidget — scope: 'cross-filter'", () => {
  it("include: 'all' — includes cross-filter from another widget on same page", () => {
    const f = makeFilter({
      id: 'cf',
      scopeV2: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(1);
  });

  it("include: 'all' — excludes self-emitted cross-filter", () => {
    const f = makeFilter({
      id: 'cf',
      scopeV2: { kind: 'cross-filter', sourceWidgetId: WIDGET_ID, pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(0);
  });

  it("include: 'all' — excludes cross-filter from different page", () => {
    const f = makeFilter({
      id: 'cf',
      scopeV2: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: 'other-page' },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(0);
  });

  it("include: 'no-cross' — excludes cross-filters", () => {
    const f = makeFilter({
      id: 'cf',
      scopeV2: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-cross' })).toHaveLength(0);
  });

  it("include: 'no-chart-cross' — excludes cross-filters", () => {
    const f = makeFilter({
      id: 'cf',
      scopeV2: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(0);
  });
});

// ── scope: 'interactive' ──────────────────────────────────────────────────────

describe("selectFiltersForWidget — scope: 'interactive'", () => {
  it("include: 'all' — includes interactive filter from another widget on same page", () => {
    const f = makeFilter({
      id: 'i',
      scopeV2: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(1);
  });

  it("include: 'no-cross' — excludes interactive filters", () => {
    const f = makeFilter({
      id: 'i',
      scopeV2: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-cross' })).toHaveLength(0);
  });

  it("include: 'no-chart-cross' — includes interactive filter (interactive always hard-filters)", () => {
    const f = makeFilter({
      id: 'i',
      scopeV2: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(1);
  });

  it("include: 'no-chart-cross' — excludes self-emitted interactive filter", () => {
    const f = makeFilter({
      id: 'i',
      scopeV2: { kind: 'interactive', sourceWidgetId: WIDGET_ID, pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(0);
  });

  it("include: 'no-chart-cross' — excludes interactive filter from different page", () => {
    const f = makeFilter({
      id: 'i',
      scopeV2: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: 'other-page' },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(0);
  });
});

// ── include mode: all three variants ─────────────────────────────────────────

describe('selectFiltersForWidget — include variants', () => {
  const page = makeFilter({ id: 'page', scopeV2: { kind: 'page' }, value: 'x' });
  const widget = makeFilter({ id: 'widget', scopeV2: { kind: 'widget', widgetId: WIDGET_ID }, value: 'y' });
  const cross = makeFilter({
    id: 'cross',
    scopeV2: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
    value: 'z',
  });
  const interactive = makeFilter({
    id: 'interactive',
    scopeV2: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
    value: 'q',
  });

  it("include: 'all' returns all four types", () => {
    const result = selectFiltersForWidget([page, widget, cross, interactive], {
      ...baseOpts,
      include: 'all',
    });
    expect(result.map((f) => f.id)).toEqual(['page', 'widget', 'cross', 'interactive']);
  });

  it("include: 'no-cross' returns only page and widget", () => {
    const result = selectFiltersForWidget([page, widget, cross, interactive], {
      ...baseOpts,
      include: 'no-cross',
    });
    expect(result.map((f) => f.id)).toEqual(['page', 'widget']);
  });

  it("include: 'no-chart-cross' returns page, widget, and interactive", () => {
    const result = selectFiltersForWidget([page, widget, cross, interactive], {
      ...baseOpts,
      include: 'no-chart-cross',
    });
    expect(result.map((f) => f.id)).toEqual(['page', 'widget', 'interactive']);
  });
});

// ── activePageId: undefined ───────────────────────────────────────────────────

describe('selectFiltersForWidget — activePageId undefined', () => {
  it('includes cross-filters from any page when activePageId is undefined', () => {
    const filters = [
      makeFilter({
        id: 'cf1',
        scopeV2: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: 'p1' },
        value: 'a',
      }),
      makeFilter({
        id: 'cf2',
        scopeV2: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: 'p2' },
        value: 'b',
      }),
    ];
    const result = selectFiltersForWidget(filters, { ...baseOpts, activePageId: undefined });
    expect(result).toHaveLength(2);
  });
});

// ── scopeV2: typed path ───────────────────────────────────────────────────────

describe('selectFiltersForWidget — scopeV2 typed path', () => {
  it("scopeV2 kind:'page' — included regardless of legacy fields", () => {
    const f = makeFilter({ id: 'p', scopeV2: { kind: 'page' }, value: 'x' });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it("scopeV2 kind:'page' with pageId — included when pageId matches", () => {
    const f = makeFilter({
      id: 'p',
      scopeV2: { kind: 'page', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it("scopeV2 kind:'page' with different pageId — excluded", () => {
    const f = makeFilter({
      id: 'p',
      scopeV2: { kind: 'page', pageId: 'other-page' },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it("scopeV2 kind:'widget' — included for matching widgetId", () => {
    const f = makeFilter({
      id: 'w',
      scopeV2: { kind: 'widget', widgetId: WIDGET_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it("scopeV2 kind:'widget' — excluded for different widgetId", () => {
    const f = makeFilter({
      id: 'w',
      scopeV2: { kind: 'widget', widgetId: 'other' },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it("scopeV2 kind:'cross-filter' — included with include:'all' and matching page", () => {
    const f = makeFilter({
      id: 'cf',
      scopeV2: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(1);
  });

  it("scopeV2 kind:'cross-filter' — excluded with include:'no-chart-cross'", () => {
    const f = makeFilter({
      id: 'cf',
      scopeV2: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(0);
  });

  it("scopeV2 kind:'interactive' — included with include:'no-chart-cross'", () => {
    const f = makeFilter({
      id: 'i',
      scopeV2: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(1);
  });

  it("scopeV2 kind:'dashboard-date-range' — included when sourceId matches widget source", () => {
    const f = makeFilter({
      id: 'ddr',
      scopeV2: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it("scopeV2 kind:'dashboard-date-range' — excluded when sourceId is different", () => {
    const f = makeFilter({
      id: 'ddr',
      scopeV2: { kind: 'dashboard-date-range', sourceId: 'other-source', pageId: PAGE_ID },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it("scopeV2 kind:'dashboard-date-range' — excluded when pageId is different", () => {
    const f = makeFilter({
      id: 'ddr',
      scopeV2: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: 'other-page' },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it('filter with missing scopeV2 kind is silently ignored', () => {
    // Filters whose scopeV2 is undefined/missing are skipped — all creation sites emit scopeV2.
    const f = {
      id: 'ddr',
      field: 'date',
      operator: 'between',
      value: { from: '2024-01-01', to: '2024-12-31' },
      scopeV2: undefined,
    } as unknown as StudioFilterState;
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });
});

// ── resolveDateRangePresets is called ─────────────────────────────────────────

describe('selectFiltersForWidget — resolveDateRangePresets', () => {
  it('resolves a non-custom preset to concrete {from, to} values', () => {
    const f = makeFilter({
      id: 'ddr',
      scopeV2: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
      dateRangePreset: 'last_12_months',
      operator: 'between',
      value: null,
    });
    const [resolved] = selectFiltersForWidget([f], baseOpts);
    const v = resolved.value as { from: string; to: string };
    expect(typeof v.from).toBe('string');
    expect(typeof v.to).toBe('string');
    expect(v.from).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});
