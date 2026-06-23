/**
 * Unit tests for the Studio state selectors.
 *
 * These selectors are pure derived-state functions consumed by
 * `useStudioSelector`. They were previously only exercised indirectly by a
 * performance test (`internals/renderPerf.test.tsx`), so their correctness —
 * filter partitioning, active-page scoping, and the reference-stability
 * memoization that prevents needless re-renders — was untested.
 */
import { describe, it, expect } from 'vitest';
import { createDefaultStudioState, type StudioFilterState } from '../models/stateTypes';
import type { StudioState, StudioWidget, StudioExpressionField, StudioDataSource } from '../models';
import {
  selectFilters,
  selectFilterPresets,
  selectWidgets,
  selectActivePage,
  selectActivePageId,
  selectMode,
  makeSelectActiveInteractiveFilter,
  makeSelectExpressionFieldsForSource,
  makeSelectExpressionFieldsForSources,
  selectPartitionedFilters,
  selectPartitionedBaseFilters,
  makeSelectActiveCrossFilter,
  makeSelectIncomingCrossFilters,
  makeSelectWidget,
  makeSelectIsWidgetSelected,
  makeSelectIsWidgetDimmed,
  makeSelectWidgetSource,
  makeSelectWidgetRankFilter,
  makeSelectWidgetSliderFilter,
  makeSelectWidgetActiveCrossFilter,
} from './selectors';

// ── Fixture factories ─────────────────────────────────────────────────────────

function filter(
  overrides: Partial<StudioFilterState> & Pick<StudioFilterState, 'id' | 'scope'>,
): StudioFilterState {
  return { field: 'f', operator: 'equals', value: null, ...overrides } as StudioFilterState;
}

function widget(
  id: string,
  kind: StudioWidget['kind'],
  extra: { sourceId?: string; config?: Record<string, unknown> } = {},
): StudioWidget {
  return {
    id,
    kind,
    title: id,
    sourceId: extra.sourceId,
    config: (extra.config ?? {}) as StudioWidget['config'],
  };
}

function exprField(id: string, sourceId: string): StudioExpressionField {
  return {
    id,
    label: id,
    sourceId,
    isMeasure: false,
    expression: {} as StudioExpressionField['expression'],
  };
}

function state(overrides?: Partial<StudioState>): StudioState {
  return createDefaultStudioState(overrides);
}

// ── Plain accessors ─────────────────────────────────────────────────────────

describe('plain accessors', () => {
  it('selectFilters / selectWidgets / selectMode return the corresponding slices', () => {
    const filters = [filter({ id: 'a', scope: { kind: 'page' } })];
    const s = state({ filters, mode: 'view' });
    expect(selectFilters(s)).toBe(filters);
    expect(selectWidgets(s)).toBe(s.widgets);
    expect(selectMode(s)).toBe('view');
  });

  it('selectActivePage / selectActivePageId resolve the active page', () => {
    const s = state();
    expect(selectActivePageId(s)).toBe('page-1');
    expect(selectActivePage(s)).toBe(s.pages['page-1']);
  });

  it('selectFilterPresets returns a stable empty array when none are set', () => {
    const a = selectFilterPresets(state());
    const b = selectFilterPresets(state());
    expect(a).toEqual([]);
    expect(a).toBe(b); // same module-level EMPTY reference
  });
});

// ── makeSelectActiveInteractiveFilter ──────────────────────────────────────────

