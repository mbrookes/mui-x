import { describe, expect, it } from 'vitest';
import { createDefaultStudioState } from '@mui/x-studio-schema';
import { parseStateMutation, PARSEABLE_MUTATION_TYPES } from './parseStateMutation';
import { applyMutation, MUTATION_TYPES } from './applyMutation';
import type { StateMutation } from './aiTypes';
import type { StudioState } from './stateTypes';
import type { StudioWidget } from './widgetTypes';

const chartWidget = (id: string, title = 'W'): StudioWidget => ({
  id,
  kind: 'chart',
  title,
  config: { chartType: 'bar' },
});

// Two pages (page-1 holds w1), a seed filter, and one AI thread — enough shape for
// every variant's happy-path transition to be observable.
function baseState(activePageId = 'page-1'): StudioState {
  return createDefaultStudioState({
    doc: {
      dashboard: { id: 'd1', title: 'D', activePageId },
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [] },
      },
      widgets: { w1: chartWidget('w1') },
      filters: [
        {
          id: 'seed-f',
          field: 'x',
          operator: 'equals',
          value: 1,
          scope: { kind: 'page', pageId: 'page-1' },
        },
      ],
      ai: {
        activeThreadId: 't1',
        threads: [{ id: 't1', name: 'Old', createdAt: '2020-01-01T00:00:00.000Z', messages: [] }],
      },
    },
  });
}

// One valid payload per `StateMutation` variant, each with an assertion on the state
// `applyMutation` produces — so a valid payload the reducer actually needs can never
// be rejected by the parser.
const VALID_CASES: Array<{
  type: StateMutation['type'];
  mutation: StateMutation;
  assert: (next: StudioState) => void;
}> = [
  {
    type: 'addPage',
    mutation: { type: 'addPage', args: { id: 'page-3', title: 'New' } },
    assert: (next) => {
      expect(next.doc.pages['page-3']).toMatchObject({ id: 'page-3', title: 'New' });
      expect(next.doc.dashboard.activePageId).toBe('page-3');
    },
  },
  {
    type: 'setDashboardTitle',
    mutation: { type: 'setDashboardTitle', args: { title: 'X' } },
    assert: (next) => expect(next.doc.dashboard.title).toBe('X'),
  },
  {
    type: 'addWidget',
    mutation: { type: 'addWidget', args: { widget: chartWidget('w2'), pageId: 'page-2' } },
    assert: (next) => {
      expect(next.doc.widgets.w2).toBeDefined();
      expect(next.doc.pages['page-2'].widgetRows.flat()).toContain('w2');
    },
  },
  {
    type: 'updateWidget',
    mutation: { type: 'updateWidget', args: { widgetId: 'w1', changes: { title: 'Updated' } } },
    assert: (next) => expect(next.doc.widgets.w1.title).toBe('Updated'),
  },
  {
    type: 'removeWidget',
    mutation: { type: 'removeWidget', args: { widgetId: 'w1' } },
    assert: (next) => expect(next.doc.widgets.w1).toBeUndefined(),
  },
  {
    type: 'setWidgetLayout',
    mutation: { type: 'setWidgetLayout', args: { rows: [['w1']], pageId: 'page-1' } },
    assert: (next) => expect(next.doc.pages['page-1'].widgetRows).toEqual([['w1']]),
  },
  {
    type: 'setWidgetColSpan',
    mutation: {
      type: 'setWidgetColSpan',
      args: { widgetId: 'w1', columns: 6, rowWidgetIds: ['w1'], pageId: 'page-1' },
    },
    assert: (next) => expect(next.doc.pages['page-1'].widgetColSpans?.w1).toBe(6),
  },
  {
    type: 'renamePage',
    mutation: { type: 'renamePage', args: { pageId: 'page-1', title: 'Overview' } },
    assert: (next) => expect(next.doc.pages['page-1'].title).toBe('Overview'),
  },
  {
    type: 'removePage',
    mutation: { type: 'removePage', args: { pageId: 'page-2' } },
    assert: (next) => expect(next.doc.pages['page-2']).toBeUndefined(),
  },
  {
    type: 'setActivePage',
    mutation: { type: 'setActivePage', args: { pageId: 'page-2' } },
    assert: (next) => expect(next.doc.dashboard.activePageId).toBe('page-2'),
  },
  {
    type: 'addFilter',
    mutation: {
      type: 'addFilter',
      args: {
        filter: {
          id: 'f-new',
          field: 'rev',
          operator: 'greater_than',
          value: 100,
          scope: { kind: 'page', pageId: 'page-1' },
        },
      },
    },
    assert: (next) => expect(next.doc.filters.map((f) => f.id)).toContain('f-new'),
  },
  {
    // A compound filter with a valid `operator2` still passes — the T2-1 membership check
    // only rejects a PRESENT-and-INVALID `operator2`; a present-and-valid one is legal.
    type: 'addFilter',
    mutation: {
      type: 'addFilter',
      args: {
        filter: {
          id: 'f-compound',
          field: 'rev',
          operator: 'greater_than',
          value: 100,
          conjunction: 'and',
          operator2: 'less_than',
          value2: 500,
          scope: { kind: 'page', pageId: 'page-1' },
        },
      },
    },
    assert: (next) => expect(next.doc.filters.map((f) => f.id)).toContain('f-compound'),
  },
  {
    // A well-formed `dependsOn` (a string[]) is legal.
    type: 'addFilter',
    mutation: {
      type: 'addFilter',
      args: {
        filter: {
          id: 'f-depends',
          field: 'region',
          operator: 'equals',
          value: 'US',
          dependsOn: ['f-new'],
          scope: { kind: 'page', pageId: 'page-1' },
        },
      },
    },
    assert: (next) => expect(next.doc.filters.map((f) => f.id)).toContain('f-depends'),
  },
  {
    type: 'removeFilter',
    mutation: { type: 'removeFilter', args: { filterId: 'seed-f' } },
    assert: (next) => expect(next.doc.filters.map((f) => f.id)).not.toContain('seed-f'),
  },
  {
    type: 'applyBulkUpdate',
    mutation: {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: ['w1'],
        addedWidgets: [chartWidget('w-new', 'New')],
        updatedWidgets: [],
        widgetRows: [['w-new']],
        widgetColSpans: {},
        activePageId: 'page-1',
      },
    },
    assert: (next) => {
      expect(next.doc.widgets['w-new']).toBeDefined();
      expect(next.doc.widgets.w1).toBeUndefined();
      expect(next.doc.pages['page-1'].widgetRows).toEqual([['w-new']]);
    },
  },
  {
    type: 'renameAIThread',
    mutation: {
      type: 'renameAIThread',
      args: { name: 'New', updatedAt: '2024-01-01T00:00:00.000Z', threadId: 't1' },
    },
    assert: (next) => expect(next.doc.ai?.threads[0].name).toBe('New'),
  },
];

