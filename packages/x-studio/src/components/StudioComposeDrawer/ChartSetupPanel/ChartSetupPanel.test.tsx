import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidgetConfig } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { ChartSetupPanel } from './ChartSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
};

const mockState = {
  doc: {
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
  },
  runtime: {
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
  },
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

describe('ChartSetupPanel', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('labels the split-by field with its own floating label only (no duplicate heading)', () => {
    render(<ChartSetupPanel widgetId="widget-1" />);

    // Rule B (label-system spec): a single control's own floating label is its only name —
    // there is no separate "Category field" heading duplicating it.
    expect(screen.getByLabelText('Split by (series field)')).toBeVisible();
    expect(screen.queryByText('Category field')).to.equal(null);
  });

  it('keeps the split-by field visible and disabled when multiple measure fields are configured', () => {
    const previousConfig = mockState.doc.widgets['widget-1'].config;
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

    try {
      mockState.doc.widgets['widget-1'].config = {
        ...previousConfig,
        ySeries: [{ fieldId: 'total' }, { fieldId: 'revenue' }],
        yField: 'total',
        seriesField: undefined,
      };

      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
          { id: 'revenue', label: 'Revenue', type: 'number' },
          { id: 'category', label: 'Category', type: 'string' },
        ],
      };

      render(<ChartSetupPanel widgetId="widget-1" />);

      expect(screen.getByLabelText('Split by (series field)').getAttribute('disabled')).toBe('');
      expect(
        screen.getByText('Not available when multiple measure fields are configured'),
      ).toBeVisible();
    } finally {
      mockState.doc.widgets['widget-1'].config = {
        ...previousConfig,
      };

      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('shows "line" selected for a mixed-chart series carrying only the canonical `type` field', () => {
    const previousConfig = mockState.doc.widgets['widget-1'].config;

    try {
      mockState.doc.widgets['widget-1'].config = {
        ...previousConfig,
        chartType: 'mixed',
        ySeries: [{ fieldId: 'total', type: 'line' }],
        yField: 'total',
      };

      render(<ChartSetupPanel widgetId="widget-1" />);

      expect(screen.getByRole('button', { name: 'Line', pressed: true })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Bar', pressed: false })).toBeVisible();
    } finally {
      mockState.doc.widgets['widget-1'].config = { ...previousConfig };
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
    mockState.doc.widgets['widget-1'].config = {
      ...mockState.doc.widgets['widget-1'].config,
      chartType: 'bar',
      barLayout: 'horizontal',
    };

    render(<ChartSetupPanel widgetId="widget-1" />);

    expect(screen.getAllByText('Y / Category field').length).toBeGreaterThan(0);
    expect(screen.getAllByText('X / Measure field').length).toBeGreaterThan(0);
    expect(screen.getByText('Groups data along the vertical axis')).toBeVisible();
    expect(screen.getByText('Numeric field plotted along the horizontal axis')).toBeVisible();

    mockState.doc.widgets['widget-1'].config = {
      ...mockState.doc.widgets['widget-1'].config,
      barLayout: undefined,
    };
  });

  it('removes stale source filtering when xField is cleared', async () => {
    mockState.doc.widgets['widget-1'].config = {
      ...mockState.doc.widgets['widget-1'].config,
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

    mockState.doc.widgets['widget-1'].config = {
      ...mockState.doc.widgets['widget-1'].config,
      xField: 'id',
      ySeries: undefined,
    };
  });

  it('does not warn for a safe order-items chart when the x field comes from orders', () => {
    mockState.doc.widgets['widget-1'] = {
      ...mockState.doc.widgets['widget-1'],
      sourceId: 'orderItems',
      config: {
        chartType: 'bar-stacked',
        xField: 'date',
        xGroupBy: 'quarter',
        yField: 'total',
        seriesField: 'category',
      },
    };

    mockState.runtime.dataSources.orders = {
      ...mockState.runtime.dataSources.orders,
      fields: [
        { id: 'id', label: 'Order ID', type: 'string' },
        { id: 'date', label: 'Order Date', type: 'date' },
        { id: 'total', label: 'Order Total', type: 'number' },
      ],
    };

    mockState.runtime.dataSources.orderItems = {
      ...mockState.runtime.dataSources.orderItems,
      fields: [
        { id: 'total', label: 'Total', type: 'number' },
        { id: 'category', label: 'Category', type: 'string' },
      ],
    };

    render(<ChartSetupPanel widgetId="widget-1" />);

    expect(screen.queryByText(/single safe aggregation grain/i)).toBeNull();

    mockState.doc.widgets['widget-1'] = {
      ...mockState.doc.widgets['widget-1'],
      sourceId: 'orders',
      config: {
        chartType: 'bar',
        xField: 'id',
        yField: 'total',
      },
    };

    mockState.runtime.dataSources.orders = {
      ...mockState.runtime.dataSources.orders,
      fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
    };

    mockState.runtime.dataSources.orderItems = {
      ...mockState.runtime.dataSources.orderItems,
      fields: [{ id: 'total', label: 'Total', type: 'number' }],
    };
  });

  it('shows source, target, value and link controls for a sankey chart', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [
          { id: 'category', label: 'Category', type: 'string' },
          { id: 'region', label: 'Region', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
      };
      mockState.doc.widgets['widget-1'] = {
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
      expect(screen.getAllByText('Link color').length).toBeGreaterThan(0);
      expect(screen.getByText('Show values on links')).toBeVisible();
      // Irrelevant controls are hidden for sankey (split-by section title)
      expect(screen.queryByText('Category field')).toBeNull();
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('locks the aggregation to a disabled Count when no measure field is selected (BL-186)', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [{ id: 'department', label: 'Department', type: 'string' }],
      };
      // Reproduces "contacts by department": an X field, no numeric Y field, count.
      mockState.doc.widgets['widget-1'] = {
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
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('seeds a fieldless count when the X field is picked with no measure field (BL-186)', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [{ id: 'department', label: 'Department', type: 'string' }],
      };
      // No X field and no Y field yet — the from-scratch state.
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: { chartType: 'bar' },
      };

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

      // Pick the X field — its source-anchoring side effect must also seed the row count.
      // The picker is now marked `required` (BL-186 has no fieldless fallback for X), so its
      // accessible label carries a trailing asterisk — match with `exact: false`.
      const xInput = screen.getByLabelText('X / Category field', { exact: false });
      await user.click(xInput);
      const departmentOption = await screen.findByRole('option', { name: /Department$/ });
      await user.click(departmentOption);

      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
        xField: 'department',
        yAggregation: 'count',
      });
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('locks the aggregation to a disabled Count for a fieldless pie chart', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [{ id: 'department', label: 'Department', type: 'string' }],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: {
          chartType: 'pie',
          xField: 'department',
          yAggregation: 'count',
        },
      };

      render(<ChartSetupPanel widgetId="widget-1" />);

      const aggSelect = document.querySelector('input[value="count"]');
      expect(aggSelect).not.toBeNull();
      expect(aggSelect!.getAttribute('disabled')).toBe('');
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('seeds a fieldless count when the X field is picked on a pie chart with no measure field', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [{ id: 'department', label: 'Department', type: 'string' }],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: { chartType: 'pie' },
      };

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

      // The picker is now marked `required` (no fieldless fallback for the pie slice
      // category), so its accessible label carries a trailing asterisk.
      const xInput = screen.getByLabelText('Slice category', { exact: false });
      await user.click(xInput);
      const departmentOption = await screen.findByRole('option', { name: /Department$/ });
      await user.click(departmentOption);

      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
        xField: 'department',
        yAggregation: 'count',
      });
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('toggles sankeyShowValues from the show-values checkbox', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [
          { id: 'category', label: 'Category', type: 'string' },
          { id: 'region', label: 'Region', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
      };
      mockState.doc.widgets['widget-1'] = {
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
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  // Pinning test (finding 2.3): the Interactions section defaults to "Highlight" and
  // commits `crossFilterMode: 'none'` when the currently-selected button is deselected.
  // Mirrors GridSetupPanel's existing "switches the cross-filter interaction mode" test —
  // written before the CrossFilterModeSection extraction so the extraction is provably
  // behavior-preserving.
  it('renders Highlight/Filter/None with cross-highlight selected by default; clicking None commits crossFilterMode: none', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

    expect(screen.getByRole('button', { name: 'Highlight', pressed: true })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Filter', pressed: false })).toBeVisible();
    expect(screen.getByRole('button', { name: 'None', pressed: false })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'None' }));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      crossFilterMode: 'none',
    });
  });
});
