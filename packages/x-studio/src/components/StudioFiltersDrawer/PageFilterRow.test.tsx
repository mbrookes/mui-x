import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
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
});