describe('parseStateMutation — valid payloads (one per variant)', () => {
  it.each(VALID_CASES)(
    '$type: accepts the round-tripped wire payload and it applies as expected',
    ({ mutation, assert }) => {
      // Round-trip through JSON to mimic a real SSE payload that was JSON.parse'd.
      const wire = JSON.parse(JSON.stringify(mutation)) as unknown;
      const parsed = parseStateMutation(wire);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      // Pure gate: returns the input value unchanged, not a clone.
      expect(parsed.mutation).toBe(wire);
      assert(applyMutation(baseState(), parsed.mutation));
    },
  );

  it('tolerates unknown extra keys inside args (forward compatibility)', () => {
    const parsed = parseStateMutation({
      type: 'addPage',
      args: { id: 'p9', title: 'T', someNewerServerField: 123 },
    });
    expect(parsed.ok).toBe(true);
  });

  it("accepts a valid 'auto'/'manual' titleMode/subtitleMode in updateWidget.changes (2.2)", () => {
    expect(
      parseStateMutation({
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { titleMode: 'auto', subtitleMode: 'manual' } },
      }).ok,
    ).toBe(true);
  });

  // Architecture review T2.1: valid values for the previously-unvalidated full-widget
  // scalar fields must still pass (no false-positive rejection introduced by the fix).
  it('accepts a valid full-widget titleMode/subtitleMode/subtitle/sourceId in addWidget (T2.1)', () => {
    expect(
      parseStateMutation({
        type: 'addWidget',
        args: {
          widget: {
            id: 'w',
            kind: 'chart',
            title: 'T',
            subtitle: 'Sub',
            sourceId: 'src-1',
            titleMode: 'auto',
            subtitleMode: 'manual',
            config: { chartType: 'bar' },
          },
        },
      }).ok,
    ).toBe(true);
  });
});

describe('parseStateMutation — table-sync pins', () => {
  it('the validator table covers exactly the reducer variant list', () => {
    expect(new Set(PARSEABLE_MUTATION_TYPES)).toEqual(new Set(MUTATION_TYPES));
    expect(PARSEABLE_MUTATION_TYPES).toHaveLength(MUTATION_TYPES.length);
  });

  it('the valid-payload suite exercises every variant', () => {
    expect(new Set(VALID_CASES.map((c) => c.type))).toEqual(new Set(MUTATION_TYPES));
  });
});

describe('parseStateMutation — malformed top-level shapes', () => {
  const cases: Array<{ label: string; value: unknown }> = [
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'number', value: 42 },
    { label: 'string', value: 'addPage' },
    { label: 'array', value: [] },
    { label: 'empty object (no type)', value: {} },
    { label: 'unknown type', value: { type: 'nope', args: {} } },
    // Prototype-chain type lookup must not resolve `constructor` to a real handler.
    { label: 'prototype-chain type', value: { type: 'constructor', args: {} } },
    { label: 'missing args', value: { type: 'addPage' } },
    { label: 'args not a plain object', value: { type: 'addPage', args: [] } },
  ];

  it.each(cases)('rejects $label with a descriptive error', ({ value }) => {
    const parsed = parseStateMutation(value);
    expect(parsed.ok).toBe(false);
    // Non-conditional access to the failure branch's `error` field.
    expect((parsed as { error?: string }).error).toEqual(expect.any(String));
  });
});

// A fully-valid applyBulkUpdate args bag, cloned then mutated per malformed case.
function validBulkArgs(): Record<string, unknown> {
  return {
    removedWidgetIds: ['w1'],
    addedWidgets: [chartWidget('w-new')],
    updatedWidgets: [{ widgetId: 'w1', title: 'T' }],
    widgetRows: [['w-new']],
    widgetColSpans: { 'w-new': 6 },
    activePageId: 'page-1',
  };
}

