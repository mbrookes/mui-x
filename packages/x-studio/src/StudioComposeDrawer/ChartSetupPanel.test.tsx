import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
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
      },
    },
  },
  dataSources: {
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'Order ID', type: 'string' },
      ],
      rows: [],
    },
    customers: {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'country', label: 'Country', type: 'string' },
      ],
      rows: [],
    },
    orderItems: {
      id: 'orderItems',
      label: 'Order Items',
      fields: [
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [],
    },
    shipments: {
      id: 'shipments',
      label: 'Shipments',
      fields: [
        { id: 'status', label: 'Status', type: 'string' },
      ],
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

vi.mock('../context', () => ({
  useStudioController: () => controller,
  useStudioSelector: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));

const { render } = createRenderer();

describe('ChartSetupPanel', () => {
  it('shows a section title for the category field', () => {
    render(<ChartSetupPanel widgetId="widget-1" />);

    expect(screen.getByText('Category field')).toBeVisible();
  });

  it('disables unsupported cross-source X field options', async () => {
    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

    const comboboxes = screen.getAllByRole('combobox');
    const splitByInput = comboboxes[2] as HTMLInputElement;

    await user.click(splitByInput);

    const countryOption = await screen.findByRole('option', { name: /Country$/ });
    const statusOption = await screen.findByRole('option', { name: /Status$/ });

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

    const comboboxes = screen.getAllByRole('combobox');
    const splitByInput = comboboxes[2] as HTMLInputElement;

    await user.click(splitByInput);

    const countryOption = await screen.findByRole('option', { name: /Country$/ });
    const statusOption = await screen.findByRole('option', { name: /Status$/ });

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
});