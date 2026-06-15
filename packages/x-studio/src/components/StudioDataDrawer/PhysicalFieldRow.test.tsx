import * as React from 'react';
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioDataSource } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import PhysicalFieldRow from './PhysicalFieldRow';

const { render } = createRenderer();

const FIELD: StudioDataSource['fields'][number] = { id: 'amount', label: 'Amount', type: 'number' };

function setup(props: Partial<React.ComponentProps<typeof PhysicalFieldRow>> = {}) {
  const onSelect = vi.fn();
  const { wrapper } = createStudioHarness();
  render(
    <PhysicalFieldRow
      field={FIELD}
      rows={[]}
      isSelected={false}
      isEditMode
      onSelect={onSelect}
      {...props}
    />,
    { wrapper },
  );
  return { onSelect };
}

describe('PhysicalFieldRow', () => {
  it('renders the field label', () => {
    setup();
    expect(screen.getByText('Amount')).not.toBe(null);
  });

  it('marks the row selected only in edit mode when selected', () => {
    setup({ isSelected: true, isEditMode: true });
    expect(screen.getByRole('button').className).toContain('Mui-selected');
  });

  it('is not selected when not in edit mode even if isSelected', () => {
    setup({ isSelected: true, isEditMode: false });
    expect(screen.getByRole('button').className).not.toContain('Mui-selected');
  });

  it('calls onSelect when clicked in edit mode', () => {
    const { onSelect } = setup({ isEditMode: true });
    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('does not call onSelect when clicked outside edit mode', () => {
    const { onSelect } = setup({ isEditMode: false });
    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