describe('parseStateMutation — malformed per-variant args', () => {
  const cases: Array<{ label: string; value: unknown }> = [
    {
      label: 'renamePage pageId is an object',
      value: { type: 'renamePage', args: { pageId: {}, title: 'T' } },
    },
    {
      label: 'addPage title is not a string',
      value: { type: 'addPage', args: { id: 'p', title: 42 } },
    },
    {
      label: 'setWidgetLayout rows is a string',
      value: { type: 'setWidgetLayout', args: { rows: 'x' } },
    },
    // Mixed-depth matrix: the bare 'b' is not a string[] and must not slip through.
    {
      label: 'setWidgetLayout rows is mixed-depth',
      value: { type: 'setWidgetLayout', args: { rows: [['a'], 'b'] } },
    },
    {
      label: 'applyBulkUpdate removedWidgetIds is a string',
      value: { type: 'applyBulkUpdate', args: { ...validBulkArgs(), removedWidgetIds: 'abc' } },
    },
    {
      label: 'applyBulkUpdate addedWidgets is not an array',
      value: { type: 'applyBulkUpdate', args: { ...validBulkArgs(), addedWidgets: {} } },
    },
    {
      label: 'applyBulkUpdate widgetColSpans is a string',
      value: { type: 'applyBulkUpdate', args: { ...validBulkArgs(), widgetColSpans: 'hi' } },
    },
    {
      label: 'applyBulkUpdate updatedWidgets entry missing widgetId',
      value: { type: 'applyBulkUpdate', args: { ...validBulkArgs(), updatedWidgets: [{}] } },
    },
    {
      label: 'addWidget widget missing kind',
      value: { type: 'addWidget', args: { widget: { id: 'w', title: 'T', config: {} } } },
    },
    {
      label: 'addWidget widget missing title',
      value: { type: 'addWidget', args: { widget: { id: 'w', kind: 'chart', config: {} } } },
    },
    {
      label: 'addWidget widget missing config',
      value: { type: 'addWidget', args: { widget: { id: 'w', kind: 'chart', title: 'T' } } },
    },
    {
      label: 'applyBulkUpdate addedWidgets entry missing config',
      value: {
        type: 'applyBulkUpdate',
        args: { ...validBulkArgs(), addedWidgets: [{ id: 'w', kind: 'chart', title: 'T' }] },
      },
    },
    {
      label: 'addFilter scope missing required widgetId',
      value: {
        type: 'addFilter',
        args: {
          filter: { id: 'f', field: 'x', operator: 'equals', value: 1, scope: { kind: 'widget' } },
        },
      },
    },
    {
      label: 'addFilter unknown scope kind',
      value: {
        type: 'addFilter',
        args: {
          filter: { id: 'f', field: 'x', operator: 'equals', value: 1, scope: { kind: 'galaxy' } },
        },
      },
    },
    // Schema review 1.2: `updateWidget.args.changes` is a wholesale widget merge that
    // was previously unvalidated beyond `isRecord` + unsafe-key check.
    {
      label: 'updateWidget changes carries an id (would desync widget from its map key)',
      value: { type: 'updateWidget', args: { widgetId: 'w1', changes: { id: 'w2' } } },
    },
    {
      label: 'updateWidget changes.title is a non-string',
      value: { type: 'updateWidget', args: { widgetId: 'w1', changes: { title: 42 } } },
    },
    {
      label: 'updateWidget changes.config is a non-record (string)',
      value: { type: 'updateWidget', args: { widgetId: 'w1', changes: { config: 'garbage' } } },
    },
    {
      label: 'updateWidget changes.kind is a non-string',
      value: { type: 'updateWidget', args: { widgetId: 'w1', changes: { kind: 7 } } },
    },
    {
      label: 'updateWidget changes.sourceId is a non-string',
      value: { type: 'updateWidget', args: { widgetId: 'w1', changes: { sourceId: {} } } },
    },
    // Schema review 2.2: `titleMode`/`subtitleMode` are the only other `StudioWidget`
    // fields a `changes` merge can carry and were previously unchecked — a junk value
    // must not reach a field the client's auto-title logic branches on.
    {
      label: 'updateWidget changes.titleMode is a non-string',
      value: { type: 'updateWidget', args: { widgetId: 'w1', changes: { titleMode: 42 } } },
    },
    {
      label: "updateWidget changes.titleMode is a string but not 'auto'/'manual'",
      value: { type: 'updateWidget', args: { widgetId: 'w1', changes: { titleMode: 'weird' } } },
    },
    {
      label: "updateWidget changes.subtitleMode is a string but not 'auto'/'manual'",
      value: {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { subtitleMode: 'nonsense' } },
      },
    },
    // Schema review 2.1: a `setWidgetColSpan.rowWidgetIds` entry becomes the sibling-
    // rebalance bracket-assignment target in the reducer, so a prototype-polluting id
    // must be rejected per-entry at the wire boundary.
    {
      label: 'setWidgetColSpan rowWidgetIds carries a __proto__ entry',
      value: {
        type: 'setWidgetColSpan',
        args: { widgetId: 'w1', columns: 6, rowWidgetIds: ['w1', '__proto__'] },
      },
    },
    // Architecture review T2.1: `addWidget.args.widget` (and, by extension,
    // `applyBulkUpdate.addedWidgets[]`) previously skipped the `titleMode`/
    // `subtitleMode`/`subtitle`/`sourceId` checks that `updateWidget.changes` already
    // enforced, so junk values on these fields sailed through the full-widget path.
    {
      label: 'addWidget widget.titleMode is a non-string',
      value: {
        type: 'addWidget',
        args: { widget: { id: 'w', kind: 'chart', title: 'T', config: {}, titleMode: 42 } },
      },
    },
    {
      label: "addWidget widget.titleMode is a string but not 'auto'/'manual'",
      value: {
        type: 'addWidget',
        args: { widget: { id: 'w', kind: 'chart', title: 'T', config: {}, titleMode: 'weird' } },
      },
    },
    {
      label: "addWidget widget.subtitleMode is a string but not 'auto'/'manual'",
      value: {
        type: 'addWidget',
        args: {
          widget: { id: 'w', kind: 'chart', title: 'T', config: {}, subtitleMode: 'nonsense' },
        },
      },
    },
    {
      label: 'addWidget widget.sourceId is a non-string',
      value: {
        type: 'addWidget',
        args: { widget: { id: 'w', kind: 'chart', title: 'T', config: {}, sourceId: 99 } },
      },
    },
    {
      label: 'addWidget widget.subtitle is a non-string',
      value: {
        type: 'addWidget',
        args: { widget: { id: 'w', kind: 'chart', title: 'T', config: {}, subtitle: 42 } },
      },
    },
    {
      label: 'applyBulkUpdate addedWidgets entry titleMode is junk',
      value: {
        type: 'applyBulkUpdate',
        args: {
          ...validBulkArgs(),
          addedWidgets: [{ id: 'w', kind: 'chart', title: 'T', config: {}, titleMode: 42 }],
        },
      },
    },
    {
      label: 'applyBulkUpdate addedWidgets entry sourceId is a non-string',
      value: {
        type: 'applyBulkUpdate',
        args: {
          ...validBulkArgs(),
          addedWidgets: [{ id: 'w', kind: 'chart', title: 'T', config: {}, sourceId: 99 }],
        },
      },
    },
    // Finding 3.1: the widget object's OWN top-level keys are screened for the
    // prototype-hazard denylist, symmetric with the `updateWidget.changes` path. An own
    // `__proto__` key (materialized by `JSON.parse`) on a full-widget create payload was
    // previously accepted and round-tripped; it is now rejected on both create channels.
    {
      label: 'addWidget widget carries an own __proto__ key',
      value: {
        type: 'addWidget',
        args: {
          widget: JSON.parse(
            '{"id":"w","kind":"chart","title":"T","config":{},"__proto__":{"x":1}}',
          ),
        },
      },
    },
    {
      label: 'applyBulkUpdate addedWidgets entry carries an own constructor key',
      value: {
        type: 'applyBulkUpdate',
        args: {
          ...validBulkArgs(),
          addedWidgets: [
            JSON.parse('{"id":"w","kind":"chart","title":"T","config":{},"constructor":1}'),
          ],
        },
      },
    },
    // Architecture review 2.2: `addFilter` previously validated only `id` + `scope`, so
    // a non-string `field`/`operator` installed an active-but-unevaluable filter that
    // silently rendered every widget in scope empty. Both are read downstream, so both
    // must be string-checked at the wire boundary.
    {
      label: 'addFilter filter.field is a non-string (number)',
      value: {
        type: 'addFilter',
        args: {
          filter: { id: 'f', field: 42, operator: 'equals', value: 1, scope: { kind: 'page' } },
        },
      },
    },
    {
      label: 'addFilter filter.field is missing',
      value: {
        type: 'addFilter',
        args: { filter: { id: 'f', operator: 'equals', value: 1, scope: { kind: 'page' } } },
      },
    },
    {
      label: 'addFilter filter.operator is a non-string (object)',
      value: {
        type: 'addFilter',
        args: {
          filter: { id: 'f', field: 'x', operator: {}, value: 1, scope: { kind: 'page' } },
        },
      },
    },
    {
      label: 'addFilter filter.operator is missing',
      value: {
        type: 'addFilter',
        args: { filter: { id: 'f', field: 'x', value: 1, scope: { kind: 'page' } } },
      },
    },
    // Architecture review T2-1: `filter.operator` is a closed 17-member union the client
    // evaluator branches on and FAILS OPEN for (`filterUtils.ts` `default: () => true`).
    // Before this fix `validateFilter` checked `operator` with `isString` only, so a
    // plausible-but-wrong typo like `'equal'` (not in the real union — the member is
    // `'equals'`) passed the wire boundary and installed a filter chip that renders as
    // ACTIVE while filtering nothing. It is now membership-checked and REJECTED, matching
    // the AI-tool boundary that already rejected the identical payload.
    {
      label: "addFilter filter.operator is a plausible-but-wrong typo ('equal', not in the union)",
      value: {
        type: 'addFilter',
        args: {
          filter: { id: 'f', field: 'x', operator: 'equal', value: 1, scope: { kind: 'page' } },
        },
      },
    },
    // A PRESENT-but-invalid `operator2` (a compound filter's second condition) carries the
    // identical fail-open hazard and is rejected the same way; an ABSENT `operator2` stays
    // legal (pinned in the valid-cases block).
    {
      label: "addFilter filter.operator2 is present but invalid ('equal')",
      value: {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f',
            field: 'x',
            operator: 'greater_than',
            value: 1,
            conjunction: 'and',
            operator2: 'equal',
            value2: 10,
            scope: { kind: 'page' },
          },
        },
      },
    },
    // Architecture review 2.2: the three UPDATE-shaped config-carrying channels
    // previously left `chartType` as part of the unchecked `config` leaf, so an
    // arbitrary/non-member value could persist through a patch (and wedge every
    // later legitimate AI `update_widget` on that widget). All three now run the
    // same membership check the create path already enforced.
    {
      label: 'updateWidget config.chartType is not a known chart type',
      value: {
        type: 'updateWidget',
        args: { widgetId: 'w1', config: { chartType: 'trendline' } },
      },
    },
    {
      label: 'updateWidget config.chartType is a non-string',
      value: {
        type: 'updateWidget',
        args: { widgetId: 'w1', config: { chartType: 42 } },
      },
    },
    {
      label: 'updateWidget changes.config.chartType is not a known chart type',
      value: {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { config: { chartType: 'trendline' } } },
      },
    },
    {
      label: 'updateWidget changes.config.chartType is a non-string',
      value: {
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { config: { chartType: {} } } },
      },
    },
    {
      label: 'applyBulkUpdate updatedWidgets[].config.chartType is not a known chart type',
      value: {
        type: 'applyBulkUpdate',
        args: {
          ...validBulkArgs(),
          updatedWidgets: [{ widgetId: 'w1', config: { chartType: 'trendline' } }],
        },
      },
    },
    {
      label: 'applyBulkUpdate updatedWidgets[].config.chartType is a non-string',
      value: {
        type: 'applyBulkUpdate',
        args: {
          ...validBulkArgs(),
          updatedWidgets: [{ widgetId: 'w1', config: { chartType: 42 } }],
        },
      },
    },
    // Iteration-20 finding: `validateFilter` never checked `dependsOn` at all, so any
    // shape passed — a non-array, or an array with non-string elements. The x-studio-side
    // consumer (`docTransforms.ts`) does unguarded `.filter()`/`.map()` over `dependsOn`,
    // so a malformed value reaching it would throw; this closes the wire-boundary gap.
    {
      label: 'addFilter filter.dependsOn is a non-array (string)',
      value: {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f',
            field: 'x',
            operator: 'equals',
            value: 1,
            dependsOn: 'other-filter',
            scope: { kind: 'page' },
          },
        },
      },
    },
    {
      label: 'addFilter filter.dependsOn is an array with a non-string element',
      value: {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f',
            field: 'x',
            operator: 'equals',
            value: 1,
            dependsOn: ['other-filter', 42],
            scope: { kind: 'page' },
          },
        },
      },
    },
    // Finding 1 (iteration-27): the `page` scope kind's `pageId` is OPTIONAL, so
    // `FILTER_SCOPE_REQUIRED_IDS` lists no required id fields for it and a numeric
    // `pageId` was never type-checked anywhere (wire, reducer, or load) — the reducer's/
    // load boundary's `Object.hasOwn(state.pages, scope.pageId)` orphan checks coerce a
    // numeric `pageId` to match a string page key, letting it install/round-trip
    // indefinitely. `validateFilterScope` now checks it with `isOptionalString` too.
    {
      label: 'addFilter scope.pageId is a non-string (number) for a page scope',
      value: {
        type: 'addFilter',
        args: {
          filter: {
            id: 'f',
            field: 'x',
            operator: 'equals',
            value: 1,
            scope: { kind: 'page', pageId: 42 },
          },
        },
      },
    },
    // Finding 2 (iteration-27): the widget ADD channels (`addWidget`/
    // `applyBulkUpdate.addedWidgets`) already screen `kind`/`title` are strings via
    // `validateWidget` — pinning that a numeric value is rejected here too (not just
    // silently dropped a load later by `deserializeState`'s widget screen).
    {
      label: 'addWidget widget.kind is a non-string (number)',
      value: {
        type: 'addWidget',
        args: { widget: { id: 'w', kind: 42, title: 'T', config: {} } },
      },
    },
    {
      label: 'addWidget widget.title is a non-string (number)',
      value: {
        type: 'addWidget',
        args: { widget: { id: 'w', kind: 'chart', title: 42, config: {} } },
      },
    },
    {
      label: 'applyBulkUpdate addedWidgets entry has a non-string (number) kind',
      value: {
        type: 'applyBulkUpdate',
        args: {
          ...validBulkArgs(),
          addedWidgets: [{ id: 'w', kind: 42, title: 'T', config: {} }],
        },
      },
    },
    {
      label: 'applyBulkUpdate addedWidgets entry has a non-string (number) title',
      value: {
        type: 'applyBulkUpdate',
        args: {
          ...validBulkArgs(),
          addedWidgets: [{ id: 'w', kind: 'chart', title: 42, config: {} }],
        },
      },
    },
  ];

  it.each(cases)('rejects $label', ({ value }) => {
    expect(parseStateMutation(value).ok).toBe(false);
  });
});

