import { describe, expect, it } from 'vitest';
import { createDefaultStudioState } from '@mui/x-studio-schema';
import {
  applyDocMutation,
  applyMutation,
  mutationLabel,
  normalizePersistedPages,
} from './applyMutation';
// Hoisted out of `applyMutation.ts` so `factories.ts` can reach them too — see
// `rankFilterScope.ts`. The behaviour these tests pin is unchanged.
import { resolveRankFilterPageId, hasConflictingRankFilter } from './rankFilterScope';
import { serializeDoc, deserializeState } from './statePersistence';
import {
  OPTIONAL_STUDIO_WIDGET_FIELDS,
  REQUIRED_STUDIO_WIDGET_FIELDS,
  STUDIO_WIDGET_FIELDS,
} from './widgetTypeGuards';
import type { StudioDoc, StudioFilterState, StudioState } from './stateTypes';
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

  // Finding 2.2: parser-bypass parity with `addPage`/`renamePage`'s `typeof title !==
  // 'string'` guards. A server-built `setDashboardTitle` bypassing `parseStateMutation`
  // with a non-string `title` must leave the dashboard title untouched rather than
  // installing a value that violates `StudioDoc['dashboard'].title: string`.
  it('setDashboardTitle with a non-string title is a no-op (Finding 2.2)', () => {
    const state = makeDoc({ dashboard: { id: 'd1', title: 'Original', activePageId: 'page-1' } });
    let next!: StudioDoc;
    expect(() => {
      next = applyDocMutation(state, {
        type: 'setDashboardTitle',
        args: { title: 42 },
      } as unknown as StateMutation);
    }).not.toThrow();
    expect(next).toBe(state);
    expect(next.dashboard.title).toBe('Original');
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

  // Tier2 finding (`isPlainRecord` exotic-object tightening): before the fix, `typeof
  // value === 'object' && value !== null && !Array.isArray(value)` was TRUE for a `Date`/
  // `Map`/`RegExp`/class instance — none of those are arrays, but all are non-null
  // objects — so `coerceWidgetConfig`'s `!isPlainRecord(config)` guard never fired for
  // one, and the live exotic instance was stored verbatim as `widget.config` (a field
  // typed `Record<string, unknown>`) rather than being coerced to `{}` the same way
  // `null`/an array config already is above. `isPlainRecord` now checks the value's
  // prototype is exactly `Object.prototype` (or `null`), so a `Date`/`Map` config is
  // rejected exactly like `null` is.
  it('addWidget coerces a Date/Map config to `{}` instead of storing the exotic object verbatim (Tier2)', () => {
    const dateWidget = {
      id: 'w1',
      kind: 'chart',
      title: 'W',
      config: new Date('2026-01-01T00:00:00.000Z'),
    } as unknown as StudioWidgetOf<'chart'>;
    const withDate = applyDocMutation(twoPageState('page-1'), {
      type: 'addWidget',
      args: { widget: dateWidget, pageId: 'page-1' },
    });
    expect(withDate.widgets.w1.config).toEqual({});
    expect(withDate.widgets.w1.config instanceof Date).toBe(false);

    const mapWidget = {
      id: 'w2',
      kind: 'chart',
      title: 'W2',
      config: new Map([['chartType', 'line']]),
    } as unknown as StudioWidgetOf<'chart'>;
    const withMap = applyDocMutation(twoPageState('page-1'), {
      type: 'addWidget',
      args: { widget: mapWidget, pageId: 'page-1' },
    });
    expect(withMap.widgets.w2.config).toEqual({});
    expect(withMap.widgets.w2.config instanceof Map).toBe(false);
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

  // Architecture-audit gap: `addWidget` screened `widget.id` against the prototype-hazard
  // denylist (the test above) but never screened the WIDGET OBJECT's own top-level keys —
  // unlike `docScreening.ts`'s `screenWidgets` (Finding T2-1) and `parseStateMutation.ts`'s
  // `validateWidget`, which both reject a widget carrying an own `__proto__`/`constructor`/
  // `prototype` key outright. `JSON.parse` on a server-built widget (the
  // `executeToolOnState` path bypasses `parseStateMutation` entirely) materializes such a
  // key as a real own DATA property — an object literal never would — and `addWidget`
  // installed it into `state.widgets` verbatim via `{ ...state.widgets, [id]: widget }`.
  // The polluted widget then survived in memory but was silently DROPPED on the very next
  // `serializeDoc`→`deserializeState` round-trip (the load boundary correctly rejects it) —
  // deferred data loss, not an immediate crash. Reject (drop the whole widget) rather than
  // strip-and-keep, matching this handler's own "missing required field ⇒ drop the whole
  // entry" convention.
  it('addWidget rejects a widget carrying an own __proto__ key (prototype-hazard own key)', () => {
    const state = twoPageState('page-1');
    // `JSON.parse` (not an object literal) is required to produce a real OWN `__proto__`
    // data property — the same construction technique the sibling `addFilter` prototype-
    // hazard tests use above.
    const widget = JSON.parse(
      '{"id":"w1","kind":"chart","title":"W","config":{"chartType":"bar"},"__proto__":{"polluted":true}}',
    );
    const next = applyDocMutation(state, {
      type: 'addWidget',
      args: { widget, pageId: 'page-1' } as never,
    });
    expect(next).toBe(state);
    expect(Object.hasOwn(next.widgets, 'w1')).toBe(false);
    // No global prototype pollution leaked out of the reducer.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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

  // Tier 2/3 real bug: `validRowIds` (the row-placement allow-list for
  // `applyBulkUpdate`'s own `addedWidgets`) only screened a candidate widget id through
  // `isSafePatchKey`, which rejects `'__proto__'`/`'constructor'`/`'prototype'` but never
  // checks `typeof widget.id === 'string'`. A numeric `addedWidgets[].id` therefore
  // survived into `validRowIds` and into the sanitized `widgetRows` row, while the
  // separate widget-insertion loop above (which DOES require a string id) skipped
  // inserting it into `state.widgets` — leaving a dangling `widgetRows` reference to a
  // widget id with no `widgets` entry. Both the `validRowIds` population and the
  // `row.filter` sanitization step must reject the non-string id.
  it('applyBulkUpdate with a non-string addedWidgets id does not leave a dangling widgetRows reference (Tier 2/3)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        addedWidgets: [{ ...chartWidget('t'), id: 42, kind: 'text', title: 't', config: {} }],
        updatedWidgets: [],
        widgetRows: [[42]],
        activePageId: 'page-1',
      } as never,
    });
    // The numeric id was never inserted into `widgets` …
    expect(Object.hasOwn(next.widgets, '42')).toBe(false);
    expect(Object.hasOwn(next.widgets, 42 as unknown as string)).toBe(false);
    // … so it must also be filtered out of the sanitized `widgetRows`, not left dangling.
    expect(next.pages['page-1'].widgetRows).toEqual([]);
  });

  // Finding 2 (iteration-27): `addWidget`/`applyBulkUpdate.addedWidgets` guarded `id` and
  // `config` but never checked `widget.kind`/`widget.title` are strings. A server-built
  // payload with a numeric `kind`/`title` previously installed VERBATIM — it isn't
  // rejected outright, and it isn't dropped until the very next `deserializeState` load
  // (whose widget screen drops the entire widget) — deferred silent data loss. It must
  // now be rejected at write time instead.
  it('addWidget with a non-string kind is a no-op (Finding 2)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'addWidget',
      args: { widget: { ...chartWidget('w1'), kind: 42 }, pageId: 'page-1' } as never,
    });
    expect(next).toBe(state);
    expect(Object.hasOwn(next.widgets, 'w1')).toBe(false);
  });

  it('addWidget with a non-string title is a no-op (Finding 2)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'addWidget',
      args: { widget: { ...chartWidget('w1'), title: 42 }, pageId: 'page-1' } as never,
    });
    expect(next).toBe(state);
    expect(Object.hasOwn(next.widgets, 'w1')).toBe(false);
  });

  it('applyBulkUpdate.addedWidgets entry with a non-string kind is skipped (Finding 2)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        addedWidgets: [{ ...chartWidget('w1'), kind: 42 }],
        updatedWidgets: [],
        activePageId: 'page-1',
      } as never,
    });
    expect(Object.hasOwn(next.widgets, 'w1')).toBe(false);
    expect(next.widgets).toEqual(state.widgets);
  });

  it('applyBulkUpdate.addedWidgets entry with a non-string title is skipped (Finding 2)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        addedWidgets: [{ ...chartWidget('w1'), title: 42 }],
        updatedWidgets: [],
        activePageId: 'page-1',
      } as never,
    });
    expect(Object.hasOwn(next.widgets, 'w1')).toBe(false);
    expect(next.widgets).toEqual(state.widgets);
  });

  // H2, the direct sibling of the non-string-`id` dangling-row case above. The two
  // `kind`/`title` skips were added to the insert loop later, and their tests (just above)
  // never pass a `widgetRows` — so the `validRowIds` block, which PREDICTS the insert loop's
  // verdict, kept admitting such an entry's id. The row installed on the active page and the
  // insert loop then skipped the widget, leaving `pages[p].widgetRows` naming a widget absent
  // from `doc.widgets`: the exact "page renders a widget that does not exist" state
  // `validRowIds` exists to prevent. It survives `serializeDoc` and is healed only by
  // `normalizePersistedPages` on the NEXT load. Both blocks now share
  // `isInsertableAddedWidget`, so they cannot disagree again.
  it('applyBulkUpdate with a non-string addedWidgets kind does not leave a dangling widgetRows reference (H2)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        updatedWidgets: [],
        addedWidgets: [{ id: 'w9', kind: 42, title: 't', config: {} }],
        widgetRows: [['w9']],
        activePageId: 'page-1',
      } as never,
    });
    // The widget was never inserted …
    expect(Object.hasOwn(next.widgets, 'w9')).toBe(false);
    // … so no row may name it.
    expect(next.pages['page-1'].widgetRows).toEqual([]);
  });

  it('applyBulkUpdate with a non-string addedWidgets title does not leave a dangling widgetRows reference (H2)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        updatedWidgets: [],
        addedWidgets: [{ id: 'w9', kind: 'chart', title: 42, config: {} }],
        widgetRows: [['w9']],
        activePageId: 'page-1',
      } as never,
    });
    expect(Object.hasOwn(next.widgets, 'w9')).toBe(false);
    expect(next.pages['page-1'].widgetRows).toEqual([]);
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

  // Was: "removing the last remaining page results in activePageId === ''". That test was
  // added as coverage of the then-current behavior, and that behavior was the bug: `''`
  // satisfies no `Object.hasOwn(state.pages, …)` guard, so every legacy pageId-less
  // `addWidget`/`setWidgetLayout`/`setWidgetColSpan` silently no-op'd forever afterwards,
  // with no error and no recovery affordance ("at least one page always exists" is the real
  // invariant — the factory always seeds one). Removing the final page is now refused.
  it('removePage refuses to remove the LAST remaining page (no-op, doc reference preserved)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
      },
    });
    const next = applyDocMutation(state, { type: 'removePage', args: { pageId: 'page-1' } });
    expect(next).toBe(state);
    expect(next.pages['page-1']).toBeDefined();
    expect(next.dashboard.activePageId).toBe('page-1');
  });

  it('removePage still removes a page when another one survives (the guard is not over-broad)', () => {
    const state = twoPageState('page-1');
    const next = applyDocMutation(state, { type: 'removePage', args: { pageId: 'page-1' } });
    expect(Object.keys(next.pages)).toEqual(['page-2']);
    expect(next.dashboard.activePageId).toBe('page-2');
    // …and removing the now-final page is refused, so the doc can never reach zero pages.
    const last = applyDocMutation(next, { type: 'removePage', args: { pageId: 'page-2' } });
    expect(last).toBe(next);
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

  // Finding 1: a NUMERIC `pageId` must never resolve to the STRING-keyed page of the
  // same digits via `Object.hasOwn`'s key coercion. Before the fix, `Object.hasOwn(state.
  // pages, 42)` matched page `"42"` and deleted it, but `f.scope.pageId !== pageId` (a
  // strict `!==`) never matched, so the page-scoped filter survived as an orphan, and
  // `state.dashboard.activePageId === pageId` never matched either, leaving
  // `activePageId` dangling on the just-deleted page.
  it('a numeric pageId is a no-op, not coerced into the STRING page of the same digits (Finding 1)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: '42' },
      pages: { '42': { id: '42', title: 'P42', widgetRows: [] } },
      filters: [
        {
          id: 'fp',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'page', pageId: '42' },
        },
      ],
    });
    const next = applyDocMutation(state, {
      type: 'removePage',
      args: { pageId: 42 },
    } as unknown as StateMutation);
    expect(next).toBe(state);
    expect(next.pages['42']).toBeDefined();
    expect(next.filters).toHaveLength(1);
    expect(next.dashboard.activePageId).toBe('42');
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

  // Finding 1: a NUMERIC `widgetId` must never resolve to the STRING-keyed widget of the
  // same digits via `Object.hasOwn`'s key coercion. Before the fix, `Object.hasOwn(state.
  // widgets, 42)` matched widget `"42"` and deleted it from `state.widgets`, but
  // `stripWidgetIdsFromPages`'s `new Set([42]).has("42")` and `removeWidgetIds`'s
  // `stillReferenced.has(42)` never coerce, so the page row and any scoped filter
  // survived — a half-applied mutation that orphans a page reference and a filter.
  it('a numeric widgetId is a no-op, not coerced into the STRING widget of the same digits (Finding 1)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['42']] } },
      widgets: { '42': chartWidget('42') },
      filters: [
        {
          id: 'fw',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'widget', widgetId: '42' },
        },
      ],
    });
    const next = applyDocMutation(state, {
      type: 'removeWidget',
      args: { widgetId: 42 },
    } as unknown as StateMutation);
    expect(next).toBe(state);
    expect(next.widgets['42']).toBeDefined();
    expect(next.pages['page-1'].widgetRows).toEqual([['42']]);
    expect(next.filters).toHaveLength(1);
  });

  it('addFilter appends the filter verbatim (scope not re-stamped)', () => {
    // `pageId: 'page-2'` (a REAL page, just not the applying side's active page
    // 'page-1') rather than an orphan id: the orphan-page-anchor guard (mirroring the
    // orphan-widget-anchor guard) now rejects a `page`-scoped filter naming a
    // nonexistent page, so this test uses an existing non-active page to isolate the
    // behavior it actually targets — that the scope is applied VERBATIM, not
    // re-stamped with the applying side's active page.
    const state = twoPageState('page-1');
    const filter = {
      id: 'f',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const, pageId: 'page-2' },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter } });
    expect(next.filters[0].scope).toEqual({ kind: 'page', pageId: 'page-2' });
  });

  // Finding 1: require a STRING `filter.id` before installing. Without this, a numeric
  // id installs, but `removeFilter`'s strict `f.id !== filterId` compare never coerces,
  // so it can never match the numeric id, making it unremovable in-session until the
  // load boundary's non-string-id filter screen silently drops the whole filter on the
  // next load.
  it('addFilter with a non-string filter.id is a no-op (Finding 1)', () => {
    const state = twoPageState('page-1');
    const filter = {
      id: 42,
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const, pageId: 'page-1' },
    };
    const next = applyDocMutation(state, {
      type: 'addFilter',
      args: { filter },
    } as unknown as StateMutation);
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(0);
  });

  // F5: unlike the widget ADD channels (`coerceWidgetConfig`/`stripUnsafeConfigKeys`),
  // `addFilter` appended `args.filter` verbatim with no unsafe-own-key strip. A filter
  // carrying a prototype-hazard own key (from a server-built mutation bypassing the
  // parser) would otherwise install it, round-trip through `serializeDoc`, and poison
  // a later `{ ...filter }` spread.
  it('addFilter strips a prototype-hazard own key before appending (F5)', () => {
    const state = twoPageState('page-1');
    const filter = JSON.parse(
      '{"id":"f","field":"x","operator":"equals","value":1,"scope":{"kind":"page","pageId":"page-1"},"__proto__":{"polluted":true}}',
    );
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter } });
    expect(next.filters).toHaveLength(1);
    expect(Object.hasOwn(next.filters[0], '__proto__')).toBe(false);
  });

  // F5: `dependsOn` got no shape backstop at all — a malformed value (e.g. a string
  // instead of `string[]`) would install verbatim and later crash
  // `StudioFiltersDrawer`'s `dependsOn.map(...)`. Repair (strip the key) rather than
  // reject the whole `addFilter`.
  // Tier2 finding: `scope` is a record nested one level inside `filter`, and it was the
  // ONE nested record never screened for an unsafe own key — `stripUnsafeFilterKeys`
  // only stripped the filter's OWN top-level keys before this fix. A server-built
  // mutation bypassing `parseStateMutation` (which now also rejects this shape at the
  // wire boundary — see `parseStateMutation.test.ts`) could otherwise install a scope
  // carrying an own `__proto__` key verbatim.
  it('addFilter strips a prototype-hazard own key from filter.scope before appending (Tier2)', () => {
    const state = twoPageState('page-1');
    const filter = JSON.parse(
      '{"id":"f","field":"x","operator":"equals","value":1,"scope":{"kind":"page","pageId":"page-1","__proto__":{"polluted":true}}}',
    );
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter } });
    expect(next.filters).toHaveLength(1);
    expect(Object.hasOwn(next.filters[0].scope, '__proto__')).toBe(false);
    expect(next.filters[0].scope).toEqual({ kind: 'page', pageId: 'page-1' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('addFilter repairs a malformed dependsOn before appending (F5)', () => {
    const state = twoPageState('page-1');
    const filter = {
      id: 'f',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const, pageId: 'page-1' },
      dependsOn: 'not-an-array',
    } as any;
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter } });
    expect(next.filters).toHaveLength(1);
    expect((next.filters[0] as { dependsOn?: unknown }).dependsOn).toBeUndefined();
  });

  // Entropy-audit finding: `repairFilterDependsOn` had a SHAPE check (`string[]`) but no
  // SIZE cap, unlike `parseStateMutation.ts`'s `isStringArray`, which caps at
  // `MAX_ARRAY_LENGTH` (500 entries). `addFilter` is a server-built mutation that bypasses
  // the wire parser entirely, so an oversized `dependsOn` reached this repair as the ONLY
  // guard standing between it and being installed verbatim — an unbounded array a hostile
  // or buggy server-side caller could grow arbitrarily large.
  it('addFilter repairs an oversized dependsOn array instead of installing it unbounded (dependsOn size cap)', () => {
    const state = twoPageState('page-1');
    const oversized = Array.from({ length: 501 }, (_, i) => `w${i}`);
    const filter = {
      id: 'f',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const, pageId: 'page-1' },
      dependsOn: oversized,
    } as any;
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter } });
    expect(next.filters).toHaveLength(1);
    expect((next.filters[0] as { dependsOn?: unknown }).dependsOn).toBeUndefined();
  });

  it('addFilter leaves an already-clean filter reference-stable (F5)', () => {
    const state = twoPageState('page-1');
    const filter = {
      id: 'f',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const, pageId: 'page-1' },
      dependsOn: ['w1'],
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter } });
    expect(next.filters[0]).toBe(filter);
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

  // Iteration-22 finding (T3 #4): `addFilter` read `scope.kind` right after checking that
  // `args.filter` itself is a record, but never verified `args.filter.scope` was ALSO a
  // record — a parser-bypassing server-built mutation with `filter.scope` absent/non-record
  // would throw `Cannot read properties of undefined (reading 'kind')` instead of the
  // graceful no-op every sibling malformed-shape guard in this handler provides.
  it('no-ops for a filter whose scope is absent (parser-bypass guard) instead of throwing', () => {
    const state = twoPageState('page-1');
    const filter = { id: 'f', field: 'x', operator: 'equals' as const, value: 1 } as any;
    expect(() => applyDocMutation(state, { type: 'addFilter', args: { filter } })).not.toThrow();
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter } });
    expect(next).toBe(state);
  });

  it('no-ops for a filter whose scope is a non-record (parser-bypass guard) instead of throwing', () => {
    const state = twoPageState('page-1');
    const filter = {
      id: 'f',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: 'page' as any,
    };
    expect(() => applyDocMutation(state, { type: 'addFilter', args: { filter } })).not.toThrow();
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter } });
    expect(next).toBe(state);
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

  // Finding: the widget-anchor orphan check above screened `widget`/`cross-filter`/
  // `interactive` scopes, but not a `page`-scoped filter naming a `pageId` the doc
  // doesn't contain — an orphan the reducer can never clean up (`removePage`'s cleanup
  // only fires on a LIVE removal, never for a filter that named a nonexistent page from
  // the start) and one the load boundary (`deserializeState`) already drops on the next
  // load. Reject it here so the wire/reducer boundary and the load boundary agree,
  // mirroring the widget-anchor orphan check's structure.
  it('addFilter drops an orphan page-scoped filter whose pageId names no existing page', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
    });
    const orphan = {
      id: 'f-orphan',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const, pageId: 'ghost-page' },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter: orphan } });
    // No-op-return the input reference (the reducer's unresolvable-target convention).
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(0);
  });

  // Finding 2: `dashboard-date-range` scope carries a REQUIRED `pageId` (unlike `page`
  // scope's optional one), so it can become orphaned via `addFilter` exactly like a
  // `page`-scoped filter — but the orphan check above only covered `page` scope. Before
  // this fix, an `addFilter` naming a nonexistent page for a `dashboard-date-range`
  // filter installed and stayed forever live, while `deserializeState`'s load-boundary
  // screen (`statePersistence.ts`) already drops the identical shape on the next load —
  // a live/persisted disagreement this test pins closed.
  it('addFilter drops an orphan dashboard-date-range filter whose pageId names no existing page', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
    });
    const orphan = {
      id: 'f-orphan',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'dashboard-date-range' as const, sourceId: 'src-1', pageId: 'ghost-page' },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter: orphan } });
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(0);
  });

  it('addFilter installs a dashboard-date-range filter whose pageId names an existing page', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
    });
    const valid = {
      id: 'f-valid',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'dashboard-date-range' as const, sourceId: 'src-1', pageId: 'page-1' },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter: valid } });
    expect(next.filters).toHaveLength(1);
    expect(next.filters[0].id).toBe('f-valid');
  });

  it('addFilter installs a page-scoped filter whose pageId names an existing page', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
    });
    const valid = {
      id: 'f-valid',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const, pageId: 'page-1' },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter: valid } });
    expect(next.filters).toHaveLength(1);
    expect(next.filters[0].id).toBe('f-valid');
  });

  it('addFilter installs a page-scoped filter with NO pageId (legacy "applies on every page" shape)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
    });
    const valid = {
      id: 'f-valid',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const },
    };
    const next = applyDocMutation(state, { type: 'addFilter', args: { filter: valid } });
    expect(next.filters).toHaveLength(1);
    expect(next.filters[0].id).toBe('f-valid');
  });

  // Finding 1 (iteration-27): the same coercion-desync class Iteration 26 closed for
  // `filter.id` survives one level down, inside the scope payload's own anchor ids. A
  // numeric `scope.pageId` (a page keyed `"page-1"` in `state.pages` matches
  // `Object.hasOwn(state.pages, 42)` only if a page happens to be keyed `"42"` — here it
  // does NOT, so the orphan check itself would already reject it; the real hazard is a
  // numeric id that DOES collide with an existing string-keyed page/widget) must be
  // rejected outright rather than being compared via a coercing `Object.hasOwn` lookup.
  it('addFilter no-ops when scope.pageId is a number matching an existing page key (page scope)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: '1' },
      pages: { '1': { id: '1', title: 'P1', widgetRows: [] } },
    });
    const filter = {
      id: 'f-numeric',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'page' as const, pageId: 1 },
    };
    const next = applyDocMutation(state, {
      type: 'addFilter',
      args: { filter } as never,
    });
    // Must not half-apply: no orphaned/coerced filter is installed.
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(0);
  });

  it('addFilter no-ops when scope.pageId is a number for a dashboard-date-range scope', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: '1' },
      pages: { '1': { id: '1', title: 'P1', widgetRows: [] } },
    });
    const filter = {
      id: 'f-numeric',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'dashboard-date-range' as const, sourceId: 'src-1', pageId: 1 },
    };
    const next = applyDocMutation(state, {
      type: 'addFilter',
      args: { filter } as never,
    });
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(0);
  });

  it('addFilter no-ops when scope.widgetId is a number matching an existing widget key (widget scope)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['9']] } },
      widgets: { '9': chartWidget('9') },
    });
    const filter = {
      id: 'f-numeric',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'widget' as const, widgetId: 9 },
    };
    const next = applyDocMutation(state, {
      type: 'addFilter',
      args: { filter } as never,
    });
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(0);
  });

  it('addFilter no-ops when scope.sourceWidgetId is a number (cross-filter scope)', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['9']] } },
      widgets: { '9': chartWidget('9') },
    });
    const filter = {
      id: 'f-numeric',
      field: 'x',
      operator: 'equals' as const,
      value: 1,
      scope: { kind: 'cross-filter' as const, sourceWidgetId: 9, pageId: 'page-1' },
    };
    const next = applyDocMutation(state, {
      type: 'addFilter',
      args: { filter } as never,
    });
    expect(next).toBe(state);
    expect(next.filters).toHaveLength(0);
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

    // Finding 3 (iteration-27): `resolveRankFilterPageId`'s doc comment says "other scope
    // kinds are never rank filters and are excluded by the caller", but `addFilter` used to
    // run the conflict check for ANY `filterMode: 'rank'` regardless of scope kind, and
    // `hasConflictingRankFilter`'s existing-filter loop excluded only `cross-filter`, not
    // `dashboard-date-range`/`interactive`. A wire-valid `addFilter` with `filterMode:
    // 'rank'` on a `dashboard-date-range` scope resolved to a `null` page context, which
    // conflicts with — and is conflicted by — every rank filter, poisoning every future
    // legitimate `page`/`widget` rank filter. Both sides are now gated to `page`/`widget`
    // scopes only.
    it('a rank-mode filter on a dashboard-date-range scope installs without poisoning future page/widget rank filters', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const withDateRangeRank = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'date-range-rank',
            field: 'date',
            operator: 'equals',
            value: null,
            filterMode: 'rank',
            scope: { kind: 'dashboard-date-range', sourceId: 'src-1', pageId: 'page-1' },
          },
        },
      });
      // The dashboard-date-range rank filter itself installs (it is not rejected outright —
      // only the per-page rank-uniqueness GATE is skipped for its scope kind).
      expect(withDateRangeRank.filters.map((f) => f.id)).toEqual(['date-range-rank']);

      // A subsequent legitimate page-scoped rank filter on the SAME page must still be
      // accepted — before this fix, the dashboard-date-range entry's `null`-resolved page
      // context would have made this look like a conflict and silently rejected it.
      const withPageRank = applyDocMutation(withDateRangeRank, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'page-rank',
            field: 'category',
            operator: 'equals',
            value: null,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        },
      });
      expect(withPageRank.filters.map((f) => f.id)).toEqual(['date-range-rank', 'page-rank']);

      // And a THIRD rank filter on the same page must still be correctly rejected — the
      // fix must not have disabled genuine page/widget rank-uniqueness enforcement.
      const rejected = applyDocMutation(withPageRank, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'page-rank-2',
            field: 'region',
            operator: 'equals',
            value: null,
            filterMode: 'rank',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        },
      });
      expect(rejected).toBe(withPageRank);
      expect(rejected.filters.map((f) => f.id)).toEqual(['date-range-rank', 'page-rank']);
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

  // Tier3 finding: `StudioFilterState.dependsOn` (`stateTypes.ts`) lists OTHER filter ids
  // this filter cascades from. `removeFilter` never scanned the remaining filters to drop
  // a now-dangling reference to the just-removed id, leaving a dangling `dependsOn` entry
  // that the client's cascade drawer maps over directly.
  describe('removeFilter dependsOn cascade (Tier3)', () => {
    function stateWithDependentFilters(): StudioDoc {
      return makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        filters: [
          {
            id: 'country',
            field: 'country',
            operator: 'equals',
            value: 'US',
            scope: { kind: 'page', pageId: 'page-1' },
          },
          {
            id: 'city',
            field: 'city',
            operator: 'equals',
            value: 'NYC',
            scope: { kind: 'page', pageId: 'page-1' },
            dependsOn: ['country'],
          },
          {
            id: 'district',
            field: 'district',
            operator: 'equals',
            value: 'Manhattan',
            scope: { kind: 'page', pageId: 'page-1' },
            dependsOn: ['country', 'city'],
          },
          {
            id: 'unrelated',
            field: 'unrelated',
            operator: 'equals',
            value: 'x',
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      });
    }

    it('drops the removed id from a dependent filter, collapsing to undefined when it was the only entry', () => {
      const state = stateWithDependentFilters();
      const next = applyDocMutation(state, {
        type: 'removeFilter',
        args: { filterId: 'country' },
      });
      expect(next.filters.map((f) => f.id)).toEqual(['city', 'district', 'unrelated']);
      const city = next.filters.find((f) => f.id === 'city')!;
      expect(city.dependsOn).toBeUndefined();
    });

    it('prunes only the removed id from a dependsOn array with multiple entries, keeping the rest', () => {
      const state = stateWithDependentFilters();
      const next = applyDocMutation(state, {
        type: 'removeFilter',
        args: { filterId: 'country' },
      });
      const district = next.filters.find((f) => f.id === 'district')!;
      expect(district.dependsOn).toEqual(['city']);
    });

    it('leaves a filter with no reference to the removed id reference-stable', () => {
      const state = stateWithDependentFilters();
      const unrelatedBefore = state.filters.find((f) => f.id === 'unrelated')!;
      const next = applyDocMutation(state, {
        type: 'removeFilter',
        args: { filterId: 'country' },
      });
      const unrelatedAfter = next.filters.find((f) => f.id === 'unrelated')!;
      expect(unrelatedAfter).toBe(unrelatedBefore);
    });

    it('removing a filter nobody depends on still no-ops the dependsOn cascade (reference-stable)', () => {
      const state = stateWithDependentFilters();
      const cityBefore = state.filters.find((f) => f.id === 'city')!;
      const next = applyDocMutation(state, {
        type: 'removeFilter',
        args: { filterId: 'unrelated' },
      });
      const cityAfter = next.filters.find((f) => f.id === 'city')!;
      expect(cityAfter).toBe(cityBefore);
    });
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

    // F2: `changes` was gated on bare truthiness (`if (changes)`), not `isPlainRecord`
    // like the sibling config channels. A truthy non-record `changes` (a string or an
    // array from a parser-bypassing server-built mutation) is iterable via
    // `Object.entries`, which would merge index-keyed junk properties (`"0"`, `"1"`, …)
    // onto the widget. It must instead be treated as ABSENT — a clean no-op.
    it('a non-record `changes` (a string) is a no-op, not a merge of index-keyed junk (F2)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', changes: 'junk' as never },
        });
      }).not.toThrow();
      expect(next).toBe(state);
      expect(Object.hasOwn(next.widgets.w1, '0')).toBe(false);
    });

    it('a non-record `changes` (an array) is a no-op, not a merge of index-keyed junk (F2)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', changes: ['rogue', 'array'] as never },
        });
      }).not.toThrow();
      expect(next).toBe(state);
      expect(Object.hasOwn(next.widgets.w1, '0')).toBe(false);
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

    // R3-F1: the kind-coherence step was gated on `updated.kind !== existing.kind`, which
    // made ONE mutation that both flips `kind` AND supplies a config non-idempotent in the
    // worst direction. First delivery: the gate is true, so it strips the config keys the
    // patch/merge branches just installed. SECOND delivery: `kind` no longer changes, the
    // gate is false, and the SAME foreign keys install permanently — the exact config/kind
    // mismatch the step exists to prevent, which nothing downstream reconciles
    // (`screenWidgets` does no per-kind key check; `serializeDoc` persists it forever).
    // SSE is at-least-once, so a re-delivery is expected, not exotic.
    describe('kind flip + config is idempotent (R3-F1)', () => {
      const chartToGridDoc = () =>
        makeDoc({
          widgets: {
            w1: {
              id: 'w1',
              kind: 'chart',
              title: 'W',
              config: { chartType: 'bar', xField: 'a' },
            },
          },
        });

      it('`{ changes: { kind }, config }` — a re-delivery re-installs nothing', () => {
        const mutation: StateMutation = {
          type: 'updateWidget',
          args: { widgetId: 'w1', changes: { kind: 'grid' }, config: { xField: 'b' } },
        };
        const first = applyDocMutation(chartToGridDoc(), mutation);
        expect(first.widgets.w1.kind).toBe('grid');
        expect(first.widgets.w1.config).toEqual({});
        // The re-delivery must be a TRUE no-op — same doc reference, so `commitDocPatch`
        // skips a phantom undo entry (reference-equality no-op contract).
        const second = applyDocMutation(first, mutation);
        expect(second).toBe(first);
        expect(applyDocMutation(second, mutation)).toBe(second);
      });

      it('`{ changes: { kind, config } }` — a re-delivery re-installs nothing', () => {
        const mutation: StateMutation = {
          type: 'updateWidget',
          args: {
            widgetId: 'w1',
            changes: { kind: 'grid', config: { xField: 'b', gridSortField: 's' } },
          },
        };
        const first = applyDocMutation(chartToGridDoc(), mutation);
        expect(first.widgets.w1.kind).toBe('grid');
        expect(first.widgets.w1.config).toEqual({ gridSortField: 's' });
        const second = applyDocMutation(first, mutation);
        expect(second).toBe(first);
      });

      it('a config patch cannot install a key foreign to the CURRENT kind of the widget', () => {
        // No `kind` flip at all: a plain config patch naming a chart-only key on a grid
        // widget. The old gate skipped the screen entirely here.
        const state = makeDoc({
          widgets: {
            w1: { id: 'w1', kind: 'grid', title: 'T', config: { columns: [] } },
          } as unknown as StudioDoc['widgets'],
        });
        const next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', config: { xField: 'b', gridSortField: 's' } },
        });
        expect(next.widgets.w1.config).not.toHaveProperty('xField');
        expect(next.widgets.w1.config).toEqual({ columns: [], gridSortField: 's' });
      });

      it('a value-neutral update returns the SAME doc reference (value comparison, not identity)', () => {
        // The config patch re-wraps the widget and the kind-coherence screen then reverses
        // it, leaving a fresh but value-identical object. The closing no-op check compares
        // by VALUE, so this is still a no-op.
        const state = makeDoc({
          widgets: {
            w1: { id: 'w1', kind: 'grid', title: 'T', config: { columns: [] } },
          } as unknown as StudioDoc['widgets'],
        });
        const next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', config: { xField: 'b' } },
        });
        expect(next).toBe(state);
      });

      it('a kind flip still sweeps config keys this mutation never touched', () => {
        // The unchanged-kind screen is scoped to the INCOMING keys, but a kind FLIP must
        // still screen the whole config — keys authored under the old kind are all foreign.
        const next = applyDocMutation(chartToGridDoc(), {
          type: 'updateWidget',
          args: { widgetId: 'w1', changes: { kind: 'grid' } },
        });
        expect(next.widgets.w1.config).toEqual({});
      });

      it('an unrelated edit does NOT sweep pre-existing retained config keys', () => {
        // Retention-across-chartType-switch is a documented, permanent feature (see
        // `StudioChartConfig`'s doc and the wire boundary's matching stance), so an edit
        // that names none of those keys must leave them alone. Only `columns` here is
        // kind-foreign, and this mutation does not name it.
        const state = makeDoc({
          widgets: {
            w1: {
              id: 'w1',
              kind: 'chart',
              title: 'W',
              config: { chartType: 'bar', xField: 'a', columns: [] },
            },
          } as unknown as StudioDoc['widgets'],
        });
        const next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', config: { yField: 'r' } },
        });
        expect(next.widgets.w1.config).toEqual({
          chartType: 'bar',
          xField: 'a',
          columns: [],
          yField: 'r',
        });
      });

      it('a non-record live config no-ops rather than throwing in the coherence screen', () => {
        const state = makeDoc({
          widgets: {
            w1: { id: 'w1', kind: 'chart', title: 'W', config: null },
          } as unknown as StudioDoc['widgets'],
        });
        expect(() =>
          applyDocMutation(state, {
            type: 'updateWidget',
            args: { widgetId: 'w1', changes: { kind: 'grid' } },
          }),
        ).not.toThrow();
      });
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

    // F3: `unsetConfigKeys`/`unsetFields` were gated on bare truthiness
    // (`x && x.length > 0`), not `isStringArray`. A truthy non-array STRING is also
    // truthy-with-`.length`, so it was iterated char-by-char, deleting single-character
    // config keys instead of a no-op.
    it('a non-array (string) unsetConfigKeys is a no-op, not char-by-char deletion (F3)', () => {
      const state = makeDoc({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar', x: 1 },
          } as unknown as StudioWidgetOf<'chart'>,
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', unsetConfigKeys: 'x' as never },
        });
      }).not.toThrow();
      expect(next).toBe(state);
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar', x: 1 });
    });

    // F3: an array-LIKE record (`{ 0: 'a', length: 1 }`) is also truthy-with-`.length`
    // but is not iterable — the old gate let it reach `for (const key of …)`, throwing.
    it('an array-like record unsetConfigKeys is a no-op, not a throw (F3)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', unsetConfigKeys: { 0: 'chartType', length: 1 } as never },
        });
      }).not.toThrow();
      expect(next).toBe(state);
      expect(next.widgets.w1.config).toEqual({ chartType: 'bar' });
    });

    it('a non-array (string) unsetFields is a no-op, not char-by-char deletion (F3)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', sourceId: 's', config: {} },
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', unsetFields: 'sourceId' as never },
        });
      }).not.toThrow();
      expect(next).toBe(state);
      expect(next.widgets.w1.sourceId).toBe('s');
    });

    it('an array-like record unsetFields is a no-op, not a throw (F3)', () => {
      const state = makeDoc({
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'W', sourceId: 's', config: {} },
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', unsetFields: { 0: 'sourceId', length: 1 } as never },
        });
      }).not.toThrow();
      expect(next).toBe(state);
      expect(next.widgets.w1.sourceId).toBe('s');
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

    // The mergeable-key allow-list and the `unsetFields` denylist were two of five
    // independently hand-maintained enumerations of `StudioWidgetOf`'s fields, none
    // compile-locked. They are now derived from one locked tuple set
    // (`widgetTypeGuards.ts`); these drive the two channels from those SAME lists, so a
    // field that gains an entry in the tuple but no handling here fails at runtime too.
    const VALID_FIELD_VALUE: Record<string, unknown> = {
      kind: 'grid',
      title: 'New title',
      subtitle: 'New subtitle',
      sourceId: 'src-2',
      titleMode: 'manual',
      subtitleMode: 'manual',
      config: { chartType: 'line' },
    };

    it.each(STUDIO_WIDGET_FIELDS.filter((field) => field !== 'id'))(
      'updateWidget.changes actually merges the mergeable field "%s"',
      (field) => {
        const state = makeDoc({
          widgets: {
            w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
          },
        });
        const value = VALID_FIELD_VALUE[field];
        expect(value).toBeDefined(); // a new field with no fixture here is a real gap
        const next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', changes: { [field]: value } },
        } as unknown as StateMutation);
        expect(next).not.toBe(state);
        // `kind: 'grid'` triggers the kind-coherence reconciliation, which strips the
        // chart-only config; assert on the field itself in every case.
        expect((next.widgets.w1 as unknown as Record<string, unknown>)[field]).toEqual(value);
      },
    );

    it.each(OPTIONAL_STUDIO_WIDGET_FIELDS)('unsetFields voids the optional field "%s"', (field) => {
      const state = makeDoc({
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'W',
            config: { chartType: 'bar' },
            ...(VALID_FIELD_VALUE[field] !== undefined
              ? { [field]: VALID_FIELD_VALUE[field] }
              : {}),
          },
        },
      });
      expect(field in state.widgets.w1).toBe(true);
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', unsetFields: [field] },
      } as unknown as StateMutation);
      expect(field in next.widgets.w1).toBe(false);
    });

    it.each(REQUIRED_STUDIO_WIDGET_FIELDS)(
      'unsetFields never voids the required field "%s"',
      (field) => {
        const state = makeDoc({
          widgets: {
            w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
          },
        });
        const next = applyDocMutation(state, {
          type: 'updateWidget',
          args: { widgetId: 'w1', unsetFields: [field] },
        } as unknown as StateMutation);
        expect(field in next.widgets.w1).toBe(true);
      },
    );

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

    it('ignores a wire-supplied rowWidgetIds for a widget on no page: the span write is a no-op', () => {
      // The widget hasn't been placed into widgetRows yet, so no current row can be
      // derived. A span written for it would be an orphan by the same rule
      // `enforceLayoutColSpans`/`normalizePersistedPages` enforce — deleted by the next
      // layout mutation or the next load — so the handler must not write one, and must
      // not rebalance a real row-mate's span against the wire-supplied grouping either.
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
      expect(next).toBe(state);
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w2: 16 });
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

    it('does not rebalance a span onto a phantom row-mate sharing the row', () => {
      // `ghost` shares w1's row and carries a pre-existing span (forcing the
      // single-other-widget overflow rebalance) but is NOT a real widget — makeDoc
      // auto-registers any id appearing in a row/`widgetColSpans`, so strip it back out.
      const base = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1', 'ghost']],
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
      // MIN_SPAN, so the rebalance wants to write ghost = 12. The write guard skips a
      // non-widget id, so ghost's span is left at its stored value instead.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ ghost: 15, w1: 12 });
    });

    it('no-ops a span write when the widget lives on ANOTHER page than the target (no orphan span)', () => {
      // w1 exists and is placed on page-2's rows, but the mutation targets page-1 (an
      // explicit pageId racing a concurrent move, or a legacy payload applied while the
      // user is on another page). w1 is on none of page-1's rows, so a span written here
      // would be a dead entry that serializes on the wrong page.
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

    it('no-ops (without throwing) for a not-yet-placed widget when rowWidgetIds is omitted', () => {
      // w1 exists in `state.widgets` but sits on NO page, and a parser-bypassing partial
      // payload (an `executeToolOnState`-style mutation built by hand) omits
      // `rowWidgetIds`. The handler never reads that field, so a missing one can't throw —
      // and the unplaced widget makes the whole write a no-op.
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
      expect(next).toBe(state);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    it('never writes a span the reload would delete as an orphan (widget on no page)', () => {
      // Confirmed sequence: addWidget w1 → setWidgetLayout rows: [] (w1 unplaced) →
      // setWidgetColSpan { w1: 12, pageId: 'page-1' }. The orphan rule
      // `enforceLayoutColSpans` and `normalizePersistedPages` both enforce classifies a
      // span for a widget absent from the page's rows as dead weight and deletes it, so
      // the live write silently reverted on the next serialize/deserialize round trip.
      const base = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        widgets: {},
      });
      const added = applyDocMutation(base, {
        type: 'addWidget',
        args: { widget: chartWidget('w1'), pageId: 'page-1' },
      });
      const unplaced = applyDocMutation(added, {
        type: 'setWidgetLayout',
        args: { rows: [], pageId: 'page-1' },
      });
      expect(unplaced.pages['page-1'].widgetRows).toEqual([]);
      expect(Object.keys(unplaced.widgets)).toEqual(['w1']);

      const next = applyDocMutation(unplaced, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 12, pageId: 'page-1', rowWidgetIds: ['w1'] },
      });
      expect(next).toBe(unplaced);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
      // …and the live doc therefore already agrees with what a reload would produce.
      const reloaded = deserializeState(serializeDoc(next), {});
      expect(reloaded.doc.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    // Finding 2.1: a NUMERIC `widgetId` must never resolve to the STRING-keyed widget of
    // the same digits via `Object.hasOwn`'s key coercion. `row.includes(widgetId)` compares
    // by strict `===` (never coerces), so a numeric `42` never matches a row entry `"42"` —
    // but `Object.hasOwn(state.widgets, 42)` DOES coerce and match widget `"42"`. Before the
    // fix this bypassed the "on another page" orphan-span guard (which relies on
    // `currentRow`/the cross-page scan correctly reflecting membership) and persisted a
    // dead span on the wrong page. The fix requires a STRING `widgetId` up front.
    it('a numeric widgetId is a no-op, not coerced into the STRING widget of the same digits (Finding 2.1)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
          'page-2': { id: 'page-2', title: 'P2', widgetRows: [['42']] },
        },
        widgets: { '42': chartWidget('42') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'setWidgetColSpan',
          args: { widgetId: 42, columns: 12, rowWidgetIds: ['42'], pageId: 'page-1' },
        } as unknown as StateMutation);
      }).not.toThrow();
      expect(next).toBe(state);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
      expect(next.pages['page-2'].widgetColSpans).toBeUndefined();
    });
  });

  // "Drops" means the KEY is `delete`d, not spread as an explicit `undefined` — this file's
  // own stated convention (see `pruneDependsOn`'s comment, and `deserializeState`'s
  // `activeThreadId` `delete`). `removeSpanEntries` and `enforceLayoutColSpans` both
  // correctly COLLAPSE an emptied map to `undefined`, but six callers re-materialized it as
  // an own key via `{ ...page, widgetColSpans: nextSpans }`, so `Object.keys(page)` and
  // `'widgetColSpans' in page` both still reported a span map on a page that has none.
  // `toBeUndefined()` cannot tell the two apart, which is why these assert on key PRESENCE.
  describe('a dropped widgetColSpans deletes the key rather than writing `undefined`', () => {
    const spanned = () =>
      makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1', 'w2']],
            widgetColSpans: { w1: 12, w2: 12 },
          },
        },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });

    it('via setWidgetColSpan clearing the only remaining span', () => {
      // Clear w2 first, then w1 — the second clear empties the map.
      const once = applyDocMutation(spanned(), {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w2', columns: null, pageId: 'page-1', rowWidgetIds: ['w1', 'w2'] },
      } as unknown as StateMutation);
      const next = applyDocMutation(once, {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: null, pageId: 'page-1', rowWidgetIds: ['w1', 'w2'] },
      } as unknown as StateMutation);
      expect(Object.hasOwn(next.pages['page-1'], 'widgetColSpans')).toBe(false);
    });

    it('via removeWidget emptying the map (stripWidgetIdsFromPages + removeWidgetIds)', () => {
      const once = applyDocMutation(spanned(), {
        type: 'removeWidget',
        args: { widgetId: 'w1' },
      });
      const next = applyDocMutation(once, { type: 'removeWidget', args: { widgetId: 'w2' } });
      expect(Object.hasOwn(next.pages['page-1'], 'widgetColSpans')).toBe(false);
    });

    it('via setWidgetLayout unplacing every spanned widget (enforceLayoutColSpans)', () => {
      const next = applyDocMutation(spanned(), {
        type: 'setWidgetLayout',
        args: { rows: [], pageId: 'page-1' },
      });
      expect(Object.hasOwn(next.pages['page-1'], 'widgetColSpans')).toBe(false);
    });

    it('via applyBulkUpdate unplacing every spanned widget', () => {
      const next = applyDocMutation(spanned(), {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [],
          widgetRows: [],
          activePageId: 'page-1',
        },
      } as StateMutation);
      expect(Object.hasOwn(next.pages['page-1'], 'widgetColSpans')).toBe(false);
    });

    it('via the load boundary sweep dropping every orphan span (normalizePersistedPages)', () => {
      // Every span is orphaned (no widget exists), so the sweep empties the map.
      const loaded = deserializeState(
        {
          schemaVersion: 1,
          dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
          pages: {
            'page-1': {
              id: 'page-1',
              title: 'P1',
              widgetRows: [],
              widgetColSpans: { gone: 12 },
            },
          },
          widgets: {},
          filters: [],
        } as never,
        {},
      );
      expect(Object.hasOwn(loaded.doc.pages['page-1'], 'widgetColSpans')).toBe(false);
    });

    it('drops an exotic (non-plain-object) widgetColSpans instead of crashing on it (isPlainRecord bypass)', () => {
      // An own enumerable property whose getter THROWS when read — not when merely listed
      // via `Object.keys`. The old `typeof widgetColSpans === 'object' && !== null &&
      // !Array.isArray(...)` check classified any such exotic object as a usable span
      // record (it does not check the prototype), so `Object.keys` would list `w1`, and
      // the clamp loop reading `page.widgetColSpans.w1` to clamp it would then throw.
      // `isPlainRecord` rejects it up front (its prototype isn't `Object.prototype`), so
      // the span map is treated as absent and the throwing getter is never read.
      class BoomSpans {
        constructor() {
          Object.defineProperty(this, 'w1', {
            enumerable: true,
            get(): number {
              throw new Error('span boom');
            },
          });
        }
      }
      const pages = {
        'page-1': {
          id: 'page-1',
          title: 'P1',
          widgetRows: [['w1']],
          widgetColSpans: new BoomSpans(),
        },
      } as unknown as StudioDoc['pages'];
      const widgets = {
        w1: { id: 'w1', kind: 'chart', title: 'W', config: {} },
      } as unknown as StudioDoc['widgets'];
      let result!: StudioDoc['pages'];
      expect(() => {
        result = normalizePersistedPages(pages, widgets);
      }).not.toThrow();
      expect(Object.hasOwn(result['page-1'], 'widgetColSpans')).toBe(false);
    });

    it('treats an exotic applyBulkUpdate.args.widgetColSpans as absent instead of crashing on it (isPlainRecord bypass)', () => {
      // Same shape as the normalizePersistedPages case above, exercised through the
      // reducer's own `spansProvided` check instead of the load boundary's.
      class BoomSpans {
        constructor() {
          Object.defineProperty(this, 'w1', {
            enumerable: true,
            get(): number {
              throw new Error('span boom');
            },
          });
        }
      }
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(spanned(), {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: [],
            addedWidgets: [],
            updatedWidgets: [],
            widgetRows: [['w1', 'w2']],
            widgetColSpans: new BoomSpans(),
            activePageId: 'page-1',
          },
        } as unknown as StateMutation);
      }).not.toThrow();
      // Treated as absent: the replace branch (rows AND spans both "provided") does not
      // apply, so the page's EXISTING spans merge through unchanged rather than being
      // wiped by an exotic value masquerading as an empty replacement map.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12, w2: 12 });
    });

    it('still writes the key when a span map survives', () => {
      const next = applyDocMutation(spanned(), {
        type: 'removeWidget',
        args: { widgetId: 'w2' },
      });
      // w1 was left the SOLE occupant of a row it shared, so its stale span is cleared too —
      // assert on a case where a span genuinely survives instead.
      expect(Object.hasOwn(next.pages['page-1'], 'widgetColSpans')).toBe(false);
      const withSurvivor = applyDocMutation(spanned(), {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 10, pageId: 'page-1', rowWidgetIds: ['w1', 'w2'] },
      } as unknown as StateMutation);
      expect(Object.hasOwn(withSurvivor.pages['page-1'], 'widgetColSpans')).toBe(true);
      expect(withSurvivor.pages['page-1'].widgetColSpans).toEqual({ w1: 10, w2: 12 });
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

    // Iteration-22 finding (T3 #4): the wire boundary (`parseStateMutation`'s
    // `isString(args.title)` gate) already rejects a non-string `addPage.args.title`, but
    // the reducer had no defense-in-depth copy for a parser-bypassing server-built mutation.
    it('no-ops for a non-string title (parser-bypass guard, parity with the wire boundary)', () => {
      const state = twoPageState('page-1');
      const next = applyDocMutation(state, {
        type: 'addPage',
        args: { id: 'page-3', title: 42 as unknown as string },
      });
      expect(next).toBe(state);
      expect(next.pages['page-3']).toBeUndefined();
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

    // Iteration-22 finding (T3 #7): `Object.hasOwn(state.widgets, id)` coerces a non-string
    // `id` to a string when checking property existence, so a parser-bypassing row entry
    // carrying an actual NUMBER (not the string form of it) could silently pass the filter
    // whenever a widget happens to be keyed by that number's string form — but the NUMBER,
    // not the string, would land in `widgetRows`, violating the `string[][]` invariant every
    // other row-processing site assumes. An explicit `typeof id === 'string'` guard closes it.
    it('drops a numeric row id even when a widget is keyed by its string form (parser-bypass guard)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        // Deliberately keyed by the STRING "42" — a plausible real widget id.
        widgets: { '42': chartWidget('42') },
      });
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        // The wire boundary types `rows` as `string[][]`, but a parser-bypassing payload can
        // carry an actual number here.
        args: { rows: [[42 as unknown as string]] },
      });
      // The numeric id is dropped, not silently coerced/kept — the row becomes empty and is
      // dropped entirely.
      expect(next.pages['page-1'].widgetRows).toEqual([]);
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

    // Iteration-22 finding (T3 #4): parser-bypass parity with the wire boundary's
    // `isString(args.title)` gate, mirroring the `addPage` fix above.
    it('no-ops for a non-string title (parser-bypass guard, parity with the wire boundary)', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'renamePage',
        args: { pageId: 'page-1', title: 42 as unknown as string },
      });
      expect(next).toBe(state);
      expect(next.pages['page-1'].title).toBe('P1');
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

    // Finding 1: a NUMERIC `pageId` must never resolve to the STRING-keyed page of the
    // same digits via `Object.hasOwn`'s key coercion. Before the fix, `Object.hasOwn(
    // state.pages, 42)` matched page `"42"` and installed the numeric value verbatim as
    // `dashboard.activePageId` — violating its `string` type, with no self-heal (unlike
    // `removeWidget`/`removePage`, this handler's only invariant check IS the coercing
    // one, so nothing downstream catches the type violation until `deserializeState`).
    it('a numeric pageId is a no-op, not coerced into the STRING page of the same digits (Finding 1)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
          '42': { id: '42', title: 'P42', widgetRows: [] },
        },
      });
      const next = applyDocMutation(state, {
        type: 'setActivePage',
        args: { pageId: 42 },
      } as unknown as StateMutation);
      expect(next).toBe(state);
      expect(next.dashboard.activePageId).toBe('page-1');
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

    // F3: `addedWidgets`/`updatedWidgets` only defaulted with `?? []`, which guards
    // `null`/`undefined` but lets a TRUTHY non-array (a parser-bypassing server-built
    // mutation) straight through to `for...of`, throwing instead of no-opping.
    it('a non-array addedWidgets is a no-op, not a throw (F3)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: [],
            addedWidgets: { notAnArray: true } as never,
            updatedWidgets: [],
            activePageId: 'page-1',
          },
        });
      }).not.toThrow();
      expect(next).toBe(state);
    });

    it('a non-array updatedWidgets is a no-op, not a throw (F3)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: [],
            addedWidgets: [],
            updatedWidgets: 'junk' as never,
            activePageId: 'page-1',
          },
        });
      }).not.toThrow();
      expect(next).toBe(state);
    });

    // F3: a `null`/primitive entry INSIDE an otherwise-well-formed `addedWidgets`/
    // `updatedWidgets` array previously threw reading `.id`/`.widgetId` instead of
    // being skipped, like every other malformed-entry guard in this handler.
    it('a null entry in addedWidgets is skipped, other entries still apply (F3)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: [],
            addedWidgets: [null, chartWidget('ok')] as never,
            updatedWidgets: [],
            activePageId: 'page-1',
          },
        });
      }).not.toThrow();
      expect(next.widgets.ok).toEqual(chartWidget('ok'));
    });

    it('a null entry in updatedWidgets is skipped, other entries still apply (F3)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1', 'Old title') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: [],
            addedWidgets: [],
            updatedWidgets: [null, { widgetId: 'w1', title: 'New title' }] as never,
            activePageId: 'page-1',
          },
        });
      }).not.toThrow();
      expect(next.widgets.w1.title).toBe('New title');
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

    // A merged row can overflow even though every individual span is in range — the
    // incoming width plus a width already on the page. `enforceLayoutColSpans`' rule for an
    // overflowing row is to drop EVERY span in it, which would wipe the width of a widget
    // the payload never mentioned and drop the row to equal flex. Both `set_widget_width`
    // and `apply_bulk_update` are AI-reachable, so the two must resolve the same overflow
    // the same way.
    describe('col-spans merge rebalances instead of dropping the whole row', () => {
      // page p1, row [['w1','w2']], starting spans { w1: 16 }.
      function docWithSharedRow(): StudioDoc {
        return makeDoc({
          dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
          pages: {
            p1: { id: 'p1', title: 'P1', widgetRows: [['w1', 'w2']], widgetColSpans: { w1: 16 } },
          },
          widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
        });
      }

      it('a colSpans-only bulk resolves the overflow exactly like setWidgetColSpan', () => {
        const state = docWithSharedRow();
        const viaColSpan = applyDocMutation(state, {
          type: 'setWidgetColSpan',
          args: { widgetId: 'w2', columns: 10, rowWidgetIds: ['w1', 'w2'], pageId: 'p1' },
        });
        // 24 − 10 = 14 ≥ MIN_SPAN, so w1 absorbs the remainder rather than losing its width.
        expect(viaColSpan.pages.p1.widgetColSpans).toEqual({ w1: 14, w2: 10 });

        const viaBulk = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: [],
            addedWidgets: [],
            updatedWidgets: [],
            widgetColSpans: { w2: 10 },
            activePageId: 'p1',
          },
        });
        expect(viaBulk.pages.p1.widgetColSpans).toEqual({ w1: 14, w2: 10 });
      });

      it('a full-snapshot colSpans bulk fits the row instead of wiping every width', () => {
        const state = docWithSharedRow();
        const next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: [],
            addedWidgets: [],
            updatedWidgets: [],
            widgetColSpans: { w1: 16, w2: 10 },
            activePageId: 'p1',
          },
        });
        // 16 + 10 = 26 > 24. Both widths were explicitly requested, so they are granted in
        // row order out of the 24-column budget: w1 keeps 16 and w2 takes the remaining 8.
        expect(next.pages.p1.widgetColSpans).toEqual({ w1: 16, w2: 8 });
      });

      it('clears an anchor that cannot be granted MIN_SPAN out of the remaining budget', () => {
        const state = docWithSharedRow();
        const next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: [],
            addedWidgets: [],
            updatedWidgets: [],
            widgetColSpans: { w1: 20, w2: 20 },
            activePageId: 'p1',
          },
        });
        // w1 takes 20; only 4 columns remain, below MIN_SPAN (6), so w2 falls back to flex.
        expect(next.pages.p1.widgetColSpans).toEqual({ w1: 20 });
      });

      it('leaves a row the payload names no width in to the drop-to-flex rule', () => {
        const state = makeDoc({
          dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
          pages: {
            p1: {
              id: 'p1',
              title: 'P1',
              widgetRows: [['w1', 'w2'], ['w3']],
              // w1 + w2 already overflow, and this bulk names neither of them.
              widgetColSpans: { w1: 16, w2: 16 },
            },
          },
          widgets: { w1: chartWidget('w1'), w2: chartWidget('w2'), w3: chartWidget('w3') },
        });
        const next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: [],
            addedWidgets: [],
            updatedWidgets: [],
            widgetColSpans: { w3: 12 },
            activePageId: 'p1',
          },
        });
        // No anchor in the overflowing row, so it keeps the documented drop-to-flex
        // resolution; the anchored row's own width applies.
        expect(next.pages.p1.widgetColSpans).toEqual({ w3: 12 });
      });
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

    it('removes a widget named in removedWidgetIds even when it currently lives on another page (T1 cross-page fix)', () => {
      // old2 is dropped from the replacement widgets map AND is currently referenced
      // in page-2's rows — e.g. the user dragged it there mid-turn while an agentic
      // bulk update computed against an earlier snapshot was still in flight. The
      // mutation still explicitly names old2 in `removedWidgetIds`, so it must be
      // removed doc-wide: stripped from EVERY page's rows (not just the active one)
      // before the "still referenced" check runs, mirroring `removeWidget`'s own
      // all-pages `stripWidgetIdsFromPages` call. Previously the pre-strip only
      // touched the active page, so `removeWidgetIds` saw old2 as still-live on
      // page-2 and silently left it (and its filter/span) untouched — no error, no
      // signal that the removal was dropped.
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
          // Both old1 (never referenced elsewhere) and old2 (now living on page-2)
          // are named as removed — both must actually be removed.
          removedWidgetIds: ['old1', 'old2'],
          addedWidgets: [chartWidget('new1')],
          updatedWidgets: [],
          widgetRows: [['new1']],
          widgetColSpans: { new1: 6 },
          activePageId: 'page-1',
        },
      });
      // old2's row is stripped from page-2, and its filter/span are dropped too.
      expect(next.pages['page-2'].widgetRows).toEqual([]);
      expect(next.filters.map((f) => f.id)).toEqual([]);
      expect(next.pages['page-2'].widgetColSpans).toBeUndefined();
      // old2 no longer exists in the global widgets record — genuinely removed.
      expect(next.widgets.old2).toBeUndefined();
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

    // Architecture-audit gap: `isInsertableAddedWidget` — the ONE shared acceptance test
    // both the `validRowIds` prediction step and the insert loop below defer to — screened
    // `widget.id` against the prototype-hazard denylist but never screened the WIDGET
    // OBJECT's own top-level keys. A `JSON.parse`-built `addedWidgets` entry carrying a real
    // own `__proto__` DATA property therefore installed into `state.widgets` verbatim,
    // survived in memory, and was silently dropped on the next `serializeDoc`→
    // `deserializeState` round-trip (the load boundary's `screenWidgets` correctly rejects
    // it) — deferred data loss. Fixing the shared predicate closes the gap for BOTH call
    // sites in one place, keeping them in agreement per the file's own design.
    it('applyBulkUpdate.addedWidgets rejects a widget carrying an own __proto__ key', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
      });
      const widget = JSON.parse(
        '{"id":"w1","kind":"chart","title":"W","config":{"chartType":"bar"},"__proto__":{"polluted":true}}',
      );
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [widget],
          updatedWidgets: [],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'page-1',
        },
      });
      expect(Object.hasOwn(next.widgets, 'w1')).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      // `validRowIds` correctly predicted the insert loop's rejection: no phantom row
      // naming the never-installed widget survived either.
      expect(next.pages['page-1'].widgetRows).toEqual([]);
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

    // Finding 3.3 / T1 cross-page fix: the pre-strip step now clears `removedWidgetIds`
    // from EVERY page's rows (not just the active one) before the "genuinely gone" check
    // runs, so a widget requested for removal is removed doc-wide even when it currently
    // sits on a page the bulk update's `activePageId` never names — its span entry is
    // pruned everywhere it appeared, not left dangling on whichever page it wasn't on.
    it('removes a removed widget doc-wide, pruning its span on every page it appeared on (Finding 3.3 / T1)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w1: 12 },
          },
          'page-2': {
            id: 'page-2',
            title: 'P2',
            widgetRows: [['w1']],
          },
        },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
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
      // w1 is removed doc-wide: gone from `state.widgets` and from every page's rows.
      expect(next.widgets.w1).toBeUndefined();
      expect(next.pages['page-2'].widgetRows).toEqual([]);
      // …and its stale span on page-1 is pruned too (not left as an orphan).
      expect(next.pages['page-1'].widgetRows).toEqual([['w2']]);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
    });

    // Iteration-22 finding (Tier 2 #1): `validRowIds` (used to sanitize the producer-supplied
    // `widgetRows`) did not exclude ids this SAME payload also names in `removedWidgetIds`, so
    // a bulk carrying BOTH `removedWidgetIds: ['w1']` AND a `widgetRows` row still containing
    // `'w1'` kept that row entry alive — defeating the explicit removal in the same mutation.
    // The real producer already strips removed ids out of `widgetRows` before calling this, but
    // the reducer must not depend on that caller discipline: it is the source of truth for
    // mutation validity, so an adversarial/buggy producer that forgets must still see the
    // removal honored.
    it('drops a removed widget from the SAME payload widgetRows even when the payload forgot to strip it', () => {
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
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['w1'],
          addedWidgets: [],
          updatedWidgets: [],
          // Adversarial/buggy producer: still names the removed id in the layout it ships.
          widgetRows: [['w1'], ['w2']],
          widgetColSpans: { w1: 12 },
          activePageId: 'page-1',
        },
      } as StateMutation);
      // w1 is genuinely gone from the widgets record...
      expect(next.widgets.w1).toBeUndefined();
      // ...and its row entry does not survive the layout replacement either — the explicit
      // removal wins over the stale row the same payload also carried.
      expect(next.pages['page-1'].widgetRows).toEqual([['w2']]);
      expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
      expect(next.widgets.w2).toEqual(chartWidget('w2'));
    });

    // Finding 4: `validRowIds` unconditionally deleted every `removedWidgetIds` entry
    // before filtering the producer-supplied `widgetRows`, even when that SAME payload's
    // `addedWidgets` re-inserts the identical id (a reorder/replace within one bulk). The
    // row entry was stripped as a "phantom" BEFORE the re-add took effect, so the widget
    // lost its position and fell back to the bottom-row default placement. It must instead
    // keep the row placement the payload itself supplies for the re-added id.
    it('keeps row placement for a widget id that is both removed and re-added in the same bulk (finding 4)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1'], ['w2']] },
        },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['w1'],
          addedWidgets: [chartWidget('w1')],
          updatedWidgets: [],
          // The producer's own reorder: w1 moves to share a row with w2 instead of
          // occupying its own row — it must NOT be dropped as a phantom nor re-appended
          // to a default bottom row.
          widgetRows: [['w2', 'w1']],
          activePageId: 'page-1',
        },
      } as StateMutation);
      expect(next.widgets.w1).toBeDefined();
      expect(next.pages['page-1'].widgetRows).toEqual([['w2', 'w1']]);
    });

    // F4: with `widgetRows` present, the OLD row-survival + idempotent-add guard
    // combination silently discarded the NEW widget definition — a "replace" bulk
    // became a placement-only no-op. The re-added widget's title/config must now
    // actually update.
    it('a remove+re-add of the same id WITH widgetRows updates the widget definition (F4)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1'], ['w2']] } },
        widgets: { w1: chartWidget('w1', 'Old title'), w2: chartWidget('w2') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['w1'],
          addedWidgets: [chartWidget('w1', 'New title')],
          updatedWidgets: [],
          widgetRows: [['w1'], ['w2']],
          activePageId: 'page-1',
        },
      } as StateMutation);
      // Placement survives (unchanged)…
      expect(next.pages['page-1'].widgetRows).toEqual([['w1'], ['w2']]);
      // …AND the definition updates to the new value (not silently discarded).
      expect(next.widgets.w1.title).toBe('New title');
    });

    // F4: WITHOUT `widgetRows`, the OLD unconditional pre-strip genuinely deleted the
    // widget (losing its placement, cross-filters, and spans) and re-inserted it at the
    // bottom with default placement. Both branches must now agree: placement/filters/
    // spans survive AND the definition updates.
    it('a remove+re-add of the same id WITHOUT widgetRows preserves placement/filters/spans and updates the definition (F4)', () => {
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
        widgets: { w1: chartWidget('w1', 'Old title'), w2: chartWidget('w2') },
        filters: [
          {
            id: 'f1',
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
          addedWidgets: [chartWidget('w1', 'New title')],
          updatedWidgets: [],
          // No widgetRows/widgetColSpans supplied at all — an updates/replace-only bulk.
          activePageId: 'page-1',
        },
      } as StateMutation);
      // Placement is preserved in its ORIGINAL position — not moved to the bottom.
      expect(next.pages['page-1'].widgetRows).toEqual([['w1'], ['w2']]);
      // Spans survive.
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
      // The widget-scoped filter survives (was not dropped as if genuinely removed).
      expect(next.filters.map((f) => f.id)).toEqual(['f1']);
      // The definition updates to the new value.
      expect(next.widgets.w1.title).toBe('New title');
    });

    // The REPLACE branch assigned the incoming widget with NO value comparison at all, so an
    // at-least-once SSE re-delivery of the same remove+re-add bulk minted a fresh,
    // value-identical widget object, flipped `widgetsChanged`, and pushed a phantom undo
    // entry — the one add/update channel in this reducer that did not value-compare first.
    it.each([
      ['with widgetRows', true],
      ['without widgetRows', false],
    ])(
      're-delivering an identical remove+re-add bulk %s returns the SAME doc (no phantom undo entry)',
      (_label, withRows) => {
        const state = makeDoc({
          dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
          pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1'], ['w2']] } },
          widgets: { w1: chartWidget('w1', 'Title'), w2: chartWidget('w2') },
        });
        const mutation = {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: ['w1'],
            // A distinct-but-value-identical widget object, exactly as `JSON.parse` of the
            // re-delivered SSE frame produces.
            addedWidgets: [chartWidget('w1', 'Title')],
            updatedWidgets: [],
            ...(withRows ? { widgetRows: [['w1'], ['w2']] } : {}),
            activePageId: 'page-1',
          },
        } as StateMutation;
        // First delivery applies (it genuinely replaces the definition)…
        const first = applyDocMutation(state, mutation);
        // …and the SECOND is a value-identical no-op, so the SAME doc reference comes back.
        expect(applyDocMutation(first, mutation)).toBe(first);
      },
    );

    it('a re-add that genuinely CHANGES the widget still applies (the comparison is not blanket)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1', 'Title') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: ['w1'],
          addedWidgets: [
            { ...chartWidget('w1', 'Title'), config: { chartType: 'line' } },
          ] as unknown as StudioWidgetOf<'chart'>[],
          updatedWidgets: [],
          activePageId: 'page-1',
        },
      } as unknown as StateMutation);
      expect(next).not.toBe(state);
      expect(next.widgets.w1.config).toEqual({ chartType: 'line' });
    });

    // L3: the replace path relied on the re-added id's ROW surviving the pre-strip, so that
    // `removeWidgetIds`' `stillReferenced` check would classify it as live. A widget in
    // `doc.widgets` but on NO page's rows has no row to survive — it was therefore treated
    // as genuinely removed and `dropWidgetScopedFilters` took its widget-scoped filter away
    // moments before the insert loop re-added the widget. `removeWidgetIds` is now handed
    // `idsToPreStrip` (removals MINUS re-adds), making the exclusion explicit instead of a
    // row-survival side effect; for a PLACED widget the two lists are equivalent, because
    // the surviving row already vetoed the removal.
    it('a replace of an UNPLACED widget keeps its widget-scoped filter (L3)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        // `w1` exists in `widgets` but appears on no page's rows.
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [] } },
        widgets: { w1: chartWidget('w1', 'Old title') },
        filters: [
          {
            id: 'f1',
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
          addedWidgets: [chartWidget('w1', 'New title')],
          updatedWidgets: [],
          activePageId: 'page-1',
        },
      } as StateMutation);
      // The widget survives the replace with its NEW definition …
      expect(next.widgets.w1.title).toBe('New title');
      // … and its scoped filter was never dropped along the way.
      expect(next.filters.map((f) => f.id)).toEqual(['f1']);
    });

    it('removes a widget from every page when removedWidgetIds names it, even with widgetRows omitted (T1 cross-page fix)', () => {
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
      // Stripped from BOTH pages, not only the bulk's active page…
      expect(next.pages['page-1'].widgetRows).toEqual([]);
      expect(next.pages['page-2'].widgetRows).toEqual([]);
      // …so it is genuinely removed doc-wide.
      expect(next.widgets.shared).toBeUndefined();
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

    // Finding 2.1: a NUMERIC `removedWidgetIds` entry must never delete a STRING-keyed
    // widget/span/filter via `Object.hasOwn`'s key coercion. `stillReferenced` (built from
    // the page rows, all real strings) is a `Set<string>`, so the number `42` never matches
    // row entry `"42"` — but `Object.hasOwn(widgets, 42)` DOES coerce and match widget
    // `"42"`, so before the fix the widget/its span/its filter were deleted even though a
    // page's row still (as a STRING) references it — an orphaned dangling row reference.
    // The fix filters `removedWidgetIds` to `typeof id === 'string'` before use, so the
    // numeric `42` is dropped and this bulk becomes a genuine no-op.
    it('a numeric removedWidgetIds entry is dropped, not treated as the STRING widget of the same digits (Finding 2.1)', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'P1',
            widgetRows: [['42']],
            widgetColSpans: { '42': 12 },
          },
        },
        widgets: { '42': chartWidget('42') },
        filters: [
          {
            id: 'f1',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind: 'widget', widgetId: '42' },
          },
        ],
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'applyBulkUpdate',
          args: {
            removedWidgetIds: [42],
            addedWidgets: [],
            updatedWidgets: [],
            activePageId: 'page-1',
          },
        } as unknown as StateMutation);
      }).not.toThrow();
      // Nothing was genuinely named for removal (the numeric candidate is dropped before
      // use), so the whole bulk is a no-op: the widget, its row placement, its span, and
      // its filter all survive untouched.
      expect(next).toBe(state);
      expect(next.widgets['42']).toEqual(chartWidget('42'));
      expect(next.pages['page-1'].widgetRows).toEqual([['42']]);
      expect(next.pages['page-1'].widgetColSpans).toEqual({ '42': 12 });
      expect(next.filters.map((f) => f.id)).toEqual(['f1']);
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

    // Finding 2.2: parser-bypass parity with the wire boundary's `isString(args.name)`/
    // `isString(args.updatedAt)` gates. A server-built `renameAIThread` bypassing
    // `parseStateMutation` with a non-string `name` or `updatedAt` must leave the thread
    // untouched rather than installing a value that violates its `name: string`/
    // `updatedAt: string` shape.
    it('a non-string name is a no-op (Finding 2.2)', () => {
      const state = makeDoc({
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old1', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'renameAIThread',
          args: { name: 42, updatedAt: '2024-06-01T00:00:00.000Z' },
        } as unknown as StateMutation);
      }).not.toThrow();
      expect(next).toBe(state);
      expect(next.ai?.threads[0].name).toBe('Old1');
    });

    it('a non-string updatedAt is a no-op (Finding 2.2)', () => {
      const state = makeDoc({
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old1', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'renameAIThread',
          args: { name: 'New1', updatedAt: 42 },
        } as unknown as StateMutation);
      }).not.toThrow();
      expect(next).toBe(state);
      expect(next.ai?.threads[0].name).toBe('Old1');
      expect(next.ai?.threads[0].updatedAt).toBeUndefined();
    });

    // The string-id rule, which `renameAIThread` was the one handler of fourteen to be
    // missing: `args.threadId ?? state.ai.activeThreadId` accepts ANY non-nullish value, so
    // it neither fell back to the active thread nor was screened for being a string.
    //
    // The case that actually distinguishes the two implementations is a non-string
    // `threadId` that MATCHES a thread carrying the same non-string `id`: the old code
    // renamed it, while `deserializeState`'s `ai.threads` screen DROPS any thread whose
    // `id` is not a string. So the reducer used to write a rename onto a thread the very
    // next load deletes — deferred data loss, exactly what the string-id rule exists to
    // stop. (For every non-string `threadId` that matches nothing, both implementations
    // no-op; that path is covered by the unknown-id test above.)
    it('a non-string threadId never matches a thread carrying that same non-string id', () => {
      // Built as a raw doc, not via the factory: `createDefaultStudioState` now screens its
      // `doc` bag and would drop the malformed thread before the reducer ever saw it.
      const state: StudioDoc = {
        ...makeDoc(),
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 42, name: 'Junk', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
            { id: 't1', name: 'Real', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      } as unknown as StudioDoc;
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'renameAIThread',
          args: { name: 'Renamed', updatedAt: '2024-06-01T00:00:00.000Z', threadId: 42 },
        } as unknown as StateMutation);
      }).not.toThrow();
      expect(next).toBe(state);
      expect(next.ai?.threads[0].name).toBe('Junk');
      expect(next.ai?.threads[1].name).toBe('Real');
    });

    it.each([
      ['a boolean', true],
      ['an object', { id: 't1' }],
      ['an array', ['t1']],
    ])('a %s threadId is a no-op and does NOT fall back to the active thread', (_label, id) => {
      const state = makeDoc({
        ai: {
          activeThreadId: 't1',
          threads: [
            { id: 't1', name: 'Old1', createdAt: '2024-01-01T00:00:00.000Z', messages: [] },
          ],
        },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'renameAIThread',
          args: { name: 'New1', updatedAt: '2024-06-01T00:00:00.000Z', threadId: id },
        } as unknown as StateMutation);
      }).not.toThrow();
      expect(next).toBe(state);
      expect(next.ai?.threads[0].name).toBe('Old1');
    });

    it('an explicit null threadId still falls back to the active thread (`??` parity)', () => {
      // JSON has no `undefined`, so a producer that means "no explicit thread" spells it
      // `null`. That must keep the legacy active-thread fallback, exactly as
      // `resolveTargetPageId` treats a `null` `pageId`.
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
        args: { name: 'New1', updatedAt: '2024-06-01T00:00:00.000Z', threadId: null },
      } as unknown as StateMutation);
      expect(next.ai?.threads[0].name).toBe('New1');
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

    // Finding: `args.rows` being an array doesn't guarantee every ROW ENTRY is one — a
    // parser-bypassing server-built mutation can supply `rows: ['w1']` or `rows: [null]`,
    // and the sanitizer's `.map((row) => row.filter(...))` would throw on a non-array row
    // instead of the graceful no-op every sibling row-sanitizing site (`normalizePersistedPages`,
    // `applyBulkUpdate`) provides. A non-array row is dropped, same as a phantom-widget row.
    it('setWidgetLayout drops a non-array row entry instead of throwing', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'setWidgetLayout',
          args: { rows: ['w1', null, ['w1']] as any, pageId: 'page-1' },
        });
      }).not.toThrow();
      expect(next.pages['page-1'].widgetRows).toEqual([['w1']]);
    });

    // A parser-bypassing partial payload can supply a truthy NON-array `rowWidgetIds`
    // (e.g. a string). The handler derives row membership from the live rows and never
    // reads that field, so a junk value cannot throw — and w1 being on no row makes this
    // a no-op regardless.
    it('setWidgetColSpan with a non-array rowWidgetIds does not throw', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1', 'w2']] } },
        widgets: { w1: chartWidget('w1'), w2: chartWidget('w2') },
      });
      let next!: StudioDoc;
      expect(() => {
        next = applyDocMutation(state, {
          type: 'setWidgetColSpan',
          args: { widgetId: 'w1', columns: 12, rowWidgetIds: 'w1' as any, pageId: 'page-1' },
        });
      }).not.toThrow();
      expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
    });

    // Finding: `new Set('w1')` iterates a STRING char-by-char (`{'w','1'}`), so a
    // parser-bypassing `removedWidgetIds: 'w1'` would silently delete widgets literally
    // named `'w'` and `'1'` instead of the intended widget `'w1'`. A non-array value must
    // be rejected/ignored, mirroring the wire boundary's `isStringArray` guard.
    it('applyBulkUpdate with a non-array removedWidgetIds does not iterate it as a string', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
        widgets: { w1: chartWidget('w1'), w: chartWidget('w'), '1': chartWidget('1') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: 'w1' as any,
          addedWidgets: [],
          updatedWidgets: [],
          activePageId: 'page-1',
        },
      });
      // Neither the char-by-char-iterated 'w' nor '1' is removed, and the real 'w1' widget
      // (which was never actually named in a real array) survives too — the malformed
      // input is ignored wholesale rather than partially applied.
      expect(next.widgets.w).toBeDefined();
      expect(next.widgets['1']).toBeDefined();
      expect(next.widgets.w1).toBeDefined();
    });

    // Finding: `title`/`kind` are load-bearing with no fallback, and `deserializeState`
    // drops the ENTIRE widget on the next load if either is non-string. A parser-bypassing
    // `changes: { title: 42 }`/`{ kind: 42 }` must be rejected at write time rather than
    // merged verbatim and left to detonate on the next load.
    it('updateWidget rejects a non-string changes.title/changes.kind instead of merging it', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { title: 42, kind: 42 } as any },
      });
      expect(next.widgets.w1.title).toBe(state.widgets.w1.title);
      expect(next.widgets.w1.kind).toBe(state.widgets.w1.kind);
    });

    // Finding: `applyBulkUpdate.updatedWidgets[].title` is typed as `string | undefined`
    // on the wire mutation, but a parser-bypassing server-built bulk can still carry a
    // non-string value — reject it rather than merging it verbatim (the same deferred
    // whole-widget-loss hazard the `updateWidget.changes.title` guard above closes).
    it('applyBulkUpdate rejects a non-string updatedWidgets[].title instead of merging it', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [{ widgetId: 'w1', title: 42 as any }],
          activePageId: 'page-1',
        },
      });
      expect(next.widgets.w1.title).toBe(state.widgets.w1.title);
    });

    // Finding 3: `subtitle`/`sourceId` are guarded as STRINGS at the wire boundary
    // (`parseStateMutation.ts`'s `isOptionalString` gates), but the `updateWidget.changes`
    // parser-bypass merge path only guarded `title`/`kind` — a non-string `subtitle`
    // crashes `StudioWidgetEditDialog` (rendered directly as text) and a non-string
    // `sourceId` silently breaks the widget-to-data-source lookup with no self-heal.
    it('updateWidget rejects a non-string changes.subtitle/changes.sourceId instead of merging it', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { subtitle: 42, sourceId: 42 } as any },
      });
      expect(next.widgets.w1.subtitle).toBe(state.widgets.w1.subtitle);
      expect(next.widgets.w1.sourceId).toBe(state.widgets.w1.sourceId);
      expect(next).toBe(state);
    });

    // Finding 3 (`applyBulkUpdate.updatedWidgets` sibling of the above): guarded `title`
    // but not `sourceId` — a parser-bypassing bulk carrying a non-string `sourceId` would
    // install verbatim and silently break the data-source lookup.
    it('applyBulkUpdate rejects a non-string updatedWidgets[].sourceId instead of merging it', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [{ widgetId: 'w1', sourceId: 42 as any }],
          activePageId: 'page-1',
        },
      });
      expect(next.widgets.w1.sourceId).toBe(state.widgets.w1.sourceId);
    });

    // Finding 2: `titleMode`/`subtitleMode` are guarded at the wire boundary
    // (`parseStateMutation.ts`'s `isTitleModeValue`, only `'auto' | 'manual' |
    // undefined`) and at the load boundary (`deserializeState` strips a bad value), but
    // the `updateWidget.changes` parser-bypass merge path was missing the equivalent
    // check — a numeric `titleMode`/`subtitleMode` would merge verbatim and steer the
    // client's auto-title logic until the next load strips it. Reject (skip), matching
    // the sibling `title`/`kind`/`subtitle`/`sourceId` scalar guards.
    it('updateWidget rejects a non-auto/manual changes.titleMode/changes.subtitleMode instead of merging it', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { titleMode: 42, subtitleMode: 'bogus' } as any },
      });
      expect((next.widgets.w1 as any).titleMode).toBe((state.widgets.w1 as any).titleMode);
      expect((next.widgets.w1 as any).subtitleMode).toBe((state.widgets.w1 as any).subtitleMode);
      expect(next).toBe(state);
    });

    // The valid values must still merge normally — the new guard must not reject
    // `'auto'`/`'manual'` themselves.
    it('updateWidget accepts a valid changes.titleMode/changes.subtitleMode', () => {
      const state = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        widgets: { w1: chartWidget('w1') },
      });
      const next = applyDocMutation(state, {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { titleMode: 'manual', subtitleMode: 'auto' } as any },
      });
      expect((next.widgets.w1 as any).titleMode).toBe('manual');
      expect((next.widgets.w1 as any).subtitleMode).toBe('auto');
    });

    it('addFilter with a missing filter is a no-op, not a throw', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, { type: 'addFilter', args: {} } as any);
      expect(next).toBe(state);
    });

    // Finding 6: `applyDocMutation`/`mutationLabel` read `mutation.type` before the
    // existing `args`-level totality gate, so a non-record `mutation` (`null`, a
    // primitive) threw on `Object.hasOwn(…, mutation.type)`. Both must stay total.
    it('a non-record mutation is a graceful no-op / label, not a throw (Finding 6)', () => {
      const state = twoPageState();
      for (const mutation of [undefined, null, 42, 'x', []]) {
        let next!: StudioDoc;
        expect(
          () => {
            next = applyDocMutation(state, mutation as any);
          },
          `mutation=${JSON.stringify(mutation)}`,
        ).not.toThrow();
        expect(next, `mutation=${JSON.stringify(mutation)}`).toBe(state);
        expect(() => mutationLabel(mutation as any)).not.toThrow();
        expect(mutationLabel(mutation as any)).toBe('unknown');
      }
    });
  });

  // Finding 1: the ADD channels (`addWidget`, `applyBulkUpdate.addedWidgets`) require a
  // string `kind`/`title` but installed the OPTIONAL scalars (`subtitle`/`sourceId`/
  // `titleMode`/`subtitleMode`) verbatim. The wire boundary validates all four; the load
  // boundary strips the offending key. These paths must key-strip an invalid value on
  // write so it never lands to be silently dropped on the next load.
  describe('ADD channels screen optional widget scalars (Finding 1)', () => {
    it('addWidget key-strips a non-string subtitle/sourceId and a non-auto/manual titleMode/subtitleMode', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addWidget',
        args: {
          widget: {
            id: 'w1',
            kind: 'chart',
            title: 'T',
            config: { chartType: 'bar' },
            subtitle: 42,
            sourceId: 42,
            titleMode: 'weird',
            subtitleMode: 7,
          },
          pageId: 'page-1',
        },
      } as any);
      const w = next.widgets.w1 as unknown as Record<string, unknown>;
      expect(Object.hasOwn(w, 'subtitle')).toBe(false);
      expect(Object.hasOwn(w, 'sourceId')).toBe(false);
      expect(Object.hasOwn(w, 'titleMode')).toBe(false);
      expect(Object.hasOwn(w, 'subtitleMode')).toBe(false);
    });

    it('addWidget keeps valid optional scalars', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addWidget',
        args: {
          widget: {
            id: 'w1',
            kind: 'chart',
            title: 'T',
            config: { chartType: 'bar' },
            subtitle: 'sub',
            sourceId: 'src',
            titleMode: 'manual',
            subtitleMode: 'auto',
          },
          pageId: 'page-1',
        },
      } as any);
      const w = next.widgets.w1 as unknown as Record<string, unknown>;
      expect(w.subtitle).toBe('sub');
      expect(w.sourceId).toBe('src');
      expect(w.titleMode).toBe('manual');
      expect(w.subtitleMode).toBe('auto');
    });

    it('applyBulkUpdate.addedWidgets key-strips invalid optional scalars', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [
            {
              id: 'w1',
              kind: 'chart',
              title: 'T',
              config: { chartType: 'bar' },
              subtitle: 42,
              titleMode: 'weird',
            },
          ],
          updatedWidgets: [],
          activePageId: 'page-1',
        },
      } as any);
      const w = next.widgets.w1 as unknown as Record<string, unknown>;
      expect(Object.hasOwn(w, 'subtitle')).toBe(false);
      expect(Object.hasOwn(w, 'titleMode')).toBe(false);
    });
  });

  // Finding 2: `addFilter` checked id/scope/anchors/ranks but appended a filter with a
  // non-string `field` or an invalid `operator`/`operator2` verbatim, which the load
  // boundary then dropped wholesale. No-op instead of installing.
  describe('addFilter screens field/operator/operator2 (Finding 2)', () => {
    const baseFilter = {
      id: 'f1',
      field: 'country',
      operator: 'equals',
      value: 'FR',
      scope: { kind: 'page', pageId: 'page-1' },
    };

    it('no-ops a non-string field', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: { filter: { ...baseFilter, field: 42 } },
      } as any);
      expect(next).toBe(state);
    });

    it('no-ops an invalid operator', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: { filter: { ...baseFilter, operator: 'equal' } },
      } as any);
      expect(next).toBe(state);
    });

    it('no-ops an invalid operator2 when present', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: { filter: { ...baseFilter, operator2: 'nonsense' } },
      } as any);
      expect(next).toBe(state);
    });

    it('accepts a valid field/operator/operator2', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: { filter: { ...baseFilter, operator2: 'contains' } },
      } as any);
      expect(next.filters).toHaveLength(1);
      expect(next.filters[0].id).toBe('f1');
    });
  });

  // Finding 4: `dashboard-date-range` scope's `pageId` is REQUIRED, but the string guard
  // exempted `pageId === undefined`. A parser-bypassing payload omitting it installed a
  // filter anchored to nothing. Require a string pageId outright.
  describe('addFilter requires dashboard-date-range pageId (Finding 4)', () => {
    it('no-ops a dashboard-date-range scope with a missing pageId', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f1',
            field: 'date',
            operator: 'equals',
            value: '2024',
            scope: { kind: 'dashboard-date-range', sourceId: 's1' },
          },
        },
      } as any);
      expect(next).toBe(state);
    });

    it('accepts a dashboard-date-range scope with a valid string pageId', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f1',
            field: 'date',
            operator: 'equals',
            value: '2024',
            scope: { kind: 'dashboard-date-range', sourceId: 's1', pageId: 'page-1' },
          },
        },
      } as any);
      expect(next.filters).toHaveLength(1);
    });
  });

  // H1: `addFilter` hand-rolled its scope screening per kind and checked only `typeof
  // scope.kind === 'string'` for kind membership, so it accepted two shapes BOTH other
  // trust boundaries reject — the deferred-data-loss class the "all three boundaries agree
  // on the same payload" rule exists to prevent. Both are reachable WITHOUT the wire parser
  // (`executeToolOnState.ts` builds mutations straight from LLM tool args; the public
  // `StudioController.addFilter` commits straight to the reducer). The handler now delegates
  // wellformedness to `isValidFilterScope`, the same predicate the wire and load boundaries
  // use, keeping only the doc-relative EXISTENCE checks the wire structurally cannot do.
  describe('addFilter delegates scope wellformedness to the shared predicate (H1)', () => {
    // `FILTER_SCOPE_REQUIRED_IDS` lists BOTH `sourceId` and `pageId` for
    // `dashboard-date-range`, but the reducer screened `pageId` alone. A payload omitting
    // `sourceId` installed live with `scope.sourceId === undefined` — so the date window is
    // matched against a source id that can never be right — persisted, and was then silently
    // dropped by `isValidFilterScope` on the very next load.
    it('no-ops a dashboard-date-range scope missing its REQUIRED sourceId', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f1',
            field: 'date',
            operator: 'equals',
            value: '2024',
            scope: { kind: 'dashboard-date-range', pageId: 'page-1' },
          },
        },
      } as any);
      expect(next).toBe(state);
      expect(next.filters).toHaveLength(0);
    });

    // An UNKNOWN kind was the sharper of the two: it installed and then escaped EVERY
    // cleanup path, because `dropWidgetScopedFilters`, `removePage`'s page-anchor drop and
    // `removeWidgetIds` all key off the five known kinds. The filter then narrowed its page
    // forever with no clearing affordance — exactly the failure `statePersistence.ts`'s own
    // `isValidFilterScope` comment describes.
    it('no-ops a scope whose kind is not one of the five known kinds', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f1',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind: 'pages' },
          },
        },
      } as any);
      expect(next).toBe(state);
      expect(next.filters).toHaveLength(0);
    });

    // The delegation must not tighten the ONE genuinely-optional id: `page` scope's
    // `pageId` is optional (a legacy pageId-less filter applies on every page), and
    // `validateFilterScope` handles that with `isOptionalString`. Pinned here so a future
    // simplification of the shared predicate cannot silently drop the legacy shape.
    it('still accepts the legacy pageId-less page scope through the shared predicate', () => {
      const state = twoPageState();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: { id: 'f1', field: 'x', operator: 'equals', value: 1, scope: { kind: 'page' } },
        },
      } as any);
      expect(next.filters.map((f) => f.id)).toEqual(['f1']);
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

  // Iteration-22 finding (T3 #3): `mutationLabel` is only guaranteed a record TOP-LEVEL
  // `args` (its own `isPlainRecord(mutation.args)` guard) — a server-built mutation
  // bypassing `parseStateMutation` could still supply a record `args` whose nested
  // `widget`/`filter` field is absent/non-record, and the OLD `addWidget`/`addFilter` label
  // builders threw reading `.kind`/`.id`/`.field` straight off of it, contradicting the "never
  // throws" contract this function's callers (the undo/redo history label, `get_recent_changes`)
  // rely on.
  it('does not throw building an addWidget label when args.widget is absent, falling back to "unknown"', () => {
    const bogus = { type: 'addWidget', args: {} } as unknown as StateMutation;
    expect(() => mutationLabel(bogus)).not.toThrow();
    expect(mutationLabel(bogus)).toBe('addWidget:unknown:unknown');
  });

  it('does not throw building an addFilter label when args.filter is absent, falling back to "unknown"', () => {
    const bogus = { type: 'addFilter', args: {} } as unknown as StateMutation;
    expect(() => mutationLabel(bogus)).not.toThrow();
    expect(mutationLabel(bogus)).toBe('addFilter:unknown');
  });
});

