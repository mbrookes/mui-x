import { describe, expect, it, vi } from 'vitest';
import { executeToolOnState } from './executeToolOnState';
import { STUDIO_AI_TOOL_NAMES } from './studioAITools';
import { createDefaultStudioState } from './models/studioTypes';
import type { StudioState } from './models/studioTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(): StudioState {
  const pageId = 'page-1';
  const widgetId = 'widget-1';
  return createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: pageId },
    pages: {
      [pageId]: {
        id: pageId,
        title: 'Page 1',
        widgetRows: [[widgetId]],
      },
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
    dataSources: {
      src1: {
        id: 'src1',
        label: 'Sales',
        fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
      },
    },
    filters: [
      {
        id: 'filter-1',
        field: 'revenue',
        operator: 'greater_than',
        value: 100,
        scope: { kind: 'page', pageId },
      },
    ],
  });
}

function parseOutput(output: string) {
  return JSON.parse(output) as Record<string, unknown>;
}

/**
 * Two pages, each with its own widget and a page-scoped filter, plus a widget-scoped
 * filter. `page-1` is active. Used to assert `remove_page` cleanup semantics.
 */
function makeMultiPageState(): StudioState {
  return createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
    pages: {
      'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['widget-1']] },
      'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['widget-2']] },
    },
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'chart',
        title: 'W1',
        sourceId: 'src1',
        config: { chartType: 'bar' },
      },
      'widget-2': {
        id: 'widget-2',
        kind: 'chart',
        title: 'W2',
        sourceId: 'src1',
        config: { chartType: 'bar' },
      },
    },
    filters: [
      {
        id: 'f-page1',
        field: 'revenue',
        operator: 'greater_than',
        value: 1,
        scope: { kind: 'page', pageId: 'page-1' },
      },
      {
        id: 'f-page2',
        field: 'revenue',
        operator: 'greater_than',
        value: 2,
        scope: { kind: 'page', pageId: 'page-2' },
      },
      {
        id: 'f-widget2',
        field: 'revenue',
        operator: 'equals',
        value: 3,
        scope: { kind: 'widget', widgetId: 'widget-2' },
      },
    ],
  });
}

// ── Read-only tools ───────────────────────────────────────────────────────────

