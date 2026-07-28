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
    render(<ColorInput label="Color" value="" identity="w1:color" onChange={onChange} />);
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#' } });
    fireEvent.change(input, { target: { value: '#f' } });
    fireEvent.change(input, { target: { value: '#ff8800' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('#ff8800');
  });

  it('commits the buffered value exactly once on blur', () => {
    const onChange = vi.fn();
    render(<ColorInput label="Color" value="" identity="w1:color" onChange={onChange} />);
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#ff8800' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('#ff8800');
  });

  it('commits on Enter as well as blur', () => {
    const onChange = vi.fn();
    render(<ColorInput label="Color" value="" identity="w1:color" onChange={onChange} />);
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
    render(<ColorInput label="Color" value="" identity="w1:color" onChange={onChange} />);
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
    render(<ColorInput label="Color" value="#ff8800" identity="w1:color" onChange={onChange} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: DEFAULT_STUDIO_LOCALE_TEXT.colorInputClearAriaLabel('Color'),
      }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('resyncs the buffered text when the external value prop changes and nothing is being typed', () => {
    const onChange = vi.fn();
    const { setProps } = render(
      <ColorInput label="Color" value="#ff8800" identity="w1:color" onChange={onChange} />,
    );

    setProps({ value: '#abcdef' });

    expect((screen.getByLabelText('Color') as HTMLInputElement).value).toBe('#abcdef');
  });

  // M15: the resync is DIRTY-AWARE. This case used to assert the opposite — that an external
  // write overwrote a half-typed value — which is precisely the bug: the compose drawer and
  // the AI chat panel are usable at the same time and the AI tool surface includes
  // `update_widget`, so a concurrent write (or an undo from a keyboard shortcut) landed
  // mid-keystroke and silently threw the user's edit away. In-flight typing now wins; only an
  // `identity` change discards it (covered below).
  it('keeps in-flight typing when the external value changes mid-edit', () => {
    const onChange = vi.fn();
    const { setProps } = render(
      <ColorInput label="Color" value="#ff8800" identity="w1:color" onChange={onChange} />,
    );
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#000000' } });
    setProps({ value: '#abcdef' });

    expect((screen.getByLabelText('Color') as HTMLInputElement).value).toBe('#000000');
    // …and the blur still commits what the user actually typed, not the concurrent write.
    fireEvent.blur(screen.getByLabelText('Color'));
    expect(onChange).toHaveBeenCalledWith('#000000');
  });
});

/**
 * M2 — a buffered input whose resync effect depends on `value` alone cannot tell "nothing
 * changed" from "same value, different entity". Re-pointing this input at another widget
 * that holds the same colour (typically `''` — neither has one set) left the previous
 * widget's dirty buffer in place, and the next blur/Enter committed it onto the new widget.
 * The primary fix remounts the subtree (`StudioComposeDrawer` keys `WidgetConfigView` on the
 * selected widget id); `identity` covers the other contexts this reusable input is used in.
 */
describe('ColorInput identity resync (M2)', () => {
  it('discards a dirty buffer when `identity` changes even though `value` does not', () => {
    const onChange = vi.fn();
    const { setProps } = render(
      <ColorInput label="Color" value="" identity="widget-a:title" onChange={onChange} />,
    );
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    // Widget A has no colour set; the user types one without blurring.
    fireEvent.change(input, { target: { value: '#ff0000' } });

    // Selection moves to widget B, which also has no colour set — `value` is `''` both
    // before and after, so a `[value]`-only effect never fires.
    setProps({ identity: 'widget-b:title' });

    expect((screen.getByLabelText('Color') as HTMLInputElement).value).toBe('');

    // …and the now-clean buffer has nothing to commit onto widget B.
    fireEvent.blur(screen.getByLabelText('Color'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves the buffer alone while `identity` is unchanged', () => {
    const onChange = vi.fn();
    const { setProps } = render(
      <ColorInput label="Color" value="" identity="widget-a:title" onChange={onChange} />,
    );
    const input = screen.getByLabelText('Color') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#ff0000' } });

    // An unrelated re-render of the same entity must not discard an in-progress edit.
    setProps({ label: 'Color' });

    expect((screen.getByLabelText('Color') as HTMLInputElement).value).toBe('#ff0000');
  });
});

// ─── Finding 9: no no-op commit when the text is edited back to its original ───
//
// `dirty` only records that the buffer was TYPED IN, not that it differs from the committed
// value. Editing `#ff0000` and undoing the edit by hand before blurring left `dirty` set, so
// blurring pushed an undoable `updateWidgetConfig` with identical content — and a later
// Ctrl+Z then appeared to do nothing at all.
describe('ColorInput — no-op commit guard (finding 9)', () => {
  it('commits nothing when the text is typed and restored to the committed value', () => {
    const onChange = vi.fn();
    render(<ColorInput label="Color" value="#ff0000" identity="w1:color" onChange={onChange} />);
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#ff000' } });
    fireEvent.change(input, { target: { value: '#ff0000' } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('still commits a genuine change', () => {
    const onChange = vi.fn();
    render(<ColorInput label="Color" value="#ff0000" identity="w1:color" onChange={onChange} />);
    const input = screen.getByLabelText('Color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#00ff00' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('#00ff00');
  });
});
