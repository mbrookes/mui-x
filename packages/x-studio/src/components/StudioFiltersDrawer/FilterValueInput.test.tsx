import * as React from 'react';
import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';
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
    //
    // Finding 1.17: the bounds now buffer locally and commit on blur (not per keystroke), so
    // the object dispatch is asserted after a blur rather than on `change`.
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
    fireEvent.blur(toInput);
    expect(onChange).toHaveBeenCalledWith({ from: '10', to: '25' });
  });

  it('buffers between-numeric keystrokes and commits once on blur (1.17)', () => {
    // Regression for finding 1.17: the `between` bounds used to call `onChange`
    // (`controller.updateFilter`, undoable) on EVERY keystroke — typing "1500" produced 4
    // separate undoable commits + 4 pipeline recomputes. They now buffer locally: no commit
    // while typing, and a single commit on blur.
    const onChange = vi.fn();
    render(
      <FilterValueInput
        fieldType="number"
        operator="between"
        value={{ from: '', to: '99' }}
        onChange={onChange}
      />,
    );

    const fromInput = screen.getByLabelText('From') as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: '1' } });
    fireEvent.change(fromInput, { target: { value: '15' } });
    fireEvent.change(fromInput, { target: { value: '150' } });
    fireEvent.change(fromInput, { target: { value: '1500' } });
    // Still buffered — no store write yet, and the displayed text tracks every keystroke.
    expect(onChange).not.toHaveBeenCalled();
    expect(fromInput.value).toBe('1500');

    fireEvent.blur(fromInput);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ from: '1500', to: '99' });
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

  describe('Autocomplete reset echo (finding 2.16)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not schedule a commit when an external value change echoes back the same value', () => {
      // Regression for finding 2.16: MUI's free-solo Autocomplete fires
      // `onInputChange(value, 'reset')` whenever its controlled `value` changes externally
      // (undo, redo, preset apply, AI mutation). The drawer's handler used to schedule its
      // 150ms debounce unconditionally, eventually re-committing the content-identical value
      // as a fresh, undoable, redo-clearing `updateFilter` commit.
      vi.useFakeTimers();
      const onChange = vi.fn();
      const { rerender } = render(
        <FilterValueInput
          fieldType="string"
          operator="equals"
          value="B"
          onChange={onChange}
          fieldValues={['A', 'B']}
        />,
      );

      // Simulate an undo: the store's filter value reverts from the in-progress edit ('B')
      // back to the pre-edit value ('A') — an EXTERNAL change, not a user keystroke.
      rerender(
        <FilterValueInput
          fieldType="string"
          operator="equals"
          value="A"
          onChange={onChange}
          fieldValues={['A', 'B']}
        />,
      );

      // Advance well past the 150ms debounce window.
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('still commits a genuine option pick after an external value change', () => {
      // The fix must not swallow real edits — only the reset echo that redelivers the
      // ALREADY-current value. Picking a different option must still commit.
      vi.useFakeTimers();
      const onChange = vi.fn();
      render(
        <FilterValueInput
          fieldType="string"
          operator="equals"
          value="A"
          onChange={onChange}
          fieldValues={['A', 'B']}
        />,
      );

      const input = screen.getByRole('combobox') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'B' } });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(onChange).toHaveBeenCalledWith('B');
    });
  });
});
