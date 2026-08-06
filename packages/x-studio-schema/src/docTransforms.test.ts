import { describe, expect, it, vi } from 'vitest';
import { createDefaultStudioState } from './factories';
import type { StudioDoc, StudioFilterPreset, StudioFilterState } from './stateTypes';
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
  it('adds a dashboard-date-range filter for the page, leaving unrelated filters untouched', () => {
    // L15: `expect(next.pages).toBe(doc.pages)` / `.dashboard` used to stand here and could not
    // fail — both are guaranteed by the `{ ...doc, filters }` spread on the line under test, so
    // they asserted JS spread semantics rather than anything about this transform. The identity
    // property this transform DOES own is that `withoutExisting` is a `.filter` pass, so every
    // unrelated filter is carried over as the SAME object — which a future rewrite that mapped
    // or re-normalized the array would break.
    const unrelated = pageFilter('f-unrelated', 'page-1');
    const doc = makeDoc({ filters: [unrelated] });
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
    expect(next.filters).toContain(unrelated);
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

  it('returns the ORIGINAL doc when clearing an already-clear date range (2.3)', () => {
    // Identity preservation: clearing when there is nothing to clear must not allocate a fresh
    // `filters` array — otherwise `commitDocPatch` sees a changed reference and commits a
    // phantom undoable no-op that clears the redo stack.
    const doc = makeDoc();
    expect(docTransforms.setDashboardDateRange(doc, 'page-1', null, null, null, null)).toBe(doc);
  });

  it('returns the ORIGINAL doc when re-applying an identical date range (2.3)', () => {
    const doc = makeDoc();
    const withRange = docTransforms.setDashboardDateRange(
      doc,
      'page-1',
      'orderDate',
      'sales',
      'date',
      'last_3_months',
    );
    // Re-running with identical args rebuilds a content-identical filter → no logical change.
    const again = docTransforms.setDashboardDateRange(
      withRange,
      'page-1',
      'orderDate',
      'sales',
      'date',
      'last_3_months',
    );
    expect(again).toBe(withRange);
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

  it('returns the ORIGINAL doc when re-applying an identical multi-source date range (2.3)', () => {
    const doc = makeDoc();
    const fields = [
      { fieldId: 'd1', sourceId: 's1', fieldType: 'date' as const },
      { fieldId: 'd2', sourceId: 's2', fieldType: 'datetime' as const },
    ];
    const withRange = docTransforms.setDashboardDateRangeAll(
      doc,
      'page-1',
      fields,
      'last_3_months',
    );
    const again = docTransforms.setDashboardDateRangeAll(
      withRange,
      'page-1',
      fields,
      'last_3_months',
    );
    expect(again).toBe(withRange);
  });

  it('returns the ORIGINAL doc for a no-source, no-existing call (2.3)', () => {
    const doc = makeDoc();
    expect(docTransforms.setDashboardDateRangeAll(doc, 'page-1', [], 'last_3_months')).toBe(doc);
  });

  // Regression coverage for finding 1.7: the coverage-reconciliation effect used to always pass
  // `undefined` custom bounds, so a `'custom'` preset built an EMPTY filter set (`buildDateRangeFilter`
  // returns `null` with no bounds) whose length mismatch against the existing custom filter(s)
  // triggered a rebuild-all that silently deleted every custom date-range filter for the page.
  describe('custom preset coverage (finding 1.7)', () => {
    it('preserves an existing custom-range filter and extends coverage to a newly-added source', () => {
      const existingCustom: StudioFilterState = {
        id: 'dashboard-date-range-page-1-s1',
        field: 'order_date',
        fieldType: 'date',
        filterSourceId: 's1',
        filterMode: 'condition',
        operator: 'between',
        dateRangePreset: 'custom',
        value: { from: '2024-01-01', to: '2024-01-31' },
        scope: { kind: 'dashboard-date-range', sourceId: 's1', pageId: 'page-1' },
      };
      const doc = makeDoc({ filters: [existingCustom] });

      // A second source (`s2`) is injected after the persisted single-source custom range
      // loaded — the reconciliation effect now covers both sources, threading the EXISTING
      // custom bounds through (as `StudioDateRangeBar` does) rather than `undefined`.
      const next = docTransforms.setDashboardDateRangeAll(
        doc,
        'page-1',
        [
          { fieldId: 'order_date', sourceId: 's1', fieldType: 'date' },
          { fieldId: 'ship_date', sourceId: 's2', fieldType: 'date' },
        ],
        'custom',
        '2024-01-01',
        '2024-01-31',
      );

      const rangeFilters = next.filters.filter((f) => f.scope.kind === 'dashboard-date-range');
      expect(rangeFilters).toHaveLength(2);
      // The original s1 filter is untouched (same id/field), not deleted.
      const s1Filter = rangeFilters.find(
        (f) => f.scope.kind === 'dashboard-date-range' && f.scope.sourceId === 's1',
      );
      expect(s1Filter).toMatchObject({
        id: 'dashboard-date-range-page-1-s1',
        field: 'order_date',
        value: { from: '2024-01-01', to: '2024-01-31' },
      });
      // The newly-covered s2 source gets the SAME custom bounds.
      const s2Filter = rangeFilters.find(
        (f) => f.scope.kind === 'dashboard-date-range' && f.scope.sourceId === 's2',
      );
      expect(s2Filter).toMatchObject({
        field: 'ship_date',
        value: { from: '2024-01-01', to: '2024-01-31' },
      });
    });

    it('never wipes an existing custom-range filter when called with no bounds (the pre-fix repro)', () => {
      // This reproduces the OLD call shape (`customFrom`/`customTo` omitted, as the buggy
      // effect always passed) to prove the transform itself no longer deletes coverage even
      // if a caller regresses back to omitting bounds.
      const existingCustom: StudioFilterState = {
        id: 'dashboard-date-range-page-1-s1',
        field: 'order_date',
        fieldType: 'date',
        filterSourceId: 's1',
        filterMode: 'condition',
        operator: 'between',
        dateRangePreset: 'custom',
        value: { from: '2024-01-01', to: '2024-01-31' },
        scope: { kind: 'dashboard-date-range', sourceId: 's1', pageId: 'page-1' },
      };
      const doc = makeDoc({ filters: [existingCustom] });

      const next = docTransforms.setDashboardDateRangeAll(
        doc,
        'page-1',
        [
          { fieldId: 'order_date', sourceId: 's1', fieldType: 'date' },
          { fieldId: 'ship_date', sourceId: 's2', fieldType: 'date' },
        ],
        'custom',
      );

      const rangeFilters = next.filters.filter((f) => f.scope.kind === 'dashboard-date-range');
      // The existing s1 custom filter survives — it is never deleted just because bounds
      // were unavailable for the reconciliation call.
      expect(rangeFilters.some((f) => f.id === 'dashboard-date-range-page-1-s1')).toBe(true);
    });

    it('preserves an authored non-first date field when reconciling a non-custom preset', () => {
      // Secondary defect (1.7): rebuilding ALL of a page's date-range filters from each
      // source's FIRST date field would silently re-point a filter authored on a DIFFERENT
      // field (e.g. an AI-chosen `ship_date`) back to the source's first field
      // (`order_date`) whenever another source merely lacked coverage.
      const existingOnShipDate: StudioFilterState = {
        id: 'dashboard-date-range-page-1-s1',
        field: 'ship_date',
        fieldType: 'date',
        filterSourceId: 's1',
        filterMode: 'condition',
        operator: 'between',
        dateRangePreset: 'last_3_months',
        value: null,
        scope: { kind: 'dashboard-date-range', sourceId: 's1', pageId: 'page-1' },
      };
      const doc = makeDoc({ filters: [existingOnShipDate] });

      // s2 has no coverage yet; s1's `fields` entry lists its FIRST date field
      // (`order_date`) — the reconciliation call always reports first-date-field candidates,
      // even for a source that's already covered on a different field.
      const next = docTransforms.setDashboardDateRangeAll(
        doc,
        'page-1',
        [
          { fieldId: 'order_date', sourceId: 's1', fieldType: 'date' },
          { fieldId: 'order_date', sourceId: 's2', fieldType: 'date' },
        ],
        'last_3_months',
      );

      const s1Filter = next.filters.find(
        (f) => f.scope.kind === 'dashboard-date-range' && f.scope.sourceId === 's1',
      );
      // s1 keeps its authored `ship_date` field — not silently re-pointed to `order_date`.
      expect(s1Filter?.field).toBe('ship_date');
      const s2Filter = next.filters.find(
        (f) => f.scope.kind === 'dashboard-date-range' && f.scope.sourceId === 's2',
      );
      expect(s2Filter?.field).toBe('order_date');
    });
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

  it('returns the ORIGINAL doc when clearing an already-clear widget date range (2.3)', () => {
    const doc = makeDoc();
    expect(docTransforms.setWidgetDateRange(doc, 'w1', null, null, null, null)).toBe(doc);
  });

  it('returns the ORIGINAL doc when re-applying an identical widget date range (2.3)', () => {
    const doc = makeDoc();
    const withRange = docTransforms.setWidgetDateRange(doc, 'w1', 'd', 's', 'date', 'this_month');
    const again = docTransforms.setWidgetDateRange(withRange, 'w1', 'd', 's', 'date', 'this_month');
    expect(again).toBe(withRange);
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
    // page-2 filter kept, page-1 filter replaced with the preset filter scoped to page-1.
    expect(next.filters.find((f) => f.id === 'other')).toBeTruthy();
    expect(next.filters.find((f) => f.id === 'current')).toBeUndefined();
    // The applied filter carries a FRESH id (not the preset-baked `preset-1-a`), scoped to
    // the active page and preserving the preset filter's field/operator/value payload.
    const applied = next.filters.find(
      (f) => f.scope.kind === 'page' && f.scope.pageId === 'page-1',
    );
    expect(applied).toBeTruthy();
    expect(applied!.id).not.toBe('preset-1-a');
    expect(applied!.field).toBe('value');
    expect(applied!.scope).toEqual({ kind: 'page', pageId: 'page-1' });
  });

  // Regression for architecture-review finding: a legacy pageId-less page filter
  // (`scope: { kind: 'page' }`, no `pageId` — predates the per-page scope model and applies to
  // EVERY page, per `selectFiltersForWidget`'s `!sv2.pageId` branch) used to be silently
  // DELETED from the doc entirely whenever a preset was applied to ANY page, because it
  // satisfied neither "not a page filter" nor "page filter for a specific OTHER page". Applying
  // a preset to one page must never wipe an all-pages filter's effect on the rest of the
  // dashboard.
  it('applyFilterPreset preserves a legacy pageId-less "all pages" filter\'s effect on OTHER pages', () => {
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'p',
      filters: [pageFilter('preset-1-a')],
    };
    const legacyAllPagesFilter = pageFilter('legacy-all-pages'); // no pageId -> applies everywhere
    const doc = makeDoc({
      filters: [legacyAllPagesFilter, pageFilter('other', 'page-2')],
      filterPresets: [preset],
    });
    // `makeDoc`'s default `dashboard.activePageId` is 'page-1'.
    const next = docTransforms.applyFilterPreset(doc, 'preset-1');

    // The legacy all-pages filter survives untouched — its effect on page-2 (and every other
    // page) must not be wiped out just because the preset was applied on page-1.
    const survivingLegacy = next.filters.find((f) => f.id === 'legacy-all-pages');
    expect(survivingLegacy).toBeTruthy();
    expect(survivingLegacy!.scope).toEqual({ kind: 'page' });

    // page-2's own filter is untouched too.
    expect(next.filters.find((f) => f.id === 'other')).toBeTruthy();

    // The active page (page-1) has the preset's filter applied as usual.
    const applied = next.filters.find(
      (f) => f.scope.kind === 'page' && f.scope.pageId === 'page-1',
    );
    expect(applied).toBeTruthy();
  });

  // M12: `applyFilterPreset` always rebuilt `{ ...doc, filters: [...] }`, and the fresh
  // `createFilterId()`s it mints guarantee the array is never reference-equal to the old one —
  // so `commitDocPatch`'s reference-equality guard could never fire and re-applying the preset
  // a page already shows committed a phantom undoable step that also wiped the redo stack.
  // Every sibling in this file has an identity bail; this one didn't.
  it('applyFilterPreset returns the ORIGINAL doc when re-applying the preset already in effect', () => {
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'p',
      filters: [pageFilter('preset-1-a'), pageFilter('preset-1-b')],
    };
    const doc = makeDoc({
      filters: [pageFilter('current', 'page-1'), pageFilter('other', 'page-2')],
      filterPresets: [preset],
    });
    const applied = docTransforms.applyFilterPreset(doc, 'preset-1');
    expect(applied).not.toBe(doc);

    // Re-applying the SAME preset to the SAME page changes nothing a user can see, so the
    // original doc reference comes straight back.
    expect(docTransforms.applyFilterPreset(applied, 'preset-1')).toBe(applied);
  });

  it('applyFilterPreset re-applies (does not bail) when the page filters have since diverged', () => {
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'p',
      filters: [pageFilter('preset-1-a')],
    };
    const doc = makeDoc({ filterPresets: [preset] });
    const applied = docTransforms.applyFilterPreset(doc, 'preset-1');

    // The user edits the applied filter's value — the preset is no longer in effect.
    const edited: StudioDoc = {
      ...applied,
      filters: applied.filters.map((f) => ({ ...f, value: 'edited' })),
    };
    const reapplied = docTransforms.applyFilterPreset(edited, 'preset-1');
    expect(reapplied).not.toBe(edited);
    expect(reapplied.filters[0].value).toBe('x');
  });

  it('applyFilterPreset bails on a value-equal re-apply whose payload key ORDER differs', () => {
    // The compensating comparator this bail replaces lived in `StudioFiltersDrawer` and used
    // `JSON.stringify`, which is key-ORDER sensitive: two filters carrying the same `value`
    // object built by different code paths would compare unequal. The bail here compares by
    // structural value, so key order is irrelevant.
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'p',
      filters: [
        {
          ...pageFilter('preset-1-a'),
          value: { from: '2024-01-01', to: '2024-02-01' },
        } as StudioFilterState,
      ],
    };
    const doc = makeDoc({ filterPresets: [preset] });
    const applied = docTransforms.applyFilterPreset(doc, 'preset-1');
    // Rebuild the live filter's `value` with the SAME entries in the opposite key order.
    const reordered: StudioDoc = {
      ...applied,
      filters: applied.filters.map((f) => ({
        ...f,
        value: { to: '2024-02-01', from: '2024-01-01' },
      })),
    };
    expect(docTransforms.applyFilterPreset(reordered, 'preset-1')).toBe(reordered);
  });

  it('applyFilterPreset mints distinct ids per page so the two copies stay independent (1.7)', () => {
    // Repro for finding 1.7: applying the same preset to two different pages must NOT
    // produce two `doc.filters` entries sharing an id — otherwise the controller's
    // id-keyed toggle/update/remove would mutate both copies at once.
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'p',
      filters: [pageFilter('preset-1-a')],
    };
    // Apply to page-1.
    const docA = makeDoc({
      filterPresets: [preset],
      dashboard: { id: 'dashboard-1', title: 't', activePageId: 'page-1' },
    });
    const afterA = docTransforms.applyFilterPreset(docA, 'preset-1');
    const filterA = afterA.filters.find(
      (f) => f.scope.kind === 'page' && f.scope.pageId === 'page-1',
    )!;

    // Switch to page-2 and apply the same preset (keeping page-1's applied copy).
    const docB: StudioDoc = {
      ...afterA,
      dashboard: { ...afterA.dashboard, activePageId: 'page-2' },
    };
    const afterB = docTransforms.applyFilterPreset(docB, 'preset-1');
    const filterB = afterB.filters.find(
      (f) => f.scope.kind === 'page' && f.scope.pageId === 'page-2',
    )!;

    // Both copies still exist, scoped to their own page, with DISTINCT ids.
    const pageAStill = afterB.filters.find(
      (f) => f.scope.kind === 'page' && f.scope.pageId === 'page-1',
    )!;
    expect(pageAStill.id).toBe(filterA.id);
    expect(filterB.id).not.toBe(filterA.id);

    // Simulate the controller's id-keyed edit on page-2's copy: only that entry changes.
    const edited = afterB.filters.map((f) => (f.id === filterB.id ? { ...f, value: 'edited' } : f));
    expect(edited.find((f) => f.id === filterB.id)!.value).toBe('edited');
    expect(edited.find((f) => f.id === filterA.id)!.value).toBe('x');

    // Simulate the controller's id-keyed remove on page-2's copy: page-1's copy survives.
    const removed = edited.filter((f) => f.id !== filterB.id);
    expect(removed.find((f) => f.id === filterA.id)).toBeTruthy();
    expect(removed.find((f) => f.id === filterB.id)).toBeUndefined();
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

  it('deleteFilterPreset does not manufacture a filterPresets array when the doc had none (3.2)', () => {
    // A doc that never carried a `filterPresets` key must come back byte-for-byte the
    // same reference — no phantom `filterPresets: []` that would look like a real edit
    // to `commitDocPatch` and push a spurious undo entry.
    const doc = makeDoc();
    expect(doc.filterPresets).toBeUndefined();
    const next = docTransforms.deleteFilterPreset(doc, 'preset-1');
    expect(next).toBe(doc);
    expect(next.filterPresets).toBeUndefined();
  });

  it('renameFilterPreset does not manufacture a filterPresets array when the doc had none (3.2)', () => {
    const doc = makeDoc();
    expect(doc.filterPresets).toBeUndefined();
    const next = docTransforms.renameFilterPreset(doc, 'preset-1', 'x');
    expect(next).toBe(doc);
    expect(next.filterPresets).toBeUndefined();
  });

  it('deleteFilterPreset returns the same doc reference on an unknown id (no phantom commit)', () => {
    const preset: StudioFilterPreset = { id: 'preset-1', name: 'p', filters: [] };
    const doc = makeDoc({ filterPresets: [preset] });
    // Unknown id → the whole doc reference is preserved (not just the array), so the
    // controller's reference-equality no-op guard skips it entirely.
    expect(docTransforms.deleteFilterPreset(doc, 'nope')).toBe(doc);
  });

  // ─── 2.8: filter presets preserve `dependsOn` (cascading-filter) linkage ─────
  // A cascading Country → City page filter (City.dependsOn = [Country.id]) saved as a preset
  // and later applied must keep the cascade working. Before the fix neither `saveFilterPreset`
  // (re-keys ids to `${id}-${f.id}`) nor `applyFilterPreset` (mints fresh ids) remapped
  // `dependsOn`, so the dependency pointed at ids that no longer existed and `FilterBody`
  // silently dropped the dangling refs — the narrowing quietly stopped working.

  it('saveFilterPreset re-keys dependsOn into the preset id space, dropping refs outside the set (2.8)', () => {
    const country = pageFilter('country', 'page-1');
    const city = { ...pageFilter('city', 'page-1'), dependsOn: ['country', 'not-in-preset'] };
    const doc = makeDoc({ filters: [country, city] });
    const next = docTransforms.saveFilterPreset(doc, 'preset-1', 'Geo');
    const preset = next.filterPresets!.find((p) => p.id === 'preset-1')!;
    const savedCity = preset.filters.find((f) => f.id === 'preset-1-city')!;
    // The intra-preset dependency is re-keyed to match the re-keyed Country id; the ref that
    // was not captured in the preset is dropped (it can't be re-linked on apply).
    expect(savedCity.dependsOn).toEqual(['preset-1-country']);
  });

  it('applyFilterPreset remaps dependsOn through the fresh id map so the cascade survives a round-trip (2.8)', () => {
    const country = pageFilter('country', 'page-1');
    const city = { ...pageFilter('city', 'page-1'), dependsOn: ['country'] };
    const saved = docTransforms.saveFilterPreset(
      makeDoc({ filters: [country, city] }),
      'preset-1',
      'Geo',
    );
    // Apply the preset onto a fresh page-1 (no originals) to isolate the applied copies.
    const target = makeDoc({ filterPresets: saved.filterPresets });
    const next = docTransforms.applyFilterPreset(target, 'preset-1');
    const appliedCountry = next.filters.find((f) => f.field === 'value' && !f.dependsOn)!;
    const appliedCity = next.filters.find((f) => f.dependsOn)!;
    expect(appliedCountry).toBeTruthy();
    expect(appliedCity).toBeTruthy();
    // City's dependsOn points at the APPLIED Country's fresh id — not the preset-baked
    // `preset-1-country`, and not the original `country`.
    expect(appliedCity.dependsOn).toEqual([appliedCountry.id]);
    expect(appliedCity.dependsOn).not.toContain('preset-1-country');
    expect(appliedCity.dependsOn).not.toContain('country');
  });

  it('applyFilterPreset drops dependsOn refs that do not resolve within the preset (2.8)', () => {
    // A preset filter whose dependsOn points at an id absent from the preset must not leak a
    // dangling ref into the applied doc — the whole `dependsOn` collapses to `undefined`.
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'p',
      filters: [{ ...pageFilter('preset-1-a'), dependsOn: ['ghost'] }],
    };
    const doc = makeDoc({ filterPresets: [preset] });
    const next = docTransforms.applyFilterPreset(doc, 'preset-1');
    const applied = next.filters.find(
      (f) => f.scope.kind === 'page' && f.scope.pageId === 'page-1',
    )!;
    expect(applied.dependsOn).toBeUndefined();
  });

  it('saveFilterPreset does not throw on a malformed (non-array) dependsOn and drops it', () => {
    // Defense in depth: persisted/wire-loaded state can carry a wrong-shaped `dependsOn`
    // (e.g. a bare string) that the schema layer doesn't validate at the wire boundary.
    // A bare truthiness check would still call `.filter()` on it and throw mid-user-gesture.
    const malformed = { ...pageFilter('a', 'page-1'), dependsOn: 'country' as any };
    const doc = makeDoc({ filters: [malformed] });
    expect(() => docTransforms.saveFilterPreset(doc, 'preset-1', 'Bad')).not.toThrow();
    const next = docTransforms.saveFilterPreset(doc, 'preset-1', 'Bad');
    const preset = next.filterPresets!.find((p) => p.id === 'preset-1')!;
    const saved = preset.filters.find((f) => f.id === 'preset-1-a')!;
    expect(saved.dependsOn).toBeUndefined();
  });

  it('applyFilterPreset does not throw on a malformed (non-array) dependsOn and drops it', () => {
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'p',
      filters: [{ ...pageFilter('preset-1-a'), dependsOn: 'country' as any }],
    };
    const doc = makeDoc({ filterPresets: [preset] });
    expect(() => docTransforms.applyFilterPreset(doc, 'preset-1')).not.toThrow();
    const next = docTransforms.applyFilterPreset(doc, 'preset-1');
    const applied = next.filters.find(
      (f) => f.scope.kind === 'page' && f.scope.pageId === 'page-1',
    )!;
    expect(applied.dependsOn).toBeUndefined();
  });

  // ─── 2.2: applyFilterPreset must not land TWO rank filters in one page context ───
  // Sibling of the iter-9 `duplicateWidget` rank-uniqueness fix. A preset can carry a
  // page-scoped rank (Top-N) filter (`saveFilterPreset` applies no rank exclusion); applying it
  // onto a page that already has a widget-scoped rank filter would otherwise produce the
  // forbidden "two rank filters on one page" state every other writer guards against.

  function rankFilter(
    id: string,
    scope: StudioFilterState['scope'],
    value: number,
  ): StudioFilterState {
    return {
      id,
      field: 'value',
      operator: 'equals',
      value,
      filterMode: 'rank',
      rankDirection: 'top',
      scope,
    } as StudioFilterState;
  }

  it('applyFilterPreset drops a preset rank filter that conflicts with an existing widget-scoped rank filter (2.2)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Active page (page-1) already has a widget (w1) carrying a widget-scoped rank filter, so a
    // page-scoped rank filter re-materialized by the preset onto page-1 would conflict.
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'p',
      filters: [rankFilter('preset-1-rank', { kind: 'page', pageId: 'page-1' }, 10)],
    };
    const doc = makeDoc({
      pages: { 'page-1': { id: 'page-1', title: 'P1', widgetRows: [['w1']] } },
      filters: [rankFilter('w-rank', { kind: 'widget', widgetId: 'w1' }, 5)],
      filterPresets: [preset],
    });

    const next = docTransforms.applyFilterPreset(doc, 'preset-1');

    // Exactly one rank filter survives — the pre-existing widget-scoped one; the preset's rank
    // filter was dropped rather than installed, with a dev warning.
    const rankFilters = next.filters.filter((f) => f.filterMode === 'rank');
    expect(rankFilters).toHaveLength(1);
    expect(rankFilters[0].scope).toEqual({ kind: 'widget', widgetId: 'w1' });
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('applyFilterPreset installs a preset rank filter when the page has no conflicting rank filter (2.2)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'p',
      filters: [rankFilter('preset-1-rank', { kind: 'page', pageId: 'page-1' }, 10)],
    };
    // A widget-scoped rank filter on a DIFFERENT page (page-2) does not occupy page-1's context.
    const doc = makeDoc({
      pages: {
        'page-1': { id: 'page-1', title: 'P1', widgetRows: [] },
        'page-2': { id: 'page-2', title: 'P2', widgetRows: [['w2']] },
      },
      filters: [rankFilter('w-rank', { kind: 'widget', widgetId: 'w2' }, 5)],
      filterPresets: [preset],
    });

    const next = docTransforms.applyFilterPreset(doc, 'preset-1');

    // Both rank filters coexist — they live in different page contexts.
    const rankFilters = next.filters.filter((f) => f.filterMode === 'rank');
    expect(rankFilters).toHaveLength(2);
    expect(next.filters.some((f) => f.scope.kind === 'page' && f.scope.pageId === 'page-1')).toBe(
      true,
    );
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // ─── 2.6: renameFilterPreset must not commit a value-identical rename ───
  it('renameFilterPreset returns the ORIGINAL doc reference for a value-identical rename (2.6)', () => {
    const preset: StudioFilterPreset = { id: 'preset-1', name: 'same', filters: [] };
    const doc = makeDoc({ filterPresets: [preset] });
    // Renaming to the current name must not allocate a fresh doc/array — otherwise
    // `commitDocPatch`'s reference-equality guard is defeated and a phantom redo-clearing undo
    // entry is pushed.
    const next = docTransforms.renameFilterPreset(doc, 'preset-1', 'same');
    expect(next).toBe(doc);
    expect(next.filterPresets).toBe(doc.filterPresets);
  });
});

