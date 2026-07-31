import { describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { applyMutation } from '@mui/x-studio-schema';
import type { SerializedStudioSession, SerializedStudioSnapshot } from '@mui/x-studio-schema';
import { StudioController } from './StudioController';
import { studioRequestCache } from '../internals/StudioRequestCache';
import type {
  StudioDataSourceAdapter,
  StudioFilterState,
  StudioQueryResult,
  StudioWidget,
  StudioWidgetConfig,
} from '../models';
import { resolveDateRangePreset } from '../internals/filterUtils';
import { GRID_COLS, MIN_SPAN } from '../components/StudioCanvas/canvasGridConstants';
import { getWidgetMinSpan } from '../components/StudioCanvas/StudioCanvas';
import { createChatTurnMutationLedger } from '../components/StudioChatPanel/chatTurnMutations';

function makeFilter(
  overrides: Partial<StudioFilterState> & { scope?: StudioFilterState['scope'] },
): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    value: '',
    scope: { kind: 'page' },
    ...overrides,
  } as StudioFilterState;
}

describe('StudioController.updateFilter', () => {
  it('does not allow a second rank filter', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController({
      doc: {
        filters: [
          makeFilter({ id: 'rank-filter', filterMode: 'rank', rankDirection: 'top', value: 10 }),
          makeFilter({ id: 'condition-filter', filterMode: 'condition', value: 'foo' }),
        ],
      },
    });

    controller.updateFilter('condition-filter', {
      filterMode: 'rank',
      value: 5,
      rankDirection: 'top',
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();

    const updatedFilters = controller.getState().doc.filters;
    expect(updatedFilters.find((filter) => filter.id === 'condition-filter')).toMatchObject({
      filterMode: 'condition',
      value: 'foo',
    });
  });

  it('allows updates to the existing rank filter', () => {
    const controller = new StudioController({
      doc: {
        filters: [
          makeFilter({ id: 'rank-filter', filterMode: 'rank', rankDirection: 'top', value: 10 }),
          makeFilter({ id: 'condition-filter', filterMode: 'condition', value: 'foo' }),
        ],
      },
    });

    controller.updateFilter('rank-filter', { value: 7 });

    expect(
      controller.getState().doc.filters.find((filter) => filter.id === 'rank-filter'),
    ).toMatchObject({
      filterMode: 'rank',
      value: 7,
      rankDirection: 'top',
    });
  });
});

// ─── StudioController.applyCrossFilter ────────────────────────────────────────

describe('StudioController.applyCrossFilter', () => {
  it('adds a cross-filter with filterSourceId when provided', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-chart-category', { kind: 'chart' }));

    controller.applyCrossFilter(
      'widget-chart-category',
      'category',
      'Electronics',
      'order-items-source',
    );

    const filters = controller.getState().doc.filters;
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({
      scope: { kind: 'cross-filter', sourceWidgetId: 'widget-chart-category' },
      field: 'category',
      operator: 'equals',
      value: 'Electronics',
      filterSourceId: 'order-items-source',
    });
  });

  it('adds a cross-filter without filterSourceId when omitted', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-chart', { kind: 'chart' }));

    controller.applyCrossFilter('widget-chart', 'status', 'active');

    const [f] = controller.getState().doc.filters;
    expect(f.filterSourceId).toBeUndefined();
    expect(f).toMatchObject({ field: 'status', value: 'active' });
  });

  it('replaces the existing cross-filter from the same source widget', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-a', { kind: 'chart' }));

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-a', 'category', 'Clothing', 'src-a');

    const filters = controller.getState().doc.filters;
    // Only one cross-filter from widget-a should remain
    expect(
      filters.filter(
        (f) => f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === 'widget-a',
      ),
    ).toHaveLength(1);
    expect(filters[0]).toMatchObject({ value: 'Clothing' });
  });

  // Finding L3: `applyCrossFilter` was the last doc writer with no value-equality no-op
  // guard. `commitDocPatch`'s guard is REFERENCE equality, and the fresh
  // `createFilterId()` minted on every call made the rebuilt `filters` array differ even
  // when the cross-filter was semantically identical — so a re-apply committed a phantom
  // undoable step, wrote a mutation-log line, and cleared the redo stack for nothing.
  it('no-ops when an identical cross-filter is re-applied', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-a', { kind: 'chart' }));

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    const filtersAfterFirst = controller.getState().doc.filters;
    const logAfterFirst = controller.getRecentMutations();

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    // Same array AND same filter id — no fresh entry was minted and swapped in.
    expect(controller.getState().doc.filters).toBe(filtersAfterFirst);
    // No second mutation-log line for a step that changed nothing.
    expect(controller.getRecentMutations()).toEqual(logAfterFirst);
    // Only ONE undoable step was ever pushed, so a single undo clears the cross-filter.
    controller.undo();
    expect(controller.getState().doc.filters).toHaveLength(0);
  });

  it('preserves the redo stack when an identical cross-filter is re-applied', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-a', { kind: 'chart' }));
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    // Build a redo entry so the "does not clear redo" half of the guard is observable.
    controller.setDashboardTitle('Renamed');
    controller.undo();
    expect(controller.canRedo()).toBe(true);

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    expect(controller.canRedo()).toBe(true);
  });

  it('still commits when the stored cross-filter differs only in operator or fieldType', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-a', { kind: 'chart' }));

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a', 'not_equals');

    const [f] = controller.getState().doc.filters;
    expect(f.operator).toBe('not_equals');
  });

  // The guard checks `disabled` separately from `isSameManagedFilterContent`'s fixed field
  // list: re-emitting is what re-enables a disabled cross-filter, and the widget click
  // handlers' toggle can't see one either (`makeSelectActiveCrossFilter` skips disabled
  // entries), so swallowing this call would strand the filter off with no way back.
  it('still commits when the stored cross-filter is disabled', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-a', { kind: 'chart' }));

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.toggleFilter(controller.getState().doc.filters[0].id);
    expect(controller.getState().doc.filters[0].disabled).toBe(true);

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    const [f] = controller.getState().doc.filters;
    expect(f.disabled).toBeUndefined();
  });

  it('does not remove cross-filters from other source widgets', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-a', { kind: 'chart' }));
    controller.addWidget(makeWidget('widget-b', { kind: 'chart' }));

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-b', 'region', 'EMEA', 'src-b');

    const filters = controller.getState().doc.filters;
    expect(filters).toHaveLength(2);
    expect(
      filters.some((f) => f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === 'widget-a'),
    ).toBe(true);
    expect(
      filters.some((f) => f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === 'widget-b'),
    ).toBe(true);
  });

  it('does not remove page-scoped filters when adding a cross-filter', () => {
    const controller = new StudioController({
      doc: { filters: [makeFilter({ id: 'date-filter', scope: { kind: 'page' }, field: 'date' })] },
    });
    controller.addWidget(makeWidget('widget-a', { kind: 'chart' }));

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    const filters = controller.getState().doc.filters;
    expect(filters.some((f) => f.id === 'date-filter')).toBe(true);
    expect(filters.some((f) => f.scope.kind === 'cross-filter')).toBe(true);
  });

  // Finding 1: a cross-filter naming a widget the doc doesn't have would filter its page
  // forever with no clearing affordance — interactive/cross filters are hidden from the
  // filters drawer UI, and the reducer's only cleanup path fires on widget REMOVAL, which
  // never happens for a widget that never existed. Mirrors the reducer's own `addFilter`
  // existence guard (`Object.hasOwn(state.widgets, id)`).
  it('does not commit a cross-filter when the source widget does not exist', () => {
    const controller = new StudioController();

    controller.applyCrossFilter('nonexistent-widget', 'category', 'Electronics', 'src-a');

    expect(controller.getState().doc.filters).toHaveLength(0);
  });

  // ─── crossFilterMode: 'none' must suppress EMISSION (architecture review iteration 22,
  // Tier 2 finding 2) ────────────────────────────────────────────────────────────────
  //
  // Every widget kind's click handler (chart, grid, map, and any future kind) funnels
  // through this single method, so gating here is the one place that can guarantee the
  // invariant holds everywhere instead of being duplicated (and, for chart/grid,
  // previously omitted) in each widget's own click handler.

  it("does not commit a cross-filter when the source widget's own crossFilterMode is 'none'", () => {
    const controller = new StudioController();
    controller.addWidget(
      makeWidget('widget-none', { kind: 'chart', config: { crossFilterMode: 'none' } }),
    );

    controller.applyCrossFilter('widget-none', 'category', 'Electronics', 'src-a');

    expect(controller.getState().doc.filters).toHaveLength(0);
  });

  it("still commits a cross-filter when the source widget's crossFilterMode is 'cross-highlight' or 'cross-filter'", () => {
    const controller = new StudioController();
    controller.addWidget(
      makeWidget('widget-highlight', {
        kind: 'chart',
        config: { crossFilterMode: 'cross-highlight' },
      }),
    );
    controller.addWidget(
      makeWidget('widget-filter-mode', {
        kind: 'chart',
        config: { crossFilterMode: 'cross-filter' },
      }),
    );

    controller.applyCrossFilter('widget-highlight', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-filter-mode', 'region', 'EMEA', 'src-b');

    expect(controller.getState().doc.filters).toHaveLength(2);
  });

  it("still commits a cross-filter when crossFilterMode is unset (defaults to 'cross-highlight', not 'none')", () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-default', { kind: 'chart', config: {} }));

    controller.applyCrossFilter('widget-default', 'category', 'Electronics', 'src-a');

    // Default mode is 'cross-highlight', so this SHOULD commit — guards against an
    // over-eager gate that treats "unset" the same as "none".
    expect(controller.getState().doc.filters).toHaveLength(1);
  });

  it("does not commit a cross-filter when the dashboard-wide globalCrossFilterMode override is 'none', even if the widget's own mode is 'cross-highlight'", () => {
    const controller = new StudioController({
      doc: {
        dashboard: {
          id: 'dashboard-1',
          title: 'Untitled Dashboard',
          activePageId: 'page-1',
          globalCrossFilterMode: 'none',
        },
      },
    });
    controller.addWidget(
      makeWidget('widget-a', { kind: 'chart', config: { crossFilterMode: 'cross-highlight' } }),
    );

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    expect(controller.getState().doc.filters).toHaveLength(0);
  });

  it("commits a cross-filter when globalCrossFilterMode overrides a widget's own 'none' mode to 'cross-filter'", () => {
    const controller = new StudioController({
      doc: {
        dashboard: {
          id: 'dashboard-1',
          title: 'Untitled Dashboard',
          activePageId: 'page-1',
          globalCrossFilterMode: 'cross-filter',
        },
      },
    });
    controller.addWidget(
      makeWidget('widget-a', { kind: 'chart', config: { crossFilterMode: 'none' } }),
    );

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    expect(controller.getState().doc.filters).toHaveLength(1);
  });
});

// ─── StudioController.clearCrossFilter ───────────────────────────────────────

describe('StudioController.clearCrossFilter', () => {
  it('removes the cross-filter from the specified source widget', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-a', { kind: 'chart' }));
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    controller.clearCrossFilter('widget-a');

    expect(
      controller.getState().doc.filters.filter((f) => f.scope.kind === 'cross-filter'),
    ).toHaveLength(0);
  });

  it('leaves cross-filters from other widgets untouched', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('widget-a', { kind: 'chart' }));
    controller.addWidget(makeWidget('widget-b', { kind: 'chart' }));
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-b', 'region', 'EMEA', 'src-b');

    controller.clearCrossFilter('widget-a');

    const remaining = controller.getState().doc.filters;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].scope.kind === 'cross-filter' && remaining[0].scope.sourceWidgetId).toBe(
      'widget-b',
    );
  });

  it('leaves page-scoped and widget-scoped filters untouched', () => {
    const controller = new StudioController({
      doc: {
        filters: [
          makeFilter({ id: 'page-filter', scope: { kind: 'page' } }),
          makeFilter({ id: 'widget-filter', scope: { kind: 'widget', widgetId: 'w1' } }),
        ],
      },
    });
    controller.addWidget(makeWidget('widget-a', { kind: 'chart' }));
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    controller.clearCrossFilter('widget-a');

    const filters = controller.getState().doc.filters;
    expect(filters.map((f) => f.id)).toContain('page-filter');
    expect(filters.map((f) => f.id)).toContain('widget-filter');
  });

  it('is a no-op when no cross-filter exists for the widget', () => {
    const controller = new StudioController({
      doc: { filters: [makeFilter({ id: 'page-filter', scope: { kind: 'page' } })] },
    });

    controller.clearCrossFilter('widget-nonexistent');

    expect(controller.getState().doc.filters).toHaveLength(1);
  });
});

// ─── StudioController.applyInteractiveFilter ─────────────────────────────────

describe('StudioController.applyInteractiveFilter', () => {
  it('adds an interactive filter with scope interactive', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('filter-widget-1', { kind: 'filter' }));

    controller.applyInteractiveFilter(
      'filter-widget-1',
      'category',
      'in',
      ['Electronics', 'Books'],
      {
        filterMode: 'selection',
      },
    );

    const filters = controller.getState().doc.filters;
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget-1' },
      field: 'category',
      operator: 'in',
      value: ['Electronics', 'Books'],
      filterMode: 'selection',
    });
  });

  it('stamps the active pageId on the filter', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('filter-widget-1', { kind: 'filter' }));
    const activePageId = controller.getState().doc.dashboard.activePageId;

    controller.applyInteractiveFilter('filter-widget-1', 'country', 'equals', 'AU');

    const [f] = controller.getState().doc.filters;
    expect(
      f.scope.kind === 'interactive'
        ? (f.scope as { kind: 'interactive'; sourceWidgetId: string; pageId: string }).pageId
        : undefined,
    ).toBe(activePageId);
  });

  it('replaces an existing interactive filter from the same widget', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('filter-widget-1', { kind: 'filter' }));

    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Electronics']);
    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Books', 'Clothing']);

    const filters = controller.getState().doc.filters;
    expect(
      filters.filter(
        (f) => f.scope.kind === 'interactive' && f.scope.sourceWidgetId === 'filter-widget-1',
      ),
    ).toHaveLength(1);
    expect(filters[0].value).toEqual(['Books', 'Clothing']);
  });

  it('does not remove interactive filters from other widgets', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('filter-widget-a', { kind: 'filter' }));
    controller.addWidget(makeWidget('filter-widget-b', { kind: 'filter' }));

    controller.applyInteractiveFilter('filter-widget-a', 'category', 'in', ['Electronics']);
    controller.applyInteractiveFilter('filter-widget-b', 'country', 'equals', 'AU');

    expect(controller.getState().doc.filters).toHaveLength(2);
  });

  it('stores filterSourceId for cross-source filtering', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('filter-widget-1', { kind: 'filter' }));

    controller.applyInteractiveFilter('filter-widget-1', 'segment', 'in', ['Enterprise'], {
      filterMode: 'selection',
      filterSourceId: 'source-customers',
    });

    const [f] = controller.getState().doc.filters;
    expect(f.filterSourceId).toBe('source-customers');
  });

  it('does not remove page/widget/cross filters', () => {
    const controller = new StudioController({
      doc: {
        filters: [
          makeFilter({ id: 'page-f', scope: { kind: 'page' } }),
          makeFilter({ id: 'widget-f', scope: { kind: 'widget', widgetId: 'w1' } }),
          makeFilter({
            id: 'cross-f',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
          }),
        ],
      },
    });
    controller.addWidget(makeWidget('filter-widget-1', { kind: 'filter' }));

    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Books']);

    const ids = controller.getState().doc.filters.map((f) => f.id);
    expect(ids).toContain('page-f');
    expect(ids).toContain('widget-f');
    expect(ids).toContain('cross-f');
  });

  // Finding 1 — see the matching test in `applyCrossFilter` above for the full rationale.
  it('does not commit an interactive filter when the source widget does not exist', () => {
    const controller = new StudioController();

    controller.applyInteractiveFilter('nonexistent-widget', 'category', 'in', ['Books']);

    expect(controller.getState().doc.filters).toHaveLength(0);
  });
});

// ─── StudioController.clearInteractiveFilter ─────────────────────────────────

describe('StudioController.clearInteractiveFilter', () => {
  it('removes the interactive filter for the specified widget', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('filter-widget-1', { kind: 'filter' }));
    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Books']);

    controller.clearInteractiveFilter('filter-widget-1');

    expect(
      controller.getState().doc.filters.filter((f) => f.scope.kind === 'interactive'),
    ).toHaveLength(0);
  });

  it('leaves interactive filters from other widgets untouched', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('filter-a', { kind: 'filter' }));
    controller.addWidget(makeWidget('filter-b', { kind: 'filter' }));
    controller.applyInteractiveFilter('filter-a', 'category', 'in', ['Books']);
    controller.applyInteractiveFilter('filter-b', 'country', 'equals', 'AU');

    controller.clearInteractiveFilter('filter-a');

    const remaining = controller.getState().doc.filters;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].scope.kind === 'interactive' && remaining[0].scope.sourceWidgetId).toBe(
      'filter-b',
    );
  });

  it('leaves page/widget/cross-filters untouched', () => {
    const controller = new StudioController({
      doc: { filters: [makeFilter({ id: 'page-f', scope: { kind: 'page' } })] },
    });
    controller.addWidget(makeWidget('filter-widget-1', { kind: 'filter' }));
    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Books']);

    controller.clearInteractiveFilter('filter-widget-1');

    expect(controller.getState().doc.filters.map((f) => f.id)).toContain('page-f');
  });

  it('is a no-op when no interactive filter exists for the widget', () => {
    const controller = new StudioController({
      doc: { filters: [makeFilter({ id: 'page-f', scope: { kind: 'page' } })] },
    });

    controller.clearInteractiveFilter('nonexistent-widget');

    expect(controller.getState().doc.filters).toHaveLength(1);
  });
});

// ─── StudioController.removeWidget + interactive filters ─────────────────────

describe('StudioController.removeWidget — interactive filter cleanup', () => {
  it('removes interactive filters when the source filter widget is deleted', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('filter-w1', { kind: 'filter' }));
    controller.applyInteractiveFilter('filter-w1', 'category', 'in', ['Books']);

    controller.removeWidget('filter-w1');

    expect(
      controller
        .getState()
        .doc.filters.filter(
          (f) => f.scope.kind === 'interactive' && f.scope.sourceWidgetId === 'filter-w1',
        ),
    ).toHaveLength(0);
  });

  it('preserves interactive filters from other widgets when one widget is removed', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('filter-w1', { kind: 'filter' }));
    controller.addWidget(makeWidget('filter-w2', { kind: 'filter' }));
    controller.applyInteractiveFilter('filter-w1', 'category', 'in', ['Books']);
    controller.applyInteractiveFilter('filter-w2', 'country', 'equals', 'AU');

    controller.removeWidget('filter-w1');

    const remaining = controller
      .getState()
      .doc.filters.filter((f) => f.scope.kind === 'interactive');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].scope.kind === 'interactive' && remaining[0].scope.sourceWidgetId).toBe(
      'filter-w2',
    );
  });
});

// ─── StudioController — filter scope pageId stamping ─────────────────────────

describe('StudioController — interactive/cross filter pageId stamping', () => {
  function twoPageController() {
    // `source-w` lives on page-2, but page-1 is the active page — mimicking a
    // debounced commit (e.g. DateRangeControl) firing after the user navigated away.
    // `ghost-w` exists in `doc.widgets` (satisfying the reducer-mirroring existence
    // guard — finding 1) but is not placed on ANY page's `widgetRows`, exercising
    // `resolveWidgetPageId`'s "not in any layout" fallback below.
    return new StudioController({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['other-w']] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['source-w']] },
        },
        widgets: {
          'other-w': makeWidget('other-w'),
          'source-w': makeWidget('source-w'),
          'ghost-w': makeWidget('ghost-w'),
        },
      },
    });
  }

  it('stamps an interactive filter with the SOURCE widget page, not activePageId', () => {
    const controller = twoPageController();

    controller.applyInteractiveFilter('source-w', 'category', 'in', ['Books']);

    const [f] = controller.getState().doc.filters;
    expect(f.scope).toMatchObject({
      kind: 'interactive',
      sourceWidgetId: 'source-w',
      pageId: 'page-2',
    });
  });

  it('stamps a cross-filter with the SOURCE widget page, not activePageId', () => {
    const controller = twoPageController();

    controller.applyCrossFilter('source-w', 'category', 'Books');

    const [f] = controller.getState().doc.filters;
    expect(f.scope).toMatchObject({
      kind: 'cross-filter',
      sourceWidgetId: 'source-w',
      pageId: 'page-2',
    });
  });

  it('falls back to activePageId when the source widget is not in any layout', () => {
    const controller = twoPageController();

    controller.applyCrossFilter('ghost-w', 'category', 'Books');

    const [f] = controller.getState().doc.filters;
    expect(f.scope.kind === 'cross-filter' && f.scope.pageId).toBe('page-1');
  });
});

// ─── StudioController — widget CRUD ──────────────────────────────────────────

function makeWidget(id: string, overrides: Partial<StudioWidget> = {}): StudioWidget {
  // `...overrides` (a `Partial<StudioWidget>`) broadens `kind`/`config` beyond a
  // single discriminated union member, so cast through `unknown` — this generic
  // test factory intentionally accepts any kind + config combination.
  return {
    id,
    kind: 'kpi',
    title: 'Test Widget',
    config: { kpiAggregation: 'sum' },
    ...overrides,
  } as unknown as StudioWidget;
}

describe('StudioController.addWidget', () => {
  it('adds the widget to the widgets map', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    expect(controller.getState().doc.widgets.w1).toBeDefined();
  });

  it('adds the widget id to widgetRows on the active page', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const activePageId = controller.getState().doc.dashboard.activePageId;
    const rows = controller.getState().doc.pages[activePageId].widgetRows;
    expect(rows.flat()).toContain('w1');
  });

  it('sets selectedWidgetId to the new widget', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');
  });

  it('appends a second widget as a new row', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    const activePageId = controller.getState().doc.dashboard.activePageId;
    expect(controller.getState().doc.pages[activePageId].widgetRows).toHaveLength(2);
  });

  // ── Write-side CHART-TYPE guard (architecture-review Tier 2 finding 2) ────────
  // `updateWidgetConfig` already validates chart-type-appropriate config keys on every
  // UPDATE; `addWidget` (the CREATE path) had no equivalent guard of its own, so a widget
  // could be created with an invalid/hostile `chartType` (e.g. a value equal to an
  // `Object.prototype` member name) that later reaches `getDescriptor`/render-time dispatch.
  // `addWidget` must repair this at the CREATE boundary itself, belt-and-braces alongside the
  // `Object.hasOwn` guard in `chartTypeRegistry.ts`'s `getDescriptor`.
  describe('chartType validation (defense-in-depth, finding 2)', () => {
    it('falls back to "bar" and warns when a chart widget is created with an invalid chartType', () => {
      const controller = new StudioController();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      controller.addWidget(
        makeWidget('chart1', {
          kind: 'chart',
          config: {
            chartType: 'not-a-real-chart-type',
            xField: 'category',
          } as unknown as StudioWidgetConfig,
        }),
      );

      const config = controller.getState().doc.widgets.chart1.config as StudioWidgetConfig;
      expect(config.chartType).toBe('bar');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('chart1');
      expect(warnSpy.mock.calls[0][0]).toContain('not-a-real-chart-type');

      warnSpy.mockRestore();
    });

    it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
      'falls back to "bar" (never an inherited Object.prototype member) for chartType=%s',
      (hostileChartType) => {
        const controller = new StudioController();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => {
          controller.addWidget(
            makeWidget(`chart-${hostileChartType}`, {
              kind: 'chart',
              config: { chartType: hostileChartType } as StudioWidgetConfig,
            }),
          );
        }).not.toThrow();

        const config = controller.getState().doc.widgets[`chart-${hostileChartType}`]
          .config as StudioWidgetConfig;
        expect(config.chartType).toBe('bar');

        warnSpy.mockRestore();
      },
    );

    it('drops config keys that belong to a different chart family than the repaired chartType', () => {
      const controller = new StudioController();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      controller.addWidget(
        makeWidget('chart2', {
          kind: 'chart',
          config: {
            chartType: 'not-a-real-chart-type',
            sankeyTargetField: 'region',
          } as unknown as StudioWidgetConfig,
        }),
      );

      const config = controller.getState().doc.widgets.chart2.config as StudioWidgetConfig;
      expect(config.chartType).toBe('bar');
      expect('sankeyTargetField' in config).toBe(false);

      warnSpy.mockRestore();
    });

    it('does not touch a valid chartType and does not warn', () => {
      const controller = new StudioController();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      controller.addWidget(
        makeWidget('chart3', {
          kind: 'chart',
          config: { chartType: 'gauge', yField: 'revenue', gaugeMax: 100 },
        }),
      );

      const config = controller.getState().doc.widgets.chart3.config as StudioWidgetConfig;
      expect(config.chartType).toBe('gauge');
      expect(config.gaugeMax).toBe(100);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    // An ABSENT `chartType` is the sanctioned "no discriminant yet == bar" default (mirrors
    // `parseStateMutation.ts`'s `hasInvalidChartTypeInConfig`) — it must never warn, and the
    // widget's config must pass through untouched (no `chartType: 'bar'` forcibly written in).
    it('does not warn or alter the config when chartType is absent from a chart widget', () => {
      const controller = new StudioController();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      controller.addWidget(
        makeWidget('chart4', { kind: 'chart', config: { crossFilterMode: 'cross-highlight' } }),
      );

      expect(controller.getState().doc.widgets.chart4.config).toEqual({
        crossFilterMode: 'cross-highlight',
      });
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('does not validate chartType for a non-chart widget kind', () => {
      const controller = new StudioController();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      controller.addWidget(makeWidget('grid1', { kind: 'grid', config: { gridHeight: 300 } }));

      expect(controller.getState().doc.widgets.grid1.config).toEqual({ gridHeight: 300 });
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});

describe('StudioController.removeWidget', () => {
  it('removes the widget from the widgets map', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.removeWidget('w1');
    expect(controller.getState().doc.widgets.w1).toBeUndefined();
  });

  it('removes the widget id from widgetRows', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.removeWidget('w1');
    const activePageId = controller.getState().doc.dashboard.activePageId;
    expect(controller.getState().doc.pages[activePageId].widgetRows.flat()).not.toContain('w1');
  });

  it('clears selectedWidgetId when the selected widget is removed', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    // selectedWidgetId is now 'w1'
    controller.removeWidget('w1');
    expect(controller.getState().session.shell.selectedWidgetId).toBeNull();
  });

  it('preserves selectedWidgetId when a different widget is removed', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    // selectedWidgetId is now 'w2' (last added)
    controller.removeWidget('w1');
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w2');
  });

  it('leaves other widgets intact', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    controller.removeWidget('w1');
    expect(controller.getState().doc.widgets.w2).toBeDefined();
  });
});

// ─── 2.2: dangling-selection reset on AI-driven / page removal ────────────────
// User-driven `removeWidget` correctly nulls a dangling `selectedWidgetId`, but the
// AI-driven `applyExternalMutation` path and `removePage` (whose deletion removes the
// page's widgets) previously left it pointing at a vanished widget — the compose
// drawer then renders a blank `WidgetConfigView`, and the stale id enables crash 1.3.
describe('StudioController selection reset (2.2)', () => {
  it('applyExternalMutation removeWidget clears a dangling selectedWidgetId', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');
    controller.applyExternalMutation({ type: 'removeWidget', args: { widgetId: 'w1' } });
    expect(controller.getState().session.shell.selectedWidgetId).toBeNull();
  });

  it('applyExternalMutation removeWidget preserves a still-valid selection', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2')); // selects w2
    controller.applyExternalMutation({ type: 'removeWidget', args: { widgetId: 'w1' } });
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w2');
  });

  it('removePage clears the selection when the selected widget was on the removed page', () => {
    const controller = new StudioController();
    const page2 = controller.addPage('Second'); // page2 becomes active
    controller.addWidget(makeWidget('w1')); // placed on page2, selected
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');
    controller.removePage(page2);
    expect(controller.getState().doc.widgets.w1).toBeUndefined();
    expect(controller.getState().session.shell.selectedWidgetId).toBeNull();
  });

  it('removePage preserves a selection that lives on a surviving page', () => {
    const controller = new StudioController();
    const firstPageId = controller.getState().doc.dashboard.activePageId;
    controller.addWidget(makeWidget('keep')); // on page 1, selected
    const page2 = controller.addPage('Second'); // active = page2
    controller.setActivePage(firstPageId);
    // Re-select the surviving widget, then remove the (empty) second page.
    controller.applyExternalMutation({ type: 'removePage', args: { pageId: page2 } });
    expect(controller.getState().session.shell.selectedWidgetId).toBe('keep');
  });
});

