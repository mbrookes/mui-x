import { describe, expect, it } from 'vitest';
import { createDefaultStudioState } from '@mui/x-studio-schema';
import { applyDocMutation, applyMutation, mutationLabel } from './applyMutation';
import { serializeDoc, deserializeState } from './statePersistence';
import type { StudioDoc, StudioState } from './stateTypes';
import type { StudioWidgetOf } from './widgetTypes';
import type { StateMutation } from './aiTypes';

// Annotated as the precise `StudioWidgetOf<'chart'>` (not the `StudioWidget`
// union) so the `kind: 'chart'` discriminant survives object spreads at call
// sites — a `{ ...chartWidget(id), config: { chartType: 'line' } }` fixture then
// still narrows to the chart member instead of collapsing to the whole union.
const chartWidget = (id: string, title = 'W'): StudioWidgetOf<'chart'> => ({
  id,
  kind: 'chart',
  title,
  config: { chartType: 'bar' },
});

// Doc-fixture helper: the reducer operates on a `StudioDoc`, so tests build docs
// (not full `StudioState`s) via the factory's `doc` override and pull `.doc`.
function makeDoc(overrides?: Partial<StudioDoc>): StudioDoc {
  const doc = createDefaultStudioState({ doc: overrides }).doc;
  // Auto-register any widget referenced in a page's `widgetRows` (or carrying a
  // `widgetColSpans` entry) that isn't already in the flat `widgets` map, so fixtures
  // that only specify layout still satisfy the reducer's "the widget must exist in
  // `state.widgets`" guards (the layout handlers no-op / drop rows for unknown ids,
  // mirroring a real doc where every laid-out widget is registered). Prototype-name
  // ids are intentionally left unregistered — a real doc never registers them, and the
  // reducer must treat them as unknown. Explicitly-provided widgets always win.
  const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
  const widgets = { ...doc.widgets } as Record<string, StudioWidgetOf<'chart'>>;
  let added = false;
  const register = (id: string) => {
    if (!unsafe.has(id) && !Object.hasOwn(widgets, id)) {
      widgets[id] = chartWidget(id);
      added = true;
    }
  };
  for (const page of Object.values(doc.pages)) {
    for (const row of page.widgetRows ?? []) {
      row.forEach(register);
    }
    for (const id of Object.keys(page.widgetColSpans ?? {})) {
      register(id);
    }
  }
  return added ? { ...doc, widgets: widgets as StudioDoc['widgets'] } : doc;
}

