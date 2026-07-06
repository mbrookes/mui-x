import { describe, expect, it, vi } from 'vitest';
import { applyMutation } from '@mui/x-studio-schema';
import { StudioController } from './StudioController';
import type { StudioFilterState, StudioWidget } from '../models';
import { resolveDateRangePreset } from '../internals/filterUtils';
import { GRID_COLS, MIN_SPAN } from '../components/StudioCanvas/canvasGridConstants';

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

    controller.applyCrossFilter('widget-chart', 'status', 'active');

    const [f] = controller.getState().doc.filters;
    expect(f.filterSourceId).toBeUndefined();
    expect(f).toMatchObject({ field: 'status', value: 'active' });
  });

  it('replaces the existing cross-filter from the same source widget', () => {
    const controller = new StudioController();

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

  it('does not remove cross-filters from other source widgets', () => {
    const controller = new StudioController();

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

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    const filters = controller.getState().doc.filters;
    expect(filters.some((f) => f.id === 'date-filter')).toBe(true);
    expect(filters.some((f) => f.scope.kind === 'cross-filter')).toBe(true);
  });
});

// ─── StudioController.clearCrossFilter ───────────────────────────────────────

describe('StudioController.clearCrossFilter', () => {
  it('removes the cross-filter from the specified source widget', () => {
    const controller = new StudioController();
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    controller.clearCrossFilter('widget-a');

    expect(
      controller.getState().doc.filters.filter((f) => f.scope.kind === 'cross-filter'),
    ).toHaveLength(0);
  });

  it('leaves cross-filters from other widgets untouched', () => {
    const controller = new StudioController();
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

    controller.applyInteractiveFilter('filter-widget-a', 'category', 'in', ['Electronics']);
    controller.applyInteractiveFilter('filter-widget-b', 'country', 'equals', 'AU');

    expect(controller.getState().doc.filters).toHaveLength(2);
  });

  it('stores filterSourceId for cross-source filtering', () => {
    const controller = new StudioController();

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

    controller.applyInteractiveFilter('filter-widget-1', 'category', 'in', ['Books']);

    const ids = controller.getState().doc.filters.map((f) => f.id);
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

    expect(
      controller.getState().doc.filters.filter((f) => f.scope.kind === 'interactive'),
    ).toHaveLength(0);
  });

  it('leaves interactive filters from other widgets untouched', () => {
    const controller = new StudioController();
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

    expect(controller.getState().doc.widgets.text1.config.textTitleColor).toBeUndefined();
    expect('textTitleColor' in controller.getState().doc.widgets.text1.config).toBe(false);
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

  it('logs a moveWidget label (D12)', () => {
    const controller = twoPageController(['w1', 'w2'], [['w1', 'w2']], { w1: 16, w2: 8 });
    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);
    expect(controller.getRecentMutations().map((m) => m.label)).toEqual(['moveWidget:w1']);
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

// ─── StudioController.removePage — delegation to the shared reducer ─────────

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
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.addWidget(makeWidget('w2'));
    const activePageId = controller.getState().doc.dashboard.activePageId;
    // w1 alone in row 0 with a deliberate narrow span; w2 alone in row 1.
    controller.setWidgetLayout([['w1'], ['w2']]);
    controller.setAdjacentWidgetColSpans('w1', 12, 'w2', 12); // writes {w1:12} via clamp pair
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
