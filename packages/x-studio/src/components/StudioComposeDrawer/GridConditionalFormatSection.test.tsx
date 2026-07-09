import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
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

  it('clearing the numeric value stores undefined, not 0', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value');
    fireEvent.change(valueInput, { target: { value: '' } });

    expect(controller.updateWidgetConfig).toHaveBeenLastCalledWith('widget-1', {
      gridConditionalFormats: [expect.objectContaining({ value: undefined })],
    });
    const [, patch] = controller.updateWidgetConfig.mock.calls[0] as [
      string,
      { gridConditionalFormats: StudioConditionalFormat[] },
    ];
    expect(patch.gridConditionalFormats[0].value).not.toBe(0);
  });

  it('a partial/unparseable number never commits NaN', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value');
    fireEvent.change(valueInput, { target: { value: '-' } });

    const [, patch] = controller.updateWidgetConfig.mock.calls[0] as [
      string,
      { gridConditionalFormats: StudioConditionalFormat[] },
    ];
    const committedValue = patch.gridConditionalFormats[0].value;
    expect(Number.isNaN(committedValue)).toBe(false);
    expect(committedValue).toBeUndefined();
  });

  it('a valid number commits the parsed value', () => {
    render(<GridConditionalFormatSection widgetId="widget-1" />);

    const valueInput = screen.getByLabelText('Condition value');
    fireEvent.change(valueInput, { target: { value: '42' } });

    expect(controller.updateWidgetConfig).toHaveBeenLastCalledWith('widget-1', {
      gridConditionalFormats: [expect.objectContaining({ value: 42 })],
    });
  });
});
