import * as React from 'react';
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioDataSource, StudioRelationship } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { RelationshipPanel } from './RelationshipPanel';

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

const REL: StudioRelationship = {
  id: 'r1',
  sourceId: 'orders',
  sourceField: 'customerId',
  targetId: 'customers',
  targetField: 'id',
  type: 'many-to-one',
};

function setup(relationships: StudioRelationship[] = [REL]) {
  const { controller, wrapper } = createStudioHarness();
  const removeSpy = vi.spyOn(controller, 'removeRelationship');
  render(<RelationshipPanel relationships={relationships} dataSources={DATA_SOURCES} />, {
    wrapper,
  });
  return { controller, removeSpy };
}

describe('RelationshipPanel', () => {
  it('shows an empty message when there are no relationships', () => {
    setup([]);
    expect(screen.getByText('No relationships configured.')).not.toBe(null);
  });

  it('renders a relationship with its source, target and type', () => {
    setup();
    expect(screen.getByText(/Orders.*Customers/)).not.toBe(null);
    expect(screen.getByText('Many-to-one')).not.toBe(null);
  });

  it('removes a relationship from its delete action', () => {
    const { removeSpy } = setup();
    fireEvent.click(screen.getByTestId('DeleteIcon').closest('button')!);
    expect(removeSpy).toHaveBeenCalledWith('r1');
  });

  it('hides edit/delete actions for predefined relationships', () => {
    setup([{ ...REL, predefined: true }]);
    expect(screen.queryByTestId('DeleteIcon')).toBe(null);
    expect(screen.queryByTestId('EditIcon')).toBe(null);
  });

  it('opens the add dialog from the Add button', () => {
    setup([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Add relationship')).not.toBe(null);
  });

  it('opens the edit dialog from a relationship edit action', () => {
    setup();
    fireEvent.click(screen.getByTestId('EditIcon').closest('button')!);
    expect(screen.getByText('Edit relationship')).not.toBe(null);
  });
});
