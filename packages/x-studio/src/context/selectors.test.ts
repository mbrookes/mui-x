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
import type {
  StudioState,
  StudioSession,
  StudioWidget,
  StudioExpressionField,
  StudioDataSource,
} from '../models';
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
    expression: { type: 'number', value: 0 } as StudioExpressionField['expression'],
  };
}

// Test helper that routes flat fixture overrides into the lifetime partitions
// (`doc`/`session`/`runtime`), so the many call sites below stay concise. This flat
// convenience shape is a test-only affordance — production `createDefaultStudioState`
// deliberately requires the explicit nested partitions.
function state(overrides?: {
  filters?: StudioFilterState[];
  widgets?: Record<string, StudioWidget>;
  expressionFields?: StudioExpressionField[];
  dataSources?: Record<string, StudioDataSource>;
  mode?: StudioSession['mode'];
  shell?: StudioSession['shell'];
  crossFilterAllPages?: boolean;
}): StudioState {
  const base = createDefaultStudioState({
    doc: {
      ...(overrides?.filters ? { filters: overrides.filters } : {}),
      ...(overrides?.widgets ? { widgets: overrides.widgets } : {}),
      ...(overrides?.expressionFields ? { expressionFields: overrides.expressionFields } : {}),
    },
    session: {
      ...(overrides?.mode ? { mode: overrides.mode } : {}),
      ...(overrides?.shell ? { shell: overrides.shell } : {}),
    },
    runtime: {
      ...(overrides?.dataSources ? { dataSources: overrides.dataSources } : {}),
    },
  });
  if (overrides?.crossFilterAllPages === undefined) {
    return base;
  }
  return {
    ...base,
    doc: {
      ...base.doc,
      dashboard: { ...base.doc.dashboard, crossFilterAllPages: overrides.crossFilterAllPages },
    },
  };
}

// ── Plain accessors ─────────────────────────────────────────────────────────

