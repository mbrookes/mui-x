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

  // ── Prototype-chain lookup guards ───────────────────────────────────────────
  //
  // REMOVED (they could not fail): `it.each` blocks for a prototype-key `rel.sourceId`,
  // `rel.targetId`, and `rel.junctionSourceId`. All three feed `…?.label ?? rel.<id>`, and no
  // inherited `Object.prototype` member has a `label` property — so with `Object.hasOwn` REMOVED
  // the lookup resolves `Object`, `.label` is `undefined`, `??` fires, and the rendered text is
  // byte-identical. The guards in `RelationshipPanel.tsx` are KEPT as defense in depth (they
  // become load-bearing the moment someone reads a property functions DO have), but they are
  // unobservable today and no input distinguishes them.
  //
  // `rel.type` is genuinely different and stays: `relationshipTypeLabels[rel.type]` is the `<Chip
  // label>` VALUE, so unguarded it renders a function and React throws "Functions are not valid
  // as a React child."
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'renders the raw type string, never an inherited function, when rel.type is the prototype key %s',
    (key) => {
      const hostileRel = { ...REL, type: key } as unknown as StudioRelationship;
      expect(() => setup([hostileRel])).not.toThrow();
      expect(screen.getByText(key)).toBeVisible();
    },
  );

  // ── H8: a rejected write must not close the dialog ─────────────────────────
  //
  // `addRelationship` bails on a duplicate id and `updateRelationship`'s `mapPreservingIdentity`
  // finds nothing to patch when the relationship was removed elsewhere (the AI assistant, a second
  // view) — both return `void`, and the panel used to `setDialogOpen(false)` regardless, so a
  // discarded edit looked exactly like a saved one.
  describe('rejected writes keep the dialog open (H8)', () => {
    it('keeps the edit dialog open when the relationship was removed from the doc meanwhile', async () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: { doc: { relationships: [REL] } },
      });
      const { user } = render(
        <RelationshipPanel relationships={[REL]} dataSources={DATA_SOURCES} />,
        { wrapper },
      );

      await user.click(screen.getByTestId('EditIcon').closest('button')!);
      expect(screen.getByText('Edit relationship')).toBeVisible();

      // The doc moves on while the dialog is open.
      controller.removeRelationship('r1');

      await user.click(screen.getByRole('button', { name: 'Update' }));

      expect(screen.getByText('Edit relationship')).toBeVisible();
      expect(screen.getByText(/could not be saved/i)).toBeVisible();
    });

    it('closes the edit dialog when the update actually lands', async () => {
      const { wrapper } = createStudioHarness({
        initialState: { doc: { relationships: [REL] } },
      });
      const { user } = render(
        <RelationshipPanel relationships={[REL]} dataSources={DATA_SOURCES} />,
        { wrapper },
      );

      await user.click(screen.getByTestId('EditIcon').closest('button')!);
      await user.click(screen.getByRole('button', { name: 'Update' }));

      expect(screen.queryByText('Edit relationship')).toBe(null);
      expect(screen.queryByText(/could not be saved/i)).toBe(null);
    });
  });
});
