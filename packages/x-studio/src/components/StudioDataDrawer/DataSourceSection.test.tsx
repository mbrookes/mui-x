import * as React from 'react';
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
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

function setup(options: { isEditMode?: boolean } = {}) {
  const { controller, wrapper } = createStudioHarness();
  const selectFieldSpy = vi.spyOn(controller, 'selectField');
  const removeExprSpy = vi.spyOn(controller, 'removeExpressionField');
  render(
    <DataSourceSection
      source={SOURCE}
      expressionFields={[EXPR_FIELD]}
      dataSources={{ orders: SOURCE }}
      relationships={[]}
      isEditMode={options.isEditMode ?? true}
    />,
    { wrapper },
  );
  return { controller, selectFieldSpy, removeExprSpy };
}

describe('DataSourceSection', () => {
  it('renders the source label and its physical fields', () => {
    setup();
    expect(screen.getByText('Orders')).not.toBe(null);
    expect(screen.getByText('Amount')).not.toBe(null);
    expect(screen.getByText('Region')).not.toBe(null);
  });

  it('toggles the expand/collapse icon when the header is clicked', () => {
    setup();
    expect(screen.getByTestId('ExpandMoreIcon')).not.toBe(null);
    fireEvent.click(screen.getByText('Orders'));
    expect(screen.getByTestId('ExpandLessIcon')).not.toBe(null);
  });

  it('selects a physical field when its row is clicked (edit mode)', () => {
    const { selectFieldSpy } = setup();
    fireEvent.click(screen.getByText('Amount'));
    expect(selectFieldSpy).toHaveBeenCalledWith('orders', 'amount');
  });

  it('opens the expression-field dialog from the add button (edit mode)', () => {
    setup();
    fireEvent.click(screen.getByText('Add calculated field'));
    expect(screen.getByText('New Calculated Field')).not.toBe(null);
  });

  it('removes an expression field from its delete action', () => {
    const { removeExprSpy } = setup();
    fireEvent.click(screen.getByTestId('DeleteIcon').closest('button')!);
    expect(removeExprSpy).toHaveBeenCalledWith('e1');
  });

  it('hides the add-field affordance outside edit mode', () => {
    setup({ isEditMode: false });
    expect(screen.queryByText('Add calculated field')).toBe(null);
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