describe('plain accessors', () => {
  it('selectFilters / selectWidgets / selectMode return the corresponding slices', () => {
    const filters = [filter({ id: 'a', scope: { kind: 'page' } })];
    const s = state({ filters, mode: 'view' });
    expect(selectFilters(s)).toBe(filters);
    expect(selectWidgets(s)).toBe(s.doc.widgets);
    expect(selectMode(s)).toBe('view');
  });

  it('selectActivePage / selectActivePageId resolve the active page', () => {
    const s = state();
    expect(selectActivePageId(s)).toBe('page-1');
    expect(selectActivePage(s)).toBe(s.doc.pages['page-1']);
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
  it('returns the interactive filter emitted by the widget on the given page', () => {
    const f = filter({
      id: 'i1',
      scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
    });
    const sel = makeSelectActiveInteractiveFilter('w1', 'page-1');
    expect(sel(state({ filters: [f] }))).toBe(f);
  });

  it('returns null when the widget has no interactive filter', () => {
    const f = filter({
      id: 'i1',
      scope: { kind: 'interactive', sourceWidgetId: 'other', pageId: 'page-1' },
    });
    expect(makeSelectActiveInteractiveFilter('w1', 'page-1')(state({ filters: [f] }))).toBeNull();
  });

  it('does not surface a filter emitted on a DIFFERENT page (T1.1)', () => {
    // The interactive filter is pinned to `page-2` (e.g. authored there, or stranded after the
    // emitting widget moved pages). A control mounted on `page-1` must not advertise it as active
    // — it does not apply here, so a page-blind lookup would render "selected" while filtering
    // nothing.
    const f = filter({
      id: 'i1',
      scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-2' },
    });
    expect(makeSelectActiveInteractiveFilter('w1', 'page-1')(state({ filters: [f] }))).toBeNull();
    // Same filter, queried for its own page, still resolves.
    expect(makeSelectActiveInteractiveFilter('w1', 'page-2')(state({ filters: [f] }))).toBe(f);
  });

  it('does not surface a DISABLED interactive filter (finding 3.1)', () => {
    // After `toggleFilter` disables it, the filter no longer applies to rows, so the
    // filter-widget selection must not be advertised as active either.
    const f = filter({
      id: 'i1',
      disabled: true,
      scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
    });
    expect(makeSelectActiveInteractiveFilter('w1', 'page-1')(state({ filters: [f] }))).toBeNull();
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
    const crossF = filter({
      id: 'c',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
    });
    const interactiveF = filter({
      id: 'i',
      scope: { kind: 'interactive', sourceWidgetId: 'w-interactive', pageId: 'page-1' },
    });
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
          filter({
            id: 'c',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
          }),
          filter({
            id: 'i',
            scope: { kind: 'interactive', sourceWidgetId: 'w-interactive', pageId: 'page-1' },
          }),
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
      state({
        filters: [
          pageF,
          widgetF,
          filter({
            id: 'c',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
          }),
        ],
      }),
    );
    expect(second).toBe(first);
  });
});

// ── Cross-filter selectors ──────────────────────────────────────────────────────

describe('makeSelectActiveCrossFilter', () => {
  it('matches by source widget and page', () => {
    const f = filter({
      id: 'c',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
    });
    expect(makeSelectActiveCrossFilter('w1', 'page-1')(state({ filters: [f] }))).toBe(f);
  });

  it('returns null when the page does not match', () => {
    const f = filter({
      id: 'c',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-2' },
    });
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

  // ─── Finding 2.4 ────────────────────────────────────────────────────────────
  // `crossFilterAllPages` makes a cross-filter emitted on ANY page apply to a chart's
  // actual rows (see useWidgetRows' hasChartCrossFilters / filterScoping.ts). Before the
  // fix, this selector ignored the flag entirely and only ever matched same-page
  // cross-filters, so the "has incoming cross-filter" signal (gating the clear-cross-filter
  // affordance and hover/highlight logic) disagreed with what was actually filtering the
  // widget's rows.
  it('ignores a cross-filter from a DIFFERENT page when crossFilterAllPages is off (default)', () => {
    const otherPage = filter({
      id: 'other-page',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: 'page-2' },
    });
    const sel = makeSelectIncomingCrossFilters('w1', 'page-1');
    expect(sel(state({ filters: [otherPage] }))).toEqual([]);
  });

  it('includes a cross-filter from a DIFFERENT page when crossFilterAllPages is on (finding 2.4)', () => {
    const otherPage = filter({
      id: 'other-page',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: 'page-2' },
    });
    const sel = makeSelectIncomingCrossFilters('w1', 'page-1');
    expect(sel(state({ filters: [otherPage], crossFilterAllPages: true }))).toEqual([otherPage]);
  });

  it("still excludes the widget's OWN cross-filter and disabled ones when crossFilterAllPages is on", () => {
    const mine = filter({
      id: 'mine',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-2' },
    });
    const disabled = filter({
      id: 'disabled',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: 'page-2' },
      disabled: true,
    });
    const sel = makeSelectIncomingCrossFilters('w1', 'page-1');
    expect(sel(state({ filters: [mine, disabled], crossFilterAllPages: true }))).toEqual([]);
  });

  it('recomputes when crossFilterAllPages toggles even if the filters array reference is unchanged', () => {
    const otherPage = filter({
      id: 'other-page',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: 'page-2' },
    });
    const filters = [otherPage];
    const sel = makeSelectIncomingCrossFilters('w1', 'page-1');
    expect(sel(state({ filters, crossFilterAllPages: false }))).toEqual([]);
    // Same `filters` array reference, only the dashboard flag flips — the memoized
    // selector must not serve the stale cached (empty) result.
    expect(sel(state({ filters, crossFilterAllPages: true }))).toEqual([otherPage]);
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

  it('makeSelectWidget does not resolve an inherited Object.prototype member for a widgetId equal to its name', () => {
    // A doc/AI-authored widget id equal to "constructor" (or "toString"/"valueOf"/…) must not
    // resolve a bare bracket lookup to the inherited function off Object.prototype — that truthy
    // non-widget object would slip past `if (!widget) return null` guards in consumers like
    // `StudioWidgetCard.tsx` and crash on the first `.kind`/`.config` read.
    const s = state({ widgets: { w1: widget('w1', 'chart') } });
    expect(makeSelectWidget('constructor')(s)).toBeUndefined();
    expect(makeSelectWidget('toString')(s)).toBeUndefined();
    expect(makeSelectWidget('__proto__')(s)).toBeUndefined();
  });

  it('makeSelectIsWidgetSelected reflects the shell selection', () => {
    const s = state({ shell: { selectedWidgetId: 'w1' } as StudioSession['shell'] });
    expect(makeSelectIsWidgetSelected('w1')(s)).toBe(true);
    expect(makeSelectIsWidgetSelected('w2')(s)).toBe(false);
  });

  it('makeSelectIsWidgetDimmed is true only when a DIFFERENT widget is selected', () => {
    const selected = state({ shell: { selectedWidgetId: 'w1' } as StudioSession['shell'] });
    const none = state({ shell: { selectedWidgetId: null } as StudioSession['shell'] });
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

  it('makeSelectWidgetSource does not resolve an inherited Object.prototype member for a widgetId equal to its name', () => {
    // Same prototype-chain hazard as `makeSelectWidget` above, but on the `widgets[widgetId]`
    // lookup that precedes the (already-guarded) `dataSources[sourceId]` lookup inside
    // `makeSelectWidgetSource` itself.
    const s = state({ widgets: { w1: widget('w1', 'chart', { sourceId: 's1' }) } });
    expect(makeSelectWidgetSource('constructor')(s)).toBeUndefined();
    expect(makeSelectWidgetSource('toString')(s)).toBeUndefined();
    expect(makeSelectWidgetSource('__proto__')(s)).toBeUndefined();
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

  it('returns a widget-scoped rank filter for a non-chart widget (finding 3.9)', () => {
    // "Can rank" is derived from the filter set, not a chart-only kind gate: a grid /
    // KPI / map / pivot Top-N gets its "Top N" chip too.
    const s = state({ widgets: { w1: widget('w1', 'grid') }, filters: [rankFilter] });
    expect(makeSelectWidgetRankFilter('w1')(s)).toBe(rankFilter);
  });

  it('returns null when the widget has no widget-scoped rank filter', () => {
    const s = state({ widgets: { w1: widget('w1', 'grid') }, filters: [] });
    expect(makeSelectWidgetRankFilter('w1')(s)).toBeNull();
  });

  it('does not surface a DISABLED widget-scoped rank filter (finding 3.1)', () => {
    // A disabled Top-N filter no longer reduces rows (mirrors `useChartWidgetData`'s rank
    // lookup and `selectFiltersForWidget`), so the "Top N" chip must not advertise it.
    const s = state({
      widgets: { w1: widget('w1', 'grid') },
      filters: [{ ...rankFilter, disabled: true }],
    });
    expect(makeSelectWidgetRankFilter('w1')(s)).toBeNull();
  });

  it('surfaces a rank filter whose value is a numeric string (finding T3.8)', () => {
    // The engine (`isFilterComplete`, `applyRankToAggregated`) coerces the rank N with
    // `Number(...)`, so a host- or wire-authored `value: '5'` is enforced by every data path.
    // The chip selector must use the same coercion rather than requiring a native number,
    // otherwise the enforced Top-N would never surface its chip.
    const s = state({
      widgets: { w1: widget('w1', 'chart') },
      filters: [
        filter({
          id: 'r',
          scope: { kind: 'widget', widgetId: 'w1' },
          filterMode: 'rank',
          value: '5' as unknown as number,
        }),
      ],
    });
    expect(makeSelectWidgetRankFilter('w1')(s)).not.toBeNull();
  });

  it('returns null for a non-numeric rank value (finding T3.8)', () => {
    const s = state({
      widgets: { w1: widget('w1', 'chart') },
      filters: [
        filter({
          id: 'r',
          scope: { kind: 'widget', widgetId: 'w1' },
          filterMode: 'rank',
          value: 'N/A' as unknown as number,
        }),
      ],
    });
    expect(makeSelectWidgetRankFilter('w1')(s)).toBeNull();
  });

  it('returns null when the rank value is not positive', () => {
    const s = state({
      widgets: { w1: widget('w1', 'chart') },
      filters: [
        filter({
          id: 'r',
          scope: { kind: 'widget', widgetId: 'w1' },
          filterMode: 'rank',
          value: 0,
        }),
      ],
    });
    expect(makeSelectWidgetRankFilter('w1')(s)).toBeNull();
  });

  it('returns null (not a rank filter) for a widgetId equal to an Object.prototype member name', () => {
    // A bare `state.doc.widgets[widgetId]` lookup would resolve the inherited `constructor`
    // function (truthy), so the widget-existence guard must not treat that as "widget exists".
    // Scope a rank filter to the SAME phantom id: before the fix, the guard would pass (the
    // inherited function is truthy) and the filter lookup below would then match and return
    // it — reporting a "Top N" chip for a widget that doesn't exist.
    const phantomRankFilter = filter({
      id: 'r-phantom',
      scope: { kind: 'widget', widgetId: 'constructor' },
      filterMode: 'rank',
      value: 5,
    });
    const s = state({ widgets: { w1: widget('w1', 'chart') }, filters: [phantomRankFilter] });
    expect(makeSelectWidgetRankFilter('constructor')(s)).toBeNull();
  });
});

describe('makeSelectWidgetSliderFilter', () => {
  it('returns the interactive filter for a slider filter widget on the active page', () => {
    const f = filter({
      id: 'i',
      scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
    });
    const s = state({
      widgets: { w1: widget('w1', 'filter', { config: { filterWidgetType: 'slider' } }) },
      filters: [f],
    });
    expect(makeSelectWidgetSliderFilter('w1', 'page-1')(s)).toBe(f);
  });

  it('returns null when the filter widget is not a slider', () => {
    const f = filter({
      id: 'i',
      scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
    });
    const s = state({
      widgets: { w1: widget('w1', 'filter', { config: { filterWidgetType: 'dropdown' } }) },
      filters: [f],
    });
    expect(makeSelectWidgetSliderFilter('w1', 'page-1')(s)).toBeNull();
  });

  it('does not surface a DISABLED slider filter (finding 3.1)', () => {
    // A disabled slider filter no longer applies to rows, so the slider pill must not
    // advertise it (mirrors every data path's `!f.disabled` guard).
    const f = filter({
      id: 'i',
      disabled: true,
      scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
    });
    const s = state({
      widgets: { w1: widget('w1', 'filter', { config: { filterWidgetType: 'slider' } }) },
      filters: [f],
    });
    expect(makeSelectWidgetSliderFilter('w1', 'page-1')(s)).toBeNull();
  });

  it('returns null (not a phantom widget) for a widgetId equal to an Object.prototype member name', () => {
    // `state.doc.widgets[widgetId]` must not resolve the inherited `constructor` function for
    // a widgetId that isn't an own key of `widgets` — guarded the same way as
    // `makeSelectWidgetSource`/`makeSelectWidget`.
    const s = state({
      widgets: { w1: widget('w1', 'filter', { config: { filterWidgetType: 'slider' } }) },
    });
    expect(makeSelectWidgetSliderFilter('constructor', 'page-1')(s)).toBeNull();
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

  it('returns a map widget cross-filter (capability derived from the filter set, finding 3.9)', () => {
    // "Can emit" is derived from the filter set, not a chart/grid-only kind gate: a
    // map's emitted cross-filter now gets the card chip + clear affordance too.
    const s = state({ widgets: { w1: widget('w1', 'map') }, filters: [crossFilter] });
    expect(makeSelectWidgetActiveCrossFilter('w1', 'page-1')(s)).toBe(crossFilter);
  });

  it('returns null when the widget has no active cross-filter', () => {
    const s = state({ widgets: { w1: widget('w1', 'kpi') }, filters: [] });
    expect(makeSelectWidgetActiveCrossFilter('w1', 'page-1')(s)).toBeNull();
  });

  it('returns null (not a phantom widget) for a widgetId equal to an Object.prototype member name', () => {
    // `state.doc.widgets[widgetId]` must not resolve the inherited `constructor` function for
    // a widgetId that isn't an own key of `widgets`. Scope a cross-filter to the SAME phantom
    // id: before the fix, the existence guard would pass (the inherited function is truthy)
    // and the filter lookup below would then match and return it.
    const phantomCrossFilter = filter({
      id: 'c-phantom',
      scope: { kind: 'cross-filter', sourceWidgetId: 'constructor', pageId: 'page-1' },
    });
    const s = state({ widgets: { w1: widget('w1', 'chart') }, filters: [phantomCrossFilter] });
    expect(makeSelectWidgetActiveCrossFilter('constructor', 'page-1')(s)).toBeNull();
  });
});

describe('cross-filter selectors agree on the `disabled` flag (2.5)', () => {
  // Both selectors answer the same question ("the active cross-filter emitted by this
  // widget on this page") and must share the `!disabled` predicate so they cannot diverge.
  const disabledCrossFilter = filter({
    id: 'c',
    disabled: true,
    scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
  });

  it('both selectors treat a disabled cross-filter as inactive', () => {
    const s = state({ widgets: { w1: widget('w1', 'chart') }, filters: [disabledCrossFilter] });
    expect(makeSelectActiveCrossFilter('w1', 'page-1')(s)).toBeNull();
    expect(makeSelectWidgetActiveCrossFilter('w1', 'page-1')(s)).toBeNull();
  });

  it('both selectors return an enabled cross-filter', () => {
    const enabledCrossFilter = filter({
      id: 'c',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
    });
    const s = state({ widgets: { w1: widget('w1', 'chart') }, filters: [enabledCrossFilter] });
    expect(makeSelectActiveCrossFilter('w1', 'page-1')(s)).toBe(enabledCrossFilter);
    expect(makeSelectWidgetActiveCrossFilter('w1', 'page-1')(s)).toBe(enabledCrossFilter);
  });
});
