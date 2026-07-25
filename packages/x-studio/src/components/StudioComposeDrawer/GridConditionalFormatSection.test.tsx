import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioConditionalFormat, StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { GridConditionalFormatSection } from './GridConditionalFormatSection';

const controller = {
  updateWidgetConfig: vi.fn(),
};

function makeRule(overrides: Partial<StudioConditionalFormat> = {}): StudioConditionalFormat {
  return {
    fieldId: 'amount',
    operator: 'greater_than',
    value: 10,
    style: { backgroundColor: '#ffcdd2', color: '#b71c1c' },
    ...overrides,
  };
}

const mockState = {
  doc: {
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'grid',
        sourceId: 'orders',
        title: 'Orders',
        config: { gridConditionalFormats: [makeRule()] } as StudioWidgetConfig,
      },
    },
  },
  runtime: {
    dataSources: {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'amount', label: 'Amount', type: 'number' },
        ],
        rows: [],
      },
    },
  },
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

// ─── Conditional-format value input: no silent 0/NaN (architecture review 3.5) ─
//
// Clearing a numeric rule value used to store `0` (a silent semantic change from
// "no value" to "compare to zero"), and a partially-typed non-number stored
// `NaN`, which then rendered literally via `String(rule.value)`.
//
// Finding 1.14: the numeric value input used to parse+commit on every keystroke,
// so "0." collapsed to "0" (the decimal point eaten) and "-" instantly committed
// `undefined` before the user could finish typing a negative number. It now
// buffers the displayed text locally and only parses/commits on blur.

describe('GridConditionalFormatSection', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'grid',
      sourceId: 'orders',
      title: 'Orders',
      config: { gridConditionalFormats: [makeRule()] } as StudioWidgetConfig,
    };
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('clearing the numeric value stores undefined, not 0, on blur', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value');
    fireEvent.change(valueInput, { target: { value: '' } });
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    fireEvent.blur(valueInput);

    expect(controller.updateWidgetConfig).toHaveBeenLastCalledWith('widget-1', {
      gridConditionalFormats: [expect.objectContaining({ value: undefined })],
    });
    const [, patch] = controller.updateWidgetConfig.mock.calls[0] as [
      string,
      { gridConditionalFormats: StudioConditionalFormat[] },
    ];
    expect(patch.gridConditionalFormats[0].value).not.toBe(0);
  });

  it('a partial/unparseable number never commits NaN, on blur', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value');
    fireEvent.change(valueInput, { target: { value: '-' } });
    fireEvent.blur(valueInput);

    const [, patch] = controller.updateWidgetConfig.mock.calls[0] as [
      string,
      { gridConditionalFormats: StudioConditionalFormat[] },
    ];
    const committedValue = patch.gridConditionalFormats[0].value;
    expect(Number.isNaN(committedValue)).toBe(false);
    expect(committedValue).toBeUndefined();
  });

  it('a valid number commits the parsed value on blur', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value');
    fireEvent.change(valueInput, { target: { value: '42' } });
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    fireEvent.blur(valueInput);

    expect(controller.updateWidgetConfig).toHaveBeenLastCalledWith('widget-1', {
      gridConditionalFormats: [expect.objectContaining({ value: 42 })],
    });
  });

  it('does not eat a trailing decimal point while typing', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: '0.' } });
    // The in-progress "0." is never coerced/re-rendered as "0" mid-typing.
    expect(valueInput.value).toBe('0.');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();

    fireEvent.change(valueInput, { target: { value: '0.5' } });
    fireEvent.blur(valueInput);
    expect(controller.updateWidgetConfig).toHaveBeenLastCalledWith('widget-1', {
      gridConditionalFormats: [expect.objectContaining({ value: 0.5 })],
    });
  });

  it('does not commit a still-typing bare "-" before the field is blurred', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: '-' } });
    expect(valueInput.value).toBe('-');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();

    fireEvent.change(valueInput, { target: { value: '-5' } });
    expect(valueInput.value).toBe('-5');
    fireEvent.blur(valueInput);
    expect(controller.updateWidgetConfig).toHaveBeenLastCalledWith('widget-1', {
      gridConditionalFormats: [expect.objectContaining({ value: -5 })],
    });
  });
});

