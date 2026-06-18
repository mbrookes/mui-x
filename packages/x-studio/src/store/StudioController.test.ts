import { describe, expect, it, vi } from 'vitest';
import { StudioController } from './StudioController';
import type { StudioFilterState, StudioWidget } from '../models';

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    value: '',
    scope: 'page',
    ...overrides,
  };
}

describe('StudioController.updateFilter', () => {
  it('does not allow a second rank filter', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new StudioController({
      filters: [
        makeFilter({ id: 'rank-filter', filterMode: 'rank', rankDirection: 'top', value: 10 }),
        makeFilter({ id: 'condition-filter', filterMode: 'condition', value: 'foo' }),
      ],
    });

    controller.updateFilter('condition-filter', {
      filterMode: 'rank',
      value: 5,
      rankDirection: 'top',
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();

    const updatedFilters = controller.getState().filters;
    expect(updatedFilters.find((filter) => filter.id === 'condition-filter')).toMatchObject({
      filterMode: 'condition',
      value: 'foo',
    });
  });

  it('allows updates to the existing rank filter', () => {
    const controller = new StudioController({
      filters: [
        makeFilter({ id: 'rank-filter', filterMode: 'rank', rankDirection: 'top', value: 10 }),
        makeFilter({ id: 'condition-filter', filterMode: 'condition', value: 'foo' }),
      ],
    });

    controller.updateFilter('rank-filter', { value: 7 });

    expect(
      controller.getState().filters.find((filter) => filter.id === 'rank-filter'),
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

    controller.applyCrossFilter(
      'widget-chart-category',
      'category',
      'Electronics',
      'order-items-source',
    );

    const filters = controller.getState().filters;
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({
      scope: 'cross-filter',
      sourceWidgetId: 'widget-chart-category',
      field: 'category',
      operator: 'equals',
      value: 'Electronics',
      filterSourceId: 'order-items-source',
    });
  });

  it('adds a cross-filter without filterSourceId when omitted', () => {
    const controller = new StudioController();

    controller.applyCrossFilter('widget-chart', 'status', 'active');

    const [f] = controller.getState().filters;
    expect(f.filterSourceId).toBeUndefined();
    expect(f).toMatchObject({ field: 'status', value: 'active' });
  });

  it('replaces the existing cross-filter from the same source widget', () => {
    const controller = new StudioController();

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-a', 'category', 'Clothing', 'src-a');

    const filters = controller.getState().filters;
    // Only one cross-filter from widget-a should remain
    expect(filters.filter((f) => f.sourceWidgetId === 'widget-a')).toHaveLength(1);
    expect(filters[0]).toMatchObject({ value: 'Clothing' });
  });

  it('does not remove cross-filters from other source widgets', () => {
    const controller = new StudioController();

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-b', 'region', 'EMEA', 'src-b');

    const filters = controller.getState().filters;
    expect(filters).toHaveLength(2);
    expect(filters.some((f) => f.sourceWidgetId === 'widget-a')).toBe(true);
    expect(filters.some((f) => f.sourceWidgetId === 'widget-b')).toBe(true);
  });

  it('does not remove page-scoped filters when adding a cross-filter', () => {
    const controller = new StudioController({
      filters: [makeFilter({ id: 'date-filter', scope: 'page', field: 'date' })],
    });

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    const filters = controller.getState().filters;
    expect(filters.some((f) => f.id === 'date-filter')).toBe(true);
    expect(filters.some((f) => f.scope === 'cross-filter')).toBe(true);
  });
});

// ─── StudioController.clearCrossFilter ───────────────────────────────────────

describe('StudioController.clearCrossFilter', () => {
  it('removes the cross-filter from the specified source widget', () => {
    const controller = new StudioController();
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    controller.clearCrossFilter('widget-a');

    expect(controller.getState().filters.filter((f) => f.scope === 'cross-filter')).toHaveLength(0);
  });

  it('leaves cross-filters from other widgets untouched', () => {
    const controller = new StudioController();
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-b', 'region', 'EMEA', 'src-b');

    controller.clearCrossFilter('widget-a');

    const remaining = controller.getState().filters;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sourceWidgetId).toBe('widget-b');
  });

  it('leaves page-scoped and widget-scoped filters untouched', () => {
    const controller = new StudioController({
      filters: [
        makeFilter({ id: 'page-filter', scope: 'page' }),
        makeFilter({ id: 'widget-filter', scope: 'widget' }),
      ],
    });
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    controller.clearCrossFilter('widget-a');

    const filters = controller.getState().filters;
    expect(filters.map((f) => f.id)).toContain('page-filter');
    expect(filters.map((f) => f.id)).toContain('widget-filter');
  });

  it('is a no-op when no cross-filter exists for the widget', () => {
    const controller = new StudioController({
      filters: [makeFilter({ id: 'page-filter', scope: 'page' })],
    });

    controller.clearCrossFilter('widget-nonexistent');

    expect(controller.getState().filters).toHaveLength(1);
  });
});

// ─── StudioController.applyInteractiveFilter ─────────────────────────────────

describe('StudioController.applyInteractiveFilter', () => {
  it('adds an interactive filter with scope interactive', () => {
    const controller = new StudioController();

    controller.applyInteractiveFilter(
      'filter-widget-1',
      'category',
      'in',
      ['Electronics', 'Books'],
      {
        filterMode: 'selection',
      },
    );

    const filters = controller.getState().filters;
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({
      scope: 'interactive',
      sourceWidgetId: 'filter-widget-1',
      field: 'category',
      operator: 'in',
      value: ['Electronics', 'Books'],
      filterMode: 'selection',
    });
  });

  it('stamps the active pageId on the filter', () => {
    const controller = new StudioController();
    const activePageId = controller.getState().dashboard.activePageId;

    controller.applyInteractiveFilter('filter-widget-1', 'country', 'equals', 'AU');

    const [f] = controller.getState().filters;
    expect(f.pageId).toBe(activePageId);
  });

  it('replaces an existing interactive filter from the same widget', () => {
    const controller = new StudioController();

    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Electronics']);
    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Books', 'Clothing']);

    const filters = controller.getState().filters;
    expect(filters.filter((f) => f.sourceWidgetId === 'filter-widget-1')).toHaveLength(1);
    expect(filters[0].value).toEqual(['Books', 'Clothing']);
  });

  it('does not remove interactive filters from other widgets', () => {
    const controller = new StudioController();

    controller.applyInteractiveFilter('filter-widget-a', 'category', 'in', ['Electronics']);
    controller.applyInteractiveFilter('filter-widget-b', 'country', 'equals', 'AU');

    expect(controller.getState().filters).toHaveLength(2);
  });

  it('stores filterSourceId for cross-source filtering', () => {
    const controller = new StudioController();

    controller.applyInteractiveFilter('filter-widget-1', 'segment', 'in', ['Enterprise'], {
      filterMode: 'selection',
      filterSourceId: 'source-customers',
    });

    const [f] = controller.getState().filters;
    expect(f.filterSourceId).toBe('source-customers');
  });

  it('does not remove page/widget/cross filters', () => {
    const controller = new StudioController({
      filters: [
        makeFilter({ id: 'page-f', scope: 'page' }),
        makeFilter({ id: 'widget-f', scope: 'widget' }),
        makeFilter({ id: 'cross-f', scope: 'cross-filter' }),
      ],
    });

    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Books']);

    const ids = controller.getState().filters.map((f) => f.id);
    expect(ids).toContain('page-f');
    expect(ids).toContain('widget-f');
    expect(ids).toContain('cross-f');
  });
});

// ─── StudioController.clearInteractiveFilter ─────────────────────────────────

describe('StudioController.clearInteractiveFilter', () => {
  it('removes the interactive filter for the specified widget', () => {
    const controller = new StudioController();
    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Books']);

    controller.clearInteractiveFilter('filter-widget-1');

    expect(controller.getState().filters.filter((f) => f.scope === 'interactive')).toHaveLength(0);
  });

  it('leaves interactive filters from other widgets untouched', () => {
    const controller = new StudioController();
    controller.applyInteractiveFilter('filter-a', 'category', 'in', ['Books']);
    controller.applyInteractiveFilter('filter-b', 'country', 'equals', 'AU');

    controller.clearInteractiveFilter('filter-a');

    const remaining = controller.getState().filters;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sourceWidgetId).toBe('filter-b');
  });

  it('leaves page/widget/cross-filters untouched', () => {
    const controller = new StudioController({
      filters: [makeFilter({ id: 'page-f', scope: 'page' })],
    });
    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Books']);

    controller.clearInteractiveFilter('filter-widget-1');

    expect(controller.getState().filters.map((f) => f.id)).toContain('page-f');
  });

  it('is a no-op when no interactive filter exists for the widget', () => {
    const controller = new StudioController({
      filters: [makeFilter({ id: 'page-f', scope: 'page' })],
    });

    controller.clearInteractiveFilter('nonexistent-widget');

    expect(controller.getState().filters).toHaveLength(1);
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
      controller.getState().filters.filter((f) => f.sourceWidgetId === 'filter-w1'),
    ).toHaveLength(0);
  });

  it('preserves interactive filters from other widgets when one widget is removed', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('filter-w1', { kind: 'filter' }));
    controller.addWidget(makeWidget('filter-w2', { kind: 'filter' }));
    controller.applyInteractiveFilter('filter-w1', 'category', 'in', ['Books']);
    controller.applyInteractiveFilter('filter-w2', 'country', 'equals', 'AU');

    controller.removeWidget('filter-w1');

    const remaining = controller.getState().filters.filter((f) => f.scope === 'interactive');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sourceWidgetId).toBe('filter-w2');
  });
});

