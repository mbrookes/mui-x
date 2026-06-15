import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { ChartSetupPanel } from './ChartSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
};

const mockState = {
  widgets: {
    'widget-1': {
      id: 'widget-1',
      kind: 'chart',
      sourceId: 'orders',
      config: {
        chartType: 'bar',
        xField: 'id',
        yField: 'total',
      } as StudioWidgetConfig,
    },
  },
  dataSources: {
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
      rows: [],
    },
    customers: {
      id: 'customers',
      label: 'Customers',
      fields: [{ id: 'country', label: 'Country', type: 'string' }],
      rows: [],
    },
    orderItems: {
      id: 'orderItems',
      label: 'Order Items',
      fields: [{ id: 'total', label: 'Total', type: 'number' }],
      rows: [],
    },
    shipments: {
      id: 'shipments',
      label: 'Shipments',
      fields: [{ id: 'status', label: 'Status', type: 'string' }],
      rows: [],
    },
  },
  relationships: [
    {
      id: 'rel-orders-customers',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
    {
      id: 'rel-orderitems-orders',
      sourceId: 'orderItems',
      sourceField: 'orderId',
      targetId: 'orders',
      targetField: 'id',
      type: 'many-to-one',
    },
    {
      id: 'rel-shipments-orders',
      sourceId: 'shipments',
      sourceField: 'orderId',
      targetId: 'orders',
      targetField: 'id',
      type: 'many-to-one',
    },
  ],
  expressionFields: [],
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

describe('ChartSetupPanel', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('shows a section title for the category field', () => {
    render(<ChartSetupPanel widgetId="widget-1" />);

    expect(screen.getByText('Category field')).toBeVisible();
  });

  it('keeps the split-by field visible and disabled when multiple measure fields are configured', () => {
    const previousConfig = mockState.widgets['widget-1'].config;
    const previousOrdersFields = mockState.dataSources.orders.fields;

    try {
      mockState.widgets['widget-1'].config = {
        ...previousConfig,
        ySeries: [{ fieldId: 'total' }, { fieldId: 'revenue' }],
        yField: 'total',
        seriesField: undefined,
      };

      mockState.dataSources.orders = {
        ...mockState.dataSources.orders,
        fields: [
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
          { id: 'revenue', label: 'Revenue', type: 'number' },
          { id: 'category', label: 'Category', type: 'string' },
        ],
      };

      render(<ChartSetupPanel widgetId="widget-1" />);

      expect(screen.getByText('Category field')).toBeVisible();
      expect(screen.getByLabelText('Split by (series field)').getAttribute('disabled')).toBe('');
      expect(
        screen.getByText('Not available when multiple measure fields are configured'),
      ).toBeVisible();
    } finally {
      mockState.widgets['widget-1'].config = {
        ...previousConfig,
      };

      mockState.dataSources.orders = {
        ...mockState.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('disables unsupported cross-source X field options', async () => {
    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

    const splitByInput = screen.getByLabelText('Split by (series field)');

    await user.click(splitByInput);

    const [countryOption, statusOption] = await Promise.all([
      screen.findByRole('option', { name: /Country$/ }),
      screen.findByRole('option', { name: /Status$/ }),
    ]);

    expect(countryOption.getAttribute('aria-disabled')).toBe('false');
    expect(statusOption.getAttribute('aria-disabled')).toBe('true');
  });

  it('flips axis labels for horizontal bar charts', () => {
    mockState.widgets['widget-1'].config = {
      ...mockState.widgets['widget-1'].config,
      chartType: 'bar',
      barLayout: 'horizontal',
    };

    render(<ChartSetupPanel widgetId="widget-1" />);

    expect(screen.getAllByText('Y / Category field').length).toBeGreaterThan(0);
    expect(screen.getAllByText('X / Measure field').length).toBeGreaterThan(0);
    expect(screen.getByText('Groups data along the vertical axis')).toBeVisible();
    expect(screen.getByText('Numeric field plotted along the horizontal axis')).toBeVisible();

    mockState.widgets['widget-1'].config = {
      ...mockState.widgets['widget-1'].config,
      barLayout: undefined,
    };
  });

  it('removes stale source filtering when xField is cleared', async () => {
    mockState.widgets['widget-1'].config = {
      ...mockState.widgets['widget-1'].config,
      xField: undefined,
      yField: 'total',
      ySeries: [{ fieldId: 'total' }],
      seriesField: undefined,
    };

    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

    const splitByInput = screen.getByLabelText('Split by (series field)');

    await user.click(splitByInput);

    const [countryOption, statusOption] = await Promise.all([
      screen.findByRole('option', { name: /Country$/ }),
      screen.findByRole('option', { name: /Status$/ }),
    ]);

    expect(countryOption.getAttribute('aria-disabled')).toBe('false');
    expect(statusOption.getAttribute('aria-disabled')).toBe('true');

    mockState.widgets['widget-1'].config = {
      ...mockState.widgets['widget-1'].config,
      xField: 'id',
      ySeries: undefined,
    };
  });

  it('does not warn for a safe order-items chart when the x field comes from orders', () => {
    mockState.widgets['widget-1'] = {
      ...mockState.widgets['widget-1'],
      sourceId: 'orderItems',
      config: {
        chartType: 'bar-stacked',
        xField: 'date',
        xGroupBy: 'quarter',
        yField: 'total',
        seriesField: 'category',
      },
    };

    mockState.dataSources.orders = {
      ...mockState.dataSources.orders,
      fields: [
        { id: 'id', label: 'Order ID', type: 'string' },
        { id: 'date', label: 'Order Date', type: 'date' },
        { id: 'total', label: 'Order Total', type: 'number' },
      ],
    };

    mockState.dataSources.orderItems = {
      ...mockState.dataSources.orderItems,
      fields: [
        { id: 'total', label: 'Total', type: 'number' },
        { id: 'category', label: 'Category', type: 'string' },
      ],
    };

    render(<ChartSetupPanel widgetId="widget-1" />);

    expect(screen.queryByText(/single safe aggregation grain/i)).toBeNull();

    mockState.widgets['widget-1'] = {
      ...mockState.widgets['widget-1'],
      sourceId: 'orders',
      config: {
        chartType: 'bar',
        xField: 'id',
        yField: 'total',
      },
    };

    mockState.dataSources.orders = {
      ...mockState.dataSources.orders,
      fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
    };

    mockState.dataSources.orderItems = {
      ...mockState.dataSources.orderItems,
      fields: [{ id: 'total', label: 'Total', type: 'number' }],
    };
  });

  it('shows source, target, value and link controls for a sankey chart', () => {
    const previousWidget = mockState.widgets['widget-1'];
    const previousOrdersFields = mockState.dataSources.orders.fields;

    try {
      mockState.dataSources.orders = {
        ...mockState.dataSources.orders,
        fields: [
          { id: 'category', label: 'Category', type: 'string' },
          { id: 'region', label: 'Region', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
      };
      mockState.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: {
          chartType: 'sankey',
          xField: 'category',
          sankeyTargetField: 'region',
          yField: 'total',
        },
      };

      render(<ChartSetupPanel widgetId="widget-1" />);

      // Sankey-specific field controls (labels render twice via the notched outline)
      expect(screen.getAllByText('Source (from) field').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Target (to) field').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Link colour').length).toBeGreaterThan(0);
      expect(screen.getByText('Show values on links')).toBeVisible();
      // Irrelevant controls are hidden for sankey (split-by section title)
      expect(screen.queryByText('Category field')).toBeNull();
    } finally {
      mockState.widgets['widget-1'] = previousWidget;
      mockState.dataSources.orders = {
        ...mockState.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('locks the aggregation to a disabled Count when no measure field is selected (BL-186)', () => {
    const previousWidget = mockState.widgets['widget-1'];
    const previousOrdersFields = mockState.dataSources.orders.fields;

    try {
      mockState.dataSources.orders = {
        ...mockState.dataSources.orders,
        fields: [{ id: 'department', label: 'Department', type: 'string' }],
      };
      // Reproduces "contacts by department": an X field, no numeric Y field, count.
      mockState.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: {
          chartType: 'bar',
          xField: 'department',
          yAggregation: 'count',
        },
      };

      render(<ChartSetupPanel widgetId="widget-1" />);

      // The aggregation control is present, shows Count, and is disabled (count is the only
      // valid aggregation with no field). Its hidden input carries the value "count".
      const aggLabels = screen.getAllByText('Aggregation');
      expect(aggLabels.length).toBeGreaterThan(0);
      const aggSelect = document.querySelector('input[value="count"]');
      expect(aggSelect).not.toBeNull();
      expect(aggSelect!.getAttribute('disabled')).toBe('');
      // The split-by control is unavailable for a fieldless count.
      expect(screen.getByLabelText('Split by (series field)').getAttribute('disabled')).toBe('');
    } finally {
      mockState.widgets['widget-1'] = previousWidget;
      mockState.dataSources.orders = {
        ...mockState.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('seeds a fieldless count when the X field is picked with no measure field (BL-186)', async () => {
    const previousWidget = mockState.widgets['widget-1'];
    const previousOrdersFields = mockState.dataSources.orders.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.dataSources.orders = {
        ...mockState.dataSources.orders,
        fields: [{ id: 'department', label: 'Department', type: 'string' }],
      };
      // No X field and no Y field yet — the from-scratch state.
      mockState.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: { chartType: 'bar' },
      };

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

      // Pick the X field — its source-anchoring side effect must also seed the row count.
      const xInput = screen.getByLabelText('X / Category field');
      await user.click(xInput);
      const departmentOption = await screen.findByRole('option', { name: /Department$/ });
      await user.click(departmentOption);

      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
        xField: 'department',
        yAggregation: 'count',
      });
    } finally {
      mockState.widgets['widget-1'] = previousWidget;
      mockState.dataSources.orders = {
        ...mockState.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('toggles sankeyShowValues from the show-values checkbox', async () => {
    const previousWidget = mockState.widgets['widget-1'];
    const previousOrdersFields = mockState.dataSources.orders.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.dataSources.orders = {
        ...mockState.dataSources.orders,
        fields: [
          { id: 'category', label: 'Category', type: 'string' },
          { id: 'region', label: 'Region', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
      };
      mockState.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: {
          chartType: 'sankey',
          xField: 'category',
          sankeyTargetField: 'region',
          yField: 'total',
        },
      };

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

      await user.click(screen.getByRole('checkbox'));

      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
        sankeyShowValues: true,
      });
    } finally {
      mockState.widgets['widget-1'] = previousWidget;
      mockState.dataSources.orders = {
        ...mockState.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });
});