describe('StudioController.updateWidgetConfig', () => {
  it('keeps inferred chart titles in auto mode after field selection', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: {
            id: 'chart1',
            kind: 'chart',
            sourceId: 'orders',
            title: '',
            config: {
              chartType: 'bar',
            },
          },
        },
      },
      runtime: {
        dataSources: {
          orders: {
            id: 'orders',
            label: 'Orders',
            fields: [
              { id: 'month', label: 'Month', type: 'date' },
              { id: 'revenue', label: 'Revenue', type: 'number' },
            ],
          },
        },
      },
    });

    controller.updateWidgetConfig('chart1', { xField: 'month', yField: 'revenue' });

    expect(controller.getState().doc.widgets.chart1.title).toBe('Revenue by Month');
    expect(controller.getState().doc.widgets.chart1.titleMode).toBe('auto');
  });

  it('preserves an existing chart title when titleMode is undefined and chart type changes', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: {
            id: 'chart1',
            kind: 'chart',
            sourceId: 'orders',
            title: 'Revenue by Month',
            config: {
              chartType: 'bar',
              xField: 'month',
              yField: 'revenue',
            },
          },
        },
      },
      runtime: {
        dataSources: {
          orders: {
            id: 'orders',
            label: 'Orders',
            fields: [
              { id: 'month', label: 'Month', type: 'date' },
              { id: 'revenue', label: 'Revenue', type: 'number' },
            ],
          },
        },
      },
    });

    controller.updateWidgetConfig('chart1', { chartType: 'line' });

    expect(controller.getState().doc.widgets.chart1.title).toBe('Revenue by Month');
  });

  it('removes config keys when the incoming value is undefined', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          text1: {
            id: 'text1',
            kind: 'text',
            title: 'Notes',
            config: {
              textTitleColor: '#ff0000',
              textBody: 'Body',
            },
          },
        },
      },
    });

    controller.updateWidgetConfig('text1', { textTitleColor: undefined });

    expect(
      (controller.getState().doc.widgets.text1.config as StudioWidgetConfig).textTitleColor,
    ).toBeUndefined();
    expect('textTitleColor' in controller.getState().doc.widgets.text1.config).toBe(false);
  });

  it('strips cross-kind config keys (and warns) instead of persisting them', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          grid1: {
            id: 'grid1',
            kind: 'grid',
            title: 'Table',
            config: { gridHeight: 300 },
          },
        },
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // `chartType` is a chart-only key; `gridSortField` is a legitimate grid key.
    controller.updateWidgetConfig('grid1', {
      chartType: 'line',
      gridSortField: 'name',
    } as StudioWidgetConfig);

    const config = controller.getState().doc.widgets.grid1.config as StudioWidgetConfig;
    // The valid grid key is applied...
    expect(config.gridSortField).toBe('name');
    // ...and the cross-kind chart key is dropped, never persisted.
    expect('chartType' in config).toBe(false);
    // ...with a dev warning naming the widget, kind, and offending key.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('chartType');
    expect(warnSpy.mock.calls[0][0]).toContain('grid1');

    warnSpy.mockRestore();
  });

  it("strips config keys invalid for the widget's CURRENT chart type (and warns), on top of the kind-level check", () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: {
            id: 'chart1',
            kind: 'chart',
            title: 'Gauge',
            config: { chartType: 'gauge', yField: 'revenue' },
          },
        },
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // `sankeyTargetField` is a valid CHART key (passes the kind-level guard) but
    // is not valid for a 'gauge' chart; `gaugeMax` IS a legitimate gauge key.
    controller.updateWidgetConfig('chart1', {
      sankeyTargetField: 'region',
      gaugeMax: 100,
    } as StudioWidgetConfig);

    const config = controller.getState().doc.widgets.chart1.config as StudioWidgetConfig;
    // The valid gauge key is applied, and the pre-existing key is untouched...
    expect(config.gaugeMax).toBe(100);
    expect(config.yField).toBe('revenue');
    // ...the wrong-chart-type key is dropped, never persisted...
    expect('sankeyTargetField' in config).toBe(false);
    // ...with a dev warning naming the widget, chart type, and offending key.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('sankeyTargetField');
    expect(warnSpy.mock.calls[0][0]).toContain('gauge');
    expect(warnSpy.mock.calls[0][0]).toContain('chart1');

    warnSpy.mockRestore();
  });

  it('validates the NEW chart type (not the stale stored one) when the patch itself switches chartType', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: {
            id: 'chart1',
            kind: 'chart',
            title: 'Chart',
            config: { chartType: 'gauge', yField: 'revenue', gaugeMax: 100 },
          },
        },
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Switching to 'sankey' together with a sankey-appropriate key should apply
    // cleanly: the patch's OWN keys are validated against the NEW ('sankey') type
    // it is declaring, not the widget's previous ('gauge') stored type.
    controller.updateWidgetConfig('chart1', {
      chartType: 'sankey',
      sankeyTargetField: 'region',
    } as StudioWidgetConfig);

    const config = controller.getState().doc.widgets.chart1.config as StudioWidgetConfig;
    expect(config.chartType).toBe('sankey');
    expect(config.sankeyTargetField).toBe('region');
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('preserves pie/donut sort + grouping keys through a config round-trip (schema fix flows through the controller)', () => {
    // Regression: the pie family accepts `chartSortBy`/`chartSortDirection`/`xGroupBy`
    // (they are inherited sort/group keys). The schema/validator fix must flow through
    // the controller's write-side kind + chart-type guards untouched — none of these
    // keys should be stripped for a 'pie' (or 'donut') widget.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController({
      doc: {
        widgets: {
          pie1: { id: 'pie1', kind: 'chart', title: 'Pie', config: { chartType: 'pie' } },
          donut1: { id: 'donut1', kind: 'chart', title: 'Donut', config: { chartType: 'donut' } },
        },
      },
    });

    controller.updateWidgetConfig('pie1', {
      chartSortBy: 'value',
      chartSortDirection: 'desc',
      xGroupBy: 'month',
    } as StudioWidgetConfig);
    controller.updateWidgetConfig('donut1', {
      chartSortBy: 'category',
      chartSortDirection: 'asc',
      xGroupBy: 'quarter',
    } as StudioWidgetConfig);

    const pie = controller.getState().doc.widgets.pie1.config as StudioWidgetConfig;
    expect(pie.chartSortBy).toBe('value');
    expect(pie.chartSortDirection).toBe('desc');
    expect(pie.xGroupBy).toBe('month');
    const donut = controller.getState().doc.widgets.donut1.config as StudioWidgetConfig;
    expect(donut.chartSortBy).toBe('category');
    expect(donut.chartSortDirection).toBe('asc');
    expect(donut.xGroupBy).toBe('quarter');
    // No key was flagged as invalid, so no strip-and-warn fired.
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('does not warn when a config key is cleared with an explicit undefined value (validators skip undefined)', () => {
    // Regression: clearing `barLayout` while switching a bar chart to a line chart
    // sends `{ chartType: 'line', barLayout: undefined }`. `barLayout` is not a valid
    // key for a line chart, but because its value is `undefined` (a delete, not a set)
    // the validators skip it — the controller must NOT warn-and-strip it as invalid.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: {
            id: 'chart1',
            kind: 'chart',
            title: 'Chart',
            config: { chartType: 'bar', barLayout: 'stacked' },
          },
        },
      },
    });

    controller.updateWidgetConfig('chart1', {
      chartType: 'line',
      barLayout: undefined,
    } as StudioWidgetConfig);

    const config = controller.getState().doc.widgets.chart1.config as StudioWidgetConfig;
    expect(config.chartType).toBe('line');
    // The undefined-valued key is deleted (never persisted)...
    expect('barLayout' in config).toBe(false);
    // ...and crucially no dev warning fired for it.
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('does not push an undo entry for a no-op config patch (fully-stripped or same-value)', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          grid1: { id: 'grid1', kind: 'grid', title: 'Table', config: { gridHeight: 300 } },
        },
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(controller.canUndo()).toBe(false);

    // (a) A patch whose only key is stripped by validation (chart-only key on a grid)
    // leaves the doc unchanged → no undo entry.
    controller.updateWidgetConfig('grid1', { chartType: 'line' } as StudioWidgetConfig);
    expect(controller.canUndo()).toBe(false);

    // (b) Setting a key to its CURRENT value is a reference-preserving no-op → no undo entry.
    controller.updateWidgetConfig('grid1', { gridHeight: 300 } as StudioWidgetConfig);
    expect(controller.canUndo()).toBe(false);

    warnSpy.mockRestore();
  });

  // 1.3: the title-inference transform runs even on a reducer no-op (post-df6c2b7),
  // so an unknown id must be guarded rather than dereferencing `undefined.sourceId`.
  it('is a no-op (does not throw) for an unknown widgetId', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: { id: 'chart1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      },
    });
    const before = controller.getState();
    expect(() =>
      controller.updateWidgetConfig('does-not-exist', { xField: 'a' } as StudioWidgetConfig),
    ).not.toThrow();
    expect(controller.getState()).toBe(before);
  });
});

describe('StudioController.updateWidget', () => {
  const ordersSource = {
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'month', label: 'Month', type: 'date' as const },
        { id: 'revenue', label: 'Revenue', type: 'number' as const },
      ],
    },
  };

  it('voids a top-level field passed as an explicit undefined value (GridSetupPanel reset)', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          grid1: {
            id: 'grid1',
            kind: 'grid',
            title: 'Table',
            sourceId: 'orders',
            config: { columns: [{ fieldId: 'revenue' }] },
          },
        },
      },
    });

    // Byte-for-byte the GridSetupPanel "reset source, clear columns" call.
    controller.updateWidget('grid1', { sourceId: undefined, config: { columns: [] } });

    const w = controller.getState().doc.widgets.grid1;
    expect(w.sourceId).toBeUndefined();
    expect(w.config).toEqual({ columns: [] });
  });

  it('clears the subtitle (undefined value) without re-inferring titles (FormatPanel subtitle blur)', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: {
            id: 'chart1',
            kind: 'chart',
            sourceId: 'orders',
            // A stale title in auto mode: if re-inference wrongly fired it would
            // become "Revenue by Month", so this pins that it does NOT fire.
            title: 'Stale title',
            titleMode: 'auto',
            subtitle: 'Old subtitle',
            subtitleMode: 'auto',
            config: { chartType: 'bar', xField: 'month', yField: 'revenue' },
          },
        },
      },
      runtime: { dataSources: ordersSource },
    });

    // Mirrors FormatPanel: an empty trimmed subtitle collapses to `undefined`.
    const trimmed = '';
    controller.updateWidget('chart1', { subtitle: trimmed || undefined, subtitleMode: 'manual' });

    const w = controller.getState().doc.widgets.chart1;
    expect(w.subtitle).toBeUndefined();
    expect(w.subtitleMode).toBe('manual');
    // Re-inference is skipped because `subtitle` is present in `changes`.
    expect(w.title).toBe('Stale title');
  });

  it('re-infers titles in auto mode when no title/subtitle is provided', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: {
            id: 'chart1',
            kind: 'chart',
            sourceId: 'orders',
            title: 'Stale title',
            titleMode: 'auto',
            config: { chartType: 'bar', xField: 'month', yField: 'revenue' },
          },
        },
      },
      runtime: { dataSources: ordersSource },
    });

    controller.updateWidget('chart1', { sourceId: 'orders' });

    expect(controller.getState().doc.widgets.chart1.title).toBe('Revenue by Month');
    expect(controller.getState().doc.widgets.chart1.titleMode).toBe('auto');
  });

  it('does not overwrite an explicitly provided title with re-inference (FormatPanel manual title)', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: {
            id: 'chart1',
            kind: 'chart',
            sourceId: 'orders',
            title: 'Revenue by Month',
            titleMode: 'auto',
            config: { chartType: 'bar', xField: 'month', yField: 'revenue' },
          },
        },
      },
      runtime: { dataSources: ordersSource },
    });

    controller.updateWidget('chart1', { title: 'My Custom Title', titleMode: 'manual' });

    expect(controller.getState().doc.widgets.chart1.title).toBe('My Custom Title');
    expect(controller.getState().doc.widgets.chart1.titleMode).toBe('manual');
  });

  it('is a no-op for an unknown widgetId', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: { id: 'chart1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      },
    });
    const before = controller.getState();
    controller.updateWidget('nope', { title: 'x' });
    expect(controller.getState()).toBe(before);
  });

  // 1.3: the earlier test only exercises the `isExplicitTitleChange` branch (which
  // suppresses the title-inference transform entirely). A NON-title change on an
  // unknown id runs the transform, which since df6c2b7 executes even on a reducer
  // no-op — it must guard the missing widget rather than deref `undefined.sourceId`.
  it('is a no-op (does not throw) for an unknown widgetId with a non-title change', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          chart1: { id: 'chart1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      },
    });
    const before = controller.getState();
    expect(() => controller.updateWidget('does-not-exist', { sourceId: 'foo' })).not.toThrow();
    expect(controller.getState()).toBe(before);
  });

  // ── Write-side kind/chart-type guard on `changes.config` (Tier2 finding) ──────
  // `updateWidgetConfig` already validates kind/chart-type-appropriate config keys
  // on every config PATCH; `updateWidget`'s `changes.config` path (a documented,
  // supported call shape that the reducer treats as a WHOLESALE config REPLACEMENT,
  // per `applyMutation.ts`) ran neither guard. Every current call site happens to
  // pass `config: {...existingConfig, ...patch}`, so these tests mirror that shape.
  describe('changes.config kind/chart-type validation (mirrors updateWidgetConfig)', () => {
    it('strips a cross-kind config key from changes.config (and warns), same as updateWidgetConfig', () => {
      const controller = new StudioController({
        doc: {
          widgets: {
            grid1: { id: 'grid1', kind: 'grid', title: 'Table', config: { gridHeight: 300 } },
          },
        },
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // `chartType` is a chart-only key; `gridHeight` is a legitimate grid key.
      controller.updateWidget('grid1', {
        config: { gridHeight: 400, chartType: 'line' } as StudioWidgetConfig,
      });

      const config = controller.getState().doc.widgets.grid1.config as StudioWidgetConfig;
      expect(config.gridHeight).toBe(400);
      expect('chartType' in config).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('chartType');
      expect(warnSpy.mock.calls[0][0]).toContain('grid1');

      warnSpy.mockRestore();
    });

    it("strips a config key invalid for the widget's CURRENT chart type from changes.config (and warns)", () => {
      const controller = new StudioController({
        doc: {
          widgets: {
            chart1: {
              id: 'chart1',
              kind: 'chart',
              title: 'Gauge',
              config: { chartType: 'gauge', yField: 'revenue', gaugeMax: 100 },
            },
          },
        },
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // `sankeyTargetField` is a valid CHART key (passes the kind-level guard) but is
      // not valid for a 'gauge' chart. Mirrors the real call-site shape: the existing
      // config spread with a patch.
      controller.updateWidget('chart1', {
        config: {
          chartType: 'gauge',
          yField: 'revenue',
          gaugeMax: 150,
          sankeyTargetField: 'region',
        } as StudioWidgetConfig,
      });

      const config = controller.getState().doc.widgets.chart1.config as StudioWidgetConfig;
      expect(config.gaugeMax).toBe(150);
      expect(config.yField).toBe('revenue');
      expect('sankeyTargetField' in config).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('sankeyTargetField');
      expect(warnSpy.mock.calls[0][0]).toContain('gauge');
      expect(warnSpy.mock.calls[0][0]).toContain('chart1');

      warnSpy.mockRestore();
    });

    it('never persists an invalid chartType supplied via changes.config, and does not throw', () => {
      const controller = new StudioController({
        doc: {
          widgets: {
            chart1: {
              id: 'chart1',
              kind: 'chart',
              title: 'Chart',
              config: { chartType: 'bar', xField: 'category', yField: 'revenue' },
            },
          },
        },
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => {
        controller.updateWidget('chart1', {
          config: {
            chartType: 'not-a-real-chart-type',
            xField: 'category',
            yField: 'revenue',
          } as unknown as StudioWidgetConfig,
        });
      }).not.toThrow();

      const config = controller.getState().doc.widgets.chart1.config as StudioWidgetConfig;
      // The bogus chartType is fail-closed stripped (same allow-list logic
      // `updateWidgetConfig` runs), never persisted verbatim.
      expect(config.chartType).not.toBe('not-a-real-chart-type');
      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('not-a-real-chart-type')),
      ).toBe(true);

      warnSpy.mockRestore();
    });

    // Entropy-audit finding: an explicit-but-invalid chartType in the patch used to be
    // used VERBATIM (no isStudioChartType check) as the "effective chart type" fed into
    // validateChartConfigKeysForType, which fails closed to an EMPTY allow-list for an
    // unrecognized chart type — flagging every remaining key (xField/yField included) as
    // invalid and wiping the config to {}, not just dropping the bad chartType. The
    // create-path sibling (createWidgetFromDescription.ts's sanitizeServerWidgetConfig)
    // already validated this correctly (fall back, keep the rest); the update path did
    // not. Pins the correct, now-shared behavior: only chartType is dropped, and the
    // surviving keys are validated against the WIDGET'S EXISTING chart type ('bar' here).
    it('falls back to the existing chartType and preserves the rest of the config when the patch chartType is invalid', () => {
      const controller = new StudioController({
        doc: {
          widgets: {
            chart1: {
              id: 'chart1',
              kind: 'chart',
              title: 'Chart',
              config: { chartType: 'bar', xField: 'category', yField: 'revenue' },
            },
          },
        },
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      controller.updateWidget('chart1', {
        config: {
          chartType: 'not-a-real-chart-type',
          xField: 'region',
          yField: 'profit',
        } as unknown as StudioWidgetConfig,
      });

      const config = controller.getState().doc.widgets.chart1.config as StudioWidgetConfig;
      // The bogus chartType is dropped, not re-inserted with the fallback value — same
      // convention `sanitizeWidgetConfigForChartType`'s create-path caller already used
      // (chartType absence resolves to 'bar' lazily via `resolveChartType` elsewhere).
      expect(config.chartType).toBeUndefined();
      expect(config.xField).toBe('region');
      expect(config.yField).toBe('profit');

      warnSpy.mockRestore();
    });

    it('does not warn and applies changes.config untouched when every key is valid', () => {
      const controller = new StudioController({
        doc: {
          widgets: {
            chart1: {
              id: 'chart1',
              kind: 'chart',
              title: 'Chart',
              config: { chartType: 'bar', xField: 'category' },
            },
          },
        },
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      controller.updateWidget('chart1', {
        config: { chartType: 'bar', xField: 'category', yField: 'revenue' } as StudioWidgetConfig,
      });

      const config = controller.getState().doc.widgets.chart1.config as StudioWidgetConfig;
      expect(config).toEqual({ chartType: 'bar', xField: 'category', yField: 'revenue' });
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});

describe('StudioController.duplicateWidget', () => {
  it('creates a new widget with a different id', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1', { title: 'Revenue' }));
    controller.duplicateWidget('w1');
    const ids = Object.keys(controller.getState().doc.widgets);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => id !== 'w1' || ids.some((id2) => id2 !== 'w1'))).toBe(true);
  });

  it('appends " (copy)" to the duplicated widget title', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1', { title: 'Revenue' }));
    controller.duplicateWidget('w1');
    const copyWidget = Object.values(controller.getState().doc.widgets).find((w) => w.id !== 'w1');
    expect(copyWidget?.title).toBe('Revenue (copy)');
  });

  it('sets selectedWidgetId to the copy', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1', { title: 'Revenue' }));
    controller.duplicateWidget('w1');
    const copyId = Object.keys(controller.getState().doc.widgets).find((id) => id !== 'w1');
    expect(controller.getState().session.shell.selectedWidgetId).toBe(copyId);
  });

  it("stamps titleMode: 'manual' on the copy so the '(copy)' suffix survives re-inference (3.x)", () => {
    const controller = new StudioController();
    // An AUTO-titled source widget: without an explicit title mode, the clone would inherit
    // `titleMode: 'auto'` and the next title re-inference would recompute the auto title,
    // silently dropping "(copy)".
    controller.addWidget(makeWidget('w1', { title: 'Revenue', titleMode: 'auto' }));
    controller.duplicateWidget('w1');
    const copyId = Object.keys(controller.getState().doc.widgets).find((id) => id !== 'w1')!;
    const copy = controller.getState().doc.widgets[copyId];
    expect(copy.title).toBe('Revenue (copy)');
    expect(copy.titleMode).toBe('manual');

    // A subsequent unrelated config update triggers title re-inference; "(copy)" must remain.
    controller.updateWidget(copyId, { config: { kpiAggregation: 'avg' } });
    expect(controller.getState().doc.widgets[copyId].title).toBe('Revenue (copy)');
  });

  it('adds the copy to widgetRows', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.duplicateWidget('w1');
    const activePageId = controller.getState().doc.dashboard.activePageId;
    const flat = controller.getState().doc.pages[activePageId].widgetRows.flat();
    const copyId = Object.keys(controller.getState().doc.widgets).find((id) => id !== 'w1');
    expect(flat).toContain(copyId);
  });

  it('places the copy in the same row as the source when the row has space', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.duplicateWidget('w1');
    const activePageId = controller.getState().doc.dashboard.activePageId;
    const { widgetRows } = controller.getState().doc.pages[activePageId];
    const copyId = Object.keys(controller.getState().doc.widgets).find((id) => id !== 'w1')!;
    // Both widgets should be in the same row
    const row = widgetRows.find((r) => r.includes('w1'));
    expect(row).toContain(copyId);
    // Copy should appear right after the source
    expect(row).toEqual(['w1', copyId]);
  });

  it('places the copy in the same row as the source when row has 3 widgets (< MAX_PER_ROW)', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    controller.addWidget(makeWidget('w3'));
    // Manually arrange all 3 in one row
    const activePageId = controller.getState().doc.dashboard.activePageId;
    const state = controller.getState();
    controller.updateState({
      doc: {
        pages: {
          ...state.doc.pages,
          [activePageId]: {
            ...state.doc.pages[activePageId],
            widgetRows: [['w1', 'w2', 'w3']],
          },
        },
      },
    });
    controller.duplicateWidget('w2');
    const newState = controller.getState();
    const copyId = Object.keys(newState.doc.widgets).find(
      (id) => !['w1', 'w2', 'w3'].includes(id),
    )!;
    const { widgetRows } = newState.doc.pages[activePageId];
    expect(widgetRows).toHaveLength(1);
    expect(widgetRows[0]).toEqual(['w1', 'w2', copyId, 'w3']);
  });

  it('places the copy in a new row below when the source row is full (4 widgets)', () => {
    const controller = new StudioController();
    ['w1', 'w2', 'w3', 'w4'].forEach((id) => controller.addWidget(makeWidget(id)));
    const activePageId = controller.getState().doc.dashboard.activePageId;
    const state = controller.getState();
    controller.updateState({
      doc: {
        pages: {
          ...state.doc.pages,
          [activePageId]: {
            ...state.doc.pages[activePageId],
            widgetRows: [['w1', 'w2', 'w3', 'w4']],
          },
        },
      },
    });
    controller.duplicateWidget('w1');
    const newState = controller.getState();
    const copyId = Object.keys(newState.doc.widgets).find(
      (id) => !['w1', 'w2', 'w3', 'w4'].includes(id),
    )!;
    const { widgetRows } = newState.doc.pages[activePageId];
    // Should have 2 rows: the full original row + new row with just the copy
    expect(widgetRows).toHaveLength(2);
    expect(widgetRows[0]).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(widgetRows[1]).toEqual([copyId]);
  });

  it('inserts the new row immediately below the source row (not at the bottom)', () => {
    const controller = new StudioController();
    ['w1', 'w2', 'w3', 'w4', 'w5'].forEach((id) => controller.addWidget(makeWidget(id)));
    const activePageId = controller.getState().doc.dashboard.activePageId;
    const state = controller.getState();
    // Two rows: first full (4 widgets), second with one widget
    controller.updateState({
      doc: {
        pages: {
          ...state.doc.pages,
          [activePageId]: {
            ...state.doc.pages[activePageId],
            widgetRows: [['w1', 'w2', 'w3', 'w4'], ['w5']],
          },
        },
      },
    });
    controller.duplicateWidget('w1'); // duplicate from full first row
    const newState = controller.getState();
    const copyId = Object.keys(newState.doc.widgets).find(
      (id) => !['w1', 'w2', 'w3', 'w4', 'w5'].includes(id),
    )!;
    const { widgetRows } = newState.doc.pages[activePageId];
    // 3 rows: original full row, new copy row, existing second row
    expect(widgetRows).toHaveLength(3);
    expect(widgetRows[0]).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(widgetRows[1]).toEqual([copyId]);
    expect(widgetRows[2]).toEqual(['w5']);
  });

  it('is a no-op for an unknown widgetId', () => {
    const controller = new StudioController();
    controller.duplicateWidget('nonexistent');
    expect(Object.keys(controller.getState().doc.widgets)).toHaveLength(0);
  });
});

// ─── StudioController.moveWidgetToPage ────────────────────────────────────────

describe('StudioController.moveWidgetToPage', () => {
  it('moves a widget from the active page to a target page', () => {
    const controller = new StudioController();
    const sourcePageId = controller.getState().doc.dashboard.activePageId;
    controller.addWidget(makeWidget('w1', { title: 'Revenue' }));
    const targetPageId = controller.addPage('Page 2');
    // addPage switches to the new page; switch back to move from the source
    controller.setActivePage(sourcePageId);

    controller.moveWidgetToPage('w1', targetPageId);
    const state = controller.getState();
    const sourcePage = state.doc.pages[sourcePageId];
    const targetPage = state.doc.pages[targetPageId];
    expect(sourcePage.widgetRows.flat()).not.toContain('w1');
    expect(targetPage.widgetRows.flat()).toContain('w1');
    expect(state.doc.widgets.w1).toBeDefined();
  });

  it('is a no-op when source and target page are the same', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const activePageId = controller.getState().doc.dashboard.activePageId;
    const stateBefore = controller.getState();
    controller.moveWidgetToPage('w1', activePageId);
    expect(controller.getState()).toBe(stateBefore);
  });

  it('preserves widget-scoped filters when moving widget to another page (scope carries only widgetId)', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const sourcePageId = controller.getState().doc.dashboard.activePageId;
    const targetPageId = controller.addPage('Page 2');
    controller.setActivePage(sourcePageId);
    controller.addFilter(makeFilter({ id: 'f1', scope: { kind: 'widget', widgetId: 'w1' } }));
    controller.moveWidgetToPage('w1', targetPageId);
    const filter = controller.getState().doc.filters.find((f) => f.id === 'f1');
    // Widget-scoped filters identify by widgetId only; they have no pageId to re-scope.
    expect(filter?.scope).toEqual({ kind: 'widget', widgetId: 'w1' });
  });

  // Finding 2: hardcoding `sourcePageId = activePageId` would make the source-page rewrite
  // a no-op fold (the widget isn't in the ACTIVE page's rows) while the target page's
  // `setWidgetLayout` still appends it — landing the widget on two pages at once. Resolve
  // the widget's ACTUAL page via `resolveWidgetPageId` instead.
  it('moves the widget from its ACTUAL page, not activePageId, when they differ', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1')); // lives on page-1
    const page1Id = controller.getState().doc.dashboard.activePageId;
    const page2Id = controller.addPage('Page 2');
    controller.addPage('Page 3'); // active page is now page-3; w1 still lives on page-1

    controller.moveWidgetToPage('w1', page2Id);

    const state = controller.getState();
    expect(state.doc.pages[page1Id].widgetRows.flat()).not.toContain('w1');
    expect(state.doc.pages[page2Id].widgetRows.flat()).toContain('w1');
    // The widget must not have landed on both its old and new page.
    const totalPlacements = Object.values(state.doc.pages).filter((p) =>
      p.widgetRows.flat().includes('w1'),
    ).length;
    expect(totalPlacements).toBe(1);
  });
});

// ─── StudioController.insertWidgetAt (compose-drawer drop convergence) ─────────
// The canvas compose-drawer drop branch now composes `addWidget` + `setWidgetLayout`
// through `insertWidgetAt` (one commit, one undo step, one log line) instead of a
// hand-rolled `controller.updateState({ doc: { ... } })`.