describe('parseStateMutation — per-kind config-key validation (fail-closed)', () => {
  it('rejects an addWidget whose config carries a cross-kind key', () => {
    // `chartType` is a chart-only key; on a grid widget it must be rejected.
    const result = parseStateMutation({
      type: 'addWidget',
      args: { widget: { id: 'w', kind: 'grid', title: 'T', config: { chartType: 'bar' } } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected parseStateMutation to reject a cross-kind config key');
    }
    expect(result.error).toContain('chartType');
    expect(result.error).toContain('grid');
  });

  it('rejects an applyBulkUpdate whose addedWidget config carries a cross-kind key', () => {
    const result = parseStateMutation({
      type: 'applyBulkUpdate',
      args: {
        ...validBulkArgs(),
        addedWidgets: [{ id: 'w', kind: 'kpi', title: 'T', config: { columns: [] } }],
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an addWidget chart whose explicit chartType conflicts with a cross-family key', () => {
    // `sankeyTargetField` is a sankey-only key; on a gauge chart it must be rejected.
    const result = parseStateMutation({
      type: 'addWidget',
      args: {
        widget: {
          id: 'w',
          kind: 'chart',
          title: 'T',
          config: { chartType: 'gauge', sankeyTargetField: 'to' },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected parseStateMutation to reject a cross-family chart config key');
    }
    expect(result.error).toContain('sankeyTargetField');
    expect(result.error).toContain('gauge');
  });

  it('rejects an addWidget chart whose explicit chartType is not a known chart type', () => {
    const result = parseStateMutation({
      type: 'addWidget',
      args: {
        widget: { id: 'w', kind: 'chart', title: 'T', config: { chartType: 'nope' } },
      },
    });
    expect(result.ok).toBe(false);
  });

  it('accepts an addWidget chart with an explicit chartType and only its own family keys', () => {
    expect(
      parseStateMutation({
        type: 'addWidget',
        args: {
          widget: {
            id: 'w',
            kind: 'chart',
            title: 'T',
            config: { chartType: 'gauge', gaugeMin: 0, gaugeMax: 100, yField: 'v' },
          },
        },
      }).ok,
    ).toBe(true);
  });

  it('accepts an addWidget chart with NO chartType and only bar-family keys (2.3: omitted chartType resolves to the bar fallback)', () => {
    // `xField`/`barLayout` are valid BAR-family keys, and an omitted `chartType` on
    // a fresh create-path config resolves to the same 'bar' fallback the middleware
    // applies (`resolveChartType`'s `?? 'bar'`), so this must still pass.
    expect(
      parseStateMutation({
        type: 'addWidget',
        args: {
          widget: {
            id: 'w',
            kind: 'chart',
            title: 'T',
            config: { xField: 'a', barLayout: 'grouped' },
          },
        },
      }).ok,
    ).toBe(true);
  });

  // Finding 2.3: `validateWidget` previously skipped the chart-family-key check
  // entirely whenever `chartType` was absent, treating a create-path widget as
  // unvalidatable in that case. But a create-path config with no `chartType` IS
  // effectively a bar chart (the same `?? 'bar'` fallback `resolveChartType`/the
  // middleware's `invalidChartConfigKeyError` apply), so a bar-incompatible key
  // like `sankeyTargetField` must now be rejected even with no explicit `chartType`
  // — exactly as the semantically identical `{ chartType: 'bar', sankeyTargetField
  // }` already was.
  it('rejects an addWidget chart with NO chartType but a cross-family key (2.3: resolves to the bar fallback)', () => {
    const result = parseStateMutation({
      type: 'addWidget',
      args: {
        widget: {
          id: 'w',
          kind: 'chart',
          title: 'T',
          config: { sankeyTargetField: 'to' },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error(
        'expected parseStateMutation to reject a bar-incompatible key with no chartType',
      );
    }
    expect(result.error).toContain('sankeyTargetField');
    expect(result.error).toContain('bar');
  });

  // Same fallback, exercised via the applyBulkUpdate.addedWidgets sibling path.
  it('rejects an applyBulkUpdate addedWidgets entry with NO chartType but a cross-family key (2.3)', () => {
    const result = parseStateMutation({
      type: 'applyBulkUpdate',
      args: {
        ...validBulkArgs(),
        addedWidgets: [{ id: 'w', kind: 'chart', title: 'T', config: { sankeyTargetField: 'to' } }],
      },
    });
    expect(result.ok).toBe(false);
  });

  it('accepts an addWidget with a valid per-kind config', () => {
    expect(
      parseStateMutation({
        type: 'addWidget',
        args: { widget: { id: 'w', kind: 'grid', title: 'T', config: { gridHeight: 300 } } },
      }).ok,
    ).toBe(true);
  });

  it('accepts a custom-kind widget carrying arbitrary config keys (no restriction)', () => {
    expect(
      parseStateMutation({
        type: 'addWidget',
        args: {
          widget: {
            id: 'w',
            kind: 'acme-weather',
            title: 'T',
            config: { anything: 1, foo: 'bar' },
          },
        },
      }).ok,
    ).toBe(true);
  });

  it('accepts an addWidget chart whose config.ySeries carries a null entry (config interior is a leaf) (1.1)', () => {
    // The parser deliberately does NOT deep-validate the config interior, so a
    // `ySeries: [null]` passes the wire gate. The reducer's series normalization must
    // therefore be total over such junk (see `normalizeChartSeries`) rather than throw.
    expect(
      parseStateMutation({
        type: 'addWidget',
        args: {
          widget: {
            id: 'w',
            kind: 'chart',
            title: 'T',
            config: { chartType: 'mixed', ySeries: [null] },
          },
        },
      }).ok,
    ).toBe(true);
  });

  // Finding 2.2: a present-and-valid `chartType` on an update-shaped config
  // channel must still be accepted — only membership is being newly enforced.
  it('accepts an updateWidget config.chartType that is a known chart type', () => {
    expect(
      parseStateMutation({
        type: 'updateWidget',
        args: { widgetId: 'w1', config: { chartType: 'gauge' } },
      }).ok,
    ).toBe(true);
  });

  it('accepts an updateWidget changes.config.chartType that is a known chart type', () => {
    expect(
      parseStateMutation({
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { config: { chartType: 'line' } } },
      }).ok,
    ).toBe(true);
  });

  it('accepts an applyBulkUpdate updatedWidgets[].config.chartType that is a known chart type', () => {
    expect(
      parseStateMutation({
        type: 'applyBulkUpdate',
        args: {
          ...validBulkArgs(),
          updatedWidgets: [{ widgetId: 'w1', config: { chartType: 'pie' } }],
        },
      }).ok,
    ).toBe(true);
  });

  // `chartType: undefined` is the sanctioned patch-delete of the key (clearing a
  // previously-set chart type back to the widget's stored/default value) and must
  // stay legal on every update-shaped config channel even after the 2.2 fix.
  it('accepts an updateWidget config.chartType of undefined (sanctioned patch-delete)', () => {
    expect(
      parseStateMutation({
        type: 'updateWidget',
        args: { widgetId: 'w1', config: { chartType: undefined, xField: 'a' } },
      }).ok,
    ).toBe(true);
  });

  it('accepts an updateWidget changes.config.chartType of undefined (sanctioned patch-delete)', () => {
    expect(
      parseStateMutation({
        type: 'updateWidget',
        args: { widgetId: 'w1', changes: { config: { chartType: undefined } } },
      }).ok,
    ).toBe(true);
  });

  it('accepts an applyBulkUpdate updatedWidgets[].config.chartType of undefined (sanctioned patch-delete)', () => {
    expect(
      parseStateMutation({
        type: 'applyBulkUpdate',
        args: {
          ...validBulkArgs(),
          updatedWidgets: [{ widgetId: 'w1', config: { chartType: undefined } }],
        },
      }).ok,
    ).toBe(true);
  });
});

describe('parseStateMutation — id hygiene (prototype-injection defense)', () => {
  const unsafeIds = ['__proto__', 'constructor', 'prototype'];

  it.each(unsafeIds)('rejects an addWidget widget with id "%s"', (id) => {
    const parsed = parseStateMutation({
      type: 'addWidget',
      args: { widget: { id, kind: 'chart', title: 'T', config: {} } },
    });
    expect(parsed.ok).toBe(false);
  });

  it.each(unsafeIds)('rejects an applyBulkUpdate addedWidgets entry with id "%s"', (id) => {
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...validBulkArgs(), addedWidgets: [{ id, kind: 'chart', title: 'T', config: {} }] },
    });
    expect(parsed.ok).toBe(false);
  });

  // 1.2: the reducer rebuilds config/changes/widgetColSpans key-by-key, so a payload
  // carrying an unsafe key as an OWN property (JSON.parse, not an object literal) is
  // rejected at the wire boundary.
  it('rejects an updateWidget whose config carries an own __proto__ key', () => {
    const parsed = parseStateMutation({
      type: 'updateWidget',
      args: { widgetId: 'w1', config: JSON.parse('{"__proto__":{"polluted":true}}') },
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects an updateWidget whose changes carries an own __proto__ key', () => {
    const parsed = parseStateMutation({
      type: 'updateWidget',
      args: { widgetId: 'w1', changes: JSON.parse('{"__proto__":{"polluted":true}}') },
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects an applyBulkUpdate whose widgetColSpans carries an own __proto__ key', () => {
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...validBulkArgs(), widgetColSpans: JSON.parse('{"__proto__":6}') },
    });
    expect(parsed.ok).toBe(false);
  });

  // Architecture review T3.1: for a KNOWN kind, an own `__proto__` config key was
  // already incidentally rejected by the per-kind config-key allow-list (it flags
  // `__proto__` as a stray key). For a CUSTOM kind the allow-list returns "anything
  // goes", so before the fix an own `__proto__` config key sailed through. Now
  // `hasUnsafeOwnKeys` runs on every full-widget config regardless of kind.
  it('rejects an addWidget custom-kind widget whose config carries an own __proto__ key', () => {
    const parsed = parseStateMutation(
      JSON.parse(
        '{"type":"addWidget","args":{"widget":{"id":"w2","kind":"acme-x","title":"T","config":{"__proto__":{"polluted":true}}}}}',
      ),
    );
    expect(parsed.ok).toBe(false);
  });

  it('rejects an applyBulkUpdate custom-kind addedWidgets entry whose config carries an own __proto__ key', () => {
    const pollutedWidget = JSON.parse(
      '{"id":"w2","kind":"acme-x","title":"T","config":{"__proto__":{"polluted":true}}}',
    );
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...validBulkArgs(), addedWidgets: [pollutedWidget] },
    });
    expect(parsed.ok).toBe(false);
  });

  // T2-2: `validateFilter` now screens the filter object's OWN top-level keys, closing
  // the parity gap with `validateWidget`. An own `__proto__`/`constructor`/`prototype`
  // key (materialized by `JSON.parse`, not the inherited accessor) would otherwise be
  // appended verbatim by the reducer and round-trip through `serializeDoc`.
  it.each(unsafeIds)('rejects an addFilter whose filter carries an own "%s" key', (key) => {
    const parsed = parseStateMutation(
      JSON.parse(
        `{"type":"addFilter","args":{"filter":{"id":"f","field":"x","operator":"equals","value":1,"scope":{"kind":"page"},"${key}":{"polluted":true}}}}`,
      ),
    );
    expect(parsed.ok).toBe(false);
  });

  // Tier2 finding: `filter.scope` was the one nested record never screened for the
  // prototype-hazard denylist — `validateFilterScope` only checked `kind` and the
  // per-kind required id fields, unlike every other embedded record (the filter itself,
  // just above; a widget; a widget's config). An own `__proto__`/`constructor`/
  // `prototype` key (materialized by `JSON.parse`, not the inherited accessor) on
  // `scope` would otherwise install verbatim via `addFilter`'s reducer handler.
  it.each(unsafeIds)('rejects an addFilter whose filter.scope carries an own "%s" key', (key) => {
    const parsed = parseStateMutation(
      JSON.parse(
        `{"type":"addFilter","args":{"filter":{"id":"f","field":"x","operator":"equals","value":1,"scope":{"kind":"page","${key}":{"polluted":true}}}}}`,
      ),
    );
    expect(parsed.ok).toBe(false);
  });

  it('running every valid payload through parse + applyMutation never pollutes Object.prototype', () => {
    for (const { mutation } of VALID_CASES) {
      const wire = JSON.parse(JSON.stringify(mutation)) as unknown;
      const parsed = parseStateMutation(wire);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        applyMutation(baseState(), parsed.mutation);
      }
    }
    // Nothing on the accepted path may have reached into the prototype chain.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// Tier2 finding: this file validated SHAPE only, with no cap on array length or
// string length, despite being (per this file's own module doc) "the ONE place a
// value CLAIMING to be a `StateMutation` is checked" from outside the process. A
// payload with a well-formed-but-enormous collection previously passed every check
// below unmodified.
describe('parseStateMutation — wire trust-boundary size caps (Tier2)', () => {
  it('rejects a removedWidgetIds array over the length cap', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `w${i}`);
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...validBulkArgs(), removedWidgetIds: tooMany },
    });
    expect(parsed.ok).toBe(false);
  });

  it('accepts a removedWidgetIds array right at the length cap', () => {
    const exactlyMax = Array.from({ length: 500 }, (_, i) => `w${i}`);
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...validBulkArgs(), removedWidgetIds: exactlyMax },
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects a removedWidgetIds entry over the string-length cap', () => {
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...validBulkArgs(), removedWidgetIds: ['w1'.repeat(6000)] },
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects an addedWidgets array over the length cap', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => chartWidget(`w${i}`));
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...validBulkArgs(), addedWidgets: tooMany },
    });
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('addedWidgets') });
  });

  it('rejects an updatedWidgets array over the length cap', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ widgetId: `w${i}`, title: 'T' }));
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...validBulkArgs(), updatedWidgets: tooMany },
    });
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('updatedWidgets') });
  });

  it('rejects a widgetRows layout matrix over the row-count cap', () => {
    const tooManyRows = Array.from({ length: 501 }, (_, i) => [`w${i}`]);
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...validBulkArgs(), widgetRows: tooManyRows },
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a setWidgetLayout rows matrix whose row has too many entries', () => {
    const hugeRow = Array.from({ length: 501 }, (_, i) => `w${i}`);
    const parsed = parseStateMutation({
      type: 'setWidgetLayout',
      args: { rows: [hugeRow] },
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a widgetColSpans record over the key-count cap', () => {
    const tooManySpans: Record<string, number> = {};
    for (let i = 0; i < 501; i += 1) {
      tooManySpans[`w${i}`] = 6;
    }
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...validBulkArgs(), widgetColSpans: tooManySpans },
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects an addWidget title over the string-length cap', () => {
    const parsed = parseStateMutation({
      type: 'addWidget',
      args: { widget: chartWidget('w1', 'x'.repeat(10_001)) },
    });
    expect(parsed.ok).toBe(false);
  });

  it('accepts an addWidget title right at the string-length cap', () => {
    const parsed = parseStateMutation({
      type: 'addWidget',
      args: { widget: chartWidget('w1', 'x'.repeat(10_000)) },
    });
    expect(parsed.ok).toBe(true);
  });
});

