import { describe, expect, it, vi } from 'vitest';
import { applyStateMutation } from './applyStateMutation';
import { StudioController } from '../../store/StudioController';
import type { StudioWidget } from '../../models';

// These tests exercise the real `StudioController` (no mocks) so they verify the
// full path: applyStateMutation → controller.applyExternalMutation → the shared
// `applyMutation` reducer → commitState → store. This is the same reducer the
// AI-middleware server runs, so "server-threaded state equals client-applied
// state" is exercised here directly.

function makeController(): StudioController {
  return new StudioController({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
    pages: {
      'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['widget-1']] },
    },
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'chart',
        title: 'Revenue Chart',
        sourceId: 'src1',
        config: { chartType: 'bar' },
      },
    },
    filters: [
      {
        id: 'f1',
        field: 'revenue',
        operator: 'greater_than',
        value: 100,
        scope: { kind: 'page', pageId: 'page-1' },
      },
    ],
  });
}

const chartWidget = (id: string, title = 'W'): StudioWidget => ({
  id,
  kind: 'chart',
  title,
  config: { chartType: 'bar' },
});

// ── setDashboardTitle ─────────────────────────────────────────────────────────

describe('applyStateMutation: setDashboardTitle', () => {
  it('updates the dashboard title', () => {
    const controller = makeController();
    applyStateMutation({ type: 'setDashboardTitle', args: { title: 'New Title' } }, controller);
    expect(controller.getState().dashboard.title).toBe('New Title');
  });
});

// ── addPage ───────────────────────────────────────────────────────────────────

describe('applyStateMutation: addPage', () => {
  it('adds the page with the server-generated ID and makes it active', () => {
    const controller = makeController();
    applyStateMutation(
      { type: 'addPage', args: { id: 'server-page-42', title: 'Analytics' } },
      controller,
    );
    const state = controller.getState();
    expect(state.pages['server-page-42']).toMatchObject({
      id: 'server-page-42',
      title: 'Analytics',
    });
    expect(state.dashboard.activePageId).toBe('server-page-42');
  });
});

// ── addWidget + page-targeting fix ─────────────────────────────────────────────

describe('applyStateMutation: addWidget', () => {
  it('adds the widget to the active page when no pageId is given (legacy fallback)', () => {
    const controller = makeController();
    const widget = chartWidget('w-legacy');
    applyStateMutation({ type: 'addWidget', args: { widget } }, controller);
    const state = controller.getState();
    expect(state.widgets['w-legacy']).toBeDefined();
    expect(state.pages['page-1'].widgetRows.flat()).toContain('w-legacy');
  });

  it('lands the widget on the SERVER-chosen pageId, not the client active page', () => {
    // Simulate the model deciding to add a widget to page-1 while the user (the
    // client) has since navigated to page-2. Before the fix, the widget would
    // land on page-2 (the client's active page) while the model was told page-1.
    const controller = new StudioController({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-2' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
      },
    });
    const widget = chartWidget('w-server', 'Server Widget');

    applyStateMutation({ type: 'addWidget', args: { widget, pageId: 'page-1' } }, controller);

    const state = controller.getState();
    // Landed on the server-specified page…
    expect(state.pages['page-1'].widgetRows.flat()).toContain('w-server');
    // …NOT on wherever the client happened to be navigated.
    expect(state.pages['page-2'].widgetRows.flat()).not.toContain('w-server');
    // Client active page is untouched by an add to another page.
    expect(state.dashboard.activePageId).toBe('page-2');
  });
});

// ── updateWidget ──────────────────────────────────────────────────────────────

describe('applyStateMutation: updateWidget', () => {
  it('applies title changes', () => {
    const controller = makeController();
    applyStateMutation(
      { type: 'updateWidget', args: { widgetId: 'widget-1', changes: { title: 'Updated' } } },
      controller,
    );
    expect(controller.getState().widgets['widget-1'].title).toBe('Updated');
  });

  it('merges a config patch onto the existing config', () => {
    const controller = makeController();
    applyStateMutation(
      {
        type: 'updateWidget',
        args: { widgetId: 'widget-1', changes: {}, config: { chartType: 'line' } },
      },
      controller,
    );
    expect(controller.getState().widgets['widget-1'].config.chartType).toBe('line');
  });
});

