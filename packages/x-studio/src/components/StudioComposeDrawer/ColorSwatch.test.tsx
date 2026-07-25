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
    render(<ColorSwatch value="#ff0000" onChange={onChange} label="Color picker" />);
    const input = screen.getByLabelText('Color picker') as HTMLInputElement;

    fireEvent.input(input, { target: { value: '#ff1100' } });
    fireEvent.input(input, { target: { value: '#ff2200' } });
    fireEvent.input(input, { target: { value: '#ff3300' } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onChange exactly once with the final value on the native "change" event (drag end / picker close)', () => {
    const onChange = vi.fn();
    render(<ColorSwatch value="#ff0000" onChange={onChange} label="Color picker" />);
    const input = screen.getByLabelText('Color picker') as HTMLInputElement;

    // Several live drag frames…
    fireEvent.input(input, { target: { value: '#ff1100' } });
    fireEvent.input(input, { target: { value: '#ff2200' } });
    // …then the picker closes, firing a single native "change".
    fireEvent.change(input, { target: { value: '#00ff00' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('#00ff00');
  });

  it('resyncs the buffered value when the external value prop changes (undo/redo)', () => {
    const onChange = vi.fn();
    const { setProps } = render(
      <ColorSwatch value="#ff0000" onChange={onChange} label="Color picker" />,
    );
    const getInput = () => screen.getByLabelText('Color picker') as HTMLInputElement;

    fireEvent.input(getInput(), { target: { value: '#123456' } });
    setProps({ value: '#abcdef' });

    expect(getInput().value).toBe('#abcdef');
  });
});
