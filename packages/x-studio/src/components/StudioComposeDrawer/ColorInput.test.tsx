import * as React from 'react';
import { act, createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/StudioUIConfigContext';
import { ColorInput } from './ColorInput';

const { render } = createRenderer();

/**
 * Regression coverage for architecture-review finding 2.9: the hex text field used to
 * call `onChange` (an undoable commit at the call site) on every keystroke — typing a
 * 6-character hex value produced 6 separate undo entries. The field now buffers the
 * typed text locally and only commits on blur/Enter, mirroring the established
 * `AnnotationLabelInput` buffer-then-commit pattern.
 */
describe('ColorInput (finding 2.9)', () => {
  it('does not call onChange while typing', () => {
    const onChange = vi.fn();
    render(<ColorInput label="Color" value="" onChange={onChange} />);
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#' } });
    fireEvent.change(input, { target: { value: '#f' } });
    fireEvent.change(input, { target: { value: '#ff8800' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('#ff8800');
  });

  it('commits the buffered value exactly once on blur', () => {
    const onChange = vi.fn();
    render(<ColorInput label="Color" value="" onChange={onChange} />);
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#ff8800' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('#ff8800');
  });

  it('commits on Enter as well as blur', () => {
    const onChange = vi.fn();
    render(<ColorInput label="Color" value="" onChange={onChange} />);
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#123456' } });
    act(() => {
      input.focus();
    });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('#123456');
  });

  it('does not commit again on blur if nothing changed since the last commit', () => {
    const onChange = vi.fn();
    render(<ColorInput label="Color" value="" onChange={onChange} />);
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#123456' } });
    act(() => {
      input.focus();
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('the Clear button commits immediately, not deferred to blur', () => {
    const onChange = vi.fn();
    render(<ColorInput label="Color" value="#ff8800" onChange={onChange} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: DEFAULT_STUDIO_LOCALE_TEXT.colorInputClearAriaLabel('Color'),
      }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('resyncs the buffered text when the external value prop changes (undo/redo)', () => {
    const onChange = vi.fn();
    const { setProps } = render(<ColorInput label="Color" value="#ff8800" onChange={onChange} />);
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#000000' } });
    setProps({ value: '#abcdef' });

    expect((screen.getByLabelText('Color') as HTMLInputElement).value).toBe('#abcdef');
  });
});