// ── removeWidget ──────────────────────────────────────────────────────────────

describe('applyStateMutation: removeWidget', () => {
  it('removes the widget from state and every page layout', () => {
    const controller = makeController();
    applyStateMutation({ type: 'removeWidget', args: { widgetId: 'widget-1' } }, controller);
    const state = controller.getState();
    expect(state.widgets['widget-1']).toBeUndefined();
    expect(state.pages['page-1'].widgetRows.flat()).not.toContain('widget-1');
  });
});

// ── setWidgetLayout ───────────────────────────────────────────────────────────

describe('applyStateMutation: setWidgetLayout', () => {
  it('replaces the active page rows', () => {
    const controller = makeController();
    applyStateMutation({ type: 'setWidgetLayout', args: { rows: [['widget-1']] } }, controller);
    expect(controller.getState().pages['page-1'].widgetRows).toEqual([['widget-1']]);
  });
});

// ── setWidgetColSpan ──────────────────────────────────────────────────────────

describe('applyStateMutation: setWidgetColSpan', () => {
  it('sets the column span on the active page', () => {
    const controller = makeController();
    applyStateMutation(
      {
        type: 'setWidgetColSpan',
        args: { widgetId: 'widget-1', columns: 6, rowWidgetIds: ['widget-1'] },
      },
      controller,
    );
    expect(controller.getState().pages['page-1'].widgetColSpans?.['widget-1']).toBe(6);
  });
});

// ── renamePage ────────────────────────────────────────────────────────────────

describe('applyStateMutation: renamePage', () => {
  it('renames the page', () => {
    const controller = makeController();
    applyStateMutation(
      { type: 'renamePage', args: { pageId: 'page-1', title: 'Overview' } },
      controller,
    );
    expect(controller.getState().pages['page-1'].title).toBe('Overview');
  });
});

// ── removePage ────────────────────────────────────────────────────────────────

describe('applyStateMutation: removePage', () => {
  it('removes the page and cleans up its widgets/filters', () => {
    const controller = new StudioController({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [['widget-1']] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [['widget-2']] },
      },
      widgets: {
        'widget-1': chartWidget('widget-1'),
        'widget-2': chartWidget('widget-2'),
      },
      filters: [
        {
          id: 'f-page1',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'page', pageId: 'page-1' },
        },
        {
          id: 'f-page2',
          field: 'x',
          operator: 'equals',
          value: 2,
          scope: { kind: 'page', pageId: 'page-2' },
        },
      ],
    });
    applyStateMutation({ type: 'removePage', args: { pageId: 'page-1' } }, controller);
    const state = controller.getState();
    expect(state.pages['page-1']).toBeUndefined();
    expect(state.widgets['widget-1']).toBeUndefined();
    expect(state.widgets['widget-2']).toBeDefined();
    expect(state.filters.map((f) => f.id)).toEqual(['f-page2']);
    expect(state.dashboard.activePageId).toBe('page-2');
  });
});

// ── setActivePage ─────────────────────────────────────────────────────────────

describe('applyStateMutation: setActivePage', () => {
  it('switches the active page', () => {
    const controller = new StudioController({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
      },
    });
    applyStateMutation({ type: 'setActivePage', args: { pageId: 'page-2' } }, controller);
    expect(controller.getState().dashboard.activePageId).toBe('page-2');
  });
});

// ── addFilter ─────────────────────────────────────────────────────────────────

describe('applyStateMutation: addFilter', () => {
  it('appends the filter verbatim, honouring the scope the server chose', () => {
    const controller = makeController(); // client active page is page-1
    // The server targeted page-7 (not the client's active page). The filter must
    // NOT be re-stamped to the client's active page.
    const filter = {
      id: 'f-new',
      field: 'revenue',
      operator: 'greater_than' as const,
      value: 200,
      scope: { kind: 'page' as const, pageId: 'page-7' },
    };
    applyStateMutation({ type: 'addFilter', args: { filter } }, controller);
    const added = controller.getState().filters.find((f) => f.id === 'f-new');
    expect(added?.scope).toEqual({ kind: 'page', pageId: 'page-7' });
  });
});

// ── removeFilter ──────────────────────────────────────────────────────────────

