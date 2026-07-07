import * as React from 'react';
import { act, createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../../../internals/test-utils';
import { SliderControl } from './SliderControl';

const { render } = createRenderer();

function setup(props: Partial<React.ComponentProps<typeof SliderControl>> = {}) {
  const onApply = vi.fn();
  const onClear = vi.fn();
  const { wrapper } = createStudioHarness();
  const utils = render(
    <SliderControl
      label="Price"
      min={0}
      max={100}
      step={1}
      currentValue={null}
      onApply={onApply}
      onClear={onClear}
      {...props}
    />,
    { wrapper },
  );
  return { onApply, onClear, ...utils };
}

function getThumbs() {
  return screen.getAllByRole('slider');
}

describe('SliderControl', () => {
  it('renders two thumbs defaulting to [min, max] when currentValue is null', () => {
    setup({ min: 0, max: 100, currentValue: null });

    const [lo, hi] = getThumbs();
    expect(lo.getAttribute('aria-valuenow')).toBe('0');
    expect(hi.getAttribute('aria-valuenow')).toBe('100');
  });

  it('renders thumbs at the provided currentValue range', () => {
    setup({ min: 0, max: 100, currentValue: { from: 20, to: 80 } });

    const [lo, hi] = getThumbs();
    expect(lo.getAttribute('aria-valuenow')).toBe('20');
    expect(hi.getAttribute('aria-valuenow')).toBe('80');
  });

  it('falls back to min/max for whichever bound is missing from currentValue', () => {
    setup({ min: 0, max: 100, currentValue: { from: 30 } });

    const [lo, hi] = getThumbs();
    expect(lo.getAttribute('aria-valuenow')).toBe('30');
    expect(hi.getAttribute('aria-valuenow')).toBe('100');
  });

  it('commits a narrower range via onApply when a thumb is moved with the keyboard', () => {
    const { onApply } = setup({ min: 0, max: 100, currentValue: null });

    const [lo] = getThumbs();
    // `fireEvent` (not userEvent's `click`/`keyboard`) is used deliberately: userEvent's pointer
    // interactions call `hasPointerCapture` on the slider root, which jsdom doesn't implement and
    // throws. MUI's Slider commits synchronously on keydown, so a plain `fireEvent.keyDown` after
    // focusing the thumb is enough. The repo's `fireEvent.keyDown` requires the target to
    // actually be `document.activeElement`, so the native `.focus()` (wrapped in `act`) is used
    // rather than `fireEvent.focus`, which doesn't move `document.activeElement` in jsdom.
    act(() => {
      lo.focus();
    });
    fireEvent.keyDown(lo, { key: 'ArrowRight' });

    expect(onApply).toHaveBeenCalledWith(1, 100);
  });

  it('calls onClear when the committed range returns to the full [min, max] span', () => {
    const { onApply, onClear } = setup({ min: 0, max: 100, currentValue: { from: 1, to: 100 } });

    const [lo] = getThumbs();
    act(() => {
      lo.focus();
    });
    // Move the low thumb back down from 1 to 0 — the full range restored.
    fireEvent.keyDown(lo, { key: 'ArrowLeft' });

    expect(onClear).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('renders without crashing in date mode with a timestamp currentValue', () => {
    // `formatLabel` (dayjs(v).format('DD MMM YYYY')) is only exercised through the slider's
    // floating value-label tooltip on drag/focus, which isn't reliably reachable without a real
    // pointer gesture in jsdom — so this is a smoke test that date-mode props render correctly.
    const from = new Date('2024-01-01').getTime();
    const to = new Date('2024-06-01').getTime();
    setup({ min: from, max: to, step: 86400000, isDate: true, currentValue: { from, to } });

    const [lo, hi] = getThumbs();
    expect(lo.getAttribute('aria-valuenow')).toBe(String(from));
    expect(hi.getAttribute('aria-valuenow')).toBe(String(to));
  });

  it('exposes an accessible min/max label per thumb', () => {
    setup({ label: 'Price', min: 0, max: 100, currentValue: null });

    const [lo, hi] = getThumbs();
    expect(lo.getAttribute('aria-label')).toBe('Price minimum');
    expect(hi.getAttribute('aria-label')).toBe('Price maximum');
  });
});