// ─── StudioController — widget CRUD ──────────────────────────────────────────

function makeWidget(id: string, overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id,
    kind: 'kpi',
    title: 'Test Widget',
    config: { kpiAggregation: 'sum' },
    ...overrides,
  };
}

describe('StudioController.addWidget', () => {
  it('adds the widget to the widgets map', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    expect(controller.getState().widgets.w1).toBeDefined();
  });

  it('adds the widget id to widgetRows on the active page', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const activePageId = controller.getState().dashboard.activePageId;
    const rows = controller.getState().pages[activePageId].widgetRows;
    expect(rows.flat()).toContain('w1');
  });

  it('sets selectedWidgetId to the new widget', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    expect(controller.getState().shell.selectedWidgetId).toBe('w1');
  });

  it('appends a second widget as a new row', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    const activePageId = controller.getState().dashboard.activePageId;
    expect(controller.getState().pages[activePageId].widgetRows).toHaveLength(2);
  });
});

describe('StudioController.removeWidget', () => {
  it('removes the widget from the widgets map', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.removeWidget('w1');
    expect(controller.getState().widgets.w1).toBeUndefined();
  });

  it('removes the widget id from widgetRows', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.removeWidget('w1');
    const activePageId = controller.getState().dashboard.activePageId;
    expect(controller.getState().pages[activePageId].widgetRows.flat()).not.toContain('w1');
  });

  it('clears selectedWidgetId when the selected widget is removed', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    // selectedWidgetId is now 'w1'
    controller.removeWidget('w1');
    expect(controller.getState().shell.selectedWidgetId).toBeNull();
  });

  it('preserves selectedWidgetId when a different widget is removed', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    // selectedWidgetId is now 'w2' (last added)
    controller.removeWidget('w1');
    expect(controller.getState().shell.selectedWidgetId).toBe('w2');
  });

  it('leaves other widgets intact', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    controller.removeWidget('w1');
    expect(controller.getState().widgets.w2).toBeDefined();
  });
});

