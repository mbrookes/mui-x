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

  // Prototype-chain lookup bugs: `dataSources[rel.sourceId]` and `relationshipTypeLabels[rel.type]`
  // are plain object bracket lookups. A doc-authored `rel.sourceId`/`rel.type` equal to an
  // inherited `Object.prototype` member name (e.g. "constructor") resolves the inherited function
  // instead of `undefined` — which previously survived `?? rel.sourceId` (truthy) and crashed
  // `<Chip label>` rendering with "Functions are not valid as a React child."
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'renders without throwing when rel.sourceId is the prototype key %s',
    (key) => {
      expect(() => setup([{ ...REL, sourceId: key }])).not.toThrow();
      expect(screen.getByText(new RegExp(`${key}.*Customers`))).not.toBe(null);
    },
  );

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'renders without throwing when rel.targetId is the prototype key %s',
    (key) => {
      expect(() => setup([{ ...REL, targetId: key }])).not.toThrow();
      expect(screen.getByText(new RegExp(`Orders.*${key}`))).not.toBe(null);
    },
  );

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'renders without throwing when rel.type is the prototype key %s',
    (key) => {
      const hostileRel = { ...REL, type: key } as unknown as StudioRelationship;
      expect(() => setup([hostileRel])).not.toThrow();
      // The malformed type falls back to being rendered as its own string, never as a function.
      expect(screen.getByText(key)).not.toBe(null);
    },
  );

  it('renders without throwing when rel.junctionSourceId is a prototype key', () => {
    const hostileRel: StudioRelationship = {
      ...REL,
      type: 'many-to-many',
      junctionSourceId: 'constructor',
    };
    expect(() => setup([hostileRel])).not.toThrow();
  });
});
