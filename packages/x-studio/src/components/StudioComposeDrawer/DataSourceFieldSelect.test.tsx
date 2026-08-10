import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioWidget,
  StudioWidgetConfig,
} from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import {
  DataSourceFieldSelect,
  type DataSourceFieldEntry,
  type DataSourceFieldSelectCalculatedFieldContext,
} from './DataSourceFieldSelect';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';

const controller = {
  addExpressionField: vi.fn(),
  updateExpressionField: vi.fn(),
  // The picker snapshots `getState().doc` when the calculated-field dialog opens so the
  // create + assign pair can be folded into one undo entry (finding 6).
  getState: vi.fn(() => ({ doc: {} })),
  foldUndoHistorySince: vi.fn(),
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
// This component only uses `useStudioController`, but we override both hooks so the
// mocked surface is identical across files and the binding can't leak.
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

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
  beforeEach(() => {
    // This component does not read the selector; an empty state is sufficient.
    configureStudioContextMock({ getState: () => ({}), controller });
  });

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

// Finding 5 (architecture review): the selected-option resolution previously fell back to a
// bare-id lookup across EVERY source whenever the scoped (`valueSourceId`) lookup missed —
// e.g. `valueSourceId` names a source that was since removed/hidden — silently displaying a
// same-id field from a DIFFERENT source (wrong icon/group/source label) instead of showing
// the value as unresolved.
describe('DataSourceFieldSelect — selected-option resolution (finding 5)', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => ({}), controller });
  });

  // Two sources share the field id 'total', with different labels/types, so a wrong-source
  // match is observable via the displayed label.
  const collidingFields: DataSourceFieldEntry[] = [
    {
      id: 'total',
      label: 'Orders Total',
      type: 'number',
      sourceId: 'orders',
      sourceLabel: 'Orders',
    },
    {
      id: 'total',
      label: 'Invoices Total',
      type: 'string',
      sourceId: 'invoices',
      sourceLabel: 'Invoices',
    },
  ];

  it('resolves strictly against the provided valueSourceId, ignoring a same-id match elsewhere', () => {
    render(
      <DataSourceFieldSelect
        value="total"
        valueSourceId="invoices"
        onChange={() => {}}
        fields={collidingFields}
        label="Value field"
      />,
    );

    expect(screen.getByLabelText('Value field').getAttribute('value')).toBe('Invoices Total');
  });

  it('shows the value as unresolved when valueSourceId does not match any field (stale source), instead of falling back to a same-id field from a different source', () => {
    render(
      <DataSourceFieldSelect
        value="total"
        valueSourceId="removed-source"
        onChange={() => {}}
        fields={collidingFields}
        label="Value field"
      />,
    );

    // Must NOT display either colliding field's label — and (M11) must not be blank either,
    // which is indistinguishable from "never configured". The raw id is surfaced instead.
    const input = screen.getByLabelText('Value field') as HTMLInputElement;
    expect(input.value).not.toBe('Orders Total');
    expect(input.value).not.toBe('Invoices Total');
    expect(input.value).toContain('total');
  });

  it('falls back to the bare-id lookup only when no valueSourceId is supplied at all', () => {
    render(
      <DataSourceFieldSelect
        value="total"
        onChange={() => {}}
        fields={collidingFields}
        label="Value field"
      />,
    );

    // No sourceId to disambiguate with — the first matching field in list order wins,
    // preserving the pre-existing (documented) behavior for callers that don't have a
    // sourceId in scope.
    expect(screen.getByLabelText('Value field').getAttribute('value')).toBe('Orders Total');
  });
});

