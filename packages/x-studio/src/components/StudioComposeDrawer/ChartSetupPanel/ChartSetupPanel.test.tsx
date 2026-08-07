import { createRenderer, screen } from '@mui/internal-test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
import type { StudioWidget, StudioWidgetConfig } from '../../../models';
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

  it('labels the split-by and X-field controls with their own floating label only (no duplicate heading)', () => {
    render(<ChartSetupPanel widgetId="widget-1" />);

    // Rule B (label-system spec): a control's own floating label is its ONLY name — nothing
    // else in the panel carries the same accessible name, so each query resolves to exactly
    // one control. Asserted against the strings the panel actually renders
    // (`chartSetupSplitByLabel` / `chartSetupXFieldCategoryHorizLabel`); the X picker is
    // `required`, so MUI appends " *" to its label content and only a substring match hits it.
    expect(screen.getByLabelText('Split by (series field)')).toBeVisible();
    expect(screen.getAllByLabelText('Split by (series field)')).toHaveLength(1);
    expect(screen.getAllByLabelText('X / Category field', { exact: false })).toHaveLength(1);
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
    const previousConfig = mockState.doc.widgets['widget-1'].config;
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

    try {
      // The shared fixture gives `orders` a single string field, so the default
      // `yField: 'total'` (a field of the RELATED `orderItems` source) does not resolve in
      // the measure picker. That was invisible until M11 gave an unresolvable stored id its
      // own "…is no longer available…" helper text, which then replaced the axis helper text
      // this test is about. Give the widget a measure field that genuinely resolves on its
      // own source, so the assertions below exercise the horizontal/vertical flip rather
      // than the unresolved-field fallback.
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'amount', label: 'Amount', type: 'number' },
        ],
      };
      mockState.doc.widgets['widget-1'].config = {
        ...previousConfig,
        chartType: 'bar',
        barLayout: 'horizontal',
        yField: 'amount',
        ySeries: [{ fieldId: 'amount' }],
      };

      render(<ChartSetupPanel widgetId="widget-1" />);

      expect(screen.getAllByText('Y / Category field').length).toBeGreaterThan(0);
      expect(screen.getAllByText('X / Measure field').length).toBeGreaterThan(0);
      expect(screen.getByText('Groups data along the vertical axis')).toBeVisible();
      expect(screen.getByText('Numeric field plotted along the horizontal axis')).toBeVisible();
    } finally {
      mockState.doc.widgets['widget-1'].config = { ...previousConfig };
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  // The source restriction is anchored on `widgetSourceId ?? supportSourceId`, so clearing
  // the X field alone changes nothing while the widget still owns a source (that is what the
  // test above pins). It is only when the widget has NO anchor at all — no `sourceId` and no
  // X field — that `analyzeChartSupport` short-circuits to "supported" and every source's
  // fields become selectable, which is what lets a from-scratch chart adopt any source.
  it('enables every source option once the widget has no anchor at all (no sourceId, no xField)', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];

    try {
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: {
          chartType: 'bar',
          yField: 'total',
          ySeries: [{ fieldId: 'total' }],
        },
      };
      // No source yet — remove it rather than assign `undefined` (the fixture's inferred type
      // requires `sourceId: string`). The spread above means `previousWidget` keeps its own.
      delete (mockState.doc.widgets['widget-1'] as Record<string, unknown>).sourceId;

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

      await user.click(screen.getByLabelText('Split by (series field)'));

      const [countryOption, statusOption] = await Promise.all([
        screen.findByRole('option', { name: /Country$/ }),
        screen.findByRole('option', { name: /Status$/ }),
      ]);

      // `shipments.status` is unreachable from `orders` and IS disabled while the widget is
      // anchored there (the preceding test) — here both are enabled, since there is no anchor
      // to validate against yet.
      expect(countryOption.getAttribute('aria-disabled')).toBe('false');
      expect(statusOption.getAttribute('aria-disabled')).toBe('false');
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
    }
  });

  it('does not warn for a safe order-items chart when the x field comes from orders', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;
    const previousOrderItemsFields = mockState.runtime.dataSources.orderItems.fields;

    try {
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
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
    } finally {
      // `finally`, like every other fixture mutation in this file: vitest runs with
      // `isolate: false`, so a failed assertion that skipped the restore would leak this
      // widget/source shape into every later test in the run.
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
      mockState.runtime.dataSources.orderItems = {
        ...mockState.runtime.dataSources.orderItems,
        fields: previousOrderItemsFields,
      };
    }
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
      // Irrelevant controls are hidden for sankey: `supportsSeriesField` excludes it, so
      // there is no split-by picker, and its X picker is labelled "Source (from) field"
      // rather than the categorical "X / Category field". Both queries resolve to exactly
      // one control on the bar-chart fixture (see the first test in this file), so their
      // `null` here is a real absence rather than a query that can never match.
      expect(screen.queryByLabelText('Split by (series field)')).toBeNull();
      expect(screen.queryByLabelText('X / Category field', { exact: false })).toBeNull();
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

  // Iteration 20 finding 1: `StudioFunnelChart` has no reference-line rendering support at
  // all, and `FUNNEL_CHART_KEYS` correctly omits `annotations` — so the Annotations editor
  // must be hidden for funnel rather than rendering a control whose writes are silently
  // stripped by the controller's config-key guard.
  describe('annotations editor visibility (finding 1)', () => {
    it('hides the Annotations editor for a funnel chart', () => {
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
          config: { chartType: 'funnel', xField: 'stage', yField: 'count' },
        };

        render(<ChartSetupPanel widgetId="widget-1" />);

        expect(screen.queryByText('Annotations')).to.equal(null);
      } finally {
        mockState.doc.widgets['widget-1'] = previousWidget;
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: previousOrdersFields,
        };
      }
    });

    it('still shows the Annotations editor for a bar chart', () => {
      render(<ChartSetupPanel widgetId="widget-1" />);

      expect(screen.getByText('Annotations')).toBeVisible();
    });
  });

  // Iteration 20 finding 2: neither `buildFunnelStages` (funnel) nor
  // `prepareScatterData`/`prepareScatterDataGrouped` (scatter) take an `xGroupBy`
  // argument, so the Group By control must be hidden for both chart types even when the
  // resolved X field is date/datetime-typed — a write here would otherwise be silently
  // stripped by `FUNNEL_CHART_KEYS`/`SCATTER_CHART_KEYS` (neither lists `xGroupBy`) with
  // no renderer to consume it regardless.
  describe('group-by control visibility (finding 2)', () => {
    it('hides Group By for a funnel chart even with a date x field', () => {
      const previousWidget = mockState.doc.widgets['widget-1'];
      const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

      try {
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: [
            { id: 'stage', label: 'Stage', type: 'date' },
            { id: 'count', label: 'Count', type: 'number' },
          ],
        };
        mockState.doc.widgets['widget-1'] = {
          ...previousWidget,
          sourceId: 'orders',
          config: { chartType: 'funnel', xField: 'stage', yField: 'count' },
        };

        render(<ChartSetupPanel widgetId="widget-1" />);

        expect(screen.queryByText('Group by')).to.equal(null);
      } finally {
        mockState.doc.widgets['widget-1'] = previousWidget;
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: previousOrdersFields,
        };
      }
    });

    it('hides Group By for a scatter chart even with a date x field', () => {
      const previousWidget = mockState.doc.widgets['widget-1'];
      const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

      try {
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          // A date field with an explicit `numeric` capability override — the scatter x-field
          // picker only offers `numeric`-capability fields, so this is how a date-typed field
          // can end up selected as a scatter chart's x field.
          fields: [
            { id: 'ts', label: 'Timestamp', type: 'date', capabilities: ['numeric'] },
            { id: 'count', label: 'Count', type: 'number' },
          ] as unknown as typeof mockState.runtime.dataSources.orders.fields,
        };
        mockState.doc.widgets['widget-1'] = {
          ...previousWidget,
          sourceId: 'orders',
          config: { chartType: 'scatter', xField: 'ts', yField: 'count' },
        };

        render(<ChartSetupPanel widgetId="widget-1" />);

        expect(screen.queryByText('Group by')).to.equal(null);
      } finally {
        mockState.doc.widgets['widget-1'] = previousWidget;
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: previousOrdersFields,
        };
      }
    });

    it('still shows Group By for a bar chart with a date x field', () => {
      const previousWidget = mockState.doc.widgets['widget-1'];
      const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

      try {
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: [{ id: 'date', label: 'Order Date', type: 'date' }],
        };
        mockState.doc.widgets['widget-1'] = {
          ...previousWidget,
          sourceId: 'orders',
          config: { chartType: 'bar', xField: 'date' },
        };

        render(<ChartSetupPanel widgetId="widget-1" />);

        expect(screen.getAllByText('Group by').length).toBeGreaterThan(0);
      } finally {
        mockState.doc.widgets['widget-1'] = previousWidget;
        mockState.runtime.dataSources.orders = {
          ...mockState.runtime.dataSources.orders,
          fields: previousOrdersFields,
        };
      }
    });
  });

  // Iteration 20 finding 2.5: `commitYSeries` must apply the same own-source guard
  // `handleSeriesFieldChange` already applies via `nativeYFieldIds` — a foreign-source
  // blended series id (mixed/blended charts) must never land in the flat `yField`, which
  // is read back as a single-source field by `analyzeChartSupport` and the eventual
  // SELECT/aggregation.
  it('does not mirror a foreign-source series id into yField when committing ySeries (finding 2.5)', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;
    const previousCustomersFields = mockState.runtime.dataSources.customers.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
      };
      mockState.runtime.dataSources.customers = {
        ...mockState.runtime.dataSources.customers,
        fields: [
          ...previousCustomersFields,
          { id: 'lifetimeValue', label: 'Lifetime Value', type: 'number' },
        ],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: {
          chartType: 'bar',
          xField: 'id',
          ySeries: [{ fieldId: 'total' }, { fieldId: 'lifetimeValue', sourceId: 'customers' }],
          yField: 'total',
        },
      };

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

      // Remove the NATIVE (own-source) series, leaving only the foreign-source one as
      // `next[0]` inside `commitYSeries`.
      const removeButtons = screen.getAllByRole('button', { name: 'Remove series' });
      await user.click(removeButtons[0]);

      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
        ySeries: [{ fieldId: 'lifetimeValue', sourceId: 'customers' }],
        // Before the fix this was 'lifetimeValue' — the foreign field id mirrored straight
        // into the flat, own-source `yField`.
        yField: '',
      });
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
      mockState.runtime.dataSources.customers = {
        ...mockState.runtime.dataSources.customers,
        fields: previousCustomersFields,
      };
    }
  });

  // Finding 4 (architecture review): gantt hides the shared X-field picker, so
  // `config.xField` is never set and `selectedXField` never resolves — before the fix,
  // `supportSourceId` (which anchors `reachableFields`) stayed `undefined` forever for
  // gantt, even after the widget's own source was already adopted by an earlier gantt
  // field pick. `reachableFields` fell back to EVERY field on EVERY source, so
  // `GanttFieldsSection`'s label-field picker (which was wired to the raw, unfiltered
  // `allFields` on top of that) offered fields from completely unrelated sources.
  describe('gantt field reachability anchors on the widget source (finding 4)', () => {
    it('excludes a field from a source unrelated to the widget once a source is adopted', async () => {
      const previousWidget = mockState.doc.widgets['widget-1'];

      try {
        // No relationship declares this source at all — it must never be offered once
        // the widget has an anchor source.
        (mockState.runtime.dataSources as Record<string, unknown>).unrelated = {
          id: 'unrelated',
          label: 'Unrelated',
          fields: [{ id: 'note', label: 'Note', type: 'string' }],
          rows: [],
        };
        mockState.doc.widgets['widget-1'] = {
          ...previousWidget,
          sourceId: 'orders',
          config: {
            chartType: 'gantt',
          },
        };

        const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

        const labelInput = screen.getByLabelText('Label field', { exact: false });
        await user.click(labelInput);

        // The widget's own field is offered...
        expect(await screen.findByRole('option', { name: /Order ID$/ })).toBeVisible();
        // ...but the unrelated source's field is not, now that the widget's own
        // already-adopted `sourceId` anchors `reachableFields` for gantt too.
        expect(screen.queryByRole('option', { name: /Note$/ })).toBeNull();
      } finally {
        mockState.doc.widgets['widget-1'] = previousWidget;
        delete (mockState.runtime.dataSources as Record<string, unknown>).unrelated;
      }
    });

    it('offers every source when the widget has no source yet (first pick establishes the anchor)', async () => {
      const previousWidget = mockState.doc.widgets['widget-1'];

      try {
        (mockState.runtime.dataSources as Record<string, unknown>).unrelated = {
          id: 'unrelated',
          label: 'Unrelated',
          fields: [{ id: 'note', label: 'Note', type: 'string' }],
          rows: [],
        };
        mockState.doc.widgets['widget-1'] = {
          ...previousWidget,
          config: {
            chartType: 'gantt',
          },
        };
        // No source yet — remove it rather than assign `undefined` (the fixture's inferred
        // type requires `sourceId: string`).
        delete (mockState.doc.widgets['widget-1'] as Record<string, unknown>).sourceId;

        const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

        const labelInput = screen.getByLabelText('Label field', { exact: false });
        await user.click(labelInput);

        expect(await screen.findByRole('option', { name: /Note$/ })).toBeVisible();
      } finally {
        mockState.doc.widgets['widget-1'] = previousWidget;
        delete (mockState.runtime.dataSources as Record<string, unknown>).unrelated;
      }
    });
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

/**
 * H4 — `analyzeCombination`'s override merge used `??`, which cannot tell "explicitly
 * cleared" from "not supplied". The X-field picker's unrelated-source branch clears
 * `seriesField` (and now the scatter aux fields) precisely so an unrelated-source
 * candidate is validated ALONE against the source it would adopt; `??` silently put the
 * old source's fields back, every candidate came back `field_not_found_or_not_direct`,
 * and — since a chart has no separate source picker — the widget could never be
 * re-pointed at another source at all, with nothing on screen explaining why.
 */
describe('ChartSetupPanel — X-field adoption survives other configured fields (H4)', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('keeps an unrelated-source X option enabled while a split-by field is configured', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'region', label: 'Region', type: 'string' },
        ],
      };
      // No declared relationship references this source — it is unrelated to `orders`.
      (mockState.runtime.dataSources as Record<string, unknown>).tickets = {
        id: 'tickets',
        label: 'Tickets',
        fields: [{ id: 'zone', label: 'Zone', type: 'string' }],
        rows: [],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        // The split-by that used to be re-injected into the candidate's validation.
        config: { chartType: 'bar', xField: 'id', seriesField: 'region' },
      };

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);
      await user.click(screen.getByLabelText('X / Category field', { exact: false }));

      const zoneOption = await screen.findByRole('option', { name: /Zone$/ });
      // Validated alone against `tickets`, `zone` is a valid direct field → enabled. With
      // the `??` merge, `region` (an `orders` field) was validated against `tickets` too,
      // so the whole source was greyed out and adoption was impossible.
      expect(zoneOption.getAttribute('aria-disabled')).toBe('false');
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
      delete (mockState.runtime.dataSources as Record<string, unknown>).tickets;
    }
  });

  it('keeps an unrelated-source X option enabled while scatter colour/size fields are configured', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [
          { id: 'amount', label: 'Amount', type: 'number' },
          { id: 'weight', label: 'Weight', type: 'number' },
          { id: 'grade', label: 'Grade', type: 'string' },
        ],
      };
      (mockState.runtime.dataSources as Record<string, unknown>).tickets = {
        id: 'tickets',
        label: 'Tickets',
        // Scatter's X picker offers numeric fields only.
        fields: [{ id: 'score', label: 'Score', type: 'number' }],
        rows: [],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: {
          chartType: 'scatter',
          xField: 'amount',
          // These two were not overridden AT ALL by the picker's unrelated-source branch,
          // so they kept anchoring the candidate's validation on `orders`.
          scatterColorField: 'grade',
          scatterSizeField: 'weight',
        },
      };

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);
      // Scatter's X picker takes numeric fields, so it is labelled "X field (numeric)" —
      // "X / Category field" is the CATEGORICAL label used by the bar-chart sibling test.
      await user.click(screen.getByLabelText('X field (numeric)', { exact: false }));

      const scoreOption = await screen.findByRole('option', { name: /Score$/ });
      expect(scoreOption.getAttribute('aria-disabled')).toBe('false');
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
      delete (mockState.runtime.dataSources as Record<string, unknown>).tickets;
    }
  });

  // The `in`-based merge must not change the ordinary path: a key that is ABSENT from the
  // overrides still falls back to the committed config, so an own-source candidate is
  // still validated against the widget's current anchor.
  it('still validates an own-source X option against the current anchor', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];

    try {
      (mockState.runtime.dataSources as Record<string, unknown>).tickets = {
        id: 'tickets',
        label: 'Tickets',
        fields: [{ id: 'zone', label: 'Zone', type: 'string' }],
        rows: [],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: { chartType: 'bar', xField: 'id', seriesField: 'country' },
      };

      const { user } = render(<ChartSetupPanel widgetId="widget-1" />);
      await user.click(screen.getByLabelText('X / Category field', { exact: false }));

      const ownOption = await screen.findByRole('option', { name: /Order ID$/ });
      expect(ownOption.getAttribute('aria-disabled')).toBe('false');
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      delete (mockState.runtime.dataSources as Record<string, unknown>).tickets;
    }
  });
});
// ─── H3: measure-first configuration acquires a source ───────────────────────
//
// `createDefaultWidget` never sets `sourceId`, so every chart starts source-less and
// `useWidgetRows` returns no rows until a field pick adopts one. Only three of the panel's
// thirteen field pickers did that; the rest dropped the `sourceId` their `onChange` was
// handed, so a user who reached for the measure (or split-by, or a per-type section's own
// picker) before the X field got a permanently blank widget with every option still enabled
// and no warning anywhere. Nothing else in the panel can recover from that: there is no
// source picker to fall back on.
describe('ChartSetupPanel source adoption from a non-anchor field pick (H3)', () => {
  const previousWidget = mockState.doc.widgets['widget-1'];

  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
    controller.updateWidget.mockClear();
    controller.updateWidgetConfig.mockClear();
  });

  afterEach(() => {
    mockState.doc.widgets['widget-1'] = previousWidget;
  });

  /** A source-less widget of the given chart type, mirroring `createDefaultWidget`'s output. */
  function renderSourceless(config: Record<string, unknown>) {
    // The shared fixture's `sourceId` is inferred as `string`; this suite is entirely about
    // the state before one exists, so widen it here rather than loosening the fixture.
    mockState.doc.widgets['widget-1'] = {
      ...previousWidget,
      sourceId: undefined as unknown as string,
      config: config as StudioWidgetConfig,
    };
    return render(<ChartSetupPanel widgetId="widget-1" />);
  }

  /**
   * The arguments of the SOURCE half of an adoption. It commits first and undoably - that is
   * what pushes the pre-gesture doc onto the undo stack - and the config patch then rides
   * along non-undoably, so the whole gesture is ONE undo step. See
   * `commitChartConfigWithSource`. (Both halves are asserted inline in each test rather than
   * behind a shared assertion helper, which `vitest/expect-expect` cannot see through.)
   */
  function sourceCommit(sourceId: string) {
    // No filters in this fixture, so nothing stale to fold in.
    return ['widget-1', { sourceId }, { removeFilterIds: [] }] as const;
  }

  it('adopts the measure field source when the Y picker is used before the X picker', async () => {
    const { user } = renderSourceless({ chartType: 'bar' });

    await user.click(screen.getByLabelText('Y / Measure field', { exact: false }));
    await user.click(await screen.findByRole('option', { name: /Total$/ }));

    expect(controller.updateWidget).toHaveBeenCalledWith(...sourceCommit('orderItems'));
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith(
      'widget-1',
      {
        ySeries: [{ fieldId: 'total' }],
        yField: 'total',
        yAggregation: undefined,
      },
      {
        undoable: false,
      },
    );
  });

  it('adopts the measure field source from a Y-series row picker', async () => {
    const { user } = renderSourceless({
      chartType: 'bar',
      ySeries: [{ fieldId: '' }],
    });

    await user.click(screen.getByLabelText('Y / Measure field', { exact: false }));
    await user.click(await screen.findByRole('option', { name: /Total$/ }));

    // A series on a chart that has just adopted the field's own source is NATIVE, so it
    // carries no `sourceId` stamp and mirrors into the flat `yField`.
    expect(controller.updateWidget).toHaveBeenCalledWith(...sourceCommit('orderItems'));
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith(
      'widget-1',
      {
        ySeries: [{ fieldId: 'total', sourceId: undefined }],
        yField: 'total',
      },
      {
        undoable: false,
      },
    );
  });

  it('adopts the split-by field source', async () => {
    const { user } = renderSourceless({ chartType: 'bar' });

    await user.click(screen.getByLabelText('Split by (series field)'));
    await user.click(await screen.findByRole('option', { name: /Country$/ }));

    expect(controller.updateWidget).toHaveBeenCalledWith(...sourceCommit('customers'));
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith(
      'widget-1',
      { seriesField: 'country' },
      {
        undoable: false,
      },
    );
  });

  it('adopts the value field source from the funnel section', async () => {
    const { user } = renderSourceless({ chartType: 'funnel' });

    await user.click(screen.getByLabelText('Value field', { exact: false }));
    await user.click(await screen.findByRole('option', { name: /Total$/ }));

    expect(controller.updateWidget).toHaveBeenCalledWith(...sourceCommit('orderItems'));
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith(
      'widget-1',
      {
        ySeries: [{ fieldId: 'total' }],
        yField: 'total',
      },
      {
        undoable: false,
      },
    );
  });

  it('adopts the target-node field source from the sankey section', async () => {
    const { user } = renderSourceless({ chartType: 'sankey' });

    await user.click(screen.getByLabelText('Target (to) field', { exact: false }));
    await user.click(await screen.findByRole('option', { name: /Country$/ }));

    expect(controller.updateWidget).toHaveBeenCalledWith(...sourceCommit('customers'));
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith(
      'widget-1',
      { sankeyTargetField: 'country' },
      {
        undoable: false,
      },
    );
  });

  it('adopts the row-axis field source from the heatmap section', async () => {
    const { user } = renderSourceless({ chartType: 'heatmap' });

    // The row-axis picker is restricted to the widget's own source, which does not exist
    // yet — it must offer the whole catalog rather than rendering empty, since this very
    // pick is what establishes the source it is then restricted to.
    await user.click(screen.getByLabelText('Row axis field', { exact: false }));
    await user.click(await screen.findByRole('option', { name: /Country$/ }));

    expect(controller.updateWidget).toHaveBeenCalledWith(...sourceCommit('customers'));
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith(
      'widget-1',
      { heatYField: 'country' },
      {
        undoable: false,
      },
    );
  });

  it('adopts the colour-by field source from the scatter section', async () => {
    const { user } = renderSourceless({ chartType: 'scatter' });

    await user.click(screen.getByLabelText('Color by', { exact: false }));
    await user.click(await screen.findByRole('option', { name: /Country$/ }));

    expect(controller.updateWidget).toHaveBeenCalledWith(...sourceCommit('customers'));
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith(
      'widget-1',
      { scatterColorField: 'country' },
      {
        undoable: false,
      },
    );
  });

  // The non-anchor pickers adopt only to give a source-LESS widget its first source. Once the
  // chart is anchored, a reachable cross-source measure is resolved by the anchor-grain
  // mechanism; re-anchoring on it would orphan the X field the user already chose.
  it('does not re-anchor a chart that already has a source', async () => {
    mockState.doc.widgets['widget-1'] = {
      ...previousWidget,
      sourceId: 'orders',
      config: { chartType: 'bar', xField: 'id' } as StudioWidgetConfig,
    };

    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);
    await user.click(screen.getByLabelText('Y / Measure field', { exact: false }));
    await user.click(await screen.findByRole('option', { name: /Total$/ }));

    expect(controller.updateWidget).not.toHaveBeenCalled();
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      ySeries: [{ fieldId: 'total' }],
      yField: 'total',
      yAggregation: undefined,
    });
  });

  // Clearing a field must never adopt anything — there is no picked field to take a source
  // from, and the `sourceId` the picker reports on a clear is meaningless.
  it('does not adopt a source when a field is cleared', async () => {
    const { user } = renderSourceless({ chartType: 'bar', seriesField: 'country' });

    await user.click(screen.getAllByLabelText('Clear field')[0]);

    expect(controller.updateWidget).not.toHaveBeenCalled();
  });
});

