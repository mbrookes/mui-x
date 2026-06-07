import { describe, expect, it, vi } from 'vitest';
import { executeToolOnState } from './executeToolOnState';
import { createDefaultStudioState } from '@mui/x-studio/models/stateTypes';
import type { StudioState } from '@mui/x-studio';

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
        scope: 'page',
        pageId,
      },
    ],
  });
}

function parseOutput(output: string) {
  return JSON.parse(output) as Record<string, unknown>;
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
    expect((result.mutation as { type: string; args: { title: string } }).args.title).toBe('New Title');
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
    const result = executeToolOnState('rename_page', { pageId: 'page-1', title: 'Overview' }, state);
    expect(result.mutation?.type).toBe('renamePage');
    const mut = result.mutation as { type: string; args: { pageId: string; title: string } };
    expect(mut.args.pageId).toBe('page-1');
    expect(mut.args.title).toBe('Overview');
  });

  it('updates page title in nextState', () => {
    const state = makeState();
    const result = executeToolOnState('rename_page', { pageId: 'page-1', title: 'Overview' }, state);
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
    const mut = result.mutation as { type: string; args: { widget: { id: string; kind: string; title: string } } };
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
    const result = executeToolOnState('update_widget', { widgetId: 'widget-1', title: 'Updated' }, state);
    expect(result.mutation?.type).toBe('updateWidget');
  });

  it('updates the widget title in nextState', () => {
    const state = makeState();
    const result = executeToolOnState('update_widget', { widgetId: 'widget-1', title: 'Updated' }, state);
    expect(result.nextState.widgets['widget-1'].title).toBe('Updated');
  });

  it('returns an error output when widgetId is not found', () => {
    const state = makeState();
    const result = executeToolOnState('update_widget', { widgetId: 'no-such-widget', title: 'x' }, state);
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
});

describe('executeToolOnState: set_widget_layout', () => {
  it('emits a setWidgetLayout mutation', () => {
    const state = makeState();
    const rows = [['widget-1']];
    const result = executeToolOnState('set_widget_layout', { rows }, state);
    expect(result.mutation?.type).toBe('setWidgetLayout');
    const mut = result.mutation as { type: string; args: { rows: string[][] } };
    expect(mut.args.rows).toEqual(rows);
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
    const mut = result.mutation as { type: string; args: { filter: { scope: string } } };
    expect(mut.args.filter.scope).toBe('page');
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
    const mut = result.mutation as { type: string; args: { filter: { scope: string; widgetId: string } } };
    expect(mut.args.filter.scope).toBe('widget');
    expect(mut.args.filter.widgetId).toBe('widget-1');
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
