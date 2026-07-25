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

    const operatorSelect = screen.getByRole('combobox', { name: 'Operator' });
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
    expect(screen.getByRole('combobox', { name: 'Operator' }).textContent).toBe('=');
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
    screen.getByRole('button', { name: 'Remove filter' }).click();
    expect(onRemove).toHaveBeenCalled();
  });

  // Regression for finding 5: both Selects were anonymous. `role="combobox"` takes its name
  // from the author, not from the rendered value, so a screen-reader user heard
  // "combobox, combobox, edit text" — and the tests had to index positionally to say which
  // control they meant.
  it('names both Selects and the value input', () => {
    render(
      <FilterRow
        filter={makeFilter({ fieldType: 'number', value: '42' })}
        fieldOptions={[numberField]}
        onRemove={() => {}}
        onUpdate={() => {}}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Field' })).not.toBe(null);
    expect(screen.getByRole('combobox', { name: 'Operator' })).not.toBe(null);
    expect(screen.getByRole('textbox', { name: 'Value' })).not.toBe(null);
  });

  // Regression for finding 1: the row derived the field type from the option list alone. A
  // filter on a field the panel doesn't list (a cross-source pick, a renamed column) therefore
  // degraded to STRING — a numeric `greater_than` filter rendered "Equals" while the engine
  // kept applying `greater_than`, and picking "Contains" off that wrong list wrote a string
  // operator onto a number field, where `toNumericValue` yields NaN and the filter stops
  // matching. The stamped `filter.fieldType` is authoritative.
  describe('field type resolution (finding 1)', () => {
    it('uses the stamped fieldType when the field is absent from the option list', () => {
      render(
        <FilterRow
          filter={makeFilter({
            field: 'quantity',
            filterSourceId: 'orderLines',
            fieldType: 'number',
            operator: 'greater_than',
            value: '100',
          })}
          fieldOptions={[numberField]}
          onRemove={() => {}}
          onUpdate={() => {}}
        />,
      );

      // The number table's label for `greater_than`, not the string list's "Equals".
      expect(screen.getByRole('combobox', { name: 'Operator' }).textContent).toBe('>');
    });

    it('types the between bounds as number inputs from the stamped fieldType', () => {
      render(
        <FilterRow
          filter={makeFilter({
            field: 'quantity',
            filterSourceId: 'orderLines',
            fieldType: 'number',
            operator: 'between',
            value: { from: '1', to: '9' },
          })}
          fieldOptions={[numberField]}
          onRemove={() => {}}
          onUpdate={() => {}}
        />,
      );

      expect((screen.getByRole('spinbutton', { name: 'From' }) as HTMLInputElement).type).toBe(
        'number',
      );
    });

    it('repairs a stored operator that is invalid for the resolved type, non-undoably', () => {
      // `activeOperator` is display-only; without the repair the dialog shows one operator
      // while the engine applies another, forever.
      const onUpdate = vi.fn();
      render(
        <FilterRow
          filter={makeFilter({ fieldType: 'number', operator: 'contains', value: 'x' })}
          fieldOptions={[numberField]}
          onRemove={() => {}}
          onUpdate={onUpdate}
        />,
      );

      expect(onUpdate).toHaveBeenCalledWith({ operator: 'equals' }, { undoable: false });
    });

    it('does not repair while the field type is still unresolved', () => {
      // During a load race `getOperatorsForFieldType(undefined)` yields the string table, which
      // would condemn a perfectly valid `between` to a permanent rewrite.
      const onUpdate = vi.fn();
      render(
        <FilterRow
          filter={makeFilter({ field: 'ship_date', fieldType: undefined, operator: 'between' })}
          fieldOptions={[]}
          onRemove={() => {}}
          onUpdate={onUpdate}
        />,
      );

      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  // Regression for finding 2: an unresolvable field rendered as an ordinary-looking column
  // name while the widget silently matched zero rows.
  describe('unresolved field (finding 2)', () => {
    it('marks the field and explains why when it matches no catalog entry', () => {
      render(
        <FilterRow
          filter={makeFilter({ field: 'total', fieldType: 'number' })}
          fieldOptions={[numberField]}
          onRemove={() => {}}
          onUpdate={() => {}}
        />,
      );

      expect(screen.getByTestId('filter-field-unresolved')).not.toBe(null);
      expect(screen.getByRole('combobox', { name: 'Field' }).textContent).toBe(
        'total (unavailable)',
      );
    });

    it('stays silent while the option list is still empty', () => {
      render(
        <FilterRow
          filter={makeFilter({ field: 'total', fieldType: 'number' })}
          fieldOptions={[]}
          onRemove={() => {}}
          onUpdate={() => {}}
        />,
      );

      expect(screen.queryByTestId('filter-field-unresolved')).toBe(null);
    });

    it('stays silent for a resolvable field', () => {
      render(
        <FilterRow
          filter={makeFilter()}
          fieldOptions={[numberField]}
          onRemove={() => {}}
          onUpdate={() => {}}
        />,
      );

      expect(screen.queryByTestId('filter-field-unresolved')).toBe(null);
    });
  });
});
