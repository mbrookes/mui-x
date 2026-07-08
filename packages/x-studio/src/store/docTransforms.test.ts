import { describe, expect, it } from 'vitest';
import { createDefaultStudioState } from '../models';
import type { StudioDoc, StudioFilterPreset, StudioFilterState } from '../models';
import * as docTransforms from './docTransforms';

function makeDoc(overrides?: Partial<StudioDoc>): StudioDoc {
  return createDefaultStudioState({ doc: overrides }).doc;
}

function pageFilter(id: string, pageId?: string): StudioFilterState {
  return {
    id,
    field: 'value',
    operator: 'equals',
    value: 'x',
    scope: pageId ? { kind: 'page', pageId } : { kind: 'page' },
  } as StudioFilterState;
}

describe('docTransforms.buildDateRangeFilter', () => {
  it('returns null for a custom preset with no boundaries', () => {
    expect(
      docTransforms.buildDateRangeFilter({
        id: 'd',
        field: 'date',
        fieldType: 'date',
        sourceId: 's',
        preset: 'custom',
        scope: { kind: 'widget', widgetId: 'w1' },
      }),
    ).toBe(null);
  });

  it('carries explicit boundaries for a custom preset', () => {
    const f = docTransforms.buildDateRangeFilter({
      id: 'd',
      field: 'date',
      fieldType: 'date',
      sourceId: 's',
      preset: 'custom',
      scope: { kind: 'widget', widgetId: 'w1' },
      customFrom: '2024-01-01',
      customTo: '2024-02-01',
    });
    expect(f).toMatchObject({
      value: { from: '2024-01-01', to: '2024-02-01' },
      operator: 'between',
    });
  });

  it('stores null value for a non-custom preset', () => {
    const f = docTransforms.buildDateRangeFilter({
      id: 'd',
      field: 'date',
      fieldType: 'date',
      sourceId: 's',
      preset: 'this_month',
      scope: { kind: 'widget', widgetId: 'w1' },
    });
    expect(f).toMatchObject({ value: null, dateRangePreset: 'this_month' });
  });
});

describe('docTransforms.setDashboardDateRange', () => {
  it('adds a dashboard-date-range filter for the page', () => {
    const doc = makeDoc();
    const next = docTransforms.setDashboardDateRange(
      doc,
      'page-1',
      'orderDate',
      'sales',
      'date',
      'last_3_months',
    );
    const added = next.filters.find(
      (f) => f.scope.kind === 'dashboard-date-range' && f.scope.pageId === 'page-1',
    );
    expect(added).toBeTruthy();
    expect(added!.id).toBe('dashboard-date-range-page-1');
    // Unchanged fields keep their references.
    expect(next.pages).toBe(doc.pages);
    expect(next.dashboard).toBe(doc.dashboard);
  });

  it('replaces the existing dashboard-date-range filter for the page', () => {
    const existing: StudioFilterState = {
      id: 'dashboard-date-range-page-1',
      field: 'old',
      operator: 'between',
      value: null,
      scope: { kind: 'dashboard-date-range', sourceId: 'sales', pageId: 'page-1' },
    } as StudioFilterState;
    const doc = makeDoc({ filters: [existing] });
    const next = docTransforms.setDashboardDateRange(
      doc,
      'page-1',
      'orderDate',
      'sales',
      'date',
      'last_3_months',
    );
    const matches = next.filters.filter((f) => f.scope.kind === 'dashboard-date-range');
    expect(matches).toHaveLength(1);
    expect(matches[0].field).toBe('orderDate');
  });

  it('clears the filter when preset is null', () => {
    const existing: StudioFilterState = {
      id: 'dashboard-date-range-page-1',
      field: 'old',
      operator: 'between',
      value: null,
      scope: { kind: 'dashboard-date-range', sourceId: 'sales', pageId: 'page-1' },
    } as StudioFilterState;
    const doc = makeDoc({ filters: [existing] });
    const next = docTransforms.setDashboardDateRange(doc, 'page-1', null, null, null, null);
    expect(next.filters.filter((f) => f.scope.kind === 'dashboard-date-range')).toHaveLength(0);
  });
});

