import * as React from 'react';
import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
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

  // ── Buffered commit: one undo entry per editing gesture ────────────────────
  //
  // The plain TextField and the Autocomplete used to commit through a 150ms debounce, so
  // typing "Northern Europe" at a normal pace landed a separate undoable `updateFilter` at
  // every pause — Ctrl+Z un-typed the value in fragments — and a commit still pending when the
  // row unmounted was dropped without ever reaching the store.
  describe('buffered commit (finding 3)', () => {
    it('does not commit while typing, and commits once on blur', () => {
      const onChange = vi.fn();
      render(
        <FilterValueInput fieldType="string" operator="equals" value="" onChange={onChange} />,
      );

      const input = screen.getByRole('textbox') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'North' } });
      fireEvent.change(input, { target: { value: 'Northern' } });
      fireEvent.change(input, { target: { value: 'Northern Europe' } });
      expect(onChange).not.toHaveBeenCalled();
      expect(input.value).toBe('Northern Europe');

      fireEvent.blur(input);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('Northern Europe');
    });

    it('commits on Enter', () => {
      const onChange = vi.fn();
      render(
        <FilterValueInput fieldType="string" operator="equals" value="" onChange={onChange} />,
      );

      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'DE' } });
      // A key event only reaches the element the user is actually typing into, so the input
      // has to hold focus for the Enter to be delivered at all.
      act(() => {
        input.focus();
      });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('DE');
    });

    it('does not re-commit on a blur that follows no edit', () => {
      // Focusing and leaving an untouched input must not push an undo entry.
      const onChange = vi.fn();
      render(
        <FilterValueInput fieldType="string" operator="equals" value="foo" onChange={onChange} />,
      );

      fireEvent.blur(screen.getByRole('textbox'));
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  // ── M4: operator change must not strand an uncommitted edit ─────────────────
  //
  // The operator branch used to drop the in-flight keystrokes from the store but LEAVE them in
  // the input. The field then showed text that the card summary and the query knew nothing
  // about, permanently.
  describe('operator change with a pending edit (M4)', () => {
    it('resyncs the displayed text to the committed value when the operator changes', () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <FilterValueInput fieldType="string" operator="equals" value="foo" onChange={onChange} />,
      );

      const input = screen.getByRole('textbox') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'bar' } });
      expect(input.value).toBe('bar');

      // The operator changes before the edit is committed — via the dropdown, or via
      // `PageFilterRow`'s self-repair effect after a data-source load race. The stored
      // value is still `foo`, and the operator switch changes the value SHAPE, so the
      // uncommitted scalar must not survive it.
      rerender(
        <FilterValueInput fieldType="string" operator="contains" value="foo" onChange={onChange} />,
      );

      // The stale edit is dropped …
      fireEvent.blur(screen.getByRole('textbox'));
      expect(onChange).not.toHaveBeenCalled();
      // … and the input no longer disagrees with what is actually stored.
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('foo');
    });

    it('clears the input when the operator changes and the committed value is empty', () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <FilterValueInput fieldType="string" operator="equals" value="" onChange={onChange} />,
      );

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'partial' } });
      rerender(
        <FilterValueInput fieldType="string" operator="contains" value="" onChange={onChange} />,
      );

      fireEvent.blur(screen.getByRole('textbox'));
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('Autocomplete reset echo (finding 2.16)', () => {
    it('does not mark the input dirty when an external value change echoes back the same value', () => {
      // Regression for finding 2.16: MUI's free-solo Autocomplete fires
      // `onInputChange(value, 'reset')` whenever its controlled `value` changes externally
      // (undo, redo, preset apply, AI mutation). Buffering that echo would leave the input
      // dirty, so the next blur would re-commit the content-identical value as a fresh,
      // undoable, redo-clearing `updateFilter`.
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

      fireEvent.blur(screen.getByRole('combobox'));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('still commits a genuine free-text edit after an external value change', () => {
      // The fix must not swallow real edits — only the reset echo that redelivers the
      // ALREADY-current value.
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
      expect(onChange).not.toHaveBeenCalled();

      fireEvent.blur(input);
      expect(onChange).toHaveBeenCalledWith('B');
    });

    it('commits immediately when an option is picked, without waiting for a blur', async () => {
      // Clicking an option never blurs the input, so the pick has to commit on its own.
      const onChange = vi.fn();
      const { user } = render(
        <FilterValueInput
          fieldType="string"
          operator="equals"
          value="A"
          onChange={onChange}
          fieldValues={['A', 'B']}
        />,
      );

      // The Autocomplete is `freeSolo`, which suppresses the popup-indicator button, so the
      // listbox opens by clicking into the input itself.
      await user.click(screen.getByRole('combobox'));
      await user.click(screen.getByRole('option', { name: 'B' }));

      expect(onChange).toHaveBeenCalledWith('B');
    });
  });
});
