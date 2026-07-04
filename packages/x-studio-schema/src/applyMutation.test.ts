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

  it('addWidget is idempotent: re-delivering the same event does not add a duplicate row', () => {
    const mutation = {
      type: 'addWidget' as const,
      args: { widget: chartWidget('w1'), pageId: 'page-1' },
    };
    const state = applyMutation(twoPageState('page-1'), mutation);
    const next = applyMutation(state, mutation);
    // No duplicate row for the already-placed widget, and reference-stable no-op.
    expect(next).toBe(state);
    expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
    expect(next.pages['page-1'].widgetRows.flat().filter((id) => id === 'w1')).toHaveLength(1);
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

  it("removePage also drops widget-scoped filters targeting the deleted page's widgets", () => {
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [['w2']] },
      },
      widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      filters: [
        // Widget-scope filters carry no pageId — without the fix these survive as
        // permanent orphans once their anchor widget's page is removed.
        {
          id: 'fw1',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'widget', widgetId: 'w1' },
        },
        {
          id: 'fx1',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
        },
        // A widget-scope filter for a widget on the surviving page must be kept.
        {
          id: 'fw2',
          field: 'x',
          operator: 'equals',
          value: 2,
          scope: { kind: 'widget', widgetId: 'w2' },
        },
      ],
    });
    const next = applyMutation(state, { type: 'removePage', args: { pageId: 'page-1' } });
    expect(next.filters.map((f) => f.id)).toEqual(['fw2']);
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

  it('removeWidget also drops cross-filter-scope filters emitted by the removed widget', () => {
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1', 'w2']] } },
      widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      filters: [
        {
          id: 'fx',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
        },
      ],
    });
    const next = applyMutation(state, { type: 'removeWidget', args: { widgetId: 'w1' } });
    // The cross-filter emitted by the removed source widget must not survive (its
    // clearing affordance is gone, so it would filter the page permanently).
    expect(next.filters).toHaveLength(0);
  });

  it("removeWidget cleans its own span and collapses a now-sole-occupant sibling's span", () => {
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': {
          id: 'page-1',
          title: 'P1',
          widgetRows: [['w1', 'w2']],
          widgetColSpans: { w1: 16, w2: 8 },
        },
      },
      widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
    });
    const next = applyMutation(state, { type: 'removeWidget', args: { widgetId: 'w1' } });
    // w1's span is gone, and w2 (now alone in its row) has its span cleared so it
    // renders full-width — matching the user-driven removal path.
    expect(next.pages['page-1'].widgetRows).toEqual([['w2']]);
    expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
  });

  it('removeWidget leaves intentional pre-existing single-widget-row spans untouched (only collapses the row it removed from)', () => {
    // Regression for the over-broad "sole-occupant collapse": removing a widget used
    // to sweep the col-span of *every* singleton row on *every* page, silently
    // snapping intentionally-narrowed lone widgets back to full width. The collapse
    // must only affect the specific row the widget was removed from.
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-2' },
      pages: {
        // Unrelated page: a lone widget intentionally narrowed to half-width
        // (e.g. via an AI `set_widget_width`). Must survive the removal on page-2.
        'page-1': {
          id: 'page-1',
          title: 'P1',
          widgetRows: [['a']],
          widgetColSpans: { a: 12 },
        },
        // Removal happens here. `b` is a pre-existing intentional singleton-row span
        // (unrelated to the removal); `c`/`d` share a row and `c` is removed.
        'page-2': {
          id: 'page-2',
          title: 'P2',
          widgetRows: [['b'], ['c', 'd']],
          widgetColSpans: { b: 10, c: 14, d: 10 },
        },
      },
      widgets: {
        a: chartWidget('a'),
        b: chartWidget('b'),
        c: chartWidget('c'),
        d: chartWidget('d'),
      },
    });
    const next = applyMutation(state, { type: 'removeWidget', args: { widgetId: 'c' } });

    // Unrelated page is completely untouched (same object reference, span intact).
    expect(next.pages['page-1']).toBe(state.pages['page-1']);
    expect(next.pages['page-1'].widgetColSpans).toEqual({ a: 12 });

    // On the removal page: `c`'s own span is dropped, and `d` (its former
    // row-mate, now alone) has its stale span cleared by the 2→1 collapse — but
    // `b`, a pre-existing singleton-row span in a *different* row, is left alone.
    expect(next.pages['page-2'].widgetRows).toEqual([['b'], ['d']]);
    expect(next.pages['page-2'].widgetColSpans).toEqual({ b: 10 });
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

  it('addFilter is idempotent: re-delivering the same filter id does not duplicate it', () => {
    const filter = {
      id: 'f',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const, pageId: 'page-1' },
    };
    const state = applyMutation(twoPageState('page-1'), { type: 'addFilter', args: { filter } });
    const next = applyMutation(state, { type: 'addFilter', args: { filter } });
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(1);
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

    it('skips an undefined-valued key in `changes` so it cannot void a required field', () => {
      const state = createDefaultStudioState({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'Keep me', config: { chartType: 'bar' } },
        },
      });
      const next = applyMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { title: undefined } },
      });
      // The required `title` is not voided to `undefined` by the shallow merge.
      expect(next.widgets.w1.title).toBe('Keep me');
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
    // Spans are in the 24-column unit system the canvas renders (GRID_COLS = 24,
    // MIN_SPAN = 6) — the SAME system the drag-resize path commits, so AI-resize
    // and drag-resize can no longer corrupt each other's layout.
    it('clamps a too-small requested span up to MIN_SPAN (6)', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 2, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 6 });
    });

    it('clamps a too-large requested span down to GRID_COLS (24)', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 30, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 24 });
    });

    it('guards a NaN span, clamping it to MIN_SPAN rather than storing NaN', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: NaN, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 6 });
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

    it('overflow with exactly one other widget: reduces its span to the remainder when >= MIN_SPAN', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1', 'w2']],
            widgetColSpans: { w2: 16 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 12, rowWidgetIds: ['w1', 'w2'] },
      });
      // clamped(w1) = 12, other total = 16, 12 + 16 = 28 > 24, one other widget
      // => remaining = 24 - 12 = 12, which is >= 6, so w2 is reduced (not deleted).
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12, w2: 12 });
    });

    it('overflow with exactly one other widget: deletes its span entirely when the remainder is < MIN_SPAN', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1', 'w2']],
            widgetColSpans: { w2: 10 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 20, rowWidgetIds: ['w1', 'w2'] },
      });
      // remaining = 24 - 20 = 4, which is < 6, so w2's span is dropped entirely.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 20 });
    });

    it('overflow with two or more other widgets: deletes all of their spans (not just reduces)', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1', 'w2', 'w3']],
            widgetColSpans: { w2: 10, w3: 10 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 16, rowWidgetIds: ['w1', 'w2', 'w3'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 16 });
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

    it("targets the explicit pageId, not the applying side's active page", () => {
      // Active page is page-2, but the mutation targets page-1.
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-2' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [['w2']] },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 12, rowWidgetIds: ['w1'], pageId: 'page-1' },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
      expect(next.pages['page-2'].widgetColSpans).toBeUndefined();
    });

    it('rebalances against the current row membership, not stale wire-supplied rowWidgetIds', () => {
      // Server snapshot grouped w1 and w2 in one row, so the mutation carries
      // rowWidgetIds: ['w1', 'w2']. But the user has since dragged w2 into its own
      // row, so w1 is now alone. Applying the mutation must rebalance against the
      // CURRENT grouping (w1 alone) and leave w2's span untouched — not shrink w2 as
      // the stale grouping would demand.
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w2: 16 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        // Stale: reflects the old shared-row grouping. clamped(w1) = 20, and with the
        // stale grouping w1 + w2 = 20 + 16 = 36 > 24 would reduce w2 to 24 - 20 = 4
        // (< MIN_SPAN → deleted). Against the current grouping (w1 alone) there is no
        // overflow, so w2 must keep its 16.
        args: { widgetId: 'w1', columns: 20, rowWidgetIds: ['w1', 'w2'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 20, w2: 16 });
    });

    it('still rebalances when the widget is not yet in any row, using rowWidgetIds as fallback', () => {
      // The widget hasn't been placed into widgetRows yet, so no current row can be
      // derived; the wire-supplied rowWidgetIds is the only membership signal and is
      // used as the documented fallback (mirrors the producer's `?? [widgetId]`).
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [],
            widgetColSpans: { w2: 16 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 20, rowWidgetIds: ['w1', 'w2'] },
      });
      // Fallback grouping applies: 20 + 16 = 36 > 24, one other widget, remainder
      // 24 - 20 = 4 < MIN_SPAN, so w2's span is dropped.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 20 });
    });
  });

  describe('addPage', () => {
    it('also sets the new page as dashboard.activePageId (deliberate — not an accident)', () => {
      const state = twoPageState('page-2');
      const next = applyMutation(state, { type: 'addPage', args: { id: 'page-3', title: 'New' } });
      expect(next.pages['page-3']).toMatchObject({ id: 'page-3', title: 'New' });
      expect(next.dashboard.activePageId).toBe('page-3');
    });

    it('is idempotent for an existing id: re-activates it without resetting its widgetRows', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-2' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
        },
      });
      const next = applyMutation(state, { type: 'addPage', args: { id: 'page-1', title: 'X' } });
      // The existing page keeps its widgets (not reset to []) and its title.
      expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
      expect(next.pages['page-1'].title).toBe('P1');
      expect(next.dashboard.activePageId).toBe('page-1');
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

    it("targets the explicit pageId, not the applying side's active page", () => {
      // Active page is page-2, but the mutation targets page-1.
      const state = twoPageState('page-2');
      const next = applyMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['a']], pageId: 'page-1' },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['a']]);
      expect(next.pages['page-2'].widgetRows).toEqual([]);
    });

    // Col-span invariant enforcement (the cleanup the drag-and-drop path and
    // removeWidget already do, previously skipped on the AI-driven layout path).

    it('clears a survivor span when a layout change collapses its row from two widgets to one', () => {
      // w1 and w2 shared a row with an explicit 16/8 split. The new layout drops each
      // into its own row; each becomes the sole occupant of a row it previously
      // shared, so both stale multi-widget-era spans are cleared (map empties out).
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1', 'w2']],
            widgetColSpans: { w1: 16, w2: 8 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1'], ['w2']] },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['w1'], ['w2']]);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    it('rebalances an overflowing merged row by clearing its spans (falls back to equal flex)', () => {
      // A layout change merges w1 (16) and w2 (16) into one row: 16 + 16 = 32 > 24.
      // With no explicit anchor, both spans are dropped so the row falls back to
      // equal distribution — matching setWidgetColSpan's multi-other-widget overflow
      // branch (which drops all sibling spans rather than inventing new clamping).
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w1: 16, w2: 16 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1', 'w2']] },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['w1', 'w2']]);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    it('leaves a valid merged row (spans sum <= GRID_COLS) untouched', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w1: 10, w2: 8 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1', 'w2']] },
      });
      // 10 + 8 = 18 <= 24, so the spans are preserved.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 10, w2: 8 });
    });

    it('preserves an intentional pre-existing single-widget span (no false collapse)', () => {
      // w1 was already a lone occupant with an intentional narrowed span; a layout
      // change that only reorders rows must not treat it as a 2->1 collapse.
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w1: 12 },
          },
        },
      });
      const next = applyMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w2'], ['w1']] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
    });

    it('drops a span for a widget no longer present in the new rows', () => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w1: 12, w2: 8 },
          },
        },
      });
      // The new layout no longer references w2, so its stale span here is pruned.
      const next = applyMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1']] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
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

    it("drops a genuinely-removed widget's filters and its stale col-span on other pages", () => {
      // w1 lives only on page-1 (active) and is dropped by this bulk update (absent
      // from the replacement map and from the new active-page rows). Its
      // widget-scoped filter and the stale col-span it left on page-2 (where it is
      // NOT in the rows) must be cleaned up the same way `removeWidget` would.
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
          'page-2': {
            id: 'page-2',
            title: 'P2',
            widgetRows: [['w2']],
            widgetColSpans: { w1: 8, w2: 6 }, // stale w1 span (w1 not in these rows)
          },
        },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
        filters: [
          {
            id: 'fw1',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind: 'widget', widgetId: 'w1' },
          },
          {
            id: 'fi1',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind: 'interactive', sourceWidgetId: 'w1', pageId: 'page-1' },
          },
          // A filter for the surviving w2 must be kept.
          {
            id: 'fw2',
            field: 'x',
            operator: 'equals',
            value: 2,
            scope: { kind: 'widget', widgetId: 'w2' },
          },
        ],
      });
      const next = applyMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          widgets: { w2: chartWidget('w2') },
          widgetRows: [['w2']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      // w1's filters are dropped; w2's is kept.
      expect(next.filters.map((f) => f.id)).toEqual(['fw2']);
      // w1's stale span on page-2 is pruned; w2's own span there survives.
      expect(next.pages['page-2'].widgetColSpans).toEqual({ w2: 6 });
    });

    it('does NOT remove a widget dropped from the map that still lives on another page (cross-page rejection)', () => {
      // old2 is dropped from the replacement widgets map but is still referenced in
      // page-2's rows — a dangling cross-page reference, not a removal. Its filter
      // and span must be preserved (not purged).
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
        filters: [
          {
            id: 'f2',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind: 'widget', widgetId: 'old2' },
          },
        ],
      });
      const next = applyMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          widgets: { new1: chartWidget('new1') },
          widgetRows: [['new1']],
          widgetColSpans: { new1: 6 },
          activePageId: 'page-1',
        },
      });
      // old2 is still on page-2, so its filter and span are untouched.
      expect(next.filters.map((f) => f.id)).toEqual(['f2']);
      expect(next.pages['page-2'].widgetColSpans).toEqual({ old2: 6 });
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

    it("renames the explicit threadId, not the applying side's active thread", () => {
      // Active thread is t1, but the mutation targets t2 — the thread the request
      // belonged to, even though the user has since switched to t1.
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
        args: { name: 'New2', updatedAt: '2024-06-01T00:00:00.000Z', threadId: 't2' },
      });
      expect(next.ai?.threads[0].name).toBe('Old1');
      expect(next.ai?.threads[1].name).toBe('New2');
      expect(next.ai?.threads[1].updatedAt).toBe('2024-06-01T00:00:00.000Z');
    });

    it('falls back to the active thread when threadId is omitted (legacy payloads)', () => {
      const state = createDefaultStudioState({
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old1', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      });
      const next = applyMutation(state, {
        type: 'renameAIThread',
        args: { name: 'New1', updatedAt: '2024-06-01T00:00:00.000Z' },
      });
      expect(next.ai?.threads[0].name).toBe('New1');
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

  // Untrusted ids ultimately trace back to LLM tool-call arguments / wire input.
  // A bare `record[id]` / `id in record` existence check matches prototype-chain
  // members (`'constructor'`, `'__proto__'`, `'hasOwnProperty'`), so such an id used
  // to pass the "exists?" guard and drive the handler against a phantom entry. Every
  // id-keyed lookup now goes through `Object.hasOwn`, so these are clean no-ops.
  describe('prototype-chain ids are clean unknown-id no-ops (not corrupted writes)', () => {
    const pollutingIds = ['constructor', '__proto__', 'hasOwnProperty'];

    it.each(pollutingIds)('updateWidget targeting %j on a widgetless state is a no-op', (id) => {
      const state = twoPageState();
      const next = applyMutation(state, {
        type: 'updateWidget',
        args: { widgetId: id, changes: { title: 'x' } },
      });
      expect(next).toBe(state);
    });

    it.each(pollutingIds)('removeWidget targeting %j on a widgetless state is a no-op', (id) => {
      const state = twoPageState();
      const next = applyMutation(state, { type: 'removeWidget', args: { widgetId: id } });
      expect(next).toBe(state);
      expect(next.widgets).toEqual({});
    });

    it.each(pollutingIds)('setWidgetColSpan targeting %j does not throw or pollute', (id) => {
      const state = createDefaultStudioState({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const next = applyMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: id, columns: 12, rowWidgetIds: [id] },
      });
      // No global prototype pollution leaked out of the reducer.
      expect(({} as Record<string, unknown>).leaked).toBeUndefined();
      // The resulting span map only ever carries the literal id as an own key —
      // never an inherited/corrupted value (and may be undefined for `__proto__`,
      // whose assignment is silently ignored). No key other than the literal id.
      const spans = next.pages['page-1'].widgetColSpans;
      expect(Object.keys(spans ?? {}).filter((k) => k !== id)).toEqual([]);
    });

    it.each(pollutingIds)(
      'setWidgetColSpan overflow math treats a prototype-name row-mate as span 0 (no NaN — rebalance still fires)',
      (id) => {
        // Row holds a real w2 (span 16) plus a prototype-name phantom row-mate. The
        // overflow sum must read the phantom as 0 — so the real total is 12 + 16 = 28
        // > 24 and the multi-other-widget rebalance drops the siblings' spans. With
        // the old `newSpans[id] ?? 0`, the phantom resolved to the `Object` prototype
        // member, poisoning the sum to NaN so `NaN > 24` was false and the overflow
        // was silently skipped (w2's span wrongly kept).
        const state = createDefaultStudioState({
          dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
          pages: {
            'page-1': {
              id: 'page-1',
              title: 'P1',
              widgetRows: [['w1', 'w2', id]],
              widgetColSpans: { w2: 16 },
            },
          },
        });
        const next = applyMutation(state, {
          type: 'setWidgetColSpan',
          args: { widgetId: 'w1', columns: 12, rowWidgetIds: ['w1', 'w2', id] },
        });
        // 12 + (16 + 0) = 28 > 24, two+ other widgets → all sibling spans dropped.
        expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
      },
    );

    it.each(pollutingIds)('setActivePage / renamePage targeting %j are no-ops', (id) => {
      const state = twoPageState();
      expect(applyMutation(state, { type: 'setActivePage', args: { pageId: id } })).toBe(state);
      expect(applyMutation(state, { type: 'renamePage', args: { pageId: id, title: 'X' } })).toBe(
        state,
      );
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