// ─── H1: unresolvable vs. wildcard rank-filter page context ──────────────────
// `resolveRankFilterPageId` used to return `null` for BOTH "this filter applies on every
// page" (the legacy pageId-less `page` scope) and "this filter has no page context at all"
// (a `widget` scope whose widget sits on no page's rows). Since `null` conflicts with — and
// is conflicted by — every rank filter, ONE unplaced-widget rank filter silently rejected
// every subsequent rank `addFilter` on every page. Nothing removes such a filter:
// `dropWidgetScopedFilters` fires only on widget REMOVAL, and a widget can be left in
// `doc.widgets` but on no page's rows by a `setWidgetLayout` or an `applyBulkUpdate`.
describe('rank-filter page-context resolution (H1)', () => {
  const rankFilter = (id: string, scope: StudioFilterState['scope']): StudioFilterState => ({
    id,
    field: 'country',
    operator: 'equals',
    value: null,
    filterMode: 'rank',
    scope,
  });

  // A doc where `w-unplaced` exists in `widgets` but appears on NO page's `widgetRows`.
  function docWithUnplacedWidget(): StudioDoc {
    return makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w-placed']] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
      },
      widgets: { 'w-placed': chartWidget('w-placed'), 'w-unplaced': chartWidget('w-unplaced') },
    });
  }

  it('resolveRankFilterPageId distinguishes unresolvable (undefined) from everywhere (null)', () => {
    const { pages } = docWithUnplacedWidget();
    // Legacy pageId-less page scope → `null` (applies everywhere).
    expect(resolveRankFilterPageId(rankFilter('a', { kind: 'page' }), pages)).toBe(null);
    // Explicit page scope → that page id.
    expect(
      resolveRankFilterPageId(rankFilter('b', { kind: 'page', pageId: 'page-2' }), pages),
    ).toBe('page-2');
    // Placed widget → the page holding it.
    expect(
      resolveRankFilterPageId(rankFilter('c', { kind: 'widget', widgetId: 'w-placed' }), pages),
    ).toBe('page-1');
    // Unplaced widget → UNRESOLVABLE, not the `null` wildcard.
    expect(
      resolveRankFilterPageId(rankFilter('d', { kind: 'widget', widgetId: 'w-unplaced' }), pages),
    ).toBe(undefined);
    // A non-rank-eligible scope is also unresolvable, never a wildcard.
    expect(
      resolveRankFilterPageId(
        rankFilter('e', { kind: 'dashboard-date-range', sourceId: 's1', pageId: 'page-1' }),
        pages,
      ),
    ).toBe(undefined);
  });

  it('an unplaced-widget rank filter neither conflicts nor is conflicted with', () => {
    const { pages } = docWithUnplacedWidget();
    const unplaced = rankFilter('r-unplaced', { kind: 'widget', widgetId: 'w-unplaced' });
    const onPage1 = rankFilter('r-page-1', { kind: 'page', pageId: 'page-1' });
    // As the OTHER filter: it must not block a legitimate rank filter on any page.
    expect(hasConflictingRankFilter('r-page-1', onPage1, [unplaced], pages)).toBe(false);
    // As the TARGET: it collides with nothing, not even a pageId-less wildcard.
    expect(
      hasConflictingRankFilter(
        'r-unplaced',
        unplaced,
        [rankFilter('r-everywhere', { kind: 'page' })],
        pages,
      ),
    ).toBe(false);
  });

  it('the pageId-less page scope keeps its wildcard (conflicts-everywhere) semantics', () => {
    const { pages } = docWithUnplacedWidget();
    const everywhere = rankFilter('r-everywhere', { kind: 'page' });
    const onPage2 = rankFilter('r-page-2', { kind: 'page', pageId: 'page-2' });
    expect(hasConflictingRankFilter('r-page-2', onPage2, [everywhere], pages)).toBe(true);
    expect(hasConflictingRankFilter('r-everywhere', everywhere, [onPage2], pages)).toBe(true);
  });

  it('addFilter: an unplaced-widget rank filter does not poison later rank adds on any page', () => {
    const state = docWithUnplacedWidget();
    // The unplaced widget's rank filter installs (its anchor widget exists in `widgets`).
    const withUnplaced = applyDocMutation(state, {
      type: 'addFilter',
      args: { filter: rankFilter('r-unplaced', { kind: 'widget', widgetId: 'w-unplaced' }) },
    });
    expect(withUnplaced.filters.map((f) => f.id)).toEqual(['r-unplaced']);

    // Before the fix, BOTH of these were silently rejected (the handler returned `state`).
    const withPage1 = applyDocMutation(withUnplaced, {
      type: 'addFilter',
      args: { filter: rankFilter('r-page-1', { kind: 'page', pageId: 'page-1' }) },
    });
    const withPage2 = applyDocMutation(withPage1, {
      type: 'addFilter',
      args: { filter: rankFilter('r-page-2', { kind: 'page', pageId: 'page-2' }) },
    });
    expect(withPage2.filters.map((f) => f.id)).toEqual(['r-unplaced', 'r-page-1', 'r-page-2']);

    // The genuine per-page uniqueness guard still fires.
    const rejected = applyDocMutation(withPage2, {
      type: 'addFilter',
      args: { filter: rankFilter('r-page-1-dup', { kind: 'page', pageId: 'page-1' }) },
    });
    expect(rejected).toBe(withPage2);
  });

  // An unresolvable rank filter is accepted unconditionally, so the conflict it cannot have
  // at ADD time can be created later by a PLACEMENT. The layout handlers re-run the same
  // sweep the load boundary runs, so the live doc and a reload agree at commit time rather
  // than diverging until the next load silently deletes the filter.
  describe('a placement that creates a rank conflict resolves it in the reducer', () => {
    // addWidget w1 → setWidgetLayout rows: [] leaves w1 in `widgets` but on no page.
    function docWithUnplacedW1(): StudioDoc {
      const base = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [] } },
        widgets: {},
      });
      const added = applyDocMutation(base, {
        type: 'addWidget',
        args: { widget: chartWidget('w1'), pageId: 'p1' },
      });
      return applyDocMutation(added, { type: 'setWidgetLayout', args: { rows: [], pageId: 'p1' } });
    }

    // f1 (page-scoped rank on p1) + f2 (widget-scoped rank on the UNPLACED w1). Both are
    // accepted: f2 resolves to the UNRESOLVABLE sentinel, so it conflicts with nothing.
    function docWithBothRankFilters(): StudioDoc {
      const withF1 = applyDocMutation(docWithUnplacedW1(), {
        type: 'addFilter',
        args: { filter: rankFilter('f1', { kind: 'page', pageId: 'p1' }) },
      });
      const withF2 = applyDocMutation(withF1, {
        type: 'addFilter',
        args: { filter: rankFilter('f2', { kind: 'widget', widgetId: 'w1' }) },
      });
      expect(withF2.filters.map((f) => f.id)).toEqual(['f1', 'f2']);
      return withF2;
    }

    it('removePage re-resolving a widget-scoped rank filter drops the now-conflicting one', () => {
      // w1 lives on BOTH pages, so its widget-scoped rank filter resolves to p1 (first in
      // page order). p2 separately carries a page-scoped rank filter. Removing p1 makes the
      // widget-scoped filter re-resolve onto p2, where it now collides.
      const base = makeDoc({
        dashboard: { id: 'd1', title: 'D', activePageId: 'p1' },
        pages: {
          p1: { id: 'p1', title: 'P1', widgetRows: [['w1']] },
          p2: { id: 'p2', title: 'P2', widgetRows: [['w1']] },
        },
        widgets: { w1: chartWidget('w1') },
      });
      const withPageRank = applyDocMutation(base, {
        type: 'addFilter',
        args: { filter: rankFilter('f1', { kind: 'page', pageId: 'p2' }) },
      });
      const withWidgetRank = applyDocMutation(withPageRank, {
        type: 'addFilter',
        args: { filter: rankFilter('f2', { kind: 'widget', widgetId: 'w1' }) },
      });
      // Both accepted: f2 resolves to p1, which holds no rank filter.
      expect(withWidgetRank.filters.map((f) => f.id)).toEqual(['f1', 'f2']);

      const next = applyDocMutation(withWidgetRank, {
        type: 'removePage',
        args: { pageId: 'p1' },
      });
      // w1 survives on p2, so f2 survives `removeWidgetIds` — but it now resolves to p2,
      // which f1 already occupies. Array order decides, matching the load boundary.
      expect(next.widgets.w1).toBeDefined();
      expect(next.filters.map((f) => f.id)).toEqual(['f1']);
      const reloaded = deserializeState(serializeDoc(next), {});
      expect(reloaded.doc.filters.map((f) => f.id)).toEqual(['f1']);
    });

    it('setWidgetLayout placing the widget drops the now-conflicting rank filter', () => {
      const state = docWithBothRankFilters();
      const next = applyDocMutation(state, {
        type: 'setWidgetLayout',
        args: { rows: [['w1']], pageId: 'p1' },
      });
      // f2 now resolves to p1, which f1 already occupies. The FIRST rank filter in array
      // order wins — the same tie-break the load boundary uses.
      expect(next.filters.map((f) => f.id)).toEqual(['f1']);
      expect(next.pages.p1.widgetRows).toEqual([['w1']]);
      // Live doc and reload now agree; before the fix the live doc kept ['f1', 'f2'] and
      // the reload silently deleted f2, which the next save then re-persisted.
      const reloaded = deserializeState(serializeDoc(next), {});
      expect(reloaded.doc.filters.map((f) => f.id)).toEqual(['f1']);
    });

    it('applyBulkUpdate placing the widget via widgetRows drops the now-conflicting rank filter', () => {
      const state = docWithBothRankFilters();
      const next = applyDocMutation(state, {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [],
          widgetRows: [['w1']],
          widgetColSpans: {},
          activePageId: 'p1',
        },
      });
      expect(next.filters.map((f) => f.id)).toEqual(['f1']);
      const reloaded = deserializeState(serializeDoc(next), {});
      expect(reloaded.doc.filters.map((f) => f.id)).toEqual(['f1']);
    });

    it('a layout change that creates no conflict leaves the filters array identity intact', () => {
      const state = docWithBothRankFilters();
      // w1 lands on p2, where no other rank filter lives, so both survive…
      const withPage2 = applyDocMutation(state, {
        type: 'addPage',
        args: { id: 'p2', title: 'P2' },
      });
      const next = applyDocMutation(withPage2, {
        type: 'setWidgetLayout',
        args: { rows: [['w1']], pageId: 'p2' },
      });
      expect(next.filters.map((f) => f.id)).toEqual(['f1', 'f2']);
      // …and the untouched array keeps its identity, so no spurious undo entry is pushed.
      expect(next.filters).toBe(withPage2.filters);
    });
  });
});