describe('executeToolOnState: get_dashboard_state', () => {
  it('returns a non-empty output string', () => {
    const state = makeState();
    const result = executeToolOnState('get_dashboard_state', {}, state);
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('does not produce a mutation', () => {
    const state = makeState();
    const result = executeToolOnState('get_dashboard_state', {}, state);
    expect(result.mutation).toBeUndefined();
  });

  it('returns the same state as nextState', () => {
    const state = makeState();
    const result = executeToolOnState('get_dashboard_state', {}, state);
    expect(result.nextState).toBe(state);
  });

  it('outputs the raw StudioState (canonical contract shared with MCP), not the system prompt', () => {
    const state = makeState();
    const result = executeToolOnState('get_dashboard_state', {}, state);
    const parsed = JSON.parse(result.output) as StudioState;
    // Raw state round-trips: pages/widgets/dashboard are present as structured data.
    expect(parsed.pages['page-1'].title).toBe('Page 1');
    expect(parsed.widgets['widget-1'].title).toBe('Revenue Chart');
    expect(parsed.dashboard.activePageId).toBe('page-1');
  });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

describe('executeToolOnState: set_dashboard_title', () => {
  it('returns success output with the new title', () => {
    const state = makeState();
    const result = executeToolOnState('set_dashboard_title', { title: 'New Title' }, state);
    const out = parseOutput(result.output);
    expect(out.success).toBe(true);
    expect(out.title).toBe('New Title');
  });

  it('emits a setDashboardTitle mutation', () => {
    const state = makeState();
    const result = executeToolOnState('set_dashboard_title', { title: 'New Title' }, state);
    expect(result.mutation?.type).toBe('setDashboardTitle');
    expect((result.mutation as { type: string; args: { title: string } }).args.title).toBe(
      'New Title',
    );
  });

  it('updates the dashboard title in nextState', () => {
    const state = makeState();
    const result = executeToolOnState('set_dashboard_title', { title: 'New Title' }, state);
    expect(result.nextState.dashboard.title).toBe('New Title');
  });
});

// ── Pages ─────────────────────────────────────────────────────────────────────

describe('executeToolOnState: add_page', () => {
  it('returns a pageId in the output', () => {
    const state = makeState();
    const result = executeToolOnState('add_page', { title: 'Analytics' }, state);
    const out = parseOutput(result.output);
    expect(out.success).toBe(true);
    expect(typeof out.pageId).toBe('string');
    expect(out.title).toBe('Analytics');
  });

  it('emits an addPage mutation with the server-generated id', () => {
    const state = makeState();
    const result = executeToolOnState('add_page', { title: 'Analytics' }, state);
    const out = parseOutput(result.output);
    expect(result.mutation?.type).toBe('addPage');
    const mut = result.mutation as { type: string; args: { id: string; title: string } };
    expect(mut.args.id).toBe(out.pageId);
    expect(mut.args.title).toBe('Analytics');
  });

  it('adds the new page to nextState and makes it active', () => {
    const state = makeState();
    const result = executeToolOnState('add_page', { title: 'Analytics' }, state);
    const out = parseOutput(result.output);
    const pageId = out.pageId as string;
    expect(result.nextState.pages[pageId]).toBeDefined();
    expect(result.nextState.dashboard.activePageId).toBe(pageId);
  });
});

describe('executeToolOnState: rename_page', () => {
  it('emits a renamePage mutation', () => {
    const state = makeState();
    const result = executeToolOnState(
      'rename_page',
      { pageId: 'page-1', title: 'Overview' },
      state,
    );
    expect(result.mutation?.type).toBe('renamePage');
    const mut = result.mutation as { type: string; args: { pageId: string; title: string } };
    expect(mut.args.pageId).toBe('page-1');
    expect(mut.args.title).toBe('Overview');
  });

  it('updates page title in nextState', () => {
    const state = makeState();
    const result = executeToolOnState(
      'rename_page',
      { pageId: 'page-1', title: 'Overview' },
      state,
    );
    expect(result.nextState.pages['page-1'].title).toBe('Overview');
  });
});

describe('executeToolOnState: remove_page', () => {
  it('emits a removePage mutation', () => {
    const state = makeState();
    const result = executeToolOnState('remove_page', { pageId: 'page-1' }, state);
    expect(result.mutation?.type).toBe('removePage');
    const mut = result.mutation as { type: string; args: { pageId: string } };
    expect(mut.args.pageId).toBe('page-1');
  });

  it('removes the page from nextState', () => {
    const state = makeState();
    const result = executeToolOnState('remove_page', { pageId: 'page-1' }, state);
    expect(result.nextState.pages['page-1']).toBeUndefined();
  });

  it('returns a not-found error (no mutation) when the page does not exist', () => {
    const state = makeState();
    const result = executeToolOnState('remove_page', { pageId: 'no-such-page' }, state);
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/not found/i);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });

  it('removing the ACTIVE page leaves a coherent state (client-controller parity)', () => {
    const state = makeMultiPageState(); // page-1 active
    const result = executeToolOnState('remove_page', { pageId: 'page-1' }, state);
    const next = result.nextState;

    // Page gone.
    expect(next.pages['page-1']).toBeUndefined();
    // Its widget is cleaned up; the other page's widget survives (no orphans).
    expect(next.widgets['widget-1']).toBeUndefined();
    expect(next.widgets['widget-2']).toBeDefined();
    // Page-scoped filter for the removed page is gone; other filters survive.
    const filterIds = next.filters.map((f) => f.id);
    expect(filterIds).not.toContain('f-page1');
    expect(filterIds).toContain('f-page2');
    expect(filterIds).toContain('f-widget2');
    // activePageId is reassigned to a remaining page — never left dangling.
    expect(next.dashboard.activePageId).toBe('page-2');
    expect(next.pages[next.dashboard.activePageId]).toBeDefined();
  });

  it('removing a NON-active page keeps activePageId and only cleans that page', () => {
    const state = makeMultiPageState(); // page-1 active
    const result = executeToolOnState('remove_page', { pageId: 'page-2' }, state);
    const next = result.nextState;

    expect(next.pages['page-2']).toBeUndefined();
    expect(next.widgets['widget-2']).toBeUndefined();
    expect(next.widgets['widget-1']).toBeDefined();
    const filterIds = next.filters.map((f) => f.id);
    expect(filterIds).not.toContain('f-page2');
    expect(filterIds).toContain('f-page1');
    // Active page unchanged.
    expect(next.dashboard.activePageId).toBe('page-1');
  });

  it('removing the last remaining page leaves activePageId empty rather than dangling', () => {
    const state = makeState(); // single page 'page-1', active
    const result = executeToolOnState('remove_page', { pageId: 'page-1' }, state);
    expect(Object.keys(result.nextState.pages)).toHaveLength(0);
    expect(result.nextState.dashboard.activePageId).toBe('');
  });
});

describe('executeToolOnState: set_active_page', () => {
  it('emits a setActivePage mutation', () => {
    const state = makeState();
    const result = executeToolOnState('set_active_page', { pageId: 'page-1' }, state);
    expect(result.mutation?.type).toBe('setActivePage');
  });

  it('updates activePageId in nextState', () => {
    // Add a second page first
    const addResult = executeToolOnState('add_page', { title: 'P2' }, makeState());
    const newPageId = parseOutput(addResult.output).pageId as string;
    // Switch back to page-1
    const result = executeToolOnState('set_active_page', { pageId: 'page-1' }, addResult.nextState);
    expect(result.nextState.dashboard.activePageId).toBe('page-1');
    expect(newPageId).toBeTruthy(); // silence unused-var lint
  });

  it('returns a not-found error (no mutation) for an unknown page', () => {
    const state = makeState();
    const result = executeToolOnState('set_active_page', { pageId: 'no-such-page' }, state);
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/not found/i);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
    // The active page must not be corrupted into a non-existent id.
    expect(result.nextState.dashboard.activePageId).toBe('page-1');
  });
});

// ── Widgets ───────────────────────────────────────────────────────────────────

describe('executeToolOnState: add_widget', () => {
  it('returns a widgetId in the output', () => {
    const state = makeState();
    const result = executeToolOnState('add_widget', { kind: 'chart', title: 'Sales' }, state);
    const out = parseOutput(result.output);
    expect(out.success).toBe(true);
    expect(typeof out.widgetId).toBe('string');
  });

  it('emits an addWidget mutation with a widget object', () => {
    const state = makeState();
    const result = executeToolOnState('add_widget', { kind: 'chart', title: 'Sales' }, state);
    expect(result.mutation?.type).toBe('addWidget');
    const mut = result.mutation as {
      type: string;
      args: { widget: { id: string; kind: string; title: string } };
    };
    expect(mut.args.widget.kind).toBe('chart');
    expect(mut.args.widget.title).toBe('Sales');
  });

  it('adds the widget to nextState and the active page layout', () => {
    const state = makeState();
    const result = executeToolOnState('add_widget', { kind: 'chart', title: 'Sales' }, state);
    const out = parseOutput(result.output);
    const widgetId = out.widgetId as string;
    expect(result.nextState.widgets[widgetId]).toBeDefined();
    const activePage = result.nextState.pages[result.nextState.dashboard.activePageId];
    const flatRows = activePage.widgetRows.flat();
    expect(flatRows).toContain(widgetId);
  });
});

describe('executeToolOnState: update_widget', () => {
  it('emits an updateWidget mutation', () => {
    const state = makeState();
    const result = executeToolOnState(
      'update_widget',
      { widgetId: 'widget-1', title: 'Updated' },
      state,
    );
    expect(result.mutation?.type).toBe('updateWidget');
  });

  it('updates the widget title in nextState', () => {
    const state = makeState();
    const result = executeToolOnState(
      'update_widget',
      { widgetId: 'widget-1', title: 'Updated' },
      state,
    );
    expect(result.nextState.widgets['widget-1'].title).toBe('Updated');
  });

  it('returns an error output when widgetId is not found', () => {
    const state = makeState();
    const result = executeToolOnState(
      'update_widget',
      { widgetId: 'no-such-widget', title: 'x' },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toBeDefined();
    expect(result.mutation).toBeUndefined();
  });
});

describe('executeToolOnState: remove_widget', () => {
  it('emits a removeWidget mutation', () => {
    const state = makeState();
    const result = executeToolOnState('remove_widget', { widgetId: 'widget-1' }, state);
    expect(result.mutation?.type).toBe('removeWidget');
    const mut = result.mutation as { type: string; args: { widgetId: string } };
    expect(mut.args.widgetId).toBe('widget-1');
  });

  it('removes the widget from nextState widgets and page layout', () => {
    const state = makeState();
    const result = executeToolOnState('remove_widget', { widgetId: 'widget-1' }, state);
    expect(result.nextState.widgets['widget-1']).toBeUndefined();
    const flatRows = Object.values(result.nextState.pages)
      .flatMap((p) => p.widgetRows ?? [])
      .flat();
    expect(flatRows).not.toContain('widget-1');
  });

  it('returns a not-found error (no mutation) for an unknown widget instead of a phantom success', () => {
    const state = makeState();
    const result = executeToolOnState('remove_widget', { widgetId: '' }, state);
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/not found/i);
    expect(out.success).toBeUndefined();
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });
});

describe('executeToolOnState: set_widget_layout', () => {
  it('emits a setWidgetLayout mutation stamped with the active pageId', () => {
    const state = makeState();
    const rows = [['widget-1']];
    const result = executeToolOnState('set_widget_layout', { rows }, state);
    expect(result.mutation?.type).toBe('setWidgetLayout');
    const mut = result.mutation as { type: string; args: { rows: string[][]; pageId?: string } };
    expect(mut.args.rows).toEqual(rows);
    // The target page is stamped server-side (mirrors add_widget) so a page switch
    // while the model is thinking cannot land the layout on the wrong page.
    expect(mut.args.pageId).toBe('page-1');
  });

  it('rejects malformed (flat) rows without mutating state', () => {
    const state = makeState();
    // A flat array of strings is valid JSON but corrupts widgetRows.
    const result = executeToolOnState('set_widget_layout', { rows: ['widget-1'] }, state);
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/array of rows/i);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });

  it('rejects rows referencing unknown widget IDs', () => {
    const state = makeState();
    const result = executeToolOnState('set_widget_layout', { rows: [['ghost']] }, state);
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/unknown widget id/i);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });
});