describe('applyStateMutation: removeFilter', () => {
  it('removes the filter by id', () => {
    const controller = makeController();
    applyStateMutation({ type: 'removeFilter', args: { filterId: 'f1' } }, controller);
    expect(controller.getState().filters.map((f) => f.id)).not.toContain('f1');
  });
});

// ── applyBulkUpdate ───────────────────────────────────────────────────────────

describe('applyStateMutation: applyBulkUpdate', () => {
  it('applies remove/add deltas and the active page layout', () => {
    const controller = makeController();
    const added = chartWidget('w-new', 'New');
    applyStateMutation(
      {
        type: 'applyBulkUpdate',
        args: {
          // Remove the seeded widget-1 and add w-new — net result is a single new widget.
          removedWidgetIds: ['widget-1'],
          addedWidgets: [added],
          updatedWidgets: [],
          widgetRows: [['w-new']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      },
      controller,
    );
    const state = controller.getState();
    expect(state.widgets).toEqual({ 'w-new': added });
    expect(state.pages['page-1'].widgetRows).toEqual([['w-new']]);
  });

  it('is a no-op when the target page is missing', () => {
    const controller = makeController();
    const before = controller.getState();
    applyStateMutation(
      {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [],
          widgetRows: [],
          widgetColSpans: {},
          activePageId: 'nope',
        },
      },
      controller,
    );
    expect(controller.getState()).toBe(before);
  });
});

// ── renameAIThread ────────────────────────────────────────────────────────────

describe('applyStateMutation: renameAIThread', () => {
  it('renames the active AI thread', () => {
    const controller = new StudioController({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      ai: {
        activeThreadId: 't1',
        threads: [{ id: 't1', name: 'Old', createdAt: '2020-01-01T00:00:00.000Z', messages: [] }],
      },
    });
    applyStateMutation(
      { type: 'renameAIThread', args: { name: 'New Name', updatedAt: '2024-01-01T00:00:00.000Z' } },
      controller,
    );
    expect(controller.getState().ai?.threads[0].name).toBe('New Name');
  });
});

// ── undo integration ──────────────────────────────────────────────────────────

describe('applyStateMutation: undo integration', () => {
  it('an applied mutation is undoable', () => {
    const controller = makeController();
    applyStateMutation({ type: 'setDashboardTitle', args: { title: 'Changed' } }, controller);
    expect(controller.canUndo()).toBe(true);
    controller.undo();
    expect(controller.getState().dashboard.title).toBe('Dashboard');
  });
});

// ── unknown/unhandled ─────────────────────────────────────────────────────────

describe('applyStateMutation: unknown/unhandled', () => {
  it('does not throw for a malformed mutation', () => {
    const controller = makeController();
    // Dropping an unknown mutation now logs a descriptive reason via console.error;
    // suppress it so the repo's fail-on-console guard doesn't flag the expected log.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      applyStateMutation({ type: 'unknownMutation' as never, args: {} as never }, controller),
    ).not.toThrow();
    errorSpy.mockRestore();
  });
});

// ── runtime validation boundary ───────────────────────────────────────────────
//
// `applyStateMutation` now accepts `unknown` and validates it through
// `parseStateMutation` before touching the controller, since the SSE payload it
// receives is untrusted wire data.

describe('applyStateMutation: runtime validation boundary', () => {
  it('drops a structurally-malformed value: controller is never touched, reason logged', () => {
    const controller = makeController();
    const applySpy = vi.spyOn(controller, 'applyExternalMutation');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // `rows` is a string, not the string[][] the reducer would destructure.
    applyStateMutation({ type: 'setWidgetLayout', args: { rows: 'not-a-matrix' } }, controller);

    expect(applySpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rows'));

    errorSpy.mockRestore();
    applySpy.mockRestore();
  });

  it('does not throw for a completely malformed value or a prototype-chain type', () => {
    const controller = makeController();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => applyStateMutation(undefined, controller)).not.toThrow();
    expect(() => applyStateMutation({ type: 'constructor', args: {} }, controller)).not.toThrow();

    errorSpy.mockRestore();
  });

  it('applies a valid value exactly as before validation was added', () => {
    const controller = makeController();
    applyStateMutation({ type: 'setDashboardTitle', args: { title: 'Validated' } }, controller);
    expect(controller.getState().dashboard.title).toBe('Validated');
  });
});
