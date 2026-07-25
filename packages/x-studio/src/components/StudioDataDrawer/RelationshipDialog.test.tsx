import * as React from 'react';
import { createRenderer, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioDataSource } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { RelationshipDialog, type RelationshipFormState } from './RelationshipDialog';

const { render } = createRenderer();

const DATA_SOURCES: Record<string, StudioDataSource> = {
  orders: {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'customerId', label: 'Customer', type: 'string' },
      { id: 'regionId', label: 'Region', type: 'string' },
    ],
  },
  customers: {
    id: 'customers',
    label: 'Customers',
    fields: [{ id: 'id', label: 'ID', type: 'string' }],
  },
  products: {
    id: 'products',
    label: 'Products',
    fields: [
      { id: 'orderId', label: 'Order ref', type: 'string' },
      { id: 'customerId', label: 'Customer ref', type: 'string' },
    ],
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

// A valid many-to-many form using `products` as the junction table between
// `orders` and `customers`.
const VALID_M2M_FORM: RelationshipFormState = {
  sourceId: 'orders',
  sourceField: 'customerId',
  targetId: 'customers',
  targetField: 'id',
  type: 'many-to-many',
  junctionSourceId: 'products',
  junctionSourceField: 'orderId',
  junctionTargetField: 'customerId',
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

  it('enables Update for a valid many-to-many form with a distinct junction', () => {
    setup({ initial: VALID_M2M_FORM });
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', false);
  });

  // Regression for finding 2.11: a junction data source that is the same as one of the
  // endpoints is degenerate (it isn't a real many-to-many join) and must not be
  // authorable, even though the junction Select's own options omit the endpoints going
  // forward — a stale/injected form value must still fail validation.
  it('keeps Update disabled when the junction source is the same as an endpoint source', () => {
    setup({
      initial: {
        ...VALID_M2M_FORM,
        junctionSourceId: 'orders',
        junctionSourceField: 'customerId',
        junctionTargetField: 'regionId',
      },
    });
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', true);
  });

  it('keeps Update disabled when the junction source is the same as the endpoint target', () => {
    setup({
      initial: {
        ...VALID_M2M_FORM,
        junctionSourceId: 'customers',
        junctionSourceField: 'id',
        junctionTargetField: 'id',
      },
    });
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', true);
  });

  // Regression for finding 2.11: the two junction join fields resolving to the same
  // column is degenerate (it never actually joins two different keys).
  it('keeps Update disabled when both junction join fields are the same column', () => {
    setup({
      initial: {
        ...VALID_M2M_FORM,
        junctionSourceField: 'orderId',
        junctionTargetField: 'orderId',
      },
    });
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', true);
  });

  // Regression for finding 2.11: changing the source/target to the data source currently
  // used as the junction must clear the (now-degenerate) junction trio rather than
  // leaving it stale and out-of-range in form state.
  it('clears the junction trio when the source is changed to collide with it', async () => {
    const { user } = setup({ initial: VALID_M2M_FORM });
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', false);

    // combobox order: type(0), source(1), sourceField(2), target(3), targetField(4),
    // junctionSourceId(5), junctionSourceField(6), junctionTargetField(7).
    const sourceSelect = screen.getAllByRole('combobox')[1];
    await user.click(sourceSelect);
    await user.click(within(screen.getByRole('listbox')).getByText('Products'));

    // sourceField is reset by the ordinary source-change behavior, and the junction
    // trio should also now be cleared since it collided with the newly picked source.
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', true);

    // Re-fill the (now empty) source join field so the only thing keeping the form
    // invalid is the junction — proving the junction was actually cleared, and not
    // merely shadowed by the unrelated sourceField reset.
    const sourceFieldSelect = screen.getAllByRole('combobox')[2];
    await user.click(sourceFieldSelect);
    await user.click(within(screen.getByRole('listbox')).getByText('Order ref'));

    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', true);

    const junctionSourceSelect = screen.getAllByRole('combobox')[5];
    expect(junctionSourceSelect.textContent?.replace(/\u200B/g, '')).toBe('');
  });

  // The Target Select omits whatever Source currently is. Changing Source to the data source
  // that is already the Target left `form.targetId` pointing at an option that no longer
  // existed, so the control blanked itself (with an out-of-range warning) even though the
  // value was still in form state. It now keeps the selected value listed, exactly like the
  // junction Select, and `isValid` is what blocks the save.
  it('keeps the Target select rendering its value when Source is changed to the current Target', async () => {
    const { user } = setup({ initial: VALID_FORM });
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', false);

    // combobox order: type(0), source(1), sourceField(2), target(3), targetField(4).
    const sourceSelect = screen.getAllByRole('combobox')[1];
    await user.click(sourceSelect);
    await user.click(within(screen.getByRole('listbox')).getByText('Customers'));

    const targetSelect = screen.getAllByRole('combobox')[3];
    expect(targetSelect.textContent?.replace(/\u200B/g, '')).toBe('Customers');
    // The degenerate self-join still can't be saved.
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', true);
  });

  it('still omits the source from the Target options when they differ', async () => {
    const { user } = setup({ initial: VALID_FORM });

    const targetSelect = screen.getAllByRole('combobox')[3];
    await user.click(targetSelect);
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).queryByText('Orders')).toBe(null);
    expect(within(listbox).getByText('Products')).not.toBe(null);
  });

  it('clears the junction trio when the target is changed to collide with it', async () => {
    const { user } = setup({ initial: VALID_M2M_FORM });
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', false);

    // combobox order: type(0), source(1), sourceField(2), target(3), targetField(4),
    // junctionSourceId(5), junctionSourceField(6), junctionTargetField(7).
    const targetSelect = screen.getAllByRole('combobox')[3];
    await user.click(targetSelect);
    await user.click(within(screen.getByRole('listbox')).getByText('Products'));

    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', true);

    const targetFieldSelect = screen.getAllByRole('combobox')[4];
    await user.click(targetFieldSelect);
    await user.click(within(screen.getByRole('listbox')).getByText('Order ref'));

    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', true);

    const junctionSourceSelect = screen.getAllByRole('combobox')[5];
    expect(junctionSourceSelect.textContent?.replace(/\u200B/g, '')).toBe('');
  });
});
