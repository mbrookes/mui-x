import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioDataSource, StudioExpression, StudioExpressionField } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioExpressionFieldDialog } from './StudioExpressionFieldDialog';

const { render } = createRenderer();

const DATA_SOURCE: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'amount', label: 'Amount', type: 'number' },
    { id: 'cost', label: 'Cost', type: 'number' },
  ],
};

const EXPRESSION: StudioExpression = {
  operator: 'add',
  inputs: [
    { type: 'number', value: 0 },
    { type: 'number', value: 0 },
  ],
} as StudioExpression;

function setup(props: Partial<React.ComponentProps<typeof StudioExpressionFieldDialog>> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const { controller, wrapper } = createStudioHarness();
  const addSpy = vi.spyOn(controller, 'addExpressionField');
  const updateSpy = vi.spyOn(controller, 'updateExpressionField');
  const view = render(
    <StudioExpressionFieldDialog
      open
      onClose={onClose}
      dataSource={DATA_SOURCE}
      expressionFields={[]}
      onSaved={onSaved}
      {...props}
    />,
    { wrapper },
  );
  return { ...view, controller, addSpy, updateSpy, onClose, onSaved };
}

describe('StudioExpressionFieldDialog', () => {
  it('shows the "new" title and an "Add Field" action in create mode', () => {
    setup();
    expect(screen.getByText('New Calculated Field')).not.toBe(null);
    expect(screen.getByRole('button', { name: 'Add Field' })).not.toBe(null);
  });

  it('disables saving until a name is entered', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Add Field' })).toHaveProperty('disabled', true);
  });

  it('enables saving once a name is entered', async () => {
    const { user } = setup();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Profit');
    expect(screen.getByRole('button', { name: 'Add Field' })).toHaveProperty('disabled', false);
  });

  it('adds a new expression field on save and reports the new id', async () => {
    const { user, addSpy, onSaved, onClose } = setup();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Profit');
    await user.click(screen.getByRole('button', { name: 'Add Field' }));

    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^expr-/),
        label: 'Profit',
        sourceId: 'orders',
        isMeasure: false,
        type: 'number',
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(expect.stringMatching(/^expr-/));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('updates an existing field in edit mode without calling onSaved', async () => {
    const existingField: StudioExpressionField = {
      id: 'expr-1',
      label: 'Margin',
      sourceId: 'orders',
      isMeasure: false,
      expression: EXPRESSION,
    };
    const { user, updateSpy, onSaved, onClose } = setup({
      existingField,
      expressionFields: [existingField],
    });

    expect(screen.getByText('Edit Calculated Field')).not.toBe(null);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateSpy).toHaveBeenCalledWith(
      'expr-1',
      expect.objectContaining({ label: 'Margin', isMeasure: false, type: 'number' }),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes without saving when Cancel is clicked', async () => {
    const { user, addSpy, onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(addSpy).not.toHaveBeenCalled();
  });

  // Regression coverage for architecture-review finding 2.2: the "Output type:" caption
  // used to be hardcoded English even though the rest of this dialog resolves strings
  // through `useStudioLocaleText`.
  it('renders the "Output type" caption translated under a non-English locale', async () => {
    const { frLocaleText } = await import('../../locales/fr');
    const { wrapper } = createStudioHarness({
      providerProps: { localeText: frLocaleText },
    });
    render(
      <StudioExpressionFieldDialog
        open
        onClose={() => {}}
        dataSource={DATA_SOURCE}
        expressionFields={[]}
      />,
      { wrapper },
    );

    expect(screen.getByText('Type de sortie :')).not.toBe(null);
    expect(screen.queryByText('Output type:')).toBe(null);
  });
});
