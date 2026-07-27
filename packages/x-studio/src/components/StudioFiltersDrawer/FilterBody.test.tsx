import * as React from 'react';
import { createRenderer, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
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

  // M8: the reset ran in ONE direction only. ARCHITECTURE.md has always claimed "in both
  // directions", and the missing half left `revenue = 500` rendering two EMPTY bound inputs
  // over a stored scalar `500` — a card the user reads as a half-authored range they never
  // cleared, and whose first typed bound silently replaces the old value.
  it('resets a scalar value when the operator switches TO `between` (M8)', async () => {
    const filter = makeFilter({ operator: 'equals', value: 500 });
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
    await user.click(within(screen.getByRole('listbox')).getByText('Between'));

    expect(onChange).toHaveBeenCalledWith({ operator: 'between', value: '' });
  });

  it('resets a scalar value2 when operator2 switches TO `between` (M8)', async () => {
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
    await user.click(within(screen.getByRole('listbox')).getByText('Between'));

    expect(onChange).toHaveBeenCalledWith({ operator2: 'between', value2: '' });
  });

  it('does not reset an ALREADY-EMPTY value when switching to `between` (M8)', async () => {
    const filter = makeFilter({ operator: 'equals', value: '' });
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
    await user.click(within(screen.getByRole('listbox')).getByText('Between'));

    // Nothing to strand, so no redundant `value` key in the delta.
    expect(onChange).toHaveBeenCalledWith({ operator: 'between' });
  });

  // M9, end to end. The old sequence: "On: 3 months ago" → Between (no reset, M8) → pick a
  // `from` → `FilterValueInput` spread the relative value as the between base, producing
  // `{ relative: true, amount: 3, unit: 'month', direction: 'past', from }`. The loose
  // `isRelativeDateValue` then answered `true` for that hybrid, so every `between` ↔ scalar
  // reset guard refused to fire ever again and the widget-edit dialog rendered it read-only:
  // the user's typed range was unreachable. With M8 the first step already resets, and the
  // hardened predicate means even a host/AI-authored hybrid stays repairable.
  it('leaves a relative-date filter repairable across a Between round-trip (M9)', async () => {
    const relative = { relative: true, amount: 3, unit: 'month', direction: 'past' } as const;
    const operators = getOperators('date');

    // Step 1 — "On: 3 months ago" → "Between" now clears the scalar relative value.
    const onChange = vi.fn();
    const { user, unmount } = render(
      <FilterBody
        filter={makeFilter({ fieldType: 'date', operator: 'equals', value: relative })}
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
    await user.click(within(screen.getByRole('listbox')).getByText('Between'));
    expect(onChange).toHaveBeenCalledWith({ operator: 'between', value: '' });
    unmount();

    // Step 2 — even a doc that already holds the hybrid (host- or AI-authored) is repairable:
    // switching back to a scalar operator resets it instead of silently keeping it.
    const hybrid = { ...relative, from: '2024-01-01' };
    const onChange2 = vi.fn();
    const { user: user2 } = render(
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <FilterBody
          filter={makeFilter({ fieldType: 'date', operator: 'between', value: hybrid })}
          fieldType="date"
          operators={operators}
          activeOperator="between"
          activeOperator2="equals"
          fieldValues={[]}
          onModeChange={() => {}}
          onChange={onChange2}
        />
      </LocalizationProvider>,
    );
    await user2.click(screen.getAllByRole('combobox')[0]);
    await user2.click(within(screen.getByRole('listbox')).getByText('Before'));
    expect(onChange2).toHaveBeenCalledWith({ operator: 'less_than', value: '' });
  });
});
