import { describe, expect, it } from 'vitest';
import { selectFiltersForWidget, selectAdapterResidualFilters } from './filterScoping';
import type { StudioFilterState } from '../models';

function makeFilter(
  overrides: Partial<StudioFilterState> & { scope: StudioFilterState['scope'] },
): StudioFilterState {
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
    const f = makeFilter({ id: 'f1', scope: { kind: 'page' }, disabled: true, value: 'x' });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it('includes non-disabled page filters', () => {
    const f = makeFilter({ id: 'f1', scope: { kind: 'page' }, value: 'x' });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });
});

// ── dashboard-date-range source guard ─────────────────────────────────────────

describe("selectFiltersForWidget — scope: 'dashboard-date-range' source guard", () => {
  it('excludes date-range filter targeting a different source', () => {
    const f = makeFilter({
      id: 'ddr',
      scope: { kind: 'dashboard-date-range', sourceId: 'other-source', pageId: PAGE_ID },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it('includes date-range filter targeting the widget source', () => {
    const f = makeFilter({
      id: 'ddr',
      scope: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it('includes date-range filter with no filterSourceId (page-scoped fallback)', () => {
    const f = makeFilter({
      id: 'ddr',
      scope: { kind: 'page', pageId: PAGE_ID },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it('regression d00c343d: date-range filter for source A excluded when widget is on source B', () => {
    const filters = [
      makeFilter({
        id: 'ddr-a',
        scope: { kind: 'dashboard-date-range', sourceId: 'source-a', pageId: PAGE_ID },
        value: { from: '2024-01-01', to: '2024-12-31' },
      }),
      makeFilter({
        id: 'ddr-b',
        scope: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
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
    const f = makeFilter({ id: 'p', scope: { kind: 'page' }, value: 'x' });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(1);
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-cross' })).toHaveLength(1);
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(1);
  });
});

// ── scope: 'widget' ───────────────────────────────────────────────────────────

describe("selectFiltersForWidget — scope: 'widget'", () => {
  it('includes widget filter for this widget', () => {
    const f = makeFilter({ id: 'w', scope: { kind: 'widget', widgetId: WIDGET_ID }, value: 'x' });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it('excludes widget filter for a different widget', () => {
    const f = makeFilter({
      id: 'w',
      scope: { kind: 'widget', widgetId: 'other-widget' },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it('excludes rank-mode widget filters by default (chart re-ranks post-aggregation)', () => {
    const f = makeFilter({
      id: 'r',
      scope: { kind: 'widget', widgetId: WIDGET_ID },
      filterMode: 'rank',
      value: 5,
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  // finding 2.1: non-chart widget kinds opt into applying their widget-scoped rank filter at
  // L3 via `includeWidgetRank`, since they have no post-aggregation rank path of their own.
  it('includes rank-mode widget filters when includeWidgetRank is true', () => {
    const f = makeFilter({
      id: 'r',
      scope: { kind: 'widget', widgetId: WIDGET_ID },
      filterMode: 'rank',
      value: 5,
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, includeWidgetRank: true })).toHaveLength(1);
  });

  it('with includeWidgetRank true, still excludes a rank filter belonging to a DIFFERENT widget', () => {
    const f = makeFilter({
      id: 'r',
      scope: { kind: 'widget', widgetId: 'other-widget' },
      filterMode: 'rank',
      value: 5,
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, includeWidgetRank: true })).toHaveLength(0);
  });

  it('includes selection-mode widget filters', () => {
    const f = makeFilter({
      id: 's',
      scope: { kind: 'widget', widgetId: WIDGET_ID },
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
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(1);
  });

  it("include: 'all' — excludes self-emitted cross-filter", () => {
    const f = makeFilter({
      id: 'cf',
      scope: { kind: 'cross-filter', sourceWidgetId: WIDGET_ID, pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(0);
  });

  it("include: 'all' — excludes cross-filter from different page", () => {
    const f = makeFilter({
      id: 'cf',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: 'other-page' },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(0);
  });

  it("include: 'no-cross' — excludes cross-filters", () => {
    const f = makeFilter({
      id: 'cf',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-cross' })).toHaveLength(0);
  });

  it("include: 'no-chart-cross' — excludes cross-filters", () => {
    const f = makeFilter({
      id: 'cf',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
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
      scope: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(1);
  });

  it("include: 'no-cross' — excludes interactive filters", () => {
    const f = makeFilter({
      id: 'i',
      scope: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-cross' })).toHaveLength(0);
  });

  it("include: 'no-chart-cross' — includes interactive filter (interactive always hard-filters)", () => {
    const f = makeFilter({
      id: 'i',
      scope: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(1);
  });

  it("include: 'no-chart-cross' — excludes self-emitted interactive filter", () => {
    const f = makeFilter({
      id: 'i',
      scope: { kind: 'interactive', sourceWidgetId: WIDGET_ID, pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(0);
  });

  it("include: 'no-chart-cross' — excludes interactive filter from different page", () => {
    const f = makeFilter({
      id: 'i',
      scope: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: 'other-page' },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(0);
  });
});

// ── include mode: all three variants ─────────────────────────────────────────

describe('selectFiltersForWidget — include variants', () => {
  const page = makeFilter({ id: 'page', scope: { kind: 'page' }, value: 'x' });
  const widget = makeFilter({
    id: 'widget',
    scope: { kind: 'widget', widgetId: WIDGET_ID },
    value: 'y',
  });
  const cross = makeFilter({
    id: 'cross',
    scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
    value: 'z',
  });
  const interactive = makeFilter({
    id: 'interactive',
    scope: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
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
        scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: 'p1' },
        value: 'a',
      }),
      makeFilter({
        id: 'cf2',
        scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: 'p2' },
        value: 'b',
      }),
    ];
    const result = selectFiltersForWidget(filters, { ...baseOpts, activePageId: undefined });
    expect(result).toHaveLength(2);
  });

  // finding 5: `activePageId === undefined` must be a wildcard for scope:'page' filters too,
  // symmetric with cross-filter/interactive/dashboard-date-range above — otherwise a page
  // filter with a `pageId` is silently dropped in exactly the callers (the non-React
  // `StudioPipeline`, per its own class-doc examples) that most need every authored filter to
  // apply when there is no page-navigation context to scope by.
  it('includes page filters (with a pageId set) from any page when activePageId is undefined', () => {
    const filters = [
      makeFilter({ id: 'pf1', scope: { kind: 'page', pageId: 'p1' }, value: 'a' }),
      makeFilter({ id: 'pf2', scope: { kind: 'page', pageId: 'p2' }, value: 'b' }),
      makeFilter({ id: 'pf3', scope: { kind: 'page' }, value: 'c' }), // no pageId at all
    ];
    const result = selectFiltersForWidget(filters, { ...baseOpts, activePageId: undefined });
    expect(result.map((f) => f.id)).toEqual(['pf1', 'pf2', 'pf3']);
  });
});

// ── scope: typed path ───────────────────────────────────────────────────────

describe('selectFiltersForWidget — scope typed path', () => {
  it("scope kind:'page' — included regardless of legacy fields", () => {
    const f = makeFilter({ id: 'p', scope: { kind: 'page' }, value: 'x' });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it("scope kind:'page' with pageId — included when pageId matches", () => {
    const f = makeFilter({
      id: 'p',
      scope: { kind: 'page', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it("scope kind:'page' with different pageId — excluded", () => {
    const f = makeFilter({
      id: 'p',
      scope: { kind: 'page', pageId: 'other-page' },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it("scope kind:'widget' — included for matching widgetId", () => {
    const f = makeFilter({
      id: 'w',
      scope: { kind: 'widget', widgetId: WIDGET_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it("scope kind:'widget' — excluded for different widgetId", () => {
    const f = makeFilter({
      id: 'w',
      scope: { kind: 'widget', widgetId: 'other' },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it("scope kind:'cross-filter' — included with include:'all' and matching page", () => {
    const f = makeFilter({
      id: 'cf',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'all' })).toHaveLength(1);
  });

  it("scope kind:'cross-filter' — excluded with include:'no-chart-cross'", () => {
    const f = makeFilter({
      id: 'cf',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(0);
  });

  it("scope kind:'interactive' — included with include:'no-chart-cross'", () => {
    const f = makeFilter({
      id: 'i',
      scope: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(selectFiltersForWidget([f], { ...baseOpts, include: 'no-chart-cross' })).toHaveLength(1);
  });

  it("scope kind:'dashboard-date-range' — included when sourceId matches widget source", () => {
    const f = makeFilter({
      id: 'ddr',
      scope: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(1);
  });

  it("scope kind:'dashboard-date-range' — excluded when sourceId is different", () => {
    const f = makeFilter({
      id: 'ddr',
      scope: { kind: 'dashboard-date-range', sourceId: 'other-source', pageId: PAGE_ID },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it("scope kind:'dashboard-date-range' — excluded when pageId is different", () => {
    const f = makeFilter({
      id: 'ddr',
      scope: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: 'other-page' },
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });

  it('filter with missing scope kind is silently ignored', () => {
    // Filters whose scope is undefined/missing are skipped — all creation sites emit scope.
    const f = {
      id: 'ddr',
      field: 'date',
      operator: 'between',
      value: { from: '2024-01-01', to: '2024-12-31' },
      scope: undefined,
    } as unknown as StudioFilterState;
    expect(selectFiltersForWidget([f], baseOpts)).toHaveLength(0);
  });
});

// ── resolveDateRangePresets is called ─────────────────────────────────────────

describe('selectFiltersForWidget — resolveDateRangePresets', () => {
  it('resolves a non-custom preset to concrete {from, to} values', () => {
    const f = makeFilter({
      id: 'ddr',
      scope: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
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

// ── selectAdapterResidualFilters ─────────────────────────────────────────────
//
// The residual is exactly what `buildQueryDescriptor` could NOT put into the wire `filter`
// tree (`serverFilters.filter((f) => filterMode !== 'rank' && isFilterComplete(f))`):
// rank-mode filters of any authored scope, plus every cross-filter / interactive selection.
// These tests pin every scope kind on both sides of that line, plus the `includeWidgetRank`
// gate — this predicate previously existed as two hand-maintained copies (here and in
// `StudioWidgetCard/widgetExport.ts`) which had drifted on the date-range case below.

function residualIds(
  filters: StudioFilterState[],
  opts: { widgetId?: string; includeWidgetRank: boolean },
): string[] {
  return selectAdapterResidualFilters(filters, {
    widgetId: opts.widgetId ?? WIDGET_ID,
    includeWidgetRank: opts.includeWidgetRank,
  }).map((f) => f.id);
}

describe("selectAdapterResidualFilters — scope: 'page'", () => {
  it('keeps a page-scoped RANK filter (no wire representation for a rank reduction)', () => {
    const f = makeFilter({ id: 'pr', scope: { kind: 'page' }, filterMode: 'rank', value: 5 });
    expect(residualIds([f], { includeWidgetRank: false })).toEqual(['pr']);
  });

  it('drops a page-scoped condition filter (already enforced server-side — finding M1b)', () => {
    const f = makeFilter({ id: 'pc', scope: { kind: 'page', pageId: PAGE_ID }, value: 'x' });
    expect(residualIds([f], { includeWidgetRank: true })).toEqual([]);
  });

  it('drops a page-scoped selection filter', () => {
    const f = makeFilter({
      id: 'ps',
      scope: { kind: 'page' },
      filterMode: 'selection',
      value: ['a'],
    });
    expect(residualIds([f], { includeWidgetRank: true })).toEqual([]);
  });

  it('does NOT scope by pageId — that is left to selectFiltersForWidget', () => {
    const f = makeFilter({
      id: 'pr-other',
      scope: { kind: 'page', pageId: 'other-page' },
      filterMode: 'rank',
      value: 5,
    });
    expect(residualIds([f], { includeWidgetRank: false })).toEqual(['pr-other']);
    // ...and the downstream pass is what actually removes it.
    expect(
      selectFiltersForWidget(
        selectAdapterResidualFilters([f], {
          widgetId: WIDGET_ID,
          includeWidgetRank: false,
        }),
        baseOpts,
      ),
    ).toHaveLength(0);
  });
});

describe("selectAdapterResidualFilters — scope: 'widget' and the includeWidgetRank gate", () => {
  const widgetRank = makeFilter({
    id: 'wr',
    scope: { kind: 'widget', widgetId: WIDGET_ID },
    filterMode: 'rank',
    value: 5,
  });

  it("keeps this widget's rank filter when includeWidgetRank is true (non-chart kinds)", () => {
    expect(residualIds([widgetRank], { includeWidgetRank: true })).toEqual(['wr']);
  });

  // The gate exists because xy chart families re-apply their widget rank post-aggregation
  // (`shouldApplyWidgetRankAtL3` is false for them); reducing at L3 too would double-apply it.
  it("drops this widget's rank filter when includeWidgetRank is false (xy chart kinds)", () => {
    expect(residualIds([widgetRank], { includeWidgetRank: false })).toEqual([]);
  });

  it('drops a rank filter belonging to a DIFFERENT widget even when includeWidgetRank is true', () => {
    const f = makeFilter({
      id: 'wr-other',
      scope: { kind: 'widget', widgetId: 'other-widget' },
      filterMode: 'rank',
      value: 5,
    });
    expect(residualIds([f], { includeWidgetRank: true })).toEqual([]);
  });

  it("drops this widget's NON-rank filters regardless of the gate (enforced server-side)", () => {
    const cond = makeFilter({
      id: 'wc',
      scope: { kind: 'widget', widgetId: WIDGET_ID },
      value: 'x',
    });
    const sel = makeFilter({
      id: 'ws',
      scope: { kind: 'widget', widgetId: WIDGET_ID },
      filterMode: 'selection',
      value: ['a'],
    });
    expect(residualIds([cond, sel], { includeWidgetRank: true })).toEqual([]);
    expect(residualIds([cond, sel], { includeWidgetRank: false })).toEqual([]);
  });
});

describe("selectAdapterResidualFilters — scope: 'dashboard-date-range'", () => {
  it('drops a condition-mode date range (it went to the server; re-applying it emptied the CSV)', () => {
    const f = makeFilter({
      id: 'ddr',
      scope: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
      operator: 'between',
      value: { from: '2024-01-01', to: '2024-12-31' },
    });
    expect(residualIds([f], { includeWidgetRank: true })).toEqual([]);
  });

  // REGRESSION: the export path's former hand-transcribed copy excluded EVERY
  // `dashboard-date-range` filter by scope kind, while the render path
  // (`useWidgetRows`) reached them through the partitioner's `page` bucket and kept the
  // rank-mode ones. `applyFilters` decides rank-ness purely from `filterMode` with no regard
  // for scope, and `buildQueryDescriptor` strips every rank filter from the wire tree — so a
  // rank-mode date-range filter is enforced nowhere unless it is residual.
  it('keeps a RANK-mode date range — otherwise it is enforced nowhere at all', () => {
    const f = makeFilter({
      id: 'ddr-rank',
      scope: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
      filterMode: 'rank',
      value: 5,
    });
    expect(residualIds([f], { includeWidgetRank: false })).toEqual(['ddr-rank']);
  });
});

describe("selectAdapterResidualFilters — scopes 'cross-filter' and 'interactive'", () => {
  it('keeps cross-filters (never sent to the server — this is their sole enforcement point)', () => {
    const f = makeFilter({
      id: 'cf',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(residualIds([f], { includeWidgetRank: false })).toEqual(['cf']);
  });

  it('keeps interactive (filter-widget) selections', () => {
    const f = makeFilter({
      id: 'i',
      scope: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
    });
    expect(residualIds([f], { includeWidgetRank: false })).toEqual(['i']);
  });

  it('keeps a SELF-emitted cross-filter as a candidate — self-exclusion is downstream', () => {
    const f = makeFilter({
      id: 'cf-self',
      scope: { kind: 'cross-filter', sourceWidgetId: WIDGET_ID, pageId: PAGE_ID },
      value: 'x',
    });
    expect(residualIds([f], { includeWidgetRank: false })).toEqual(['cf-self']);
    expect(
      selectFiltersForWidget(
        selectAdapterResidualFilters([f], { widgetId: WIDGET_ID, includeWidgetRank: false }),
        { ...baseOpts, include: 'all' },
      ),
    ).toHaveLength(0);
  });
});

describe('selectAdapterResidualFilters — non-scoping concerns are left downstream', () => {
  it('keeps DISABLED filters as candidates — selectFiltersForWidget drops them', () => {
    const f = makeFilter({
      id: 'cf-disabled',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
      value: 'x',
      disabled: true,
    });
    expect(residualIds([f], { includeWidgetRank: false })).toEqual(['cf-disabled']);
    expect(
      selectFiltersForWidget(
        selectAdapterResidualFilters([f], { widgetId: WIDGET_ID, includeWidgetRank: false }),
        { ...baseOpts, include: 'all' },
      ),
    ).toHaveLength(0);
  });

  it('ignores a filter with no scope at all', () => {
    const f = {
      id: 'no-scope',
      field: 'x',
      operator: 'equals',
      value: 'y',
      scope: undefined,
    } as unknown as StudioFilterState;
    expect(residualIds([f], { includeWidgetRank: true })).toEqual([]);
  });

  it('preserves input order across scope kinds', () => {
    const filters = [
      makeFilter({ id: 'pr', scope: { kind: 'page' }, filterMode: 'rank', value: 5 }),
      makeFilter({ id: 'pc', scope: { kind: 'page' }, value: 'x' }),
      makeFilter({
        id: 'wr',
        scope: { kind: 'widget', widgetId: WIDGET_ID },
        filterMode: 'rank',
        value: 3,
      }),
      makeFilter({
        id: 'ddr',
        scope: { kind: 'dashboard-date-range', sourceId: SOURCE_ID, pageId: PAGE_ID },
        operator: 'between',
        value: { from: '2024-01-01', to: '2024-12-31' },
      }),
      makeFilter({
        id: 'cf',
        scope: { kind: 'cross-filter', sourceWidgetId: 'other-w', pageId: PAGE_ID },
        value: 'z',
      }),
      makeFilter({
        id: 'i',
        scope: { kind: 'interactive', sourceWidgetId: 'other-w', pageId: PAGE_ID },
        value: 'q',
      }),
    ];
    expect(residualIds(filters, { includeWidgetRank: true })).toEqual(['pr', 'wr', 'cf', 'i']);
    expect(residualIds(filters, { includeWidgetRank: false })).toEqual(['pr', 'cf', 'i']);
  });
});
