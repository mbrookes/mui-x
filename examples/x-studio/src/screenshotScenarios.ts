/**
 * Fixture registry for the widget-config-panel screenshot harness (`ScreenshotHarness.tsx`).
 *
 * Each scenario is a minimal `Partial<StudioState>` that puts one widget's setup panel
 * into a specific, named state. `test/e2e-studio/setupPanelScreenshots.spec.ts` iterates
 * this list, navigates to `/?panelScreenshot=<id>`, and screenshots the rendered panel.
 *
 * Keep this file free of JSX/React imports — it's consumed both by the browser (via
 * ScreenshotHarness) and by the Playwright spec running in Node.
 */
import type { StudioState, StudioWidgetConfig, StudioDataSource } from '@mui/x-studio';

export interface ScreenshotScenario {
  id: string;
  panel: 'chart' | 'grid' | 'kpi' | 'map' | 'pivot' | 'filter' | 'text';
  description: string;
  widgetId: string;
  initialState: Partial<StudioState>;
}

const ORDERS_SOURCE: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'id', label: 'Order ID', type: 'string' },
    { id: 'date', label: 'Order Date', type: 'date' },
    { id: 'total', label: 'Total', type: 'number' },
    { id: 'revenue', label: 'Revenue', type: 'number' },
    { id: 'department', label: 'Department', type: 'string' },
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'region', label: 'Region', type: 'string' },
  ],
  rows: [],
};

const CUSTOMERS_SOURCE: StudioDataSource = {
  id: 'customers',
  label: 'Customers',
  fields: [{ id: 'country', label: 'Country', type: 'string' }],
  rows: [],
};

const BASE_DATA_SOURCES: Record<string, StudioDataSource> = {
  orders: ORDERS_SOURCE,
  customers: CUSTOMERS_SOURCE,
};

function chartScenario(
  id: string,
  description: string,
  config: StudioWidgetConfig,
): ScreenshotScenario {
  return {
    id,
    panel: 'chart',
    description,
    widgetId: 'w1',
    initialState: {
      dataSources: BASE_DATA_SOURCES,
      widgets: {
        w1: { id: 'w1', kind: 'chart', title: 'Widget', sourceId: 'orders', config },
      },
    },
  };
}

export const SCREENSHOT_SCENARIOS: ScreenshotScenario[] = [
  chartScenario('chart-type-picker-empty', 'Chart type picker, nothing configured yet', {}),
  chartScenario('chart-bar-basic', 'Bar chart with X and Y fields set', {
    chartType: 'bar',
    xField: 'department',
    yField: 'total',
  }),
  chartScenario('chart-bar-fieldless-count', 'Bar chart, fieldless locked Count aggregation', {
    chartType: 'bar',
    xField: 'department',
    yAggregation: 'count',
  }),
  chartScenario('chart-bar-horizontal', 'Bar chart, horizontal layout (axis labels flip)', {
    chartType: 'bar',
    xField: 'department',
    yField: 'total',
    barLayout: 'horizontal',
  }),
  chartScenario('chart-line-multi-series', 'Line chart with two Y series', {
    chartType: 'line',
    xField: 'date',
    ySeries: [{ fieldId: 'total' }, { fieldId: 'revenue' }],
  }),
  chartScenario('chart-pie-basic', 'Pie chart with category and measure field', {
    chartType: 'pie',
    xField: 'category',
    yField: 'total',
  }),
  chartScenario('chart-donut-fieldless-count', 'Donut chart, fieldless locked Count', {
    chartType: 'donut',
    xField: 'category',
    yAggregation: 'count',
  }),
  chartScenario('chart-gauge', 'Gauge chart with value field and min/max', {
    chartType: 'gauge',
    yField: 'total',
    gaugeMin: 0,
    gaugeMax: 10000,
  }),
  chartScenario('chart-scatter', 'Scatter chart with X/Y and colour-by field', {
    chartType: 'scatter',
    xField: 'total',
    yField: 'revenue',
    scatterColorField: 'category',
  }),
  chartScenario('chart-funnel', 'Funnel chart with stage and value fields', {
    chartType: 'funnel',
    xField: 'category',
    yField: 'total',
  }),
  chartScenario('chart-heatmap', 'Heatmap with row axis, column axis and value field', {
    chartType: 'heatmap',
    xField: 'region',
    heatYField: 'department',
    yField: 'total',
  }),
  chartScenario('chart-sankey', 'Sankey with source, target and value fields', {
    chartType: 'sankey',
    xField: 'category',
    sankeyTargetField: 'region',
    yField: 'total',
  }),
  chartScenario('chart-sankey-show-values', 'Sankey with "show values on links" enabled', {
    chartType: 'sankey',
    xField: 'category',
    sankeyTargetField: 'region',
    yField: 'total',
    sankeyShowValues: true,
  }),
  chartScenario('chart-gantt', 'Gantt chart with label/start/end/colour fields', {
    chartType: 'gantt',
    ganttLabelField: 'department',
    ganttStartField: 'date',
    ganttEndField: 'date',
    ganttColorField: 'category',
  }),
  chartScenario('chart-mixed-dual-axis', 'Mixed bar+line chart with dual Y axis enabled', {
    chartType: 'mixed',
    xField: 'date',
    ySeries: [
      { fieldId: 'total', type: 'bar' },
      { fieldId: 'revenue', type: 'line' },
    ],
    dualYAxis: true,
  }),
  chartScenario('chart-annotations', 'Bar chart with two reference-line annotations', {
    chartType: 'bar',
    xField: 'department',
    yField: 'total',
    annotations: [
      { id: 'a1', axis: 'y', value: 1000, label: 'Target' },
      { id: 'a2', axis: 'y', value: 500 },
    ],
  }),
  chartScenario('chart-cross-filter-highlight', 'Bar chart, cross-filter mode = highlight', {
    chartType: 'bar',
    xField: 'department',
    yField: 'total',
    crossFilterMode: 'cross-highlight',
  }),
  chartScenario('chart-cross-filter-filter', 'Bar chart, cross-filter mode = filter', {
    chartType: 'bar',
    xField: 'department',
    yField: 'total',
    crossFilterMode: 'cross-filter',
  }),
  chartScenario(
    'chart-unsupported-combo',
    'X field from an unrelated source with no relationship — shows the unsupported-combination warning',
    {
      chartType: 'bar',
      xField: 'country',
      yField: 'total',
    },
  ),
];
