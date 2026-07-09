import * as React from 'react';
import { createRenderer, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioFilterState } from '../../models';
import { FilterBody } from './FilterBody';
import { getOperators } from './filterDrawerUtils';

const { render } = createRenderer();

function makeFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'f1',
    field: 'amount',
    fieldType: 'number',
    operator: 'between',
    value: { from: 10, to: 20 },
    scope: { kind: 'page' },
    ...overrides,
  };
}

describe('FilterBody', () => {
  // Regression for finding 1.6: switching a filter's operator AWAY from `between` used to
  // write only `{ operator: newOperator }`, leaving the stale `{ from, to }` object value in
  // place. `toComparable` then produces NaN for that object, so e.g. `greater_than` silently
  // matches nothing, and the value input renders "[object Object]". The operator `onChange`
  // must reset the value when the new operator is shape-incompatible with the object.
  it('resets an object `between` value when the operator switches away from `between` (1.6)', async () => {
    const filter = makeFilter();
    const onChange = vi.fn();
    const operators = getOperators('number');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={operators}
        activeOperator="between"
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    const operatorSelect = screen.getAllByRole('combobox')[0];
    await user.click(operatorSelect);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('>'));

    expect(onChange).toHaveBeenCalledWith({ operator: 'greater_than', value: '' });
  });

  it('does not reset the value when switching between two non-between operators', async () => {
    const filter = makeFilter({ operator: 'equals', value: '5' });
    const onChange = vi.fn();
    const operators = getOperators('number');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={operators}
        activeOperator="equals"
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    const operatorSelect = screen.getAllByRole('combobox')[0];
    await user.click(operatorSelect);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('>'));

    expect(onChange).toHaveBeenCalledWith({ operator: 'greater_than' });
  });
});
