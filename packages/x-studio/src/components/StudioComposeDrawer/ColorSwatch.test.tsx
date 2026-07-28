import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ColorSwatch } from './ColorSwatch';

const { render } = createRenderer();

/**
 * Regression coverage for architecture-review finding 2.9: a native
 * `<input type="color">` fires its (React-visible) `onChange` continuously while the
 * user drags around the OS color wheel — real browsers emit a native `input` event per
 * drag frame and exactly one native `change` event when the picker closes / the drag
 * ends. Wiring `onChange` straight to `controller.updateWidgetConfig` committed dozens
 * of undoable steps per drag. `ColorSwatch` now buffers the live value locally and only
 * forwards the final value on the native `change` event.
 *
 * `fireEvent.input` and `fireEvent.change` dispatch distinct native event types, which
 * is exactly the distinction the fix relies on: React's own onChange plumbing reacts to
 * both (so the swatch still tracks the cursor during a drag), but the component's own
 * commit listener is attached directly to the native `change` event only.
 */
describe('ColorSwatch (finding 2.9)', () => {
  it('does not call onChange for intermediate drag frames (native "input" events)', () => {
    const onChange = vi.fn();
    render(
      <ColorSwatch value="#ff0000" onChange={onChange} label="Color picker" identity="w1:color" />,
    );
    const input = screen.getByLabelText('Color picker') as HTMLInputElement;

    fireEvent.input(input, { target: { value: '#ff1100' } });
    fireEvent.input(input, { target: { value: '#ff2200' } });
    fireEvent.input(input, { target: { value: '#ff3300' } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onChange exactly once with the final value on the native "change" event (drag end / picker close)', () => {
    const onChange = vi.fn();
    render(
      <ColorSwatch value="#ff0000" onChange={onChange} label="Color picker" identity="w1:color" />,
    );
    const input = screen.getByLabelText('Color picker') as HTMLInputElement;

    // Several live drag frames…
    fireEvent.input(input, { target: { value: '#ff1100' } });
    fireEvent.input(input, { target: { value: '#ff2200' } });
    // …then the picker closes, firing a single native "change".
    fireEvent.change(input, { target: { value: '#00ff00' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('#00ff00');
  });

  it('resyncs the buffered value when the external value prop changes and no drag is in flight (undo/redo)', () => {
    const onChange = vi.fn();
    const { setProps } = render(
      <ColorSwatch value="#ff0000" onChange={onChange} label="Color picker" identity="w1:color" />,
    );
    const getInput = () => screen.getByLabelText('Color picker') as HTMLInputElement;

    setProps({ value: '#abcdef' });

    expect(getInput().value).toBe('#abcdef');
  });
});

/**
 * M14: `ColorSwatch` used to hand-roll the buffer as `useState` + a bare
 * `useEffect(() => setDraft(value), [value])` — the naive, NOT dirty-aware resync that
 * `useBufferedInput` was created to replace. The compose drawer and the AI chat panel are
 * usable at the same time and the AI tool surface includes `update_widget`, so an external
 * write (or an undo from a keyboard shortcut) landing mid-drag silently discarded the
 * picker value the user was still choosing.
 */
describe('ColorSwatch buffered-input semantics (M14)', () => {
  it('keeps an in-flight drag value when an external write lands mid-drag', () => {
    const onChange = vi.fn();
    const { setProps } = render(
      <ColorSwatch value="#ff0000" onChange={onChange} label="Color picker" identity="w1:color" />,
    );
    const getInput = () => screen.getByLabelText('Color picker') as HTMLInputElement;

    // The user is mid-drag on the OS colour wheel.
    fireEvent.input(getInput(), { target: { value: '#123456' } });
    // An AI `update_widget` (or an undo) writes a different colour to the same entity.
    setProps({ value: '#abcdef' });

    // In-flight picking wins over an external write to the SAME entity.
    expect(getInput().value).toBe('#123456');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('discards an in-flight drag value when the edited entity changes', () => {
    const onChange = vi.fn();
    const { setProps } = render(
      <ColorSwatch
        value="#ff0000"
        onChange={onChange}
        label="Color picker"
        identity="widget-a:titleColor"
      />,
    );
    const getInput = () => screen.getByLabelText('Color picker') as HTMLInputElement;

    fireEvent.input(getInput(), { target: { value: '#123456' } });
    // Re-pointed at a DIFFERENT entity that happens to hold the same committed value: an
    // uncommitted pick must never leak across, so the identity change discards it.
    setProps({ identity: 'widget-b:titleColor' });

    expect(getInput().value).toBe('#ff0000');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('resumes tracking external writes after a drag commits', () => {
    const onChange = vi.fn();
    const { setProps } = render(
      <ColorSwatch value="#ff0000" onChange={onChange} label="Color picker" identity="w1:color" />,
    );
    const getInput = () => screen.getByLabelText('Color picker') as HTMLInputElement;

    fireEvent.input(getInput(), { target: { value: '#123456' } });
    // The picker closes and the value commits — the buffer must go back to CLEAN, or every
    // later undo/redo/clear would be ignored as "in-flight picking wins" forever.
    fireEvent.change(getInput(), { target: { value: '#00ff00' } });
    expect(onChange).toHaveBeenCalledWith('#00ff00');

    setProps({ value: '#abcdef' });
    expect(getInput().value).toBe('#abcdef');
  });
});
