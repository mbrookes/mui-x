import * as React from 'react';
import { createRenderer, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioFilterState } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { PageFilterRow } from './PageFilterRow';
import type { FieldOption, SimpleField } from './filterDrawerTypes';

const { render } = createRenderer();

const fields: SimpleField[] = [{ id: 'amount', label: 'Amount', fieldType: 'number' }];
const fieldOptions: FieldOption[] = [
  { id: 'amount', label: 'Amount', fieldType: 'number', sourceId: 'src', sourceLabel: 'Sales' },
];

function makeFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'pf1',
    field: 'amount',
    fieldType: 'number',
    operator: 'equals',
    value: '',
    scope: { kind: 'page' },
    ...overrides,
  };
}

describe('PageFilterRow', () => {
  // Regression for finding 2.12 (display/doc drift half): `activeOperator` is a DISPLAY-ONLY
  // fallback — the row used to render `operators[0]` for an invalid stored operator (e.g.
  // `contains` on a `number` field) without writing it back, so the panel showed "Equals"
  // while the engine kept applying the stale invalid stored operator. Repair the doc,
  // non-undoably, to match what the UI shows — mirroring `KpiSetupPanel`'s `kpiAggregation`
  // self-repair (finding 2.4).
  it('repairs an invalid stored operator back to the doc as a non-undoable write (2.12)', async () => {
    const filter = makeFilter({ operator: 'contains' as StudioFilterState['operator'] });
    const { controller, wrapper } = createStudioHarness({
      initialState: { doc: { filters: [filter] } },
    });
    const updateSpy = vi.spyOn(controller, 'updateFilter');
    render(
      <PageFilterRow
        filter={filter}
        fields={fields}
        fieldOptions={fieldOptions}
        onRemove={() => {}}
        allPageFilters={[filter]}
      />,
      { wrapper },
    );

    expect(updateSpy).toHaveBeenCalledWith('pf1', { operator: 'equals' }, { undoable: false });
  });

  it('does not repair a valid stored operator', () => {
    const filter = makeFilter({ operator: 'greater_than' });
    const { controller, wrapper } = createStudioHarness({
      initialState: { doc: { filters: [filter] } },
    });
    const updateSpy = vi.spyOn(controller, 'updateFilter');
    render(
      <PageFilterRow
        filter={filter}
        fields={fields}
        fieldOptions={fieldOptions}
        onRemove={() => {}}
        allPageFilters={[filter]}
      />,
      { wrapper },
    );

    expect(updateSpy).not.toHaveBeenCalled();
  });

  // Regression for finding 2.17: the operator self-repair effect used to fire against
  // `getOperators(fieldType)` even when `fieldType` was genuinely UNRESOLVED (e.g. the field's
  // source hasn't been injected yet, so neither `filter.fieldType` nor a field-catalog lookup
  // resolves a type). `getOperators(undefined)` falls back to STRING_OPERATORS, which does not
  // contain `between` — a perfectly valid stored date/number operator — so it was permanently
  // (and non-undoably) rewritten to `equals` purely because of a data-loading race.
  it('does not repair a valid between operator when the field type has not resolved yet (2.17)', () => {
    // No `fieldType` on the filter, and no matching entry in `fields` — the field catalog
    // lookup also fails to resolve a type (simulating the source not injected yet).
    const filter = makeFilter({ field: 'ship_date', fieldType: undefined, operator: 'between' });
    const { controller, wrapper } = createStudioHarness({
      initialState: { doc: { filters: [filter] } },
    });
    const updateSpy = vi.spyOn(controller, 'updateFilter');
    render(
      <PageFilterRow
        filter={filter}
        fields={[]}
        fieldOptions={[]}
        onRemove={() => {}}
        allPageFilters={[filter]}
      />,
      { wrapper },
    );

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('repairs once the field type resolves to a real type that invalidates the stored operator (2.17)', () => {
    // Once the field catalog resolves a REAL type (here `string`, which doesn't support
    // `between`), the repair should still fire — the fix only gates the UNRESOLVED case.
    const stringFields: SimpleField[] = [{ id: 'name', label: 'Name', fieldType: 'string' }];
    const filter = makeFilter({ field: 'name', fieldType: undefined, operator: 'between' });
    const { controller, wrapper } = createStudioHarness({
      initialState: { doc: { filters: [filter] } },
    });
    const updateSpy = vi.spyOn(controller, 'updateFilter');
    render(
      <PageFilterRow
        filter={filter}
        fields={stringFields}
        fieldOptions={[]}
        onRemove={() => {}}
        allPageFilters={[filter]}
      />,
      { wrapper },
    );

    expect(updateSpy).toHaveBeenCalledWith('pf1', { operator: 'equals' }, { undoable: false });
  });

  // Regression for finding T2.5: field-type resolution used to ignore `filter.filterSourceId`
  // (`fields.find((f) => f.id === filter.field)` — `fields` is the include-hidden catalog,
  // deduped by id across every source, so it silently returns whichever source's field was
  // seen first). When two sources share a field id with different types, the WRONG type drove
  // `getOperators` and the non-undoable operator-repair effect could permanently rewrite a
  // valid stored `between`/`greater_than` operator to `equals`. Mirror `WidgetFilterRow`'s
  // `filterSourceId`-scoped lookup against `fieldOptions` (which carries `sourceId`) instead.
  it('resolves field type scoped to filter.filterSourceId, not the deduped `fields` catalog (T2.5)', () => {
    const collidingFields: SimpleField[] = [
      // Deduped catalog: source A's `string` type wins because it was seen first — this is
      // the wrong type for this filter, which lives on source B.
      { id: 'status', label: 'Status', fieldType: 'string' },
    ];
    const collidingFieldOptions: FieldOption[] = [
      { id: 'status', label: 'Status', fieldType: 'string', sourceId: 'srcA', sourceLabel: 'A' },
      { id: 'status', label: 'Status', fieldType: 'number', sourceId: 'srcB', sourceLabel: 'B' },
    ];
    const filter = makeFilter({
      field: 'status',
      fieldType: undefined,
      filterSourceId: 'srcB',
      operator: 'between',
    });
    const { controller, wrapper } = createStudioHarness({
      initialState: { doc: { filters: [filter] } },
    });
    const updateSpy = vi.spyOn(controller, 'updateFilter');
    render(
      <PageFilterRow
        filter={filter}
        fields={collidingFields}
        fieldOptions={collidingFieldOptions}
        onRemove={() => {}}
        allPageFilters={[filter]}
      />,
      { wrapper },
    );

    // If the type had resolved to source A's `string` (the unscoped/deduped lookup), `between`
    // is invalid for strings and would be non-undoably repaired to `equals` — the exact hazard
    // this fix closes. Resolving source B's `number` type instead means `between` is valid, so
    // no repair should fire.
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // Regression for finding T3.4: `dependencyOptions` used to offer every other page filter
  // with no source restriction. A cross-source "Depends on" pick can never actually narrow —
  // `applyParentFilters` (useFieldValues.ts) compares the parent's field name against the
  // CHILD source's own rows, which never has that field — silently emptying the child's
  // option list. Only same-source parents should be offered as dependencies.
  it('only offers same-source parents as dependency options (T3.4)', async () => {
    const crossSourceFields: SimpleField[] = [
      { id: 'country', label: 'Country', fieldType: 'string' },
      { id: 'amount', label: 'Amount', fieldType: 'number' },
      { id: 'status', label: 'Status', fieldType: 'string' },
    ];
    const crossSourceFieldOptions: FieldOption[] = [
      {
        id: 'country',
        label: 'Country',
        fieldType: 'string',
        sourceId: 'customers',
        sourceLabel: 'Customers',
      },
      {
        id: 'amount',
        label: 'Amount',
        fieldType: 'number',
        sourceId: 'orders',
        sourceLabel: 'Orders',
      },
      {
        id: 'status',
        label: 'Status',
        fieldType: 'string',
        sourceId: 'orders',
        sourceLabel: 'Orders',
      },
    ];
    const child = makeFilter({
      id: 'child',
      field: 'status',
      fieldType: 'string',
      filterSourceId: 'orders',
      filterMode: 'selection',
      value: [],
    });
    const sameSourceParent = makeFilter({
      id: 'parent-orders',
      field: 'amount',
      fieldType: 'number',
      filterSourceId: 'orders',
      operator: 'greater_than',
      value: 10,
    });
    const crossSourceParent = makeFilter({
      id: 'parent-customers',
      field: 'country',
      fieldType: 'string',
      filterSourceId: 'customers',
      operator: 'equals',
      value: 'US',
    });
    const { wrapper } = createStudioHarness({
      initialState: { doc: { filters: [child, sameSourceParent, crossSourceParent] } },
    });
    const { user } = render(
      <PageFilterRow
        filter={child}
        fields={crossSourceFields}
        fieldOptions={crossSourceFieldOptions}
        onRemove={() => {}}
        allPageFilters={[child, sameSourceParent, crossSourceParent]}
      />,
      { wrapper },
    );

    await user.click(screen.getByPlaceholderText('Select parent filter…'));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Amount')).not.toBeNull();
    expect(within(listbox).queryByText('Country')).toBeNull();
  });

  // Regression for architecture-review finding: a DISABLED parent filter (toggled off in the
  // drawer, not deleted) still had a "meaningful" stored value, so `parentFilters` (computed
  // from `allPageFilters` via `isFilterEffective`) kept including it — the cascading CHILD's
  // option list was narrowed by the disabled parent's value as if it were still active. Since
  // the parent is disabled it must have no effect on anything, including cascading children —
  // the child's rendered option list should reflect every distinct value, not the subset
  // matching the disabled parent's stale selection.
  it('a disabled parent filter does not narrow a cascading child selection filter (disabled cascade)', () => {
    const dataSources = {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'country', label: 'Country', type: 'string' as const },
          { id: 'segment', label: 'Segment', type: 'string' as const },
        ],
        rows: [
          { id: 'o1', country: 'US', segment: 'Consumer' },
          { id: 'o2', country: 'US', segment: 'Corporate' },
          { id: 'o3', country: 'DE', segment: 'Consumer' },
          { id: 'o4', country: 'FR', segment: 'Home Office' },
        ],
      },
    };
    const cascadeFields: SimpleField[] = [
      { id: 'country', label: 'Country', fieldType: 'string' },
      { id: 'segment', label: 'Segment', fieldType: 'string' },
    ];
    const cascadeFieldOptions: FieldOption[] = [
      {
        id: 'country',
        label: 'Country',
        fieldType: 'string',
        sourceId: 'orders',
        sourceLabel: 'Orders',
      },
      {
        id: 'segment',
        label: 'Segment',
        fieldType: 'string',
        sourceId: 'orders',
        sourceLabel: 'Orders',
      },
    ];
    const parent = makeFilter({
      id: 'parent',
      field: 'country',
      fieldType: 'string',
      filterSourceId: 'orders',
      filterMode: 'selection',
      value: ['US'],
      disabled: true,
    });
    const child = makeFilter({
      id: 'child',
      field: 'segment',
      fieldType: 'string',
      filterSourceId: 'orders',
      filterMode: 'selection',
      value: [],
      dependsOn: ['parent'],
    });
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { filters: [parent, child] },
        runtime: { dataSources },
      },
    });
    render(
      <PageFilterRow
        filter={child}
        fields={cascadeFields}
        fieldOptions={cascadeFieldOptions}
        onRemove={() => {}}
        allPageFilters={[parent, child]}
      />,
      { wrapper },
    );

    // Full unfiltered segment set from every row — NOT narrowed to just the US rows' segments
    // (which would have excluded "Home Office", the segment only present on the DE/FR rows).
    expect(screen.getByText('Consumer')).not.toBeNull();
    expect(screen.getByText('Corporate')).not.toBeNull();
    expect(screen.getByText('Home Office')).not.toBeNull();
  });

  // Regression for finding 2: a page filter whose column was renamed or dropped on reload
  // matches zero rows on every widget it reaches, while the card kept rendering the raw field
  // id as a perfectly ordinary title. Say the field is gone — but only once the catalogs are
  // actually loaded, so a data-load race is never reported as a broken filter.
  describe('unresolved field (finding 2)', () => {
    const SOURCE = {
      id: 'src',
      label: 'Sales',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' as const }],
      rows: [],
    };

    it('flags a filter whose field exists in no data source', () => {
      const filter = makeFilter({ field: 'total' });
      const { wrapper } = createStudioHarness({
        initialState: {
          doc: { filters: [filter] },
          runtime: { dataSources: { src: SOURCE } },
        },
      });
      render(
        <PageFilterRow
          filter={filter}
          fields={fields}
          fieldOptions={fieldOptions}
          onRemove={() => {}}
          allPageFilters={[filter]}
        />,
        { wrapper },
      );

      expect(screen.getByTestId('filter-field-unresolved')).not.toBe(null);
      expect(screen.getByText('total (unavailable)')).not.toBe(null);
    });

    it('stays silent while the data sources have not been injected yet', () => {
      const filter = makeFilter({ field: 'total' });
      const { wrapper } = createStudioHarness({ initialState: { doc: { filters: [filter] } } });
      render(
        <PageFilterRow
          filter={filter}
          fields={fields}
          fieldOptions={fieldOptions}
          onRemove={() => {}}
          allPageFilters={[filter]}
        />,
        { wrapper },
      );

      expect(screen.queryByTestId('filter-field-unresolved')).toBe(null);
    });

    it('stays silent for a HIDDEN field, which the offered option list drops but the data has', () => {
      const hiddenSource = {
        id: 'src',
        label: 'Sales',
        fields: [{ id: 'secret', label: 'Secret', type: 'string' as const, hidden: true }],
        rows: [],
      };
      const filter = makeFilter({ field: 'secret', fieldType: 'string' });
      const { wrapper } = createStudioHarness({
        initialState: {
          doc: { filters: [filter] },
          runtime: { dataSources: { src: hiddenSource } },
        },
      });
      render(
        <PageFilterRow
          filter={filter}
          fields={fields}
          fieldOptions={fieldOptions}
          onRemove={() => {}}
          allPageFilters={[filter]}
        />,
        { wrapper },
      );

      expect(screen.queryByTestId('filter-field-unresolved')).toBe(null);
    });

    // M7: the repoint used to rewrite only `field`/`fieldType`/`filterSourceId`. A second
    // condition authored against the OLD field survived it — `contains "north" AND ends_with
    // "ia"` repointed onto numeric `revenue` kept `value2: "ia"`, the operator self-repair
    // rewrote `contains` → `equals` non-undoably, and the widget silently ANDed
    // `revenue ends_with "ia"`: an empty widget, no second-condition UI, no explanation.
    it('clears all five condition keys when the field is re-pointed (M7)', async () => {
      const filter = makeFilter({
        field: 'total',
        fieldType: 'string',
        operator: 'contains',
        value: 'north',
        operator2: 'ends_with',
        value2: 'ia',
        conjunction: 'and',
      });
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: { filters: [filter] },
          runtime: { dataSources: { src: SOURCE } },
        },
      });
      const updateSpy = vi.spyOn(controller, 'updateFilter');
      const { user } = render(
        <PageFilterRow
          filter={filter}
          fields={fields}
          fieldOptions={fieldOptions}
          onRemove={() => {}}
          allPageFilters={[filter]}
        />,
        { wrapper },
      );

      await user.click(screen.getByRole('button', { name: 'Select a field…' }));

      expect(updateSpy).toHaveBeenCalledWith('pf1', {
        field: '',
        fieldType: undefined,
        filterSourceId: undefined,
        operator: 'equals',
        value: '',
        operator2: undefined,
        value2: undefined,
        conjunction: undefined,
      });
    });
  });

  // H4: the quick-filter chip is the only toggle in the product and it renders in VIEW mode
  // only, so a filter disabled from view mode was, in edit mode, an ordinary-looking card the
  // drawer counted as active — with no way to turn it back on and nothing on screen explaining
  // why the widget below showed unfiltered data.
  describe('disabled filter (H4)', () => {
    it('shows a disabled filter as off and offers a re-enable control', async () => {
      const filter = makeFilter({ value: '10', disabled: true });
      const { controller, wrapper } = createStudioHarness({
        initialState: { doc: { filters: [filter] } },
      });
      const toggleSpy = vi.spyOn(controller, 'toggleFilter');
      const { user } = render(
        <PageFilterRow
          filter={filter}
          fields={fields}
          fieldOptions={fieldOptions}
          onRemove={() => {}}
          allPageFilters={[filter]}
        />,
        { wrapper },
      );

      // The state is carried by a real switch, not by dimming alone: it is named after the
      // filter and reads "off" to assistive tech.
      const toggle = screen.getByRole('switch', { name: 'Amount' });
      expect((toggle as HTMLInputElement).checked).toBe(false);

      await user.click(toggle);
      expect(toggleSpy).toHaveBeenCalledWith('pf1');
    });

    it('shows an enabled filter as on', () => {
      const filter = makeFilter({ value: '10' });
      const { wrapper } = createStudioHarness({ initialState: { doc: { filters: [filter] } } });
      render(
        <PageFilterRow
          filter={filter}
          fields={fields}
          fieldOptions={fieldOptions}
          onRemove={() => {}}
          allPageFilters={[filter]}
        />,
        { wrapper },
      );

      expect((screen.getByRole('switch', { name: 'Amount' }) as HTMLInputElement).checked).toBe(
        true,
      );
    });
  });

  // H5: Base UI's `NumberField` fires `onValueChange` per keystroke, so typing "25" used to
  // commit `2` and then `25` — two undoable `updateFilter`s and two full pipeline recomputes
  // for one editing gesture — and the `Math.max(1, v ?? 1)` clamp on a CONTROLLED field wrote
  // `1` straight back when the field was emptied, so it could not be cleared to retype.
  describe('rank count input commit semantics (H5)', () => {
    function renderRankRow() {
      const filter = makeFilter({
        filterMode: 'rank',
        value: 10,
        rankDirection: 'top',
        operator: 'equals',
      });
      const harness = createStudioHarness({ initialState: { doc: { filters: [filter] } } });
      const updateSpy = vi.spyOn(harness.controller, 'updateFilter');
      const { user } = render(
        <PageFilterRow
          filter={filter}
          fields={fields}
          fieldOptions={fieldOptions}
          onRemove={() => {}}
          allPageFilters={[filter]}
        />,
        { wrapper: harness.wrapper },
      );
      return { user, updateSpy };
    }

    it('commits a multi-digit value once, on blur, and lets the field be cleared first', async () => {
      const { user, updateSpy } = renderRankRow();
      const input = screen.getByLabelText('Number of items') as HTMLInputElement;

      await user.clear(input);
      // The clamp used to make this impossible: emptying the field re-rendered "1".
      expect(input.value).toBe('');
      expect(updateSpy).not.toHaveBeenCalled();

      await user.type(input, '25');
      // Still nothing committed mid-gesture — no per-keystroke `2` on the undo stack.
      expect(updateSpy).not.toHaveBeenCalled();

      await user.tab();
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).toHaveBeenCalledWith('pf1', { value: 25 });
    });

    it('does not commit when the field is left empty', async () => {
      const { user, updateSpy } = renderRankRow();
      const input = screen.getByLabelText('Number of items') as HTMLInputElement;

      await user.clear(input);
      await user.tab();

      // A rank filter without an N is meaningless, so an empty commit is ignored and the
      // stored value stands.
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  // Wave 1 made `StudioController.updateFilter` return a `StudioMutationResult` instead of
  // `void`, so a refusal is no longer indistinguishable from a save. This row ignored it, and
  // the reachable refusal — `rank-conflict`, a second Top-N filter in a page context that
  // already has one, landing between render and commit — just snapped the control back with
  // nothing on screen saying why.
  describe('rejected mutations (wave 1 handoff)', () => {
    it('reports a rejected change instead of silently discarding it', async () => {
      const filter = makeFilter();
      const { controller, wrapper } = createStudioHarness({
        initialState: { doc: { filters: [filter] } },
      });
      vi.spyOn(controller, 'updateFilter').mockReturnValue({
        ok: false,
        reason: 'rank-conflict',
      });
      const { user } = render(
        <PageFilterRow
          filter={filter}
          fields={fields}
          fieldOptions={fieldOptions}
          onRemove={() => {}}
          allPageFilters={[filter]}
        />,
        { wrapper },
      );

      await user.click(screen.getAllByRole('combobox')[0]);
      // Pick any operator other than the stored one; which one is irrelevant here.
      await user.click(within(screen.getByRole('listbox')).getAllByRole('option')[1]);

      expect(screen.getByTestId('page-filter-change-error')).not.toBe(null);
    });

    it('shows no error for an accepted change', async () => {
      const filter = makeFilter();
      const { wrapper } = createStudioHarness({
        initialState: { doc: { filters: [filter] } },
      });
      const { user } = render(
        <PageFilterRow
          filter={filter}
          fields={fields}
          fieldOptions={fieldOptions}
          onRemove={() => {}}
          allPageFilters={[filter]}
        />,
        { wrapper },
      );

      await user.click(screen.getAllByRole('combobox')[0]);
      // Pick any operator other than the stored one; which one is irrelevant here.
      await user.click(within(screen.getByRole('listbox')).getAllByRole('option')[1]);

      expect(screen.queryByTestId('page-filter-change-error')).toBe(null);
    });

    it('treats a value-equal no-op (committed: false) as success, not an error', async () => {
      const filter = makeFilter();
      const { controller, wrapper } = createStudioHarness({
        initialState: { doc: { filters: [filter] } },
      });
      vi.spyOn(controller, 'updateFilter').mockReturnValue({ ok: true, committed: false });
      const { user } = render(
        <PageFilterRow
          filter={filter}
          fields={fields}
          fieldOptions={fieldOptions}
          onRemove={() => {}}
          allPageFilters={[filter]}
        />,
        { wrapper },
      );

      await user.click(screen.getAllByRole('combobox')[0]);
      // Pick any operator other than the stored one; which one is irrelevant here.
      await user.click(within(screen.getByRole('listbox')).getAllByRole('option')[1]);

      expect(screen.queryByTestId('page-filter-change-error')).toBe(null);
    });
  });
});