describe('StudioController.updateWidgetConfig', () => {
  it('keeps inferred chart titles in auto mode after field selection', () => {
    const controller = new StudioController({
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
    });

    controller.updateWidgetConfig('chart1', { xField: 'month', yField: 'revenue' });

    expect(controller.getState().widgets.chart1.title).toBe('Revenue by Month');
    expect(controller.getState().widgets.chart1.titleMode).toBe('auto');
  });

  it('preserves an existing chart title when titleMode is undefined and chart type changes', () => {
    const controller = new StudioController({
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
    });

    controller.updateWidgetConfig('chart1', { chartType: 'line' });

    expect(controller.getState().widgets.chart1.title).toBe('Revenue by Month');
  });

  it('removes config keys when the incoming value is undefined', () => {
    const controller = new StudioController({
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
    });

    controller.updateWidgetConfig('text1', { textTitleColor: undefined });

    expect(controller.getState().widgets.text1.config.textTitleColor).toBeUndefined();
    expect('textTitleColor' in controller.getState().widgets.text1.config).toBe(false);
  });
});

describe('StudioController.duplicateWidget', () => {
  it('creates a new widget with a different id', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1', { title: 'Revenue' }));
    controller.duplicateWidget('w1');
    const ids = Object.keys(controller.getState().widgets);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => id !== 'w1' || ids.some((id2) => id2 !== 'w1'))).toBe(true);
  });

  it('appends " (copy)" to the duplicated widget title', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1', { title: 'Revenue' }));
    controller.duplicateWidget('w1');
    const copyWidget = Object.values(controller.getState().widgets).find((w) => w.id !== 'w1');
    expect(copyWidget?.title).toBe('Revenue (copy)');
  });

  it('sets selectedWidgetId to the copy', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1', { title: 'Revenue' }));
    controller.duplicateWidget('w1');
    const copyId = Object.keys(controller.getState().widgets).find((id) => id !== 'w1');
    expect(controller.getState().shell.selectedWidgetId).toBe(copyId);
  });

  it('adds the copy to widgetRows', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.duplicateWidget('w1');
    const activePageId = controller.getState().dashboard.activePageId;
    const flat = controller.getState().pages[activePageId].widgetRows.flat();
    const copyId = Object.keys(controller.getState().widgets).find((id) => id !== 'w1');
    expect(flat).toContain(copyId);
  });

  it('places the copy in the same row as the source when the row has space', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.duplicateWidget('w1');
    const activePageId = controller.getState().dashboard.activePageId;
    const { widgetRows } = controller.getState().pages[activePageId];
    const copyId = Object.keys(controller.getState().widgets).find((id) => id !== 'w1')!;
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
    const activePageId = controller.getState().dashboard.activePageId;
    const state = controller.getState();
    controller.updateState({
      pages: {
        ...state.pages,
        [activePageId]: {
          ...state.pages[activePageId],
          widgetRows: [['w1', 'w2', 'w3']],
        },
      },
    });
    controller.duplicateWidget('w2');
    const newState = controller.getState();
    const copyId = Object.keys(newState.widgets).find((id) => !['w1', 'w2', 'w3'].includes(id))!;
    const { widgetRows } = newState.pages[activePageId];
    expect(widgetRows).toHaveLength(1);
    expect(widgetRows[0]).toEqual(['w1', 'w2', copyId, 'w3']);
  });

  it('places the copy in a new row below when the source row is full (4 widgets)', () => {
    const controller = new StudioController();
    ['w1', 'w2', 'w3', 'w4'].forEach((id) => controller.addWidget(makeWidget(id)));
    const activePageId = controller.getState().dashboard.activePageId;
    const state = controller.getState();
    controller.updateState({
      pages: {
        ...state.pages,
        [activePageId]: {
          ...state.pages[activePageId],
          widgetRows: [['w1', 'w2', 'w3', 'w4']],
        },
      },
    });
    controller.duplicateWidget('w1');
    const newState = controller.getState();
    const copyId = Object.keys(newState.widgets).find(
      (id) => !['w1', 'w2', 'w3', 'w4'].includes(id),
    )!;
    const { widgetRows } = newState.pages[activePageId];
    // Should have 2 rows: the full original row + new row with just the copy
    expect(widgetRows).toHaveLength(2);
    expect(widgetRows[0]).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(widgetRows[1]).toEqual([copyId]);
  });

  it('inserts the new row immediately below the source row (not at the bottom)', () => {
    const controller = new StudioController();
    ['w1', 'w2', 'w3', 'w4', 'w5'].forEach((id) => controller.addWidget(makeWidget(id)));
    const activePageId = controller.getState().dashboard.activePageId;
    const state = controller.getState();
    // Two rows: first full (4 widgets), second with one widget
    controller.updateState({
      pages: {
        ...state.pages,
        [activePageId]: {
          ...state.pages[activePageId],
          widgetRows: [['w1', 'w2', 'w3', 'w4'], ['w5']],
        },
      },
    });
    controller.duplicateWidget('w1'); // duplicate from full first row
    const newState = controller.getState();
    const copyId = Object.keys(newState.widgets).find(
      (id) => !['w1', 'w2', 'w3', 'w4', 'w5'].includes(id),
    )!;
    const { widgetRows } = newState.pages[activePageId];
    // 3 rows: original full row, new copy row, existing second row
    expect(widgetRows).toHaveLength(3);
    expect(widgetRows[0]).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(widgetRows[1]).toEqual([copyId]);
    expect(widgetRows[2]).toEqual(['w5']);
  });

  it('is a no-op for an unknown widgetId', () => {
    const controller = new StudioController();
    controller.duplicateWidget('nonexistent');
    expect(Object.keys(controller.getState().widgets)).toHaveLength(0);
  });
});