describe('makeSelectActiveInteractiveFilter', () => {
  it('returns the interactive filter emitted by the widget', () => {
    const f = filter({ id: 'i1', scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' } });
    const sel = makeSelectActiveInteractiveFilter('w1');
    expect(sel(state({ filters: [f] }))).toBe(f);
  });

  it('returns null when the widget has no interactive filter', () => {
    const f = filter({ id: 'i1', scope: { kind: 'interactive', sourceWidgetId: 'other', pageId: 'page-1' } });
    expect(makeSelectActiveInteractiveFilter('w1')(state({ filters: [f] }))).toBeNull();
  });
});

// ── Expression-field selectors (memoized) ──────────────────────────────────────

describe('makeSelectExpressionFieldsForSource', () => {
  it('returns only the fields for the given source', () => {
    const ef1 = exprField('e1', 's1');
    const ef2 = exprField('e2', 's2');
    const sel = makeSelectExpressionFieldsForSource('s1');
    expect(sel(state({ expressionFields: [ef1, ef2] }))).toEqual([ef1]);
  });

  it('returns the same reference when the input array is unchanged', () => {
    const ef1 = exprField('e1', 's1');
    const s = state({ expressionFields: [ef1] });
    const sel = makeSelectExpressionFieldsForSource('s1');
    expect(sel(s)).toBe(sel(s));
  });

  it('reuses the previous result when the source fields are unchanged', () => {
    const ef1 = exprField('e1', 's1');
    const ef2 = exprField('e2', 's2');
    const sel = makeSelectExpressionFieldsForSource('s1');
    const first = sel(state({ expressionFields: [ef1, ef2] }));
    // New array reference, but s1's fields (ef1) are identical → previous ref reused.
    const second = sel(state({ expressionFields: [ef1, ef2, exprField('e3', 's2')] }));
    expect(second).toBe(first);
  });

  it('returns a new array when the source fields actually change', () => {
    const sel = makeSelectExpressionFieldsForSource('s1');
    const first = sel(state({ expressionFields: [exprField('e1', 's1')] }));
    const second = sel(state({ expressionFields: [exprField('e1-new', 's1')] }));
    expect(second).not.toBe(first);
    expect(second.map((ef) => ef.id)).toEqual(['e1-new']);
  });
});

describe('makeSelectExpressionFieldsForSources', () => {
  it('returns the fields for any of the given sources', () => {
    const ef1 = exprField('e1', 's1');
    const ef2 = exprField('e2', 's2');
    const ef3 = exprField('e3', 's3');
    const sel = makeSelectExpressionFieldsForSources(new Set(['s1', 's3']));
    expect(sel(state({ expressionFields: [ef1, ef2, ef3] }))).toEqual([ef1, ef3]);
  });
});

// ── selectPartitionedFilters ───────────────────────────────────────────────────

describe('selectPartitionedFilters', () => {
  it('partitions filters into page / widget / cross / interactive buckets', () => {
    const pageF = filter({ id: 'p', scope: { kind: 'page' } });
    const widgetF = filter({ id: 'w', scope: { kind: 'widget', widgetId: 'w1' } });
    const crossF = filter({ id: 'c', scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' } });
    const interactiveF = filter({ id: 'i', scope: { kind: 'interactive', sourceWidgetId: 'w-interactive', pageId: 'page-1' } });
    const result = selectPartitionedFilters(
      state({ filters: [pageF, widgetF, crossF, interactiveF] }),
    );
    expect(result.page).toEqual([pageF]);
    expect(result.byWidgetId.get('w1')).toEqual([widgetF]);
    expect(result.cross).toEqual([crossF]);
    expect(result.interactive).toEqual([interactiveF]);
  });

  it('scopes page filters to the active page (excludes other pages, keeps legacy no-pageId)', () => {
    const here = filter({ id: 'here', scope: { kind: 'page', pageId: 'page-1' } });
    const elsewhere = filter({ id: 'elsewhere', scope: { kind: 'page', pageId: 'page-2' } });
    const legacy = filter({ id: 'legacy', scope: { kind: 'page' } });
    const result = selectPartitionedFilters(state({ filters: [here, elsewhere, legacy] }));
    expect(result.page).toEqual([here, legacy]);
  });

  it('is memoized by filters + activePageId reference', () => {
    const s = state({ filters: [filter({ id: 'p', scope: { kind: 'page' } })] });
    expect(selectPartitionedFilters(s)).toBe(selectPartitionedFilters(s));
  });
});

// ── selectPartitionedBaseFilters ────────────────────────────────────────────────

describe('selectPartitionedBaseFilters', () => {
  it('includes only page and widget filters', () => {
    const result = selectPartitionedBaseFilters(
      state({
        filters: [
          filter({ id: 'p', scope: { kind: 'page' } }),
          filter({ id: 'w', scope: { kind: 'widget', widgetId: 'w1' } }),
          filter({ id: 'c', scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' } }),
          filter({ id: 'i', scope: { kind: 'interactive', sourceWidgetId: 'w-interactive', pageId: 'page-1' } }),
        ],
      }),
    );
    expect(result.page.map((f) => f.id)).toEqual(['p']);
    expect([...result.byWidgetId.keys()]).toEqual(['w1']);
  });

  it('returns a stable reference when only cross/interactive filters change', () => {
    const pageF = filter({ id: 'p', scope: { kind: 'page' } });
    const widgetF = filter({ id: 'w', scope: { kind: 'widget', widgetId: 'w1' } });
    const first = selectPartitionedBaseFilters(state({ filters: [pageF, widgetF] }));
    // New filters array, same page/widget content, plus an added cross-filter.
    const second = selectPartitionedBaseFilters(
      state({ filters: [pageF, widgetF, filter({ id: 'c', scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' } })] }),
    );
    expect(second).toBe(first);
  });
});

// ── Cross-filter selectors ──────────────────────────────────────────────────────

describe('makeSelectActiveCrossFilter', () => {
  it('matches by source widget and page', () => {
    const f = filter({ id: 'c', scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' } });
    expect(makeSelectActiveCrossFilter('w1', 'page-1')(state({ filters: [f] }))).toBe(f);
  });

  it('returns null when the page does not match', () => {
    const f = filter({ id: 'c', scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-2' } });
    expect(makeSelectActiveCrossFilter('w1', 'page-1')(state({ filters: [f] }))).toBeNull();
  });
});

describe('makeSelectIncomingCrossFilters', () => {
  it('returns cross-filters from OTHER widgets on the page', () => {
    const mine = filter({
      id: 'mine',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
    });
    const theirs = filter({
      id: 'theirs',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: 'page-1' },
    });
    const sel = makeSelectIncomingCrossFilters('w1', 'page-1');
    expect(sel(state({ filters: [mine, theirs] }))).toEqual([theirs]);
  });

  it('keeps a stable reference across unchanged inputs', () => {
    const theirs = filter({
      id: 'theirs',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: 'page-1' },
    });
    const sel = makeSelectIncomingCrossFilters('w1', 'page-1');
    const s = state({ filters: [theirs] });
    expect(sel(s)).toBe(sel(s));
  });
});

// ── Per-widget selectors ────────────────────────────────────────────────────────

describe('per-widget selectors', () => {
  it('makeSelectWidget returns the widget config or undefined', () => {
    const w = widget('w1', 'chart');
    const s = state({ widgets: { w1: w } });
    expect(makeSelectWidget('w1')(s)).toBe(w);
    expect(makeSelectWidget('missing')(s)).toBeUndefined();
  });

  it('makeSelectIsWidgetSelected reflects the shell selection', () => {
    const s = state({ shell: { selectedWidgetId: 'w1' } as StudioState['shell'] });
    expect(makeSelectIsWidgetSelected('w1')(s)).toBe(true);
    expect(makeSelectIsWidgetSelected('w2')(s)).toBe(false);
  });

  it('makeSelectIsWidgetDimmed is true only when a DIFFERENT widget is selected', () => {
    const selected = state({ shell: { selectedWidgetId: 'w1' } as StudioState['shell'] });
    const none = state({ shell: { selectedWidgetId: null } as StudioState['shell'] });
    expect(makeSelectIsWidgetDimmed('w2')(selected)).toBe(true);
    expect(makeSelectIsWidgetDimmed('w1')(selected)).toBe(false);
    expect(makeSelectIsWidgetDimmed('w1')(none)).toBe(false);
  });

  it('makeSelectWidgetSource resolves the widget data source', () => {
    const source = { id: 's1', label: 'S1', fields: [] } as StudioDataSource;
    const s = state({
      widgets: { w1: widget('w1', 'chart', { sourceId: 's1' }), w2: widget('w2', 'chart') },
      dataSources: { s1: source },
    });
    expect(makeSelectWidgetSource('w1')(s)).toBe(source);
    expect(makeSelectWidgetSource('w2')(s)).toBeUndefined(); // no sourceId
  });
});

describe('makeSelectWidgetRankFilter', () => {
  const rankFilter = filter({
    id: 'r',
    scope: { kind: 'widget', widgetId: 'w1' },
    filterMode: 'rank',
    value: 5,
  });

  it('returns the rank filter for a chart widget', () => {
    const s = state({ widgets: { w1: widget('w1', 'chart') }, filters: [rankFilter] });
    expect(makeSelectWidgetRankFilter('w1')(s)).toBe(rankFilter);
  });

  it('returns null for a non-chart widget', () => {
    const s = state({ widgets: { w1: widget('w1', 'grid') }, filters: [rankFilter] });
    expect(makeSelectWidgetRankFilter('w1')(s)).toBeNull();
  });

  it('returns null when the rank value is not positive', () => {
    const s = state({
      widgets: { w1: widget('w1', 'chart') },
      filters: [filter({ id: 'r', scope: { kind: 'widget', widgetId: 'w1' }, filterMode: 'rank', value: 0 })],
    });
    expect(makeSelectWidgetRankFilter('w1')(s)).toBeNull();
  });
});

describe('makeSelectWidgetSliderFilter', () => {
  it('returns the interactive filter for a slider filter widget on the active page', () => {
    const f = filter({ id: 'i', scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' } });
    const s = state({
      widgets: { w1: widget('w1', 'filter', { config: { filterWidgetType: 'slider' } }) },
      filters: [f],
    });
    expect(makeSelectWidgetSliderFilter('w1', 'page-1')(s)).toBe(f);
  });

  it('returns null when the filter widget is not a slider', () => {
    const f = filter({ id: 'i', scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' } });
    const s = state({
      widgets: { w1: widget('w1', 'filter', { config: { filterWidgetType: 'dropdown' } }) },
      filters: [f],
    });
    expect(makeSelectWidgetSliderFilter('w1', 'page-1')(s)).toBeNull();
  });
});

describe('makeSelectWidgetActiveCrossFilter', () => {
  const crossFilter = filter({
    id: 'c',
    scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
  });

  it.each(['chart', 'grid'] as const)('returns the cross-filter for a %s widget', (kind) => {
    const s = state({ widgets: { w1: widget('w1', kind) }, filters: [crossFilter] });
    expect(makeSelectWidgetActiveCrossFilter('w1', 'page-1')(s)).toBe(crossFilter);
  });

  it('returns null for a widget kind that does not emit cross-filters', () => {
    const s = state({ widgets: { w1: widget('w1', 'kpi') }, filters: [crossFilter] });
    expect(makeSelectWidgetActiveCrossFilter('w1', 'page-1')(s)).toBeNull();
  });
});