// ─── H2: dependsOn cascade prune across every filter-removal path ────────────
// The prune used to live inline in `removeFilter`, so it covered exactly one of the
// several paths that drop filters. A page filter `f-city` with `dependsOn: ['f-country']`
// kept pointing at `f-country` after `removeWidget` / `applyBulkUpdate` / `removePage`
// dropped it, and the cascade drawer then gated option-narrowing on a filter that no
// longer exists.
describe('dependsOn cascade prune (H2)', () => {
  const cityFilter = (dependsOn: string[]): StudioFilterState => ({
    id: 'f-city',
    field: 'city',
    operator: 'equals',
    value: 'Paris',
    dependsOn,
    scope: { kind: 'page', pageId: 'page-1' },
  });
  const countryOnW1: StudioFilterState = {
    id: 'f-country',
    field: 'country',
    operator: 'equals',
    value: 'FR',
    scope: { kind: 'widget', widgetId: 'w1' },
  };

  function docWithCascade(dependsOn = ['f-country']): StudioDoc {
    return makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
      },
      widgets: { w1: chartWidget('w1') },
      filters: [countryOnW1, cityFilter(dependsOn)],
    });
  }

  it('removeWidget prunes the dangling dependsOn of the widget filter it drops', () => {
    const next = applyDocMutation(docWithCascade(), {
      type: 'removeWidget',
      args: { widgetId: 'w1' },
    });
    expect(next.filters.map((f) => f.id)).toEqual(['f-city']);
    // The array is dropped entirely (not left as `[]`) — "absent is the canonical empty".
    expect(next.filters[0].dependsOn).toBeUndefined();
  });

  it('removeWidget keeps the surviving dependsOn ids when only one is dropped', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      widgets: { w1: chartWidget('w1') },
      filters: [
        countryOnW1,
        {
          id: 'f-region',
          field: 'region',
          operator: 'equals',
          value: 'EU',
          scope: { kind: 'page', pageId: 'page-1' },
        },
        cityFilter(['f-country', 'f-region']),
      ],
    });
    const next = applyDocMutation(state, { type: 'removeWidget', args: { widgetId: 'w1' } });
    expect(next.filters.find((f) => f.id === 'f-city')?.dependsOn).toEqual(['f-region']);
  });

  it('applyBulkUpdate prunes the dangling dependsOn of a removed widget filter', () => {
    const next = applyDocMutation(docWithCascade(), {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: ['w1'],
        addedWidgets: [],
        updatedWidgets: [],
        activePageId: 'page-1',
      },
    });
    expect(next.filters.map((f) => f.id)).toEqual(['f-city']);
    expect(next.filters[0].dependsOn).toBeUndefined();
  });

  it('removePage prunes a dependsOn pointing at a filter the page drop removed', () => {
    const state = makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
      },
      filters: [
        {
          id: 'f-on-page-2',
          field: 'country',
          operator: 'equals',
          value: 'FR',
          scope: { kind: 'page', pageId: 'page-2' },
        },
        {
          id: 'f-on-page-1',
          field: 'city',
          operator: 'equals',
          value: 'Paris',
          dependsOn: ['f-on-page-2'],
          scope: { kind: 'page', pageId: 'page-1' },
        },
      ],
    });
    const next = applyDocMutation(state, { type: 'removePage', args: { pageId: 'page-2' } });
    expect(next.filters.map((f) => f.id)).toEqual(['f-on-page-1']);
    expect(next.filters[0].dependsOn).toBeUndefined();
  });

  it('is reference-stable: no dangling id means the SAME filters array', () => {
    const state = docWithCascade(['f-country']);
    // Removing a widget that owns no filter drops nothing, so the array must not churn.
    const next = applyDocMutation(state, { type: 'removeWidget', args: { widgetId: 'nope' } });
    expect(next).toBe(state);
    expect(next.filters).toBe(state.filters);
  });

  it('removeFilter still prunes (the original site, now via the shared helper)', () => {
    const state = docWithCascade();
    const next = applyDocMutation(state, {
      type: 'removeFilter',
      args: { filterId: 'f-country' },
    });
    expect(next.filters.map((f) => f.id)).toEqual(['f-city']);
    expect(next.filters[0].dependsOn).toBeUndefined();
  });
});

