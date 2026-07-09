import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { FilterValueInput } from './FilterValueInput';

const { render } = createRenderer();

describe('FilterValueInput', () => {
  it('renders a text field for string operators', () => {
    render(
      <FilterValueInput fieldType="string" operator="contains" value="hello" onChange={() => {}} />,
    );
    expect(screen.getByRole('textbox')).not.toBe(null);
  });

  it('renders relative date input for date fields', () => {
    render(
      <FilterValueInput
        fieldType="date"
        operator="greater_than"
        value={{ relative: true, amount: 7, unit: 'day', direction: 'past' }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText('Amount')).not.toBe(null);
  });

  it('renders a between numeric filter as from/to inputs and preserves the object on edit (1.10)', () => {
    // Regression for finding 1.10: a `between` value is a `{ from, to }` object. The generic
    // numeric TextField path would stringify it to `[object Object]` and the first keystroke
    // would clobber it. The dedicated editor shows two bounds and dispatches an object.
    const onChange = vi.fn();
    render(
      <FilterValueInput
        fieldType="number"
        operator="between"
        value={{ from: '10', to: '20' }}
        onChange={onChange}
      />,
    );

    const fromInput = screen.getByLabelText('From') as HTMLInputElement;
    const toInput = screen.getByLabelText('To') as HTMLInputElement;
    expect(fromInput.value).toBe('10');
    expect(toInput.value).toBe('20');
    expect(screen.queryByDisplayValue('[object Object]')).toBe(null);

    fireEvent.change(toInput, { target: { value: '25' } });
    expect(onChange).toHaveBeenCalledWith({ from: '10', to: '25' });
  });

  it('renders a between date filter as two date pickers (1.10)', () => {
    // A between filter on a date field must expose two independent date inputs (from + to),
    // not a single-date picker that cannot express a range.
    render(
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <FilterValueInput
          fieldType="date"
          operator="between"
          value={{ from: '2024-01-01', to: '2024-02-01' }}
          onChange={() => {}}
        />
      </LocalizationProvider>,
    );
    // DateValueInput renders a mode toggle per bound; two "From/To"-labelled date pickers
    // appear. The sectioned date field exposes its label via an `aria-labelledby` group,
    // not a plain labelled input, so `getByRole('group', { name })` is the unambiguous way
    // to find it (`getByLabelText` matches both that group and the field's hidden native
    // input — see `DateRangeControl.test.tsx`'s `getDateField` helper for the same pattern).
    expect(screen.getByRole('group', { name: 'From' })).not.toBe(null);
    expect(screen.getByRole('group', { name: 'To' })).not.toBe(null);
  });

  it('renders nothing for is_empty operator', () => {
    const { container } = render(
      <FilterValueInput fieldType="string" operator="is_empty" value="" onChange={() => {}} />,
    );
    expect(container.firstChild).toBe(null);
  });
});