describe('StudioController.insertWidgetAt', () => {
  it('inserts a new widget at a horizontal position (new row) and selects it', () => {
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;
    controller.addWidget(makeWidget('a')); // rows: [['a']]

    controller.insertWidgetAt(makeWidget('w1'), pageId, [['w1'], ['a']]);

    const state = controller.getState();
    expect(state.doc.widgets.w1).toBeDefined();
    expect(state.doc.pages[pageId].widgetRows).toEqual([['w1'], ['a']]);
    expect(state.session.shell.selectedWidgetId).toBe('w1');
    // No stray column-span entries introduced by the insert.
    expect(state.doc.pages[pageId].widgetColSpans).toBeUndefined();
  });

  it('inserts a new widget into an existing row (vertical) with no stray spans', () => {
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;
    controller.addWidget(makeWidget('a'));

    controller.insertWidgetAt(makeWidget('w1'), pageId, [['a', 'w1']]);

    const state = controller.getState();
    expect(state.doc.pages[pageId].widgetRows).toEqual([['a', 'w1']]);
    expect(state.doc.pages[pageId].widgetColSpans).toBeUndefined();
    expect(state.session.shell.selectedWidgetId).toBe('w1');
  });

  it('is a whole-fold no-op for a nonexistent pageId (no commit, no undo entry)', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('anchor'); // one real undoable action
    const before = controller.getState();
    const undoBefore = controller.canUndo();

    controller.insertWidgetAt(makeWidget('w1'), 'no-such-page', [['w1']]);

    // Both folded mutations no-op on the unknown page → same state reference, no history.
    expect(controller.getState()).toBe(before);
    expect(controller.canUndo()).toBe(undoBefore);
    expect(controller.getState().doc.widgets.w1).toBeUndefined();
  });

  it('collapses one insert gesture to a single undo step', () => {
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;
    controller.addWidget(makeWidget('a'));
    const rowsBefore = controller.getState().doc.pages[pageId].widgetRows;

    controller.insertWidgetAt(makeWidget('w1'), pageId, [['w1'], ['a']]);
    controller.undo();

    const state = controller.getState();
    expect(state.doc.widgets.w1).toBeUndefined();
    expect(state.doc.pages[pageId].widgetRows).toEqual(rowsBefore);
  });

  it('logs under the addWidget label shape (D12)', () => {
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;

    controller.insertWidgetAt(makeWidget('w1'), pageId, [['w1']]);

    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addWidget:kpi:w1']);
  });
});

// ─── StudioController.moveWidget (canvas drag-and-drop convergence) ────────────
// The canvas canvas-widget drop branch now delegates to `moveWidget`, which folds
// the source/target `setWidgetLayout` mutations into a single commit and selects the
// moved widget. `moveWidgetToPage` (context menu) shares the same `commitWidgetMove`
// core but does not select.

describe('StudioController.moveWidget', () => {
  function twoPageController(
    widgetIds: string[],
    page1Rows: string[][],
    page1Spans?: Record<string, number>,
  ) {
    return new StudioController({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'Page 1',
            widgetRows: page1Rows,
            widgetColSpans: page1Spans,
          },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
        widgets: Object.fromEntries(widgetIds.map((id) => [id, makeWidget(id)])),
      },
    });
  }

  it('collapses a cross-page move to one undo step restoring BOTH pages', () => {
    const controller = twoPageController(['w1', 'w2'], [['w1', 'w2']], { w1: 16, w2: 8 });
    const p1Before = controller.getState().doc.pages['page-1'];
    const p2Before = controller.getState().doc.pages['page-2'];

    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);
    // Sanity: the move actually changed both pages.
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['w2']]);
    expect(controller.getState().doc.pages['page-2'].widgetRows).toEqual([['w1']]);

    controller.undo();
    const state = controller.getState();
    expect(state.doc.pages['page-1']).toEqual(p1Before);
    expect(state.doc.pages['page-2']).toEqual(p2Before);
  });

  it('selects the moved widget (unlike moveWidgetToPage)', () => {
    const controller = twoPageController(['w1', 'w2'], [['w1', 'w2']], { w1: 16, w2: 8 });
    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');
  });

  it('is a whole-fold no-op for an unknown widgetId (no commit, no undo entry)', () => {
    const controller = twoPageController(['w1'], [['w1']]);
    controller.setDashboardTitle('anchor');
    const before = controller.getState();
    const undoBefore = controller.canUndo();

    controller.moveWidget('ghost', 'page-1', 'page-2', [['ghost']]);

    expect(controller.getState()).toBe(before);
    expect(controller.canUndo()).toBe(undoBefore);
  });

  it('is a whole-fold no-op when the target page no longer exists (deleted mid-drag)', () => {
    const controller = twoPageController(['w1', 'w2'], [['w1', 'w2']], { w1: 16, w2: 8 });
    controller.setDashboardTitle('anchor');
    const before = controller.getState();
    const undoBefore = controller.canUndo();

    controller.moveWidget('w1', 'page-1', 'deleted-page', [['w1']]);

    expect(controller.getState()).toBe(before);
    expect(controller.canUndo()).toBe(undoBefore);
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['w1', 'w2']]);
    expect(controller.getState().doc.widgets.w1).toBeDefined();
  });

  it('logs a moveWidget label (D12)', () => {
    const controller = twoPageController(['w1', 'w2'], [['w1', 'w2']], { w1: 16, w2: 8 });
    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['moveWidget:w1']);
  });

  // Finding 2: `moveWidget` (the canvas drag-and-drop entry point) used to trust the
  // drag-start `sourcePageId` verbatim. If a CONCURRENT operation (a different code
  // path, or a second fast action) relocated the SAME widget to a third page while the
  // drag was still in flight, the eventual drop acted on the stale captured page —
  // clearing a page the widget no longer lived on while still appending it to the
  // drop target, duplicating the widget across two pages' `widgetRows`. This mirrors the
  // guard `moveWidgetToPage` already applies via `resolveWidgetPageId`.
  it('re-resolves the widget actual current page at drop time instead of trusting a stale captured sourcePageId', () => {
    // The dev-only staleness warning is the EXPECTED signal this test is exercising
    // (a concurrent move made the drag's captured sourcePageId stale) — silence it
    // here rather than let `vitest-fail-on-console`'s default "no console output"
    // assertion fail the test.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1')); // lives on page-1
    const page1Id = controller.getState().doc.dashboard.activePageId;
    const page2Id = controller.addPage('Page 2');
    const page3Id = controller.addPage('Page 3');

    // Concurrent operation relocates w1 from page-1 to page-3 WHILE a drag that
    // started on page-1 is still in flight (its captured `sourcePageId` is now stale).
    controller.moveWidgetToPage('w1', page3Id);
    expect(controller.getState().doc.pages[page1Id].widgetRows.flat()).not.toContain('w1');
    expect(controller.getState().doc.pages[page3Id].widgetRows.flat()).toContain('w1');

    // The drag's drop handler still believes the widget started on page-1 and drops it
    // onto page-2 — using the STALE captured `sourcePageId` ('page-1').
    controller.moveWidget('w1', page1Id, page2Id, [['w1']]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();

    const state = controller.getState();
    const totalPlacements = Object.values(state.doc.pages).filter((p) =>
      p.widgetRows.flat().includes('w1'),
    ).length;
    // The widget must land on exactly one page (the drop target) — its ACTUAL prior
    // page (page-3) must be cleared, not the stale captured page-1 (which no longer
    // contained it), which would otherwise leave it duplicated on page-2 AND page-3.
    expect(totalPlacements).toBe(1);
    expect(state.doc.pages[page2Id].widgetRows.flat()).toContain('w1');
    expect(state.doc.pages[page3Id].widgetRows.flat()).not.toContain('w1');
  });

  it('drag-drop (moveWidget) and context-menu (moveWidgetToPage) reach the same state bar selection', () => {
    const build = () =>
      new StudioController({
        doc: {
          dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
          pages: {
            'page-1': {
              id: 'page-1',
              title: 'P1',
              widgetRows: [['w1', 'w2']],
              widgetColSpans: { w1: 16, w2: 8 },
            },
            'page-2': { id: 'page-2', title: 'P2', widgetRows: [['x']] },
          },
          widgets: { w1: makeWidget('w1'), w2: makeWidget('w2'), x: makeWidget('x') },
        },
      });

    // moveWidgetToPage appends the widget as a new trailing row on the target page.
    const viaMenu = build();
    viaMenu.moveWidgetToPage('w1', 'page-2');

    // moveWidget is called by the canvas with that same computed target layout.
    const viaDrag = build();
    viaDrag.moveWidget('w1', 'page-1', 'page-2', [['x'], ['w1']]);

    const menuState = viaMenu.getState();
    const dragState = viaDrag.getState();
    expect(dragState.doc.pages).toEqual(menuState.doc.pages);
    expect(dragState.doc.widgets).toEqual(menuState.doc.widgets);
    expect(dragState.doc.filters).toEqual(menuState.doc.filters);
    // The only intended divergence: the drag path selects the moved widget.
    expect(dragState.session.shell.selectedWidgetId).toBe('w1');
    expect(menuState.session.shell.selectedWidgetId).toBeNull();
  });
});

// ─── 2.2: cross-page widget move must not land TWO rank filters on one page ────
// Sibling of the iter-9 `duplicateWidget` rank-uniqueness fix, missed on the move paths.
// Moving a widget carrying a widget-scoped rank (Top-N) filter onto a page whose context
// already holds a rank filter would otherwise produce the forbidden "two rank filters on
// one page" state every other writer (`addFilter`/`updateFilter`/`duplicateWidget`) guards.
describe('StudioController move — rank-filter uniqueness (2.2)', () => {
  function twoPageRankController(page2Filter: StudioFilterState) {
    return new StudioController({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [['w2']] },
        },
        widgets: { w1: makeWidget('w1'), w2: makeWidget('w2') },
        filters: [
          // w1 carries a widget-scoped rank filter (resolves to page-1 while w1 lives there).
          makeFilter({
            id: 'w1-rank',
            filterMode: 'rank',
            rankDirection: 'top',
            value: 5,
            scope: { kind: 'widget', widgetId: 'w1' },
          }),
          page2Filter,
        ],
      },
    });
  }

  it('moveWidgetToPage drops the moved widget rank filter when the target page already has a page-scoped rank filter', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = twoPageRankController(
      makeFilter({
        id: 'p2-rank',
        filterMode: 'rank',
        rankDirection: 'top',
        value: 10,
        scope: { kind: 'page', pageId: 'page-2' },
      }),
    );

    controller.moveWidgetToPage('w1', 'page-2');

    const state = controller.getState();
    expect(state.doc.pages['page-2'].widgetRows.flat()).toContain('w1');
    // The conflicting moved rank filter was dropped; the page-2 rank filter survives.
    expect(state.doc.filters.find((f) => f.id === 'w1-rank')).toBeUndefined();
    expect(state.doc.filters.find((f) => f.id === 'p2-rank')).toBeTruthy();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('moveWidget (canvas drag) drops the moved widget rank filter when the target page has a conflicting widget rank filter', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = twoPageRankController(
      makeFilter({
        id: 'w2-rank',
        filterMode: 'rank',
        rankDirection: 'top',
        value: 10,
        scope: { kind: 'widget', widgetId: 'w2' },
      }),
    );

    controller.moveWidget('w1', 'page-1', 'page-2', [['w2'], ['w1']]);

    const state = controller.getState();
    expect(state.doc.pages['page-2'].widgetRows.flat()).toContain('w1');
    // w2's rank filter (already on page-2) survives; w1's incoming rank filter is dropped.
    expect(state.doc.filters.find((f) => f.id === 'w2-rank')).toBeTruthy();
    expect(state.doc.filters.find((f) => f.id === 'w1-rank')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('moveWidgetToPage keeps the moved widget rank filter when the target page has no rank filter', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = twoPageRankController(
      // page-2 has only a plain condition filter — no rank conflict.
      makeFilter({
        id: 'p2-cond',
        filterMode: 'condition',
        scope: { kind: 'page', pageId: 'page-2' },
      }),
    );

    controller.moveWidgetToPage('w1', 'page-2');

    const state = controller.getState();
    // No conflict → the widget-scoped rank filter follows its widget, unchanged.
    expect(state.doc.filters.find((f) => f.id === 'w1-rank')).toBeTruthy();
    expect(state.doc.filters.find((f) => f.id === 'w1-rank')!.scope).toEqual({
      kind: 'widget',
      widgetId: 'w1',
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── StudioController.commitWidgetMove — emitted-scope cleanup (T1.1) ─────────
// A cross-page move must also drop any filter the moved widget EMITS whose scope is pinned
// to the source page (interactive / cross-filter), otherwise the old page stays hard-filtered
// with no controlling widget while the moved control advertises a selection that filters nothing.

describe('StudioController.commitWidgetMove — emitted-scope cleanup (T1.1)', () => {
  function twoPageWithFilters(filters: StudioFilterState[]) {
    return new StudioController({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
        widgets: { w1: makeWidget('w1') },
        filters,
      },
    });
  }

  it('drops an interactive filter the moved widget emits (moveWidget / canvas drag)', () => {
    const controller = twoPageWithFilters([
      makeFilter({
        id: 'i1',
        scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
      }),
    ]);
    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);
    expect(controller.getState().doc.filters.find((f) => f.id === 'i1')).toBeUndefined();
  });

  it('drops a cross-filter the moved widget emits (moveWidgetToPage / context menu)', () => {
    const controller = twoPageWithFilters([
      makeFilter({
        id: 'x1',
        scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
      }),
    ]);
    controller.moveWidgetToPage('w1', 'page-2');
    expect(controller.getState().doc.filters.find((f) => f.id === 'x1')).toBeUndefined();
  });

  it("leaves another widget's emitted filters untouched", () => {
    const controller = twoPageWithFilters([
      makeFilter({
        id: 'i-other',
        scope: { kind: 'interactive', sourceWidgetId: 'w-other', pageId: 'page-1' },
      }),
    ]);
    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);
    expect(controller.getState().doc.filters.find((f) => f.id === 'i-other')).toBeTruthy();
  });

  it('does not touch emitted filters on a same-page move', () => {
    const controller = twoPageWithFilters([
      makeFilter({
        id: 'i1',
        scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
      }),
    ]);
    controller.moveWidget('w1', 'page-1', 'page-1', [['w1']]);
    expect(controller.getState().doc.filters.find((f) => f.id === 'i1')).toBeTruthy();
  });

  it('folds the cross-filter cleanup into the SAME commit — one undo restores it (undoable by design)', () => {
    const controller = twoPageWithFilters([
      makeFilter({
        id: 'x1',
        scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
      }),
    ]);
    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);
    expect(controller.getState().doc.filters.find((f) => f.id === 'x1')).toBeUndefined();
    controller.undo();
    const state = controller.getState();
    // One undo step restores BOTH the source-page layout and the cross-filter (cross-filters
    // are NOT transient-carried, so they time-travel with the doc).
    expect(state.doc.pages['page-1'].widgetRows.flat()).toContain('w1');
    expect(state.doc.filters.find((f) => f.id === 'x1')).toBeTruthy();
  });

  it('carryTransientDocState never resurrects the removed interactive entry after undo', () => {
    const controller = twoPageWithFilters([
      makeFilter({
        id: 'i1',
        scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
      }),
    ]);
    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);
    expect(controller.getState().doc.filters.find((f) => f.id === 'i1')).toBeUndefined();
    controller.undo();
    const state = controller.getState();
    // The layout is restored, but the interactive selection is transient-carried from the CURRENT
    // (now empty) set, so undo must NOT bring back a filter the move deliberately cleared.
    expect(state.doc.pages['page-1'].widgetRows.flat()).toContain('w1');
    expect(state.doc.filters.find((f) => f.id === 'i1')).toBeUndefined();
  });

  // Finding 1: a carried interactive filter's `scope.pageId` must be RE-DERIVED against
  // the emitting widget's actual page in the doc being swapped in, not blindly kept at
  // whatever page it was scoped to just before the undo/redo. Sequence: move a filter
  // widget to page-2, make a selection there (stamping `scope.pageId: 'page-2'` via
  // `resolveWidgetPageId`), then undo the move — the widget goes back to page-1, and the
  // carried filter must follow it there instead of keeping the stale `pageId: 'page-2'`.
  it('re-derives a carried interactive filter scope.pageId against the widget ACTUAL page after undoing a move', () => {
    const controller = twoPageWithFilters([]);

    // Move the filter widget from page-1 to page-2 — an undoable step.
    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);
    expect(controller.getState().doc.pages['page-2'].widgetRows.flat()).toContain('w1');

    // Make a selection on the widget's NEW page. This commits NON-undoably (transient
    // interactive state), stamped with the widget's current page (page-2).
    controller.applyInteractiveFilter('w1', 'category', 'in', ['Books']);
    const beforeUndo = controller
      .getState()
      .doc.filters.find((f) => f.scope.kind === 'interactive' && f.scope.sourceWidgetId === 'w1');
    expect(beforeUndo?.scope).toMatchObject({ pageId: 'page-2' });

    // Undo the move: the widget goes back to page-1. The interactive selection has no
    // undo entry of its own (it is transient-carried forward by `carryTransientDocState`),
    // so it survives the undo — but its `scope.pageId` must now reflect page-1, the
    // widget's page in the RESTORED doc, not the stale page-2 it carried before.
    controller.undo();

    const state = controller.getState();
    expect(state.doc.pages['page-1'].widgetRows.flat()).toContain('w1');
    expect(state.doc.pages['page-2'].widgetRows.flat()).not.toContain('w1');

    const afterUndo = state.doc.filters.find(
      (f) => f.scope.kind === 'interactive' && f.scope.sourceWidgetId === 'w1',
    );
    expect(afterUndo?.scope).toMatchObject({ pageId: 'page-1' });
  });
});

// ─── StudioController — filter CRUD ──────────────────────────────────────────

describe('StudioController.addFilter / removeFilter', () => {
  it('addFilter appends a filter to the list', () => {
    const controller = new StudioController();
    controller.addFilter(makeFilter({ id: 'f1' }));
    expect(controller.getState().doc.filters).toHaveLength(1);
    expect(controller.getState().doc.filters[0].id).toBe('f1');
  });

  it('addFilter preserves existing filters', () => {
    const controller = new StudioController({ doc: { filters: [makeFilter({ id: 'f1' })] } });
    controller.addFilter(makeFilter({ id: 'f2' }));
    expect(controller.getState().doc.filters).toHaveLength(2);
  });

  it('removeFilter removes only the matching filter', () => {
    const controller = new StudioController({
      doc: { filters: [makeFilter({ id: 'f1' }), makeFilter({ id: 'f2' })] },
    });
    controller.removeFilter('f1');
    expect(controller.getState().doc.filters.map((f) => f.id)).toEqual(['f2']);
  });

  it('removeFilter is a no-op for an unknown id', () => {
    const controller = new StudioController({ doc: { filters: [makeFilter({ id: 'f1' })] } });
    controller.removeFilter('nonexistent');
    expect(controller.getState().doc.filters).toHaveLength(1);
  });
});

describe('StudioController.clearAllCrossFilters', () => {
  it('removes all cross-filter scoped entries', () => {
    const controller = new StudioController({
      doc: {
        filters: [
          makeFilter({ id: 'page-f', scope: { kind: 'page' } }),
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
          }),
          makeFilter({
            id: 'cf2',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: 'page-1' },
          }),
        ],
      },
    });
    controller.clearAllCrossFilters();
    expect(
      controller.getState().doc.filters.filter((f) => f.scope.kind === 'cross-filter'),
    ).toHaveLength(0);
  });

  it('preserves page-scoped and widget-scoped filters', () => {
    const controller = new StudioController({
      doc: {
        filters: [
          makeFilter({ id: 'page-f', scope: { kind: 'page' } }),
          makeFilter({ id: 'widget-f', scope: { kind: 'widget', widgetId: 'w1' } }),
          makeFilter({
            id: 'cf1',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
          }),
        ],
      },
    });
    controller.clearAllCrossFilters();
    const ids = controller.getState().doc.filters.map((f) => f.id);
    expect(ids).toContain('page-f');
    expect(ids).toContain('widget-f');
  });
});

// ─── StudioController — expression field CRUD ────────────────────────────────

describe('StudioController expression fields', () => {
  const ef = {
    id: 'ef1',
    label: 'Margin',
    expression: { operator: 'subtract' as const, inputs: [{ id: 'revenue' }, { id: 'cost' }] },
    sourceId: 'orders',
    type: 'number' as const,
    isMeasure: false,
  };

  it('addExpressionField appends a new field', () => {
    const controller = new StudioController();
    controller.addExpressionField(ef);
    expect(controller.getState().doc.expressionFields).toHaveLength(1);
    expect(controller.getState().doc.expressionFields[0].id).toBe('ef1');
  });

  it('addExpressionField is a no-op when the id already exists', () => {
    const controller = new StudioController({ doc: { expressionFields: [ef] } });
    controller.addExpressionField({ ...ef, label: 'Different' });
    expect(controller.getState().doc.expressionFields).toHaveLength(1);
    expect(controller.getState().doc.expressionFields[0].label).toBe('Margin');
  });

  it('updateExpressionField merges partial changes', () => {
    const controller = new StudioController({ doc: { expressionFields: [ef] } });
    controller.updateExpressionField('ef1', { label: 'Profit Margin' });
    expect(controller.getState().doc.expressionFields[0].label).toBe('Profit Margin');
    expect(controller.getState().doc.expressionFields[0].expression).toEqual(ef.expression);
  });

  it('updateExpressionField is a no-op for unknown id', () => {
    const controller = new StudioController({ doc: { expressionFields: [ef] } });
    controller.updateExpressionField('nonexistent', { label: 'X' });
    expect(controller.getState().doc.expressionFields[0].label).toBe('Margin');
  });

  it('removeExpressionField removes the matching field', () => {
    const ef2 = { ...ef, id: 'ef2', label: 'Other' };
    const controller = new StudioController({ doc: { expressionFields: [ef, ef2] } });
    controller.removeExpressionField('ef1');
    expect(controller.getState().doc.expressionFields.map((field) => field.id)).toEqual(['ef2']);
  });

  // Finding 2.14: deleting a calculated field used to silently strand every widget / filter /
  // expression that referenced it. The controller now surfaces a reference count so the caller
  // can confirm (or a future UI pass can gate) the deletion.
  it('getExpressionFieldReferenceCount counts referencing widgets, filters, and expressions', () => {
    const efUser = {
      ...ef,
      id: 'ef2',
      label: 'Uses margin',
      expression: { operator: 'add' as const, inputs: [{ id: 'ef1' }, { id: 'cost' }] },
    };
    const controller = new StudioController({
      doc: {
        expressionFields: [ef, efUser],
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            // `title` is required — the canvas card reads it with no fallback, so the doc
            // screen drops a title-less widget. Without it this widget never entered the
            // doc and its `xField` reference went uncounted.
            title: 'W1',
            sourceId: 'orders',
            config: { chartType: 'bar', xField: 'ef1' },
          } as never,
        },
        filters: [
          {
            id: 'flt',
            field: 'ef1',
            operator: 'greater_than',
            value: '5',
            scope: { kind: 'page' },
          } as never,
        ],
      },
    });
    // widget xField + filter field + sibling expression input → 3 references.
    expect(controller.getExpressionFieldReferenceCount('ef1')).toBe(3);
    // The unreferenced sibling reports 0.
    expect(controller.getExpressionFieldReferenceCount('ef2')).toBe(0);
    // An unknown id reports 0.
    expect(controller.getExpressionFieldReferenceCount('nope')).toBe(0);
  });

  // Tier-3 finding: a rank filter references an expression field not only via `field`
  // (the ranked dimension) but also via `rankByField` (the numeric measure a dimension is
  // ranked *by*) and `rankMultiSeriesBy` (the specific series a multi-series rank scores by).
  // Deleting a measure used ONLY as a rank's sort key previously reported 0 references,
  // silently stranding the rank filter.
  it('getExpressionFieldReferenceCount counts rankByField and rankMultiSeriesBy references', () => {
    // The two rank filters are anchored to DIFFERENT pages on purpose. Rank uniqueness is
    // per-page and `createDefaultStudioState` now enforces it over `initialState` (as the
    // reducer and the load boundary already did), so two pageId-less `page` scopes — both
    // resolving to the "applies everywhere" wildcard — would conflict and the second would
    // legitimately be dropped before this count ever ran.
    const controller = new StudioController({
      doc: {
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
        expressionFields: [ef],
        filters: [
          {
            id: 'rankBy',
            field: 'country',
            filterMode: 'rank',
            operator: 'equals',
            value: '',
            rankDirection: 'top',
            rankByField: 'ef1',
            scope: { kind: 'page', pageId: 'page-1' },
          } as never,
          {
            id: 'rankSeries',
            field: 'country',
            filterMode: 'rank',
            operator: 'equals',
            value: '',
            rankDirection: 'top',
            rankMultiSeriesBy: 'ef1',
            scope: { kind: 'page', pageId: 'page-2' },
          } as never,
        ],
      },
    });
    // ef1 is referenced by `rankByField` in one filter and `rankMultiSeriesBy` in another → 2.
    expect(controller.getExpressionFieldReferenceCount('ef1')).toBe(2);
  });

  it('removeExpressionField still deletes a referenced field and returns the reference count', () => {
    const controller = new StudioController({
      doc: {
        expressionFields: [ef],
        filters: [
          {
            id: 'flt',
            field: 'ef1',
            operator: 'greater_than',
            value: '5',
            scope: { kind: 'page' },
          } as never,
        ],
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const count = controller.removeExpressionField('ef1');
    warnSpy.mockRestore();
    // Guard-and-continue: the field is removed even though a filter still references it...
    expect(controller.getState().doc.expressionFields).toHaveLength(0);
    // ...and the reference count is surfaced to the caller.
    expect(count).toBe(1);
  });
});

// ─── StudioController — undo / redo ──────────────────────────────────────────

describe('StudioController undo/redo', () => {
  it('canUndo returns false before any undoable action', () => {
    const controller = new StudioController();
    expect(controller.canUndo()).toBe(false);
  });

  it('canUndo returns true after an undoable action', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('New Title');
    expect(controller.canUndo()).toBe(true);
  });

  it('undo restores the previous state', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Step 1');
    controller.setDashboardTitle('Step 2');
    controller.undo();
    expect(controller.getState().doc.dashboard.title).toBe('Step 1');
  });

  it('undo returns false when there is nothing to undo', () => {
    const controller = new StudioController();
    expect(controller.undo()).toBe(false);
  });

  it('undo makes redo available', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('New Title');
    controller.undo();
    expect(controller.canRedo()).toBe(true);
  });

  it('redo re-applies the undone change', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('New Title');
    controller.undo();
    controller.redo();
    expect(controller.getState().doc.dashboard.title).toBe('New Title');
  });

  it('redo returns false when there is nothing to redo', () => {
    const controller = new StudioController();
    expect(controller.redo()).toBe(false);
  });

  it('a new undoable action clears the redo stack', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('A');
    controller.undo();
    // redo stack has one entry; now take a new action
    controller.setDashboardTitle('B');
    expect(controller.canRedo()).toBe(false);
  });

  it('non-undoable actions (setSelectedWidget) do not push to the undo stack', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const undoDepth = controller.canUndo();
    controller.setSelectedWidget('w1');
    // Undo state should be the same as before setSelectedWidget
    expect(controller.canUndo()).toBe(undoDepth);
  });

  it('upsertDataSource does not push an undo entry (host data injection is not undoable)', () => {
    const controller = new StudioController();

    // Host injects data (e.g. a periodic refresh / config-swap reload) with no prior
    // authored edit. This must NOT create an undo entry — otherwise a stray Ctrl+Z would
    // wipe freshly loaded data the user never authored.
    controller.upsertDataSource({
      id: 'src1',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [{ amount: 1 }],
    });

    expect(controller.canUndo()).toBe(false);
    expect(controller.undo()).toBe(false);
    expect(controller.getState().runtime.dataSources.src1.rows).toHaveLength(1);
  });

  it('setDataSourceRows does not push an undo entry (host data refresh is not undoable)', () => {
    const controller = new StudioController({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Orders',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: [{ amount: 1 }],
          },
        },
      },
    });

    // Host pushes fresh rows into the live source — infrastructure, not an authored edit.
    controller.setDataSourceRows('src1', [{ amount: 2 }, { amount: 3 }]);

    expect(controller.canUndo()).toBe(false);
    expect(controller.undo()).toBe(false);
    expect(controller.getState().runtime.dataSources.src1.rows).toHaveLength(2);
  });

  it('a data injection between authored edits adds no extra undo step', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Step 1'); // the only undoable action

    // A host data refresh lands between authored edits — it must not become its own step.
    controller.upsertDataSource({
      id: 'src1',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [{ amount: 1 }],
    });

    // Exactly one authored change is on the stack: one undo empties it. If the injection
    // had been undoable, `canUndo()` would still be true here.
    expect(controller.undo()).toBe(true);
    expect(controller.canUndo()).toBe(false);
  });

  it('caps undo history at MAX_UNDO_HISTORY (100)', () => {
    const controller = new StudioController();
    for (let i = 0; i < 101; i += 1) {
      controller.setDashboardTitle(`Title ${i}`);
    }
    // After 101 actions, the stack should be at most 100 deep
    let undoCount = 0;
    while (controller.canUndo()) {
      controller.undo();
      undoCount += 1;
      if (undoCount > 110) {
        break;
      } // safety guard
    }
    expect(undoCount).toBe(100);
  });

  // ── lifetime-partition guarantees ──────────────────────────────────────────
  // The core reason for the doc/session/runtime split: undo time-travels ONLY the
  // doc, so a Ctrl+Z can never revert freshly-injected live data (runtime) or the
  // current view mode / drawer state (session).

  it('undo never reverts runtime or session', () => {
    const controller = new StudioController({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Orders',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: [{ amount: 1 }],
          },
        },
      },
    });
    // One authored (doc) edit — the thing undo should revert.
    controller.addWidget(makeWidget('w1'));

    // Then a runtime refresh and session changes land AFTER it. `clearSelection` drops
    // the auto-selection of w1 so the undo below has no dangling selection to normalize
    // — isolating the "undo doesn't even reconstruct session/runtime" guarantee.
    controller.setDataSourceRows('src1', [{ amount: 2 }, { amount: 3 }]);
    controller.setMode('view');
    controller.clearSelection();
    const sessionBefore = controller.getState().session;
    const runtimeBefore = controller.getState().runtime;

    controller.undo();

    const after = controller.getState();
    // The doc edit is reverted...
    expect(after.doc.widgets.w1).toBeUndefined();
    // ...but the fresh rows and the view mode survive, and neither partition was even
    // reconstructed (same object references — undo didn't touch them at all).
    expect(after.runtime.dataSources.src1.rows).toHaveLength(2);
    expect(after.session.mode).toBe('view');
    expect(after.session).toBe(sessionBefore);
    expect(after.runtime).toBe(runtimeBefore);
  });

  it('undo normalizes a dangling widget selection', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1')); // adds + selects w1
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');

    // Undo the mutation that created w1: the reverted doc no longer contains it, so the
    // now-dangling selection must be nulled out.
    controller.undo();
    expect(controller.getState().doc.widgets.w1).toBeUndefined();
    expect(controller.getState().session.shell.selectedWidgetId).toBeNull();
  });

  it('session round-trip preserves undo/redo history and the present mode', () => {
    const source = new StudioController({ session: { mode: 'view' } });
    source.setDashboardTitle('Step 1');
    source.setDashboardTitle('Step 2');
    source.undo(); // present = "Step 1"; redo holds "Step 2"

    const restored = new StudioController();
    restored.restoreSession(source.serializeSession());

    expect(restored.getState().session.mode).toBe('view');
    expect(restored.getState().doc.dashboard.title).toBe('Step 1');
    expect(restored.canUndo()).toBe(true);
    expect(restored.canRedo()).toBe(true);
    restored.redo();
    expect(restored.getState().doc.dashboard.title).toBe('Step 2');
    restored.undo();
    expect(restored.getState().doc.dashboard.title).toBe('Step 1');
  });
});