describe('executeToolOnState: set_widget_width', () => {
  it('emits a setWidgetColSpan mutation', () => {
    const state = makeState();
    const result = executeToolOnState(
      'set_widget_width',
      { widgetId: 'widget-1', columns: 6, rowWidgetIds: ['widget-1'] },
      state,
    );
    expect(result.mutation?.type).toBe('setWidgetColSpan');
    const mut = result.mutation as {
      type: string;
      args: { widgetId: string; columns: number; rowWidgetIds: string[] };
    };
    expect(mut.args.widgetId).toBe('widget-1');
    expect(mut.args.columns).toBe(6);
    // Stamped with the active page so the span lands on the right page.
    const stamped = result.mutation as { args: { pageId?: string } };
    expect(stamped.args.pageId).toBe('page-1');
  });

  it('returns an error when there is no active page (no undefined spread)', () => {
    const base = makeState();
    // activePageId points at a page that does not exist.
    const orphanState: StudioState = {
      ...base,
      dashboard: { ...base.dashboard, activePageId: 'gone' },
    };
    const result = executeToolOnState(
      'set_widget_width',
      { widgetId: 'widget-1', columns: 6 },
      orphanState,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/no active page/i);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(orphanState);
  });
});

// ── Filters ───────────────────────────────────────────────────────────────────

