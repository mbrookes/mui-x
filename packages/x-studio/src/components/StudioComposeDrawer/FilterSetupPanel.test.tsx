import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { FilterSetupPanel } from './FilterSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
  clearInteractiveFilter: vi.fn(),
};

const mockState = {
  doc: {
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'filter',
        sourceId: 'orders',
        config: {
          filterWidgetType: 'multi-select',
          filterWidgetField: 'status',
        } as StudioWidgetConfig,
      },
    },
    relationships: [],
    expressionFields: [],
  },
  runtime: {
    dataSources: {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'status', label: 'Status', type: 'string' },
          { id: 'amount', label: 'Amount', type: 'number' },
          { id: 'placedAt', label: 'Placed At', type: 'date' },
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

describe('FilterSetupPanel', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'filter',
      sourceId: 'orders',
      config: {
        filterWidgetType: 'multi-select',
        filterWidgetField: 'status',
      } as StudioWidgetConfig,
    };
    controller.updateWidgetConfig.mockClear();
    controller.updateWidget.mockClear();
    controller.clearInteractiveFilter.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('shows the control-type select and the selected field', () => {
    render(<FilterSetupPanel widgetId="widget-1" />);

    expect(screen.getAllByText('Control type').length).toBeGreaterThan(0);
    // The field picker is marked `required` (no fieldless fallback), so its accessible
    // label carries a trailing asterisk — match with `exact: false`, scoped to the input
    // so it doesn't also match the filled-state "Clear field" button's aria-label.
    expect(
      screen.getByLabelText('Field', { exact: false, selector: 'input' }).getAttribute('value'),
    ).toBe('Status');
    expect(screen.queryByText('Select a field to configure the filter control.')).toBeNull();
  });

  it('switches the control type to slider and reveals the min/max/step inputs', async () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'multi-select',
      filterWidgetField: 'amount',
    };

    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByText('Multi-select'));
    const sliderOption = await screen.findByRole('option', { name: /^Slider/ });
    await user.click(sliderOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetType: 'slider',
    });
    expect(controller.clearInteractiveFilter).toHaveBeenCalledWith('widget-1');
  });

  it('clears an incompatible field when switching to date-range', async () => {
    // "status" is a string field, incompatible with date-range.
    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByText('Multi-select'));
    const dateRangeOption = await screen.findByRole('option', { name: /^Date range/ });
    await user.click(dateRangeOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetType: 'date-range',
      filterWidgetField: undefined,
    });
  });

  it('shows the slider range inputs only when the control type is slider', () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'slider',
      filterWidgetField: 'amount',
    };

    render(<FilterSetupPanel widgetId="widget-1" />);

    expect(screen.getByLabelText('Min')).toBeVisible();
    expect(screen.getByLabelText('Max')).toBeVisible();
    expect(screen.getByLabelText('Step')).toBeVisible();
  });

  it('updates the slider min value via the min input', async () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'slider',
      filterWidgetField: 'amount',
    };

    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.type(screen.getByLabelText('Min'), '5');

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetMin: 5,
    });
  });

  it('shows the "select a field" alert when no field is configured', () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'multi-select',
    };

    render(<FilterSetupPanel widgetId="widget-1" />);

    expect(screen.getByText('Select a field to configure the filter control.')).toBeVisible();
  });
});