// ── M11: an unresolvable stored field id must not look like "never configured" ──
//
// A `required` picker holding a dangling field id used to render completely blank —
// visually identical to an unset field — while the canvas showed the widget's unsupported
// overlay, so nothing in the UI said WHICH field went missing. `GridConditionalFormatSection`
// (schema-drift `MenuItem`) and `GridSetupPanel` (`fieldInfo?.label ?? col.fieldId`) already
// handled this correctly; the shared picker now mirrors them.
describe('DataSourceFieldSelect — unresolvable stored field (M11)', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => ({}), controller });
  });

  it('surfaces the raw field id and an explanatory error instead of rendering blank', () => {
    render(
      <DataSourceFieldSelect
        value="removed_field"
        onChange={() => {}}
        fields={numericFields}
        label="Value field"
        required
      />,
    );

    // `getByRole`, not `getByLabelText('Value field')`: `required` makes MUI append an
    // `aria-hidden` asterisk INSIDE the `<label>`, so the label's textContent is
    // "Value field *" and an exact-string label query misses. The accessible name skips the
    // aria-hidden asterisk, so this matches what a screen reader actually announces.
    const input = screen.getByRole('combobox', { name: 'Value field' }) as HTMLInputElement;
    expect(input.value).toContain('removed_field');
    expect(screen.getByText(/removed_field/)).not.toBe(null);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('renders blank (not an error) when no field is configured at all', () => {
    render(
      <DataSourceFieldSelect
        value=""
        onChange={() => {}}
        fields={numericFields}
        label="Value field"
        required
      />,
    );

    // See the note above: `required` puts an aria-hidden asterisk in the label text.
    const input = screen.getByRole('combobox', { name: 'Value field' }) as HTMLInputElement;
    expect(input.value).toBe('');
    // A legitimately-unset required field is not a mistake — no error styling.
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
  });

  it('stops flagging the field once its source resolves again', () => {
    const { setProps } = render(
      <DataSourceFieldSelect
        value="total"
        valueSourceId="orders"
        onChange={() => {}}
        fields={[]}
        label="Value field"
      />,
    );
    expect((screen.getByLabelText('Value field') as HTMLInputElement).value).toContain('total');

    // The data source finishes loading and the field becomes resolvable.
    setProps({ fields: numericFields });

    expect((screen.getByLabelText('Value field') as HTMLInputElement).value).toBe('Total');
    expect(screen.getByLabelText('Value field').getAttribute('aria-invalid')).not.toBe('true');
  });
});

// ─── Finding 6: creating a calculated field from the picker is ONE undo step ───
//
// The gesture necessarily spans two commits — `StudioExpressionFieldDialog` commits
// `addExpressionField` itself, then calls `onSaved` so the picker's `onChange` can write the
// config key that selects the new field. Left unfolded, one gesture cost two Ctrl+Z presses,
// the first landing on "field created but not assigned" — a state the user never saw. Every
// source-adopting setup panel already folds its multi-mutation gestures into one commit; this
// runs against a REAL `StudioController` so the actual undo stack is observed.
describe('DataSourceFieldSelect — calculated-field creation folds to one undo step (finding 6)', () => {
  it('reverts both the new field and its assignment with a single undo', async () => {
    const realController = new StudioController({
      doc: {
        widgets: {
          'widget-1': {
            id: 'widget-1',
            kind: 'kpi',
            title: 'Revenue',
            sourceId: 'orders',
            config: { kpiValueField: 'total', kpiAggregation: 'sum' },
          } as StudioWidget,
        },
      },
      runtime: { dataSources: { orders: ordersSource } },
    });
    configureStudioContextMock({
      getState: () => realController.getState(),
      controller: realController,
    });

    const { user } = render(
      <DataSourceFieldSelect
        value="total"
        onChange={(fieldId) =>
          realController.updateWidgetConfig('widget-1', { kpiValueField: fieldId })
        }
        fields={numericFields}
        label="Measure"
        calculatedField={{ dataSource: ordersSource, expressionFields: [] }}
      />,
    );

    await user.click(screen.getByLabelText('Measure'));
    await user.click(screen.getByRole('button', { name: /Add calculated field/i }));
    // `required` makes MUI append an aria-hidden asterisk inside the <label>, so an exact
    // `getByLabelText('Name')` would miss — the accessible name skips it.
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Margin');
    await user.click(screen.getByRole('button', { name: 'Add Field' }));

    // The gesture reached the intended state: field created AND selected.
    const created = realController.getState().doc.semanticModel.expressionFields[0];
    expect(created?.label).toBe('Margin');
    expect(
      (realController.getState().doc.widgets['widget-1'].config as StudioWidgetConfig)
        .kpiValueField,
    ).toBe(created.id);

    // Exactly ONE undo entry: the single undo reverts BOTH commits together...
    expect(realController.canUndo()).toBe(true);
    realController.undo();
    expect(realController.getState().doc.semanticModel.expressionFields).toEqual([]);
    expect(
      (realController.getState().doc.widgets['widget-1'].config as StudioWidgetConfig)
        .kpiValueField,
    ).toBe('total');
    // ...and nothing remains to undo, proving the gesture pushed only one entry.
    expect(realController.canUndo()).toBe(false);
  });
});