describe('executeToolOnState: add_page_filter', () => {
  it('returns a filterId in output', () => {
    const state = makeState();
    const result = executeToolOnState(
      'add_page_filter',
      { field: 'revenue', sourceId: 'src1', operator: 'greater_than', value: 500 },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.success).toBe(true);
    expect(typeof out.filterId).toBe('string');
  });

  it('emits an addFilter mutation with scope page', () => {
    const state = makeState();
    const result = executeToolOnState(
      'add_page_filter',
      { field: 'revenue', sourceId: 'src1', operator: 'greater_than', value: 500 },
      state,
    );
    expect(result.mutation?.type).toBe('addFilter');
    const mut = result.mutation as { type: string; args: { filter: { scope: { kind: string } } } };
    expect(mut.args.filter.scope.kind).toBe('page');
  });

  it('appends the filter to nextState.filters', () => {
    const state = makeState();
    const before = state.filters?.length ?? 0;
    const result = executeToolOnState(
      'add_page_filter',
      { field: 'revenue', sourceId: 'src1', operator: 'greater_than', value: 500 },
      state,
    );
    expect(result.nextState.filters?.length).toBe(before + 1);
  });
});

describe('executeToolOnState: add_widget_filter', () => {
  it('emits an addFilter mutation with scope widget', () => {
    const state = makeState();
    const result = executeToolOnState(
      'add_widget_filter',
      { widgetId: 'widget-1', field: 'revenue', sourceId: 'src1', operator: 'equals', value: 42 },
      state,
    );
    expect(result.mutation?.type).toBe('addFilter');
    const mut = result.mutation as {
      type: string;
      args: { filter: { scope: { kind: string; widgetId: string } } };
    };
    expect(mut.args.filter.scope.kind).toBe('widget');
    expect(mut.args.filter.scope.widgetId).toBe('widget-1');
  });
});