// ─── StudioController.moveWidgetToPage ────────────────────────────────────────

describe('StudioController.moveWidgetToPage', () => {
  it('moves a widget from the active page to a target page', () => {
    const controller = new StudioController();
    const sourcePageId = controller.getState().dashboard.activePageId;
    controller.addWidget(makeWidget('w1', { title: 'Revenue' }));
    const targetPageId = controller.addPage('Page 2');
    // addPage switches to the new page; switch back to move from the source
    controller.setActivePage(sourcePageId);

    controller.moveWidgetToPage('w1', targetPageId);
    const state = controller.getState();
    const sourcePage = state.pages[sourcePageId];
    const targetPage = state.pages[targetPageId];
    expect(sourcePage.widgetRows.flat()).not.toContain('w1');
    expect(targetPage.widgetRows.flat()).toContain('w1');
    expect(state.widgets.w1).toBeDefined();
  });

  it('is a no-op when source and target page are the same', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const activePageId = controller.getState().dashboard.activePageId;
    const stateBefore = controller.getState();
    controller.moveWidgetToPage('w1', activePageId);
    expect(controller.getState()).toBe(stateBefore);
  });

  it('re-scopes widget filters to the target page', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const sourcePageId = controller.getState().dashboard.activePageId;
    const targetPageId = controller.addPage('Page 2');
    controller.setActivePage(sourcePageId);
    controller.addFilter(
      makeFilter({ id: 'f1', scope: 'widget', widgetId: 'w1', pageId: sourcePageId }),
    );
    controller.moveWidgetToPage('w1', targetPageId);
    const filter = controller.getState().filters.find((f) => f.id === 'f1');
    expect(filter?.pageId).toBe(targetPageId);
  });
});

