import { describe, expect, it, vi } from 'vitest';
import { executeToolOnState } from './executeToolOnState';
import { STUDIO_AI_TOOL_NAMES } from './studioAITools';
import { createDefaultStudioState, createWidgetId, isWidgetOfKind } from './models/studioTypes';
import type { StudioChartConfig, StudioState } from './models/studioTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(): StudioState {
  const pageId = 'page-1';
  const widgetId = 'widget-1';
  return createDefaultStudioState({
    doc: {
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
      filters: [
        {
          id: 'filter-1',
          field: 'revenue',
          operator: 'greater_than',
          value: 100,
          scope: { kind: 'page', pageId },
        },
      ],
    },
    runtime: {
      dataSources: {
        src1: {
          id: 'src1',
          label: 'Sales',
          fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
        },
      },
    },
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
    doc: {
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
    },
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

  it('outputs the doc plus data-source metadata (canonical contract shared with MCP)', () => {
    const state = makeState();
    const result = executeToolOnState('get_dashboard_state', {}, state);
    const parsed = JSON.parse(result.output) as {
      doc: StudioState['doc'];
      dataSources: Record<string, { id: string; label: string; fields: unknown[] }>;
    };
    // The `doc` partition round-trips: pages/widgets/dashboard are structured data.
    expect(parsed.doc.pages['page-1'].title).toBe('Page 1');
    expect(parsed.doc.widgets['widget-1'].title).toBe('Revenue Chart');
    expect(parsed.doc.dashboard.activePageId).toBe('page-1');
    // Data sources are projected to metadata (id/label/fields), not the runtime object.
    expect(parsed.dataSources.src1.id).toBe('src1');
    expect(parsed.dataSources.src1.label).toBe('Sales');
    expect(parsed.dataSources.src1.fields).toHaveLength(1);
  });

  it('never leaks raw rows and caps fieldDistinctValues with a truncation marker', () => {
    const distinct = Array.from({ length: 33 }, (_, i) => `v${i}`);
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            tableName: 'sales',
            fields: [{ id: 'status', label: 'Status', type: 'string' }],
            rows: [{ status: 'x', secret: 'S3CR3T' }],
            fieldDistinctValues: { status: distinct },
          },
        },
      },
    });

    const result = executeToolOnState('get_dashboard_state', {}, state);

    // No raw rows and no secret value anywhere in the serialized output.
    expect(result.output).not.toContain('S3CR3T');
    expect(result.output).not.toContain('"rows"');

    const parsed = JSON.parse(result.output) as {
      dataSources: Record<
        string,
        { fieldDistinctValues: Record<string, { values: string[]; truncated: boolean }> }
      >;
    };
    const capped = parsed.dataSources.src1.fieldDistinctValues.status;
    expect(capped.values).toHaveLength(20);
    expect(capped.truncated).toBe(true);
  });

  it('reduces doc.ai to per-thread metadata and never leaks chat transcripts', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
        ai: {
          activeThreadId: 'thread-1',
          threads: [
            {
              id: 'thread-1',
              name: 'Salaries',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              messages: [
                {
                  id: 'm1',
                  role: 'user',
                  parts: [{ type: 'text', text: 'CONFIDENTIAL-SALARY-QUESTION' }],
                },
                {
                  id: 'm2',
                  role: 'assistant',
                  parts: [{ type: 'text', text: 'CONFIDENTIAL-SALARY-ANSWER' }],
                },
              ],
            },
            {
              id: 'thread-2',
              name: 'Other',
              createdAt: '2026-01-01T00:00:00.000Z',
              messages: [
                {
                  id: 'm3',
                  role: 'user',
                  parts: [{ type: 'text', text: 'UNRELATED-THREAD-SECRET' }],
                },
              ],
            },
          ],
        },
      },
    });

    const result = executeToolOnState('get_dashboard_state', {}, state);

    // No transcript content from ANY thread appears in the serialized output.
    expect(result.output).not.toContain('CONFIDENTIAL-SALARY-QUESTION');
    expect(result.output).not.toContain('CONFIDENTIAL-SALARY-ANSWER');
    expect(result.output).not.toContain('UNRELATED-THREAD-SECRET');
    expect(result.output).not.toContain('"messages"');

    const parsed = JSON.parse(result.output) as {
      doc: {
        ai?: {
          activeThreadId?: string;
          threads: Array<{ id: string; name: string; updatedAt?: string; messageCount: number }>;
        };
      };
    };
    // `doc.ai` is reduced to per-thread metadata (no `messages`), not omitted.
    expect(parsed.doc.ai?.activeThreadId).toBe('thread-1');
    expect(parsed.doc.ai?.threads).toEqual([
      { id: 'thread-1', name: 'Salaries', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 2 },
      { id: 'thread-2', name: 'Other', messageCount: 1 },
    ]);
    parsed.doc.ai?.threads.forEach((t) => {
      expect(t).not.toHaveProperty('messages');
    });
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
    expect(result.nextState.doc.dashboard.title).toBe('New Title');
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
    expect(result.nextState.doc.pages[pageId]).toBeDefined();
    expect(result.nextState.doc.dashboard.activePageId).toBe(pageId);
  });

  it('mints the page id via the shared createPageId factory (page- prefix)', () => {
    // Ids are minted through `@mui/x-studio-schema`'s `createPageId()` — a stable,
    // collision-resistant factory — not an ad-hoc `Date.now()` string. Two pages
    // added in the same millisecond must still get distinct ids.
    const state = makeState();
    const a = parseOutput(executeToolOnState('add_page', { title: 'A' }, state).output);
    const b = parseOutput(executeToolOnState('add_page', { title: 'B' }, state).output);
    expect(a.pageId as string).toMatch(/^page-/);
    expect(b.pageId as string).toMatch(/^page-/);
    expect(a.pageId).not.toBe(b.pageId);
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
    expect(result.nextState.doc.pages['page-1'].title).toBe('Overview');
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
    expect(result.nextState.doc.pages['page-1']).toBeUndefined();
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
    expect(next.doc.pages['page-1']).toBeUndefined();
    // Its widget is cleaned up; the other page's widget survives (no orphans).
    expect(next.doc.widgets['widget-1']).toBeUndefined();
    expect(next.doc.widgets['widget-2']).toBeDefined();
    // Page-scoped filter for the removed page is gone; other filters survive.
    const filterIds = next.doc.filters.map((f) => f.id);
    expect(filterIds).not.toContain('f-page1');
    expect(filterIds).toContain('f-page2');
    expect(filterIds).toContain('f-widget2');
    // activePageId is reassigned to a remaining page — never left dangling.
    expect(next.doc.dashboard.activePageId).toBe('page-2');
    expect(next.doc.pages[next.doc.dashboard.activePageId]).toBeDefined();
  });

  it('removing a NON-active page keeps activePageId and only cleans that page', () => {
    const state = makeMultiPageState(); // page-1 active
    const result = executeToolOnState('remove_page', { pageId: 'page-2' }, state);
    const next = result.nextState;

    expect(next.doc.pages['page-2']).toBeUndefined();
    expect(next.doc.widgets['widget-2']).toBeUndefined();
    expect(next.doc.widgets['widget-1']).toBeDefined();
    const filterIds = next.doc.filters.map((f) => f.id);
    expect(filterIds).not.toContain('f-page2');
    expect(filterIds).toContain('f-page1');
    // Active page unchanged.
    expect(next.doc.dashboard.activePageId).toBe('page-1');
  });

  it('removing the last remaining page leaves activePageId empty rather than dangling', () => {
    const state = makeState(); // single page 'page-1', active
    const result = executeToolOnState('remove_page', { pageId: 'page-1' }, state);
    expect(Object.keys(result.nextState.doc.pages)).toHaveLength(0);
    expect(result.nextState.doc.dashboard.activePageId).toBe('');
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
    expect(result.nextState.doc.dashboard.activePageId).toBe('page-1');
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
    expect(result.nextState.doc.dashboard.activePageId).toBe('page-1');
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
    expect(result.nextState.doc.widgets[widgetId]).toBeDefined();
    const activePage = result.nextState.doc.pages[result.nextState.doc.dashboard.activePageId];
    const flatRows = activePage.widgetRows.flat();
    expect(flatRows).toContain(widgetId);
  });

  it('rejects a config key that does not belong to the requested kind (no mutation)', () => {
    const state = makeState();
    const result = executeToolOnState(
      'add_widget',
      { kind: 'grid', title: 'T', config: { chartType: 'bar' } },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/chartType/);
    expect(out.error).toMatch(/grid/);
    expect(out.mutation).toBeUndefined();
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });

  it('rejects a config key that is a valid CHART key but not valid for the requested chartType (no mutation)', () => {
    const state = makeState();
    const result = executeToolOnState(
      'add_widget',
      { kind: 'chart', title: 'Flow', config: { chartType: 'gauge', sankeyTargetField: 'x' } },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/sankeyTargetField/);
    expect(out.error).toMatch(/gauge/);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });

  it('rejects an unrecognized chartType string (no mutation)', () => {
    const state = makeState();
    const result = executeToolOnState(
      'add_widget',
      { kind: 'chart', title: 'Bad', config: { chartType: 'not-a-real-type' } },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/unknown chartType/i);
    expect(out.error).toMatch(/not-a-real-type/);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
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
    expect(result.nextState.doc.widgets['widget-1'].title).toBe('Updated');
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

  it('clears a clearable top-level field via unsetFields', () => {
    const state = makeState();
    const result = executeToolOnState(
      'update_widget',
      { widgetId: 'widget-1', unsetFields: ['sourceId'] },
      state,
    );
    expect('sourceId' in result.nextState.doc.widgets['widget-1']).toBe(false);
  });

  it('clears a config key that is present via unsetConfigKeys', () => {
    const state = makeState();
    const result = executeToolOnState(
      'update_widget',
      { widgetId: 'widget-1', unsetConfigKeys: ['chartType'] },
      state,
    );
    expect('chartType' in result.nextState.doc.widgets['widget-1'].config).toBe(false);
  });

  it('ignores non-clearable / unknown top-level keys in unsetFields', () => {
    const state = makeState();
    const result = executeToolOnState(
      'update_widget',
      // `title`/`kind`/`id` are not clearable; `bogus` is unknown — all ignored,
      // so no unsetFields reaches the mutation and the widget is untouched.
      { widgetId: 'widget-1', unsetFields: ['title', 'kind', 'id', 'bogus'] },
      state,
    );
    const w = result.nextState.doc.widgets['widget-1'];
    expect(w.title).toBe('Revenue Chart');
    expect(w.kind).toBe('chart');
    expect(w.id).toBe('widget-1');
    expect((result.mutation as { args: Record<string, unknown> }).args.unsetFields).toBeUndefined();
  });

  it('ignores config keys that are not present on the widget in unsetConfigKeys', () => {
    const state = makeState();
    const result = executeToolOnState(
      'update_widget',
      { widgetId: 'widget-1', unsetConfigKeys: ['xField'] },
      state,
    );
    // `xField` was never set, so nothing is cleared and no unsetConfigKeys is emitted.
    expect(result.nextState.doc.widgets['widget-1'].config).toEqual({ chartType: 'bar' });
    expect(
      (result.mutation as { args: Record<string, unknown> }).args.unsetConfigKeys,
    ).toBeUndefined();
  });

  it('rejects a config key that does not belong to the widget kind (no mutation)', () => {
    const state = makeState(); // widget-1 is kind 'chart'
    const result = executeToolOnState(
      'update_widget',
      { widgetId: 'widget-1', config: { gridHeight: 400 } },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/gridHeight/);
    expect(out.error).toMatch(/chart/);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState.doc.widgets['widget-1'].config).toEqual({ chartType: 'bar' });
  });

  it('rejects a config key belonging to a DIFFERENT chart type than the widget currently has (no mutation)', () => {
    const state = makeState(); // widget-1 is kind 'chart', chartType 'bar'
    const result = executeToolOnState(
      'update_widget',
      // `sankeyTargetField` is a valid CHART key, but not for 'bar' (the widget's
      // current, unchanged chartType).
      { widgetId: 'widget-1', config: { sankeyTargetField: 'x' } },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/sankeyTargetField/);
    expect(out.error).toMatch(/bar/);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState.doc.widgets['widget-1'].config).toEqual({ chartType: 'bar' });
  });

  it('accepts a patch that changes chartType alongside a key valid for the NEW type', () => {
    const state = makeState(); // widget-1 is kind 'chart', chartType 'bar'
    const result = executeToolOnState(
      'update_widget',
      { widgetId: 'widget-1', config: { chartType: 'gauge', gaugeMin: 0 } },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toBeUndefined();
    expect(out.success).toBe(true);
    expect(result.mutation).toBeDefined();
    const nextConfig = result.nextState.doc.widgets['widget-1'].config as Record<string, unknown>;
    expect(nextConfig.chartType).toBe('gauge');
    expect(nextConfig.gaugeMin).toBe(0);
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
    expect(result.nextState.doc.widgets['widget-1']).toBeUndefined();
    const flatRows = Object.values(result.nextState.doc.pages)
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
      doc: { ...base.doc, dashboard: { ...base.doc.dashboard, activePageId: 'gone' } },
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

  it('returns a clear error for a nonexistent widget id (no phantom col-span)', () => {
    const state = makeState();
    const result = executeToolOnState(
      'set_widget_width',
      { widgetId: 'no-such-widget', columns: 12 },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/not found/i);
    // Must NOT fall through to the `[widgetId]` fallback and emit a phantom mutation.
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });

  it('reports the CLAMPED column value that actually landed in state, not the raw input', () => {
    const state = makeState();
    // 100 is out of range; the reducer clamps to the 24-col max.
    const result = executeToolOnState(
      'set_widget_width',
      { widgetId: 'widget-1', columns: 100 },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.success).toBe(true);
    expect(out.columns).toBe(24);
    // The output matches what the reducer actually wrote.
    expect(result.nextState.doc.pages['page-1'].widgetColSpans?.['widget-1']).toBe(24);
  });

  // Regression for T2-5: a widget that exists globally but lives on a NON-active page is
  // a reducer no-op (its orphan-span guard). The tool used to read back `null` and report
  // `{ success: true, columns: null }` — telling the model a width took effect that never
  // did. It must now error and point at `set_active_page`, and commit nothing.
  it('errors (does not report success) for a widget on a non-active page', () => {
    const state = makeMultiPageState(); // page-1 active, widget-2 on page-2
    const result = executeToolOnState(
      'set_widget_width',
      { widgetId: 'widget-2', columns: 12 },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.success).toBeUndefined();
    expect(out.error).toMatch(/not on the active page/i);
    expect(out.error).toMatch(/set_active_page/);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });

  // A widget that exists but is not yet placed on ANY page is the documented
  // not-yet-placed case and stays permissive — it must still commit the width.
  it('still applies the width for a widget that is not placed on any page yet', () => {
    const base = makeState();
    const unplaced: StudioState = {
      ...base,
      doc: {
        ...base.doc,
        pages: {
          'page-1': { ...base.doc.pages['page-1'], widgetRows: [] },
        },
      },
    };
    const result = executeToolOnState(
      'set_widget_width',
      { widgetId: 'widget-1', columns: 12 },
      unplaced,
    );
    const out = parseOutput(result.output);
    expect(out.success).toBe(true);
    expect(out.columns).toBe(12);
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
    const before = state.doc.filters?.length ?? 0;
    const result = executeToolOnState(
      'add_page_filter',
      { field: 'revenue', sourceId: 'src1', operator: 'greater_than', value: 500 },
      state,
    );
    expect(result.nextState.doc.filters?.length).toBe(before + 1);
  });

  it('mints the filter id via the shared createFilterId factory (filter- prefix)', () => {
    const state = makeState();
    const a = parseOutput(
      executeToolOnState(
        'add_page_filter',
        { field: 'revenue', sourceId: 'src1', operator: 'equals', value: 1 },
        state,
      ).output,
    );
    const b = parseOutput(
      executeToolOnState(
        'add_page_filter',
        { field: 'revenue', sourceId: 'src1', operator: 'equals', value: 2 },
        state,
      ).output,
    );
    expect(a.filterId as string).toMatch(/^filter-/);
    expect(a.filterId).not.toBe(b.filterId);
  });

  it('rejects an unknown filter operator with a clear error naming valid operators', () => {
    const state = makeState();
    const result = executeToolOnState(
      'add_page_filter',
      // "eq" is a plausible-but-wrong operator the model might invent.
      { field: 'revenue', sourceId: 'src1', operator: 'eq', value: 1 },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/invalid filter operator/i);
    expect(out.error as string).toContain('equals');
    // Nothing committed to state on a rejected operator.
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });

  it('returns an error (not success) when there is no active page, and does not mutate', () => {
    // activePageId points at a page that does not exist in `pages`.
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'gone' },
        pages: {},
        widgets: {},
      },
    });
    const result = executeToolOnState(
      'add_page_filter',
      { field: 'revenue', sourceId: 'src1', operator: 'equals', value: 1 },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/no active page/i);
    expect(out.success).toBeUndefined();
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });

  it('accepts every valid StudioFilterOperator', () => {
    const state = makeState();
    const operators = [
      'equals',
      'not_equals',
      'in',
      'not_in',
      'contains',
      'does_not_contain',
      'starts_with',
      'not_starts_with',
      'ends_with',
      'not_ends_with',
      'is_empty',
      'is_not_empty',
      'greater_than',
      'less_than',
      'greater_than_or_equal',
      'less_than_or_equal',
      'between',
    ];
    for (const operator of operators) {
      const out = parseOutput(
        executeToolOnState(
          'add_page_filter',
          { field: 'revenue', sourceId: 'src1', operator, value: 1 },
          state,
        ).output,
      );
      expect(out.success, `operator ${operator} should be accepted`).toBe(true);
    }
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

  it('rejects an unknown filter operator with a clear error', () => {
    const state = makeState();
    const result = executeToolOnState(
      'add_widget_filter',
      { widgetId: 'widget-1', field: 'revenue', sourceId: 'src1', operator: '==', value: 1 },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/invalid filter operator/i);
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });

  it('returns an error (not success) for an unknown widgetId, and does not mutate', () => {
    // Matches every sibling entity-targeting tool: a fabricated/stale widgetId is
    // rejected up front instead of committing a dangling widget-scoped filter.
    const state = makeState();
    const result = executeToolOnState(
      'add_widget_filter',
      {
        widgetId: 'does-not-exist',
        field: 'revenue',
        sourceId: 'src1',
        operator: 'equals',
        value: 1,
      },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/does-not-exist.*not found/i);
    expect(out.success).toBeUndefined();
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
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
    const ids = (result.nextState.doc.filters ?? []).map((f) => f.id);
    expect(ids).not.toContain('filter-1');
  });

  it('returns an error (not success) for a nonexistent filterId, and does not mutate', () => {
    const state = makeState();
    const result = executeToolOnState(
      'remove_page_filter',
      { filterId: 'nonexistent-filter' },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/nonexistent-filter.*not found/i);
    expect(out.success).toBeUndefined();
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
  });
});

