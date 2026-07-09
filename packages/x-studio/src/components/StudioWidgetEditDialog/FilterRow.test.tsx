import * as React from 'react';
import { createRenderer, fireEvent, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioFilterState } from '../../models';
import { FilterRow, type FieldOption } from './FilterRow';

const { render } = createRenderer();

function makeFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'f1',
    field: 'amount',
    operator: 'equals',
    value: '',
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  };
}

const numberField: FieldOption = { id: 'amount', label: 'Amount', type: 'number' };
const dateField: FieldOption = { id: 'created', label: 'Created', type: 'date' };

describe('FilterRow', () => {
  it('renders the "Between" operator label for a between filter on a number field', () => {
    // Regression for finding #6: `between` used to be missing from the drawer's
    // operator table but present here — this only asserts FilterRow itself still
    // offers/labels it; the cross-surface round-trip is covered in
    // `StudioFiltersDrawer/filterOperatorMetadata.test.ts`.
    render(
      <FilterRow
        filter={makeFilter({ field: 'amount', operator: 'between', fieldType: 'number' })}
        fieldOptions={[numberField]}
        onRemove={() => {}}
        onUpdate={() => {}}
      />,
    );
    expect(screen.getByText('Between')).not.toBe(null);
  });

  it('hides the value input for is_empty/is_not_empty operators', () => {
    const { rerender } = render(
      <FilterRow
        filter={makeFilter({ field: 'amount', operator: 'is_empty', fieldType: 'number' })}
        fieldOptions={[numberField]}
        onRemove={() => {}}
        onUpdate={() => {}}
      />,
    );
    expect(screen.queryByPlaceholderText('Value')).toBe(null);

    rerender(
      <FilterRow
        filter={makeFilter({ field: 'amount', operator: 'equals', fieldType: 'number' })}
        fieldOptions={[numberField]}
        onRemove={() => {}}
        onUpdate={() => {}}
      />,
    );
    expect(screen.getByPlaceholderText('Value')).not.toBe(null);
  });

  it('renders a between filter value without corrupting it, and edits preserve the object (1.10)', () => {
    // Regression for finding 1.10: a `between` value is a `{ from, to }` object. The generic
    // single-value TextField would render it as `[object Object]` and the first keystroke
    // would clobber it into a plain string. The dedicated from/to editor must show the two
    // bounds and, when one is edited, dispatch an object `value` (not a string).
    const onUpdate = vi.fn();
    render(
      <FilterRow
        filter={makeFilter({
          field: 'amount',
          operator: 'between',
          fieldType: 'number',
          value: { from: '10', to: '20' },
        })}
        fieldOptions={[numberField]}
        onRemove={() => {}}
        onUpdate={onUpdate}
      />,
    );

    const fromInput = screen.getByPlaceholderText('From') as HTMLInputElement;
    const toInput = screen.getByPlaceholderText('To') as HTMLInputElement;
    // The object is displayed as two bounds, never as `[object Object]`.
    expect(fromInput.value).toBe('10');
    expect(toInput.value).toBe('20');
    expect(screen.queryByDisplayValue('[object Object]')).toBe(null);

    // Editing the "from" bound keeps the value an object, only changing `from`. The
    // bound editors buffer locally and commit on blur (finding 2.8), so the change
    // alone doesn't commit yet — blur triggers it.
    fireEvent.change(fromInput, { target: { value: '15' } });
    fireEvent.blur(fromInput);
    expect(onUpdate).toHaveBeenCalledWith({ value: { from: '15', to: '20' } });
  });

  it('does NOT reset a RelativeDateValue when the operator switches between scalar operators (1.14)', async () => {
    // Regression for finding 1.14: a `RelativeDateValue` is a non-array object but a valid
    // scalar date value. The edit dialog's reset predicate used to also fire for it, so
    // switching operator silently discarded the relative-date configuration.
    const onUpdate = vi.fn();
    const { user } = render(
      <FilterRow
        filter={makeFilter({
          field: 'created',
          fieldType: 'date',
          operator: 'equals',
          value: { relative: true, amount: 7, unit: 'day', direction: 'past' },
        })}
        fieldOptions={[dateField]}
        onRemove={() => {}}
        onUpdate={onUpdate}
      />,
    );

    // combobox[0] is the field selector; combobox[1] is the operator selector.
    const operatorSelect = screen.getAllByRole('combobox')[1];
    await user.click(operatorSelect);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('Before'));

    // Only the operator changes — the relative value is preserved (no `value` key).
    expect(onUpdate).toHaveBeenCalledWith({ operator: 'less_than' });
  });

  it('falls back to a valid operator for display when the stored operator is invalid for the field type (2.16)', () => {
    // Regression for finding 2.16: an invalid stored operator (here a string `contains` on a
    // number field) used to render raw into the operator Select — an out-of-range value that
    // shows blank and logs a MUI dev warning. The dialog now mirrors the drawer's
    // `activeOperator` fallback and displays `operators[0]` (`=`) instead.
    render(
      <FilterRow
        filter={makeFilter({
          field: 'amount',
          fieldType: 'number',
          operator: 'contains',
          value: 'x',
        })}
        fieldOptions={[numberField]}
        onRemove={() => {}}
        onUpdate={() => {}}
      />,
    );
    const operatorSelect = screen.getAllByRole('combobox')[1];
    expect(operatorSelect.textContent).toBe('=');
  });

  it('calls onRemove when the delete button is clicked', () => {
    const onRemove = vi.fn();
    render(
      <FilterRow
        filter={makeFilter()}
        fieldOptions={[numberField]}
        onRemove={onRemove}
        onUpdate={() => {}}
      />,
    );
    screen.getByRole('button').click();
    expect(onRemove).toHaveBeenCalled();
  });
});