// ─── Measure expression fields in the pickers (HIGH 1) ────────────────────────
//
// `buildFieldCatalog` defaults to `expression: 'all'` and stamps `type: ef.type ?? 'number'`, so
// every measure got the `numeric` capability and a slot in every picker in this panel — including
// the chart families whose aggregation path cannot evaluate one, and including dimension pickers
// where a measure is meaningless whatever the chart type.
describe('ChartSetupPanel — measure expression fields', () => {
  const AOV = {
    id: 'aov',
    label: 'Avg order value',
    sourceId: 'orders',
    isMeasure: true,
    type: 'number',
    expression: {
      operator: 'divide',
      inputs: [
        { id: 'total', aggregation: 'sum' },
        { id: 'total', aggregation: 'count' },
      ],
    },
  };

  let previousWidget: (typeof mockState.doc.widgets)['widget-1'];
  let previousExpressionFields: unknown[];
  let previousOrdersFields: unknown[];

  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
    previousWidget = mockState.doc.widgets['widget-1'];
    previousExpressionFields = mockState.doc.expressionFields;
    previousOrdersFields = mockState.runtime.dataSources.orders.fields;
    mockState.doc.expressionFields = [AOV] as never;
    mockState.runtime.dataSources.orders = {
      ...mockState.runtime.dataSources.orders,
      fields: [
        { id: 'id', label: 'Order ID', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
    };
  });

  afterEach(() => {
    mockState.doc.widgets['widget-1'] = previousWidget;
    mockState.doc.expressionFields = previousExpressionFields as never;
    mockState.runtime.dataSources.orders = {
      ...mockState.runtime.dataSources.orders,
      fields: previousOrdersFields as never,
    };
  });

  const setConfig = (config: Record<string, unknown>) => {
    mockState.doc.widgets['widget-1'] = {
      ...previousWidget,
      sourceId: 'orders',
      config: config as StudioWidgetConfig,
    };
  };

  const optionNames = async (user: ReturnType<typeof render>['user'], label: string) => {
    await user.click(screen.getByLabelText(label, { exact: false }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    return names;
  };

  it('offers a measure as the Y measure of a bar chart', async () => {
    setConfig({ chartType: 'bar', xField: 'id' });
    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

    expect(await optionNames(user, 'Y / Measure field')).toEqual(
      expect.arrayContaining([expect.stringContaining('Avg order value')]),
    );
  });

  it('offers a measure as the heatmap colour value, which now aggregates by cell', async () => {
    // `chartShapes/heatmap.ts` used to read `row[valueField]` — a measure has no per-row value,
    // so every cell accumulated nothing and the picker had to hide it. It now buckets each
    // cell's rows and evaluates the measure over them, so the picker offers it again.
    setConfig({ chartType: 'heatmap', xField: 'id', heatYField: 'id' });
    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

    const names = await optionNames(user, 'Value / color field');
    expect(names).toEqual(expect.arrayContaining([expect.stringContaining('Total')]));
    expect(names).toEqual(expect.arrayContaining([expect.stringContaining('Avg order value')]));
  });

  it('still hides a measure from the Y measure picker of a family that cannot evaluate it', async () => {
    // Scatter plots one mark per RAW row, so a value that only exists per bucket has no
    // coordinate to plot — it is not a missing implementation but a property of the family.
    setConfig({ chartType: 'scatter', xField: 'id' });
    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

    const names = await optionNames(user, 'Y field (numeric)');
    expect(names).toEqual(expect.arrayContaining([expect.stringContaining('Total')]));
    expect(names.join('|')).not.toContain('Avg order value');
  });

  it('never offers a measure as the X / category field, even on a measure-capable family', async () => {
    setConfig({ chartType: 'bar', xField: 'id' });
    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

    const names = await optionNames(user, 'X / Category field');
    expect(names).toEqual(expect.arrayContaining([expect.stringContaining('Order ID')]));
    expect(names.join('|')).not.toContain('Avg order value');
  });

  it('never offers a measure as the split-by field', async () => {
    setConfig({ chartType: 'bar', xField: 'id' });
    const { user } = render(<ChartSetupPanel widgetId="widget-1" />);

    const names = await optionNames(user, 'Split by (series field)');
    expect(names.join('|')).not.toContain('Avg order value');
  });
});

// ─── Interactions modes derived from the chart-type registry (HIGH 5) ─────────
describe('ChartSetupPanel — Interactions modes', () => {
  let previousWidget: (typeof mockState.doc.widgets)['widget-1'];

  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
    previousWidget = mockState.doc.widgets['widget-1'];
  });

  afterEach(() => {
    mockState.doc.widgets['widget-1'] = previousWidget;
  });

  const setChartType = (chartType: string, extra: Record<string, unknown> = {}) => {
    mockState.doc.widgets['widget-1'] = {
      ...previousWidget,
      sourceId: 'orders',
      config: { chartType, xField: 'id', ...extra } as StudioWidgetConfig,
    };
  };

  it.each(['bar', 'line', 'pie', 'scatter'])(
    'offers Highlight for %s, which renders a ghost baseline',
    (chartType) => {
      setChartType(chartType);
      render(<ChartSetupPanel widgetId="widget-1" />);

      expect(screen.getByRole('button', { name: 'Highlight', pressed: true })).toBeVisible();
    },
  );

  it.each(['mixed', 'heatmap', 'funnel', 'sankey', 'gantt', 'gauge'])(
    'hides Highlight for %s, whose renderer has no ghost path',
    (chartType) => {
      // Without a ghost, `'cross-highlight'` re-aggregates the cross-filtered rows and rebases
      // the axis/colour scale — a picture identical to `'cross-filter'`, offered under a button
      // claiming otherwise.
      setChartType(chartType);
      render(<ChartSetupPanel widgetId="widget-1" />);

      expect(screen.queryByRole('button', { name: 'Highlight' })).toBe(null);
      expect(screen.getByRole('button', { name: 'Filter', pressed: true })).toBeVisible();
      expect(screen.getByRole('button', { name: 'None', pressed: false })).toBeVisible();
    },
  );

  // WCAG 4.1.2: the "add series" IconButton takes its name from a wrapping `<Tooltip>`,
  // but that Tooltip wraps a `<span>` (the MUI idiom for keeping a tooltip on a disabled
  // control), so the generated `aria-label` lands on the roleless span and the button
  // itself stays unnamed — even when it is enabled.
  it('names the add-series button', () => {
    const previousConfig = mockState.doc.widgets['widget-1'].config;
    const previousOrdersFields = mockState.runtime.dataSources.orders.fields;

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
          { id: 'revenue', label: 'Revenue', type: 'number' },
        ],
      };

      render(<ChartSetupPanel widgetId="widget-1" />);

      const addSeries = screen.getByRole('button', { name: 'Add series' });
      expect(addSeries.getAttribute('disabled')).toBe(null);
    } finally {
      mockState.doc.widgets['widget-1'].config = { ...previousConfig };
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousOrdersFields,
      };
    }
  });

  it('displays a legacy stored cross-highlight as Filter on a non-ghosting family', () => {
    // Nothing rewrites the stored config, and nothing about the rendered chart changes — only
    // the claim the panel makes about it.
    setChartType('heatmap', { crossFilterMode: 'cross-highlight' });
    controller.updateWidgetConfig.mockClear();

    render(<ChartSetupPanel widgetId="widget-1" />);

    expect(screen.getByRole('button', { name: 'Filter', pressed: true })).toBeVisible();
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });
});
