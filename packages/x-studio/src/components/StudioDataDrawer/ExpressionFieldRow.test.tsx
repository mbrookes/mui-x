import * as React from 'react';
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioExpressionField } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import ExpressionFieldRow from './ExpressionFieldRow';

const { render } = createRenderer();

const FIELD: StudioExpressionField = {
  id: 'expr1',
  label: 'Profit margin',
  sourceId: 's1',
  isMeasure: false,
  expression: {} as StudioExpressionField['expression'],
  type: 'number',
};

function setup(props: Partial<React.ComponentProps<typeof ExpressionFieldRow>> = {}) {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const { wrapper } = createStudioHarness();
  render(
    <ExpressionFieldRow field={FIELD} isEditMode onEdit={onEdit} onDelete={onDelete} {...props} />,
    {
      wrapper,
    },
  );
  return { onEdit, onDelete };
}

describe('ExpressionFieldRow', () => {
  it('renders the field label', () => {
    setup();
    expect(screen.getByText('Profit margin')).not.toBe(null);
  });

  it('shows edit and delete actions in edit mode', () => {
    setup();
    expect(screen.getByTestId('EditIcon')).not.toBe(null);
    expect(screen.getByTestId('DeleteIcon')).not.toBe(null);
  });

  it('calls onEdit from the edit action and onDelete from the delete action', () => {
    const { onEdit, onDelete } = setup();
    fireEvent.click(screen.getByTestId('EditIcon').closest('button')!);
    fireEvent.click(screen.getByTestId('DeleteIcon').closest('button')!);
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('calls onEdit when the row itself is clicked in edit mode', () => {
    const { onEdit } = setup();
    fireEvent.click(screen.getByText('Profit margin'));
    expect(onEdit).toHaveBeenCalled();
  });

  it('hides the actions and is inert in view mode', () => {
    const { onEdit, onDelete } = setup({ isEditMode: false });
    expect(screen.queryByTestId('EditIcon')).toBe(null);
    expect(screen.queryByTestId('DeleteIcon')).toBe(null);
    fireEvent.click(screen.getByText('Profit margin'));
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