// T2-4 (parser half): `applyBulkUpdate.args.widgetRows`/`widgetColSpans` used to be
// required, forcing an updates-only bulk call (no removals/additions/layout op/
// colSpans) to carry a full turn-start layout snapshot that could silently revert a
// concurrent client-side layout edit. The reducer's fix (a parallel unit, in
// `applyMutation.ts`) treats "both absent" as "skip layout replacement, don't wipe" —
// this parser half's job is only to let that true absence reach the reducer
// unmodified, not to default it to `[]`/`{}` (which would be indistinguishable from
// "replace the layout with nothing").
describe('parseStateMutation — applyBulkUpdate widgetRows/widgetColSpans optionality (T2-4)', () => {
  function bulkArgsWithout(omit: Array<'widgetRows' | 'widgetColSpans'>): Record<string, unknown> {
    const args: Record<string, unknown> = {
      removedWidgetIds: [],
      addedWidgets: [],
      updatedWidgets: [{ widgetId: 'w1', title: 'Retitled' }],
      widgetRows: [['w1']],
      widgetColSpans: { w1: 6 },
      activePageId: 'page-1',
    };
    for (const key of omit) {
      delete args[key];
    }
    return args;
  }

  it('accepts an updates-only applyBulkUpdate with BOTH widgetRows and widgetColSpans absent', () => {
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: bulkArgsWithout(['widgetRows', 'widgetColSpans']),
    });
    expect(parsed.ok).toBe(true);
  });

  it('type-checks an updates-only bulk with NO layout fields against the wire StateMutation type (3.3)', () => {
    // Compile-time proof that the `applyBulkUpdate` wire type declares
    // `widgetRows`/`widgetColSpans` as OPTIONAL: a typed producer can express the
    // sanctioned updates-only bulk WITHOUT a cast. Were the fields required again, this
    // literal — typed as the shared `StateMutation` union — would be a type error, so the
    // package's `typescript` check would fail. It also round-trips through the runtime
    // validator, which already treats their absence as valid.
    const mutation: StateMutation = {
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        addedWidgets: [],
        updatedWidgets: [{ widgetId: 'w1', title: 'Retitled' }],
        activePageId: 'page-1',
      },
    };
    const parsed = parseStateMutation(mutation);
    expect(parsed.ok).toBe(true);
  });

  it('passes true absence through unchanged — does not default widgetRows/widgetColSpans to []/{}', () => {
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: bulkArgsWithout(['widgetRows', 'widgetColSpans']),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const { args } = parsed.mutation as unknown as {
      args: Record<string, unknown>;
    };
    // Own-key absence, not merely a falsy/empty value: a `?? []`/`?? {}` default
    // would still be an OWN key, which the reducer could not tell apart from "the
    // producer explicitly wants an empty layout".
    expect(Object.hasOwn(args, 'widgetRows')).toBe(false);
    expect(Object.hasOwn(args, 'widgetColSpans')).toBe(false);
  });

  it('accepts widgetRows present with widgetColSpans absent (independent optionality)', () => {
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: bulkArgsWithout(['widgetColSpans']),
    });
    expect(parsed.ok).toBe(true);
  });

  it('accepts widgetColSpans present with widgetRows absent (independent optionality)', () => {
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: bulkArgsWithout(['widgetRows']),
    });
    expect(parsed.ok).toBe(true);
  });

  it('still rejects a present-but-malformed widgetRows even when widgetColSpans is absent', () => {
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...bulkArgsWithout(['widgetColSpans']), widgetRows: 'not-a-matrix' },
    });
    expect(parsed.ok).toBe(false);
  });

  it('still rejects a present-but-malformed widgetColSpans even when widgetRows is absent', () => {
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: { ...bulkArgsWithout(['widgetRows']), widgetColSpans: 'not-a-record' },
    });
    expect(parsed.ok).toBe(false);
  });

  it('still rejects a present widgetColSpans carrying an own __proto__ key when widgetRows is absent', () => {
    const parsed = parseStateMutation({
      type: 'applyBulkUpdate',
      args: {
        ...bulkArgsWithout(['widgetRows']),
        widgetColSpans: JSON.parse('{"__proto__":6}'),
      },
    });
    expect(parsed.ok).toBe(false);
  });

  // NOTE: this suite intentionally does NOT assert `applyMutation` behavior on an
  // absent-layout payload — that half of T2-4 (treating "both absent" as "skip
  // layout replacement, don't wipe" rather than throwing) is owned by a parallel
  // fix to `applyMutation.ts`'s `applyBulkUpdate` handler, not this parser. This
  // suite's job ends at proving the parser ACCEPTS the payload and forwards true
  // absence unchanged (see the two tests above).
});

