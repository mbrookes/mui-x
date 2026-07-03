import { describe, expect, it } from 'vitest';
import { applyMutation, mutationLabel } from './applyMutation';
import { createDefaultStudioState } from './stateTypes';
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

  it('returns the same reference for a no-op (unknown active thread on renameAIThread)', () => {
    const state = twoPageState();
    const next = applyMutation(state, { type: 'renameAIThread', args: { name: 'x' } });
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
    expect(mutationLabel({ type: 'renameAIThread', args: { name: 't' } })).toBe('renameAIThread');
    expect(mutationLabel({ type: 'addWidget', args: { widget: chartWidget('w1') } })).toBe(
      'addWidget:chart:w1',
    );
  });
});