// ─── String-value input: buffer-then-commit-on-blur (architecture review 2.3) ───
//
// The numeric branch (tested above) was fixed first; the string-value branch (used
// for a non-numeric field, e.g. "id") was missed and still committed on every
// keystroke — an undoable commit, a mutation-log line, and a full pipeline
// recompute per character typed.
describe('GridConditionalFormatSection string value input (finding 2.3)', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'grid',
      title: 'Widget 1',
      sourceId: 'orders',
      config: {
        gridConditionalFormats: [makeRule({ fieldId: 'id', value: 'Pending' })],
      } as StudioWidgetConfig,
    };
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('does not commit while typing', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'Overdue' } });

    expect(valueInput.value).toBe('Overdue');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits the typed string once on blur', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'Overdue' } });
    fireEvent.blur(valueInput);

    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      gridConditionalFormats: [expect.objectContaining({ value: 'Overdue' })],
    });
  });

  it('commits once on Enter, not per keystroke', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'S' } });
    fireEvent.change(valueInput, { target: { value: 'Sh' } });
    fireEvent.change(valueInput, { target: { value: 'Shipped' } });
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();

    act(() => {
      valueInput.focus();
    });
    fireEvent.keyDown(valueInput, { key: 'Enter' });
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      gridConditionalFormats: [expect.objectContaining({ value: 'Shipped' })],
    });
  });

  it('does not commit on blur when nothing changed', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value');
    fireEvent.blur(valueInput);

    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });
});

// Stale-buffer-on-widget-switch (architecture review Tier2 finding): the resync effect
// used to key off the rule's value alone. Switching to a DIFFERENT widget whose rule at
// the same array position happens to carry the SAME value looked like no change to that
// effect, so a dirty buffer from the previous widget survived and a subsequent blur would
// have committed the stray uncommitted text into the NEW widget's rule.
describe('GridConditionalFormatSection resyncs on widget switch', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'grid',
      sourceId: 'orders',
      title: 'Orders',
      config: { gridConditionalFormats: [makeRule({ value: 10 })] } as StudioWidgetConfig,
    };
    (mockState.doc.widgets as Record<string, (typeof mockState.doc.widgets)['widget-1']>)[
      'widget-2'
    ] = {
      id: 'widget-2',
      kind: 'grid',
      sourceId: 'orders',
      title: 'Other Orders',
      config: { gridConditionalFormats: [makeRule({ value: 10 })] } as StudioWidgetConfig,
    };
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('resyncs (clears dirty) the numeric value buffer instead of committing stale text when switching widgets', () => {
    const { setProps } = render(<GridConditionalFormatSection widgetId="widget-1" />);
    const valueInput = screen.getByLabelText('Condition value') as HTMLInputElement;

    // Type into widget-1's rule value but never blur — buffer is dirty, nothing committed.
    fireEvent.change(valueInput, { target: { value: '999' } });
    expect(valueInput.value).toBe('999');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();

    // Switch to a different widget whose rule at the same position has the SAME value (10).
    setProps({ widgetId: 'widget-2' });

    // The buffer must have resynced to the new widget's committed rule value...
    expect((screen.getByLabelText('Condition value') as HTMLInputElement).value).toBe('10');

    // ...so a blur now commits nothing, instead of writing the stray "999" from widget-1
    // into widget-2's rule.
    fireEvent.blur(screen.getByLabelText('Condition value'));
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });
});

// Tier3 secondary fix: a persisted rule can reference a field id no longer present on the
// source (schema drift after a field is removed/renamed). Before this fix, the fieldId
// `Select` had no MenuItem matching the stale value, so MUI rendered it blank —
// indistinguishable from an unset field, even though `rule.fieldId` is technically still
// set. Mirrors `GridSetupPanel`'s `fieldInfo?.label ?? col.fieldId` raw-id fallback.
describe('GridConditionalFormatSection stale fieldId fallback (Tier3)', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'grid',
      sourceId: 'orders',
      title: 'Orders',
      config: {
        gridConditionalFormats: [makeRule({ fieldId: 'removedField', value: 'Pending' })],
      } as StudioWidgetConfig,
    };
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('shows a fallback option for a fieldId no longer present on the source, instead of rendering blank', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const fieldSelect = screen.getByLabelText('Condition field');
    // The Select's displayed value must still reflect the stale id (not silently blank).
    expect(fieldSelect.textContent).toContain('removedField');
  });
});