describe('docTransforms.setDashboardDateRangeAll', () => {
  it('creates one filter per source', () => {
    const doc = makeDoc();
    const next = docTransforms.setDashboardDateRangeAll(
      doc,
      'page-1',
      [
        { fieldId: 'd1', sourceId: 's1', fieldType: 'date' },
        { fieldId: 'd2', sourceId: 's2', fieldType: 'datetime' },
      ],
      'last_3_months',
    );
    const added = next.filters.filter((f) => f.scope.kind === 'dashboard-date-range');
    expect(added).toHaveLength(2);
    expect(added.map((f) => f.id).sort()).toEqual([
      'dashboard-date-range-page-1-s1',
      'dashboard-date-range-page-1-s2',
    ]);
  });
});

describe('docTransforms.setWidgetDateRange', () => {
  it('adds and replaces a widget-scoped date-range filter', () => {
    const doc = makeDoc();
    const next = docTransforms.setWidgetDateRange(doc, 'w1', 'd', 's', 'date', 'this_month');
    const f = next.filters.find((x) => x.id === 'widget-date-range-w1');
    expect(f).toBeTruthy();
    expect(f!.scope).toEqual({ kind: 'widget', widgetId: 'w1' });

    const cleared = docTransforms.setWidgetDateRange(next, 'w1', null, null, null, null);
    expect(cleared.filters.find((x) => x.id === 'widget-date-range-w1')).toBeUndefined();
  });
});

describe('docTransforms preset family', () => {
  it('saveFilterPreset snapshots active-page filters under the given id', () => {
    const doc = makeDoc({ filters: [pageFilter('f1', 'page-1'), pageFilter('f2', 'page-2')] });
    const next = docTransforms.saveFilterPreset(doc, 'preset-1', 'My preset');
    const preset = next.filterPresets!.find((p) => p.id === 'preset-1');
    expect(preset).toBeTruthy();
    // Only the active page's filter is captured.
    expect(preset!.filters.map((f) => f.id)).toEqual(['preset-1-f1']);
  });

  it('applyFilterPreset returns the same doc reference for an unknown preset', () => {
    const doc = makeDoc();
    expect(docTransforms.applyFilterPreset(doc, 'nope')).toBe(doc);
  });

  it('applyFilterPreset replaces active-page filters with the preset filters', () => {
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'p',
      filters: [pageFilter('preset-1-a')],
    };
    const doc = makeDoc({
      filters: [pageFilter('current', 'page-1'), pageFilter('other', 'page-2')],
      filterPresets: [preset],
    });
    const next = docTransforms.applyFilterPreset(doc, 'preset-1');
    const ids = next.filters.map((f) => f.id).sort();
    // page-2 filter kept, page-1 filter replaced with the preset filter scoped to page-1.
    expect(ids).toEqual(['other', 'preset-1-a']);
    const applied = next.filters.find((f) => f.id === 'preset-1-a');
    expect(applied!.scope).toEqual({ kind: 'page', pageId: 'page-1' });
  });

  it('deleteFilterPreset removes by id and preserves identity on no-op', () => {
    const preset: StudioFilterPreset = { id: 'preset-1', name: 'p', filters: [] };
    const doc = makeDoc({ filterPresets: [preset] });
    const removed = docTransforms.deleteFilterPreset(doc, 'preset-1');
    expect(removed.filterPresets).toEqual([]);
    // Unknown id → original array reference preserved.
    const noop = docTransforms.deleteFilterPreset(doc, 'nope');
    expect(noop.filterPresets).toBe(doc.filterPresets);
  });

  it('renameFilterPreset renames and preserves identity on unknown id', () => {
    const preset: StudioFilterPreset = { id: 'preset-1', name: 'old', filters: [] };
    const doc = makeDoc({ filterPresets: [preset] });
    const renamed = docTransforms.renameFilterPreset(doc, 'preset-1', 'new');
    expect(renamed.filterPresets!.find((p) => p.id === 'preset-1')!.name).toBe('new');
    const noop = docTransforms.renameFilterPreset(doc, 'nope', 'x');
    expect(noop.filterPresets).toBe(doc.filterPresets);
  });
});
