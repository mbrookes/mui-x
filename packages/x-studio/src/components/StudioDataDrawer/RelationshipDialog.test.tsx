import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioDataSource } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { RelationshipDialog, type RelationshipFormState } from './RelationshipDialog';

const { render } = createRenderer();

const DATA_SOURCES: Record<string, StudioDataSource> = {
  orders: {
    id: 'orders',
    label: 'Orders',
    fields: [{ id: 'customerId', label: 'Customer', type: 'string' }],
  },
  customers: {
    id: 'customers',
    label: 'Customers',
    fields: [{ id: 'id', label: 'ID', type: 'string' }],
  },
};

const VALID_FORM: RelationshipFormState = {
  sourceId: 'orders',
  sourceField: 'customerId',
  targetId: 'customers',
  targetField: 'id',
  type: 'many-to-one',
  junctionSourceId: '',
  junctionSourceField: '',
  junctionTargetField: '',
};

function setup(props: Partial<React.ComponentProps<typeof RelationshipDialog>> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  const { wrapper } = createStudioHarness();
  const view = render(
    <RelationshipDialog
      open
      onClose={onClose}
      onSave={onSave}
      dataSources={DATA_SOURCES}
      {...props}
    />,
    { wrapper },
  );
  return { ...view, onClose, onSave };
}

describe('RelationshipDialog', () => {
  it('shows the "add" title and a disabled Add button for an empty form', () => {
    setup();
    expect(screen.getByText('Add relationship')).not.toBe(null);
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true);
  });

  it('shows the "edit" title and an enabled Update button for a valid initial form', () => {
    setup({ initial: VALID_FORM });
    expect(screen.getByText('Edit relationship')).not.toBe(null);
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', false);
  });

  it('calls onSave with the form when saving a valid relationship', async () => {
    const { user, onSave } = setup({ initial: VALID_FORM });
    await user.click(screen.getByRole('button', { name: 'Update' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
        type: 'many-to-one',
      }),
    );
  });

  it('calls onClose from Cancel', async () => {
    const { user, onClose } = setup({ initial: VALID_FORM });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps Update disabled when a required join field is missing', () => {
    setup({ initial: { ...VALID_FORM, targetField: '' } });
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', true);
  });
});
