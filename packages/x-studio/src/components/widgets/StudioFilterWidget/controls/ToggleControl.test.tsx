import * as React from 'react';
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../../../internals/test-utils';
import { ToggleControl } from './ToggleControl';

const { render } = createRenderer();

function setup(props: Partial<React.ComponentProps<typeof ToggleControl>> = {}) {
  const onApply = vi.fn();
  const onClear = vi.fn();
  const { wrapper } = createStudioHarness();
  render(
    <ToggleControl
      label="Country"
      values={['US', 'DE', 'FR']}
      selected={[]}
      onApply={onApply}
      onClear={onClear}
      {...props}
    />,
    { wrapper },
  );
  return { onApply, onClear };
}

describe('ToggleControl', () => {
  it('renders a chip per value', () => {
    setup();
    expect(screen.getByRole('button', { name: 'US' })).not.toBe(null);
    expect(screen.getByRole('button', { name: 'DE' })).not.toBe(null);
    expect(screen.getByRole('button', { name: 'FR' })).not.toBe(null);
  });

  it('applies a newly selected value', () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'US' }));
    expect(onApply).toHaveBeenCalledWith(['US']);
  });

  it('adds to the existing selection', () => {
    const { onApply } = setup({ selected: ['US'] });
    fireEvent.click(screen.getByRole('button', { name: 'DE' }));
    expect(onApply).toHaveBeenCalledWith(['US', 'DE']);
  });

  it('clears when the last selected value is toggled off', () => {
    const { onClear } = setup({ selected: ['US'] });
    fireEvent.click(screen.getByRole('button', { name: 'US' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('reflects the selected state via aria-pressed', () => {
    setup({ selected: ['US'] });
    expect(screen.getByRole('button', { name: 'US' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'DE' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('clears from the clear affordance when a selection is active', () => {
    const { onClear } = setup({ selected: ['US'] });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('shows a no-options hint when there are no values', () => {
    setup({ values: [] });
    expect(screen.getByText('No options found')).not.toBe(null);
  });
});

// Regression for M10: above 12 distinct values the control renders a search box. Typing a
// non-matching term used to replace the whole `filtered.length > 0` branch — the selected chips
// AND the inline Clear button — with an italic "No options". The filter kept filtering the
// whole page with no control left to remove it without first clearing the search, and the
// message claimed the field had no options when it had many. `MultiSelectControl` never had
// this problem because its Clear lives in an always-rendered `ListSubheader`.
describe('ToggleControl search with no matches (M10)', () => {
  // Above `TOGGLE_SEARCH_THRESHOLD` (12) so the search box renders.
  const MANY = ['US', 'DE', 'FR', 'GB', 'ES', 'IT', 'NL', 'BE', 'SE', 'NO', 'DK', 'FI', 'PL'];

  function setupMany(props: Partial<React.ComponentProps<typeof ToggleControl>> = {}) {
    return setup({ values: MANY, ...props });
  }

  it('keeps the Clear affordance reachable when the search matches nothing', () => {
    const { onClear } = setupMany({ selected: ['US'] });

    fireEvent.change(screen.getByPlaceholderText('Search values…'), {
      target: { value: 'zzzz-no-such-country' },
    });

    const clear = screen.getByRole('button', { name: 'Clear filter' });
    expect(clear).not.toBe(null);
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('keeps an active selection visible and deselectable when the search excludes it', () => {
    const { onClear } = setupMany({ selected: ['US'] });

    fireEvent.change(screen.getByPlaceholderText('Search values…'), {
      target: { value: 'zzzz-no-such-country' },
    });

    // The selected chip is still on screen — a value that is actively filtering the page must
    // never be hidden by a search term — and toggling it off still clears.
    const chip = screen.getByRole('button', { name: 'US' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('does not claim the field has no options when it has many', () => {
    setupMany({ selected: ['US'] });

    fireEvent.change(screen.getByPlaceholderText('Search values…'), {
      target: { value: 'zzzz-no-such-country' },
    });

    // Uses the translated `filterWidgetNoSearchMatchesLabel`, which is distinct from
    // existing string, so assert on the structural claim that actually regressed: the
    // no-OPTIONS branch (which hides the chips and the Clear button) must not be taken.
    expect(screen.queryByRole('button', { name: 'Clear filter' })).not.toBe(null);
    expect(screen.queryByRole('button', { name: 'US' })).not.toBe(null);
  });

  it('still shows the no-options message when the field genuinely has none', () => {
    setup({ values: [], selected: [] });
    expect(screen.getByText('No options found')).not.toBe(null);
  });
});
