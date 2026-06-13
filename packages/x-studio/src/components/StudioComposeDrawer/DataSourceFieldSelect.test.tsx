import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioDataSource, StudioExpressionField } from '../../models';
import {
  DataSourceFieldSelect,
  type DataSourceFieldEntry,
  type DataSourceFieldSelectCalculatedFieldContext,
} from './DataSourceFieldSelect';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';

const controller = {
  addExpressionField: vi.fn(),
  updateExpressionField: vi.fn(),
};

vi.mock('../../context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../context')>();
  return {
    ...actual,
    useStudioController: () => controller,
  };
});

const ordersSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'total', label: 'Total', type: 'number' },
    { id: 'qty', label: 'Quantity', type: 'number' },
  ],
  rows: [],
};

const numericFields: DataSourceFieldEntry[] = [
  { id: 'total', label: 'Total', type: 'number', sourceId: 'orders', sourceLabel: 'Orders' },
  { id: 'qty', label: 'Quantity', type: 'number', sourceId: 'orders', sourceLabel: 'Orders' },
];

// One expression field on the reachable source, one on an unreachable source.
const expressionFields: StudioExpressionField[] = [
  {
    id: 'expr-reachable',
    label: 'Reachable Calc',
    sourceId: 'orders',
    type: 'number',
    isMeasure: false,
    expression: { operator: 'add', inputs: [{ id: 'total' }, { id: 'qty' }] },
  },
  {
    id: 'expr-unreachable',
    label: 'Unreachable Calc',
    sourceId: 'galaxy',
    type: 'number',
    isMeasure: false,
    expression: { type: 'number', value: 1 },
  },
];

const { render } = createRenderer();

describe('DataSourceFieldSelect — calculated field affordance (BL-179/180)', () => {
  it('renders the "Add calculated field…" entry in the dropdown when context is supplied', async () => {
    const calculatedField: DataSourceFieldSelectCalculatedFieldContext = {
      dataSource: ordersSource,
      expressionFields,
      reachableSourceIds: new Set(['orders']),
    };

    const { user } = render(
      <DataSourceFieldSelect
        value=""
        onChange={() => {}}
        fields={numericFields}
        label="Measure"
        calculatedField={calculatedField}
      />,
    );

    await user.click(screen.getByLabelText('Measure'));

    expect(screen.getByRole('button', { name: /Add calculated field/i })).toBeVisible();
  });

  it('hides the "Add calculated field…" entry when no context is supplied (feature disabled)', async () => {
    const { user } = render(
      <DataSourceFieldSelect value="" onChange={() => {}} fields={numericFields} label="Measure" />,
    );

    await user.click(screen.getByLabelText('Measure'));

    expect(screen.queryByRole('button', { name: /Add calculated field/i })).toBeNull();
  });

  it('scopes operand expression fields to reachable sources in the dialog (BL-180)', async () => {
    // Render the dialog directly with an existing field whose expression already uses a
    // field operand, so the operand field <Select> is shown without UI kind-switching.
    const editingField: StudioExpressionField = {
      id: 'expr-editing',
      label: 'Editing',
      sourceId: 'orders',
      type: 'number',
      isMeasure: false,
      expression: { operator: 'add', inputs: [{ id: 'total' }, { id: 'qty' }] },
    };

    const { user } = render(
      <StudioExpressionFieldDialog
        open
        onClose={() => {}}
        dataSource={ordersSource}
        expressionFields={[...expressionFields, editingField]}
        existingField={editingField}
        reachableSourceIds={new Set(['orders'])}
      />,
    );

    // The operand field picker shows the current field ("Total") — open it.
    const operandSelect = screen
      .getAllByRole('combobox')
      .find((el) => /Total/.test(el.textContent ?? ''));
    expect(operandSelect).toBeDefined();
    await user.click(operandSelect!);

    // The reachable expression field is offered; the unreachable one (source "galaxy")
    // is excluded (BL-180). Physical fields stay available.
    expect(screen.getByRole('option', { name: /Reachable Calc/i })).toBeVisible();
    expect(screen.queryByRole('option', { name: /Unreachable Calc/i })).toBeNull();
  });

  it('offers all expression fields as operands when no reachability scope is supplied', async () => {
    const editingField: StudioExpressionField = {
      id: 'expr-editing',
      label: 'Editing',
      sourceId: 'orders',
      type: 'number',
      isMeasure: false,
      expression: { operator: 'add', inputs: [{ id: 'total' }, { id: 'qty' }] },
    };

    const { user } = render(
      <StudioExpressionFieldDialog
        open
        onClose={() => {}}
        dataSource={ordersSource}
        expressionFields={[...expressionFields, editingField]}
        existingField={editingField}
      />,
    );

    const operandSelect = screen
      .getAllByRole('combobox')
      .find((el) => /Total/.test(el.textContent ?? ''));
    await user.click(operandSelect!);

    // Without a reachability scope, even the unreachable expression field is selectable.
    expect(screen.getByRole('option', { name: /Unreachable Calc/i })).toBeVisible();
  });
});