// ─── M5: cross-filter/interactive pageId parity at the reducer boundary ──────
// `FILTER_SCOPE_REQUIRED_IDS` requires `pageId` for both kinds at the WIRE boundary, but
// the reducer never screened it — and the `executeToolOnState` path never runs the parser.
// A numeric `pageId` installed verbatim and could never be cleared: `removePage` compares
// with a strict `===`, and `serializeDoc` strips both kinds so a reload never repairs it.
describe('addFilter cross-filter/interactive pageId guards (M5)', () => {
  function baseDoc(): StudioDoc {
    return makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      widgets: { w1: chartWidget('w1') },
    });
  }

  it.each(['cross-filter', 'interactive'] as const)(
    'no-ops when a %s scope carries a NON-STRING pageId',
    (kind) => {
      const state = baseDoc();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f-numeric-page',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind, sourceWidgetId: 'w1', pageId: 42 },
          },
        },
      } as unknown as StateMutation);
      expect(next).toBe(state);
      expect(next.filters).toHaveLength(0);
    },
  );

  it.each(['cross-filter', 'interactive'] as const)(
    'no-ops when a %s scope names a page the doc does not contain',
    (kind) => {
      const state = baseDoc();
      const next = applyDocMutation(state, {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f-orphan-page',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind, sourceWidgetId: 'w1', pageId: 'ghost-page' },
          },
        },
      } as unknown as StateMutation);
      expect(next).toBe(state);
      expect(next.filters).toHaveLength(0);
    },
  );

  it.each(['cross-filter', 'interactive'] as const)(
    'still installs a well-formed %s filter (the guard is not over-broad)',
    (kind) => {
      const next = applyDocMutation(baseDoc(), {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f-ok',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind, sourceWidgetId: 'w1', pageId: 'page-1' },
          },
        },
      } as unknown as StateMutation);
      expect(next.filters.map((f) => f.id)).toEqual(['f-ok']);
    },
  );
});

