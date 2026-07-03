import { describe, expect, it } from 'vitest';
import { createDefaultStudioState } from '@mui/x-studio-schema';
import { applyMutation, mutationLabel } from './applyMutation';
import type { StudioState } from './stateTypes';
import type { StudioWidget } from './widgetTypes';

const chartWidget = (id: string, title = 'W'): StudioWidget => ({
  id,
  kind: 'chart',
  title,
  config: { chartType: 'bar' },
});

function twoPageState(activePageId = 'page-1'): StudioState {
  return createDefaultStudioState({
    dashboard: { id: 'd1', title: 'D', activePageId },
    pages: {
      'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
      'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
    },
  });
}

describe('applyMutation', () => {
  it('is pure — does not mutate the input state', () => {
    const state = twoPageState();
    const before = JSON.stringify(state);
    applyMutation(state, { type: 'setDashboardTitle', args: { title: 'X' } });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('addWidget targets the explicit pageId, not the active page', () => {
    // Active page is page-2, but the mutation targets page-1.
    const state = twoPageState('page-2');
    const next = applyMutation(state, {
      type: 'addWidget',
      args: { widget: chartWidget('w1'), pageId: 'page-1' },
    });
    expect(next.pages['page-1'].widgetRows.flat()).toContain('w1');
    expect(next.pages['page-2'].widgetRows.flat()).not.toContain('w1');
  });

  it('addWidget falls back to the active page when pageId is omitted', () => {
    const state = twoPageState('page-2');
    const next = applyMutation(state, { type: 'addWidget', args: { widget: chartWidget('w1') } });
    expect(next.pages['page-2'].widgetRows.flat()).toContain('w1');
  });

  it('removePage cleans up widgets, page-scoped filters, and reassigns activePageId', () => {
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [['w2']] },
      },
      widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      filters: [
        {
          id: 'fp1',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'page', pageId: 'page-1' },
        },
        {
          id: 'fp2',
          field: 'x',
          operator: 'equals',
          value: 2,
          scope: { kind: 'page', pageId: 'page-2' },
        },
      ],
    });
    const next = applyMutation(state, { type: 'removePage', args: { pageId: 'page-1' } });
    expect(next.pages['page-1']).toBeUndefined();
    expect(next.widgets.w1).toBeUndefined();
    expect(next.widgets.w2).toBeDefined();
    expect(next.filters.map((f) => f.id)).toEqual(['fp2']);
    expect(next.dashboard.activePageId).toBe('page-2');
  });

  it("removePage: removing the last remaining page results in activePageId === ''", () => {
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
      },
    });
    const next = applyMutation(state, { type: 'removePage', args: { pageId: 'page-1' } });
    expect(next.pages['page-1']).toBeUndefined();
    expect(next.dashboard.activePageId).toBe('');
  });

  it('removeWidget drops the widget from every page and its widget-scoped filters', () => {
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      widgets: { w1: chartWidget('w1') },
      filters: [
        {
          id: 'fw',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'widget', widgetId: 'w1' },
        },
      ],
    });
    const next = applyMutation(state, { type: 'removeWidget', args: { widgetId: 'w1' } });
    expect(next.widgets.w1).toBeUndefined();
    expect(next.pages['page-1'].widgetRows.flat()).not.toContain('w1');
    expect(next.filters).toHaveLength(0);
  });

  it('removeWidget also drops interactive-scope filters whose sourceWidgetId is the removed widget', () => {
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      widgets: { w1: chartWidget('w1') },
      filters: [
        {
          id: 'fi',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
        },
      ],
    });
    const next = applyMutation(state, { type: 'removeWidget', args: { widgetId: 'w1' } });
    expect(next.filters).toHaveLength(0);
  });

  it('addFilter appends the filter verbatim (scope not re-stamped)', () => {
    const state = twoPageState('page-1');
    const filter = {
      id: 'f',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const, pageId: 'page-9' },
    };
    const next = applyMutation(state, { type: 'addFilter', args: { filter } });
    expect(next.filters[0].scope).toEqual({ kind: 'page', pageId: 'page-9' });
  });

  it('removeFilter: unknown filterId is a no-op', () => {
    const state = twoPageState();
    const next = applyMutation(state, { type: 'removeFilter', args: { filterId: 'nope' } });
    expect(next).toBe(state);
  });

  describe('updateWidget', () => {
    it('an explicit undefined value in the config patch deletes that key', () => {
      const state = createDefaultStudioState({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar', xGroupBy: 'month' },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', config: { xGroupBy: undefined } },
      });
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar' });
      expect('xGroupBy' in next.widgets.w1.config).toBe(false);
    });

    it('changes.config wholesale-replaces the config-patch result rather than merging with it', () => {
      const state = createDefaultStudioState({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar', xGroupBy: 'month' },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'updateWidget',
        args: {
          widgetId: 'w1',
          // Patch applied first: would produce { chartType: 'bar', xGroupBy: 'week' }...
          config: { xGroupBy: 'week' },
          // ...but `changes.config` replaces that result wholesale.
          changes: { config: { chartType: 'line' } },
        },
      });
      expect(next.widgets.w1.config).toEqual({ chartType: 'line' });
    });

    it('unknown widgetId is a no-op', () => {
      const state = twoPageState();
      const next = applyMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'nope', changes: { title: 'x' } },
      });
      expect(next).toBe(state);
    });
  });

  describe('setWidgetColSpan', () => {
    it('clamps a too-small requested span up to 3', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 2, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 3 });
    });

    it('clamps a too-large requested span down to 12', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 15, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
    });

    it('rounds a non-integer span', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 7.6, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 8 });
    });

    it("columns: null deletes that widget's span entry, collapsing the map to undefined when empty", () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1']],
            widgetColSpans: { w1: 6 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: null, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    it('overflow with exactly one other widget: reduces its span to the remainder when >= 3', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1', 'w2']],
            widgetColSpans: { w2: 8 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 6, rowWidgetIds: ['w1', 'w2'] },
      });
      // clamped(w1) = 6, other total = 8, 6 + 8 = 14 > 12, one other widget
      // => remaining = 12 - 6 = 6, which is >= 3, so w2 is reduced (not deleted).
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 6, w2: 6 });
    });

    it('overflow with exactly one other widget: deletes its span entirely when the remainder is < 3', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1', 'w2']],
            widgetColSpans: { w2: 5 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 10, rowWidgetIds: ['w1', 'w2'] },
      });
      // remaining = 12 - 10 = 2, which is < 3, so w2's span is dropped entirely.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 10 });
    });

    it('overflow with two or more other widgets: deletes all of their spans (not just reduces)', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1', 'w2', 'w3']],
            widgetColSpans: { w2: 5, w3: 5 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 8, rowWidgetIds: ['w1', 'w2', 'w3'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 8 });
    });

    it('missing active page is a no-op', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'ghost-page' },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 6, rowWidgetIds: ['w1'] },
      });
      expect(next).toBe(state);
    });
  });

  describe('addPage', () => {
    it('also sets the new page as dashboard.activePageId (deliberate — not an accident)', () => {
      const state = twoPageState('page-2');
      const next = applyMutation(state, { type: 'addPage', args: { id: 'page-3', title: 'New' } });
      expect(next.pages['page-3']).toMatchObject({ id: 'page-3', title: 'New' });
      expect(next.dashboard.activePageId).toBe('page-3');
    });
  });

  describe('setWidgetLayout', () => {
    it('replaces the active page rows only', () => {
      const state = twoPageState('page-1');
      const next = applyMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['a', 'b'], ['c']] },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['a', 'b'], ['c']]);
      expect(next.pages['page-2'].widgetRows).toEqual([]);
    });
  });

  describe('renamePage', () => {
    it('renames the page', () => {
      const state = twoPageState();
      const next = applyMutation(state, {
        type: 'renamePage',
        args: { pageId: 'page-1', title: 'Renamed' },
      });
      expect(next.pages['page-1'].title).toBe('Renamed');
    });

    it('unknown pageId is a no-op', () => {
      const state = twoPageState();
      const next = applyMutation(state, {
        type: 'renamePage',
        args: { pageId: 'nope', title: 'X' },
      });
      expect(next).toBe(state);
    });
  });

  describe('setActivePage', () => {
    it('switches the active page', () => {
      const state = twoPageState('page-1');
      const next = applyMutation(state, { type: 'setActivePage', args: { pageId: 'page-2' } });
      expect(next.dashboard.activePageId).toBe('page-2');
    });

    it('unknown pageId is a no-op', () => {
      const state = twoPageState();
      const next = applyMutation(state, { type: 'setActivePage', args: { pageId: 'nope' } });
      expect(next).toBe(state);
    });
  });

  describe('applyBulkUpdate', () => {
    it('replaces widgets globally but only touches widgetRows/widgetColSpans on activePageId', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['old1']] },
          'page-2': {
            id: 'page-2',
            title: 'P2',
            widgetRows: [['old2']],
            widgetColSpans: { old2: 6 },
          },
        },
        widgets: { old1: chartWidget('old1'), old2: chartWidget('old2') },
      });
      const newWidgets = { new1: chartWidget('new1') };
      const next = applyMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          widgets: newWidgets,
          widgetRows: [['new1']],
          widgetColSpans: { new1: 6 },
          activePageId: 'page-1',
        },
      });
      expect(next.widgets).toEqual(newWidgets);
      expect(next.pages['page-1'].widgetRows).toEqual([['new1']]);
      expect(next.pages['page-1'].widgetColSpans).toEqual({ new1: 6 });
      // page-2, not the active page, is untouched.
      expect(next.pages['page-2'].widgetRows).toEqual([['old2']]);
      expect(next.pages['page-2'].widgetColSpans).toEqual({ old2: 6 });
    });

    it('missing activePageId page is a no-op', () => {
      const state = twoPageState();
      const next = applyMutation(state, {
        type: 'applyBulkUpdate',
        args: { widgets: {}, widgetRows: [], widgetColSpans: {}, activePageId: 'nope' },
      });
      expect(next).toBe(state);
    });
  });

  describe('renameAIThread', () => {
    it('renames only the active thread', () => {
      const state = createDefaultStudioState({
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old1', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
            { id: 't2', name: 'Old2', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      });
      const next = applyMutation(state, {
        type: 'renameAIThread',
        args: { name: 'New1', updatedAt: '2024-06-01T00:00:00.000Z' },
      });
      expect(next.ai?.threads[0].name).toBe('New1');
      expect(next.ai?.threads[0].updatedAt).toBe('2024-06-01T00:00:00.000Z');
      expect(next.ai?.threads[1].name).toBe('Old2');
      expect(next.ai?.threads[1].updatedAt).toBeUndefined();
    });

    it('returns the same reference for a no-op (no active thread)', () => {
      const state = twoPageState();
      const next = applyMutation(state, {
        type: 'renameAIThread',
        args: { name: 'x', updatedAt: '2024-01-01T00:00:00.000Z' },
      });
      expect(next).toBe(state);
    });
  });

  it('an unrecognized mutation type is a graceful no-op', () => {
    const state = twoPageState();
    const bogus = { type: 'bogusMutation', args: {} } as any;
    const next = applyMutation(state, bogus);
    expect(next).toBe(state);
  });
});

describe('mutationLabel', () => {
  it('produces labels for every mutation type (incl. the ones mcpMutationLabel dropped)', () => {
    expect(mutationLabel({ type: 'setDashboardTitle', args: { title: 't' } })).toBe(
      'setDashboardTitle',
    );
    expect(
      mutationLabel({
        type: 'applyBulkUpdate',
        args: { widgets: {}, widgetRows: [], widgetColSpans: {}, activePageId: 'p' },
      }),
    ).toBe('applyBulkUpdate');
    expect(
      mutationLabel({
        type: 'renameAIThread',
        args: { name: 't', updatedAt: '2024-01-01T00:00:00.000Z' },
      }),
    ).toBe('renameAIThread');
    expect(mutationLabel({ type: 'addWidget', args: { widget: chartWidget('w1') } })).toBe(
      'addWidget:chart:w1',
    );
  });

  it('returns the raw type string for an unrecognized mutation type, without throwing', () => {
    const bogus = { type: 'bogusMutation', args: {} } as any;
    expect(() => mutationLabel(bogus)).not.toThrow();
    expect(mutationLabel(bogus)).toBe('bogusMutation');
  });
});
