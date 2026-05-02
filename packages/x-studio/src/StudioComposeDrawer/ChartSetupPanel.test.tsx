import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
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
  it('disables unsupported cross-source X field options', async () => {
    render(<ChartSetupPanel widgetId="widget-1" />);

    const comboboxes = screen.getAllByRole('combobox');
    const splitByInput = comboboxes[2] as HTMLInputElement;

    await React.act(async () => {
      splitByInput.focus();
      fireEvent.mouseDown(splitByInput);
      fireEvent.keyDown(document.activeElement ?? splitByInput, { key: 'ArrowDown' });
    });

    const countryOption = screen.getByRole('option', { name: /Country$/ });
    const statusOption = screen.getByRole('option', { name: /Status$/ });

    expect(countryOption.getAttribute('aria-disabled')).toBe('false');
    expect(statusOption.getAttribute('aria-disabled')).toBe('true');
  });
});