// ─── StudioController — misc ──────────────────────────────────────────────────

describe('StudioController.setDashboardTitle', () => {
  it('updates the dashboard title', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Quarterly Report');
    expect(controller.getState().doc.dashboard.title).toBe('Quarterly Report');
  });
});

describe('StudioController.setActivePage', () => {
  it('changes the active page id', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
      },
    });
    controller.setActivePage('page-2');
    expect(controller.getState().doc.dashboard.activePageId).toBe('page-2');
  });

  it('is a no-op when the page is already active', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
      },
    });
    controller.setActivePage('page-1');
    // Should not push to undo stack or change state
    expect(controller.canUndo()).toBe(false);
  });

  it('is a no-op for an unknown page id', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
      },
    });
    controller.setActivePage('nonexistent');
    expect(controller.getState().doc.dashboard.activePageId).toBe('page-1');
  });

  it('stamps the cross-filter with the active page id', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
        // Present in `doc.widgets` (satisfies the existence guard — finding 1) but not
        // placed on any page, so `resolveWidgetPageId` falls back to `activePageId`.
        widgets: { 'widget-a': makeWidget('widget-a') },
      },
    });
    controller.applyCrossFilter('widget-a', 'country', 'Germany');
    const cf = controller.getState().doc.filters.find((f) => f.scope.kind === 'cross-filter');
    expect(cf?.scope.kind === 'cross-filter' ? cf.scope.pageId : undefined).toBe('page-1');
  });

  it('preserves cross-filters when navigating to a different page', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
        widgets: { 'widget-a': makeWidget('widget-a') },
      },
    });
    controller.applyCrossFilter('widget-a', 'country', 'Germany');
    controller.setActivePage('page-2');
    // Cross-filter remains in state (page-scoped by pageId, not removed)
    expect(
      controller
        .getState()
        .doc.filters.some((f) => f.scope.kind === 'cross-filter' && f.scope.pageId === 'page-1'),
    ).toBe(true);
  });
});

// AI-driven wire mutations reach the controller through `applyExternalMutation` (default
// `undoable: true`). But `setActivePage` (`dashboard.activePageId`) and `renameAIThread`
// (`doc.ai`) touch ONLY transient-carried doc fields — `carryTransientDocState` overlays the
// current value back onto any undo/redo swap, so an undo entry pushed for them can never
// actually revert anything, yet the commit would still clear the redo stack. These mutations
// must therefore be committed non-undoably from the wire path too (2.1).
describe('StudioController.applyExternalMutation — transient-only wire mutations (2.1)', () => {
  it('applyExternalMutation setActivePage does not push an undo entry or clear the redo stack', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
      },
    });
    // Set up a pending redo entry via a real authored edit.
    controller.setDashboardTitle('Edited');
    controller.undo();
    expect(controller.canRedo()).toBe(true);

    // An AI-driven page navigation must NOT push a dead undo entry or destroy the redo stack.
    controller.applyExternalMutation({ type: 'setActivePage', args: { pageId: 'page-2' } });
    expect(controller.getState().doc.dashboard.activePageId).toBe('page-2');
    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(true);

    // The redo still works and lands on the authored edit, unaffected by the navigation.
    controller.redo();
    expect(controller.getState().doc.dashboard.title).toBe('Edited');
  });

  it('applyExternalMutation renameAIThread does not push an undo entry or clear the redo stack', () => {
    const controller = new StudioController({
      doc: {
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old name', createdAt: '2020-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      },
    });
    // Set up a pending redo entry via a real authored edit.
    controller.setDashboardTitle('Edited');
    controller.undo();
    expect(controller.canRedo()).toBe(true);

    // An AI-driven thread rename must NOT push a dead undo entry or destroy the redo stack.
    controller.applyExternalMutation({
      type: 'renameAIThread',
      args: { name: 'New name', updatedAt: '2020-02-02T00:00:00.000Z', threadId: 't1' },
    });
    expect(controller.getState().doc.ai?.threads[0].name).toBe('New name');
    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(true);

    controller.redo();
    expect(controller.getState().doc.dashboard.title).toBe('Edited');
  });

  // T3.3: the dead-undo special-case used to hardcode mutation TYPES
  // (`setActivePage`/`renameAIThread`). The reducer's `addPage`-for-an-existing-id
  // branch produces the exact same shape of diff (`dashboard.activePageId` only) through
  // a DIFFERENT mutation type, so a re-delivered AI `addPage` slipped through the
  // type-based check and committed undoably — pushing a dead undo entry (it can never
  // revert anything; `carryTransientDocState` re-overlays `activePageId` on every
  // undo/redo swap) that still cleared the redo stack. Classifying by the actual
  // resulting doc diff catches this mutation TYPE too, without hardcoding it by name.
  it('applyExternalMutation addPage for an existing id (re-delivery) does not push an undo entry or clear the redo stack', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
      },
    });
    // Set up a pending redo entry via a real authored edit.
    controller.setDashboardTitle('Edited');
    controller.undo();
    expect(controller.canRedo()).toBe(true);

    // Re-delivery of an `addPage` SSE event for a page that already exists — the reducer
    // only re-activates it (`dashboard.activePageId`), matching a fresh `addPage`'s
    // idempotent branch. It must NOT push a dead undo entry or destroy the redo stack.
    controller.applyExternalMutation({
      type: 'addPage',
      args: { id: 'page-2', title: 'Page 2' },
    });
    expect(controller.getState().doc.dashboard.activePageId).toBe('page-2');
    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(true);

    controller.redo();
    expect(controller.getState().doc.dashboard.title).toBe('Edited');
  });

  // The mirror image of the three cases above, and the one that actually bounds
  // `isTransientOnlyDocDiff`: a wire-driven WIDGET edit changes only `doc.widgets`, so every
  // other term of the classifier stays reference-equal. Drop the `widgets` term and a real
  // `updateWidget` classifies as transient-only — it then pushes NO undo entry (the edit
  // becomes unrevertable) AND leaves a pending redo standing, so the next `redo()` replays an
  // older doc straight over the AI's change.
  it('applyExternalMutation updateWidget is a REAL edit: undoable, and it clears the pending redo', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1', { config: { kpiAggregation: 'sum' } }));
    controller.setDashboardTitle('Edited');
    controller.undo(); // leaves a pending redo holding the 'Edited' title
    expect(controller.canRedo()).toBe(true);

    controller.applyExternalMutation({
      type: 'updateWidget',
      args: { widgetId: 'w1', config: { kpiAggregation: 'avg' } },
    });
    expect(controller.getState().doc.widgets.w1.config).toMatchObject({ kpiAggregation: 'avg' });

    // A widget edit invalidates the pending redo…
    expect(controller.canRedo()).toBe(false);
    // …and is itself revertable.
    expect(controller.canUndo()).toBe(true);
    controller.undo();
    expect(controller.getState().doc.widgets.w1.config).toMatchObject({ kpiAggregation: 'sum' });
  });

  // A GENUINE addPage (a new id) is a real authored edit and must remain undoable.
  it('applyExternalMutation addPage for a NEW id still pushes an undoable entry', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
        },
      },
    });

    controller.applyExternalMutation({
      type: 'addPage',
      args: { id: 'page-2', title: 'Page 2' },
    });
    expect(controller.getState().doc.pages['page-2']).toBeDefined();
    expect(controller.canUndo()).toBe(true);
    controller.undo();
    expect(controller.getState().doc.pages['page-2']).toBeUndefined();
  });
});

describe('StudioController.loadSerializedState', () => {
  it('replaces the dashboard title from the serialized state', () => {
    const source = new StudioController();
    source.setDashboardTitle('Saved Dashboard');
    const serialized = source.serializeState();

    const target = new StudioController();
    target.setDashboardTitle('Old Title');
    target.loadSerializedState(serialized);

    expect(target.getState().doc.dashboard.title).toBe('Saved Dashboard');
  });

  it('preserves the host dataSources after load', () => {
    const ds = { orders: { id: 'orders', label: 'Orders', fields: [], rows: [] } };
    const controller = new StudioController();
    controller.upsertDataSource(ds.orders);
    const serialized = controller.serializeState();

    // Load into a controller that has a different data source
    const target = new StudioController();
    const liveDs = { live: { id: 'live', label: 'Live', fields: [], rows: [] } };
    target.upsertDataSource(liveDs.live);
    target.loadSerializedState(serialized);

    // The live data source should be preserved
    expect(target.getState().runtime.dataSources.live).toBeDefined();
  });

  it('resets undo/redo history after a successful load', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('A');
    controller.setDashboardTitle('B');

    const serialized = controller.serializeState();
    controller.loadSerializedState(serialized);

    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(false);
  });

  it('returns a failed migration result for invalid input', () => {
    const controller = new StudioController();
    const result = controller.loadSerializedState('not-an-object');
    expect(result.success).toBe(false);
    expect(controller.getState().doc.dashboard.title).toBe('Untitled Dashboard'); // unchanged
  });

  // `deserializeState` hardcodes `session.mode: 'edit'` (session is never persisted, so it
  // has no mode to restore). `loadSerializedState` used to commit that session verbatim, so
  // swapping the doc silently promoted a read-only embed to edit mode — cards became
  // draggable, resize handles mounted, `shouldHide` stopped being consulted, and a viewer's
  // grid header click started writing `gridSortField` into the persisted authored doc.
  // Mode lives in the non-persisted `session` partition, so a doc swap must carry it
  // forward untouched, exactly like `undo`/`redo` do.
  it('preserves the current session mode across a load (view stays view)', () => {
    const controller = new StudioController();
    controller.setMode('view');
    const serialized = controller.serializeState();

    controller.loadSerializedState(serialized);

    expect(controller.getState().session.mode).toBe('view');
  });

  it('preserves edit mode across a load too', () => {
    const controller = new StudioController();
    controller.setMode('edit');
    const serialized = controller.serializeState();

    controller.loadSerializedState(serialized);

    expect(controller.getState().session.mode).toBe('edit');
  });
});

describe('StudioController.getRecentMutations', () => {
  it('starts empty', () => {
    const controller = new StudioController();
    expect(controller.getRecentMutations()).toEqual([]);
  });

  it('records labeled mutations oldest-first', () => {
    const controller = new StudioController();
    controller.addFilter(makeFilter({ id: 'a', field: 'revenue' }));
    controller.addFilter(makeFilter({ id: 'b', field: 'region' }));
    controller.removeFilter('a');

    const log = controller.getRecentMutations();
    expect(log.map((m) => m.label)).toEqual([
      'addFilter:revenue',
      'addFilter:region',
      'removeFilter:a',
    ]);
    expect(typeof log[0].at).toBe('string');
    expect(Number.isNaN(Date.parse(log[0].at))).toBe(false);
  });

  it('does not record non-undoable navigation (setActivePage)', () => {
    const controller = new StudioController({
      doc: {
        pages: {
          'page-1': { id: 'page-1', title: 'One', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Two', widgetRows: [] },
        },
        dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
      },
    });
    controller.setActivePage('page-2');
    expect(controller.getRecentMutations()).toEqual([]);
  });

  it('caps the log at 20 entries, keeping the newest', () => {
    const controller = new StudioController();
    for (let i = 0; i < 25; i += 1) {
      controller.addFilter(makeFilter({ id: `f-${i}`, field: `field-${i}` }));
    }
    const log = controller.getRecentMutations();
    expect(log).toHaveLength(20);
    expect(log[0].label).toBe('addFilter:field-5');
    expect(log[19].label).toBe('addFilter:field-24');
  });

  it('returns a defensive copy', () => {
    const controller = new StudioController();
    controller.addFilter(makeFilter({ id: 'a', field: 'revenue' }));
    const log = controller.getRecentMutations();
    log.push({ label: 'tampered', at: 'now' });
    expect(controller.getRecentMutations()).toHaveLength(1);
  });

  // Finding 6: `undo`/`redo` bypass `commitState` and previously never touched
  // `mutationLog`, so the AI-surfaced `get_recent_changes` log kept describing
  // mutations the user had since undone.
  it('removes the corresponding log entry when its mutation is undone', () => {
    const controller = new StudioController();
    controller.addFilter(makeFilter({ id: 'a', field: 'revenue' }));
    controller.addFilter(makeFilter({ id: 'b', field: 'region' }));
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'addFilter:revenue',
      'addFilter:region',
    ]);

    controller.undo(); // reverts the addFilter:region step

    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addFilter:revenue']);
  });

  it('restores the log entry when the undone mutation is redone', () => {
    const controller = new StudioController();
    controller.addFilter(makeFilter({ id: 'a', field: 'revenue' }));
    controller.addFilter(makeFilter({ id: 'b', field: 'region' }));

    controller.undo();
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addFilter:revenue']);

    controller.redo();
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'addFilter:revenue',
      'addFilter:region',
    ]);
  });

  // Finding 3: `redo()` used to blindly re-append the restored entry at the TAIL of
  // `mutationLog`, breaking the oldest-first ordering `getRecentMutations()` promises. A
  // non-undoable but LABELED commit (e.g. `applyExternalMutation`'s `setActivePage`) can
  // land strictly between an undo and its later redo WITHOUT clearing the redo stack
  // (only an UNDOABLE commit does that) — so by the time the older entry is restored, a
  // genuinely more recent entry may already sit at the tail. Every log entry carries the
  // `at` timestamp it was stamped with at ORIGINAL commit time (never touched by
  // undo/redo), so the fix re-inserts in ascending-`at` order instead of assuming
  // "just redone == newest".
  it('redo re-inserts the restored entry at its correct chronological position, not always at the tail', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
      },
    });
    controller.addFilter(makeFilter({ id: 'a', field: 'revenue' }));
    controller.addFilter(makeFilter({ id: 'b', field: 'region' }));

    controller.undo(); // undoes addFilter:region; it now sits in the redo stack
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addFilter:revenue']);

    // A non-undoable but LABELED mutation lands strictly AFTER the undo (real time) — it
    // does not clear the redo stack (a transient-only doc diff), so `addFilter:region`
    // remains redoable, yet `setActivePage` is now genuinely the MOST RECENT log entry.
    controller.applyExternalMutation({ type: 'setActivePage', args: { pageId: 'page-2' } });
    expect(controller.canRedo()).toBe(true);
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'addFilter:revenue',
      'setActivePage:page-2',
    ]);

    controller.redo(); // restores addFilter:region

    // `addFilter:region`'s own timestamp predates `setActivePage`'s (it was committed,
    // undone, and only THEN did setActivePage happen) — appending it at the tail would
    // make the redone (older) entry look newer than `setActivePage`. It must sort BEFORE
    // `setActivePage`, restoring correct oldest-first order.
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'addFilter:revenue',
      'addFilter:region',
      'setActivePage:page-2',
    ]);
  });

  it('leaves the log untouched when an unlabeled/non-undoable commit is undone', () => {
    const controller = new StudioController();
    controller.addFilter(makeFilter({ id: 'a', field: 'revenue' }));
    controller.setPageStackBreakpoint(600); // undoable but unlabeled — no log entry
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addFilter:revenue']);

    controller.undo(); // reverts the stack-breakpoint change; no paired log entry to remove

    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addFilter:revenue']);
  });

  it('does not resurrect a log entry that was evicted by the MAX_MUTATION_LOG cap', () => {
    const controller = new StudioController();
    // 21 labeled undoable steps: the log (capped at 20) evicts the OLDEST entry
    // (`addFilter:field-0`), but the undo stack (capped at 100) still holds all 21.
    for (let i = 0; i < 21; i += 1) {
      controller.addFilter(makeFilter({ id: `f-${i}`, field: `field-${i}` }));
    }
    expect(controller.getRecentMutations()).toHaveLength(20);
    expect(controller.getRecentMutations()[0].label).toBe('addFilter:field-1');

    // Undo all the way back to the first step — its log entry is long gone; nothing
    // should throw, and the log must not resurrect or duplicate anything.
    for (let i = 0; i < 21; i += 1) {
      controller.undo();
    }
    expect(controller.getRecentMutations()).toEqual([]);
  });
});

describe('StudioController.serializeSession / restoreSession', () => {
  it('round-trips the present state plus undo/redo stacks', () => {
    const source = new StudioController();
    source.setDashboardTitle('Step 1');
    source.setDashboardTitle('Step 2');
    source.undo(); // present = "Step 1", redo holds "Step 2"

    const session = source.serializeSession();
    expect(session.past).toHaveLength(1); // the pre-"Step 1" state
    expect(session.future).toHaveLength(1); // the undone "Step 2" state

    // Restore into a fresh controller.
    const restored = new StudioController();
    restored.restoreSession(session);

    expect(restored.getState().doc.dashboard.title).toBe('Step 1');
    expect(restored.canUndo()).toBe(true);
    expect(restored.canRedo()).toBe(true);

    // History is functional after restore.
    restored.redo();
    expect(restored.getState().doc.dashboard.title).toBe('Step 2');
    restored.undo();
    restored.undo();
    expect(restored.getState().doc.dashboard.title).not.toBe('Step 1');
  });

  // Behaviour change (lifetime-partition split): `mode` now lives in the non-undoable
  // `session` partition, so a `setMode` never creates an undo entry and `undo()` can no
  // longer flip view↔edit. A restored session carries the present mode forward and
  // preserves the (doc-only) undo/redo history — but undo does NOT time-travel mode.
  it('carries the present mode across a session round-trip and never reverts mode via undo', () => {
    const source = new StudioController({ session: { mode: 'view' } });
    source.setMode('edit'); // structurally non-undoable
    source.setDashboardTitle('A doc edit'); // the only undoable step

    const restored = new StudioController({ session: { mode: 'view' } });
    restored.restoreSession(source.serializeSession());

    // Present mode is preserved from the source's present snapshot.
    expect(restored.getState().session.mode).toBe('edit');
    // The doc edit is undoable; undoing it must leave mode untouched.
    expect(restored.canUndo()).toBe(true);
    restored.undo();
    expect(restored.getState().doc.dashboard.title).not.toBe('A doc edit');
    expect(restored.getState().session.mode).toBe('edit');
  });

  it('does not create an undo entry for the restore itself', () => {
    const source = new StudioController();
    source.setDashboardTitle('Only change');

    const restored = new StudioController();
    restored.restoreSession(source.serializeSession());

    // One undoable action in the source → exactly one past entry, not two.
    expect(restored.serializeSession().past).toHaveLength(1);
  });

  it('rejects a malformed session without mutating state', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Keep me');
    const result = controller.restoreSession({ nope: true });
    expect(result.success).toBe(false);
    expect(controller.getState().doc.dashboard.title).toBe('Keep me');
  });

  // Finding 5: `commitState`'s trim only shifts ONE entry per commit, so a tampered/legacy
  // session with an unbounded number of history entries would otherwise stay at that size
  // forever. `restoreSession` must truncate to `MAX_UNDO_HISTORY` (100) itself, keeping the
  // MOST RECENT entries (closest to `present`).
  it('truncates a restored past stack to MAX_UNDO_HISTORY, keeping the most recent entries', () => {
    const source = new StudioController();
    const snapshots: SerializedStudioSnapshot[] = [];
    for (let i = 0; i < 150; i += 1) {
      source.setDashboardTitle(`t-${i}`);
      snapshots.push(source.serializeSession().present);
    }
    const fakeSession: SerializedStudioSession = {
      schemaVersion: source.serializeSession().schemaVersion,
      present: snapshots[149],
      past: snapshots, // 150 raw entries — well over MAX_UNDO_HISTORY
      future: [],
    };

    const restored = new StudioController();
    const result = restored.restoreSession(fakeSession);
    expect(result.success).toBe(true);
    expect(restored.serializeSession().past).toHaveLength(100);

    // The oldest 50 entries (t-0..t-49) were evicted: 100 undos land on t-50, and the
    // 101st has nothing left to undo.
    for (let i = 0; i < 100; i += 1) {
      expect(restored.undo()).toBe(true);
    }
    expect(restored.getState().doc.dashboard.title).toBe('t-50');
    expect(restored.undo()).toBe(false);
  });

  // Finding 5: `present.mode` should be validated against the two allowed literals rather
  // than installed verbatim — a tampered/legacy/foreign session could carry anything.
  it('falls back to the default mode when the restored present.mode is invalid', () => {
    const source = new StudioController();
    const session = source.serializeSession();
    const tampered = {
      ...session,
      present: { ...session.present, mode: 'not-a-real-mode' as never },
    };

    const restored = new StudioController();
    const result = restored.restoreSession(tampered);

    expect(result.success).toBe(true);
    expect(['view', 'edit']).toContain(restored.getState().session.mode);
  });
});

// ─── StudioController.removeWidget — delegation to the shared reducer ────────
// Since `removeWidget` now delegates its state transform to `applyMutation`,
// these pin the cleanup that used to be reducer-only (cross-filter, colSpans)
// now also happening via the controller's user-driven path.

describe('StudioController.removeWidget — cross-filter and col-span cleanup', () => {
  it('removes a cross-filter emitted by the removed widget', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('chart-1', { kind: 'chart' }));
    controller.applyCrossFilter('chart-1', 'category', 'Books');

    controller.removeWidget('chart-1');

    expect(
      controller
        .getState()
        .doc.filters.filter(
          (f) => f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === 'chart-1',
        ),
    ).toHaveLength(0);
  });

  it("clears the removed widget's span and collapses a now-sole sibling's span", () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    const activePageId = controller.getState().doc.dashboard.activePageId;
    // Put both widgets in the same row with explicit spans.
    controller.setWidgetLayout([['w1', 'w2']]);
    controller.setAdjacentWidgetColSpans('w1', 16, 'w2', 8);
    expect(controller.getState().doc.pages[activePageId].widgetColSpans).toEqual({ w1: 16, w2: 8 });

    controller.removeWidget('w1');

    // w2 is now alone in its row — its span is cleared so it renders full-width.
    expect(controller.getState().doc.pages[activePageId].widgetColSpans).toBeUndefined();
  });
});

// ─── StudioController.foldUndoHistorySince ───────────────────────────────────
//
// This method had no direct test at all — its callers (`DataSourceFieldSelect`,
// `GridSetupPanel`, `StudioGridWidget`) either mock the controller or assert only the
// happy path, so every branch here was unpinned. That matters most for the
// missing-baseline guard: `baseIndex === -1` combined with the truncation two lines
// below (`this.undoStack.length = baseIndex + 1`) evaluates to `length = 0` — dropping
// that half of the condition silently WIPES the user's entire undo history whenever a
// gesture's baseline is not on the stack (the gesture committed nothing undoable, or its
// entries were already evicted by `MAX_UNDO_HISTORY`).
describe('StudioController.foldUndoHistorySince', () => {
  it('collapses every entry pushed since the baseline into a single undo step', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1')); // a pre-gesture edit, must survive untouched
    const baselineDoc = controller.getState().doc;

    // Three commits, one user gesture.
    controller.setDashboardTitle('Step 1');
    controller.setDashboardTitle('Step 2');
    controller.setDashboardTitle('Step 3');

    controller.foldUndoHistorySince(baselineDoc);

    // One Ctrl+Z reverts the WHOLE gesture, landing on the pre-gesture doc — never on an
    // intermediate state ("Step 1"/"Step 2") the user never saw.
    controller.undo();
    expect(controller.getState().doc).toBe(baselineDoc);
    expect(controller.getState().doc.widgets.w1).toBeDefined();

    // …and the pre-gesture edit is still separately undoable.
    expect(controller.canUndo()).toBe(true);
    controller.undo();
    expect(controller.getState().doc.widgets.w1).toBeUndefined();
  });

  it('no-ops when the baseline is not on the undo stack — it must not wipe the history', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.setDashboardTitle('Anchor');
    // A doc reference that was never committed by THIS controller, standing in for a
    // gesture that committed nothing undoable (or whose entries were evicted).
    const foreignDoc = new StudioController().getState().doc;

    controller.foldUndoHistorySince(foreignDoc);

    // Both undo steps must still be there, individually.
    expect(controller.canUndo()).toBe(true);
    controller.undo();
    expect(controller.getState().doc.dashboard.title).not.toBe('Anchor');
    expect(controller.getState().doc.widgets.w1).toBeDefined();
    expect(controller.canUndo()).toBe(true);
    controller.undo();
    expect(controller.getState().doc.widgets.w1).toBeUndefined();
  });

  it('no-ops when the baseline is already the newest entry (nothing to fold)', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const baselineDoc = controller.getState().doc;
    controller.setDashboardTitle('Only step');

    controller.foldUndoHistorySince(baselineDoc);

    controller.undo();
    expect(controller.getState().doc).toBe(baselineDoc);
    expect(controller.canUndo()).toBe(true);
  });

  // "The surviving entry inherits the LAST log line among those folded, so a subsequent
  // `undo()` retracts the line describing the gesture's NET effect." Taking the FIRST
  // folded line instead retracts a line describing an intra-gesture step the user never
  // saw, and leaves the line describing the gesture's actual outcome in the log the AI
  // reads back — so `get_recent_changes` would report an edit that has been undone.
  it('the surviving entry inherits the LAST folded log line, not the first', () => {
    const controller = new StudioController();
    controller.addFilter(makeFilter({ id: 'a', field: 'revenue' })); // pre-gesture
    const baselineDoc = controller.getState().doc;
    controller.addFilter(makeFilter({ id: 'b', field: 'region' })); // gesture step 1
    controller.addFilter(makeFilter({ id: 'c', field: 'country' })); // gesture step 2
    controller.addFilter(makeFilter({ id: 'd', field: 'city' })); // gesture step 3 (net effect)

    controller.foldUndoHistorySince(baselineDoc);

    // Folding does not rewrite the log: every step really did happen.
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'addFilter:revenue',
      'addFilter:region',
      'addFilter:country',
      'addFilter:city',
    ]);

    controller.undo();

    // The LAST folded line (`addFilter:city`) is the one retracted.
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'addFilter:revenue',
      'addFilter:region',
      'addFilter:country',
    ]);
  });

  // The baseline is looked up with `lastIndexOf`, not `indexOf`: a doc reference can sit on
  // the undo stack more than once (a host "revert to a captured snapshot" action commits a
  // previously-seen `doc` object through the public `setState`), and the gesture's own entry
  // is always the MOST RECENT occurrence. Matching the first occurrence truncates the stack
  // back to it, swallowing every unrelated edit in between.
  it('folds to the MOST RECENT occurrence of a doc reference that appears twice on the stack', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('A');
    const docA = controller.getState().doc;
    controller.setDashboardTitle('B'); // pushes docA onto the stack (occurrence #1)

    // A host restores the earlier snapshot as a fresh undoable edit.
    controller.setState({ ...controller.getState(), doc: docA });
    expect(controller.getState().doc).toBe(docA);

    // The gesture starts here, with `docA` as its baseline.
    controller.setDashboardTitle('C'); // pushes docA onto the stack (occurrence #2)
    controller.setDashboardTitle('D');

    controller.foldUndoHistorySince(docA);

    // One Ctrl+Z reverts the whole gesture back to the restore point…
    controller.undo();
    expect(controller.getState().doc).toBe(docA);
    // …and the edits made BEFORE the restore are untouched: the next undo lands on 'B',
    // not on the initial title (which is where matching occurrence #1 would have left it).
    controller.undo();
    expect(controller.getState().doc.dashboard.title).toBe('B');
  });
});