describe('executeToolOnState: remove_page_filter', () => {
  it('emits a removeFilter mutation', () => {
    const state = makeState();
    const result = executeToolOnState('remove_page_filter', { filterId: 'filter-1' }, state);
    expect(result.mutation?.type).toBe('removeFilter');
    const mut = result.mutation as { type: string; args: { filterId: string } };
    expect(mut.args.filterId).toBe('filter-1');
  });

  it('removes the filter from nextState', () => {
    const state = makeState();
    const result = executeToolOnState('remove_page_filter', { filterId: 'filter-1' }, state);
    const ids = (result.nextState.filters ?? []).map((f) => f.id);
    expect(ids).not.toContain('filter-1');
  });
});

describe('executeToolOnState: remove_widget_filter', () => {
  it('emits a removeFilter mutation (same handler as remove_page_filter)', () => {
    const state = makeState();
    const result = executeToolOnState('remove_widget_filter', { filterId: 'filter-1' }, state);
    expect(result.mutation?.type).toBe('removeFilter');
  });
});

// ── apply_bulk_update ─────────────────────────────────────────────────────────

describe('executeToolOnState: apply_bulk_update', () => {
  it('applies widget additions and returns success', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      { widgetAdditions: [{ kind: 'chart', title: 'New Widget', sourceId: 'src1' }] },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.success).toBe(true);
    const applied = out.applied as { added: number };
    expect(applied.added).toBe(1);
  });

  it('emits an applyBulkUpdate mutation', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      { widgetAdditions: [{ kind: 'chart', title: 'New Widget' }] },
      state,
    );
    expect(result.mutation?.type).toBe('applyBulkUpdate');
  });

  it('emits a DELTA-shaped mutation (remove/add/update lists), not a full widgets snapshot', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      {
        widgetRemovals: ['widget-1'],
        widgetAdditions: [{ kind: 'chart', title: 'Added' }],
        widgetUpdates: [{ widgetId: 'widget-1', title: 'ignored (removed above)' }],
      },
      state,
    );
    const args = (result.mutation as { args: Record<string, unknown> }).args;
    // The lost-update fix: the mutation carries deltas, never a `widgets` snapshot
    // of the whole record (which would revert concurrent edits on apply).
    expect(args).not.toHaveProperty('widgets');
    expect(args.removedWidgetIds).toEqual(['widget-1']);
    const addedWidgets = args.addedWidgets as Array<{ id: string; title: string }>;
    expect(addedWidgets).toHaveLength(1);
    expect(addedWidgets[0].title).toBe('Added');
    expect(addedWidgets[0].id).toMatch(/^widget-/);
    // widget-1 was removed this turn, so the update targeting it is skipped, not emitted.
    expect(args.updatedWidgets).toEqual([]);
  });

  it('carries an update as a partial config patch (not a pre-merged widget snapshot)', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      { widgetUpdates: [{ widgetId: 'widget-1', config: { chartType: 'line' } }] },
      state,
    );
    const args = (
      result.mutation as {
        args: { updatedWidgets: Array<{ widgetId: string; config?: Record<string, unknown> }> };
      }
    ).args;
    expect(args.updatedWidgets).toEqual([{ widgetId: 'widget-1', config: { chartType: 'line' } }]);
  });

  it('applies widget updates in nextState', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      { widgetUpdates: [{ widgetId: 'widget-1', title: 'Renamed' }] },
      state,
    );
    expect(result.nextState.widgets['widget-1'].title).toBe('Renamed');
  });

  it('applies widget removals in nextState', () => {
    const state = makeState();
    const result = executeToolOnState('apply_bulk_update', { widgetRemovals: ['widget-1'] }, state);
    expect(result.nextState.widgets['widget-1']).toBeUndefined();
  });

  it('skips a removal for a widget that lives on another page (no dangling reference)', () => {
    const base = makeState();
    // widget-2 lives on page-2, but the active page is page-1.
    const state: StudioState = {
      ...base,
      pages: {
        ...base.pages,
        'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['widget-2']] },
      },
      widgets: {
        ...base.widgets,
        'widget-2': { id: 'widget-2', kind: 'chart', title: 'Other', config: { chartType: 'bar' } },
      },
    };
    const result = executeToolOnState('apply_bulk_update', { widgetRemovals: ['widget-2'] }, state);
    const out = parseOutput(result.output);
    expect(out.skipped).toEqual(['remove widget-2: not on the active page']);
    // widget-2 must survive on page-2 — it was not deleted from `widgets`.
    expect(result.nextState.widgets['widget-2']).toBeDefined();
    expect(result.nextState.pages['page-2'].widgetRows).toEqual([['widget-2']]);
  });

  it('builds additions via the shared helper: layered config + a unique id', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      { widgetAdditions: [{ kind: 'chart', title: 'A', config: { chartType: 'line' } }] },
      state,
    );
    const addedIds = Object.keys(result.nextState.widgets).filter((id) => id !== 'widget-1');
    expect(addedIds).toHaveLength(1);
    const added = result.nextState.widgets[addedIds[0]];
    expect(added.id).toMatch(/^widget-/);
    // Factory default (chartType) is overlaid by the model-supplied config.
    expect(added.config.chartType).toBe('line');
  });
});