// ─── L1: mutationLabel's `: string` contract ─────────────────────────────────
describe('mutationLabel totality (L1)', () => {
  it.each([[42], [null], [{ nested: true }], [['a']]])(
    'returns a STRING for an unrecognized non-string mutation.type (%p)',
    (type) => {
      const label = mutationLabel({ type, args: {} } as unknown as StateMutation);
      expect(typeof label).toBe('string');
      expect(label).toBe(String(type));
      // Callers use the result as a log line / React child / `.slice()` target.
      expect(() => label.slice(0, 3)).not.toThrow();
    },
  );
});

// ─── H6: a rows-only applyBulkUpdate must not wipe the page's widget widths ──
// `widgetRows` and `widgetColSpans` are INDEPENDENTLY optional on the wire type and are
// validated independently, so "rows only" is a legitimate payload. It used to coerce the
// absent `widgetColSpans` to `{}` and REPLACE the page's whole span map with nothing, so
// the same reorder expressed as `applyBulkUpdate` vs `setWidgetLayout` disagreed on every
// widget's width.
describe('applyBulkUpdate rows-only span preservation (H6)', () => {
  function spannedDoc(): StudioDoc {
    return makeDoc({
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
  }

  it('preserves widgetColSpans when only widgetRows is supplied', () => {
    const next = applyDocMutation(spannedDoc(), {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        addedWidgets: [],
        updatedWidgets: [],
        widgetRows: [['w2', 'w1']],
        activePageId: 'page-1',
      },
    });
    expect(next.pages['page-1'].widgetRows).toEqual([['w2', 'w1']]);
    expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 16, w2: 8 });
  });

  it('agrees with setWidgetLayout for the identical reorder', () => {
    const viaLayout = applyDocMutation(spannedDoc(), {
      type: 'setWidgetLayout',
      args: { rows: [['w2', 'w1']], pageId: 'page-1' },
    });
    const viaBulk = applyDocMutation(spannedDoc(), {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        addedWidgets: [],
        updatedWidgets: [],
        widgetRows: [['w2', 'w1']],
        activePageId: 'page-1',
      },
    });
    expect(viaBulk.pages['page-1'].widgetColSpans).toEqual(
      viaLayout.pages['page-1'].widgetColSpans,
    );
  });

  it('a rows-only bulk still drops a span orphaned by the new rows', () => {
    const next = applyDocMutation(spannedDoc(), {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        addedWidgets: [],
        updatedWidgets: [],
        widgetRows: [['w1']],
        activePageId: 'page-1',
      },
    });
    // w2 is no longer placed, so its stale span is pruned; w1's row collapsed from two
    // widgets to one, so its multi-widget-era span is cleared (the 2→1 collapse rule,
    // matching `setWidgetLayout`) — leaving an empty map, stored as `undefined`.
    expect(next.pages['page-1'].widgetColSpans).toBeUndefined();
  });

  it('rows AND spans together still REPLACE the map (unchanged semantics)', () => {
    const next = applyDocMutation(spannedDoc(), {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        addedWidgets: [],
        updatedWidgets: [],
        widgetRows: [['w1', 'w2']],
        widgetColSpans: { w1: 12 },
        activePageId: 'page-1',
      },
    });
    // w2's previous span is NOT merged back in — the producer shipped the full intended map.
    expect(next.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
  });
});