// ─── StudioController — filter CRUD ──────────────────────────────────────────

describe('StudioController.addFilter / removeFilter', () => {
  it('addFilter appends a filter to the list', () => {
    const controller = new StudioController();
    controller.addFilter(makeFilter({ id: 'f1' }));
    expect(controller.getState().filters).toHaveLength(1);
    expect(controller.getState().filters[0].id).toBe('f1');
  });

  it('addFilter preserves existing filters', () => {
    const controller = new StudioController({ filters: [makeFilter({ id: 'f1' })] });
    controller.addFilter(makeFilter({ id: 'f2' }));
    expect(controller.getState().filters).toHaveLength(2);
  });

  it('removeFilter removes only the matching filter', () => {
    const controller = new StudioController({
      filters: [makeFilter({ id: 'f1' }), makeFilter({ id: 'f2' })],
    });
    controller.removeFilter('f1');
    expect(controller.getState().filters.map((f) => f.id)).toEqual(['f2']);
  });

  it('removeFilter is a no-op for an unknown id', () => {
    const controller = new StudioController({ filters: [makeFilter({ id: 'f1' })] });
    controller.removeFilter('nonexistent');
    expect(controller.getState().filters).toHaveLength(1);
  });
});

describe('StudioController.clearAllCrossFilters', () => {
  it('removes all cross-filter scoped entries', () => {
    const controller = new StudioController({
      filters: [
        makeFilter({ id: 'page-f', scope: 'page' }),
        makeFilter({ id: 'cf1', scope: 'cross-filter', sourceWidgetId: 'w1' }),
        makeFilter({ id: 'cf2', scope: 'cross-filter', sourceWidgetId: 'w2' }),
      ],
    });
    controller.clearAllCrossFilters();
    expect(controller.getState().filters.filter((f) => f.scope === 'cross-filter')).toHaveLength(0);
  });

  it('preserves page-scoped and widget-scoped filters', () => {
    const controller = new StudioController({
      filters: [
        makeFilter({ id: 'page-f', scope: 'page' }),
        makeFilter({ id: 'widget-f', scope: 'widget' }),
        makeFilter({ id: 'cf1', scope: 'cross-filter', sourceWidgetId: 'w1' }),
      ],
    });
    controller.clearAllCrossFilters();
    const ids = controller.getState().filters.map((f) => f.id);
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
    expect(controller.getState().expressionFields).toHaveLength(1);
    expect(controller.getState().expressionFields[0].id).toBe('ef1');
  });

  it('addExpressionField is a no-op when the id already exists', () => {
    const controller = new StudioController({ expressionFields: [ef] });
    controller.addExpressionField({ ...ef, label: 'Different' });
    expect(controller.getState().expressionFields).toHaveLength(1);
    expect(controller.getState().expressionFields[0].label).toBe('Margin');
  });

  it('updateExpressionField merges partial changes', () => {
    const controller = new StudioController({ expressionFields: [ef] });
    controller.updateExpressionField('ef1', { label: 'Profit Margin' });
    expect(controller.getState().expressionFields[0].label).toBe('Profit Margin');
    expect(controller.getState().expressionFields[0].expression).toEqual(ef.expression);
  });

  it('updateExpressionField is a no-op for unknown id', () => {
    const controller = new StudioController({ expressionFields: [ef] });
    controller.updateExpressionField('nonexistent', { label: 'X' });
    expect(controller.getState().expressionFields[0].label).toBe('Margin');
  });

  it('removeExpressionField removes the matching field', () => {
    const ef2 = { ...ef, id: 'ef2', label: 'Other' };
    const controller = new StudioController({ expressionFields: [ef, ef2] });
    controller.removeExpressionField('ef1');
    expect(controller.getState().expressionFields.map((field) => field.id)).toEqual(['ef2']);
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
    expect(controller.getState().dashboard.title).toBe('Step 1');
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
    expect(controller.getState().dashboard.title).toBe('New Title');
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
});

// ─── StudioController — misc ──────────────────────────────────────────────────

describe('StudioController.setDashboardTitle', () => {
  it('updates the dashboard title', () => {
    const controller = new StudioController();
    controller.setDashboardTitle('Quarterly Report');
    expect(controller.getState().dashboard.title).toBe('Quarterly Report');
  });
});

describe('StudioController.setActivePage', () => {
  it('changes the active page id', () => {
    const controller = new StudioController({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
        'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
      },
    });
    controller.setActivePage('page-2');
    expect(controller.getState().dashboard.activePageId).toBe('page-2');
  });

  it('is a no-op when the page is already active', () => {
    const controller = new StudioController({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
    });
    controller.setActivePage('page-1');
    // Should not push to undo stack or change state
    expect(controller.canUndo()).toBe(false);
  });

  it('is a no-op for an unknown page id', () => {
    const controller = new StudioController({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
    });
    controller.setActivePage('nonexistent');
    expect(controller.getState().dashboard.activePageId).toBe('page-1');
  });

  it('stamps the cross-filter with the active page id', () => {
    const controller = new StudioController({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
        'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
      },
    });
    controller.applyCrossFilter('widget-a', 'country', 'Germany');
    const cf = controller.getState().filters.find((f) => f.scope === 'cross-filter');
    expect(cf?.pageId).toBe('page-1');
  });

  it('preserves cross-filters when navigating to a different page', () => {
    const controller = new StudioController({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
        'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
      },
    });
    controller.applyCrossFilter('widget-a', 'country', 'Germany');
    controller.setActivePage('page-2');
    // Cross-filter remains in state (page-scoped by pageId, not removed)
    expect(
      controller
        .getState()
        .filters.some((f) => f.scope === 'cross-filter' && f.pageId === 'page-1'),
    ).toBe(true);
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

    expect(target.getState().dashboard.title).toBe('Saved Dashboard');
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
    expect(target.getState().dataSources.live).toBeDefined();
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
    expect(controller.getState().dashboard.title).toBe('Untitled Dashboard'); // unchanged
  });
});
