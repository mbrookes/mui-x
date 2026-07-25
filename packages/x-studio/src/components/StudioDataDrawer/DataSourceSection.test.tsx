import * as React from 'react';
import { createRenderer, screen, fireEvent, within } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { StudioDataSource, StudioExpressionField } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { DataSourceSection } from './DataSourceSection';

// Tier2 defense-in-depth fix: `DataSourceSection`'s `evaluateMeasure` call previously had
// no local try/catch, unlike `ExpressionPreview.tsx`'s equivalent call. The evaluator has
// no throw statements today (and an explicit cycle guard), so this mock is what makes the
// throwing path reachable at all — it forces `evaluateMeasure` to throw so the fix's
// try/catch can be pinned against a future evaluator change that does introduce one.
let shouldThrowInEvaluateMeasure = false;

vi.mock('../../utils/expressionEvaluator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/expressionEvaluator')>();
  return {
    ...actual,
    evaluateMeasure: (...args: Parameters<typeof actual.evaluateMeasure>) => {
      if (shouldThrowInEvaluateMeasure) {
        throw new Error('evaluator exploded');
      }
      return actual.evaluateMeasure(...args);
    },
  };
});

const { render } = createRenderer();

const SOURCE: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'amount', label: 'Amount', type: 'number' },
    { id: 'region', label: 'Region', type: 'string' },
  ],
  rows: [{ amount: 1, region: 'x' }],
};

const EXPR_FIELD: StudioExpressionField = {
  id: 'e1',
  label: 'Calc',
  sourceId: 'orders',
  isMeasure: false,
  expression: {} as StudioExpressionField['expression'],
  type: 'number',
};

function setup(options: { isEditMode?: boolean; expressionFields?: StudioExpressionField[] } = {}) {
  const { controller, wrapper } = createStudioHarness();
  const selectFieldSpy = vi.spyOn(controller, 'selectField');
  const removeExprSpy = vi.spyOn(controller, 'removeExpressionField');
  const view = render(
    <DataSourceSection
      source={SOURCE}
      expressionFields={options.expressionFields ?? [EXPR_FIELD]}
      dataSources={{ orders: SOURCE }}
      relationships={[]}
      isEditMode={options.isEditMode ?? true}
    />,
    { wrapper },
  );
  return { ...view, controller, selectFieldSpy, removeExprSpy };
}

// The section starts collapsed (`open = false`), so every field row and the "Add calculated
// field" button live inside a closed `<Collapse>`. Testing Library ignores CSS visibility, so
// clicking them directly passes even if the expand toggle is broken — go through the header
// the way a user must.
function expandSection() {
  fireEvent.click(screen.getByText('Orders'));
}

describe('DataSourceSection', () => {
  it('renders the source label and its physical fields once expanded', () => {
    setup();
    expect(screen.getByText('Orders')).not.toBe(null);
    expandSection();
    expect(screen.getByText('Amount')).toBeVisible();
    expect(screen.getByText('Region')).toBeVisible();
  });

  it('toggles the expand/collapse icon when the header is clicked', () => {
    setup();
    expect(screen.getByTestId('ExpandMoreIcon')).not.toBe(null);
    expandSection();
    expect(screen.getByTestId('ExpandLessIcon')).not.toBe(null);
  });

  it('selects a physical field when its row is clicked (edit mode)', () => {
    const { selectFieldSpy } = setup();
    expandSection();
    fireEvent.click(screen.getByText('Amount'));
    expect(selectFieldSpy).toHaveBeenCalledWith('orders', 'amount');
  });

  it('opens the expression-field dialog from the add button (edit mode)', () => {
    setup();
    expandSection();
    fireEvent.click(screen.getByText('Add calculated field'));
    expect(screen.getByText('New Calculated Field')).not.toBe(null);
  });

  it('removes an expression field from its delete action', () => {
    const { removeExprSpy } = setup();
    expandSection();
    fireEvent.click(screen.getByTestId('DeleteIcon').closest('button')!);
    expect(removeExprSpy).toHaveBeenCalledWith('e1');
  });

  it('hides the add-field affordance outside edit mode', () => {
    setup({ isEditMode: false });
    expandSection();
    expect(screen.queryByText('Add calculated field')).toBe(null);
  });

  // The drawer's "Add calculated field" used to open the dialog with no reachable-source
  // scope, so the operand picker offered expression fields owned by completely unrelated
  // sources. Selecting one passed validation and saved a field that can only ever evaluate to
  // null against this source's rows.
  it('scopes the calculated-field dialog operands to sources related to this one', async () => {
    const unrelated: StudioExpressionField = {
      id: 'ltv',
      label: 'Lifetime value',
      sourceId: 'customers',
      isMeasure: false,
      expression: { type: 'number', value: 1 } as StudioExpressionField['expression'],
      type: 'number',
    };
    const { user } = setup({ expressionFields: [EXPR_FIELD, unrelated] });
    expandSection();
    fireEvent.click(screen.getByText('Add calculated field'));

    // Turn the first operand into a field reference so the operand picker is rendered.
    await user.click(screen.getAllByRole('combobox', { name: 'Input type' })[0]);
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Field' }));

    await user.click(screen.getByRole('combobox', { name: 'Field' }));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Amount')).not.toBe(null);
    expect(within(listbox).getByText('Calc')).not.toBe(null);
    expect(within(listbox).queryByText('Lifetime value')).toBe(null);
  });

  describe('evaluateMeasure error handling (Tier2 defense-in-depth fix)', () => {
    beforeEach(() => {
      shouldThrowInEvaluateMeasure = false;
    });

    it('contains a throw from evaluateMeasure instead of crashing the section render', () => {
      shouldThrowInEvaluateMeasure = true;
      const measureField: StudioExpressionField = {
        ...EXPR_FIELD,
        id: 'm1',
        label: 'Total',
        isMeasure: true,
      };
      const { wrapper } = createStudioHarness();

      expect(() =>
        render(
          <div>
            <div data-testid="sibling">Canary content outside the section</div>
            <DataSourceSection
              source={SOURCE}
              expressionFields={[measureField]}
              dataSources={{ orders: SOURCE }}
              relationships={[]}
              isEditMode
            />
          </div>,
          { wrapper },
        ),
      ).not.toThrow();

      // The sibling survives, and the measure field row itself still renders — only the
      // aggregate preview value is dropped (falls back to `undefined`, same as when the
      // field has no rows), instead of the throw propagating up and taking the tree down.
      expect(screen.getByTestId('sibling')).not.toBe(null);
      expect(screen.getByText('Total')).not.toBe(null);
    });

    it('renders the field row normally when evaluateMeasure does not throw', () => {
      shouldThrowInEvaluateMeasure = false;
      const measureField: StudioExpressionField = {
        ...EXPR_FIELD,
        id: 'm1',
        label: 'Total',
        isMeasure: true,
      };
      const { wrapper } = createStudioHarness();
      render(
        <DataSourceSection
          source={SOURCE}
          expressionFields={[measureField]}
          dataSources={{ orders: SOURCE }}
          relationships={[]}
          isEditMode
        />,
        { wrapper },
      );
      expect(screen.getByText('Total')).not.toBe(null);
    });
  });
});
