import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { GridSetupPanel } from './GridSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
};

const mockState = {
  doc: {
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'grid',
        sourceId: 'orders' as string | undefined,
        config: {
          columns: [{ fieldId: 'id' }, { fieldId: 'total' }],
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
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
          { id: 'category', label: 'Category', type: 'string' },
        ],
        rows: [],
      },
      // Second source used by the "changing the data source" test below.
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [{ id: 'name', label: 'Name', type: 'string' }],
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

describe('GridSetupPanel', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('renders the columns list and the Add column affordance', () => {
    render(<GridSetupPanel widgetId="widget-1" />);

    expect(screen.getByText('Columns')).toBeVisible();
    expect(screen.getByText('Order ID')).toBeVisible();
    expect(screen.getByText('Total')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add column' })).toBeVisible();
  });

  it('adds a column via the Add column menu', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<GridSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('button', { name: 'Add column' }));
    // Name includes the field-type icon's aria-label prefix (e.g. "Text Category").
    const categoryItem = await screen.findByRole('menuitem', { name: /Category$/ });
    await user.click(categoryItem);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      columns: [{ fieldId: 'id' }, { fieldId: 'total' }, { fieldId: 'category' }],
    });
  });

  it('removes a column via its options menu', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<GridSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('button', { name: 'Options for Order ID' }));
    const removeItem = await screen.findByRole('menuitem', { name: 'Remove' });
    await user.click(removeItem);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      columns: [{ fieldId: 'total' }],
    });
  });

  it('sets the group-by field', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<GridSetupPanel widgetId="widget-1" />);

    const groupByInput = screen.getByLabelText('Group by');
    await user.click(groupByInput);
    // Name includes the field-type icon's aria-label prefix (e.g. "Text Category").
    const categoryOption = await screen.findByRole('option', { name: /Category$/ });
    await user.click(categoryOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      gridGroupByField: 'category',
      gridAggregations: {},
    });
  });

  it('switches the cross-filter interaction mode', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<GridSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      crossFilterMode: 'cross-filter',
    });
  });

  it('preserves non-field config keys when the data source changes (finding 3.6)', async () => {
    controller.updateWidget.mockClear();
    const previousWidget = mockState.doc.widgets['widget-1'];

    try {
      // Field-bound keys (columns, gridSortField, gridGroupByField, …) reference
      // the OLD source's fields and must be cleared on a source change, but
      // grid-level display settings independent of field selection — here
      // gridSortDirection and gridHeight — must survive it.
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: {
          columns: [{ fieldId: 'id' }, { fieldId: 'total' }],
          gridSortField: 'total',
          gridSortDirection: 'desc',
          gridGroupByField: 'category',
          gridHeight: 500,
        } as StudioWidgetConfig,
      };

      const { user } = render(<GridSetupPanel widgetId="widget-1" />);

      await user.click(screen.getByLabelText('Data source'));
      const customersOption = await screen.findByRole('option', { name: 'Customers' });
      await user.click(customersOption);

      expect(controller.updateWidget).toHaveBeenCalledWith('widget-1', {
        sourceId: 'customers',
        config: {
          gridSortDirection: 'desc',
          gridHeight: 500,
          columns: [],
        },
      });
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
    }
  });

  it('hides the columns section and shows a helper alert when no source is selected', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];

    try {
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: undefined,
        config: {},
      };

      render(<GridSetupPanel widgetId="widget-1" />);

      expect(
        screen.getByText(
          "Select a data source above to configure this table's columns and settings.",
        ),
      ).toBeVisible();
      expect(screen.queryByText('Columns')).toBeNull();
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
    }
  });
});