function twoPageState(activePageId = 'page-1'): StudioDoc {
  return makeDoc({
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
    applyDocMutation(state, { type: 'setDashboardTitle', args: { title: 'X' } });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('setDashboardTitle writing the identical title returns the SAME state reference (no undo step) (2.1)', () => {
    const state = makeDoc({ dashboard: { id: 'd1', title: 'Same', activePageId: 'page-1' } });
    const next = applyDocMutation(state, { type: 'setDashboardTitle', args: { title: 'Same' } });
    expect(next).toBe(state);
  });

  it('addWidget targets the explicit pageId, not the active page', () => {
    // Active page is page-2, but the mutation targets page-1.
    const state = twoPageState('page-2');
    const next = applyDocMutation(state, {
      type: 'addWidget',
      args: { widget: chartWidget('w1'), pageId: 'page-1' },
    });
    expect(next.pages['page-1'].widgetRows.flat()).toContain('w1');
    expect(next.pages['page-2'].widgetRows.flat()).not.toContain('w1');
  });

  it('addWidget falls back to the active page when pageId is omitted', () => {
    const state = twoPageState('page-2');
    const next = applyDocMutation(state, {
      type: 'addWidget',
      args: { widget: chartWidget('w1') },
    });
    expect(next.pages['page-2'].widgetRows.flat()).toContain('w1');
  });

  it('addWidget normalizes a live `seriesType`-carrying config to canonical `type` (3.2)', () => {
    const widget: StudioWidgetOf<'chart'> = {
      id: 'w1',
      kind: 'chart',
      title: 'W',
      config: { chartType: 'mixed', ySeries: [{ fieldId: 'revenue', seriesType: 'line' }] },
    };
    const next = applyDocMutation(twoPageState('page-1'), {
      type: 'addWidget',
      args: { widget, pageId: 'page-1' },
    });
    const series = (next.widgets.w1.config as { ySeries: Array<Record<string, unknown>> })
      .ySeries[0];
    expect(series.type).toBe('line');
    expect('seriesType' in series).toBe(false);
  });

  it('addWidget with a `null` ySeries entry does not throw (a parser-leaf config reaches the reducer) (1.1)', () => {
    // `parseStateMutation` leaves the widget-config interior as an unvalidated leaf, so
    // `{ ySeries: [null] }` passes the wire gate and reaches the reducer's series
    // normalization. Reading `.type` off `null` used to throw a TypeError mid-apply.
    const widget = {
      id: 'w1',
      kind: 'chart',
      title: 'W',
      config: { chartType: 'mixed', ySeries: [null] },
    } as unknown as StudioWidgetOf<'chart'>;
    let next!: StudioDoc;
    expect(() => {
      next = applyDocMutation(twoPageState('page-1'), {
        type: 'addWidget',
        args: { widget, pageId: 'page-1' },
      });
    }).not.toThrow();
    // The junk entry survives verbatim — normalization is total over it, not lossy.
    expect((next.widgets.w1.config as { ySeries: unknown[] }).ySeries).toEqual([null]);
  });

  it('addWidget with a `null` config does not throw (Tier 3)', () => {
    // A server-built `addWidget` bypassing `parseStateMutation` could carry a non-record
    // `config`; `normalizeConfigChartSeries(null)` used to throw on the `.ySeries` read.
    const widget = {
      id: 'w1',
      kind: 'chart',
      title: 'W',
      config: null,
    } as unknown as StudioWidgetOf<'chart'>;
    let next!: StudioDoc;
    expect(() => {
      next = applyDocMutation(twoPageState('page-1'), {
        type: 'addWidget',
        args: { widget, pageId: 'page-1' },
      });
    }).not.toThrow();
    expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
  });

  it('addWidget coerces a `null` config to `{}` so a LATER config mutation does not throw (T2-2)', () => {
    // The iteration-7 fix stopped the immediate add from throwing but stored the widget
    // with `config: null` verbatim — a landmine the NEXT config-touching mutation detonated
    // via `Object.keys(null)`/`shallowRecordEqual(null, …)`. Coercing to `{}` at the add
    // site (mirroring the load boundary, finding 2.4) closes that deferred throw.
    const widget = {
      id: 'w1',
      kind: 'chart',
      title: 'W',
      config: null,
    } as unknown as StudioWidgetOf<'chart'>;
    const added = applyDocMutation(twoPageState('page-1'), {
      type: 'addWidget',
      args: { widget, pageId: 'page-1' },
    });
    // The installed widget carries a real record, not `null`.
    expect(added.widgets.w1.config).toEqual({});
    // …and a subsequent config-touching update no longer throws on the null.
    let next!: StudioDoc;
    expect(() => {
      next = applyDocMutation(added, {
        type: 'updateWidget',
        args: { widgetId: 'w1', config: { chartType: 'line' } },
      });
    }).not.toThrow();
    expect((next.widgets.w1.config as { chartType?: string }).chartType).toBe('line');
  });

  it('addWidget with a prototype-hazard id is a no-op (Tier 3)', () => {
    // A `'__proto__'` id would create a real own entry that silently vanishes on the next
    // load (the load-boundary key screen drops it) — so reject it up front, uniform with
    // `applyBulkUpdate.addedWidgets`.
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'addWidget',
      args: { widget: chartWidget('__proto__'), pageId: 'page-1' },
    });
    expect(next).toBe(state);
    expect(Object.getPrototypeOf(next.widgets)).toBe(Object.prototype);
    expect(Object.hasOwn(next.widgets, '__proto__')).toBe(false);
  });

  // Iteration-20 finding: only `isSafePatchKey` was checked on `widget.id`, not
  // `typeof widget.id === 'string'` — `addPage` already guards its own id this way, but
  // `addWidget`/`applyBulkUpdate.addedWidgets` didn't, so a non-string id (e.g. a number)
  // passed the denylist check (it has no non-string members) and installed under a
  // STRINGIFIED record key while `widget.id` itself stayed non-string — a key/field desync.
  it('addWidget with a non-string id is a no-op (Tier 3)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'addWidget',
      args: { widget: { ...chartWidget('w1'), id: 42 }, pageId: 'page-1' } as never,
    });
    expect(next).toBe(state);
    expect(Object.hasOwn(next.widgets, '42')).toBe(false);
  });

  it('applyBulkUpdate.addedWidgets with a non-string id is skipped (Tier 3)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        addedWidgets: [{ ...chartWidget('w1'), id: 42 }],
        updatedWidgets: [],
        activePageId: 'page-1',
      } as never,
    });
    expect(Object.hasOwn(next.widgets, '42')).toBe(false);
    expect(next.widgets).toEqual(state.widgets);
  });

  it('addPage with a prototype-hazard id is a no-op (Tier 3)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'addPage',
      args: { id: '__proto__', title: 'Evil' },
    });
    expect(next).toBe(state);
    expect(Object.getPrototypeOf(next.pages)).toBe(Object.prototype);
    expect(Object.hasOwn(next.pages, '__proto__')).toBe(false);
  });

  it('addWidget is idempotent: re-delivering the same event does not add a duplicate row', () => {
    const mutation = {
      type: 'addWidget' as const,
      args: { widget: chartWidget('w1'), pageId: 'page-1' },
    };
    const state = applyDocMutation(twoPageState('page-1'), mutation);
    const next = applyDocMutation(state, mutation);
    // No duplicate row for the already-placed widget, and reference-stable no-op.
    expect(next).toBe(state);
    expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
    expect(next.pages['page-1'].widgetRows.flat().filter((id) => id === 'w1')).toHaveLength(1);
  });

  it('addWidget is idempotent by existence anywhere: re-delivery after a move/edit is a no-op', () => {
    // 1.7: a re-delivered addWidget must no-op if the widget exists ANYWHERE — even
    // after the user moved it to another page and edited it — never re-adding a row
    // or reverting the edit.
    const add = {
      type: 'addWidget' as const,
      args: { widget: chartWidget('w1'), pageId: 'page-1' },
    };
    let doc = applyDocMutation(twoPageState('page-1'), add);
    // Move w1 off page-1 and onto page-2, then retitle it.
    doc = applyDocMutation(doc, { type: 'setWidgetLayout', args: { rows: [], pageId: 'page-1' } });
    doc = applyDocMutation(doc, {
      type: 'setWidgetLayout',
      args: { rows: [['w1']], pageId: 'page-2' },
    });
    doc = applyDocMutation(doc, {
      type: 'updateWidget',
      args: { widgetId: 'w1', changes: { title: 'Edited' } },
    });
    const next = applyDocMutation(doc, add);
    expect(next).toBe(doc); // reference-stable no-op
    expect(next.widgets.w1.title).toBe('Edited'); // edit preserved
    expect(next.pages['page-1'].widgetRows).toEqual([]);
    expect(next.pages['page-2'].widgetRows).toEqual([['w1']]);
    const occurrences = [
      ...next.pages['page-1'].widgetRows.flat(),
      ...next.pages['page-2'].widgetRows.flat(),
    ].filter((id) => id === 'w1');
    expect(occurrences).toHaveLength(1); // appears exactly once
  });

  it('removePage cleans up widgets, page-scoped filters, and reassigns activePageId', () => {
    const state = makeDoc({
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
    const next = applyDocMutation(state, { type: 'removePage', args: { pageId: 'page-1' } });
    expect(next.pages['page-1']).toBeUndefined();
    expect(next.widgets.w1).toBeUndefined();
    expect(next.widgets.w2).toBeDefined();
    expect(next.filters.map((f) => f.id)).toEqual(['fp2']);
    expect(next.dashboard.activePageId).toBe('page-2');
  });

  it("removePage: removing the last remaining page results in activePageId === ''", () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
      },
    });
    const next = applyDocMutation(state, { type: 'removePage', args: { pageId: 'page-1' } });
    expect(next.pages['page-1']).toBeUndefined();
    expect(next.dashboard.activePageId).toBe('');
  });

  it("removePage also drops widget-scoped filters targeting the deleted page's widgets", () => {
    const state = makeDoc({
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
    const next = applyDocMutation(state, { type: 'removePage', args: { pageId: 'page-1' } });
    expect(next.filters.map((f) => f.id)).toEqual(['fw2']);
  });

  it('removePage keeps a widget (and its filters) still referenced on a surviving page (1.5)', () => {
    // w-shared lives on BOTH page-1 (removed) and page-2 (surviving); w-only lives on
    // page-1 alone. Removing page-1 must delete only w-only — w-shared and its
    // widget-scoped filter survive because a surviving page still references it.
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-2' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w-shared', 'w-only']] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [['w-shared']] },
      },
      widgets: { 'w-shared': chartWidget('w-shared'), 'w-only': chartWidget('w-only') },
      filters: [
        {
          id: 'f-shared',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'widget', widgetId: 'w-shared' },
        },
        {
          id: 'f-only',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'widget', widgetId: 'w-only' },
        },
      ],
    });
    const next = applyDocMutation(state, { type: 'removePage', args: { pageId: 'page-1' } });
    expect(next.widgets['w-shared']).toBeDefined();
    expect(next.widgets['w-only']).toBeUndefined();
    expect(next.filters.map((f) => f.id)).toEqual(['f-shared']);
  });

  it('removeWidget drops the widget from every page and its widget-scoped filters', () => {
    const state = makeDoc({
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
    const next = applyDocMutation(state, { type: 'removeWidget', args: { widgetId: 'w1' } });
    expect(next.widgets.w1).toBeUndefined();
    expect(next.pages['page-1'].widgetRows.flat()).not.toContain('w1');
    expect(next.filters).toHaveLength(0);
  });

  it('removeWidget also drops interactive-scope filters whose sourceWidgetId is the removed widget', () => {
    const state = makeDoc({
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
    const next = applyDocMutation(state, { type: 'removeWidget', args: { widgetId: 'w1' } });
    expect(next.filters).toHaveLength(0);
  });

  it('removeWidget also drops cross-filter-scope filters emitted by the removed widget', () => {
    const state = makeDoc({
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
    const next = applyDocMutation(state, { type: 'removeWidget', args: { widgetId: 'w1' } });
    // The cross-filter emitted by the removed source widget must not survive (its
    // clearing affordance is gone, so it would filter the page permanently).
    expect(next.filters).toHaveLength(0);
  });

  it("removeWidget cleans its own span and collapses a now-sole-occupant sibling's span", () => {
    const state = makeDoc({
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
    const next = applyDocMutation(state, { type: 'removeWidget', args: { widgetId: 'w1' } });
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
    const state = makeDoc({
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
    const next = applyDocMutation(state, { type: 'removeWidget', args: { widgetId: 'c' } });

    // Unrelated page is completely untouched (same object reference, span intact).
    expect(next.pages['page-1']).toBe(state.pages['page-1']);
    expect(next.pages['page-1'].widgetColSpans).toEqual({ a: 12 });

    // On the removal page: `c`'s own span is dropped, and `d` (its former
    // row-mate, now alone) has its stale span cleared by the 2→1 collapse — but
    // `b`, a pre-existing singleton-row span in a *different* row, is left alone.
    expect(next.pages['page-2'].widgetRows).toEqual([['b'], ['d']]);
    expect(next.pages['page-2'].widgetColSpans).toEqual({ b: 10 });
  });

  it("removeWidget prunes the removed widget's stale span entry on another page (3.2 unification)", () => {
    // w1 lives on page-1's rows but page-2 carries a stale w1 span (w1 is NOT in
    // page-2's rows). After the unification, removeWidget prunes that stale span on
    // every page — not only the holding page as the old per-page code did.
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
        'page-2': {
          id: 'page-2',
          title: 'P2',
          widgetRows: [['w2']],
          widgetColSpans: { w1: 8, w2: 6 },
        },
      },
      widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
    });
    const next = applyDocMutation(state, { type: 'removeWidget', args: { widgetId: 'w1' } });
    expect(next.pages['page-2'].widgetColSpans).toEqual({ w2: 6 });
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
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter } });
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
    const state = applyDocMutation(twoPageState('page-1'), { type: 'addFilter', args: { filter } });
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter } });
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(1);
  });

  it('addFilter drops an orphan cross-filter whose sourceWidgetId names no existing widget (2.1)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    });
    const orphan = {
      id: 'f-orphan',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'cross-filter' as const, sourceWidgetId: 'ghost', pageId: 'page-1' },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter: orphan } });
    // No-op-return the input reference (the reducer's unresolvable-target convention).
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(0);
  });

  it('addFilter drops an orphan interactive filter whose sourceWidgetId names no existing widget (2.1)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    });
    const orphan = {
      id: 'f-orphan',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'interactive' as const, sourceWidgetId: 'ghost', pageId: 'page-1' },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter: orphan } });
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(0);
  });

  it('addFilter installs a cross-filter whose sourceWidgetId names an existing widget (2.1)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    });
    const valid = {
      id: 'f-valid',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'cross-filter' as const, sourceWidgetId: 'w1', pageId: 'page-1' },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter: valid } });
    expect(next.filters).toHaveLength(1);
    expect(next.filters[0].id).toBe('f-valid');
  });

  // T3-2: a `widget`-scoped filter naming a widget that does not exist is an orphan the reducer
  // can never clean up (`dropWidgetScopedFilters` fires only on widget REMOVAL) — reject it,
  // extending the same guard the cross-filter/interactive orphan check already applies.
  it('addFilter drops an orphan widget-scoped filter whose widgetId names no existing widget (T3-2)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    });
    const orphan = {
      id: 'f-orphan',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'widget' as const, widgetId: 'ghost' },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter: orphan } });
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(0);
  });

  it('addFilter installs a widget-scoped filter whose widgetId names an existing widget (T3-2)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
    });
    const valid = {
      id: 'f-valid',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'widget' as const, widgetId: 'w1' },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter: valid } });
    expect(next.filters).toHaveLength(1);
    expect(next.filters[0].id).toBe('f-valid');
  });

  // Iteration-20 finding: the reducer never enforced "at most one rank-type filter per
  // page" — `StudioController` enforced it at five call sites before invoking the
  // reducer, but the reducer (the single source of truth for mutation semantics) let a
  // caller that skipped that check install a second rank filter on the same page.
  describe('addFilter rank-filter uniqueness', () => {
    it('rejects a second page-scoped rank filter on the same page', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        filters: [
          {
            id: 'rank-1',
            field: 'category',
            operator: 'equals',
            value: null,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      });
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'rank-2',
            field: 'region',
            operator: 'equals',
            value: null,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        },
      });
      expect(next).toBe(state);
      expect(next.filters.map((f) => f.id)).toEqual(['rank-1']);
    });

    it('allows a second rank filter on a DIFFERENT page (rank uniqueness is per-page)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
        },
        filters: [
          {
            id: 'rank-1',
            field: 'category',
            operator: 'equals',
            value: null,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      });
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'rank-2',
            field: 'region',
            operator: 'equals',
            value: null,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-2' },
          },
        },
      });
      expect(next.filters.map((f) => f.id)).toEqual(['rank-1', 'rank-2']);
    });

    it('allows a non-rank filter on a page that already has a rank filter', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        filters: [
          {
            id: 'rank-1',
            field: 'category',
            operator: 'equals',
            value: null,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      });
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'cond-1',
            field: 'region',
            operator: 'equals',
            value: 'US',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        },
      });
      expect(next.filters.map((f) => f.id)).toEqual(['rank-1', 'cond-1']);
    });
  });

  // T2-2: the `addWidget` ADD channel strips unsafe own config keys (via `coerceWidgetConfig`),
  // so a server-built widget whose config carries an own `__proto__` key survives the next load
  // instead of being dropped wholesale by `deserializeState`'s config own-key screen.
  it('addWidget strips an unsafe own key from config; widget survives reload (T2-2)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
    });
    const config = JSON.parse('{"__proto__":{"polluted":true},"foo":"baz"}');
    const widget = { id: 'w1', kind: 'acme-x', title: 'W', config };
    const next = applyDocMutation(state, {
      type: 'addWidget',
      args: { widget, pageId: 'page-1' } as never,
    });
    expect(Object.hasOwn(next.widgets.w1.config, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((next.widgets.w1.config as { foo: string }).foo).toBe('baz');
    const reloaded = deserializeState(serializeDoc(next), {});
    expect(reloaded.doc.widgets.w1).toBeDefined();
    expect((reloaded.doc.widgets.w1.config as { foo: string }).foo).toBe('baz');
  });

  it('removeFilter: unknown filterId is a no-op', () => {
    const state = twoPageState();
    const next = applyDocMutation(state, { type: 'removeFilter', args: { filterId: 'nope' } });
    expect(next).toBe(state);
  });

  describe('updateWidget', () => {
    it('an explicit undefined value in the config patch deletes that key', () => {
      const state = makeDoc({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar', xGroupBy: 'month' },
          },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', config: { xGroupBy: undefined } },
      });
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar' });
      expect('xGroupBy' in next.widgets.w1.config).toBe(false);
    });

    it('drops an `id` key in `changes` even from a raw (parser-bypassing) mutation (1.2)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      });
      // A server-built mutation bypassing `parseStateMutation` must not be able to
      // desync `widget.id` from its `state.widgets` map key.
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { id: 'w2', title: 'Renamed' } as never },
      });
      // The map key still holds w1, whose `.id` is unchanged; the title change applied.
      expect(next.widgets.w1.id).toBe('w1');
      expect(next.widgets.w1.title).toBe('Renamed');
      expect(next.widgets.w2).toBeUndefined();
    });

    it('normalizes a live `seriesType`-carrying config to canonical `type` immediately (3.2)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'mixed' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: {
          widgetId: 'w1',
          config: { ySeries: [{ fieldId: 'revenue', seriesType: 'line' }] },
        },
      });
      const series = (next.widgets.w1.config as { ySeries: Array<Record<string, unknown>> })
        .ySeries[0];
      expect(series.type).toBe('line');
      expect('seriesType' in series).toBe(false);
    });

    it('normalizes `seriesType` inside a wholesale `changes.config` replacement (2.3)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'mixed' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: {
          widgetId: 'w1',
          changes: {
            config: { chartType: 'mixed', ySeries: [{ fieldId: 'revenue', seriesType: 'line' }] },
          } as never,
        },
      });
      const series = (next.widgets.w1.config as { ySeries: Array<Record<string, unknown>> })
        .ySeries[0];
      expect(series.type).toBe('line');
      expect('seriesType' in series).toBe(false);
    });

    it('a config patch carrying a `null` ySeries entry does not throw (1.1)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'mixed' } },
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', config: { ySeries: [null] } as never },
        });
      }).not.toThrow();
      expect((next.widgets.w1.config as { ySeries: unknown[] }).ySeries).toEqual([null]);
    });

    it('an identical-value config patch returns the SAME state reference (no undo step) (3.5)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar', xField: 'a' } },
        },
      });
      // Re-setting every key to its current value changes nothing.
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', config: { chartType: 'bar', xField: 'a' } },
      });
      expect(next).toBe(state);
    });

    it('an all-stripped-to-{} config patch returns the SAME state reference (no undo step) (3.5)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', config: {} },
      });
      expect(next).toBe(state);
    });

    it('skips an undefined-valued key in `changes` so it cannot void a required field', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'Keep me', config: { chartType: 'bar' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { title: undefined } },
      });
      // The required `title` is not voided to `undefined` by the shallow merge.
      expect(next.widgets.w1.title).toBe('Keep me');
    });

    it('changes.config wholesale-replaces the config-patch result rather than merging with it', () => {
      const state = makeDoc({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar', xGroupBy: 'month' },
          },
        },
      });
      const next = applyDocMutation(state, {
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

    // Architecture review T3.3: `changes.config` is typed non-nullable and
    // `parseStateMutation` rejects a non-object `changes.config` at the wire
    // boundary, so `null` can only reach the reducer via a server-built mutation
    // that bypasses the parser (or defeats its own types, hence the `as never`
    // cast here). Before the fix, the `else if (value !== updated.config)` branch
    // would assign `config = null` outright, corrupting the widget. The reducer
    // must instead ignore the invalid value and leave the config-patch result (or
    // existing config) untouched — matching this file's other defense-in-depth
    // guards for exactly this "server bypasses the parser" case.
    it('changes.config: null does not corrupt the widget config (T3.3)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar', xField: 'a' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { config: null } as never },
      });
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'a' });
    });

    it('changes.config: null does not override a preceding config-patch (T3.3)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar', xField: 'a' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: {
          widgetId: 'w1',
          config: { xField: 'b' },
          changes: { config: null } as never,
        },
      });
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'b' });
    });

    // T2-2: an array is truthy and `typeof [] === 'object'`, so the old
    // `value && typeof value === 'object'` guard let it through and installed it AS the
    // widget's `config` verbatim (`widget.config` became an array — a silent live-vs-reload
    // divergence, since `deserializeState` would coerce it to `{}` on the next load but the
    // live in-memory state wouldn't match). An array must be ignored exactly like `null`.
    it('changes.config: an array does not corrupt the widget config (T2-2)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar', xField: 'a' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { config: ['rogue', 'array'] } as never },
      });
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'a' });
    });

    // Finishing the T3.3 defense-in-depth pair: the top-level `updateWidget.args.config`
    // branch admitted `null` (a server-built mutation bypassing the parser), then threw
    // inside `normalizeConfigChartSeries`/`Object.entries(null)`. A non-record `config` is
    // now treated as ABSENT (a clean no-op), mirroring the `changes.config: null` twin.
    it('top-level config: null is a no-op, not a throw (Tier 3)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar', xField: 'a' } },
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', config: null as never },
        });
      }).not.toThrow();
      // Unchanged config, and a reference-equality no-op (no spurious undo step).
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'a' });
      expect(next).toBe(state);
    });

    // T2-2: the old guard (`config !== null && typeof config === 'object'`) let an array
    // through, and `Object.entries([...])` merged its index keys ("0", "1", …) into the
    // widget's live config. An array must be treated as ABSENT, same as `null`.
    it('top-level config: an array is a no-op, not a merge of index keys (T2-2)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar', xField: 'a' } },
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', config: ['rogue', 'array'] as never },
        });
      }).not.toThrow();
      // Unchanged config (no `"0"`/`"1"` keys merged in), and a reference-equality no-op.
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'a' });
      expect(next).toBe(state);
    });

    it('a value-identical `changes` scalar returns the SAME state reference (no undo step) (1.1)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'Same', config: { chartType: 'bar' } },
        },
      });
      // Re-setting `title` to its current value must not rewrap the widget — otherwise
      // `commitDocPatch`'s reference-equality no-op guard pushes a spurious undo entry
      // (a realistic producer: an LLM re-issuing `update_widget` with the current title).
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { title: 'Same' } },
      });
      expect(next).toBe(state);
    });

    it('a value-identical wholesale `changes.config` returns the SAME state reference (1.1)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar', xField: 'a' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: {
          widgetId: 'w1',
          changes: { config: { chartType: 'bar', xField: 'a' } } as never,
        },
      });
      expect(next).toBe(state);
    });

    it('a `changes` mixing a same-valued and a changed scalar rewraps and applies only the real change (1.1)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'Same', config: { chartType: 'bar' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { title: 'Same', subtitle: 'New' } },
      });
      expect(next).not.toBe(state);
      expect(next.widgets.w1.title).toBe('Same');
      expect(next.widgets.w1.subtitle).toBe('New');
    });

    it('unknown widgetId is a no-op', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'nope', changes: { title: 'x' } },
      });
      expect(next).toBe(state);
    });

    it('unsetFields deletes the named top-level widget keys (wire-safe void)', () => {
      const state = makeDoc({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'grid',
            title: 'Table',
            sourceId: 'orders',
            subtitle: 'A subtitle',
            config: { columns: [] },
          },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', unsetFields: ['sourceId', 'subtitle'] },
      });
      expect('sourceId' in next.widgets.w1).toBe(false);
      expect('subtitle' in next.widgets.w1).toBe(false);
      // Untouched fields survive.
      expect(next.widgets.w1.title).toBe('Table');
      expect(next.widgets.w1.config).toEqual({ columns: [] });
    });

    // Iteration-20 finding: `changes.kind` could flip a widget's kind (e.g. chart ->
    // grid) with zero coherence check against the surviving config, leaving a widget
    // whose `kind`/`config` shapes don't match. The reducer now reconciles the config
    // to the NEW kind's allowed keys (via `getAllowedConfigKeys`) whenever `kind` changes.
    it('changing kind from chart to grid strips leftover chart-only config keys (kind/config coherence)', () => {
      const state = makeDoc({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar', xField: 'month', yField: 'revenue', titleFontSize: 14 },
          },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { kind: 'grid' } },
      });
      expect(next.widgets.w1.kind).toBe('grid');
      // Chart-only keys (chartType/xField/yField) are gone…
      expect(next.widgets.w1.config).not.toHaveProperty('chartType');
      expect(next.widgets.w1.config).not.toHaveProperty('xField');
      expect(next.widgets.w1.config).not.toHaveProperty('yField');
      // …but a SHARED key (valid on every kind) survives.
      expect(next.widgets.w1.config).toEqual({ titleFontSize: 14 });
    });

    it('changing kind to a custom (non-built-in) kind leaves the config untouched (no restriction)', () => {
      const state = makeDoc({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar', xField: 'month' },
          },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { kind: 'my-custom-widget' } },
      });
      expect(next.widgets.w1.kind).toBe('my-custom-widget');
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'month' });
    });

    it('a `changes` that does not touch kind leaves the config untouched (no spurious reconciliation)', () => {
      const state = makeDoc({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar', xField: 'month' },
          },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { title: 'Renamed' } },
      });
      expect(next.widgets.w1.kind).toBe('chart');
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'month' });
    });

    it('unsetConfigKeys deletes the named keys from the merged config', () => {
      const state = makeDoc({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar', xField: 'month', yField: 'revenue' },
          },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', unsetConfigKeys: ['xField', 'yField'] },
      });
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar' });
    });

    it('an unset always wins over a same-mutation set of the same key (unsets run last)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'T', sourceId: 'old', config: { xField: 'a' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: {
          widgetId: 'w1',
          // Set sourceId + xField in the same turn...
          changes: { sourceId: 'new' },
          config: { xField: 'b' },
          // ...but explicitly unset them: the unset must win.
          unsetFields: ['sourceId'],
          unsetConfigKeys: ['xField'],
        },
      });
      expect('sourceId' in next.widgets.w1).toBe(false);
      expect('xField' in next.widgets.w1.config).toBe(false);
    });

    it('unsetFields ignores id and config (never strands the widget or its config bag)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        // Cast: `id`/`config` are outside the compile-time type, but an untrusted
        // wire payload can carry them, so the runtime guard must hold.
        args: { widgetId: 'w1', unsetFields: ['id', 'config'] as never },
      });
      expect(next.widgets.w1.id).toBe('w1');
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar' });
    });

    it('unsetFields never voids the required title/kind, but does unset an optional field (1.1)', () => {
      const state = makeDoc({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            subtitle: 'Sub',
            config: { chartType: 'bar' },
          },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        // Wire-shaped payload: an untrusted caller can list required fields; the runtime
        // denylist must keep `title`/`kind` while unsetting the optional `subtitle`.
        args: { widgetId: 'w1', unsetFields: ['title', 'kind', 'subtitle'] },
      } as unknown as StateMutation);
      expect(next.widgets.w1.title).toBe('W');
      expect(next.widgets.w1.kind).toBe('chart');
      expect('subtitle' in next.widgets.w1).toBe(false);
    });

    it('a config patch with an own __proto__ key does not pollute Object.prototype (1.2)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      });
      // JSON.parse makes `__proto__` a real OWN key (an object literal would set the
      // prototype instead). The reducer must skip it, not write through the setter.
      const config = JSON.parse('{"__proto__":{"polluted":true},"chartType":"line"}');
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', config },
      });
      expect(Object.getPrototypeOf(next.widgets.w1.config)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      // The safe key still applied.
      expect((next.widgets.w1.config as { chartType: string }).chartType).toBe('line');
    });

    // T2-3: the `changes.config` WHOLESALE replace channel now strips unsafe own config
    // keys (the config-PATCH loop already did, per-key). Without the strip, the unsafe
    // key survived as an own config property and `deserializeState`'s `hasUnsafeOwnKeys`
    // screen would drop the ENTIRE widget on the next load — silent data loss. Reachable
    // via a CUSTOM widget kind, whose per-kind key validation imposes no restriction.
    it('strips an unsafe own key from a wholesale changes.config; widget survives reload (T2-3)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'acme-x', title: 'W', config: { foo: 'bar' } },
        } as unknown as StudioDoc['widgets'],
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      });
      const config = JSON.parse('{"__proto__":{"polluted":true},"foo":"baz"}');
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { config } as never },
      });
      // The unsafe key is stripped; the safe key applied; the prototype is untouched.
      expect(Object.hasOwn(next.widgets.w1.config, '__proto__')).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((next.widgets.w1.config as { foo: string }).foo).toBe('baz');
      // The widget round-trips through persistence WITHOUT being dropped on load.
      const reloaded = deserializeState(serializeDoc(next), {});
      expect(reloaded.doc.widgets.w1).toBeDefined();
      expect((reloaded.doc.widgets.w1.config as { foo: string }).foo).toBe('baz');
    });

    it('unsetting an absent key is a harmless no-change', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', unsetFields: ['sourceId'], unsetConfigKeys: ['xField'] },
      });
      expect(next.widgets.w1).toEqual(state.widgets.w1);
    });
  });

  describe('setWidgetColSpan', () => {
    // Spans are in the 24-column unit system the canvas renders (GRID_COLS = 24,
    // MIN_SPAN = 6) — the SAME system the drag-resize path commits, so AI-resize
    // and drag-resize can no longer corrupt each other's layout.
    it('clamps a too-small requested span up to MIN_SPAN (6)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 2, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 6 });
    });

    it('clamps a too-large requested span down to GRID_COLS (24)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 30, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 24 });
    });

    it('guards a NaN span, clamping it to MIN_SPAN rather than storing NaN', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: NaN, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 6 });
    });

    it('rounds a non-integer span', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 7.6, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 8 });
    });

    it("columns: null deletes that widget's span entry, collapsing the map to undefined when empty", () => {
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: null, rowWidgetIds: ['w1'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    it('overflow with exactly one other widget: reduces its span to the remainder when >= MIN_SPAN', () => {
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 12, rowWidgetIds: ['w1', 'w2'] },
      });
      // clamped(w1) = 12, other total = 16, 12 + 16 = 28 > 24, one other widget
      // => remaining = 24 - 12 = 12, which is >= 6, so w2 is reduced (not deleted).
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12, w2: 12 });
    });

    it('overflow with exactly one other widget: deletes its span entirely when the remainder is < MIN_SPAN', () => {
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 20, rowWidgetIds: ['w1', 'w2'] },
      });
      // remaining = 24 - 20 = 4, which is < 6, so w2's span is dropped entirely.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 20 });
    });

    it('overflow with two or more other widgets: deletes all of their spans (not just reduces)', () => {
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 16, rowWidgetIds: ['w1', 'w2', 'w3'] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 16 });
    });

    it('missing active page is a no-op', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'ghost-page' },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 6, rowWidgetIds: ['w1'] },
      });
      expect(next).toBe(state);
    });

    it("targets the explicit pageId, not the applying side's active page", () => {
      // Active page is page-2, but the mutation targets page-1.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-2' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [['w2']] },
        },
      });
      const next = applyDocMutation(state, {
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
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
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
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [],
            widgetColSpans: { w2: 16 },
          },
        },
        // w1 exists in the flat map but has not been placed into a row yet.
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 20, rowWidgetIds: ['w1', 'w2'] },
      });
      // Fallback grouping applies: 20 + 16 = 36 > 24, one other widget, remainder
      // 24 - 20 = 4 < MIN_SPAN, so w2's span is dropped.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 20 });
    });

    it('a span write for a widget id absent from state.widgets is a no-op (no orphan span) (2.2)', () => {
      // The widget id exists nowhere in the flat map, so a span write must not persist
      // an orphan `widgetColSpans` entry (dead weight that serializes) — mirrors the
      // unknown-id guard `updateWidget`/`removeWidget` already have.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'ghost-widget', columns: 10, rowWidgetIds: ['ghost-widget'] },
      });
      expect(next).toBe(state);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    it('re-writing the identical span returns the SAME state reference (no undo step) (2.1)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1']],
            widgetColSpans: { w1: 12 },
          },
        },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 12, rowWidgetIds: ['w1'] },
      });
      expect(next).toBe(state);
    });

    it('clearing the span of a widget that has none returns the SAME state reference (2.1)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: null, rowWidgetIds: ['w1'] },
      });
      expect(next).toBe(state);
    });

    it('does not rebalance a span onto a phantom row-mate on the fallback path (2.1)', () => {
      // w1 exists but sits in NO row, so the handler falls back to the wire-supplied
      // `rowWidgetIds` grouping. `ghost` carries a pre-existing span (forcing the
      // single-other-widget overflow rebalance) but is NOT a real widget — makeDoc
      // auto-registers any id appearing in `widgetColSpans`, so strip it back out.
      const base = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [],
            widgetColSpans: { ghost: 15 },
          },
        },
        widgets: { w1: chartWidget('w1') },
      });
      const state: StudioDoc = { ...base, widgets: { w1: base.widgets.w1 } };
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 12, rowWidgetIds: ['w1', 'ghost'], pageId: 'page-1' },
      });
      // clamped(12) + ghost(15) = 27 > 24 with a single other id and remaining(12) >=
      // MIN_SPAN, so the OLD code rebalanced the phantom `ghost` to 12. The
      // `Object.hasOwn(state.widgets, …) && isSafePatchKey(…)` guard skips writing a span
      // for a non-widget id, so ghost's span is never rewritten to the rebalanced value.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ ghost: 15, w1: 12 });
    });

    it('no-ops a span write when the widget lives on ANOTHER page than the target (no orphan span) (review 2.3)', () => {
      // w1 exists and is placed on page-2's rows, but the mutation targets page-1 (an
      // explicit pageId racing a concurrent move, or a legacy payload applied while the
      // user is on another page). currentRow is undefined on page-1, so the OLD code
      // used the wire-supplied rowWidgetIds fallback and wrote w1's span into page-1's
      // map — a dead entry that serializes. It must instead be a no-op.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [['w1']] },
        },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 12, rowWidgetIds: ['w1'], pageId: 'page-1' },
      });
      expect(next).toBe(state);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
      expect(next.pages['page-2'].widgetColSpans).toBeUndefined();
    });

    it('sets the span of a not-yet-placed widget when rowWidgetIds is omitted (parser-bypass, finding 2.5)', () => {
      // w1 exists in `state.widgets` but sits on NO page (the documented not-yet-placed
      // case), and a parser-bypassing partial payload (an `executeToolOnState`-style
      // mutation built by hand) omits `rowWidgetIds`. The OLD code left `rowWidgetIds`
      // undefined and threw a `TypeError` at `.filter(...)`; the handler must instead
      // treat the widget as the sole occupant of its row (mirroring the producer's own
      // `?? [widgetId]` default) and apply gracefully, like every sibling handler.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        widgets: { w1: chartWidget('w1') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'setWidgetColSpan',
          args: { widgetId: 'w1', columns: 12 },
        } as StateMutation);
      }).not.toThrow();
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
    });
  });

  describe('addPage', () => {
    it('also sets the new page as dashboard.activePageId (deliberate — not an accident)', () => {
      const state = twoPageState('page-2');
      const next = applyDocMutation(state, {
        type: 'addPage',
        args: { id: 'page-3', title: 'New' },
      });
      expect(next.pages['page-3']).toMatchObject({ id: 'page-3', title: 'New' });
      expect(next.dashboard.activePageId).toBe('page-3');
    });

    it('is idempotent for an existing id: re-activates it without resetting its widgetRows', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-2' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
        },
      });
      const next = applyDocMutation(state, { type: 'addPage', args: { id: 'page-1', title: 'X' } });
      // The existing page keeps its widgets (not reset to []) and its title.
      expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
      expect(next.pages['page-1'].title).toBe('P1');
      expect(next.dashboard.activePageId).toBe('page-1');
    });
  });

  describe('setWidgetLayout', () => {
    it('replaces the active page rows only', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
        },
        // The laid-out widgets must exist in the flat map (a real doc registers them).
        widgets: { a: chartWidget('a'), b: chartWidget('b'), c: chartWidget('c') },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['a', 'b'], ['c']] },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['a', 'b'], ['c']]);
      expect(next.pages['page-2'].widgetRows).toEqual([]);
    });

    it("targets the explicit pageId, not the applying side's active page", () => {
      // Active page is page-2, but the mutation targets page-1.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-2' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
        },
        widgets: { a: chartWidget('a') },
      });
      const next = applyDocMutation(state, {
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
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
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
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1', 'w2']] },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['w1', 'w2']]);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    it('leaves a valid merged row (spans sum <= GRID_COLS) untouched', () => {
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1', 'w2']] },
      });
      // 10 + 8 = 18 <= 24, so the spans are preserved.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 10, w2: 8 });
    });

    it('preserves an intentional pre-existing single-widget span (no false collapse)', () => {
      // w1 was already a lone occupant with an intentional narrowed span; a layout
      // change that only reorders rows must not treat it as a 2->1 collapse.
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w2'], ['w1']] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
    });

    it('drops a span for a widget no longer present in the new rows', () => {
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1']] },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
    });

    it('drops rows naming a widget absent from state.widgets (phantom-widget guard) (2.2)', () => {
      // `w1` is real; `ghost` exists nowhere in the flat map. The layout must install
      // only the real widget's row and drop the phantom entry (and the row it emptied),
      // never leave the page rendering a widget that does not exist.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1', 'ghost'], ['ghost']] },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
    });

    it('deduplicates a widget id repeated within a single row (first occurrence wins) (review 2.1)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1'], ['w2']] } },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1', 'w1', 'w2']] },
      });
      // The repeated `w1` is collapsed to a single occurrence — the page must never
      // render the same widget twice (a duplicate React key in StudioCanvas).
      expect(next.pages['page-1'].widgetRows).toEqual([['w1', 'w2']]);
    });

    it('deduplicates a widget id repeated across rows (first occurrence wins) (review 2.1)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1'], ['w2']] } },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1'], ['w2', 'w1']] },
      });
      // The second `w1` is dropped; the row it would have shared keeps only `w2`.
      expect(next.pages['page-1'].widgetRows).toEqual([['w1'], ['w2']]);
    });

    it('a within-row duplicate no longer double-counts a span into a false overflow (review 2.1)', () => {
      // Without de-duplication, `[['w1','w1']]` with `w1: 13` sums to 26 > GRID_COLS in
      // enforceLayoutColSpans's overflow check and DELETES a valid span. Deduping to
      // `[['w1']]` first leaves w1 a lone occupant, so its intentional span survives.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1']],
            widgetColSpans: { w1: 13 },
          },
        },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1', 'w1']] },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 13 });
    });

    it('an identical layout returns the SAME state reference (no undo step) (2.1)', () => {
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1'], ['w2']] },
      });
      expect(next).toBe(state);
    });
  });

  describe('renamePage', () => {
    it('renames the page', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'renamePage',
        args: { pageId: 'page-1', title: 'Renamed' },
      });
      expect(next.pages['page-1'].title).toBe('Renamed');
    });

    it('unknown pageId is a no-op', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'renamePage',
        args: { pageId: 'nope', title: 'X' },
      });
      expect(next).toBe(state);
    });

    it('renaming to the identical title returns the SAME state reference (no undo step) (2.1)', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'renamePage',
        args: { pageId: 'page-1', title: 'P1' },
      });
      expect(next).toBe(state);
    });
  });

  describe('setActivePage', () => {
    it('switches the active page', () => {
      const state = twoPageState('page-1');
      const next = applyDocMutation(state, { type: 'setActivePage', args: { pageId: 'page-2' } });
      expect(next.dashboard.activePageId).toBe('page-2');
    });

    it('unknown pageId is a no-op', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, { type: 'setActivePage', args: { pageId: 'nope' } });
      expect(next).toBe(state);
    });

    it('activating the already-active page returns the SAME state reference (no undo step) (2.1)', () => {
      const state = twoPageState('page-1');
      const next = applyDocMutation(state, { type: 'setActivePage', args: { pageId: 'page-1' } });
      expect(next).toBe(state);
    });
  });

  describe('applyBulkUpdate', () => {
    it('applies add/remove/update deltas and only touches widgetRows/widgetColSpans on activePageId', () => {
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['old1'],
          addedWidgets: [chartWidget('new1')],
          updatedWidgets: [],
          widgetRows: [['new1']],
          widgetColSpans: { new1: 6 },
          activePageId: 'page-1',
        },
      });
      // old1 removed, new1 added; old2 (another page) preserved — not a wholesale replace.
      expect(next.widgets.old1).toBeUndefined();
      expect(next.widgets.new1).toEqual(chartWidget('new1'));
      expect(next.widgets.old2).toEqual(chartWidget('old2'));
      expect(next.pages['page-1'].widgetRows).toEqual([['new1']]);
      expect(next.pages['page-1'].widgetColSpans).toEqual({ new1: 6 });
      // page-2, not the active page, is untouched.
      expect(next.pages['page-2'].widgetRows).toEqual([['old2']]);
      expect(next.pages['page-2'].widgetColSpans).toEqual({ old2: 6 });
    });

    // 1.8: producer-supplied active-page spans are normalized (clamped + invariant-
    // enforced) rather than stored verbatim.
    it('clamps producer-supplied active-page spans into the valid range', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [chartWidget('a'), chartWidget('b')],
          updatedWidgets: [],
          widgetRows: [['a'], ['b']],
          widgetColSpans: { a: 2, b: 99 }, // below MIN_SPAN, above GRID_COLS
          activePageId: 'page-1',
        },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ a: 6, b: 24 });
    });

    it('drops both spans of an overflowing two-widget row', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [chartWidget('a'), chartWidget('b')],
          updatedWidgets: [],
          widgetRows: [['a', 'b']],
          widgetColSpans: { a: 20, b: 20 }, // 20 + 20 = 40 > 24
          activePageId: 'page-1',
        },
      });
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    it('drops a producer span for an id absent from widgetRows', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [chartWidget('a')],
          updatedWidgets: [],
          widgetRows: [['a']],
          widgetColSpans: { a: 8, ghost: 8 }, // ghost not in rows
          activePageId: 'page-1',
        },
      });
      expect(next.pages['page-1'].widgetColSpans).toEqual({ a: 8 });
    });

    it('stores an empty widgetColSpans as undefined (not {})', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [chartWidget('a')],
          updatedWidgets: [],
          widgetRows: [['a']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    it('does NOT revert a widget concurrently edited between snapshot and apply (lost-update fix)', () => {
      // Two widgets exist on the active page; a third (w3) was concurrently edited
      // on another page AFTER the producer built its delta but BEFORE this mutation
      // applies. The bulk update names only w1/w2/w4, so the reducer must apply its
      // deltas on top of the CURRENT `state.widgets` and leave the concurrently
      // edited w3 exactly as the user left it.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1'], ['w2']] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [['w3']] },
        },
        widgets: {
          w1: chartWidget('w1', 'W1'),
          w2: chartWidget('w2', 'W2'),
          // The user's concurrent edit is already reflected in current state.
          w3: { ...chartWidget('w3', 'User Renamed'), config: { chartType: 'line' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['w2'],
          addedWidgets: [chartWidget('w4', 'W4')],
          updatedWidgets: [{ widgetId: 'w1', title: 'W1 renamed by AI' }],
          widgetRows: [['w1'], ['w4']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(next.widgets.w1.title).toBe('W1 renamed by AI');
      expect(next.widgets.w2).toBeUndefined();
      expect(next.widgets.w4).toEqual(chartWidget('w4', 'W4'));
      // The untouched, concurrently edited widget survives verbatim.
      expect(next.widgets.w3).toEqual({
        ...chartWidget('w3', 'User Renamed'),
        config: { chartType: 'line' },
      });
    });

    it('shallow-merges an update patch onto the live widget config (preserves other keys)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: {
          w1: { ...chartWidget('w1', 'W1'), config: { chartType: 'bar', xField: 'category' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [{ widgetId: 'w1', config: { chartType: 'line' } }],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      // Patched key changes; the untouched key survives the shallow merge.
      expect(next.widgets.w1.config).toEqual({ chartType: 'line', xField: 'category' });
    });

    // T2-2: the old guard was bare truthiness (`if (update.config)`), so an array passed
    // and `{ ...existing.config, ...update.config }` merged its index keys ("0", "1", …)
    // into the widget's live config. A non-record `update.config` must be skipped, same
    // as an absent one.
    it('an array `updatedWidgets[].config` is skipped, not merged as index keys (T2-2)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: {
          w1: { ...chartWidget('w1', 'W1'), config: { chartType: 'bar', xField: 'category' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [{ widgetId: 'w1', config: ['rogue', 'array'] as never }],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      // Unchanged config (no `"0"`/`"1"` keys merged in), and a reference-equality no-op.
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'category' });
      expect(next).toBe(state);
    });

    // T2-2: a truthy STRING is also bare-truthy, and `{ ...existing.config, ...'abc' }`
    // spreads a string's own indices too (`{0:'a',1:'b',2:'c'}`) — the same hazard class
    // as the array case, just via string iteration rather than array iteration.
    it('a string `updatedWidgets[].config` is skipped, not spread as index keys (T2-2)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: {
          w1: { ...chartWidget('w1', 'W1'), config: { chartType: 'bar', xField: 'category' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [{ widgetId: 'w1', config: 'abc' as never }],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      // Unchanged config (no `"0"`/`"1"`/`"2"` keys spread in), and a reference-equality no-op.
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'category' });
      expect(next).toBe(state);
    });

    it('skips an update whose target widget no longer exists', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1', 'W1') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [{ widgetId: 'ghost', title: 'nope' }],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(next.widgets.ghost).toBeUndefined();
      expect(Object.keys(next.widgets)).toEqual(['w1']);
    });

    it('missing activePageId with no widget deltas is a no-op (only the layout is page-scoped)', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [],
          widgetRows: [],
          widgetColSpans: {},
          activePageId: 'nope',
        },
      });
      expect(next).toBe(state);
    });

    it('applies page-independent widget deltas even when activePageId is stale (finding 7)', () => {
      // The target page was deleted mid-turn (`activePageId` names no page), but the
      // widget deltas (`removedWidgetIds`/`addedWidgets`/`updatedWidgets`) are
      // page-independent and lost-update-safe by design — they must still apply rather
      // than the WHOLE delta being silently dropped. Only the page-scoped layout
      // replacement is skipped.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['keep']] },
        },
        // `stray` exists in the flat widgets map but is referenced on no page, so it is
        // genuinely removable regardless of any page layout.
        widgets: { keep: chartWidget('keep', 'Old'), stray: chartWidget('stray') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['stray'],
          addedWidgets: [chartWidget('new1')],
          updatedWidgets: [{ widgetId: 'keep', title: 'New' }],
          widgetRows: [['new1']],
          widgetColSpans: { new1: 6 },
          activePageId: 'deleted-mid-turn', // stale — page no longer exists
        },
      });
      // Widget deltas applied despite the stale active page...
      expect(next.widgets.stray).toBeUndefined();
      expect(Object.hasOwn(next.widgets, 'new1')).toBe(true);
      expect(next.widgets.keep.title).toBe('New');
      // ...but the (page-scoped) layout replacement was skipped — page-1 is untouched.
      expect(next.pages['page-1'].widgetRows).toEqual([['keep']]);
      // No phantom page was created for the stale id.
      expect(Object.hasOwn(next.pages, 'deleted-mid-turn')).toBe(false);
    });

    it("drops a genuinely-removed widget's filters and its stale col-span on other pages", () => {
      // w1 lives only on page-1 (active) and is dropped by this bulk update (absent
      // from the replacement map and from the new active-page rows). Its
      // widget-scoped filter and the stale col-span it left on page-2 (where it is
      // NOT in the rows) must be cleaned up the same way `removeWidget` would.
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['w1'],
          addedWidgets: [],
          updatedWidgets: [],
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
      const state = makeDoc({
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
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          // Both old1 (genuinely gone) and old2 (still referenced on page-2) are
          // listed as removed — the reducer must tell them apart via `stillReferenced`
          // rather than purging cleanup for a widget another page still shows.
          removedWidgetIds: ['old1', 'old2'],
          addedWidgets: [chartWidget('new1')],
          updatedWidgets: [],
          widgetRows: [['new1']],
          widgetColSpans: { new1: 6 },
          activePageId: 'page-1',
        },
      });
      // old2 is still on page-2, so its filter and span are untouched.
      expect(next.filters.map((f) => f.id)).toEqual(['f2']);
      expect(next.pages['page-2'].widgetColSpans).toEqual({ old2: 6 });
      // old2 itself also survives in the global widgets record (never truly removed).
      expect(next.widgets.old2).toEqual(chartWidget('old2'));
    });

    // 2.2: applyBulkUpdate must follow the file's own prototype-hygiene convention
    // (isSafePatchKey on inserts, Object.hasOwn on existence checks) for a
    // server-built mutation that bypasses `parseStateMutation`'s isSafeId check.
    it('an added widget with a __proto__ id does not re-prototype nextWidgets', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [chartWidget('__proto__'), chartWidget('good')],
          updatedWidgets: [],
          widgetRows: [['good']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      // The record's prototype is intact (the unsafe insert was skipped, not applied).
      expect(Object.getPrototypeOf(next.widgets)).toBe(Object.prototype);
      expect(Object.hasOwn(next.widgets, 'good')).toBe(true);
      // No own `__proto__` widget entry was created.
      expect(Object.hasOwn(next.widgets, '__proto__')).toBe(false);
    });

    it('an update for a `constructor` widget id is a clean no-op, not a phantom-existing write', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['good']] } },
        widgets: { good: chartWidget('good') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          // `nextWidgets['constructor']` would resolve to `Object` (truthy) under the old
          // bracket lookup; `Object.hasOwn` treats it as "no such widget".
          updatedWidgets: [{ widgetId: 'constructor', title: 'Hacked' }],
          widgetRows: [['good']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(Object.getPrototypeOf(next.widgets)).toBe(Object.prototype);
      expect(Object.hasOwn(next.widgets, 'constructor')).toBe(false);
      expect(next.widgets.good).toEqual(chartWidget('good'));
    });

    // T2-3: the `updatedWidgets[].config` shallow-merge channel now strips unsafe own
    // config keys, the same defense-in-depth the `updateWidget` config-patch loop applies
    // per-key. Without the strip, the unsafe key survived the merge as an own config
    // property and `deserializeState`'s `hasUnsafeOwnKeys` screen dropped the ENTIRE
    // widget on the next load — silent data loss, reachable for a CUSTOM widget kind.
    it('strips an unsafe own key from a bulk updatedWidgets[].config; widget survives reload (T2-3)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: {
          w1: { id: 'w1', kind: 'acme-x', title: 'W', config: { foo: 'bar' } },
        } as unknown as StudioDoc['widgets'],
      });
      const config = JSON.parse('{"__proto__":{"polluted":true},"foo":"baz"}');
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [{ widgetId: 'w1', config }],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        } as never,
      });
      // The unsafe key is stripped from the merged config; the prototype is untouched.
      expect(Object.hasOwn(next.widgets.w1.config, '__proto__')).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((next.widgets.w1.config as { foo: string }).foo).toBe('baz');
      // The widget round-trips through persistence WITHOUT being dropped on load.
      const reloaded = deserializeState(serializeDoc(next), {});
      expect(reloaded.doc.widgets.w1).toBeDefined();
      expect((reloaded.doc.widgets.w1.config as { foo: string }).foo).toBe('baz');
    });

    // T2-2: the ADD channel (`addedWidgets`) now strips unsafe own config keys too (via
    // `coerceWidgetConfig`), mirroring the UPDATE channels. A server-built added widget whose
    // config carries an own `__proto__` key would otherwise install it verbatim and
    // `deserializeState` would drop the ENTIRE widget on the next load — deferred silent data
    // loss, reachable for a CUSTOM widget kind (no per-kind key restriction).
    it('strips an unsafe own key from a bulk addedWidgets[].config; widget survives reload (T2-2)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const config = JSON.parse('{"__proto__":{"polluted":true},"foo":"baz"}');
      const added = { id: 'w1', kind: 'acme-x', title: 'W', config };
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [added],
          updatedWidgets: [],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        } as never,
      });
      expect(Object.hasOwn(next.widgets.w1.config, '__proto__')).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((next.widgets.w1.config as { foo: string }).foo).toBe('baz');
      const reloaded = deserializeState(serializeDoc(next), {});
      expect(reloaded.doc.widgets.w1).toBeDefined();
      expect((reloaded.doc.widgets.w1.config as { foo: string }).foo).toBe('baz');
    });

    // T2-1: a re-delivered removal bulk (SSE at-least-once) whose `removedWidgetIds` names an
    // already-gone widget must return the SAME doc reference — the prior code minted a fresh,
    // content-identical `widgets` record (a no-op `{ ...widgets }` + `delete`), flipping the
    // change gate and pushing a spurious undo entry.
    it('re-applying a removal bulk for an already-gone widget returns the SAME doc reference (T2-1)', () => {
      const bulk = {
        type: 'applyBulkUpdate' as const,
        args: {
          removedWidgetIds: ['w1'],
          addedWidgets: [],
          updatedWidgets: [],
          widgetRows: [],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      };
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1') },
      });
      // 1) First delivery genuinely removes w1.
      const afterFirst = applyDocMutation(state, bulk);
      expect(afterFirst.widgets.w1).toBeUndefined();
      expect(afterFirst).not.toBe(state);
      // 2) Re-delivery of the SAME envelope: w1 is already gone, so the whole bulk is a no-op
      // and must return the SAME doc reference (no spurious undo entry).
      const afterSecond = applyDocMutation(afterFirst, bulk);
      expect(afterSecond).toBe(afterFirst);
    });

    it('re-delivering the same bulk does not clobber a concurrent edit to an added widget (idempotent add) (1.2)', () => {
      const bulk = {
        type: 'applyBulkUpdate' as const,
        args: {
          removedWidgetIds: [],
          addedWidgets: [chartWidget('wb', 'AI title')],
          updatedWidgets: [],
          widgetRows: [['wb']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      };
      const base = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      // 1) The bulk adds `wb` with the AI's title.
      const afterBulk = applyDocMutation(base, bulk);
      expect(afterBulk.widgets.wb.title).toBe('AI title');
      // 2) The user renames `wb`.
      const afterEdit = applyDocMutation(afterBulk, {
        type: 'updateWidget',
        args: { widgetId: 'wb', changes: { title: 'User title' } },
      });
      expect(afterEdit.widgets.wb.title).toBe('User title');
      // 3) The SAME envelope is re-delivered (SSE at-least-once retry): the idempotent
      // add must skip the already-present `wb`, leaving the user's edit intact.
      const afterRedelivery = applyDocMutation(afterEdit, bulk);
      expect(afterRedelivery.widgets.wb.title).toBe('User title');
    });

    it('a bulk that removes/adds/updates nothing and keeps the layout returns the SAME state reference (2.1)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1']],
            widgetColSpans: { w1: 12 },
          },
        },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [],
          widgetRows: [['w1']],
          widgetColSpans: { w1: 12 },
          activePageId: 'page-1',
        },
      });
      expect(next).toBe(state);
    });

    it('a field-less updatedWidgets entry returns the SAME state reference (idempotent update) (1.2)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          // No field to apply — must not rewrap the widget or churn the doc.
          updatedWidgets: [{ widgetId: 'w1' }],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(next).toBe(state);
    });

    it('a value-identical updatedWidgets entry returns the SAME state reference (idempotent update) (1.2)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1', 'Current') },
      });
      // Re-delivered bulk (SSE at-least-once) carrying the widget's CURRENT title and a
      // config patch equal to the live config must be a no-op — not a spurious undo step.
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [{ widgetId: 'w1', title: 'Current', config: { chartType: 'bar' } }],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(next).toBe(state);
    });

    it('an updatedWidgets entry that genuinely changes a field still rewraps and applies (1.2)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1', 'Old') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [{ widgetId: 'w1', title: 'New' }],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(next).not.toBe(state);
      expect(next.widgets.w1.title).toBe('New');
    });

    it('sanitizes phantom widgetRows ids (neither an existing nor an added widget) (1.3)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          // `ghost` is neither an existing widget nor an added widget — it must be
          // stripped from the persisted rows (no widget entry would exist for it).
          updatedWidgets: [],
          widgetRows: [['w1', 'ghost']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
      expect(Object.hasOwn(next.widgets, 'ghost')).toBe(false);
    });

    it("keeps rows referencing this bulk's own addedWidgets ids (not filtered as phantoms) (1.3)", () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      // A row legitimately references `new1`, inserted later in the same handler; it must
      // survive sanitization (filtering against `state.widgets` alone would drop it).
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [chartWidget('new1')],
          updatedWidgets: [],
          widgetRows: [['new1', 'ghost']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['new1']]);
      expect(Object.hasOwn(next.widgets, 'new1')).toBe(true);
      expect(Object.hasOwn(next.widgets, 'ghost')).toBe(false);
    });

    it('drops a phantom row id left behind by a skipped unsafe-id addedWidgets entry (1.3)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          // The `__proto__`-id add is skipped as unsafe, so a row referencing it would be
          // a phantom — it must be stripped rather than persisted with no widget entry.
          addedWidgets: [chartWidget('__proto__'), chartWidget('good')],
          updatedWidgets: [],
          widgetRows: [['good', '__proto__']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['good']]);
      expect(Object.hasOwn(next.widgets, '__proto__')).toBe(false);
      expect(Object.getPrototypeOf(next.widgets)).toBe(Object.prototype);
    });

    it('normalizes `seriesType` in an updatedWidgets config patch (2.3)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: {
          w1: { ...chartWidget('w1'), config: { chartType: 'mixed' } },
        },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [
            { widgetId: 'w1', config: { ySeries: [{ fieldId: 'revenue', seriesType: 'line' }] } },
          ],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      const series = (next.widgets.w1.config as { ySeries: Array<Record<string, unknown>> })
        .ySeries[0];
      expect(series.type).toBe('line');
      expect('seriesType' in series).toBe(false);
    });

    it('deduplicates a widget id repeated in widgetRows (first occurrence wins) (review 2.1)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [],
          // `w1` appears twice (once per row) — the duplicate must be dropped so the
          // page never renders the same widget twice.
          widgetRows: [['w1', 'w2'], ['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(next.pages['page-1'].widgetRows).toEqual([['w1', 'w2']]);
    });

    // ── total over a parser-bypassing partial layout payload (finding 2.5, shared with
    //    ai-middleware T2-4) ──────────────────────────────────────────────────────────
    it('leaves the active-page layout untouched when BOTH widgetRows and widgetColSpans are omitted (finding 2.5)', () => {
      // The three widget-delta fields are already `?? []`-defaulted, but the two layout
      // fields were read unguarded — `widgetRows.map(...)` threw on an updates-only bulk
      // built by hand (the `executeToolOnState` pattern, which never runs the parser).
      // The correct fix is NOT `widgetRows ?? []` (that would WIPE the layout on mere
      // omission); it is to SKIP the layout replacement entirely when both are absent, so
      // an updates-only bulk preserves whatever layout the user has.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1']],
            widgetColSpans: { w1: 12 },
          },
        },
        widgets: { w1: chartWidget('w1') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            updatedWidgets: [{ widgetId: 'w1', title: 'Renamed' }],
            activePageId: 'page-1',
          },
        } as StateMutation);
      }).not.toThrow();
      // The update applied…
      expect(next.widgets.w1.title).toBe('Renamed');
      // …and the layout was NOT wiped by the omission.
      expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
    });

    // Iteration-20 finding: `removedWidgetIds` malfunctioned as a no-op whenever the bulk
    // omitted `widgetRows` — the active page's OWN rows still named the removed widget,
    // so `removeWidgetIds`'s "stillReferenced" check saw it as still-live and refused to
    // remove it from `widgets`/`filters`/spans, even though this exact mutation named it
    // in `removedWidgetIds`.
    it('removes a widget named in removedWidgetIds even when widgetRows is omitted (updates-only bulk)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w1: 12 },
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
        ],
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['w1'],
          addedWidgets: [],
          updatedWidgets: [],
          activePageId: 'page-1',
        },
      } as StateMutation);
      // w1 is genuinely gone: dropped from the flat record, its row, its span, and its filter.
      expect(next.widgets.w1).toBeUndefined();
      expect(next.pages['page-1'].widgetRows).toEqual([['w2']]);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
      expect(next.filters.map((f) => f.id)).toEqual([]);
      // w2 (untouched) survives.
      expect(next.widgets.w2).toEqual(chartWidget('w2'));
    });

    it('still respects a genuine cross-page reference when widgetRows is omitted (does not remove a widget another page shows)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['shared']] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [['shared']] },
        },
        widgets: { shared: chartWidget('shared') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['shared'],
          addedWidgets: [],
          updatedWidgets: [],
          activePageId: 'page-1',
        },
      } as StateMutation);
      // Stripped from page-1 (the bulk's active page)…
      expect(next.pages['page-1'].widgetRows).toEqual([]);
      // …but page-2 still shows it, so it is NOT genuinely removed.
      expect(next.pages['page-2'].widgetRows).toEqual([['shared']]);
      expect(next.widgets.shared).toEqual(chartWidget('shared'));
    });

    // Iteration-20 finding: an added widget landed in the flat `widgets` record but was
    // never placed onto any page's rows when the bulk omitted `widgetRows` (the layout-
    // replacement block only runs when a layout field is present) — an orphan that
    // exists but never renders anywhere.
    it('places an added widget onto the active page even when widgetRows is omitted', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [chartWidget('new1')],
          updatedWidgets: [],
          activePageId: 'page-1',
        },
      } as StateMutation);
      expect(next.widgets.new1).toEqual(chartWidget('new1'));
      expect(next.pages['page-1'].widgetRows).toEqual([['w1'], ['new1']]);
    });

    it('applies a layout update carrying only widgetRows (widgetColSpans omitted) without throwing (finding 2.5)', () => {
      // At least one layout field present ⇒ the layout replacement runs; the ABSENT
      // `widgetColSpans` is coerced to `{}` (not read unguarded) so `Object.keys` can't
      // throw. The block stays total on a partial payload.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        widgets: { w1: chartWidget('w1') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            widgetRows: [['w1']],
            activePageId: 'page-1',
          },
        } as StateMutation);
      }).not.toThrow();
      expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    it('reconciles a widgetColSpans-only bulk against the EXISTING rows, without wiping the layout (T1-1)', () => {
      // The third partial shape (mirror of the rows-only test above): `widgetColSpans`
      // present, `widgetRows` ABSENT. `safeRows` used to fall to `[]`, un-placing every
      // widget on the active page and then orphaning the very span the bulk carried. The
      // fix reconciles the span update against the page's current rows instead.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w1: 12 },
          },
        },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            widgetColSpans: { w1: 18 },
            activePageId: 'page-1',
          },
        } as unknown as StateMutation);
      }).not.toThrow();
      // Rows are preserved (not wiped to `[]`), so every widget stays placed.
      expect(next.pages['page-1'].widgetRows).toEqual([['w1'], ['w2']]);
      // …and only the span was updated (clamped/enforced, kept because its row still holds w1).
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 18 });
    });

    it('treats a present-but-non-array widgetRows (null) as ABSENT, leaving the layout untouched (Finding 3)', () => {
      // A hand-built server payload (bypassing `parseStateMutation`, which rejects a
      // non-array `widgetRows`) with `widgetRows: null` used to take the third branch and
      // coerce to `[]`, un-placing every widget on the active page — contradicting the
      // T1-1 invariant that a malformed layout field must never mean "replace with
      // nothing". `null` is now handled the same as ABSENT (`page.widgetRows ?? []`).
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w1: 12 },
          },
        },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            widgetRows: null,
            widgetColSpans: { w1: 18 },
            activePageId: 'page-1',
          },
        } as unknown as StateMutation);
      }).not.toThrow();
      // The page's existing layout is preserved (NOT wiped to `[]`).
      expect(next.pages['page-1'].widgetRows).toEqual([['w1'], ['w2']]);
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 18 });
    });

    it('MERGES spans when a junk widgetRows (null) accompanies a colSpans payload, not REPLACE (T2-2)', () => {
      // A junk `widgetRows: null` is treated as ABSENT for row placement (rows preserved),
      // and — the T2-2 fix — the spans decision keys on the SAME `Array.isArray` predicate,
      // so it MERGES rather than REPLACES. Under the old `widgetRows === undefined` predicate,
      // `null` took the REPLACE branch and wiped w2's concurrent/unnamed span even though
      // rows were never re-placed. w2's span (18) must survive alongside w1's update.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            // Separate rows so the two spans never overflow a single row's 24 columns.
            widgetRows: [['w1'], ['w2']],
            // w2's span is set by a prior turn / concurrent client drag-resize the batch
            // doesn't name.
            widgetColSpans: { w1: 12, w2: 18 },
          },
        },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            widgetRows: null,
            // Only w1 is named — no w2 entry.
            widgetColSpans: { w1: 8 },
            activePageId: 'page-1',
          },
        } as unknown as StateMutation);
      }).not.toThrow();
      // Rows preserved…
      expect(next.pages['page-1'].widgetRows).toEqual([['w1'], ['w2']]);
      // …w1 updated, and w2's unnamed span SURVIVES the merge (would be gone under REPLACE).
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 8, w2: 18 });
    });

    it('MERGES a widgetColSpans-only bulk onto existing spans, preserving an untouched widget concurrently resized (T2-2)', () => {
      // T2-2 (residual lost-update): a colSpans-only bulk names ONLY the widget whose
      // width the model changed (w1). Widget w2 already has a span set — from a prior turn
      // or a concurrent client drag-resize that landed AFTER the producer built its delta.
      // The reducer used to WHOLESALE-REPLACE the page's span map with the wire payload,
      // silently wiping w2's span (the same lost-update class as `widgetRows`, one field
      // over). The merge fix keeps w2's span while applying w1's update.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            // Separate rows so the two spans never overflow a single row's 24 columns.
            widgetRows: [['w1'], ['w2']],
            // w2's span is already set (prior turn / concurrent client drag-resize).
            widgetColSpans: { w1: 12, w2: 18 },
          },
        },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            // Only w1 is named — no `widgetRows`, no w2 entry (a partial/colSpans-only payload).
            widgetColSpans: { w1: 8 },
            activePageId: 'page-1',
          },
        } as unknown as StateMutation);
      }).not.toThrow();
      // w1's span updated…
      expect(next.pages['page-1'].widgetColSpans?.w1).toBe(8);
      // …and w2's span SURVIVES the merge (would be `undefined` under the old replace bug).
      expect(next.pages['page-1'].widgetColSpans?.w2).toBe(18);
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 8, w2: 18 });
      // Rows untouched.
      expect(next.pages['page-1'].widgetRows).toEqual([['w1'], ['w2']]);
    });

    it('a bulk-added widget with a `null` config is stored with `{}`, safe for a later update (T2-2)', () => {
      // Mirror of the addWidget T2-2 fix on the bulk `addedWidgets` path: the add site
      // coerces a non-record config to `{}` rather than storing the null landmine.
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        widgets: {},
      });
      const nullConfigWidget = {
        id: 'wb',
        kind: 'chart',
        title: 'WB',
        config: null,
      } as unknown as StudioWidgetOf<'chart'>;
      let added!: StudioDoc;
      expect(() => {
        added = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            addedWidgets: [nullConfigWidget],
            activePageId: 'page-1',
          },
        } as StateMutation);
      }).not.toThrow();
      expect(added.widgets.wb.config).toEqual({});
      // A subsequent bulk config update on that widget no longer throws on the null.
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(added, {
          type: 'applyBulkUpdate',
          args: {
            updatedWidgets: [{ widgetId: 'wb', config: { chartType: 'line' } }],
            activePageId: 'page-1',
          },
        } as StateMutation);
      }).not.toThrow();
      expect((next.widgets.wb.config as { chartType?: string }).chartType).toBe('line');
    });
  });

  describe('renameAIThread', () => {
    it('renames only the active thread', () => {
      const state = makeDoc({
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old1', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
            { id: 't2', name: 'Old2', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      });
      const next = applyDocMutation(state, {
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
      const state = makeDoc({
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old1', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
            { id: 't2', name: 'Old2', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      });
      const next = applyDocMutation(state, {
        type: 'renameAIThread',
        args: { name: 'New2', updatedAt: '2024-06-01T00:00:00.000Z', threadId: 't2' },
      });
      expect(next.ai?.threads[0].name).toBe('Old1');
      expect(next.ai?.threads[1].name).toBe('New2');
      expect(next.ai?.threads[1].updatedAt).toBe('2024-06-01T00:00:00.000Z');
    });

    it('falls back to the active thread when threadId is omitted (legacy payloads)', () => {
      const state = makeDoc({
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old1', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      });
      const next = applyDocMutation(state, {
        type: 'renameAIThread',
        args: { name: 'New1', updatedAt: '2024-06-01T00:00:00.000Z' },
      });
      expect(next.ai?.threads[0].name).toBe('New1');
    });

    it('returns the same reference for a no-op (no active thread)', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'renameAIThread',
        args: { name: 'x', updatedAt: '2024-01-01T00:00:00.000Z' },
      });
      expect(next).toBe(state);
    });

    it('a threadId matching no thread returns the SAME state reference (no undo step) (2.1)', () => {
      const state = makeDoc({
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old1', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      });
      const next = applyDocMutation(state, {
        type: 'renameAIThread',
        args: { name: 'New', updatedAt: '2024-06-01T00:00:00.000Z', threadId: 'nope' },
      });
      expect(next).toBe(state);
    });

    it('renaming a thread to its identical name+timestamp returns the SAME state reference (2.1)', () => {
      const state = makeDoc({
        ai: {
          activeThreadId: 't1',
          threads: [
            {
              id: 't1',
              name: 'Same',
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-06-01T00:00:00.000Z',
              messages: [],
            },
          ],
        },
      });
      const next = applyDocMutation(state, {
        type: 'renameAIThread',
        args: { name: 'Same', updatedAt: '2024-06-01T00:00:00.000Z', threadId: 't1' },
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
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: id, changes: { title: 'x' } },
      });
      expect(next).toBe(state);
    });

    it.each(pollutingIds)('removeWidget targeting %j on a widgetless state is a no-op', (id) => {
      const state = twoPageState();
      const next = applyDocMutation(state, { type: 'removeWidget', args: { widgetId: id } });
      expect(next).toBe(state);
      expect(next.widgets).toEqual({});
    });

    it.each(pollutingIds)('setWidgetColSpan targeting %j does not throw or pollute', (id) => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const next = applyDocMutation(state, {
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
        const state = makeDoc({
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
        const next = applyDocMutation(state, {
          type: 'setWidgetColSpan',
          args: { widgetId: 'w1', columns: 12, rowWidgetIds: ['w1', 'w2', id] },
        });
        // 12 + (16 + 0) = 28 > 24, two+ other widgets → all sibling spans dropped.
        expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
      },
    );

    it.each(pollutingIds)('setActivePage / renamePage targeting %j are no-ops', (id) => {
      const state = twoPageState();
      expect(applyDocMutation(state, { type: 'setActivePage', args: { pageId: id } })).toBe(state);
      expect(
        applyDocMutation(state, { type: 'renamePage', args: { pageId: id, title: 'X' } }),
      ).toBe(state);
    });
  });

  it('an unrecognized mutation type is a graceful no-op', () => {
    const state = twoPageState();
    const bogus = { type: 'bogusMutation', args: {} } as any;
    const next = applyDocMutation(state, bogus);
    expect(next).toBe(state);
  });

  it('a mutation type naming an Object.prototype member is a graceful no-op, not doc corruption (T2-1)', () => {
    // The dispatch bracket lookup had no `Object.hasOwn` gate, so a `type` naming a
    // prototype member resolved UP the chain instead of to `undefined`, defeating the
    // `handler ? … : doc` guard: `type: 'constructor'` invoked `Object.apply(doc, args)`
    // and replaced the WHOLE doc with a bogus `{}`; `'__proto__'`/`'valueOf'` threw
    // mid-apply. Every such `type` must now be the same graceful no-op an unknown type is.
    const state = twoPageState();
    for (const type of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      const bogus = { type, args: {} } as any;
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, bogus);
      }, `applyDocMutation type=${type}`).not.toThrow();
      // Same reference back — the doc is neither replaced nor corrupted.
      expect(next, `applyDocMutation type=${type}`).toBe(state);
    }
  });

  // T2-3: the reducer must stay TOTAL over a parser-bypassing server-built mutation with a
  // partial/malformed `args` (the `executeToolOnState` path never runs `parseStateMutation`),
  // returning the graceful no-op `doc` reference rather than throwing or installing junk.
  describe('reducer totality over parser-bypassing partial payloads (T2-3)', () => {
    it('a non-record args is a graceful no-op at the dispatch boundary', () => {
      const state = twoPageState();
      for (const args of [undefined, null, 42, 'x', []]) {
        const bogus = { type: 'addWidget', args } as any;
        let next!: StudioDoc;
        expect(
          () => {
            next = applyDocMutation(state, bogus);
          },
          `args=${JSON.stringify(args)}`,
        ).not.toThrow();
        expect(next, `args=${JSON.stringify(args)}`).toBe(state);
      }
    });

    it('addPage with a missing id does not mint an "undefined" page or unset activePageId', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, { type: 'addPage', args: { title: 'X' } } as any);
      expect(next).toBe(state);
      expect(Object.hasOwn(next.pages, 'undefined')).toBe(false);
      expect(next.dashboard.activePageId).toBe('page-1');
    });

    it('addWidget with a missing widget is a no-op, not a throw', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addWidget',
        args: { pageId: 'page-1' },
      } as any);
      expect(next).toBe(state);
    });

    it('setWidgetLayout with a missing/non-array rows is a no-op, not a throw', () => {
      const state = twoPageState();
      for (const rows of [undefined, 'not-an-array', 42]) {
        const next = applyDocMutation(state, {
          type: 'setWidgetLayout',
          args: { rows, pageId: 'page-1' },
        } as any);
        expect(next, `rows=${JSON.stringify(rows)}`).toBe(state);
      }
    });

    it('addFilter with a missing filter is a no-op, not a throw', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, { type: 'addFilter', args: {} } as any);
      expect(next).toBe(state);
    });
  });
});