// ─── M2: depth/breadth bounds on the deliberately-unvalidated leaves ─────────
// The wire caps were BREADTH-only and were applied only to fields routed through the
// shared leaf predicates. `widget.config` and `filter.value` are deliberately
// uninterpreted leaves, and `hasUnsafeOwnKeys` only inspects TOP-LEVEL keys, so a ~20 KB
// deeply-nested payload passed every check, installed into the doc, and then made the
// host's autosave `JSON.stringify(serializeState(state))` throw `RangeError: Maximum call
// stack size exceeded` — every save failing for the rest of the session while the
// dashboard still looked fine — and `migrateState`'s `structuredClone` fail closed on the
// next schema bump, making the doc unloadable.
describe('parseStateMutation leaf boundedness (M2)', () => {
  // ~10k levels of nesting in a few KB of JSON — well past `JSON.stringify`'s recursion
  // limit, well under every existing length cap.
  function deeplyNested(levels = 10_000): unknown {
    let value: unknown = 1;
    for (let i = 0; i < levels; i += 1) {
      value = [value];
    }
    return value;
  }
  const shallow = { chartType: 'bar' as const };

  it('rejects an addWidget whose config carries a deeply-nested value', () => {
    const result = parseStateMutation({
      type: 'addWidget',
      args: {
        widget: {
          id: 'w-deep',
          kind: 'chart',
          title: 'W',
          config: { chartType: 'bar', customConfig: deeplyNested() },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/addWidget\.args\.widget\.config/);
      expect(result.error).toMatch(/bounded, dashboard-sized value/);
    }
  });

  it.each([
    ['updateWidget.args.config', { widgetId: 'w1', config: { customConfig: deeplyNested() } }],
    [
      'updateWidget.args.changes.config',
      { widgetId: 'w1', changes: { config: { customConfig: deeplyNested() } } },
    ],
  ])('rejects a deeply-nested %s', (path, args) => {
    const result = parseStateMutation({ type: 'updateWidget', args });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(path);
    }
  });

  it('rejects a deeply-nested applyBulkUpdate.updatedWidgets[].config', () => {
    const result = parseStateMutation({
      type: 'applyBulkUpdate',
      args: {
        removedWidgetIds: [],
        addedWidgets: [],
        updatedWidgets: [{ widgetId: 'w1', config: { customConfig: deeplyNested() } }],
        activePageId: 'page-1',
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/updatedWidgets\[0\]\.config/);
    }
  });

  it.each(['value', 'value2'] as const)(
    'rejects an addFilter whose %s is deeply nested',
    (field) => {
      const result = parseStateMutation({
        type: 'addFilter',
        args: {
          filter: {
            id: 'f1',
            field: 'x',
            operator: 'equals',
            value: field === 'value' ? deeplyNested() : 1,
            ...(field === 'value2' ? { operator2: 'equals', value2: deeplyNested() } : {}),
            scope: { kind: 'page' },
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(new RegExp(`addFilter\\.args\\.filter\\.${field}`));
      }
    },
  );

  it('rejects a config record with an unbounded number of own keys', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 5_000; i += 1) {
      wide[`k${i}`] = i;
    }
    const result = parseStateMutation({
      type: 'updateWidget',
      args: { widgetId: 'w1', config: { customConfig: wide } },
    });
    expect(result.ok).toBe(false);
  });

  it('still accepts ordinary, dashboard-sized configs and filter values', () => {
    expect(
      parseStateMutation({
        type: 'addWidget',
        args: { widget: { id: 'w1', kind: 'chart', title: 'W', config: shallow } },
      }).ok,
    ).toBe(true);
    expect(
      parseStateMutation({
        type: 'addFilter',
        args: {
          filter: {
            id: 'f1',
            field: 'x',
            operator: 'in',
            // A realistic multi-select selection payload, comfortably inside every cap.
            value: ['a', 'b', 'c'],
            scope: { kind: 'page', pageId: 'page-1' },
          },
        },
      }).ok,
    ).toBe(true);
    // Nesting well within `MAX_DEPTH` (e.g. a chart's `ySeries[].format`) is fine.
    expect(
      parseStateMutation({
        type: 'updateWidget',
        args: { widgetId: 'w1', config: { ySeries: [{ fieldId: 'a', format: { style: 'x' } }] } },
      }).ok,
    ).toBe(true);
  });
});