// ─── StudioController.removePage — delegation to the shared reducer ─────────

describe('StudioController undo/redo activePageId carry (1.2)', () => {
  it('undo of addPage does not leave activePageId dangling at the removed page', () => {
    const controller = new StudioController();
    const firstPageId = controller.getState().doc.dashboard.activePageId;

    // addPage creates and activates the new page.
    const newPageId = controller.addPage('Second');
    expect(controller.getState().doc.dashboard.activePageId).toBe(newPageId);

    // Undo removes the page the user was viewing. activePageId must not remain
    // pointing at the now-deleted page — it falls back to the first existing page.
    controller.undo();
    const doc = controller.getState().doc;
    expect(doc.pages[newPageId]).toBeUndefined();
    expect(Object.hasOwn(doc.pages, doc.dashboard.activePageId)).toBe(true);
    expect(doc.dashboard.activePageId).toBe(firstPageId);
  });

  it('redo of removePage does not leave activePageId dangling at the removed page', () => {
    const controller = new StudioController();
    const firstPageId = controller.getState().doc.dashboard.activePageId;
    const secondPageId = controller.addPage('Second');

    // View the first page, then remove the (non-active) second page.
    controller.setActivePage(firstPageId);
    controller.removePage(secondPageId);
    expect(controller.getState().doc.dashboard.activePageId).toBe(firstPageId);

    // Undo restores the second page; navigate onto it (non-undoable, keeps the
    // redo stack intact) so the current selection points at the page redo will drop.
    controller.undo();
    expect(controller.getState().doc.pages[secondPageId]).toBeTruthy();
    controller.setActivePage(secondPageId);
    expect(controller.getState().doc.dashboard.activePageId).toBe(secondPageId);

    // Redo re-removes the second page. The carried activePageId (secondPageId) is
    // gone from the restored doc, so it must fall back to an existing page.
    controller.redo();
    const doc = controller.getState().doc;
    expect(doc.pages[secondPageId]).toBeUndefined();
    expect(Object.hasOwn(doc.pages, doc.dashboard.activePageId)).toBe(true);
    expect(doc.dashboard.activePageId).toBe(firstPageId);
  });

  it('carries a still-valid activePageId forward unchanged across an unrelated undo', () => {
    const controller = new StudioController();
    const secondPageId = controller.addPage('Second');

    // An unrelated, undoable edit while viewing the second page.
    controller.setDashboardTitle('Edited');
    controller.setActivePage(secondPageId);

    // Undo of the title edit must not jump the user off the (still-existing) page.
    controller.undo();
    expect(controller.getState().doc.dashboard.activePageId).toBe(secondPageId);
    expect(controller.getState().doc.dashboard.title).not.toBe('Edited');
  });
});

describe('StudioController.removePage', () => {
  it('removes the page, its widgets, and reassigns the active page', () => {
    const controller = new StudioController();
    const firstPageId = controller.getState().doc.dashboard.activePageId;
    const secondPageId = controller.addPage('Second');
    controller.setActivePage(firstPageId);
    controller.addWidget(makeWidget('w1'));

    controller.removePage(firstPageId);

    expect(controller.getState().doc.pages[firstPageId]).toBeUndefined();
    expect(controller.getState().doc.widgets.w1).toBeUndefined();
    expect(controller.getState().doc.dashboard.activePageId).toBe(secondPageId);
  });

  it('drops widget-scoped filters targeting a widget on the removed page (no orphan)', () => {
    const controller = new StudioController();
    controller.addPage('Second');
    const firstPageId = Object.keys(controller.getState().doc.pages)[0];
    controller.setActivePage(firstPageId);
    controller.addWidget(makeWidget('w1'));
    controller.addFilter(makeFilter({ id: 'fw1', scope: { kind: 'widget', widgetId: 'w1' } }));

    controller.removePage(firstPageId);

    // The widget-scope filter has no pageId of its own — without cleanup it would
    // survive as a permanent orphan once its anchor widget's page is gone.
    expect(controller.getState().doc.filters.find((f) => f.id === 'fw1')).toBeUndefined();
  });

  it('is a no-op for an unknown pageId', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Keep me');
    const before = controller.getState();
    controller.removePage('does-not-exist');
    expect(controller.getState()).toBe(before);
  });
});

// ─── StudioController date-range presets ─────────────────────────────────────
// Zero tests existed for this surface prior to fixing the widget-scoped preset
// bug (a non-custom preset stored with `value: null` was silently dropped as
// "incomplete" because resolution only handled `dashboard-date-range` scope).

describe('StudioController.setWidgetDateRange', () => {
  it('stores a non-custom preset with value: null and scope.kind "widget"', () => {
    const controller = new StudioController();
    controller.setWidgetDateRange('kpi-1', 'orderDate', 'src1', 'date', 'last_3_months');
    const filter = controller
      .getState()
      .doc.filters.find((f) => f.id === 'widget-date-range-kpi-1');
    expect(filter).toBeDefined();
    expect(filter!.value).toBeNull();
    expect(filter!.scope).toEqual({ kind: 'widget', widgetId: 'kpi-1' });
    expect(filter!.dateRangePreset).toBe('last_3_months');
  });

  it('is resolved to a concrete range by resolveDateRangePreset (the widget-scoped preset bug)', () => {
    const controller = new StudioController();
    controller.setWidgetDateRange('kpi-1', 'orderDate', 'src1', 'date', 'last_3_months');
    const filter = controller
      .getState()
      .doc.filters.find((f) => f.id === 'widget-date-range-kpi-1')!;
    const resolved = resolveDateRangePreset(filter);
    expect(resolved.value).not.toBeNull();
    expect(resolved.value).toHaveProperty('from');
    expect(resolved.value).toHaveProperty('to');
  });

  it('stores a custom preset with the explicit from/to value', () => {
    const controller = new StudioController();
    controller.setWidgetDateRange(
      'kpi-1',
      'orderDate',
      'src1',
      'date',
      'custom',
      '2024-01-01',
      '2024-01-31',
    );
    const filter = controller
      .getState()
      .doc.filters.find((f) => f.id === 'widget-date-range-kpi-1')!;
    expect(filter.value).toEqual({ from: '2024-01-01', to: '2024-01-31' });
  });

  it('clears the widget date range when preset is null', () => {
    const controller = new StudioController();
    controller.setWidgetDateRange('kpi-1', 'orderDate', 'src1', 'date', 'last_3_months');
    controller.setWidgetDateRange('kpi-1', null, null, null, null);
    expect(
      controller.getState().doc.filters.find((f) => f.id === 'widget-date-range-kpi-1'),
    ).toBeUndefined();
  });

  it('does not affect a dashboard-date-range filter on the same page', () => {
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;
    controller.setDashboardDateRange(pageId, 'orderDate', 'src1', 'date', 'this_month');
    controller.setWidgetDateRange('kpi-1', 'orderDate', 'src1', 'date', 'last_3_months');
    expect(controller.getState().doc.filters).toHaveLength(2);
  });
});

// ─── Col-span unit system round-trip (24-column, GRID_COLS) ──────────────────
// Pins the fix for the two-incompatible-unit-systems bug: drag-resize
// (`setAdjacentWidgetColSpans`) and AI-resize (the shared `applyMutation`
// reducer's `setWidgetColSpan` handler) must agree on the same GRID_COLS=24
// unit system, or one path silently corrupts the other's layout.
//
// `GRID_COLS`/`MIN_SPAN` are now single-sourced in `@mui/x-studio-schema` (and
// re-exported through `canvasGridConstants`), so these no longer guard against two
// *diverging literal copies* of the base constants. They remain a live sanity
// check that the reducer's clamp bounds equal the constants the canvas renders
// with, exercised end-to-end through the client controller.
//
// NOTE (known follow-up, out of scope here): the per-widget-kind minimum
// `KPI_NO_SPARKLINE_MIN_SPAN` (canvas-only, in `StudioCanvas.tsx`) is NOT mirrored
// by the reducer's clamp — so an AI resize of a sparkline-less KPI can still clamp
// to `MIN_SPAN` (6) rather than that widget's rendered minimum (4). Consolidating
// the base constant does not fix that per-kind semantic drift; it is left for a
// later pass.

describe('Col-span unit system round-trip', () => {
  it('drag-resize and AI-resize (applyMutation) agree on GRID_COLS units', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    controller.setWidgetLayout([['w1', 'w2']]);
    const activePageId = controller.getState().doc.dashboard.activePageId;

    // Drag-resize: user sets a 16/8 split in 24-column units.
    controller.setAdjacentWidgetColSpans('w1', 16, 'w2', 8);
    expect(controller.getState().doc.pages[activePageId].widgetColSpans).toEqual({ w1: 16, w2: 8 });

    // AI-resize: the shared reducer resizes w1 to 12 — must clamp/rebalance in
    // the SAME 24-column system, not silently reinterpret the stored 8 as a
    // 12-column-system value.
    const state = controller.getState();
    const next = applyMutation(state, {
      type: 'setWidgetColSpan',
      args: { widgetId: 'w1', columns: 12, rowWidgetIds: ['w1', 'w2'] },
    });
    // 12 + 8 = 20 <= 24, so no rebalancing is needed — w2's span is untouched.
    expect(next.doc.pages[activePageId].widgetColSpans).toEqual({ w1: 12, w2: 8 });
  });

  it('AI-resize clamps to the same MIN_SPAN/GRID_COLS bounds as the canvas grid constants', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const activePageId = controller.getState().doc.dashboard.activePageId;
    const state = controller.getState();

    const tooSmall = applyMutation(state, {
      type: 'setWidgetColSpan',
      args: { widgetId: 'w1', columns: 1, rowWidgetIds: ['w1'] },
    });
    expect(tooSmall.doc.pages[activePageId].widgetColSpans).toEqual({ w1: MIN_SPAN });

    const tooLarge = applyMutation(state, {
      type: 'setWidgetColSpan',
      args: { widgetId: 'w1', columns: 100, rowWidgetIds: ['w1'] },
    });
    expect(tooLarge.doc.pages[activePageId].widgetColSpans).toEqual({ w1: GRID_COLS });
  });

  // 2.2: a resize-handle pointerup with zero movement re-derives the exact same spans.
  // Because the handler builds a fresh spans/pages object each call, `commitDocPatch`'s
  // reference-equality guard can't catch it — without the value-equality no-op guard this
  // would push a phantom undoable entry and clear the redo stack.
  it('setAdjacentWidgetColSpans is a value-equal no-op when the spans do not change (2.2)', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    controller.setWidgetLayout([['w1', 'w2']]);
    const activePageId = controller.getState().doc.dashboard.activePageId;

    // Establish an explicit split, then set up a pending redo entry.
    controller.setAdjacentWidgetColSpans('w1', 16, 'w2', 8);
    controller.setDashboardTitle('anchor');
    controller.undo();
    expect(controller.canRedo()).toBe(true);
    const stateBefore = controller.getState();

    // Re-committing the identical 16/8 split (a zero-movement pointerup) must be a clean
    // no-op: no state change, no new undo entry, and the pending redo survives.
    controller.setAdjacentWidgetColSpans('w1', 16, 'w2', 8);
    expect(controller.getState()).toBe(stateBefore);
    expect(controller.getState().doc.pages[activePageId].widgetColSpans).toEqual({ w1: 16, w2: 8 });
    expect(controller.canRedo()).toBe(true);
    controller.redo();
    expect(controller.getState().doc.dashboard.title).toBe('anchor');
  });

  // Finding 3: when the two widgets' minimum spans can't both fit inside the pair's
  // current total (e.g. a KPI's sparkline toggled on after the layout was set, raising
  // its min-span requirement), the naive `clampedRight = totalSpan - clampedLeft` can go
  // to zero or negative. Floor `clampedRight` at its own minimum instead.
  it('never commits a sub-minimum or negative span when the pair total cannot satisfy both minimums', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    controller.setWidgetLayout([['w1', 'w2']]);
    const activePageId = controller.getState().doc.dashboard.activePageId;

    // totalSpan = 10, but the mins (8 + 8 = 16) can't both fit inside it.
    controller.setAdjacentWidgetColSpans('w1', 5, 'w2', 5, 8, 8);

    const spans = controller.getState().doc.pages[activePageId].widgetColSpans;
    expect(spans!.w1).toBeGreaterThanOrEqual(8);
    expect(spans!.w2).toBeGreaterThanOrEqual(8);
  });

  // Finding 3: both widgets must exist and share a row on the active page.
  it('is a no-op when the two widgets do not share a row', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    controller.setWidgetLayout([['w1'], ['w2']]);
    const stateBefore = controller.getState();

    controller.setAdjacentWidgetColSpans('w1', 16, 'w2', 8);

    expect(controller.getState()).toBe(stateBefore);
  });

  it('is a no-op when either widget id is unknown', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    controller.setWidgetLayout([['w1', 'w2']]);
    const stateBefore = controller.getState();

    controller.setAdjacentWidgetColSpans('w1', 16, 'nonexistent', 8);

    expect(controller.getState()).toBe(stateBefore);
  });
});

// ─── commitMutation delegation — signed-off behaviour changes ────────────────
// These pin the intended behaviour changes introduced when the listed controller
// methods were converted to delegate through the shared `applyMutation` reducer
// via the private `commitMutation` choke-point.

describe('StudioController.setWidgetLayout — col-span cleanup (D2 bug fix)', () => {
  it('prunes stale spans when a keyboard-style reorder splits a shared row into singletons', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    const activePageId = controller.getState().doc.dashboard.activePageId;
    // Put both widgets in one row and give them an explicit 16/8 split.
    controller.setWidgetLayout([['w1', 'w2']]);
    controller.setAdjacentWidgetColSpans('w1', 16, 'w2', 8);
    expect(controller.getState().doc.pages[activePageId].widgetColSpans).toEqual({ w1: 16, w2: 8 });

    // The keyboard-accessible reorder path (StudioWidgetCard) commits via
    // `setWidgetLayout`. Splitting the pair into two singleton rows must now clear
    // both stale multi-widget-era spans (each survivor auto-fills its row) — the
    // same cleanup the pointer drag-and-drop path already performed, which the old
    // `setWidgetLayout` (a bare `widgetRows` replace) skipped, leaving them stale.
    controller.setWidgetLayout([['w1'], ['w2']]);
    expect(controller.getState().doc.pages[activePageId].widgetColSpans).toBeUndefined();
  });

  it('preserves an intentional lone-widget span (does not over-prune)', () => {
    // w1 alone in row 0 with a deliberate narrow span; w2 alone in row 1. Built directly
    // into the initial doc (rather than via `setAdjacentWidgetColSpans`, which now
    // requires — finding 3 — that both widgets share a row before it will write anything).
    const activePageId = 'page-1';
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId },
        pages: {
          [activePageId]: {
            id: activePageId,
            title: 'Page 1',
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w1: 12 },
          },
        },
        widgets: { w1: makeWidget('w1'), w2: makeWidget('w2') },
      },
    });
    // Only assert the reorder below keeps w1's already-lone span intact.
    const spansBefore = controller.getState().doc.pages[activePageId].widgetColSpans;
    // Swap the two singleton rows — neither row collapses from 2→1, so no span is stale.
    controller.setWidgetLayout([['w2'], ['w1']]);
    expect(controller.getState().doc.pages[activePageId].widgetColSpans).toEqual(spansBefore);
  });
});

describe('StudioController.removeFilter — no-op does not touch history/log (D4)', () => {
  it('removing an unknown filter id creates no undo entry and no log line', () => {
    const controller = new StudioController({ doc: { filters: [makeFilter({ id: 'f1' })] } });
    controller.setDashboardTitle('anchor'); // one real undoable action + log line
    const undoBefore = controller.canUndo();
    const logBefore = controller.getRecentMutations();

    controller.removeFilter('does-not-exist');

    expect(controller.canUndo()).toBe(undoBefore);
    expect(controller.getRecentMutations()).toEqual(logBefore);
    // A single undo reverts the title change — proving the no-op added no step.
    expect(controller.undo()).toBe(true);
    expect(controller.canUndo()).toBe(false);
  });
});

// The rule the mutation-log labelling follows: a commit that changes the authored `doc`
// on the user's behalf is labeled, and suppression is reserved for system-initiated
// self-repair (`{ undoable: false }`) and user-driven navigation (`setActivePage`).
// `updateWidget` used to break it with an inherited `label: null`, so the log recorded a
// config tweak but hid the larger edit (retitle / re-source / kind switch) — and hid the
// USER's widget edit while `applyExternalMutation` logged the assistant's identical one.
describe('StudioController.updateWidget — labelling rule', () => {
  it('logs a user-driven widget edit under the reducer default `updateWidget:<id>` label', () => {
    const controller = new StudioController({
      doc: { widgets: { w1: makeWidget('w1') } },
    });

    controller.updateWidget('w1', { title: 'Renamed' });

    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['updateWidget:w1']);
  });

  it('logs the same label whether the edit came from the user or over the AI wire', () => {
    const userDriven = new StudioController({ doc: { widgets: { w1: makeWidget('w1') } } });
    const wireDriven = new StudioController({ doc: { widgets: { w1: makeWidget('w1') } } });

    userDriven.updateWidget('w1', { title: 'Renamed' });
    wireDriven.applyExternalMutation({
      type: 'updateWidget',
      args: { widgetId: 'w1', changes: { title: 'Renamed' } },
    });

    expect(userDriven.getRecentMutations().map((m) => m.label)).toEqual(
      wireDriven.getRecentMutations().map((m) => m.label),
    );
  });

  it('folds the stale-filter removals into the same batch label', () => {
    const controller = new StudioController({
      doc: {
        widgets: { w1: makeWidget('w1') },
        filters: [makeFilter({ id: 'f1', field: 'amount' })],
      },
    });

    controller.updateWidget('w1', { sourceId: 'other' }, { removeFilterIds: ['f1'] });

    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'updateWidget:w1 + removeFilter:f1',
    ]);
  });
});

describe('StudioController.updateWidgetConfig — reducer default label (D1)', () => {
  it('logs under the reducer default `updateWidget:<id>` label (was `updateWidgetConfig:<id>`)', () => {
    const controller = new StudioController({
      doc: {
        widgets: {
          text1: { id: 'text1', kind: 'text', title: 'Notes', config: { textBody: 'Body' } },
        },
      },
    });

    controller.updateWidgetConfig('text1', { textBody: 'Updated' });

    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['updateWidget:text1']);
  });
});

// ─── Step A (2.3): helpers + mechanical routing preserved semantics ──────────

describe('StudioController — commit*Patch routing (2.3)', () => {
  it('setPageStackBreakpoint stays undoable after routing through commitDocPatch', () => {
    const controller = new StudioController();
    expect(controller.canUndo()).toBe(false);
    controller.setPageStackBreakpoint(600);
    expect(controller.canUndo()).toBe(true);
    controller.undo();
    expect(
      controller.getState().doc.pages[controller.getState().doc.dashboard.activePageId]
        .stackBreakpoint,
    ).toBeUndefined();
  });

  it('shell writers stay non-undoable and leave the doc reference untouched', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const before = controller.getState();
    const undoBefore = controller.canUndo();

    controller.toggleDrawer('filters');

    const after = controller.getState();
    // Only session changed; the doc partition is the SAME reference.
    expect(after.doc).toBe(before.doc);
    expect(after.session.shell.openDrawers.filters).toBe(true);
    expect(controller.canUndo()).toBe(undoBefore);
  });

  it('updateDataSourceField on an unknown sourceId is a state-reference no-op', () => {
    const controller = new StudioController();
    const before = controller.getState();
    controller.updateDataSourceField('nope', 'field', { label: 'X' });
    expect(controller.getState()).toBe(before);
  });

  // Finding 4: `commitDataSourcePatch` always allocates a fresh source/`dataSources`
  // object, so without an explicit guard an unknown `fieldId` or a value-identical
  // `updates` payload would still commit and churn every subscriber.
  it('updateDataSourceField on an unknown fieldId is a state-reference no-op', () => {
    const controller = new StudioController({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Orders',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: [],
          },
        },
      },
    });
    const before = controller.getState();
    controller.updateDataSourceField('src1', 'nonexistent-field', { label: 'X' });
    expect(controller.getState()).toBe(before);
  });

  it('updateDataSourceField with a value-identical update is a state-reference no-op', () => {
    const controller = new StudioController({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Orders',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: [],
          },
        },
      },
    });
    const before = controller.getState();
    controller.updateDataSourceField('src1', 'amount', { label: 'Amount', type: 'number' });
    expect(controller.getState()).toBe(before);
  });

  it('updateDataSourceField commits a fresh state when the update actually changes a value', () => {
    const controller = new StudioController({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Orders',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: [],
          },
        },
      },
    });
    controller.updateDataSourceField('src1', 'amount', { label: 'Total Amount' });
    expect(controller.getState().runtime.dataSources.src1.fields[0].label).toBe('Total Amount');
  });

  it('setGlobalCrossFilterMode is a state-reference no-op when the value is unchanged', () => {
    const controller = new StudioController();
    controller.setGlobalCrossFilterMode('cross-filter');
    const before = controller.getState();
    controller.setGlobalCrossFilterMode('cross-filter');
    expect(controller.getState()).toBe(before);
  });

  it('setCrossFilterAllPages is a state-reference no-op when the value is unchanged', () => {
    const controller = new StudioController();
    controller.setCrossFilterAllPages(true);
    const before = controller.getState();
    controller.setCrossFilterAllPages(true);
    expect(controller.getState()).toBe(before);
  });

  it('setDataSourceAdapter on an unknown sourceId is a state-reference no-op', () => {
    const controller = new StudioController();
    const before = controller.getState();
    controller.setDataSourceAdapter('nope', undefined);
    expect(controller.getState()).toBe(before);
  });
});

