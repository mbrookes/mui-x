import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { StudioController } from '../../store/StudioController';
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

// Finding 2.2: picking a filter field from a different source ADOPTS that source. That
// single gesture must collapse to ONE undo step. This runs the panel against a REAL
// StudioController so `canUndo()`/`undo()` observe the actual undo stack — proving the
// source adoption and the field write were folded into one commit (clearInteractiveFilter
// is a separate non-undoable/session commit and must NOT add an undo entry), rather than
// leaving a lone Ctrl+Z on a torn state (new sourceId, old field) the UI never produced.
describe('FilterSetupPanel — cross-source field pick folds to a single undo step (finding 2.2)', () => {
  function makeController() {
    return new StudioController({
      doc: {
        widgets: {
          'widget-1': {
            id: 'widget-1',
            kind: 'filter',
            title: 'Filter',
            config: { filterWidgetType: 'multi-select', filterWidgetField: 'status' },
            sourceId: 'orders',
          } as StudioWidget,
        },
      },
      runtime: {
        dataSources: {
          orders: {
            id: 'orders',
            label: 'Orders',
            fields: [{ id: 'status', label: 'Status', type: 'string' }],
            rows: [],
          },
          customers: {
            id: 'customers',
            label: 'Customers',
            fields: [{ id: 'segment', label: 'Segment', type: 'string' }],
            rows: [],
          },
        },
      },
    });
  }

  it('folds a cross-source field pick and its source adoption into one undoable step', async () => {
    const realController = makeController();
    configureStudioContextMock({
      getState: () => realController.getState(),
      controller: realController,
    });

    expect(realController.canUndo()).toBe(false);

    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Field', { exact: false, selector: 'input' }));
    // Name includes the field-type icon's aria-label prefix (e.g. "Text Segment").
    const segmentOption = await screen.findByRole('option', { name: /Segment$/ });
    await user.click(segmentOption);

    // The gesture reached the intended state: new source adopted + new field written.
    const afterGesture = realController.getState().doc.widgets['widget-1'];
    expect(afterGesture.sourceId).toBe('customers');
    expect((afterGesture.config as StudioWidgetConfig).filterWidgetField).toBe('segment');
    expect(realController.canUndo()).toBe(true);

    // Exactly ONE undo entry: a single undo fully reverts to the pre-gesture state (old
    // source AND old field together — never a torn source/field intermediate)...
    realController.undo();
    const reverted = realController.getState().doc.widgets['widget-1'];
    expect(reverted.sourceId).toBe('orders');
    expect((reverted.config as StudioWidgetConfig).filterWidgetField).toBe('status');
    // ...and nothing remains to undo, proving the gesture pushed only one entry.
    expect(realController.canUndo()).toBe(false);
  });
});