// ─── R6 F3: every filter-drop path cascades into the survivors' `dependsOn` ───

describe('docTransforms — dependsOn cascade on filter drops (R6 F3)', () => {
  const dateRangeArgs = {
    fieldId: 'created_at',
    sourceId: 'orders',
    fieldType: 'date' as const,
  };

  it('applyFilterPreset prunes a retained filter depending on a dropped page filter', () => {
    const preset: StudioFilterPreset = {
      id: 'preset-1',
      name: 'View',
      filters: [pageFilter('p-a', 'page-1')],
    } as StudioFilterPreset;
    const doc = makeDoc({
      dashboard: { activePageId: 'page-1' } as never,
      widgets: { w1: { id: 'w1', kind: 'kpi', title: 'W', config: {} } } as never,
      filters: [
        pageFilter('fp', 'page-1'),
        {
          id: 'fw',
          field: 'value',
          operator: 'equals',
          value: 'x',
          scope: { kind: 'widget', widgetId: 'w1' },
          dependsOn: ['fp'],
        } as StudioFilterState,
      ],
      filterPresets: [preset],
    });

    const next = docTransforms.applyFilterPreset(doc, 'preset-1');

    expect(next.filters.find((f) => f.id === 'fp')).toBeUndefined();
    expect(next.filters.find((f) => f.id === 'fw')).not.toHaveProperty('dependsOn');
  });

  it('setDashboardDateRange prunes a dependency on the date-range filter it clears', () => {
    let doc = makeDoc({ dashboard: { activePageId: 'page-1' } as never });
    doc = docTransforms.setDashboardDateRange(
      doc,
      'page-1',
      dateRangeArgs.fieldId,
      dateRangeArgs.sourceId,
      dateRangeArgs.fieldType,
      'this_month',
    );
    const dateFilterId = doc.filters.find((f) => f.scope.kind === 'dashboard-date-range')!.id;
    doc = {
      ...doc,
      filters: [...doc.filters, { ...pageFilter('fp', 'page-1'), dependsOn: [dateFilterId] }],
    };

    // Clearing the date range (null preset) drops it.
    const next = docTransforms.setDashboardDateRange(doc, 'page-1', null, null, null, null);

    expect(next.filters.some((f) => f.scope.kind === 'dashboard-date-range')).toBe(false);
    expect(next.filters.find((f) => f.id === 'fp')).not.toHaveProperty('dependsOn');
  });

  it('setWidgetDateRange prunes a dependency on the widget date-range filter it clears', () => {
    let doc = makeDoc({
      widgets: { w1: { id: 'w1', kind: 'kpi', title: 'W', config: {} } } as never,
    });
    doc = docTransforms.setWidgetDateRange(
      doc,
      'w1',
      dateRangeArgs.fieldId,
      dateRangeArgs.sourceId,
      dateRangeArgs.fieldType,
      'this_month',
    );
    doc = {
      ...doc,
      filters: [
        ...doc.filters,
        { ...pageFilter('fp', 'page-1'), dependsOn: ['widget-date-range-w1'] },
      ],
    };

    const next = docTransforms.setWidgetDateRange(doc, 'w1', null, null, null, null);

    expect(next.filters.some((f) => f.id === 'widget-date-range-w1')).toBe(false);
    expect(next.filters.find((f) => f.id === 'fp')).not.toHaveProperty('dependsOn');
  });

  // `setDashboardDateRangeAll` keeps one filter per SOURCE: a second existing
  // dashboard-date-range filter sharing a source is dropped by the coverage sweep.
  it('setDashboardDateRangeAll prunes a dependency on the duplicate-source filter it drops', () => {
    const ddr = (id: string) =>
      docTransforms.buildDateRangeFilter({
        id,
        field: 'created_at',
        fieldType: 'date',
        sourceId: 'orders',
        preset: 'this_month',
        scope: { kind: 'dashboard-date-range', sourceId: 'orders', pageId: 'page-1' },
      })!;
    const doc = makeDoc({
      dashboard: { activePageId: 'page-1' } as never,
      filters: [ddr('d1'), ddr('d2'), { ...pageFilter('fp', 'page-1'), dependsOn: ['d2'] }],
    });

    const next = docTransforms.setDashboardDateRangeAll(
      doc,
      'page-1',
      [{ fieldId: 'created_at', sourceId: 'orders', fieldType: 'date' }],
      'last_3_months',
    );

    expect(next.filters.some((f) => f.id === 'd2')).toBe(false);
    expect(next.filters.find((f) => f.id === 'fp')).not.toHaveProperty('dependsOn');
  });
});
