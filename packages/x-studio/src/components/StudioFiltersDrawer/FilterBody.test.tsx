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

  // Regression for finding 1.14: a `RelativeDateValue` (`{ relative: true, amount, unit,
  // direction }`) is a non-array object but a fully-supported scalar date value, NOT a
  // `between`-shaped one. The reset predicate used to also fire for it, so switching a
  // relative-date filter's operator (e.g. "On" → "Before") silently discarded the configured
  // relative value.
  it('does NOT reset a RelativeDateValue when the operator switches between scalar date operators (1.14)', async () => {
    const filter = makeFilter({
      fieldType: 'date',
      operator: 'equals',
      value: { relative: true, amount: 7, unit: 'day', direction: 'past' },
    });
    const onChange = vi.fn();
    const operators = getOperators('date');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="date"
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
    await user.click(within(listbox).getByText('Before'));

    // Only the operator changes — the relative value is preserved (no `value` key).
    expect(onChange).toHaveBeenCalledWith({ operator: 'less_than' });
  });

  // Regression for finding 1.15: the SECOND condition's `operator2` handler had neither the
  // between-shape reset nor the relative-date exclusion the primary `operator` has. Switching
  // `operator2` away from `between` used to leave the `{ from, to }` object in `value2`,
  // which evaluates as NaN (matches nothing) and renders "[object Object]".
  it('resets an object `between` value2 when operator2 switches away from `between` (1.15)', async () => {
    const filter = makeFilter({
      operator: 'equals',
      value: '5',
      operator2: 'between',
      value2: { from: 1, to: 2 },
      conjunction: 'and',
    });
    const onChange = vi.fn();
    const operators = getOperators('number');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={operators}
        activeOperator="equals"
        activeOperator2="between"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    // combobox[0] is the primary operator; combobox[1] is operator2.
    const operator2Select = screen.getAllByRole('combobox')[1];
    await user.click(operator2Select);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('='));

    expect(onChange).toHaveBeenCalledWith({ operator2: 'equals', value2: '' });
  });

  it('does NOT reset value2 when operator2 switches between two non-between operators (1.15)', async () => {
    const filter = makeFilter({
      operator: 'equals',
      value: '5',
      operator2: 'equals',
      value2: '7',
      conjunction: 'and',
    });
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

    const operator2Select = screen.getAllByRole('combobox')[1];
    await user.click(operator2Select);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('>'));

    expect(onChange).toHaveBeenCalledWith({ operator2: 'greater_than' });
  });
});