describe('StudioController.upsertDataSource — adapter preservation (1.8)', () => {
  const makeAdapter = (rows: StudioQueryResult['rows']): StudioDataSourceAdapter => ({
    getRows: async () => ({ rows, totalCount: rows.length }),
  });

  it('preserves a separately-registered adapter when the incoming source has none', () => {
    // Regression (1.8): the documented embed flow registers adapters via `dataAdapters`
    // (→ `setDataSourceAdapter`), then a `config` prop swap re-injects sources parsed from
    // `serializeState()`/JSON — which never carry an `adapter` field. `upsertDataSource`
    // replaced the whole entry, silently wiping the registered adapter so the source fell
    // back to (usually absent) static rows and widgets went blank with no error.
    const controller = new StudioController();
    controller.upsertDataSource({
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [{ amount: 1 }],
    });
    const adapter = makeAdapter([{ amount: 99 }]);
    controller.setDataSourceAdapter('orders', adapter);
    expect(controller.getState().runtime.dataSources.orders.adapter).toBe(adapter);

    // Config-swap reload: a source with the SAME id but no adapter (as it came from JSON).
    controller.upsertDataSource({
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [{ amount: 2 }],
    });

    // The adapter survives the swap; the new static rows are applied.
    expect(controller.getState().runtime.dataSources.orders.adapter).toBe(adapter);
    expect(controller.getState().runtime.dataSources.orders.rows).toEqual([{ amount: 2 }]);
  });

  it('lets an incoming adapter override the existing one', () => {
    const controller = new StudioController();
    const first = makeAdapter([{ amount: 1 }]);
    const second = makeAdapter([{ amount: 2 }]);
    controller.upsertDataSource({
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      adapter: first,
    });
    controller.upsertDataSource({
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      adapter: second,
    });
    expect(controller.getState().runtime.dataSources.orders.adapter).toBe(second);
  });

  it('invalidates the request cache on a replacement even when neither entry carries an adapter here', () => {
    // Regression (1.8): the old `if (dataSource.adapter)` guard skipped cache invalidation
    // when an adapter-less source replaced an existing one — so the swap could serve
    // pre-swap cached rows for the "new" source. Replacing an entry always invalidates now.
    const controller = new StudioController();
    controller.upsertDataSource({
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [{ amount: 1 }],
    });
    const spy = vi.spyOn(studioRequestCache, 'invalidateSource');
    try {
      controller.upsertDataSource({
        id: 'orders',
        label: 'Orders',
        fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
        rows: [{ amount: 2 }],
      });
      expect(spy).toHaveBeenCalledWith('orders');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('StudioController.setDataSourceAdapter — same-adapter guard (1.2)', () => {
  const makeAdapter = (rows: StudioQueryResult['rows']): StudioDataSourceAdapter => ({
    getRows: async () => ({ rows, totalCount: rows.length }),
  });

  function makeControllerWithSource() {
    const controller = new StudioController();
    controller.upsertDataSource({
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [{ amount: 1 }],
    });
    return controller;
  }

  it('re-registering the identical adapter reference is a clean no-op (no cache invalidation, no commit)', () => {
    // Regression (1.2): `StudioDashboard` re-runs `setDataSourceAdapter` for every entry
    // whenever its `dataAdapters` prop changes by identity. Without a same-adapter guard,
    // an unchanged adapter still invalidated the request cache and committed a new source
    // object every render — an unbounded refetch/update loop paired with `onStateChange`.
    const controller = makeControllerWithSource();
    const adapter = makeAdapter([{ amount: 99 }]);
    controller.setDataSourceAdapter('orders', adapter);

    const stateBefore = controller.getState();
    const spy = vi.spyOn(studioRequestCache, 'invalidateSource');
    try {
      controller.setDataSourceAdapter('orders', adapter);
      // No cache invalidation and no new state object for an unchanged adapter reference.
      expect(spy).not.toHaveBeenCalled();
      expect(controller.getState()).toBe(stateBefore);
    } finally {
      spy.mockRestore();
    }
  });

  it('a different adapter reference invalidates the cache and commits', () => {
    const controller = makeControllerWithSource();
    const first = makeAdapter([{ amount: 1 }]);
    controller.setDataSourceAdapter('orders', first);

    const stateBefore = controller.getState();
    const second = makeAdapter([{ amount: 2 }]);
    const spy = vi.spyOn(studioRequestCache, 'invalidateSource');
    try {
      controller.setDataSourceAdapter('orders', second);
      expect(spy).toHaveBeenCalledWith('orders');
      expect(controller.getState()).not.toBe(stateBefore);
      expect(controller.getState().runtime.dataSources.orders.adapter).toBe(second);
    } finally {
      spy.mockRestore();
    }
  });

  it('is a no-op on a missing source', () => {
    const controller = new StudioController();
    const stateBefore = controller.getState();
    controller.setDataSourceAdapter('nope', makeAdapter([]));
    expect(controller.getState()).toBe(stateBefore);
  });
});

describe('StudioController.removeDataSource (2.1)', () => {
  function makeControllerWith(ids: string[]) {
    const controller = new StudioController();
    for (const id of ids) {
      controller.upsertDataSource({
        id,
        label: id,
        fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
        rows: [{ amount: 1 }],
      });
    }
    return controller;
  }

  it('removes the source, invalidates its cache, and is not undoable', () => {
    const controller = makeControllerWith(['orders', 'customers']);
    expect(controller.canUndo()).toBe(false);

    const spy = vi.spyOn(studioRequestCache, 'invalidateSource');
    try {
      controller.removeDataSource('orders');
      expect(spy).toHaveBeenCalledWith('orders');
    } finally {
      spy.mockRestore();
    }

    const sources = controller.getState().runtime.dataSources;
    expect(sources.orders).toBeUndefined();
    expect(sources.customers).toBeDefined();
    // Data-source removal is host infrastructure — never an undoable authored edit.
    expect(controller.canUndo()).toBe(false);
  });

  it('is a no-op on a missing source', () => {
    const controller = makeControllerWith(['orders']);
    const stateBefore = controller.getState();
    controller.removeDataSource('nope');
    expect(controller.getState()).toBe(stateBefore);
  });
});

describe('StudioController.updateState — spread + no-op guard (2.4)', () => {
  it('a content-identical update is a no-op (no new state, no redo-clearing commit)', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Original');
    // Establish a redo entry to prove a no-op update does not clear it.
    controller.setDashboardTitle('Second');
    controller.undo();
    expect(controller.canRedo()).toBe(true);

    const stateBefore = controller.getState();
    // Re-supplying the CURRENT dashboard reference (reference-equal) must not commit.
    controller.updateState({ doc: { dashboard: stateBefore.doc.dashboard } });
    expect(controller.getState()).toBe(stateBefore);
    // The redo stack survived (a phantom commit would have cleared it).
    expect(controller.canRedo()).toBe(true);
  });

  /* eslint-disable no-underscore-dangle */ // __cacheKey__ is the reselect memoization tag
  it('preserves the top-level __cacheKey__ reselect-memoization tag across a real update', () => {
    const controller = new StudioController();
    // Simulate `createSelectorMemoized` stamping its per-store cache key onto the state.
    const marker = { id: 1 };
    const before = controller.getState();
    (before as unknown as { __cacheKey__?: unknown }).__cacheKey__ = marker;

    // A genuine doc change (new `dashboard` reference) so the commit actually runs.
    controller.updateState({ doc: { dashboard: { ...before.doc.dashboard, title: 'Renamed' } } });

    expect(controller.getState().doc.dashboard.title).toBe('Renamed');
    expect((controller.getState() as unknown as { __cacheKey__?: unknown }).__cacheKey__).toBe(
      marker,
    );
  });
  /* eslint-enable no-underscore-dangle */

  // The history bookkeeping in `commitState` is gated on `nextState.doc !== current.doc`,
  // NOT on "did anything change". `updateState` forwards no options, so `undoable` defaults
  // to `true` — widening that gate to `nextState !== current` would make every session- or
  // runtime-only update push a doc snapshot onto the undo stack and clear the redo stack.
  // The existing coverage in this area routes through `commitShellPatch`/`upsertDataSource`,
  // which pass `{ undoable: false }` explicitly and so cannot observe the gate at all.
  it('a session-only update is not an authored edit: no undo entry, and a pending redo survives', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Edited');
    controller.undo();
    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(true);

    controller.updateState({ session: { mode: 'view' } });

    expect(controller.getState().session.mode).toBe('view');
    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(true);
    controller.redo();
    expect(controller.getState().doc.dashboard.title).toBe('Edited');
  });

  it('a runtime-only update is not an authored edit either', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Edited');
    controller.undo();
    expect(controller.canRedo()).toBe(true);

    controller.updateState({
      runtime: {
        dataSources: {
          orders: { id: 'orders', label: 'Orders', fields: [], rows: [{ amount: 1 }] },
        },
      },
    });

    expect(controller.getState().runtime.dataSources.orders).toBeDefined();
    // Host data injection must never enter the authored-edit timeline, nor destroy a
    // pending redo — an undo must not be able to revert live rows to stale ones.
    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(true);
  });
});

// ─── StudioController — commitState's identical-state early return ────────────
//
// `commitState` bails when `nextState === current`. Every write path above it already
// guards key-wise, so with the bail neutered the SUITE stays green — but `Store.setState`
// notifies unconditionally, so a genuine no-op commit would wake every `useStudioSelector`
// subscriber and re-render every mounted widget for a state that did not change. The
// no-op re-commit is not hypothetical: `useChatThreads` re-sends `controller.getState()`
// on write-backs, and hosts re-apply a controlled `mode`/state prop from an effect.
describe('StudioController — commitState bails on an identical state object', () => {
  it('does not notify subscribers when the committed state is the current one', () => {
    const controller = new StudioController();
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.setState(controller.getState());

    expect(listener).not.toHaveBeenCalled();
  });

  it('still notifies for a genuine change (the guard is not just "never notify")', () => {
    const controller = new StudioController();
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.setDashboardTitle('Changed');

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('StudioController.setDashboardDateRangeAll — undoable option (1.7)', () => {
  const fields = [{ fieldId: 'date', sourceId: 'orders', fieldType: 'date' as const }];

  it('is undoable by default (a user-authored preset change)', () => {
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;
    expect(controller.canUndo()).toBe(false);

    controller.setDashboardDateRangeAll(pageId, fields, 'last_3_months');

    expect(controller.canUndo()).toBe(true);
  });

  it('does NOT push an undo entry (or clear redo) when committed with { undoable: false }', () => {
    // Regression (1.7): the date-range reconciliation effect commits this system-initiated
    // normalization non-undoably, so it must not trap undo on mount nor wipe the redo stack
    // when it re-fires after an undo.
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;

    // Establish some undo/redo history from a genuine authored edit.
    controller.setDashboardTitle('First');
    controller.undo();
    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(true);

    // The system reconciliation fires: it must neither push an undo entry nor clear redo.
    controller.setDashboardDateRangeAll(pageId, fields, 'last_3_months', undefined, undefined, {
      undoable: false,
    });

    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(true);
    // The reconciliation still applied to the doc.
    expect(
      controller
        .getState()
        .doc.filters.some(
          (f) => f.scope.kind === 'dashboard-date-range' && f.scope.pageId === pageId,
        ),
    ).toBe(true);
  });
});

// Finding 4: `{ undoable: false }` on `updateFilter`/`updateWidgetConfig` is ALSO the
// self-repair signal (an internal consistency fixup, not a user-driven edit — e.g.
// `PageFilterRow`/`WidgetFilterRow` silently correcting a stored operator invalid for
// the field type, or `KpiSetupPanel` repairing an invalid stored aggregation). Both
// methods used to still write a recent-mutation-log line for this case (via their
// default reducer label), because `commitState` logs whenever the doc changed
// regardless of `undoable` — so a self-repair could evict a genuine user-initiated
// entry from the capped (`MAX_MUTATION_LOG`) log. The label must be suppressed for the
// self-repair case specifically, while a genuine (undoable) call keeps logging.
describe('StudioController — self-repair commits do not pollute the recent-mutation log (finding 4)', () => {
  it('updateFilter self-repair ({ undoable: false }) logs nothing; a genuine call still logs', () => {
    const controller = new StudioController();
    controller.addFilter(makeFilter({ id: 'f1', field: 'amount', operator: 'greater_than' }));
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addFilter:amount']);

    // Self-repair: e.g. a filters-drawer row silently correcting a stored operator that
    // is invalid for the field type. Must NOT add a log line.
    controller.updateFilter('f1', { operator: 'less_than' }, { undoable: false });
    expect(controller.getState().doc.filters.find((f) => f.id === 'f1')?.operator).toBe(
      'less_than',
    );
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addFilter:amount']);
    // It also must not be reachable via undo as its own step: the self-repair never
    // pushed an undo entry, so the next undo() reverts the PRECEDING undoable commit
    // (`addFilter`) instead — removing the filter entirely, not merely reverting the
    // repaired operator.
    controller.undo();
    expect(controller.getState().doc.filters.find((f) => f.id === 'f1')).toBeUndefined();
    controller.redo();

    // A genuine (default-undoable) call to the SAME method still logs normally.
    controller.updateFilter('f1', { value: 20 });
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'addFilter:amount',
      'updateFilter:f1',
    ]);
  });

  // A default (undoable) `updateWidgetConfig` — the shape `StudioGridWidget`'s edit-mode
  // header sort now uses (F2) — both logs AND lands on the undo timeline. The previous
  // `logAsUserEdit` escape hatch (log, but stay off the timeline) existed only for that
  // caller; a non-undoable write into `doc.widgets` was silently reverted by any unrelated
  // undo, since `carryTransientDocState` does not carry widget config.
  it('updateWidgetConfig logs AND is undoable by default', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('grid1', { kind: 'grid' }));
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addWidget:grid:grid1']);

    controller.updateWidgetConfig('grid1', { gridSortField: 'revenue', gridSortDirection: 'desc' });

    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'addWidget:grid:grid1',
      'updateWidget:grid1',
    ]);
    expect(controller.getState().doc.widgets.grid1.config).toMatchObject({
      gridSortField: 'revenue',
      gridSortDirection: 'desc',
    });

    // Undo reverts the SORT (its own step), not the preceding `addWidget` …
    controller.undo();
    expect(controller.getState().doc.widgets.grid1).toBeTruthy();
    expect(controller.getState().doc.widgets.grid1.config).not.toMatchObject({
      gridSortField: 'revenue',
    });
    // … and the log line goes with it.
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addWidget:grid:grid1']);
  });

  it('updateWidgetConfig self-repair ({ undoable: false }) logs nothing; a genuine call still logs', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('kpi1', { kind: 'kpi', config: { kpiAggregation: 'sum' } }));
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addWidget:kpi:kpi1']);

    // Self-repair: e.g. `KpiSetupPanel`'s render-time repair of an invalid stored
    // aggregation. Must NOT add a log line.
    controller.updateWidgetConfig('kpi1', { kpiAggregation: 'avg' }, { undoable: false });
    expect(controller.getState().doc.widgets.kpi1.config).toMatchObject({
      kpiAggregation: 'avg',
    });
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['addWidget:kpi:kpi1']);
    // It also must not be reachable via undo as its own step: the self-repair never
    // pushed an undo entry, so the next undo() reverts the PRECEDING undoable commit
    // (`addWidget`) instead — removing the widget entirely, not merely reverting the
    // repaired config.
    controller.undo();
    expect(controller.getState().doc.widgets.kpi1).toBeUndefined();
    controller.redo();

    // A genuine (default-undoable) call to the SAME method still logs normally.
    controller.updateWidgetConfig('kpi1', { kpiAggregation: 'count' });
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'addWidget:kpi:kpi1',
      'updateWidget:kpi1',
    ]);
  });
});

// ─── Step B (1.6): identity-preserving no-op writers ─────────────────────────
// Each writer, called with an unknown/rejected target, must be a clean no-op:
// same state reference, no undo entry, no mutation-log line. A single anchor
// commit precedes each so a final undo proves the no-op added no step.

describe('StudioController — identity-preserving no-op writers (1.6)', () => {
  function relationship(id: string) {
    return {
      id,
      sourceId: 'a',
      sourceField: 'x',
      targetId: 'b',
      targetField: 'y',
      type: 'many-to-one' as const,
    };
  }

  const expressionField = {
    id: 'ef1',
    label: 'Margin',
    expression: { operator: 'subtract' as const, inputs: [{ id: 'revenue' }, { id: 'cost' }] },
    sourceId: 'orders',
    type: 'number' as const,
    isMeasure: false,
  };

  function assertNoOp(controller: StudioController, act: () => void) {
    controller.setDashboardTitle('anchor');
    const before = controller.getState();
    const undoBefore = controller.canUndo();
    const logBefore = controller.getRecentMutations();

    act();

    expect(controller.getState()).toBe(before);
    expect(controller.canUndo()).toBe(undoBefore);
    expect(controller.getRecentMutations()).toEqual(logBefore);
    // A single undo reverts only the anchor — proving the no-op added no step.
    expect(controller.undo()).toBe(true);
    expect(controller.canUndo()).toBe(false);
  }

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the shared assertNoOp helper
  it('updateFilter with an unknown id is a no-op', () => {
    const controller = new StudioController({ doc: { filters: [makeFilter({ id: 'f1' })] } });
    assertNoOp(controller, () => controller.updateFilter('does-not-exist', { value: 'x' }));
  });

  it('a rejected rank change is a no-op (no undo entry, no log line)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController({
      doc: {
        filters: [
          makeFilter({ id: 'rank-filter', filterMode: 'rank', rankDirection: 'top', value: 10 }),
          makeFilter({ id: 'condition-filter', filterMode: 'condition', value: 'foo' }),
        ],
      },
    });
    controller.setDashboardTitle('anchor');
    const before = controller.getState();
    const undoBefore = controller.canUndo();
    const logBefore = controller.getRecentMutations();

    controller.updateFilter('condition-filter', {
      filterMode: 'rank',
      value: 5,
      rankDirection: 'top',
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
    expect(controller.getState()).toBe(before);
    expect(controller.canUndo()).toBe(undoBefore);
    expect(controller.getRecentMutations()).toEqual(logBefore);
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the shared assertNoOp helper
  it('toggleFilter with an unknown id is a no-op', () => {
    const controller = new StudioController({ doc: { filters: [makeFilter({ id: 'f1' })] } });
    assertNoOp(controller, () => controller.toggleFilter('does-not-exist'));
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the shared assertNoOp helper
  it('updateRelationship / removeRelationship with an unknown id are no-ops', () => {
    const controller = new StudioController({ doc: { relationships: [relationship('r1')] } });
    assertNoOp(controller, () => {
      controller.updateRelationship('nope', { targetId: 'z' });
      controller.removeRelationship('nope');
    });
  });

  // T3.3: `addRelationship` had no duplicate-id guard (unlike `addExpressionField`'s
  // `.some(...)` bail), so a double-add — e.g. a re-delivered wire/AI `addRelationship`
  // event — appended a second entry sharing `id`, and `updateRelationship`/
  // `removeRelationship` (both keyed on `rel.id`) would then act on both at once.
  it('addRelationship with an already-existing id is a no-op (T3.3)', () => {
    const controller = new StudioController({ doc: { relationships: [relationship('r1')] } });
    assertNoOp(controller, () =>
      controller.addRelationship({ ...relationship('r1'), targetId: 'different-target' }),
    );
    expect(controller.getState().doc.relationships).toHaveLength(1);
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the shared assertNoOp helper
  it('deleteFilterPreset / renameFilterPreset with an unknown id are no-ops', () => {
    const controller = new StudioController({
      doc: { filterPresets: [{ id: 'p1', name: 'Preset', filters: [] }] },
    });
    assertNoOp(controller, () => {
      controller.deleteFilterPreset('nope');
      controller.renameFilterPreset('nope', 'X');
    });
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the shared assertNoOp helper
  it('removeExpressionField with an unknown id is a no-op', () => {
    const controller = new StudioController({ doc: { expressionFields: [expressionField] } });
    assertNoOp(controller, () => controller.removeExpressionField('nope'));
  });

  it('reorderPages with the current order is a no-op but a genuine reorder still commits', () => {
    const build = () =>
      new StudioController({
        doc: {
          dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
          pages: {
            'page-1': { id: 'page-1', title: 'One', widgetRows: [] },
            'page-2': { id: 'page-2', title: 'Two', widgetRows: [] },
          },
        },
      });

    const noop = build();
    assertNoOp(noop, () => noop.reorderPages(['page-1', 'page-2']));

    const reordered = build();
    reordered.setDashboardTitle('anchor');
    reordered.reorderPages(['page-2', 'page-1']);
    expect(Object.keys(reordered.getState().doc.pages)).toEqual(['page-2', 'page-1']);
    // L15: `expect(canUndo()).toBe(undoBefore)` used to stand here, and could not fail — it was
    // `true` before AND after, whichever way the reorder went. What actually distinguishes "a
    // new step was added" from "the reorder rode along on the anchor's step" is the DEPTH of the
    // undo stack, so undo twice and assert each step reverts exactly one thing.
    expect(reordered.undo()).toBe(true); // step 2: the reorder
    expect(Object.keys(reordered.getState().doc.pages)).toEqual(['page-1', 'page-2']);
    expect(reordered.getState().doc.dashboard.title).toBe('anchor'); // the anchor step survives
    expect(reordered.canUndo()).toBe(true);
    expect(reordered.undo()).toBe(true); // step 1: the anchor title
    expect(reordered.getState().doc.dashboard.title).not.toBe('anchor');
    expect(reordered.canUndo()).toBe(false);
  });
});

// ─── Step C (1.7): per-page rank-filter uniqueness scope ─────────────────────
// A rank filter is unique PER PAGE, not dashboard-wide: page filters gate on
// `pageId === activePageId` and widget rank filters are per-widget, so a rank
// filter on page-1 must not block one on page-2.

describe('StudioController.updateFilter — per-page rank scope (1.7)', () => {
  function twoPageController(filters: StudioFilterState[]) {
    return new StudioController({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [['w2']] },
        },
        widgets: { w1: makeWidget('w1'), w2: makeWidget('w2') },
        filters,
      },
    });
  }

  it('allows a rank filter on a different page than an existing one', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = twoPageController([
      makeFilter({
        id: 'rank-1',
        filterMode: 'rank',
        rankDirection: 'top',
        value: 10,
        scope: { kind: 'page', pageId: 'page-1' },
      }),
      makeFilter({
        id: 'cond-2',
        filterMode: 'condition',
        value: 'foo',
        scope: { kind: 'page', pageId: 'page-2' },
      }),
    ]);

    controller.updateFilter('cond-2', { filterMode: 'rank', value: 5, rankDirection: 'top' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    expect(controller.getState().doc.filters.find((f) => f.id === 'cond-2')?.filterMode).toBe(
      'rank',
    );
  });

  it('still rejects a second rank filter on the SAME page', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = twoPageController([
      makeFilter({
        id: 'rank-1',
        filterMode: 'rank',
        rankDirection: 'top',
        value: 10,
        scope: { kind: 'page', pageId: 'page-1' },
      }),
      makeFilter({
        id: 'cond-1',
        filterMode: 'condition',
        value: 'foo',
        scope: { kind: 'page', pageId: 'page-1' },
      }),
    ]);

    controller.updateFilter('cond-1', { filterMode: 'rank', value: 5, rankDirection: 'top' });

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
    expect(controller.getState().doc.filters.find((f) => f.id === 'cond-1')?.filterMode).toBe(
      'condition',
    );
  });

  it('a pageId-less page rank filter conflicts on every page', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = twoPageController([
      // No pageId → applies everywhere → conflicts everywhere.
      makeFilter({
        id: 'rank-global',
        filterMode: 'rank',
        rankDirection: 'top',
        value: 10,
        scope: { kind: 'page' },
      }),
      makeFilter({
        id: 'cond-2',
        filterMode: 'condition',
        value: 'foo',
        scope: { kind: 'page', pageId: 'page-2' },
      }),
    ]);

    controller.updateFilter('cond-2', { filterMode: 'rank', value: 5, rankDirection: 'top' });

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
    expect(controller.getState().doc.filters.find((f) => f.id === 'cond-2')?.filterMode).toBe(
      'condition',
    );
  });

  it('a widget rank filter blocks only its own page', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = twoPageController([
      // Rank filter on w1, which lives on page-1.
      makeFilter({
        id: 'rank-w1',
        filterMode: 'rank',
        rankDirection: 'top',
        value: 10,
        scope: { kind: 'widget', widgetId: 'w1' },
      }),
      makeFilter({
        id: 'cond-p1',
        filterMode: 'condition',
        value: 'foo',
        scope: { kind: 'page', pageId: 'page-1' },
      }),
      makeFilter({
        id: 'cond-p2',
        filterMode: 'condition',
        value: 'bar',
        scope: { kind: 'page', pageId: 'page-2' },
      }),
    ]);

    // Same page as the widget rank filter → rejected.
    controller.updateFilter('cond-p1', { filterMode: 'rank', value: 5, rankDirection: 'top' });
    expect(controller.getState().doc.filters.find((f) => f.id === 'cond-p1')?.filterMode).toBe(
      'condition',
    );
    expect(warnSpy).toHaveBeenCalledOnce();

    // Different page → allowed.
    controller.updateFilter('cond-p2', { filterMode: 'rank', value: 3, rankDirection: 'top' });
    expect(controller.getState().doc.filters.find((f) => f.id === 'cond-p2')?.filterMode).toBe(
      'rank',
    );
    expect(warnSpy).toHaveBeenCalledOnce(); // no further warning
    warnSpy.mockRestore();
  });

  // T3.3: the rank guard previously only ran when SWITCHING INTO rank mode
  // (`switchingToRank`). An already-rank filter re-pointed to a different page via
  // `changes.scope` bypassed it entirely, so two rank filters could land in the same
  // page context — no shipped UI patches `scope` on an existing filter, so this is
  // reachable only through this host API (e.g. a wire-driven `updateFilter`).
  it('rejects re-pointing an already-rank filter into a page that already has one (T3.3)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = twoPageController([
      makeFilter({
        id: 'rank-1',
        filterMode: 'rank',
        rankDirection: 'top',
        value: 10,
        scope: { kind: 'page', pageId: 'page-1' },
      }),
      makeFilter({
        id: 'rank-2',
        filterMode: 'rank',
        rankDirection: 'top',
        value: 5,
        scope: { kind: 'page', pageId: 'page-2' },
      }),
    ]);

    // rank-2 is ALREADY a rank filter; only its `scope` changes (no `filterMode` in the
    // payload), re-pointing it onto page-1, which already has rank-1.
    controller.updateFilter('rank-2', { scope: { kind: 'page', pageId: 'page-1' } });

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
    // Rejected: rank-2 keeps its original page-2 scope.
    expect(controller.getState().doc.filters.find((f) => f.id === 'rank-2')?.scope).toEqual({
      kind: 'page',
      pageId: 'page-2',
    });
  });

  it('allows re-pointing an already-rank filter to a page with no rank filter of its own', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = twoPageController([
      makeFilter({
        id: 'rank-2',
        filterMode: 'rank',
        rankDirection: 'top',
        value: 5,
        scope: { kind: 'page', pageId: 'page-2' },
      }),
    ]);

    controller.updateFilter('rank-2', { scope: { kind: 'page', pageId: 'page-1' } });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    expect(controller.getState().doc.filters.find((f) => f.id === 'rank-2')?.scope).toEqual({
      kind: 'page',
      pageId: 'page-1',
    });
  });
});

// ─── Step D (2.1 + 1.8): duplicateWidget rewrite ─────────────────────────────

describe('StudioController.duplicateWidget — rewrite (2.1 + 1.8)', () => {
  it('is a clean no-op when the active page is missing (1.8)', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const state = controller.getState();
    // Point the dashboard at a page that does not exist.
    controller.updateState({
      doc: { dashboard: { ...state.doc.dashboard, activePageId: 'ghost' } },
    });
    const before = controller.getState();
    // Must NOT throw a TypeError reading `activePage.widgetRows`; must no-op.
    controller.duplicateWidget('w1');
    expect(controller.getState()).toBe(before);
  });

  it('mints collision-free ids under rapid synchronous duplication (2.1)', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.duplicateWidget('w1');
    controller.duplicateWidget('w1');
    const ids = Object.keys(controller.getState().doc.widgets);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('collapses the duplicate (widget + cloned filters) into a single undo step', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.setWidgetDateRange('w1', 'orderDate', 'src1', 'date', 'last_3_months');
    const filtersBefore = controller.getState().doc.filters.length;

    controller.duplicateWidget('w1');
    expect(Object.keys(controller.getState().doc.widgets)).toHaveLength(2);
    expect(controller.getState().doc.filters).toHaveLength(filtersBefore + 1);

    controller.undo();
    expect(Object.keys(controller.getState().doc.widgets)).toHaveLength(1);
    expect(controller.getState().doc.filters).toHaveLength(filtersBefore);
  });

  it('remaps a managed date-range filter id to the copy so setWidgetDateRange replaces it', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.setWidgetDateRange('w1', 'orderDate', 'src1', 'date', 'last_3_months');

    controller.duplicateWidget('w1');
    const copyId = Object.keys(controller.getState().doc.widgets).find((id) => id !== 'w1')!;
    const clonedDate = controller
      .getState()
      .doc.filters.find((f) => f.scope.kind === 'widget' && f.scope.widgetId === copyId);
    expect(clonedDate?.id).toBe(`widget-date-range-${copyId}`);

    // Setting the copy's date range must REPLACE the cloned managed filter, not stack.
    controller.setWidgetDateRange(copyId, 'orderDate', 'src1', 'date', 'this_month');
    const copyDateFilters = controller
      .getState()
      .doc.filters.filter((f) => f.id === `widget-date-range-${copyId}`);
    expect(copyDateFilters).toHaveLength(1);
    expect(copyDateFilters[0].dateRangePreset).toBe('this_month');
  });

  it('logs under the addWidget label shape, like every other creation path', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.duplicateWidget('w1');

    const labels = controller.getRecentMutations().map((m) => m.label);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toBe('addWidget:kpi:w1');
    // The copy's id is minted inside `duplicateWidget`, so match the shape, not the id.
    expect(labels[1]).toMatch(/^addWidget:kpi:widget-/);
    // Not the fold's default join — the log records the user's action, not the internal
    // `addWidget + setWidgetLayout + addFilter` composition it is implemented with.
    expect(labels[1]).not.toContain('setWidgetLayout');
  });

  it('runs the reducer col-span normalization (row spans stay within GRID_COLS)', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    controller.setWidgetLayout([['w1', 'w2']]);
    controller.setAdjacentWidgetColSpans('w1', 12, 'w2', 12); // sum to GRID_COLS

    controller.duplicateWidget('w1');
    const activePageId = controller.getState().doc.dashboard.activePageId;
    const page = controller.getState().doc.pages[activePageId];
    const spans = page.widgetColSpans ?? {};
    const row = page.widgetRows.find((r) => r.includes('w1'))!;
    const sum = row.reduce((acc, id) => acc + (spans[id] ?? 0), 0);
    expect(sum).toBeLessThanOrEqual(GRID_COLS);
  });
});

// ─── Step E (1.1): transient doc state vs. undo/redo ─────────────────────────

