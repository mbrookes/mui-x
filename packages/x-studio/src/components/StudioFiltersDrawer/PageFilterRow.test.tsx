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
});
