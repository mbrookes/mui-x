import { describe, expect, it, vi } from 'vitest';
import { applyStateMutation } from './applyStateMutation';
import { createDefaultStudioState } from '../../models/stateTypes';
import type { StudioController } from '../../store/StudioController';
import type { StateMutation } from '../../models';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeController(overrides: Partial<StudioController> = {}): StudioController {
  const pageId = 'page-1';
  const widgetId = 'widget-1';
  const state = createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: pageId },
    pages: {
      [pageId]: { id: pageId, title: 'Page 1', widgetRows: [[widgetId]] },
    },
    widgets: {
      [widgetId]: {
        id: widgetId,
        kind: 'chart',
        title: 'Revenue Chart',
        sourceId: 'src1',
        config: { chartType: 'bar' },
      },
    },
    filters: [
      { id: 'f1', field: 'revenue', operator: 'greater_than', value: 100, scopeV2: { kind: 'page', pageId } },
    ],
  });

  return {
    getState: vi.fn(() => state),
    setState: vi.fn(),
    setDashboardTitle: vi.fn(),
    addPage: vi.fn().mockReturnValue('new-page-id'),
    removePage: vi.fn(),
    renamePage: vi.fn(),
    setActivePage: vi.fn(),
    addWidget: vi.fn(),
    removeWidget: vi.fn(),
    updateWidget: vi.fn(),
    updateWidgetConfig: vi.fn(),
    moveWidgetToPage: vi.fn(),
    duplicateWidget: vi.fn(),
    addFilter: vi.fn(),
    removeFilter: vi.fn(),
    setWidgetLayout: vi.fn(),
    setWidgetColSpanInRow: vi.fn(),
    clearSelection: vi.fn(),
    setDrawerOpen: vi.fn(),
    selectWidget: vi.fn(),
    ...overrides,
  } as unknown as StudioController;
}

// ── setDashboardTitle ─────────────────────────────────────────────────────────

describe('applyStateMutation: setDashboardTitle', () => {
  it('calls controller.setDashboardTitle with the given title', () => {
    const controller = makeController();
    const mutation: StateMutation = { type: 'setDashboardTitle', args: { title: 'New Title' } };
    applyStateMutation(mutation, controller);
    expect(controller.setDashboardTitle).toHaveBeenCalledWith('New Title');
  });
});

// ── addPage ───────────────────────────────────────────────────────────────────

describe('applyStateMutation: addPage', () => {
  it('uses controller.setState() directly to preserve the server-generated ID', () => {
    const controller = makeController();
    const mutation: StateMutation = {
      type: 'addPage',
      args: { id: 'server-page-42', title: 'Analytics' },
    };
    applyStateMutation(mutation, controller);

    // Must use setState, NOT addPage() (which generates a new ID)
    expect(controller.setState).toHaveBeenCalled();
    expect(controller.addPage).not.toHaveBeenCalled();

    // The new page must appear in the state passed to setState
    const setStateArg = (controller.setState as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      pages: Record<string, { id: string; title: string }>;
    };
    expect(setStateArg.pages['server-page-42']).toMatchObject({
      id: 'server-page-42',
      title: 'Analytics',
    });
  });

  it('makes the new page active', () => {
    const controller = makeController();
    const mutation: StateMutation = {
      type: 'addPage',
      args: { id: 'server-page-99', title: 'Reports' },
    };
    applyStateMutation(mutation, controller);
    const setStateArg = (controller.setState as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      dashboard: { activePageId: string };
    };
    expect(setStateArg.dashboard.activePageId).toBe('server-page-99');
  });
});

// ── addWidget ─────────────────────────────────────────────────────────────────

describe('applyStateMutation: addWidget', () => {
  it('calls controller.addWidget with the widget', () => {
    const controller = makeController();
    const widget = {
      id: 'w-99',
      kind: 'chart' as const,
      title: 'Test',
      config: { chartType: 'bar' as const },
    };
    const mutation: StateMutation = { type: 'addWidget', args: { widget } };
    applyStateMutation(mutation, controller);
    expect(controller.addWidget).toHaveBeenCalledWith(widget);
  });
});

// ── updateWidget ──────────────────────────────────────────────────────────────

describe('applyStateMutation: updateWidget', () => {
  it('calls controller.updateWidget with changes', () => {
    const controller = makeController();
    const mutation: StateMutation = {
      type: 'updateWidget',
      args: { widgetId: 'widget-1', changes: { title: 'Updated' } },
    };
    applyStateMutation(mutation, controller);
    expect(controller.updateWidget).toHaveBeenCalledWith('widget-1', { title: 'Updated' });
  });

  it('calls controller.updateWidgetConfig when config is provided', () => {
    const controller = makeController();
    const mutation: StateMutation = {
      type: 'updateWidget',
      args: { widgetId: 'widget-1', changes: {}, config: { chartType: 'line' } },
    };
    applyStateMutation(mutation, controller);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { chartType: 'line' });
  });

  it('does not call updateWidget when changes is empty', () => {
    const controller = makeController();
    const mutation: StateMutation = {
      type: 'updateWidget',
      args: { widgetId: 'widget-1', changes: {} },
    };
    applyStateMutation(mutation, controller);
    expect(controller.updateWidget).not.toHaveBeenCalled();
  });
});

// ── removeWidget ──────────────────────────────────────────────────────────────