// ── rename_thread ─────────────────────────────────────────────────────────────

describe('executeToolOnState: rename_thread', () => {
  it('trims the name to 40 chars and stamps a server-side updatedAt', () => {
    const state = makeState();
    const longName = 'x'.repeat(60);
    const result = executeToolOnState('rename_thread', { name: longName }, state);
    const mut = result.mutation as {
      type: string;
      args: { name: string; updatedAt: string; threadId?: string };
    };
    expect(mut.type).toBe('renameAIThread');
    expect(mut.args.name).toHaveLength(40);
    expect(typeof mut.args.updatedAt).toBe('string');
  });

  it('stamps the threadId from the request state so the rename targets that thread', () => {
    const base = makeState();
    const state: StudioState = {
      ...base,
      ai: {
        activeThreadId: 't-req',
        threads: [
          { id: 't-req', name: 'Old', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
        ],
      },
    };
    const result = executeToolOnState('rename_thread', { name: 'New name' }, state);
    const mut = result.mutation as { args: { threadId?: string } };
    expect(mut.args.threadId).toBe('t-req');
  });

  it('rejects a non-string name', () => {
    const state = makeState();
    const result = executeToolOnState('rename_thread', { name: 123 }, state);
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/non-empty name/i);
    expect(result.mutation).toBeUndefined();
  });
});

// ── summarise_page ────────────────────────────────────────────────────────────