describe('StudioController — transient doc state across undo/redo (1.1)', () => {
  it('carries an interactive filter across undo, and prunes it when its source widget is reverted away', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('fw', { kind: 'filter' })); // undoable step 1
    controller.applyInteractiveFilter('fw', 'category', 'in', ['Books']); // non-undoable
    controller.addWidget(makeWidget('w2')); // undoable step 2

    // Undo step 2: the filter widget still exists → the interactive filter survives.
    controller.undo();
    expect(
      controller
        .getState()
        .doc.filters.some((f) => f.scope.kind === 'interactive' && f.scope.sourceWidgetId === 'fw'),
    ).toBe(true);

    // Undo step 1 (removes the filter widget): the interactive filter now dangles → pruned.
    controller.undo();
    expect(controller.getState().doc.filters.some((f) => f.scope.kind === 'interactive')).toBe(
      false,
    );
  });

  it('redo does not destroy a transient selection applied after the undo', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1')); // undoable
    controller.setDashboardTitle('New'); // undoable
    controller.undo(); // reverts the title

    // A transient interactive filter selection lands AFTER the undo.
    controller.applyInteractiveFilter('w1', 'category', 'in', ['Books']);
    expect(controller.canRedo()).toBe(true); // non-undoable action did NOT clear redo

    controller.redo(); // reapplies the title
    expect(controller.getState().doc.dashboard.title).toBe('New');
    // ...and the interactive filter is preserved, exactly once (not resurrected/duplicated).
    expect(
      controller.getState().doc.filters.filter((f) => f.scope.kind === 'interactive'),
    ).toHaveLength(1);

    controller.undo(); // reverts the title again
    expect(controller.getState().doc.dashboard.title).not.toBe('New');
    expect(
      controller.getState().doc.filters.filter((f) => f.scope.kind === 'interactive'),
    ).toHaveLength(1);
  });

  // L15: this used to be "does not resurrect a cleared selection on undo", which could not
  // fail — `undo()` swaps only `doc`/`session`, the undo stack is typed `StudioDoc[]` (so it
  // holds no session state to resurrect), and its ONE session transform
  // (`normalizeSessionAfterDocSwap`) can only ever set `selectedWidgetId` to `null`, never to a
  // value. There is no code path that could make that assertion go red. What IS observable —
  // and is what `normalizeSessionAfterDocSwap` actually decides — is the branch it takes:
  // leave a selection whose widget survived the swap alone, null one whose widget did not.
  it('keeps a selection whose widget survives an undo and nulls one the undo removed', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1')); // selects w1; undoable
    controller.setDashboardTitle('New'); // undoable
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');

    controller.undo(); // reverts the title only — w1 is still in the doc
    expect(controller.getState().doc.widgets.w1).toBeTruthy();
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');

    controller.undo(); // reverts the addWidget — the selected widget is gone
    expect(controller.getState().doc.widgets.w1).toBeUndefined();
    expect(controller.getState().session.shell.selectedWidgetId).toBeNull();
  });

  it('carries dashboard cross-filter toggles across undo and redo without an undo step', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Anchor'); // the only undoable step
    controller.setGlobalCrossFilterMode('cross-filter'); // non-undoable
    controller.setCrossFilterAllPages(true); // non-undoable

    controller.undo(); // reverts the title
    expect(controller.getState().doc.dashboard.globalCrossFilterMode).toBe('cross-filter');
    expect(controller.getState().doc.dashboard.crossFilterAllPages).toBe(true);
    expect(controller.getState().doc.dashboard.title).not.toBe('Anchor');
    // The toggles were not undo steps: nothing left to undo.
    expect(controller.canUndo()).toBe(false);

    controller.redo(); // reapplies the title
    expect(controller.getState().doc.dashboard.title).toBe('Anchor');
    expect(controller.getState().doc.dashboard.globalCrossFilterMode).toBe('cross-filter');
    expect(controller.getState().doc.dashboard.crossFilterAllPages).toBe(true);
  });

  it('carries the active page across undo (navigation is not reverted by an unrelated edit)', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
      },
    });
    controller.setDashboardTitle('Anchor'); // the only undoable step
    controller.setActivePage('page-2'); // non-undoable navigation

    controller.undo(); // reverts the title only
    // Navigation is preserved — undo must not jump the user back to page-1.
    expect(controller.getState().doc.dashboard.activePageId).toBe('page-2');
    expect(controller.getState().doc.dashboard.title).not.toBe('Anchor');
    // The navigation was not an undo step: nothing left to undo.
    expect(controller.canUndo()).toBe(false);
  });

  it('carries the active page across redo (navigation is not reverted by an unrelated edit)', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
      },
    });
    controller.setDashboardTitle('Anchor'); // undoable
    controller.undo(); // present title reverted; redo holds "Anchor"
    controller.setActivePage('page-2'); // navigate after the undo

    controller.redo(); // reapplies the title
    expect(controller.getState().doc.dashboard.title).toBe('Anchor');
    // Navigation carried forward across the redo, not reset to page-1.
    expect(controller.getState().doc.dashboard.activePageId).toBe('page-2');
  });

  it('restores the SAME doc reference on undo when there is no transient state', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const docAfterAdd = controller.getState().doc;
    controller.setDashboardTitle('New');

    controller.undo();
    // L15: `toEqual` used to stand here and could not fail — with no transient state
    // `carryTransientDocState` returns `incomingDoc` BY REFERENCE, so `toEqual` compared the
    // snapshot to itself. `toBe` asserts the identity preservation the test's name implies:
    // a transient-free history hands the snapshot straight back rather than rebuilding it
    // (which would churn every `useStudioSelector` subscribed to a doc slice).
    expect(controller.getState().doc).toBe(docAfterAdd);
  });

  it('still time-travels cross-filters (undoable), unlike interactive filters', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1', { kind: 'chart' }));
    controller.applyCrossFilter('w1', 'category', 'Books'); // undoable
    expect(controller.getState().doc.filters.some((f) => f.scope.kind === 'cross-filter')).toBe(
      true,
    );

    controller.undo(); // cross-filters ARE time-travelled → reverted
    expect(controller.getState().doc.filters.some((f) => f.scope.kind === 'cross-filter')).toBe(
      false,
    );
  });

  // `doc.ai` is the third transient-carried field (alongside the cross-filter toggles and
  // `activePageId`), and the only one whose loss is UNRECOVERABLE: `useChatThreads` writes
  // chat history NON-undoably, so the undo snapshot taken before an unrelated authored edit
  // predates the whole conversation. Without the carry, one Ctrl+Z swaps that snapshot in and
  // the thread is gone — and the very next edit clears the redo stack, so it can never come
  // back. Both `ARCHITECTURE.md` ("Undo/redo cross-partition fix-ups") and the block comment
  // at the carry state this contract; until now nothing asserted it.
  function writeChatThreadNonUndoably(controller: StudioController, threadId: string) {
    // Mirrors `useChatThreads`' `onMessagesChange` write-back exactly: a whole-state
    // `setState` with `{ undoable: false }`, because it fires on every streamed token delta.
    const state = controller.getState();
    controller.setState(
      {
        ...state,
        doc: {
          ...state.doc,
          ai: {
            threads: [
              {
                id: threadId,
                name: 'Conversation',
                createdAt: '2024-01-01T00:00:00.000Z',
                messages: [],
              },
            ],
            activeThreadId: threadId,
          },
        },
      },
      { undoable: false },
    );
  }

  it('carries doc.ai (chat history) across undo — Ctrl+Z on an unrelated edit does not destroy the conversation', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Anchor'); // the only undoable step; its snapshot has no `ai`
    writeChatThreadNonUndoably(controller, 't1');
    expect(controller.getState().doc.ai?.threads).toHaveLength(1);

    controller.undo(); // reverts the title only

    expect(controller.getState().doc.dashboard.title).not.toBe('Anchor');
    expect(controller.getState().doc.ai?.threads).toHaveLength(1);
    expect(controller.getState().doc.ai?.threads[0].id).toBe('t1');
    expect(controller.getState().doc.ai?.activeThreadId).toBe('t1');
    // The chat write was not an undo step of its own: nothing left to undo.
    expect(controller.canUndo()).toBe(false);
  });

  it('carries doc.ai (chat history) across redo too', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Anchor'); // undoable
    controller.undo(); // redo now holds the doc WITH the title but WITHOUT any `ai`
    writeChatThreadNonUndoably(controller, 't1'); // conversation starts after the undo

    controller.redo(); // reapplies the title

    expect(controller.getState().doc.dashboard.title).toBe('Anchor');
    expect(controller.getState().doc.ai?.threads).toHaveLength(1);
    expect(controller.getState().doc.ai?.threads[0].id).toBe('t1');
  });
});

// ─── 2.7: duplicateWidget honours the one-rank-filter-per-page invariant ──────
// `duplicateWidget` clones a widget's widget-scoped filters and commits them via raw
// `addFilter` mutations (which the reducer applies verbatim, no rank check). The clone lands
// on the SAME page as the source, so a cloned rank filter would resolve to the same page
// context as the source's own rank filter — the exact "two rank filters per page" state
// `addFilter`/`updateFilter` reject and the filters drawer assumes cannot exist.
describe('StudioController.duplicateWidget — rank-filter uniqueness (2.7)', () => {
  it('drops a cloned widget-scoped rank filter that would conflict on the page', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addFilter(
      makeFilter({
        id: 'rank1',
        filterMode: 'rank',
        rankDirection: 'top',
        value: 10,
        scope: { kind: 'widget', widgetId: 'w1' },
      }),
    );

    controller.duplicateWidget('w1');

    // Exactly one rank filter survives — the source's own. The clone's rank filter was dropped
    // guard-and-continue style rather than persisting a second rank filter on the page.
    const rankFilters = controller.getState().doc.filters.filter((f) => f.filterMode === 'rank');
    expect(rankFilters).toHaveLength(1);
    expect(rankFilters[0].scope).toEqual({ kind: 'widget', widgetId: 'w1' });
    warnSpy.mockRestore();
  });

  it('still clones non-rank widget-scoped filters onto the copy', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addFilter(
      makeFilter({
        id: 'cond1',
        filterMode: 'condition',
        value: 'foo',
        scope: { kind: 'widget', widgetId: 'w1' },
      }),
    );

    controller.duplicateWidget('w1');

    const copyId = Object.keys(controller.getState().doc.widgets).find((id) => id !== 'w1')!;
    const clonedForCopy = controller
      .getState()
      .doc.filters.filter((f) => f.scope.kind === 'widget' && f.scope.widgetId === copyId);
    // The condition filter is cloned onto the copy (guard-and-continue only drops rank filters).
    expect(clonedForCopy).toHaveLength(1);
    expect(clonedForCopy[0]).toMatchObject({ filterMode: 'condition', value: 'foo' });
  });
});

// ─── 2.9: upsertDataSource same-reference guard (refetch-loop hazard) ──────────
describe('StudioController.upsertDataSource — same-reference guard (2.9)', () => {
  it('re-injecting the identical source object is a clean no-op (no invalidation, no commit)', () => {
    // Regression (2.9): a host re-injecting the SAME source object from an effect/poller would
    // otherwise bump the source generation, evict every cached adapter result, and mark
    // in-flight requests stale on every call — an unbounded refetch loop paired with
    // `onStateChange`. `setDataSourceAdapter` already had this guard; `upsertDataSource` did not.
    const controller = new StudioController();
    const source = {
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' as const }],
      rows: [{ amount: 1 }],
    };
    controller.upsertDataSource(source);

    const stateBefore = controller.getState();
    const spy = vi.spyOn(studioRequestCache, 'invalidateSource');
    try {
      controller.upsertDataSource(source); // same reference re-injected
      expect(spy).not.toHaveBeenCalled();
      expect(controller.getState()).toBe(stateBefore);
    } finally {
      spy.mockRestore();
    }
  });

  it('a content-equal but distinct object still invalidates and commits (only reference identity short-circuits)', () => {
    const controller = new StudioController();
    controller.upsertDataSource({
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [{ amount: 1 }],
    });
    const spy = vi.spyOn(studioRequestCache, 'invalidateSource');
    try {
      // A fresh object (as a config-swap reload produces) is NOT reference-equal, so it must
      // still replace the entry and invalidate — the guard only short-circuits identity.
      controller.upsertDataSource({
        id: 'orders',
        label: 'Orders',
        fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
        rows: [{ amount: 2 }],
      });
      expect(spy).toHaveBeenCalledWith('orders');
      expect(controller.getState().runtime.dataSources.orders.rows).toEqual([{ amount: 2 }]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── 2.10: phantom redo-clearing commits eliminated on value-identical writes ──
// `setPageStackBreakpoint` / `updateActivePage` / `updateRelationship` each built a fresh
// object unconditionally (`{ ...page, ...changes }` / `{ ...rel, ...patch }`), defeating
// `commitDocPatch`'s reference-equality no-op guard even for a value-identical write — so
// re-confirming a value the doc already holds wiped a pending redo stack.
describe('StudioController — value-identical page/relationship writes are no-ops (2.10)', () => {
  it('setPageStackBreakpoint re-confirming the current value preserves the redo stack', () => {
    const controller = new StudioController();
    controller.setPageStackBreakpoint(600);
    controller.setDashboardTitle('edit'); // second undoable edit
    controller.undo(); // reverts the title; breakpoint stays 600; redo now pending
    expect(controller.canRedo()).toBe(true);

    const before = controller.getState();
    controller.setPageStackBreakpoint(600); // re-confirm the value the page already has

    expect(controller.getState()).toBe(before); // no commit
    expect(controller.canRedo()).toBe(true); // redo NOT wiped
  });

  it('updateActivePage re-confirming the current value preserves the redo stack', () => {
    const controller = new StudioController();
    controller.updateActivePage({ title: 'Renamed' });
    controller.setDashboardTitle('edit');
    controller.undo(); // reverts the title; active page title stays 'Renamed'; redo pending
    expect(controller.canRedo()).toBe(true);

    const before = controller.getState();
    controller.updateActivePage({ title: 'Renamed' }); // value-identical

    expect(controller.getState()).toBe(before);
    expect(controller.canRedo()).toBe(true);
  });

  it('updateRelationship with a value-identical patch preserves the redo stack', () => {
    const controller = new StudioController({
      doc: {
        relationships: [
          {
            id: 'r1',
            sourceId: 'a',
            sourceField: 'x',
            targetId: 'b',
            targetField: 'y',
            type: 'many-to-one' as const,
          },
        ],
      },
    });
    controller.setDashboardTitle('edit');
    controller.undo(); // redo pending
    expect(controller.canRedo()).toBe(true);

    const before = controller.getState();
    controller.updateRelationship('r1', { targetId: 'b' }); // already 'b' — value-identical

    expect(controller.getState()).toBe(before);
    expect(controller.canRedo()).toBe(true);

    // A genuine change still commits (and clears redo), proving the guard isn't over-broad.
    controller.updateRelationship('r1', { targetId: 'c' });
    expect(controller.getState().doc.relationships[0].targetId).toBe('c');
    expect(controller.canRedo()).toBe(false);
  });

  // ─── 2.6: the two sibling writers iter-9 missed ───
  it('updateExpressionField with value-identical updates preserves the redo stack (2.6)', () => {
    const controller = new StudioController({
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
    controller.setDashboardTitle('edit');
    controller.undo(); // redo pending
    expect(controller.canRedo()).toBe(true);

    const before = controller.getState();
    // Re-saving the expression dialog with no edits (open, glance, hit Save).
    controller.updateExpressionField('ef1', { label: 'Margin' });

    expect(controller.getState()).toBe(before); // no commit
    expect(controller.canRedo()).toBe(true); // redo NOT wiped

    // A genuine change still commits (and clears redo), proving the guard isn't over-broad.
    controller.updateExpressionField('ef1', { label: 'Gross Margin' });
    expect(controller.getState().doc.expressionFields[0].label).toBe('Gross Margin');
    expect(controller.canRedo()).toBe(false);
  });

  it('updateFilter with a value-identical changes payload preserves the redo stack (2.6)', () => {
    const controller = new StudioController({
      doc: { filters: [makeFilter({ id: 'f1', operator: 'equals', value: 'foo' })] },
    });
    controller.setDashboardTitle('edit');
    controller.undo(); // redo pending
    expect(controller.canRedo()).toBe(true);

    const before = controller.getState();
    // A drawer control re-committing its current value on blur.
    controller.updateFilter('f1', { operator: 'equals', value: 'foo' });

    expect(controller.getState()).toBe(before); // no commit
    expect(controller.canRedo()).toBe(true); // redo NOT wiped

    // A genuine change still commits (and clears redo), proving the guard isn't over-broad.
    controller.updateFilter('f1', { value: 'bar' });
    expect(controller.getState().doc.filters[0].value).toBe('bar');
    expect(controller.canRedo()).toBe(false);
  });
});

// ─── 2.11: transient-only wire mutations are still surfaced to the change log ──
// `commitState` previously pushed the mutation-log label ONLY inside the undoable branch, so
// the non-undoable `setActivePage` / `renameAIThread` routed through `applyExternalMutation`
// were silently dropped — contradicting `applyExternalMutation`'s "logging unchanged" contract
// and `setActivePage`'s "only the AI-driven path logs setActivePage" comment.
describe('StudioController.applyExternalMutation — transient mutations are logged (2.11)', () => {
  it('records a mutation-log line for a non-undoable setActivePage from the wire', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
      },
    });

    controller.applyExternalMutation({ type: 'setActivePage', args: { pageId: 'page-2' } });

    expect(controller.getRecentMutations().map((m) => m.label)).toContain('setActivePage:page-2');
  });

  it('records a mutation-log line for a non-undoable renameAIThread from the wire', () => {
    const controller = new StudioController({
      doc: {
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old name', createdAt: '2020-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      },
    });

    controller.applyExternalMutation({
      type: 'renameAIThread',
      args: { name: 'New name', updatedAt: '2020-02-02T00:00:00.000Z', threadId: 't1' },
    });

    expect(controller.getRecentMutations().map((m) => m.label)).toContain('renameAIThread');
  });

  it('user-driven setActivePage stays unlogged (label: null) — only the wire path logs it', () => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
      },
    });

    controller.setActivePage('page-2'); // user navigation

    expect(controller.getRecentMutations()).toEqual([]);
  });
});

// ── Chart-type repair is applied at EVERY widget-creation boundary (finding M1) ──────────────
//
// `addWidget`'s own comment claims to "mirror the validate-at-every-mutation-boundary
// convention", but the convention had two holes: `insertWidgetAt` (public API, the compose
// drawer's drop-at-position path) installed a hostile `chartType` verbatim, and
// `duplicateWidget` then propagated it into the copy. The shared reducer's `addWidget` handler
// validates record-ness and `kind`/`title` string-ness but deliberately knows nothing about
// chart types, so the repair lives in the controller — and must run from all three entry points.

describe('StudioController — chart-type repair at every creation boundary', () => {
  const hostileConfig = {
    chartType: '__proto__evil',
    sankeyTargetField: 't',
    xField: 'a',
  } as unknown as StudioWidgetConfig;

  it('insertWidgetAt repairs an invalid chartType instead of installing it verbatim', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;

    controller.insertWidgetAt(
      makeWidget('chart-insert', { kind: 'chart', config: hostileConfig }),
      pageId,
      [['chart-insert']],
    );

    const config = controller.getState().doc.widgets['chart-insert'].config as StudioWidgetConfig;
    expect(config.chartType).toBe('bar');
    // The keys authored for the bogus chart type go with it; `xField` is valid for 'bar'.
    expect('sankeyTargetField' in config).toBe(false);
    expect(config.xField).toBe('a');

    warnSpy.mockRestore();
  });

  it('duplicateWidget repairs an invalid chartType rather than propagating it to the copy', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // HISTORY, because it decides whether this test is still worth its weight.
    //
    // This repair was first reported as unreachable, then shown to BE reachable through
    // two ordinary public calls: create a NON-chart widget carrying a bogus
    // `config.chartType` (`sanitizeWidgetForCreate` returns early on
    // `kind !== 'chart'`), then `updateWidget(id, { kind: 'chart' })` with no `config`
    // in `changes` — which used to skip the controller's chart-type guard, while the
    // reducer's kind-coherence pass RETAINED `chartType` because it is a valid 'chart'
    // key. BOTH halves of that route are now closed, in two separate places:
    //  - `updateWidget` re-runs `sanitizeWidgetForCreate` on a kind-only flip to 'chart'
    //    (the test below pins it), and
    //  - the shared reducer now screens `config.chartType` on EVERY channel
    //    (`screenOptionalWidgetScalars` on the two ADD channels, `stripInvalidChartType` on
    //    the three UPDATE ones), so the PLANTING step no longer works either: an invalid
    //    `chartType` is stripped on the way in regardless of the widget's `kind`, which is
    //    why this test can no longer set up via `insertWidgetAt` on a `text` widget.
    //
    // So no supported call sequence now reaches a chart-kind widget with a chart type
    // outside `StudioChartType`, and this repair is DEFENSE IN DEPTH. The test says so by
    // reaching in through the controller's PUBLIC `store` field rather than pretending a
    // mutation route exists.
    //
    // The repair is emphatically NOT dead code, for two reasons worth stating so nobody
    // deletes it on a redundancy argument:
    //  1. It is live and reachable for a CHART-kind widget at all three creation entry
    //     points — the `insertWidgetAt` test above exercises exactly that, through the
    //     public API, with no reach-in.
    //  2. It does strictly MORE than the reducer's screen. The reducer DELETES an invalid
    //     `chartType` key; this repairs it to `'bar'` AND strips the config keys authored
    //     for the bogus type (`sankeyTargetField` below). Remove it and the reducer alone
    //     leaves a chart with no `chartType` and a stray sankey key.
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['src']] } },
        widgets: {},
      },
    });
    controller.insertWidgetAt(makeWidget('src', { kind: 'text' }), 'page-1', [['src']]);
    // NOT a supported route — every mutation channel screens `config.chartType` now, and
    // `updateWidget('src', { kind: 'chart' })` would additionally repair it on the way in.
    // Reaching into the store is the honest way to construct the state a defense-in-depth
    // guard exists for.
    const reached = controller.getState();
    controller.store.setState({
      ...reached,
      doc: {
        ...reached.doc,
        widgets: {
          ...reached.doc.widgets,
          src: { ...reached.doc.widgets.src, kind: 'chart', config: hostileConfig },
        },
      },
    });

    // Precondition: the state really does hold an invalid chart type on a chart-kind
    // widget, so the clone assertions below exercise the repair rather than a
    // nothing-to-repair no-op.
    expect(controller.getState().doc.widgets.src.kind).toBe('chart');
    expect((controller.getState().doc.widgets.src.config as StudioWidgetConfig).chartType).toBe(
      '__proto__evil',
    );

    controller.duplicateWidget('src');

    const widgets = controller.getState().doc.widgets;
    const cloneId = Object.keys(widgets).find((id) => id !== 'src')!;
    const cloneConfig = widgets[cloneId].config as StudioWidgetConfig;
    expect(cloneConfig.chartType).toBe('bar');
    expect('sankeyTargetField' in cloneConfig).toBe(false);
    // The source widget is untouched — duplication is not a repair of the original.
    expect((widgets.src.config as StudioWidgetConfig).chartType).toBe('__proto__evil');

    warnSpy.mockRestore();
  });

  it('updateWidget repairs an invalid stored chartType on a kind-only flip to chart', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The gap this closes: `updateWidget`'s chart-type guard is gated on
    // `Object.hasOwn(changes, 'config')`, so `{ kind: 'chart' }` with no `config` used to
    // skip it. The reducer's kind-coherence pass STILL does not cover it — it strips keys
    // not ALLOWED for the new kind, and `chartType` is an allowed 'chart' key, so a bogus
    // VALUE is retained. This controller-side repair is the only thing that fixes it, which
    // is why the guard stays even though the state below now needs a reach-in to build.
    //
    // The SETUP changed, the guard did not. The original route in was
    // `insertWidgetAt` a `text` widget carrying the bogus `chartType` (which
    // `sanitizeWidgetForCreate` skips on `kind !== 'chart'`) and then flip the kind. The
    // shared reducer now screens `config.chartType` on every channel regardless of the
    // widget's kind (`screenOptionalWidgetScalars`), so the plant is stripped on the way in
    // and that precondition is unreachable through any mutation. Build it through the
    // controller's public `store` field instead — same state, honestly labelled — rather
    // than delete a guard whose failure mode (a chart rendering blank, then every later AI
    // `update_widget` hard-erroring on the unknown stored chartType) is still live for
    // anything that writes state directly.
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['src']] } },
        widgets: {},
      },
    });
    controller.insertWidgetAt(makeWidget('src', { kind: 'text' }), 'page-1', [['src']]);
    const reached = controller.getState();
    controller.store.setState({
      ...reached,
      doc: {
        ...reached.doc,
        widgets: {
          ...reached.doc.widgets,
          src: { ...reached.doc.widgets.src, config: hostileConfig },
        },
      },
    });
    // Precondition: the bogus chart type really is on the stored widget, so the assertion
    // below tests the repair rather than an already-clean config.
    expect((controller.getState().doc.widgets.src.config as StudioWidgetConfig).chartType).toBe(
      '__proto__evil',
    );
    expect(controller.getState().doc.widgets.src.kind).toBe('text');

    controller.updateWidget('src', { kind: 'chart' });

    const config = controller.getState().doc.widgets.src.config as StudioWidgetConfig;
    expect(controller.getState().doc.widgets.src.kind).toBe('chart');
    expect(config.chartType).toBe('bar');
    // The repair drops keys authored for the bogus type, and keeps those valid for 'bar'.
    expect('sankeyTargetField' in config).toBe(false);
    expect(config.xField).toBe('a');

    warnSpy.mockRestore();
  });

  it('updateWidget leaves a valid stored config untouched on a kind-only flip to chart', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The other half of the guard: the repair must not fire when there is nothing to
    // repair. `sanitizeWidgetForCreate` returns the SAME widget reference when the stored
    // `chartType` is valid (or absent), and the controller only adds `config` to the
    // mutation when that reference changed — so an ordinary kind flip keeps its existing
    // shape and cannot push a spurious undo entry.
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['src']] } },
        widgets: {},
      },
    });
    controller.insertWidgetAt(
      makeWidget('src', { kind: 'kpi', config: { kpiValueField: 'revenue' } }),
      'page-1',
      [['src']],
    );

    controller.updateWidget('src', { kind: 'chart' });

    const config = controller.getState().doc.widgets.src.config as StudioWidgetConfig;
    expect(controller.getState().doc.widgets.src.kind).toBe('chart');
    // No `chartType` was invented — an ABSENT chart type is the sanctioned "defaults to
    // bar" shape `resolveChartType` applies, and the repair deliberately does not touch it.
    expect('chartType' in config).toBe(false);
    // No repair warning fired, because nothing was repaired.
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('invalid chartType'))).toBe(
      false,
    );

    warnSpy.mockRestore();
  });

  it('leaves a valid chartType alone on insertWidgetAt (no spurious repair or warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;

    controller.insertWidgetAt(
      makeWidget('chart-ok', {
        kind: 'chart',
        config: { chartType: 'gauge', yField: 'revenue', gaugeMax: 100 },
      }),
      pageId,
      [['chart-ok']],
    );

    const config = controller.getState().doc.widgets['chart-ok'].config as StudioWidgetConfig;
    expect(config.chartType).toBe('gauge');
    expect(config.gaugeMax).toBe(100);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

// ── Prototype-chain key lookups on doc / caller-authored ids (finding M5) ────────────────────
//
// `doc.pages`, `doc.widgets` and `runtime.dataSources` are plain-object `Record`s, so a bare
// `map[id]` walks the prototype chain: `pages['constructor']` is the `Object` FUNCTION and is
// TRUTHY, which defeats every `if (!page) return;` existence check. `Object.hasOwn` is the
// convention `selectors.ts` and several controller methods already document; these cover the
// siblings that did not.

describe('StudioController — inherited-key ids never resolve as real entries', () => {
  const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'] as const;

  function makeTwoPageController() {
    return new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
      },
    });
  }

  // The consequential one: `reorderPages` is on the public `StudioHandle`. Before the guard it
  // COMMITTED `pages.constructor` (the `Object` function) into `doc.pages` as a real page, so
  // every later `Object.values(doc.pages)` iterated a function and the page tabs rendered a
  // bogus entry.
  it.each(PROTO_KEYS)(
    'reorderPages(["%s", ...]) never writes a prototype value into doc.pages',
    (protoKey) => {
      const controller = makeTwoPageController();

      controller.reorderPages([protoKey, 'page-2', 'page-1']);

      const pages = controller.getState().doc.pages;
      expect(Object.keys(pages)).toEqual(['page-2', 'page-1']);
      expect(Object.values(pages).every((p) => typeof p === 'object')).toBe(true);
    },
  );

  // A page legitimately NAMED with a prototype member must not be dropped by the "append
  // omitted pages" fallback, which read back a truthy inherited function from the fresh `{}`
  // accumulator and silently skipped the page.
  //
  // WHICH names, exactly. `PROTO_KEYS` above mixes two populations, and they get different
  // answers — this test covers the KEEP half, the one below covers the DROP half:
  //
  //  - `toString`/`valueOf`/`hasOwnProperty` are `Object.prototype` members and nothing else.
  //    They are what the package-wide conversion to `Object.hasOwn` was FOR: no lookup
  //    resolves them up the chain any more, so there is no reason to drop a user's page named
  //    one of them, and no boundary does.
  //  - `constructor`/`prototype`/`__proto__` are `UNSAFE_KEYS` (`unsafeKeys.ts`) — the
  //    three-name pollution denylist every boundary in `@mui/x-studio-schema` screens against.
  //
  // This test used to assert `constructor` was KEPT. It was only ever true of the factory,
  // which was the one page producer with no screen at all; the load boundary
  // (`normalizePersistedPages`) has always dropped it, so the page this asserted we kept
  // vanished on the very next reload. See the sibling test below.
  it.each(['toString', 'valueOf', 'hasOwnProperty'])(
    'keeps a page whose id is the Object.prototype member name "%s"',
    (protoKey) => {
      const controller = new StudioController({
        doc: {
          dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
            [protoKey]: { id: protoKey, title: 'Odd', widgetRows: [] },
          },
        },
      });

      controller.reorderPages(['page-1']);

      const pages = controller.getState().doc.pages;
      expect(Object.keys(pages).sort()).toEqual([protoKey, 'page-1'].sort());
      expect(pages[protoKey]).toMatchObject({ id: protoKey, title: 'Odd' });
    },
  );

  // The DROP half, and the reason the test above no longer claims `constructor`.
  //
  // `constructor`/`prototype`/`__proto__` are dropped by EVERY boundary that can produce a
  // `doc`: the wire boundary rejects the id (`parseStateMutation`'s `isValidId`), the reducer
  // refuses to mint the page (`addPage`'s `isSafePatchKey` gate — whose comment names deferred
  // data loss as the motive), the persistence loader drops it (`normalizePersistedPages`), and
  // as of the round-3 `screenPagesShape` fix so does this factory. Before that fix the factory
  // was the ONLY producer that kept such a page, which is the worse failure mode, not the
  // better one: the page lived until the first save/reload and then disappeared with no error.
  //
  // The tradeoff is real and deliberate — a hand-authored `initialState` naming a page
  // `constructor` loses that page — and is accepted because one consistent answer at four
  // boundaries beats three different ones. Note this is NOT a prototype-pollution claim about
  // `constructor`: the maps are rebuilt with `Object.fromEntries`/spread (define semantics),
  // so it could not pollute here any more than `toString` could. It is denylist membership.
  it.each(['constructor', 'prototype', '__proto__'])(
    'drops a page keyed with the pollution-denylist name "%s", matching the load boundary',
    (unsafeKey) => {
      const controller = new StudioController({
        doc: {
          dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
          // `JSON.parse`, not an object literal: `{ __proto__: … }` in a literal invokes the
          // setter instead of creating the own key this screen is about.
          pages: JSON.parse(
            `{"page-1":{"id":"page-1","title":"Page 1","widgetRows":[]},` +
              `"${unsafeKey}":{"id":"${unsafeKey}","title":"Odd","widgetRows":[]}}`,
          ),
        },
      });

      controller.reorderPages(['page-1']);

      const pages = controller.getState().doc.pages;
      expect(Object.keys(pages)).toEqual(['page-1']);
      expect(Object.hasOwn(pages, unsafeKey)).toBe(false);
      // The map itself is untouched — nothing was re-prototyped on the way through.
      expect(Object.getPrototypeOf(pages)).toBe(Object.prototype);
    },
  );

  it.each(PROTO_KEYS)('setActivePage("%s") does not navigate anywhere', (protoKey) => {
    const controller = makeTwoPageController();

    controller.setActivePage(protoKey);

    expect(controller.getState().doc.dashboard.activePageId).toBe('page-1');
  });

  it.each(PROTO_KEYS)('duplicateWidget("%s") is a clean no-op', (protoKey) => {
    const controller = new StudioController({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] } },
        widgets: { w1: makeWidget('w1') },
      },
    });

    expect(() => controller.duplicateWidget(protoKey)).not.toThrow();
    expect(Object.keys(controller.getState().doc.widgets)).toEqual(['w1']);
  });

  it.each(PROTO_KEYS)(
    'moveWidgetToPage(w1, "%s") does not move onto a nonexistent page',
    (protoKey) => {
      const controller = new StudioController({
        doc: {
          dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] },
            'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
          },
          widgets: { w1: makeWidget('w1') },
        },
      });

      controller.moveWidgetToPage('w1', protoKey);

      expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['w1']]);
      expect(controller.getState().doc.pages['page-2'].widgetRows).toEqual([]);
    },
  );

  it.each(PROTO_KEYS)('data-source writers no-op for an inherited source id "%s"', (protoKey) => {
    const controller = new StudioController();
    const before = controller.getState().runtime.dataSources;

    expect(() => {
      controller.setDataSourceRows(protoKey, [{ a: 1 }]);
      controller.setDataSourceAdapter(protoKey, { getRows: async () => ({ rows: [] }) });
      controller.removeDataSource(protoKey);
      controller.updateDataSourceField(protoKey, 'f1', { label: 'x' });
    }).not.toThrow();

    // Nothing was written, and no prototype member was promoted to an own key.
    expect(controller.getState().runtime.dataSources).toBe(before);
    expect(Object.hasOwn(controller.getState().runtime.dataSources, protoKey)).toBe(false);
  });
});

