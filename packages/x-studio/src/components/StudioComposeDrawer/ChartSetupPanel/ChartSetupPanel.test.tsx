import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { StudioController } from '../../../store/StudioController';
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

  // Finding 2.4: removing the last field-bearing series must re-apply the BL-186
  // fieldless-count lock, exactly like `handleSeriesFieldChange` — both now route
  // through the shared `commitYSeries` helper.
  it('re-locks aggregation to count when removing the last field-bearing series (finding 2.4)', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
          { id: 'revenue', label: 'Revenue', type: 'number' },
        ],
      };
      // One field-bearing series plus a still-empty one (post "add series"). Removing
      // the filled series leaves a fieldless chart whose only valid aggregation is count.
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: {
          chartType: 'bar',
          xField: 'id',
          ySeries: [{ fieldId: 'total' }, { fieldId: '' }],
          yField: 'total',
          yAggregation: 'sum',
        },
      };

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

      // Remove the first (field-bearing) series → the remaining series is fieldless.
      const removeButtons = screen.getAllByRole('button', { name: 'Remove series' });
      await user.click(removeButtons[0]);

      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
        ySeries: [{ fieldId: '' }],
        yField: '',
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

  // Finding 2.6: the heatmap axes section uses the same extracted SortDirectionToggle
  // as the chart panel, so the "Sort direction" group must render for a heatmap sorted
  // by an axis too.
  it('shows the shared sort direction toggle for a heatmap sorted by an axis (finding 2.6)', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [
          { id: 'col', label: 'Column', type: 'string' },
          { id: 'rowAxis', label: 'Row Axis', type: 'string' },
          { id: 'val', label: 'Value', type: 'number' },
        ],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: {
          chartType: 'heatmap',
          xField: 'col',
          heatYField: 'rowAxis',
          yField: 'val',
          ySeries: [{ fieldId: 'val' }],
          heatSortBy: 'x-axis',
        },
      };

      render(<ChartSetupPanel widgetId="widget-1" />);

      expect(screen.getByRole('group', { name: 'Sort direction' })).toBeVisible();
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  // Finding 2.13: the panel's support check must validate the SAME fields the canvas
  // (`useChartWidgetData.ts`) does — `chartTypeExtraFields` (heatmap/funnel/sankey/gantt
  // dimension fields) and the scatter aux fields (`scatterColorField`/`scatterSizeField`) —
  // not just x/y/series. Before the fix, the panel's `analyzeChartSupport` call omitted all
  // three, so an unresolvable field in one of them showed no warning here even though the
  // rendered widget would fall back to the "unsupported chart configuration" overlay.
  describe('extra-field / scatter-aux-field validation (finding 2.13)', () => {
    it('warns when a heatmap heatYField is an unresolvable cross-source field', () => {
      const previousWidget = mockState.doc.widgets['widget-1'];
      const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

      try {
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: [
            { id: 'col', label: 'Column', type: 'string' },
            { id: 'val', label: 'Value', type: 'number' },
          ],
        };
        mockState.doc.widgets['widget-1'] = {
          ...previousWidget,
          sourceId: 'orders',
          config: {
            chartType: 'heatmap',
            xField: 'col',
            heatYField: 'doesNotExistAnywhere',
            yField: 'val',
            ySeries: [{ fieldId: 'val' }],
          },
        };

        render(<ChartSetupPanel widgetId="widget-1" />);

        expect(
          screen.getByText(/not available on the widget source or a directly related source/i),
        ).toBeVisible();
      } finally {
        mockState.doc.widgets['widget-1'] = previousWidget;
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: previousOrdersFields,
        };
      }
    });

    it('does not warn when the heatYField resolves on the widget source (control)', () => {
      const previousWidget = mockState.doc.widgets['widget-1'];
      const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

      try {
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: [
            { id: 'col', label: 'Column', type: 'string' },
            { id: 'rowAxis', label: 'Row Axis', type: 'string' },
            { id: 'val', label: 'Value', type: 'number' },
          ],
        };
        mockState.doc.widgets['widget-1'] = {
          ...previousWidget,
          sourceId: 'orders',
          config: {
            chartType: 'heatmap',
            xField: 'col',
            heatYField: 'rowAxis',
            yField: 'val',
            ySeries: [{ fieldId: 'val' }],
          },
        };

        render(<ChartSetupPanel widgetId="widget-1" />);

        expect(
          screen.queryByText(/not available on the widget source or a directly related source/i),
        ).toBeNull();
      } finally {
        mockState.doc.widgets['widget-1'] = previousWidget;
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: previousOrdersFields,
        };
      }
    });

    it('warns for a scatter chart with a cross-source colour field', () => {
      const previousWidget = mockState.doc.widgets['widget-1'];

      try {
        mockState.doc.widgets['widget-1'] = {
          ...previousWidget,
          sourceId: 'orders',
          config: {
            chartType: 'scatter',
            xField: 'id',
            yField: 'id',
            ySeries: [{ fieldId: 'id' }],
            // Owned by the related `customers` source, not `orders` — scatter doesn't
            // support cross-source field combinations.
            scatterColorField: 'country',
          },
        };

        render(<ChartSetupPanel widgetId="widget-1" />);

        expect(screen.getByText(/do not support cross-source field combinations/i)).toBeVisible();
      } finally {
        mockState.doc.widgets['widget-1'] = previousWidget;
      }
    });
  });

  // Schema review finding 1.1's UI half: funnel has no sort DIRECTION concept
  // (`StudioFunnelChartConfig` declares `chartSortBy` only — buildFunnelStages
  // never reads `chartSortDirection`), so the direction toggle must be hidden
  // for funnel while the "Sort by" control itself stays visible.
  describe('sort direction control', () => {
    it('shows the sort direction toggle for a bar chart', () => {
      render(<ChartSetupPanel widgetId="widget-1" />);

      // "Sort by" label renders twice via the notched outline (see the sankey test above).
      expect(screen.getAllByText('Sort by').length).toBeGreaterThan(0);
      expect(screen.getByRole('group', { name: 'Sort direction' })).toBeVisible();
    });

    it('hides the sort direction toggle for a funnel chart, but keeps "Sort by"', () => {
      const previousWidget = mockState.doc.widgets['widget-1'];
      const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

      try {
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: [
            { id: 'stage', label: 'Stage', type: 'string' },
            { id: 'count', label: 'Count', type: 'number' },
          ],
        };
        mockState.doc.widgets['widget-1'] = {
          ...previousWidget,
          sourceId: 'orders',
          config: {
            chartType: 'funnel',
            xField: 'stage',
            yField: 'count',
          },
        };

        render(<ChartSetupPanel widgetId="widget-1" />);

        expect(screen.getAllByText('Sort by').length).toBeGreaterThan(0);
        expect(screen.queryByRole('group', { name: 'Sort direction' })).toBeNull();
      } finally {
        mockState.doc.widgets['widget-1'] = previousWidget;
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: previousOrdersFields,
        };
      }
    });
  });

  // Finding 2.9: a chart has no separate source picker — the X field IS how it adopts a
  // source. So an unrelated-source X candidate must NOT be permanently disabled; selecting it
  // adopts that source. The picker validates the candidate against its OWN source as anchor.
  it('keeps an unrelated-source X field selectable (its pick adopts that source) (finding 2.9)', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];

    try {
      // An UNRELATED source — no declared relationship references it.
      (mockState.runtime.dataSources as Record<string, unknown>).warehouse = {
        id: 'warehouse',
        label: 'Warehouse',
        fields: [{ id: 'zone', label: 'Zone', type: 'string' }],
        rows: [],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: { chartType: 'bar', xField: 'id' },
      };

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

      const xInput = screen.getByLabelText('X / Category field', { exact: false });
      await user.click(xInput);

      const zoneOption = await screen.findByRole('option', { name: /Zone$/ });
      // Anchored on 'warehouse' (its own source), the candidate is a valid direct field →
      // enabled. Before the fix it was validated against 'orders' → field_not_found → disabled.
      expect(zoneOption.getAttribute('aria-disabled')).toBe('false');
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      delete (mockState.runtime.dataSources as Record<string, unknown>).warehouse;
    }
  });

  // Finding 2.12: `selectedXField` (which sets `supportSourceId`, anchoring every other
  // picker) must resolve the configured X field scoped to the widget's OWN source. An
  // earlier-sorting related source sharing the field id would otherwise re-anchor the panel.
  it('resolves the X field scoped to the widget source on an id collision (finding 2.12)', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        // The widget's own X field is a DATE — so Group By should be offered.
        fields: [{ id: 'shared', label: 'Shared', type: 'date' }],
      };
      // Sorts before "Orders" by label; shares the 'shared' id but as a STRING.
      (mockState.runtime.dataSources as Record<string, unknown>).aaa = {
        id: 'aaa',
        label: 'Aaa',
        fields: [{ id: 'shared', label: 'Aaa Shared', type: 'string' }],
        rows: [],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: { chartType: 'bar', xField: 'shared' },
      };

      render(<ChartSetupPanel widgetId="widget-1" />);

      // Group By renders only when the RESOLVED X field is date/datetime. With the fix, the
      // widget-source date field is resolved → Group By shows. Before the fix, the
      // earlier-sorting string 'aaa.shared' won the bare-id lookup → no Group By.
      expect(screen.getAllByText('Group by').length).toBeGreaterThan(0);
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
      delete (mockState.runtime.dataSources as Record<string, unknown>).aaa;
    }
  });
});