describe('executeToolOnState: summarise_page', () => {
  it('returns an error — no row data available server-side', () => {
    const state = makeState();
    const result = executeToolOnState('summarise_page', {}, state);
    const out = parseOutput(result.output);
    expect(out.error).toBeDefined();
    expect(typeof out.error).toBe('string');
  });

  it('does not produce a mutation', () => {
    const state = makeState();
    const result = executeToolOnState('summarise_page', {}, state);
    expect(result.mutation).toBeUndefined();
  });

  it('returns the snapshot verbatim when pageId is omitted', () => {
    const state = makeState();
    const result = executeToolOnState('summarise_page', {}, state, undefined, 'SNAPSHOT-DATA');
    expect(result.output).toBe('SNAPSHOT-DATA');
  });

  it('returns the snapshot when pageId matches the active page', () => {
    const state = makeState(); // active page is 'page-1'
    const result = executeToolOnState(
      'summarise_page',
      { pageId: 'page-1' },
      state,
      undefined,
      'SNAPSHOT-DATA',
    );
    expect(result.output).toBe('SNAPSHOT-DATA');
  });

  it('rejects a non-active pageId instead of mislabeling the active page snapshot', () => {
    const state = makeState(); // active page is 'page-1'
    const result = executeToolOnState(
      'summarise_page',
      { pageId: 'page-2' },
      state,
      undefined,
      'SNAPSHOT-DATA',
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/page-2/);
    expect(out.error).toMatch(/set_active_page/);
  });
});

// ── Unknown tool ──────────────────────────────────────────────────────────────

describe('executeToolOnState: unknown tool', () => {
  it('returns an error in the output', () => {
    const state = makeState();
    const result = executeToolOnState('no_such_tool', {}, state);
    const out = parseOutput(result.output);
    expect(out.error).toBeDefined();
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });
});

// ── nextState chaining ────────────────────────────────────────────────────────

describe('executeToolOnState: nextState chaining', () => {
  it('can chain multiple tool calls using nextState', () => {
    let state = makeState();

    // Add a page
    const r1 = executeToolOnState('add_page', { title: 'Analytics' }, state);
    state = r1.nextState;
    const newPageId = parseOutput(r1.output).pageId as string;

    // Rename it
    const r2 = executeToolOnState('rename_page', { pageId: newPageId, title: 'Metrics' }, state);
    state = r2.nextState;

    expect(state.pages[newPageId].title).toBe('Metrics');
  });
});

// ── set_widget_forecast ────────────────────────────────────────────────────────

describe('executeToolOnState: set_widget_forecast', () => {
  it('returns error when widgetId is missing', () => {
    const state = makeState();
    const result = executeToolOnState('set_widget_forecast', { enabled: true }, state);
    expect(parseOutput(result.output).error).toMatch(/widgetId/);
  });

  it('returns error when widget does not exist', () => {
    const state = makeState();
    const result = executeToolOnState(
      'set_widget_forecast',
      { widgetId: 'no-such-widget', enabled: true },
      state,
    );
    expect(parseOutput(result.output).error).toMatch(/not found/);
  });

  it('returns error when chart type is not line/area', () => {
    const state = makeState(); // makeState widget has chartType: 'bar'
    const result = executeToolOnState(
      'set_widget_forecast',
      { widgetId: 'widget-1', enabled: true },
      state,
    );
    expect(parseOutput(result.output).error).toMatch(/line.*area/i);
  });

  it('enables forecast on a line chart widget', () => {
    const baseState = makeState();
    const lineState = {
      ...baseState,
      widgets: {
        'widget-1': { ...baseState.widgets['widget-1'], config: { chartType: 'line' as const } },
      },
    };
    const result = executeToolOnState(
      'set_widget_forecast',
      { widgetId: 'widget-1', enabled: true, periods: 6 },
      lineState,
    );
    expect(parseOutput(result.output).success).toBe(true);
    expect(result.nextState.widgets['widget-1'].config.forecast?.enabled).toBe(true);
    expect(result.nextState.widgets['widget-1'].config.forecast?.periods).toBe(6);
    expect(result.mutation?.type).toBe('updateWidget');
  });

  it('disables forecast by setting enabled: false', () => {
    const baseState = makeState();
    const lineState = {
      ...baseState,
      widgets: {
        'widget-1': {
          ...baseState.widgets['widget-1'],
          config: {
            chartType: 'line' as const,
            forecast: { enabled: true, periods: 3 },
          },
        },
      },
    };
    const result = executeToolOnState(
      'set_widget_forecast',
      { widgetId: 'widget-1', enabled: false },
      lineState,
    );
    expect(result.nextState.widgets['widget-1'].config.forecast?.enabled).toBe(false);
  });

  it('enables forecast with confidence bands', () => {
    const baseState = makeState();
    const areaState = {
      ...baseState,
      widgets: {
        'widget-1': { ...baseState.widgets['widget-1'], config: { chartType: 'area' as const } },
      },
    };
    const result = executeToolOnState(
      'set_widget_forecast',
      { widgetId: 'widget-1', enabled: true, showConfidenceBands: true },
      areaState,
    );
    expect(result.nextState.widgets['widget-1'].config.forecast?.showConfidenceBands).toBe(true);
  });
});

