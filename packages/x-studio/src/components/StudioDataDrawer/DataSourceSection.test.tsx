import * as React from 'react';
import { act, createRenderer, screen, fireEvent, waitFor, within } from '@mui/internal-test-utils';
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

vi.mock('@mui/x-studio-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mui/x-studio-core/utils')>();
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
  expression: { type: 'number', value: 0 } as StudioExpressionField['expression'],
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

    // `measureValue` reaches the DOM only through `ExpressionFieldRow`'s hover tooltip. The
    // previous pair of tests never opened it, so both asserted only that the row label rendered —
    // identical assertions that passed whether `evaluateMeasure` returned, threw, or was never
    // called at all. Both now open the tooltip, which is the only place the two outcomes differ.
    const MEASURE_FIELD: StudioExpressionField = {
      ...EXPR_FIELD,
      id: 'm1',
      label: 'Total',
      isMeasure: true,
      // `sum(amount)` over SOURCE's single row → 1.
      expression: { id: 'amount', aggregation: 'sum' } as StudioExpressionField['expression'],
    };

    it('contains a throw from evaluateMeasure instead of crashing the section render', async () => {
      shouldThrowInEvaluateMeasure = true;
      const { wrapper } = createStudioHarness();

      let view: ReturnType<typeof render> | undefined;
      expect(() => {
        view = render(
          <div>
            <div data-testid="sibling">Canary content outside the section</div>
            <DataSourceSection
              source={SOURCE}
              expressionFields={[MEASURE_FIELD]}
              dataSources={{ orders: SOURCE }}
              relationships={[]}
              isEditMode
            />
          </div>,
          { wrapper },
        );
      }).not.toThrow();

      // The sibling survives and the measure row still renders …
      expect(screen.getByTestId('sibling')).toBeVisible();
      expandSection();
      expect(screen.getByText('Total')).toBeVisible();

      // … but the aggregate is dropped: `measureValue` falls back to `undefined`, so
      // `ExpressionFieldRow` passes no preview rows and `FieldPreviewTooltip` renders the trigger
      // untouched — no tooltip at all, exactly as for a field with no rows. This is the assertion
      // that distinguishes the caught throw from a successful evaluation (the sibling test below
      // opens the tooltip and reads the value out of it).
      await view!.user.hover(screen.getByText('Total'));
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 200);
        });
      });
      expect(screen.queryByRole('tooltip')).toBe(null);
    });

    it('shows the computed aggregate in the preview when evaluateMeasure does not throw', async () => {
      shouldThrowInEvaluateMeasure = false;
      const { wrapper } = createStudioHarness();
      const { user } = render(
        <DataSourceSection
          source={SOURCE}
          expressionFields={[MEASURE_FIELD]}
          dataSources={{ orders: SOURCE }}
          relationships={[]}
          isEditMode
        />,
        { wrapper },
      );
      expandSection();

      await user.hover(screen.getByText('Total'));
      const tooltip = await screen.findByRole('tooltip');
      expect(within(tooltip).getByText('1')).toBeVisible();
    });
  });

  // ── H1: an adapter-backed source has never delivered its rows ──────────────
  //
  // `StudioDataSource.rows` is `undefined` (not `[]`) for a source whose data comes from an
  // adapter until the host imperatively calls `setDataSourceRows`. `?? 0` reported that as a
  // measured "0 rows".
  describe('adapter-backed source with undefined rows (H1)', () => {
    const ADAPTER_SOURCE: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: SOURCE.fields,
      adapter: { getRows: async () => ({ rows: [] }) },
    };

    it('does not claim "0 rows" for a source that was never counted', () => {
      const { wrapper } = createStudioHarness();
      render(
        <DataSourceSection
          source={ADAPTER_SOURCE}
          expressionFields={[]}
          dataSources={{ orders: ADAPTER_SOURCE }}
          relationships={[]}
          isEditMode
        />,
        { wrapper },
      );

      expect(screen.queryByText(/0 rows/)).toBe(null);
      expect(screen.getByText(/2 fields · Loading/)).toBeVisible();
    });

    it('still says "0 rows" when the source genuinely delivered an empty set', () => {
      const emptySource: StudioDataSource = { ...ADAPTER_SOURCE, rows: [] };
      const { wrapper } = createStudioHarness();
      render(
        <DataSourceSection
          source={emptySource}
          expressionFields={[]}
          dataSources={{ orders: emptySource }}
          relationships={[]}
          isEditMode
        />,
        { wrapper },
      );

      expect(screen.getByText(/2 fields · 0 rows/)).toBeVisible();
    });
  });

  // ── H7: deleting a referenced calculated field asks first ──────────────────
  //
  // `StudioController.removeExpressionField`'s JSDoc documents this confirmation; the count was
  // being read and discarded, and the field deleted on a single click, silently blanking every
  // widget that referenced it.
  describe('delete confirmation for a referenced calculated field (H7)', () => {
    const REFERENCING_WIDGET = {
      id: 'w1',
      kind: 'kpi' as const,
      title: 'Total',
      sourceId: 'orders',
      config: { kpiValueField: 'e1' },
    };

    it('asks before deleting a field that is still referenced', async () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: { expressionFields: [EXPR_FIELD], widgets: { w1: REFERENCING_WIDGET } },
        },
      });
      const removeSpy = vi.spyOn(controller, 'removeExpressionField');
      const { user } = render(
        <DataSourceSection
          source={SOURCE}
          expressionFields={[EXPR_FIELD]}
          dataSources={{ orders: SOURCE }}
          relationships={[]}
          isEditMode
        />,
        { wrapper },
      );
      expandSection();

      await user.click(screen.getByTestId('DeleteIcon').closest('button')!);

      // Nothing deleted yet — the confirmation names the field and how many places use it.
      expect(removeSpy).not.toHaveBeenCalled();
      expect(screen.getByText('Delete calculated field?')).toBeVisible();
      expect(screen.getByText(/"Calc" is used by 1 /)).toBeVisible();

      // Confirming goes through; the controller's own dev warning about the stranded references
      // is expected here (it is the same information the confirmation just showed).
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        expect(removeSpy).toHaveBeenCalledWith('e1');
      } finally {
        warn.mockRestore();
      }
    });

    it('keeps the field when the confirmation is cancelled', async () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: { expressionFields: [EXPR_FIELD], widgets: { w1: REFERENCING_WIDGET } },
        },
      });
      const removeSpy = vi.spyOn(controller, 'removeExpressionField');
      const { user } = render(
        <DataSourceSection
          source={SOURCE}
          expressionFields={[EXPR_FIELD]}
          dataSources={{ orders: SOURCE }}
          relationships={[]}
          isEditMode
        />,
        { wrapper },
      );
      expandSection();

      await user.click(screen.getByTestId('DeleteIcon').closest('button')!);
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(removeSpy).not.toHaveBeenCalled();
      // `waitFor`: MUI's Dialog unmounts at the end of its Fade exit transition, so it is still in
      // the tree for a frame after `open` flips to false.
      await waitFor(() => {
        expect(screen.queryByText('Delete calculated field?')).toBe(null);
      });
    });

    it('deletes an unreferenced field in one click, with no confirmation', async () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: { doc: { expressionFields: [EXPR_FIELD] } },
      });
      const removeSpy = vi.spyOn(controller, 'removeExpressionField');
      const { user } = render(
        <DataSourceSection
          source={SOURCE}
          expressionFields={[EXPR_FIELD]}
          dataSources={{ orders: SOURCE }}
          relationships={[]}
          isEditMode
        />,
        { wrapper },
      );
      expandSection();

      await user.click(screen.getByTestId('DeleteIcon').closest('button')!);

      expect(screen.queryByText('Delete calculated field?')).toBe(null);
      expect(removeSpy).toHaveBeenCalledWith('e1');
    });
  });

  // The header caption used to be assembled as `${count} ${localeText.dataDrawerRowsLabel}`
  // with a bare plural noun, so it read "1 rows" and "1 fields" in EVERY locale — and no
  // language that inflects the noun could ever produce the right string through that shape.
  // The tokens now take the count.
  describe('row/field count pluralization', () => {
    function renderWith(source: StudioDataSource, providerProps?: { localeText?: any }) {
      const { wrapper } = createStudioHarness({ providerProps });
      return render(
        <DataSourceSection
          source={source}
          expressionFields={[]}
          dataSources={{ [source.id]: source }}
          relationships={[]}
          isEditMode={false}
        />,
        { wrapper },
      );
    }

    it('uses the singular form for exactly one row and one field', () => {
      renderWith({
        id: 'orders',
        label: 'Orders',
        fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
        rows: [{ amount: 1 }],
      });

      expect(screen.getByText('1 field · 1 row')).not.toBe(null);
      expect(screen.queryByText(/1 rows/)).toBe(null);
      expect(screen.queryByText(/1 fields/)).toBe(null);
    });

    it('uses the plural form for other counts', () => {
      renderWith(SOURCE);
      expect(screen.getByText('2 fields · 1 row')).not.toBe(null);
    });

    it('lets a locale bundle place the number and inflect the noun itself', () => {
      renderWith(
        {
          id: 'orders',
          label: 'Orders',
          fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
          rows: [{ amount: 1 }],
        },
        {
          localeText: {
            dataDrawerRowsLabel: (count: number) => `Zeilen: ${count}`,
            dataDrawerFieldsLabel: (count: number) => `Felder: ${count}`,
          },
        },
      );

      expect(screen.getByText('Felder: 1 · Zeilen: 1')).not.toBe(null);
    });
  });
});
