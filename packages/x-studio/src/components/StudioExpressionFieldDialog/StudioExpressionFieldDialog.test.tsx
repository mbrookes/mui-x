import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { StudioDataSource, StudioExpression, StudioExpressionField } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioExpressionFieldDialog } from './StudioExpressionFieldDialog';

// Tier2 fix: `StudioExpressionFieldDialog` previously had no error boundary of its own —
// every existing render site happened to sit inside some other drawer's
// `StudioDrawerErrorBoundary` (e.g. `DataSourceSection.tsx` under `StudioDataDrawer`), so
// its safety was incidental. This mutable flag lets a single test force
// `ExpressionPreview` (one of the two components rendering user/AI-authored expression
// trees, alongside `ExpressionNodeEditor`) to throw, without disturbing every other test
// in this file that renders the dialog normally.
let throwFromExpressionPreview = false;

vi.mock('./ExpressionPreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ExpressionPreview')>();
  return {
    ...actual,
    ExpressionPreview: (props: React.ComponentProps<typeof actual.ExpressionPreview>) => {
      if (throwFromExpressionPreview) {
        throw new Error('expression preview exploded');
      }
      return <actual.ExpressionPreview {...props} />;
    },
  };
});

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

  // Regression coverage for architecture-review finding 3.11: the previous
  // `expr-${Date.now()}` id was recomputed on every render in create mode, churning
  // the `draftField`/`validationErrors` memos (both depend on `fieldId`) on every
  // keystroke until save.
  it('does not regenerate the field id per keystroke', async () => {
    // A global `Date.now()` call-count assertion is too broad — React/MUI/test-harness
    // internals call it for unrelated reasons on every render, independent of this
    // component. Instead, mint an INCREASING sequence of timestamps and verify the
    // *saved* field's id embeds the first one (from mount), not a later one that would
    // only appear if the id were regenerated on a subsequent keystroke's render.
    let nextTimestamp = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      const value = nextTimestamp;
      nextTimestamp += 1;
      return value;
    });
    const { user, addSpy } = setup();
    await screen.findByRole('button', { name: 'Add Field' });

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Profit Margin');
    await user.click(screen.getByRole('button', { name: 'Add Field' }));

    // The id's timestamp segment must be the FIRST minted value (from mount) — a
    // module-level counter suffix makes the full id order-dependent across this
    // file's tests, so only the timestamp portion is asserted here.
    const created = addSpy.mock.calls[0][0] as { id: string };
    expect(created.id).toMatch(/^expr-1700000000000-\d+$/);
  });

  // Regression coverage for finding 3.11: a plain `expr-${Date.now()}` collides
  // whenever two fields are created within the same millisecond, silently no-op'ing
  // the second create via the reducer's duplicate-id idempotency.
  it('mints unique ids for separately-created fields even when Date.now() does not advance', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    const first = setup();
    await first.user.type(screen.getByRole('textbox', { name: 'Name' }), 'A');
    await first.user.click(screen.getByRole('button', { name: 'Add Field' }));
    const firstId = first.addSpy.mock.calls[0][0].id;
    first.unmount();

    const second = setup();
    await second.user.type(screen.getByRole('textbox', { name: 'Name' }), 'B');
    await second.user.click(screen.getByRole('button', { name: 'Add Field' }));
    const secondId = second.addSpy.mock.calls[0][0].id;

    expect(firstId).not.toBe(secondId);
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

  describe('error boundary (Tier2 fix)', () => {
    afterEach(() => {
      throwFromExpressionPreview = false;
    });

    it('contains a render throw when rendered standalone, not nested under another drawer boundary', () => {
      throwFromExpressionPreview = true;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { wrapper } = createStudioHarness();

      expect(() =>
        render(
          <div>
            <div data-testid="sibling">Canary content outside the dialog</div>
            <StudioExpressionFieldDialog
              open
              onClose={() => {}}
              dataSource={DATA_SOURCE}
              expressionFields={[]}
            />
          </div>,
          { wrapper },
        ),
      ).not.toThrow();

      // The sibling survives -- without the dialog's own boundary, React would have
      // unmounted the whole render tree (nothing in it would catch the throw), since this
      // dialog isn't nested under any other drawer's `StudioDrawerErrorBoundary` here.
      expect(screen.getByTestId('sibling')).not.toBe(null);
      // `StudioDrawerErrorBoundary` renders the thrown error's own message.
      expect(screen.getByText('expression preview exploded')).not.toBe(null);
      // Dialog chrome outside the boundary (title, actions) is unaffected.
      expect(screen.getByText('New Calculated Field')).not.toBe(null);
      expect(screen.getByRole('button', { name: 'Cancel' })).not.toBe(null);

      errorSpy.mockRestore();
    });
  });
});