// ─── M6: updateWidget.changes must only merge real StudioWidget fields ───────
describe('updateWidget.changes key allow-list (M6)', () => {
  function oneWidgetDoc(): StudioDoc {
    return makeDoc({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      widgets: { w1: chartWidget('w1', 'A') },
    });
  }

  it('drops unknown top-level keys instead of merging them onto the widget forever', () => {
    const next = applyDocMutation(oneWidgetDoc(), {
      type: 'updateWidget',
      args: {
        widgetId: 'w1',
        changes: { evil: { a: 1 }, widgetRows: 'x', title: 'Renamed' },
      },
    } as unknown as StateMutation);
    const widget = next.widgets.w1 as unknown as Record<string, unknown>;
    expect(widget.title).toBe('Renamed');
    expect(Object.hasOwn(widget, 'evil')).toBe(false);
    expect(Object.hasOwn(widget, 'widgetRows')).toBe(false);
    // Nothing unknown survives into the persisted shape either.
    expect(Object.keys(serializeDoc(next).widgets.w1).sort()).toEqual([
      'config',
      'id',
      'kind',
      'title',
    ]);
  });

  it('an unknown-keys-only changes bag is a clean no-op (reference-equality contract)', () => {
    const state = oneWidgetDoc();
    const next = applyDocMutation(state, {
      type: 'updateWidget',
      args: { widgetId: 'w1', changes: { evil: 1 } },
    } as unknown as StateMutation);
    expect(next).toBe(state);
  });

  it('still merges every legitimate StudioWidget field', () => {
    const next = applyDocMutation(oneWidgetDoc(), {
      type: 'updateWidget',
      args: {
        widgetId: 'w1',
        changes: {
          title: 'T',
          titleMode: 'manual',
          subtitle: 'S',
          subtitleMode: 'manual',
          sourceId: 'orders',
          kind: 'chart',
        },
      },
    } as unknown as StateMutation);
    expect(next.widgets.w1).toMatchObject({
      title: 'T',
      titleMode: 'manual',
      subtitle: 'S',
      subtitleMode: 'manual',
      sourceId: 'orders',
      kind: 'chart',
    });
  });
});

