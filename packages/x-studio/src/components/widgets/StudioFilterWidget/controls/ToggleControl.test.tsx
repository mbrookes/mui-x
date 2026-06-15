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