describe('applyStateMutation: removeWidget', () => {
  it('calls controller.removeWidget with the widgetId', () => {
    const controller = makeController();
    const mutation: StateMutation = { type: 'removeWidget', args: { widgetId: 'widget-1' } };
    applyStateMutation(mutation, controller);
    expect(controller.removeWidget).toHaveBeenCalledWith('widget-1');
  });
});

// ── setWidgetLayout ───────────────────────────────────────────────────────────

describe('applyStateMutation: setWidgetLayout', () => {
  it('calls controller.setWidgetLayout with the rows', () => {
    const controller = makeController();
    const rows = [['widget-1', 'widget-2'], ['widget-3']];
    const mutation: StateMutation = { type: 'setWidgetLayout', args: { rows } };
    applyStateMutation(mutation, controller);
    expect(controller.setWidgetLayout).toHaveBeenCalledWith(rows);
  });
});

// ── setWidgetColSpan ──────────────────────────────────────────────────────────

describe('applyStateMutation: setWidgetColSpan', () => {
  it('calls controller.setWidgetColSpanInRow', () => {
    const controller = makeController();
    const mutation: StateMutation = {
      type: 'setWidgetColSpan',
      args: { widgetId: 'widget-1', columns: 6, rowWidgetIds: ['widget-1'] },
    };
    applyStateMutation(mutation, controller);
    expect(controller.setWidgetColSpanInRow).toHaveBeenCalledWith('widget-1', 6, ['widget-1']);
  });
});

// ── renamePage ────────────────────────────────────────────────────────────────

describe('applyStateMutation: renamePage', () => {
  it('calls controller.renamePage', () => {
    const controller = makeController();
    const mutation: StateMutation = {
      type: 'renamePage',
      args: { pageId: 'page-1', title: 'Overview' },
    };
    applyStateMutation(mutation, controller);
    expect(controller.renamePage).toHaveBeenCalledWith('page-1', 'Overview');
  });
});

// ── removePage ────────────────────────────────────────────────────────────────

describe('applyStateMutation: removePage', () => {
  it('calls controller.removePage', () => {
    const controller = makeController();
    const mutation: StateMutation = { type: 'removePage', args: { pageId: 'page-1' } };
    applyStateMutation(mutation, controller);
    expect(controller.removePage).toHaveBeenCalledWith('page-1');
  });
});

// ── setActivePage ─────────────────────────────────────────────────────────────

describe('applyStateMutation: setActivePage', () => {
  it('calls controller.setActivePage', () => {
    const controller = makeController();
    const mutation: StateMutation = { type: 'setActivePage', args: { pageId: 'page-1' } };
    applyStateMutation(mutation, controller);
    expect(controller.setActivePage).toHaveBeenCalledWith('page-1');
  });
});

// ── addFilter ─────────────────────────────────────────────────────────────────

describe('applyStateMutation: addFilter', () => {
  it('calls controller.addFilter with the filter', () => {
    const controller = makeController();
    const filter = {
      id: 'f-new',
      field: 'revenue',
      operator: 'greater_than' as const,
      value: 200,
      scopeV2: { kind: 'page' as const, pageId: 'page-1' },
    };
    const mutation: StateMutation = { type: 'addFilter', args: { filter } };
    applyStateMutation(mutation, controller);
    expect(controller.addFilter).toHaveBeenCalledWith(filter);
  });
});

// ── removeFilter ──────────────────────────────────────────────────────────────

describe('applyStateMutation: removeFilter', () => {
  it('calls controller.removeFilter', () => {
    const controller = makeController();
    const mutation: StateMutation = { type: 'removeFilter', args: { filterId: 'f1' } };
    applyStateMutation(mutation, controller);
    expect(controller.removeFilter).toHaveBeenCalledWith('f1');
  });
});

// ── applyBulkUpdate ───────────────────────────────────────────────────────────

describe('applyStateMutation: applyBulkUpdate', () => {
  it('uses controller.setState() directly with the full widget map', () => {
    const controller = makeController();
    const widgets = { 'w-new': { id: 'w-new', kind: 'chart' as const, title: 'New', config: {} } };
    const mutation: StateMutation = {
      type: 'applyBulkUpdate',
      args: {
        widgets,
        widgetRows: [['w-new']],
        widgetColSpans: {},
        activePageId: 'page-1',
      },
    };
    applyStateMutation(mutation, controller);
    expect(controller.setState).toHaveBeenCalled();

    const setStateArg = (controller.setState as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      widgets: Record<string, unknown>;
    };
    expect(setStateArg.widgets).toEqual(widgets);
  });

  it('does nothing when activePageId is not found in state', () => {
    const controller = makeController();
    const mutation: StateMutation = {
      type: 'applyBulkUpdate',
      args: {
        widgets: {},
        widgetRows: [],
        widgetColSpans: {},
        activePageId: 'nonexistent-page',
      },
    };
    applyStateMutation(mutation, controller);
    expect(controller.setState).not.toHaveBeenCalled();
  });
});

// ── Unknown mutation type ─────────────────────────────────────────────────────

describe('applyStateMutation: unknown type', () => {
  it('logs a console.warn and does not throw', () => {
    const controller = makeController();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    applyStateMutation({ type: 'unknownMutation' as never, args: {} as never }, controller);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown state mutation type:'),
      'unknownMutation',
    );

    warnSpy.mockRestore();
  });
});