// R3-F3: the reducer was the ONLY one of the four trust boundaries with no
// `config.chartType` membership screen, so one payload got three different answers — the
// wire boundary REJECTED it, the reducer installed it VERBATIM, and the next load STRIPPED
// the key. That is the deferred-data-loss class: the widget renders blank, wedges every
// later AI `update_widget` (`executeToolOnState` hard-errors on an unknown stored
// chartType), then silently becomes a bar chart on the next reload.
describe('the reducer screens config.chartType like the other three boundaries (R3-F3)', () => {
  const chartDoc = () =>
    makeDoc({
      widgets: {
        w1: { id: 'w1', kind: 'chart', title: 'W', config: { chartType: 'bar' } },
      },
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
    });

  it('addWidget drops an unknown chartType instead of installing it verbatim', () => {
    const next = applyDocMutation(chartDoc(), {
      type: 'addWidget',
      args: {
        widget: {
          id: 'w2',
          kind: 'chart',
          title: 'X',
          config: { chartType: 'trendline', xField: 'a' },
        },
        pageId: 'page-1',
      },
    } as unknown as StateMutation);
    // The load boundary's own answer for the byte-identical payload: key stripped, so
    // `resolveChartType`'s `'bar'` fallback applies. The rest of the config survives.
    expect(next.widgets.w2.config).toEqual({ xField: 'a' });
  });

  it('updateWidget config patch drops a non-string chartType', () => {
    const next = applyDocMutation(chartDoc(), {
      type: 'updateWidget',
      args: { widgetId: 'w1', config: { chartType: 42, xField: 'a' } },
    } as unknown as StateMutation);
    // The patch's bad `chartType` never installs; the widget keeps its stored one.
    expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'a' });
  });

  it('updateWidget changes.config drops an unknown chartType', () => {
    const next = applyDocMutation(chartDoc(), {
      type: 'updateWidget',
      args: { widgetId: 'w1', changes: { config: { chartType: 'sunburst', xField: 'a' } } },
    } as unknown as StateMutation);
    // A wholesale replacement, so the stored `chartType` goes with it — but the unknown one
    // does not take its place.
    expect(next.widgets.w1.config).toEqual({ xField: 'a' });
  });

  it('a VALID chartType still installs through every update channel', () => {
    const patched = applyDocMutation(chartDoc(), {
      type: 'updateWidget',
      args: { widgetId: 'w1', config: { chartType: 'line' } },
    });
    expect(patched.widgets.w1.config).toEqual({ chartType: 'line' });
    const replaced = applyDocMutation(chartDoc(), {
      type: 'updateWidget',
      args: { widgetId: 'w1', changes: { config: { chartType: 'donut' } } },
    });
    expect(replaced.widgets.w1.config).toEqual({ chartType: 'donut' });
  });

  it('applyBulkUpdate.addedWidgets drops an unknown chartType', () => {
    const next = applyDocMutation(chartDoc(), {
      type: 'applyBulkUpdate',
      args: {
        addedWidgets: [
          { id: 'w3', kind: 'chart', title: 'Y', config: { chartType: 'sunburst', xField: 'a' } },
        ],
        activePageId: 'page-1',
      },
    } as unknown as StateMutation);
    expect(next.widgets.w3.config).toEqual({ xField: 'a' });
  });

  it('applyBulkUpdate.updatedWidgets drops an unknown chartType but keeps the stored one', () => {
    const next = applyDocMutation(chartDoc(), {
      type: 'applyBulkUpdate',
      args: {
        updatedWidgets: [{ widgetId: 'w1', config: { chartType: 'sunburst', xField: 'a' } }],
        activePageId: 'page-1',
      },
    } as unknown as StateMutation);
    expect(next.widgets.w1.config).toEqual({ chartType: 'bar', xField: 'a' });
  });

  it('a chartType: undefined patch still DELETES the key (the sanctioned patch-delete)', () => {
    const next = applyDocMutation(chartDoc(), {
      type: 'updateWidget',
      args: { widgetId: 'w1', config: { chartType: undefined } },
    } as unknown as StateMutation);
    expect(next.widgets.w1.config).not.toHaveProperty('chartType');
  });

  it('a widget installed through the reducer round-trips a serialize/load unchanged', () => {
    // The point of the fix: the write channels and the load boundary must agree, so a
    // reload can no longer silently change the widget's chart type.
    const next = applyDocMutation(chartDoc(), {
      type: 'addWidget',
      args: {
        widget: { id: 'w2', kind: 'chart', title: 'X', config: { chartType: 'trendline' } },
        pageId: 'page-1',
      },
    } as unknown as StateMutation);
    const loaded = deserializeState(JSON.parse(JSON.stringify(serializeDoc(next))), {});
    expect(loaded.doc.widgets.w2.config).toEqual(next.widgets.w2.config);
  });
});
