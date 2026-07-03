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
import type {
  StudioState,
  StudioWidgetConfig,
  StudioWidgetKind,
  StudioDataSource,
  StudioController,
} from '@mui/x-studio';

/**
 * A scripted step run by the Playwright spec after mount, before the screenshot is
 * taken. Needed for open dropdowns/menus/tooltips: MUI portals poppers outside the
 * drawer's DOM subtree, so scenarios with `interactions` are screenshotted at the
 * full-page level instead of just the drawer root (see setupPanelScreenshots.spec.ts).
 */
export interface ScreenshotInteractionStep {
  action: 'click' | 'hover';
  /** Resolves via Playwright's getByLabel (works when the control's InputLabel is
   * properly aria-associated, as DataSourceFieldSelect's Autocomplete fields are). */
  label?: string;
  /** Resolves via Playwright's getByRole('button', { name }). */
  buttonName?: string;
  /** Resolves via Playwright's getByRole('menuitem', { name }). */
  menuItemName?: string;
  /**
   * Fallback for controls whose InputLabel text is NOT aria-associated with the
   * control (getByLabel finds nothing) — targets the combobox inside the nearest
   * MUI FormControl containing this visible text. Needed for ChartSetupPanel's
   * "Sort by" / "Group by" native Selects — a real gap worth flagging in review,
   * not just a harness workaround.
   */
  formControlText?: string;
}