describe('executeToolOnState: remove_widget_filter', () => {
  it('emits a removeFilter mutation (same handler as remove_page_filter)', () => {
    const state = makeState();
    const result = executeToolOnState('remove_widget_filter', { filterId: 'filter-1' }, state);
    expect(result.mutation?.type).toBe('removeFilter');
  });

  it('returns an error (not success) for a nonexistent filterId, and does not mutate', () => {
    const state = makeState();
    const result = executeToolOnState(
      'remove_widget_filter',
      { filterId: 'nonexistent-filter' },
      state,
    );
    const out = parseOutput(result.output);
    expect(out.error).toMatch(/nonexistent-filter.*not found/i);
    expect(out.success).toBeUndefined();
    expect(result.mutation).toBeUndefined();
    expect(result.nextState).toBe(state);
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
    expect(result.nextState.doc.widgets['widget-1'].title).toBe('Renamed');
  });

  it('applies widget removals in nextState', () => {
    const state = makeState();
    const result = executeToolOnState('apply_bulk_update', { widgetRemovals: ['widget-1'] }, state);
    expect(result.nextState.doc.widgets['widget-1']).toBeUndefined();
  });

  it('skips a removal for a widget that lives on another page (no dangling reference)', () => {
    const base = makeState();
    // widget-2 lives on page-2, but the active page is page-1.
    const state: StudioState = {
      ...base,
      doc: {
        ...base.doc,
        pages: {
          ...base.doc.pages,
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['widget-2']] },
        },
        widgets: {
          ...base.doc.widgets,
          'widget-2': {
            id: 'widget-2',
            kind: 'chart',
            title: 'Other',
            config: { chartType: 'bar' },
          },
        },
      },
    };
    const result = executeToolOnState('apply_bulk_update', { widgetRemovals: ['widget-2'] }, state);
    const out = parseOutput(result.output);
    expect(out.skipped).toEqual(['remove widget-2: not on the active page']);
    // widget-2 must survive on page-2 — it was not deleted from `widgets`.
    expect(result.nextState.doc.widgets['widget-2']).toBeDefined();
    expect(result.nextState.doc.pages['page-2'].widgetRows).toEqual([['widget-2']]);
  });

  it('builds additions via the shared helper: layered config + a unique id', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      { widgetAdditions: [{ kind: 'chart', title: 'A', config: { chartType: 'line' } }] },
      state,
    );
    const addedIds = Object.keys(result.nextState.doc.widgets).filter((id) => id !== 'widget-1');
    expect(addedIds).toHaveLength(1);
    const added = result.nextState.doc.widgets[addedIds[0]];
    expect(added.id).toMatch(/^widget-/);
    if (!isWidgetOfKind(added, 'chart')) {
      throw new Error('expected added widget to be a chart widget');
    }
    // Factory default (chartType) is overlaid by the model-supplied config.
    expect(added.config.chartType).toBe('line');
  });

  it('skips an addition with a cross-kind config key but applies a valid one alongside it', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      {
        widgetAdditions: [
          { kind: 'grid', title: 'Bad Grid', config: { chartType: 'bar' } },
          { kind: 'chart', title: 'Good Chart', config: { chartType: 'line' } },
        ],
      },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { added: number };
    expect(applied.added).toBe(1);
    expect(out.skipped).toEqual(expect.arrayContaining([expect.stringMatching(/chartType/)]));
    const addedIds = Object.keys(result.nextState.doc.widgets).filter((id) => id !== 'widget-1');
    expect(addedIds).toHaveLength(1);
    expect(result.nextState.doc.widgets[addedIds[0]].title).toBe('Good Chart');
  });

  it('skips an update with a cross-kind config key and leaves the widget unchanged', () => {
    const state = makeState(); // widget-1 is kind 'chart'
    const result = executeToolOnState(
      'apply_bulk_update',
      { widgetUpdates: [{ widgetId: 'widget-1', config: { gridHeight: 400 } }] },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { updated: number };
    expect(applied.updated).toBe(0);
    expect(out.skipped).toEqual(expect.arrayContaining([expect.stringMatching(/gridHeight/)]));
    expect(result.nextState.doc.widgets['widget-1'].config).toEqual({ chartType: 'bar' });
  });

  it('skips an update with a cross-CHART-TYPE config key against an existing chart widget', () => {
    const state = makeState(); // widget-1 is kind 'chart', chartType 'bar'
    const result = executeToolOnState(
      'apply_bulk_update',
      // `sankeyTargetField` is a valid CHART key, but not for 'bar'.
      { widgetUpdates: [{ widgetId: 'widget-1', config: { sankeyTargetField: 'x' } }] },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { updated: number };
    expect(applied.updated).toBe(0);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/sankeyTargetField/)]),
    );
    expect(result.nextState.doc.widgets['widget-1'].config).toEqual({ chartType: 'bar' });
  });

  it('resolves the kind of a same-batch addition when validating a same-batch update', () => {
    // The widget id minted for the addition isn't known until `buildWidgetFromArgs`
    // runs INSIDE `apply_bulk_update`, so to target it with a `widgetUpdates` entry
    // in the very same call, the id is predicted ahead of time: `Math.random`/`Date.now`
    // are pinned, a throwaway `createWidgetId()` "probe" call reveals the current
    // per-process sequence counter, and the next id (sequence + 1 — the one the
    // addition below will mint) is computed from the exact same format.
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    try {
      const probeId = createWidgetId();
      const [, timestamp, sequenceBase36, randomSuffix] = probeId.split('-');
      const predictedSequence = (parseInt(sequenceBase36, 36) + 1).toString(36);
      const predictedId = `widget-${timestamp}-${predictedSequence}-${randomSuffix}`;

      const state = makeState();
      const result = executeToolOnState(
        'apply_bulk_update',
        {
          widgetAdditions: [{ kind: 'grid', title: 'New Grid' }],
          widgetUpdates: [{ widgetId: predictedId, config: { chartType: 'bar' } }],
        },
        state,
      );

      // Sanity check: the prediction actually landed — the addition minted exactly
      // the id we predicted, as a grid widget.
      expect(result.nextState.doc.widgets[predictedId]).toBeDefined();
      expect(result.nextState.doc.widgets[predictedId].kind).toBe('grid');

      const out = parseOutput(result.output);
      const applied = out.applied as { added: number; updated: number };
      expect(applied.added).toBe(1);
      // The update against that SAME (same-batch, not-yet-in-`state.doc.widgets`)
      // widget, carrying a chart-only key, must be skipped — proving the kind was
      // resolved from the same-batch addition (not misreported as "not found", and
      // not silently accepted as valid).
      expect(applied.updated).toBe(0);
      expect(out.skipped).toEqual(expect.arrayContaining([expect.stringMatching(/chartType/)]));
      expect(out.skipped).not.toEqual(expect.arrayContaining([expect.stringMatching(/not found/)]));
      // The addition's config is unaffected by the skipped update.
      expect(result.nextState.doc.widgets[predictedId].config).not.toHaveProperty('chartType');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('resolves the chartType of a same-batch chart addition when validating a same-batch update', () => {
    // Same id-prediction technique as the kind-resolution test above, but here the
    // same-batch addition IS a chart widget (with an explicit chartType), and the
    // same-batch update carries a key that is valid for the CHART kind but not for
    // that specific chartType — proving the chartType (not just the kind) was
    // resolved from the same-batch addition.
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    try {
      const probeId = createWidgetId();
      const [, timestamp, sequenceBase36, randomSuffix] = probeId.split('-');
      const predictedSequence = (parseInt(sequenceBase36, 36) + 1).toString(36);
      const predictedId = `widget-${timestamp}-${predictedSequence}-${randomSuffix}`;

      const state = makeState();
      const result = executeToolOnState(
        'apply_bulk_update',
        {
          widgetAdditions: [{ kind: 'chart', title: 'New Gauge', config: { chartType: 'gauge' } }],
          // `sankeyTargetField` is a valid CHART key but not valid for 'gauge'.
          widgetUpdates: [{ widgetId: predictedId, config: { sankeyTargetField: 'x' } }],
        },
        state,
      );

      // Sanity check: the prediction landed — the addition minted exactly the id
      // we predicted, as a gauge chart widget.
      expect(result.nextState.doc.widgets[predictedId]).toBeDefined();
      expect(result.nextState.doc.widgets[predictedId].kind).toBe('chart');
      expect(
        (result.nextState.doc.widgets[predictedId].config as Record<string, unknown>).chartType,
      ).toBe('gauge');

      const out = parseOutput(result.output);
      const applied = out.applied as { added: number; updated: number };
      expect(applied.added).toBe(1);
      expect(applied.updated).toBe(0);
      expect(out.skipped).toEqual(
        expect.arrayContaining([expect.stringMatching(/sankeyTargetField/)]),
      );
      // The addition's config is unaffected by the skipped update.
      expect(result.nextState.doc.widgets[predictedId].config).not.toHaveProperty(
        'sankeyTargetField',
      );
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('validates a same-batch update against the chartType an EARLIER same-batch update set (no false reject)', () => {
    // widget-1 starts as a 'bar' chart. In ONE bulk call: first change it to 'sankey',
    // then set `sankeyTargetField` (valid only for 'sankey'). The second update must be
    // accepted — it validates against the chartType the first update set in this same
    // batch, not the pre-batch 'bar' snapshot (which would falsely reject it).
    const state = makeState(); // widget-1: kind 'chart', chartType 'bar'
    const result = executeToolOnState(
      'apply_bulk_update',
      {
        widgetUpdates: [
          { widgetId: 'widget-1', config: { chartType: 'sankey' } },
          { widgetId: 'widget-1', config: { sankeyTargetField: 'region' } },
        ],
      },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { updated: number };
    expect(applied.updated).toBe(2);
    expect(out.skipped).toBeUndefined();
    // Both deltas landed: the widget is now a sankey chart carrying the sankey key.
    const finalConfig = result.nextState.doc.widgets['widget-1'].config as Record<string, unknown>;
    expect(finalConfig.chartType).toBe('sankey');
    expect(finalConfig.sankeyTargetField).toBe('region');
  });

  it('validates a same-batch update against the NEW chartType, preventing a false accept', () => {
    // Reverse of the false-reject case: widget-1 starts as a 'sankey' chart. In ONE
    // bulk call, first change it to 'gauge', then set `sankeyTargetField` (valid for
    // sankey, NOT for gauge). The second update must be SKIPPED — validated against
    // the 'gauge' set earlier in this batch, not the stale pre-batch 'sankey' (which
    // would falsely accept a now-invalid key onto a gauge chart).
    const base = makeState();
    const sankeyState: StudioState = {
      ...base,
      doc: {
        ...base.doc,
        widgets: {
          'widget-1': {
            ...base.doc.widgets['widget-1'],
            kind: 'chart' as const,
            config: { chartType: 'sankey' as const },
          },
        },
      },
    };
    const result = executeToolOnState(
      'apply_bulk_update',
      {
        widgetUpdates: [
          { widgetId: 'widget-1', config: { chartType: 'gauge' } },
          { widgetId: 'widget-1', config: { sankeyTargetField: 'region' } },
        ],
      },
      sankeyState,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { updated: number };
    // Only the chartType change is accepted; the sankey-only key is rejected.
    expect(applied.updated).toBe(1);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/sankeyTargetField/)]),
    );
    const finalConfig = result.nextState.doc.widgets['widget-1'].config as Record<string, unknown>;
    expect(finalConfig.chartType).toBe('gauge');
    expect(finalConfig).not.toHaveProperty('sankeyTargetField');
  });

  it('rejects an update targeting a widget removed earlier in the same batch (no crash, clear skip)', () => {
    const state = makeState(); // widget-1 on the active page
    const result = executeToolOnState(
      'apply_bulk_update',
      {
        widgetRemovals: ['widget-1'],
        widgetUpdates: [{ widgetId: 'widget-1', title: 'Renamed after removal' }],
      },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { removed: number; updated: number };
    expect(applied.removed).toBe(1);
    expect(applied.updated).toBe(0);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/update widget-1: not found/)]),
    );
    // The widget is gone and no phantom update was emitted for it.
    expect(result.nextState.doc.widgets['widget-1']).toBeUndefined();
    const args = (result.mutation as { args: { updatedWidgets: unknown[] } }).args;
    expect(args.updatedWidgets).toEqual([]);
  });

  it('validates the bulk layout the same way set_widget_layout does: a flat (mis-shaped) array is skipped', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      // A flat array of ids instead of an array-of-rows — the exact shape mistake the
      // single-widget set_widget_layout handler rejects. It must be caught here too.
      { layout: ['widget-1'] },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { layout: boolean };
    expect(applied.layout).toBe(false);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/layout: must be an array of rows/)]),
    );
    // The active page's original layout is untouched.
    expect(result.nextState.doc.pages['page-1'].widgetRows).toEqual([['widget-1']]);
  });

  it('skips a bulk layout that references an unknown/removed widget id', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      {
        widgetRemovals: ['widget-1'],
        // References widget-1, which this same batch just removed → unknown after removal.
        layout: [['widget-1']],
      },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { layout: boolean; removed: number };
    expect(applied.removed).toBe(1);
    expect(applied.layout).toBe(false);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/layout: unknown or removed widget IDs/)]),
    );
  });

  it('rejects an out-of-range colSpan with a skipped entry instead of silently dropping it', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      { colSpans: { 'widget-1': 100 } },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { colSpans: number };
    expect(applied.colSpans).toBe(0);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/colSpan widget-1: 100 is out of range/)]),
    );
    // Nothing landed in the page's widgetColSpans for the rejected widget.
    expect(result.nextState.doc.pages['page-1'].widgetColSpans?.['widget-1']).toBeUndefined();
  });

  it('rejects a non-numeric colSpan with a skipped entry', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      { colSpans: { 'widget-1': 'wide' as unknown as number } },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { colSpans: number };
    expect(applied.colSpans).toBe(0);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/colSpan widget-1: "wide" is out of range/)]),
    );
  });

  it('applies an in-range colSpan normally (no skipped entry)', () => {
    const state = makeState();
    const result = executeToolOnState('apply_bulk_update', { colSpans: { 'widget-1': 12 } }, state);
    const out = parseOutput(result.output);
    const applied = out.applied as { colSpans: number };
    expect(applied.colSpans).toBe(1);
    expect(out.skipped).toBeUndefined();
    expect(result.nextState.doc.pages['page-1'].widgetColSpans?.['widget-1']).toBe(12);
  });

  // Regression for T2-4 sub-issue 2: duplicate layout ids. The reducer's
  // `dedupeLayoutRows` silently keeps the first occurrence, so an `applied.layout: true`
  // would overstate what committed. Reject with a skip, mirroring set_widget_layout.
  it('rejects a bulk layout with duplicate widget IDs instead of silently deduping', () => {
    const base = makeState();
    const twoWidgetState: StudioState = {
      ...base,
      doc: {
        ...base.doc,
        pages: {
          'page-1': { ...base.doc.pages['page-1'], widgetRows: [['widget-1', 'widget-2']] },
        },
        widgets: {
          ...base.doc.widgets,
          'widget-2': { id: 'widget-2', kind: 'chart', title: 'W2', config: { chartType: 'bar' } },
        },
      },
    };
    const result = executeToolOnState(
      'apply_bulk_update',
      // widget-1 appears in two cells — a self-overlapping layout.
      { layout: [['widget-1', 'widget-2'], ['widget-1']] },
      twoWidgetState,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { layout: boolean };
    expect(applied.layout).toBe(false);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/layout: duplicate widget IDs/)]),
    );
    // The original layout is untouched — the reducer never got a chance to dedupe.
    expect(result.nextState.doc.pages['page-1'].widgetRows).toEqual([['widget-1', 'widget-2']]);
  });

  // Regression for T2-4 sub-issue 1: colSpans membership. The reducer prunes a span
  // whose widget isn't on the active page's post-batch rows, so counting it in
  // `applied.colSpans` overstates what actually landed. Three membership misses:
  it('skips a colSpan for a nonexistent widget rather than counting it applied', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      { colSpans: { 'no-such-widget': 12 } },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { colSpans: number };
    expect(applied.colSpans).toBe(0);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/colSpan no-such-widget: widget not found/)]),
    );
    expect(result.nextState.doc.pages['page-1'].widgetColSpans?.['no-such-widget']).toBeUndefined();
  });

  it('skips a colSpan for a widget that lives on another page (reducer would prune it)', () => {
    const state = makeMultiPageState(); // page-1 active, widget-2 on page-2
    const result = executeToolOnState('apply_bulk_update', { colSpans: { 'widget-2': 12 } }, state);
    const out = parseOutput(result.output);
    const applied = out.applied as { colSpans: number };
    expect(applied.colSpans).toBe(0);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/colSpan widget-2: not on the active page/)]),
    );
    // Nothing lands on either page — matching the reducer's orphan-span pruning.
    expect(result.nextState.doc.pages['page-1'].widgetColSpans?.['widget-2']).toBeUndefined();
    expect(result.nextState.doc.pages['page-2'].widgetColSpans?.['widget-2']).toBeUndefined();
  });

  it('skips a colSpan for a widget removed earlier in the same batch', () => {
    const state = makeState();
    const result = executeToolOnState(
      'apply_bulk_update',
      { widgetRemovals: ['widget-1'], colSpans: { 'widget-1': 12 } },
      state,
    );
    const out = parseOutput(result.output);
    const applied = out.applied as { colSpans: number; removed: number };
    expect(applied.removed).toBe(1);
    expect(applied.colSpans).toBe(0);
    expect(out.skipped).toEqual(
      expect.arrayContaining([expect.stringMatching(/colSpan widget-1: widget not found/)]),
    );
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
      doc: {
        ...base.doc,
        ai: {
          activeThreadId: 't-req',
          threads: [
            { id: 't-req', name: 'Old', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
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

    expect(state.doc.pages[newPageId].title).toBe('Metrics');
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
      doc: {
        ...baseState.doc,
        widgets: {
          'widget-1': {
            ...baseState.doc.widgets['widget-1'],
            kind: 'chart' as const,
            config: { chartType: 'line' as const },
          },
        },
      },
    };
    const result = executeToolOnState(
      'set_widget_forecast',
      { widgetId: 'widget-1', enabled: true, periods: 6 },
      lineState,
    );
    expect(parseOutput(result.output).success).toBe(true);
    const updatedWidget1 = result.nextState.doc.widgets['widget-1'];
    if (!isWidgetOfKind(updatedWidget1, 'chart')) {
      throw new Error('expected widget-1 to remain a chart widget');
    }
    expect((updatedWidget1.config as StudioChartConfig).forecast?.enabled).toBe(true);
    expect((updatedWidget1.config as StudioChartConfig).forecast?.periods).toBe(6);
    expect(result.mutation?.type).toBe('updateWidget');
  });

  it('disables forecast by setting enabled: false', () => {
    const baseState = makeState();
    const lineState = {
      ...baseState,
      doc: {
        ...baseState.doc,
        widgets: {
          'widget-1': {
            ...baseState.doc.widgets['widget-1'],
            kind: 'chart' as const,
            config: {
              chartType: 'line' as const,
              forecast: { enabled: true, periods: 3 },
            },
          },
        },
      },
    };
    const result = executeToolOnState(
      'set_widget_forecast',
      { widgetId: 'widget-1', enabled: false },
      lineState,
    );
    const updatedWidget1 = result.nextState.doc.widgets['widget-1'];
    if (!isWidgetOfKind(updatedWidget1, 'chart')) {
      throw new Error('expected widget-1 to remain a chart widget');
    }
    expect((updatedWidget1.config as StudioChartConfig).forecast?.enabled).toBe(false);
  });

  it('enables forecast with confidence bands', () => {
    const baseState = makeState();
    const areaState = {
      ...baseState,
      doc: {
        ...baseState.doc,
        widgets: {
          'widget-1': {
            ...baseState.doc.widgets['widget-1'],
            kind: 'chart' as const,
            config: { chartType: 'area' as const },
          },
        },
      },
    };
    const result = executeToolOnState(
      'set_widget_forecast',
      { widgetId: 'widget-1', enabled: true, showConfidenceBands: true },
      areaState,
    );
    const updatedWidget1 = result.nextState.doc.widgets['widget-1'];
    if (!isWidgetOfKind(updatedWidget1, 'chart')) {
      throw new Error('expected widget-1 to remain a chart widget');
    }
    expect((updatedWidget1.config as StudioChartConfig).forecast?.showConfidenceBands).toBe(true);
  });

  it('merges the forecast delta, preserving pre-existing unrelated config keys', () => {
    // A line widget with several unrelated config keys already set. Enabling the
    // forecast must MERGE just the forecast field, not wholesale-replace the config
    // (which would drop title/color/series settings the widget already had).
    const baseState = makeState();
    const richState = {
      ...baseState,
      doc: {
        ...baseState.doc,
        widgets: {
          'widget-1': {
            ...baseState.doc.widgets['widget-1'],
            kind: 'chart' as const,
            config: {
              chartType: 'line' as const,
              xField: 'month',
              yField: 'revenue',
              yAggregation: 'sum' as const,
              crossFilterMode: 'cross-filter' as const,
            },
          },
        },
      },
    };
    const result = executeToolOnState(
      'set_widget_forecast',
      { widgetId: 'widget-1', enabled: true, periods: 4 },
      richState,
    );
    expect(parseOutput(result.output).success).toBe(true);
    const config = result.nextState.doc.widgets['widget-1'].config as Record<string, unknown>;
    // Forecast applied…
    expect((config.forecast as { enabled: boolean }).enabled).toBe(true);
    // …and every pre-existing key survived (this is the wholesale-replace regression).
    expect(config.chartType).toBe('line');
    expect(config.xField).toBe('month');
    expect(config.yField).toBe('revenue');
    expect(config.yAggregation).toBe('sum');
    expect(config.crossFilterMode).toBe('cross-filter');
    // The mutation carries a partial `config` patch (merge path), not a `changes.config`
    // wholesale replacement.
    const mut = result.mutation as {
      args: { config?: Record<string, unknown>; changes?: Record<string, unknown> };
    };
    expect(mut.args.config).toBeDefined();
    expect(mut.args.config && Object.keys(mut.args.config)).toEqual(['forecast']);
    expect(mut.args.changes?.config).toBeUndefined();
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
    query_data_source: { sourceId: 'src1' },
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