// The full-state `applyMutation` wrapper must only ever rewrite the `doc` partition:
// `session` (mode/shell) and `runtime` (dataSources) are structurally invisible to
// the reducer, so they must come out the other side as the SAME object references.
// This makes the compile-time access boundary observable at runtime.
describe('applyMutation wrapper — reducer cannot touch session/runtime', () => {
  const chart = (id: string): StudioWidgetOf<'chart'> => ({
    id,
    kind: 'chart',
    title: 'W',
    config: { chartType: 'bar' },
  });

  function fullState(): StudioState {
    return createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w0', 'w1']] } },
        widgets: { w0: chart('w0'), w1: chart('w1') },
      },
      session: { mode: 'view', shell: { selectedWidgetId: 'w1' } as never },
      runtime: {
        dataSources: { orders: { id: 'orders', label: 'Orders', fields: [], rows: [{ a: 1 }] } },
      },
    });
  }

  const cases: Array<{ label: string; mutation: StateMutation }> = [
    {
      label: 'addWidget',
      mutation: { type: 'addWidget', args: { widget: chart('w2'), pageId: 'page-1' } },
    },
    {
      label: 'updateWidget',
      mutation: { type: 'updateWidget', args: { widgetId: 'w1', changes: { title: 'X' } } },
    },
    { label: 'removeWidget', mutation: { type: 'removeWidget', args: { widgetId: 'w1' } } },
    {
      label: 'setWidgetLayout',
      // Splits the shared row into two — a genuine layout change (both widgets exist).
      mutation: { type: 'setWidgetLayout', args: { rows: [['w0'], ['w1']], pageId: 'page-1' } },
    },
    {
      label: 'applyBulkUpdate',
      mutation: {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['w1'],
          addedWidgets: [chart('w3')],
          updatedWidgets: [],
          widgetRows: [['w3']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      },
    },
  ];

  it.each(cases)('$label leaves session and runtime referentially identical', ({ mutation }) => {
    const prev = fullState();
    const next = applyMutation(prev, mutation);
    // The doc changed (sanity: these are all real mutations on this fixture)...
    expect(next.doc).not.toBe(prev.doc);
    // ...but session and runtime are the very same objects, untouched.
    expect(next.session).toBe(prev.session);
    expect(next.runtime).toBe(prev.runtime);
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
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [],
          widgetRows: [],
          widgetColSpans: {},
          activePageId: 'p',
        },
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

  it('returns the raw type string for a prototype-member type, not a throw (T2-1)', () => {
    // Without the `Object.hasOwn` gate, `type: 'constructor'`/`'toString'` resolved to a
    // prototype function and threw `handler.label is not a function`. It must fall back to
    // the raw type string, exactly like any other unrecognized type.
    for (const type of ['constructor', 'toString', '__proto__', 'valueOf']) {
      const bogus = { type, args: {} } as any;
      expect(() => mutationLabel(bogus), `mutationLabel type=${type}`).not.toThrow();
      expect(mutationLabel(bogus), `mutationLabel type=${type}`).toBe(type);
    }
  });
});