// ─── H6: clearPageFilters must not delete legacy "all pages" filters ──────────
// A page filter with no `scope.pageId` predates the per-page scope model and applies to EVERY
// page (`internals/filterScoping.ts`, `context/selectors.ts`, and the `!sv2.pageId` branch of
// `selectFiltersForWidget` all honour that). `clearPageFilters` used to retain only page
// filters whose `pageId` was BOTH set and different from the active page, so an all-pages
// filter satisfied neither disjunct and "Clear all" on ONE page silently un-filtered every
// other page. `docTransforms.applyFilterPreset` already had the correct predicate.

describe('StudioController.clearPageFilters — all-pages filters (H6)', () => {
  function twoPageController(filters: StudioFilterState[]) {
    return new StudioController({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
        },
        filters,
      },
    });
  }

  it("preserves a legacy pageId-less filter while clearing the active page's own filters", () => {
    const controller = twoPageController([
      makeFilter({ id: 'all-pages', field: 'region', value: 'EMEA', scope: { kind: 'page' } }),
      makeFilter({ id: 'page-1-own', scope: { kind: 'page', pageId: 'page-1' } }),
      makeFilter({ id: 'page-2-own', scope: { kind: 'page', pageId: 'page-2' } }),
    ]);

    controller.clearPageFilters();

    const ids = controller.getState().doc.filters.map((f) => f.id);
    // The all-pages filter survives — page-2's widgets must stay filtered.
    expect(ids).toContain('all-pages');
    // Another page's own filter survives too.
    expect(ids).toContain('page-2-own');
    // Only the active page's own filter is cleared.
    expect(ids).not.toContain('page-1-own');
  });

  it('is a clean no-op when the active page has only an all-pages filter', () => {
    const controller = twoPageController([
      makeFilter({ id: 'all-pages', scope: { kind: 'page' } }),
    ]);
    const before = controller.getState();

    controller.clearPageFilters();

    // Nothing to clear → the same state reference, no undo entry, no log line.
    expect(controller.getState()).toBe(before);
    expect(controller.canUndo()).toBe(false);
    expect(controller.getRecentMutations()).toEqual([]);
  });

  it('records a labeled mutation so the AI assistant sees the clear', () => {
    const controller = twoPageController([
      makeFilter({ id: 'page-1-own', scope: { kind: 'page', pageId: 'page-1' } }),
    ]);

    controller.clearPageFilters();

    expect(controller.getRecentMutations().map((m) => m.label)).toEqual([
      'clearPageFilters:page-1',
    ]);
  });
});

// ─── M12: controller writers report their rejections ─────────────────────────

describe('StudioController.addFilter / updateFilter — reported rejections (M12)', () => {
  it('addFilter returns rank-conflict instead of silently dropping a second rank filter', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const controller = new StudioController({
        doc: {
          filters: [
            makeFilter({ id: 'rank-1', filterMode: 'rank', rankDirection: 'top', value: 10 }),
          ],
        },
      });

      const result = controller.addFilter(
        makeFilter({ id: 'rank-2', filterMode: 'rank', rankDirection: 'top', value: 5 }),
      );

      expect(result).toEqual({ ok: false, reason: 'rank-conflict' });
      expect(controller.getState().doc.filters.map((f) => f.id)).toEqual(['rank-1']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('addFilter returns duplicate-id when the id is already in the doc', () => {
    const controller = new StudioController({ doc: { filters: [makeFilter({ id: 'f1' })] } });
    expect(controller.addFilter(makeFilter({ id: 'f1', value: 'other' }))).toEqual({
      ok: false,
      reason: 'duplicate-id',
    });
    // The stored filter wins — an add never overwrites.
    expect(controller.getState().doc.filters[0].value).toBe('');
  });

  it('addFilter returns invalid when the reducer refuses the payload', () => {
    const controller = new StudioController();
    // A `widget`-scoped filter naming a widget that does not exist: the shared reducer's
    // orphan-anchor check rejects it, and `commitMutation` sees a whole-fold no-op.
    const result = controller.addFilter(
      makeFilter({ id: 'orphan', scope: { kind: 'widget', widgetId: 'nope' } }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(controller.getState().doc.filters).toHaveLength(0);
  });

  it('addFilter reports a committed write', () => {
    const controller = new StudioController();
    expect(controller.addFilter(makeFilter({ id: 'f1' }))).toEqual({ ok: true, committed: true });
  });

  it('updateFilter returns rank-conflict instead of silently snapping the control back', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const controller = new StudioController({
        doc: {
          filters: [
            makeFilter({ id: 'rank-1', filterMode: 'rank', rankDirection: 'top', value: 10 }),
            makeFilter({ id: 'condition-1', filterMode: 'condition', value: 'foo' }),
          ],
        },
      });

      const result = controller.updateFilter('condition-1', {
        filterMode: 'rank',
        rankDirection: 'top',
        value: 5,
      });

      expect(result).toEqual({ ok: false, reason: 'rank-conflict' });
      expect(controller.getState().doc.filters.find((f) => f.id === 'condition-1')).toMatchObject({
        filterMode: 'condition',
        value: 'foo',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('updateFilter distinguishes an unknown id from a value-equal re-save', () => {
    const controller = new StudioController({
      doc: { filters: [makeFilter({ id: 'f1', value: 'keep' })] },
    });
    expect(controller.updateFilter('does-not-exist', { value: 'x' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(controller.updateFilter('f1', { value: 'keep' })).toEqual({
      ok: true,
      committed: false,
    });
    expect(controller.updateFilter('f1', { value: 'changed' })).toEqual({
      ok: true,
      committed: true,
    });
  });
});

describe('StudioController.applyInteractiveFilter — value-equal re-emission guard (M12)', () => {
  function filterWidgetController() {
    const controller = new StudioController();
    controller.addWidget(makeWidget('fw', { kind: 'filter' }));
    return controller;
  }

  it('does not rebuild doc.filters (or re-mint the id) for an identical re-emission', () => {
    const controller = filterWidgetController();
    controller.applyInteractiveFilter('fw', 'category', 'in', ['Books']);
    const stateAfterFirst = controller.getState();
    const idAfterFirst = stateAfterFirst.doc.filters[0].id;

    // A debounced date control / slider re-emitting the SAME selection.
    controller.applyInteractiveFilter('fw', 'category', 'in', ['Books']);

    // No commit at all — no subscriber notification, no L3 re-run, and the drawer's disable
    // affordance keeps pointing at the same filter id.
    expect(controller.getState()).toBe(stateAfterFirst);
    expect(controller.getState().doc.filters[0].id).toBe(idAfterFirst);
  });

  it('still commits when the selection genuinely changes', () => {
    const controller = filterWidgetController();
    controller.applyInteractiveFilter('fw', 'category', 'in', ['Books']);
    const before = controller.getState();

    controller.applyInteractiveFilter('fw', 'category', 'in', ['Books', 'Games']);

    expect(controller.getState()).not.toBe(before);
    expect(controller.getState().doc.filters[0].value).toEqual(['Books', 'Games']);
  });

  it('re-emits (re-enabling) when the stored selection was disabled', () => {
    const controller = filterWidgetController();
    controller.applyInteractiveFilter('fw', 'category', 'in', ['Books']);
    const filterId = controller.getState().doc.filters[0].id;
    controller.toggleFilter(filterId);
    expect(controller.getState().doc.filters[0].disabled).toBe(true);

    controller.applyInteractiveFilter('fw', 'category', 'in', ['Books']);

    expect(controller.getState().doc.filters[0].disabled).toBeUndefined();
  });
});

describe('StudioController — no-op guards on session/runtime writers (M12)', () => {
  function controllerWithSource(rows: Record<string, unknown>[]) {
    return new StudioController({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Orders',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows,
          },
        },
      },
    });
  }

  it('setDataSourceRows with the SAME rows reference does not rebuild the source', () => {
    const rows = [{ amount: 1 }];
    const controller = controllerWithSource(rows);
    const before = controller.getState();

    // A host poller re-injecting the identical array it already handed over.
    controller.setDataSourceRows('src1', rows);

    expect(controller.getState()).toBe(before);
    expect(controller.getState().runtime.dataSources.src1).toBe(before.runtime.dataSources.src1);
  });

  it('setDataSourceRows with a different array still commits', () => {
    const controller = controllerWithSource([{ amount: 1 }]);
    const before = controller.getState();

    controller.setDataSourceRows('src1', [{ amount: 2 }]);

    expect(controller.getState()).not.toBe(before);
    expect(controller.getState().runtime.dataSources.src1.rows).toEqual([{ amount: 2 }]);
  });

  it('setMode with the current mode does not rebuild session', () => {
    const controller = new StudioController();
    const before = controller.getState();

    controller.setMode(before.session.mode);

    expect(controller.getState()).toBe(before);
    expect(controller.getState().session).toBe(before.session);
  });

  it('setMode with a different mode still commits', () => {
    const controller = new StudioController();
    controller.setMode('view');
    expect(controller.getState().session.mode).toBe('view');
    controller.setMode('edit');
    expect(controller.getState().session.mode).toBe('edit');
  });
});

// ─── M11: expression-field / relationship edits invalidate the request cache ──
// The request `cacheKey` (`internals/queryDescriptor.ts`) is
// `${widget.sourceId}:${stableStringify({ select, filter, groupBy, aggregations, … })}` — it
// folds in nothing about expression fields or relationships, yet both change the bytes a
// source returns. Without invalidation, repointing `expr-country` from `customers.country` to
// `customers.city` produces a byte-identical key and the cache serves PRE-EDIT rows for up to
// its 30s TTL: the axis is labelled "city" and shows countries.

describe('StudioController — expression-field / relationship edits invalidate the cache (M11)', () => {
  const relationship = {
    id: 'rel1',
    sourceId: 'orders',
    sourceField: 'customer_id',
    targetId: 'customers',
    targetField: 'id',
    type: 'many-to-one' as const,
  };
  const cacheExpressionField = {
    id: 'ef1',
    label: 'Margin',
    expression: { operator: 'subtract' as const, inputs: [{ id: 'revenue' }, { id: 'cost' }] },
    sourceId: 'orders',
    type: 'number' as const,
    isMeasure: false,
  };

  type InvalidateSpy = MockInstance<typeof studioRequestCache.invalidateSource>;

  function withSpy(act: (spy: InvalidateSpy) => void) {
    const spy = vi.spyOn(studioRequestCache, 'invalidateSource');
    try {
      act(spy);
    } finally {
      spy.mockRestore();
    }
  }

  /** The source ids passed to `invalidateSource`, sorted for order-independent assertions. */
  const invalidatedIds = (spy: InvalidateSpy) => spy.mock.calls.map(([id]) => id).sort();

  it('updateExpressionField invalidates both the previous and the new source', () => {
    const controller = new StudioController({
      doc: { expressionFields: [{ ...cacheExpressionField, sourceId: 'customers' }] },
    });
    withSpy((spy) => {
      controller.updateExpressionField('ef1', {
        expression: { operator: 'add', inputs: [{ id: 'city' }, { id: 'zip' }] },
        sourceId: 'cities',
      });
      expect(invalidatedIds(spy)).toEqual(['cities', 'customers']);
    });
  });

  it('updateExpressionField does not invalidate for a rejected / no-op write', () => {
    const controller = new StudioController({ doc: { expressionFields: [cacheExpressionField] } });
    withSpy((spy) => {
      controller.updateExpressionField('nope', { label: 'x' }); // not-found
      controller.updateExpressionField('ef1', { label: cacheExpressionField.label }); // value-equal
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('addExpressionField / removeExpressionField invalidate the field source', () => {
    const controller = new StudioController();
    withSpy((spy) => {
      controller.addExpressionField(cacheExpressionField);
      expect(spy).toHaveBeenCalledWith('orders');
      spy.mockClear();
      controller.removeExpressionField('ef1');
      expect(spy).toHaveBeenCalledWith('orders');
      spy.mockClear();
      controller.removeExpressionField('ef1'); // already gone → clean no-op
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('updateRelationship invalidates both endpoints, before and after the repoint', () => {
    const controller = new StudioController({ doc: { relationships: [relationship] } });
    withSpy((spy) => {
      controller.updateRelationship('rel1', { targetId: 'accounts', targetField: 'id' });
      expect(invalidatedIds(spy)).toEqual(['accounts', 'customers', 'orders']);
    });
  });

  it('addRelationship / removeRelationship invalidate both endpoints', () => {
    const controller = new StudioController();
    withSpy((spy) => {
      controller.addRelationship(relationship);
      expect(invalidatedIds(spy)).toEqual(['customers', 'orders']);
      spy.mockClear();
      controller.removeRelationship('rel1');
      expect(invalidatedIds(spy)).toEqual(['customers', 'orders']);
      spy.mockClear();
      controller.removeRelationship('rel1'); // already gone → clean no-op
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('updateRelationship does not invalidate for a rejected / no-op write', () => {
    const controller = new StudioController({ doc: { relationships: [relationship] } });
    withSpy((spy) => {
      controller.updateRelationship('nope', { targetField: 'x' }); // not-found
      controller.updateRelationship('rel1', { targetField: relationship.targetField }); // equal
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

// ─── M12: applyFilterPreset commits no phantom step on a value-equal re-apply ──

describe('StudioController.applyFilterPreset — identity bail (M12)', () => {
  it('re-applying the preset already in effect adds no undo entry and keeps redo intact', () => {
    const controller = new StudioController({
      doc: {
        filters: [makeFilter({ id: 'f1', scope: { kind: 'page', pageId: 'page-1' } })],
      },
    });
    const presetId = controller.saveFilterPreset('My view');
    controller.applyFilterPreset(presetId);

    controller.setDashboardTitle('anchor');
    controller.undo(); // redo now holds the title change
    expect(controller.canRedo()).toBe(true);
    const before = controller.getState();

    controller.applyFilterPreset(presetId); // the preset is already in effect

    // Nothing committed: same state reference, and the pending redo survives.
    expect(controller.getState()).toBe(before);
    expect(controller.canRedo()).toBe(true);
  });
});

// ─── R6 F1: every doc swap normalizes a dangling widget selection ────────────

describe('StudioController — dangling selection normalization at the commit choke point', () => {
  it('setState nulls a selection the swapped-in doc no longer contains', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const docBefore = controller.getState().doc;

    controller.addWidget(makeWidget('ai1'));
    expect(controller.getState().session.shell.selectedWidgetId).toBe('ai1');

    // The whole-state swap `chatTurnMutations`' `revert` performs.
    controller.setState({ ...controller.getState(), doc: docBefore }, { undoable: true });

    expect(controller.getState().doc.widgets).not.toHaveProperty('ai1');
    expect(controller.getState().session.shell.selectedWidgetId).toBe(null);
  });

  it('chat Retry (ledger revert) does not leave the reverted widget selected', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const ledger = createChatTurnMutationLedger(controller);

    const docBefore = controller.getState().doc;
    const pageId = controller.getState().doc.dashboard.activePageId;
    controller.applyExternalMutation({
      type: 'addWidget',
      args: { widget: makeWidget('ai1'), pageId },
    });
    const docAfter = controller.getState().doc;
    ledger.record('msg-1', docBefore, docAfter);

    // Selecting the AI-created widget is a SESSION-only commit, so `doc` stays
    // reference-identical and the ledger's staleness guard still passes.
    controller.setSelectedWidget('ai1');
    expect(controller.getState().doc).toBe(docAfter);

    expect(ledger.revert('msg-1')).toBe(true);

    expect(Object.keys(controller.getState().doc.widgets)).toEqual(['w1']);
    // Without the normalization the compose drawer renders a blank `WidgetConfigView`
    // keyed on the vanished id instead of `AddWidgetView`.
    expect(controller.getState().session.shell.selectedWidgetId).toBe(null);
  });

  it('leaves a still-present selection and the state reference alone', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.setSelectedWidget('w1');

    controller.setDashboardTitle('renamed');

    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');
  });
});

// ─── R6 F2: the non-reducer-routed writers screen their payloads too ──────────

describe('StudioController.updateFilter — payload screen (R6 F2)', () => {
  function makeControllerWithFilter() {
    return new StudioController({
      doc: {
        widgets: { w1: makeWidget('w1') },
        filters: [makeFilter({ id: 'f1', scope: { kind: 'page', pageId: 'page-1' } })],
      },
    });
  }

  it('refuses a widget scope whose widget does not exist, exactly as addFilter does', () => {
    const controller = makeControllerWithFilter();
    const scope = { kind: 'widget' as const, widgetId: 'nope' };

    // The sibling, reducer-routed writer's answer for the byte-identical scope.
    expect(controller.addFilter(makeFilter({ id: 'f-new', scope }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(controller.updateFilter('f1', { scope })).toEqual({ ok: false, reason: 'invalid' });
    expect(controller.getState().doc.filters[0].scope).toEqual({
      kind: 'page',
      pageId: 'page-1',
    });
  });

  it('refuses a page scope naming a nonexistent page', () => {
    const controller = makeControllerWithFilter();
    expect(controller.updateFilter('f1', { scope: { kind: 'page', pageId: 'ghost' } })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(controller.getState().doc.filters[0].scope).toEqual({
      kind: 'page',
      pageId: 'page-1',
    });
  });

  it('refuses a malformed scope kind', () => {
    const controller = makeControllerWithFilter();
    expect(controller.updateFilter('f1', { scope: { kind: 'pages' } as never })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses a non-StudioFilterOperator operator / operator2', () => {
    const controller = makeControllerWithFilter();
    expect(controller.updateFilter('f1', { operator: 'nonsense' as never })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(controller.updateFilter('f1', { operator2: 'nonsense' as never })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(controller.getState().doc.filters[0].operator).toBe('equals');
  });

  it('refuses a non-string field / id', () => {
    const controller = makeControllerWithFilter();
    expect(controller.updateFilter('f1', { field: 42 as never })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(controller.updateFilter('f1', { id: 42 as never })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('still accepts a well-formed scope re-point and an untouched-key patch', () => {
    const controller = makeControllerWithFilter();
    expect(controller.updateFilter('f1', { scope: { kind: 'widget', widgetId: 'w1' } })).toEqual({
      ok: true,
      committed: true,
    });
    // A value-only patch never trips the screen, even though the stored `scope` is what it is.
    expect(controller.updateFilter('f1', { value: 'x' })).toEqual({ ok: true, committed: true });
  });
});

describe('StudioController.updateActivePage — payload screen (R6 F2)', () => {
  it('refuses a non-string title, exactly as renamePage does', () => {
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;
    const before = controller.getState().doc.pages[pageId].title;

    controller.renamePage(pageId, 42 as never); // reducer-routed sibling: a no-op
    expect(controller.getState().doc.pages[pageId].title).toBe(before);

    expect(controller.updateActivePage({ title: 42 as never })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(controller.getState().doc.pages[pageId].title).toBe(before);
  });

  it('strips an id write (which would desync page.id from its record key) with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;

    controller.updateActivePage({ id: 'zzz' } as never);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('id');
    warnSpy.mockRestore();
    expect(controller.getState().doc.pages[pageId].id).toBe(pageId);
  });

  it('still commits a legitimate title change', () => {
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;
    expect(controller.updateActivePage({ title: 'Renamed' })).toEqual({
      ok: true,
      committed: true,
    });
    expect(controller.getState().doc.pages[pageId].title).toBe('Renamed');
  });
});

// ─── R6 F4: the canvas may not offer a span the document cannot hold ─────────

describe('setAdjacentWidgetColSpans — canvas min-span vocabulary matches the doc floor', () => {
  it('commits exactly the minimum getWidgetMinSpan offers for a sparkline-less KPI', () => {
    const kpi = makeWidget('k1', { kind: 'kpi', config: {} });
    const controller = new StudioController({
      doc: {
        widgets: { k1: kpi, w2: makeWidget('w2') },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['k1', 'w2']] },
        },
        dashboard: { activePageId: 'page-1' } as never,
      },
    });

    // The exact number `RowResizeHandle` publishes as `aria-valuemin` and announces.
    const offeredMin = getWidgetMinSpan(kpi);
    controller.setAdjacentWidgetColSpans(
      'k1',
      offeredMin,
      'w2',
      GRID_COLS - offeredMin,
      offeredMin,
      MIN_SPAN,
    );

    // Before R6 F4 the canvas offered 4 while the reducer's `clampSpan` committed 6, so the
    // handle's `aria-valuemin` and its announcement both described a width the document
    // cannot represent.
    expect(controller.getState().doc.pages['page-1'].widgetColSpans?.k1).toBe(offeredMin);
  });
});

// ─── R6 F3: the controller's non-reducer filter drops cascade too ────────────

describe('StudioController — dependsOn cascade on filter drops (R6 F3)', () => {
  function makeControllerWithCascade(extra: StudioFilterState[] = []) {
    return new StudioController({
      doc: {
        dashboard: { activePageId: 'page-1' } as never,
        widgets: { w1: makeWidget('w1') },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] } },
        filters: [
          makeFilter({ id: 'fp', scope: { kind: 'page', pageId: 'page-1' } }),
          makeFilter({
            id: 'fw',
            scope: { kind: 'widget', widgetId: 'w1' },
            dependsOn: ['fp'],
          }),
          ...extra,
        ],
      },
    });
  }

  const dependsOnOf = (controller: StudioController, id: string) =>
    controller.getState().doc.filters.find((f: StudioFilterState) => f.id === id)?.dependsOn;

  it('clearPageFilters cascades into a survivor that depended on a cleared filter', () => {
    const controller = makeControllerWithCascade();
    controller.clearPageFilters();
    expect(controller.getState().doc.filters.map((f: StudioFilterState) => f.id)).toEqual(['fw']);
    // Before R6 F3 this stayed `['fp']` in the LIVE doc and was pruned only by
    // `serializeDoc` at save time — the in-memory cascade and the saved one disagreed.
    expect(dependsOnOf(controller, 'fw')).toBeUndefined();
  });

  it('clearCrossFilter cascades', () => {
    const controller = makeControllerWithCascade();
    controller.applyCrossFilter('w1', 'category', 'Books');
    const crossId = controller
      .getState()
      .doc.filters.find((f: StudioFilterState) => f.scope.kind === 'cross-filter')!.id;
    controller.updateFilter('fw', { dependsOn: [crossId] });

    controller.clearCrossFilter('w1');

    expect(dependsOnOf(controller, 'fw')).toBeUndefined();
  });

  it('clearAllCrossFilters cascades', () => {
    const controller = makeControllerWithCascade();
    controller.applyCrossFilter('w1', 'category', 'Books');
    const crossId = controller
      .getState()
      .doc.filters.find((f: StudioFilterState) => f.scope.kind === 'cross-filter')!.id;
    controller.updateFilter('fw', { dependsOn: [crossId] });

    controller.clearAllCrossFilters();

    expect(dependsOnOf(controller, 'fw')).toBeUndefined();
  });

  it('clearInteractiveFilter cascades', () => {
    const controller = makeControllerWithCascade();
    controller.applyInteractiveFilter('w1', 'category', 'equals', 'Books');
    const interactiveId = controller
      .getState()
      .doc.filters.find((f: StudioFilterState) => f.scope.kind === 'interactive')!.id;
    controller.updateFilter('fw', { dependsOn: [interactiveId] });

    controller.clearInteractiveFilter('w1');

    expect(dependsOnOf(controller, 'fw')).toBeUndefined();
  });
});

// ─── R6 F6: the factory's pages-override gap is surfaced at construction ─────

describe('StudioController constructor — unswept initialState layout warning (R6 F6)', () => {
  const badPages = {
    p1: {
      id: 'p1',
      title: 'P1',
      // Phantom id, duplicate placement, spans summing to 40 > GRID_COLS, an orphan span and
      // a sub-MIN_SPAN one. The factory installs all of it verbatim.
      widgetRows: [['w1', 'ghost', 'w1', 'w2']],
      widgetColSpans: { w1: 20, w2: 20, gone: 12, tiny: 2 },
    },
  };

  it('warns, names the page, and still installs the override verbatim', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController({
      doc: {
        widgets: { w1: makeWidget('w1'), w2: makeWidget('w2') },
        pages: badPages as never,
        dashboard: { activePageId: 'p1' } as never,
      },
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('p1');
    warnSpy.mockRestore();

    // The warning does NOT repair — the factory's contract is "the override IS the page map".
    expect(controller.getState().doc.pages.p1.widgetRows).toEqual([['w1', 'ghost', 'w1', 'w2']]);
  });

  it('stays silent for a well-formed initialState layout', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // eslint-disable-next-line no-new
    new StudioController({
      doc: {
        widgets: { w1: makeWidget('w1'), w2: makeWidget('w2') },
        pages: {
          p1: { id: 'p1', title: 'P1', widgetRows: [['w1', 'w2']] },
        } as never,
        dashboard: { activePageId: 'p1' } as never,
      },
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('stays silent for widgets supplied without a pages override', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // eslint-disable-next-line no-new
    new StudioController({ doc: { widgets: { w1: makeWidget('w1') } } });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