// ── Purity guard (frozen input) ────────────────────────────────────────────────

/** Recursively freeze an object graph so any in-place mutation throws. */
function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
  }
  return obj;
}

describe('executeToolOnState: purity (never mutates the input state in place)', () => {
  // Representative args per built-in tool, pointing at entities in `makeState()` so
  // the mutation path (not just the not-found error path) is exercised where possible.
  const ARGS_BY_TOOL: Record<string, Record<string, unknown>> = {
    get_dashboard_state: {},
    list_pages: {},
    add_page: { title: 'New' },
    set_dashboard_title: { title: 'T' },
    add_widget: { kind: 'chart', title: 'W' },
    update_widget: { widgetId: 'widget-1', title: 'U' },
    remove_widget: { widgetId: 'widget-1' },
    set_widget_layout: { rows: [['widget-1']] },
    set_widget_width: { widgetId: 'widget-1', columns: 12 },
    rename_page: { pageId: 'page-1', title: 'R' },
    remove_page: { pageId: 'page-1' },
    set_active_page: { pageId: 'page-1' },
    add_page_filter: { field: 'revenue', sourceId: 'src1', operator: 'greater_than', value: 1 },
    remove_page_filter: { filterId: 'filter-1' },
    add_widget_filter: {
      widgetId: 'widget-1',
      field: 'revenue',
      sourceId: 'src1',
      operator: 'equals',
      value: 1,
    },
    remove_widget_filter: { filterId: 'filter-1' },
    summarise_page: {},
    apply_bulk_update: { widgetUpdates: [{ widgetId: 'widget-1', title: 'Bulk' }] },
    rename_thread: { name: 'Thread' },
    execute_query: { query: 'SELECT 1' },
    set_widget_forecast: { widgetId: 'widget-1', enabled: false },
  };

  it.each(STUDIO_AI_TOOL_NAMES)(
    'does not throw for %s when the input state is deep-frozen',
    (toolName) => {
      const frozen = deepFreeze(makeState());
      expect(() =>
        executeToolOnState(toolName, ARGS_BY_TOOL[toolName] ?? {}, frozen),
      ).not.toThrow();
    },
  );
});

// ── handleAIChat integration ──────────────────────────────────────────────────

describe('handleAIChat', () => {
  it('streams SSE text-delta and finish events from a mocked LLM', async () => {
    const { handleAIChat } = await import('./handleAIChat');

    // Build a minimal LLM response: one text chunk + done
    const chunk1 = JSON.stringify({
      choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
    });
    const chunk2 = JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    });
    const sseBody = `data: ${chunk1}\n\ndata: ${chunk2}\n\ndata: [DONE]\n\n`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode(sseBody));
            ctrl.close();
          },
        }),
      }),
    );

    const state = makeState();
    const stream = handleAIChat(
      {
        messages: [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
        dashboardState: state,
      },
      {
        endpoint: 'https://fake-llm.test/v1/chat/completions',
        apiKey: 'test-key',
      },
    );

    const reader = stream.getReader();
    const events: string[] = [];
    let done = false;
    while (!done) {
      // eslint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) {
        events.push(chunk.value);
      }
    }

    const allText = events.join('');
    expect(allText).toContain('"type":"text-delta"');
    expect(allText).toContain('"delta":"Hello"');
    expect(allText).toContain('"type":"finish"');

    vi.unstubAllGlobals();
  });
});