export interface ScreenshotScenario {
  id: string;
  panel: 'chart' | 'grid' | 'kpi' | 'map' | 'pivot' | 'filter' | 'text';
  description: string;
  widgetId: string;
  initialState: Partial<StudioState>;
  interactions?: ScreenshotInteractionStep[];
  /**
   * Imperative controller calls run once after construction, for state that can't be
   * expressed via `initialState` alone (e.g. KPI's date-range is a top-level filter
   * keyed by widget id, set through `StudioController.setWidgetDateRange`).
   */
  postSetup?: (controller: StudioController) => void;
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

function widgetScenario(
  panel: ScreenshotScenario['panel'],
  kind: StudioWidgetKind,
  id: string,
  description: string,
  config: StudioWidgetConfig,
  opts?: {
    /** Omit to leave the widget's source unset (e.g. a from-scratch Grid/KPI/Pivot). */
    sourceId?: string;
    interactions?: ScreenshotInteractionStep[];
    postSetup?: (controller: StudioController) => void;
  },
): ScreenshotScenario {
  return {
    id,
    panel,
    description,
    widgetId: 'w1',
    initialState: {
      dataSources: BASE_DATA_SOURCES,
      widgets: {
        w1: { id: 'w1', kind, title: 'Widget', sourceId: opts?.sourceId, config },
      },
    },
    ...(opts?.interactions && { interactions: opts.interactions }),
    ...(opts?.postSetup && { postSetup: opts.postSetup }),
  };
}

function chartScenario(
  id: string,
  description: string,
  config: StudioWidgetConfig,
  interactions?: ScreenshotInteractionStep[],
): ScreenshotScenario {
  return widgetScenario('chart', 'chart', id, description, config, {
    sourceId: 'orders',
    interactions,
  });
}

function gridScenario(
  id: string,
  description: string,
  config: StudioWidgetConfig,
  opts?: { sourceId?: string; interactions?: ScreenshotInteractionStep[] },
): ScreenshotScenario {
  return widgetScenario('grid', 'grid', id, description, config, opts);
}

function kpiScenario(
  id: string,
  description: string,
  config: StudioWidgetConfig,
  opts?: {
    sourceId?: string;
    interactions?: ScreenshotInteractionStep[];
    postSetup?: (controller: StudioController) => void;
  },
): ScreenshotScenario {
  return widgetScenario('kpi', 'kpi', id, description, config, { sourceId: 'orders', ...opts });
}

function mapScenario(
  id: string,
  description: string,
  config: StudioWidgetConfig,
  opts?: { interactions?: ScreenshotInteractionStep[] },
): ScreenshotScenario {
  return widgetScenario('map', 'map', id, description, config, {
    sourceId: 'customers',
    ...opts,
  });
}

function pivotScenario(
  id: string,
  description: string,
  config: StudioWidgetConfig,
  opts?: { interactions?: ScreenshotInteractionStep[] },
): ScreenshotScenario {
  return widgetScenario('pivot', 'pivot', id, description, config, {
    sourceId: 'orders',
    ...opts,
  });
}

function filterScenario(
  id: string,
  description: string,
  config: StudioWidgetConfig,
  opts?: { sourceId?: string; interactions?: ScreenshotInteractionStep[] },
): ScreenshotScenario {
  return widgetScenario('filter', 'filter', id, description, config, opts);
}

function textScenario(
  id: string,
  description: string,
  config: StudioWidgetConfig,
): ScreenshotScenario {
  return widgetScenario('text', 'text', id, description, config);
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
  // ── In-edit / interaction states ──────────────────────────────────────────────
  chartScenario(
    'chart-x-field-select-open',
    'X / Category field dropdown open, showing field options',
    { chartType: 'bar' },
    [{ action: 'click', label: 'X / Category field' }],
  ),
  chartScenario(
    'chart-x-field-reopen-when-filled',
    'X / Category field already has a value — clicking it reopens the dropdown ' +
      'instead of requiring the field to be cleared first',
    { chartType: 'bar', xField: 'department', yField: 'total' },
    [{ action: 'click', label: 'X / Category field' }],
  ),
  chartScenario(
    'chart-y-field-select-open',
    'Y / Measure field dropdown open, showing field options',
    { chartType: 'bar', xField: 'department' },
    [{ action: 'click', label: 'Y / Measure field' }],
  ),
  chartScenario(
    'chart-sort-by-select-open',
    'Sort by dropdown open, showing category/value/natural options',
    { chartType: 'bar', xField: 'department', yField: 'total' },
    [{ action: 'click', formControlText: 'Sort by' }],
  ),
  chartScenario(
    'chart-type-picker-hover-tooltip',
    'Chart type picker, hovering the Sankey option — tooltip visible',
    { chartType: 'bar', xField: 'department', yField: 'total' },
    [{ action: 'hover', buttonName: 'Sankey' }],
  ),

  // ── Grid ─────────────────────────────────────────────────────────────────────
  gridScenario('grid-empty', 'No data source chosen yet (explicit source mode)', {}),
  gridScenario(
    'grid-data-source-select-open',
    'Data source dropdown open',
    {},
    { interactions: [{ action: 'click', label: 'Data source' }] },
  ),
  gridScenario(
    'grid-with-columns',
    'Three columns added, cross-filter/group-by/sort fields set',
    {
      columns: [{ fieldId: 'id' }, { fieldId: 'department' }, { fieldId: 'total' }],
      crossFilterField: 'department',
      gridSortField: 'total',
      gridSortDirection: 'desc',
    },
    { sourceId: 'orders' },
  ),
  gridScenario(
    'grid-column-options-menu-open',
    'Column "⋮" options menu open (remove / aggregation)',
    { columns: [{ fieldId: 'id' }, { fieldId: 'department' }, { fieldId: 'total' }] },
    { sourceId: 'orders', interactions: [{ action: 'click', buttonName: 'Options for Total' }] },
  ),
  gridScenario(
    'grid-add-column-menu-open',
    '"Add column" menu open, grouped by source, with the calculated-column entry',
    { columns: [{ fieldId: 'id' }] },
    { sourceId: 'orders', interactions: [{ action: 'click', buttonName: 'Add column' }] },
  ),
  gridScenario(
    'grid-calculated-column-dialog-open',
    'Calculated-column dialog opened from the "Add column" menu',
    { columns: [{ fieldId: 'id' }] },
    {
      sourceId: 'orders',
      interactions: [
        { action: 'click', buttonName: 'Add column' },
        { action: 'click', menuItemName: 'Calculated column…' },
      ],
    },
  ),

  // ── KPI ──────────────────────────────────────────────────────────────────────
  kpiScenario('kpi-empty', 'No value field chosen yet', {}),
  kpiScenario('kpi-basic', 'Value field and aggregation set', {
    kpiValueField: 'total',
    kpiAggregation: 'sum',
  }),
  kpiScenario(
    'kpi-aggregation-select-open',
    'Aggregation dropdown open',
    { kpiValueField: 'total', kpiAggregation: 'sum' },
    { interactions: [{ action: 'click', formControlText: 'Aggregation' }] },
  ),
  kpiScenario(
    'kpi-sparkline-expanded',
    'Sparkline section expanded (CollapsibleFeatureSection starts collapsed on ' +
      'mount regardless of the enabled config — reaching this state needs the click)',
    { kpiValueField: 'total', kpiAggregation: 'sum', kpiSparkline: true },
    { interactions: [{ action: 'click', buttonName: 'Sparkline' }] },
  ),
  kpiScenario(
    'kpi-trend-expanded',
    'Trend section expanded, with the invert-colours switch visible',
    { kpiValueField: 'total', kpiAggregation: 'sum', kpiTrend: true, kpiTrendInvert: true },
    { interactions: [{ action: 'click', buttonName: 'Trend' }] },
  ),
  kpiScenario(
    'kpi-date-range-expanded',
    'Date range section expanded, "last 12 months" preset active',
    { kpiValueField: 'total', kpiAggregation: 'sum' },
    {
      interactions: [{ action: 'click', buttonName: 'Date range' }],
      postSetup: (controller) =>
        controller.setWidgetDateRange('w1', 'date', 'orders', 'date', 'last_12_months'),
    },
  ),

  // ── Map ──────────────────────────────────────────────────────────────────────
  mapScenario('map-empty', 'No region/value field chosen yet', {}),
  mapScenario('map-basic', 'Region and value field set, default colour scheme', {
    mapCountryField: 'country',
    mapValueField: 'total',
    mapValueSourceId: 'orders',
    mapAggregation: 'sum',
  }),
  mapScenario(
    'map-color-scheme-select-open',
    'Colour scheme dropdown open',
    { mapCountryField: 'country', mapValueField: 'total', mapValueSourceId: 'orders' },
    { interactions: [{ action: 'click', formControlText: 'Colour scheme' }] },
  ),
  mapScenario('map-switches-on', 'Scale-from-zero, clickable and cross-filter switches all on', {
    mapCountryField: 'country',
    mapValueField: 'total',
    mapValueSourceId: 'orders',
    mapLegendZeroMin: true,
    mapCrossFilterEmit: true,
    crossFilterMode: 'cross-highlight',
  }),

  // ── Pivot ────────────────────────────────────────────────────────────────────
  pivotScenario('pivot-empty', 'No row/column field chosen yet', {}),
  pivotScenario('pivot-basic', 'Row, column, aggregation and value field set', {
    pivotRowField: 'department',
    pivotColField: 'category',
    pivotAggregation: 'sum',
    pivotValueField: 'total',
  }),
  pivotScenario(
    'pivot-count-hides-value-field',
    'Aggregation = Count hides the value-field picker (counts rows, not values)',
    {
      pivotRowField: 'department',
      pivotColField: 'category',
      pivotAggregation: 'count',
    },
  ),
  pivotScenario(
    'pivot-aggregation-select-open',
    'Aggregation dropdown open',
    {
      pivotRowField: 'department',
      pivotColField: 'category',
      pivotAggregation: 'sum',
      pivotValueField: 'total',
    },
    { interactions: [{ action: 'click', formControlText: 'Aggregation' }] },
  ),

  // ── Filter widget ────────────────────────────────────────────────────────────
  filterScenario(
    'filter-no-field-alert',
    'Control type chosen but no field yet — info alert shown',
    { filterWidgetType: 'multi-select' },
    { sourceId: 'orders' },
  ),
  filterScenario(
    'filter-multi-select',
    'Multi-select control with a field set',
    { filterWidgetType: 'multi-select', filterWidgetField: 'department' },
    { sourceId: 'orders' },
  ),
  filterScenario(
    'filter-toggle-chips',
    'Toggle-chips control with a field set',
    { filterWidgetType: 'toggle', filterWidgetField: 'department' },
    { sourceId: 'orders' },
  ),
  filterScenario(
    'filter-date-range',
    'Date-range control with a temporal field set',
    { filterWidgetType: 'date-range', filterWidgetField: 'date' },
    { sourceId: 'orders' },
  ),
  filterScenario(
    'filter-slider',
    'Slider control with a numeric field and min/max/step set',
    {
      filterWidgetType: 'slider',
      filterWidgetField: 'total',
      filterWidgetMin: 0,
      filterWidgetMax: 10000,
      filterWidgetStep: 100,
    },
    { sourceId: 'orders' },
  ),
  filterScenario(
    'filter-control-type-select-open',
    'Control-type dropdown open, showing each option\'s description',
    { filterWidgetType: 'multi-select' },
    { sourceId: 'orders', interactions: [{ action: 'click', formControlText: 'Control type' }] },
  ),

  // ── Text ─────────────────────────────────────────────────────────────────────
  textScenario('text-plain', 'Title, subtitle and body set, AI mode off', {
    textSubtitle: 'Subtitle text',
    textBody: 'Body copy goes here.',
  }),
  textScenario('text-ai-mode', 'AI mode on — subtitle hidden, body becomes a prompt field', {
    textAiEnabled: true,
    textBody: 'Summarise this quarter\'s revenue trend in two sentences.',
  }),
];