// Finding 2.2: picking the X field also ADOPTS its source (the widget starts with no
// source). That single gesture must collapse to ONE undo step. This runs the panel against
// a REAL StudioController so `canUndo()`/`undo()` observe the actual undo stack — proving
// the X-field config write and the source adoption were folded into one commit rather than
// leaving a lone Ctrl+Z on a torn state (new sourceId, no xField) the UI never produced.
describe('ChartSetupPanel — X-field source adoption folds to a single undo step (finding 2.2)', () => {
  function makeController() {
    return new StudioController({
      doc: {
        widgets: {
          'widget-1': {
            id: 'widget-1',
            kind: 'chart',
            title: 'Chart',
            // No source yet, and no X/Y field — the from-scratch state where picking a
            // field adopts its source (the ChartSetupPanel version of the adopt-source flow).
            config: { chartType: 'bar' },
          } as StudioWidget,
        },
      },
      runtime: {
        dataSources: {
          orders: {
            id: 'orders',
            label: 'Orders',
            fields: [{ id: 'department', label: 'Department', type: 'string' }],
            rows: [],
          },
        },
      },
    });
  }

  it('folds the X-field pick and its source adoption into one undoable step', async () => {
    const realController = makeController();
    configureStudioContextMock({
      getState: () => realController.getState(),
      controller: realController,
    });

    expect(realController.canUndo()).toBe(false);

    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

    // The X picker is `required` (BL-186 has no fieldless fallback), so its label carries a
    // trailing asterisk — match with `exact: false`.
    const xInput = screen.getByLabelText('X / Category field', { exact: false });
    await user.click(xInput);
    const departmentOption = await screen.findByRole('option', { name: /Department$/ });
    await user.click(departmentOption);

    // The gesture reached the intended state: source adopted + X field written (+ the
    // BL-186 fieldless-count seed) in one shot.
    const afterGesture = realController.getState().doc.widgets['widget-1'];
    expect(afterGesture.sourceId).toBe('orders');
    expect((afterGesture.config as StudioWidgetConfig).xField).toBe('department');
    expect(realController.canUndo()).toBe(true);

    // Exactly ONE undo entry: a single undo fully reverts (no source, no X field together —
    // never a torn source-without-field intermediate)...
    realController.undo();
    const reverted = realController.getState().doc.widgets['widget-1'];
    expect(reverted.sourceId).toBeUndefined();
    expect((reverted.config as StudioWidgetConfig).xField).toBeUndefined();
    // ...and nothing remains to undo, proving the gesture pushed only one entry.
    expect(realController.canUndo()).toBe(false);
  });
});
