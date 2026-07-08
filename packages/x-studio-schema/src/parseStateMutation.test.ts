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

  it('accepts an addWidget chart with NO chartType (omitted discriminant is left to the stateful path)', () => {
    // A chart config with an omitted chartType cannot be family-validated statelessly
    // (no access to the existing widget), so the chart-family check is skipped here.
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
