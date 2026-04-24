export type StudioMode = 'edit' | 'view';

export type StudioDrawer = 'data' | 'compose' | 'filters';

export type StudioWidgetKind = 'grid' | 'chart' | 'kpi' | 'text';

export type StudioChartType =
  | 'bar'
  | 'line'
  | 'pie'
  | 'area'
  | 'scatter'
  | 'bar-grouped'
  | 'bar-stacked';

export type StudioBarLayout = 'grouped' | 'stacked';

export type StudioKpiAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

export type StudioKpiFormat = 'number' | 'currency' | 'percent';

export type StudioFilterOperator =
  | 'equals'
  | 'in'
  | 'not_equals'
  | 'contains'
  | 'greater_than'
  | 'less_than'
  | 'greater_than_or_equal'
  | 'less_than_or_equal';

export interface StudioWidgetLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StudioFieldBinding {
  field: string;
  label?: string;
}

export interface StudioChartSeries {
  fieldId: string;
}

export interface StudioWidgetConfig {
  // Grid config
  columns?: string[];
  // Chart config
  chartType?: StudioChartType;
  barLayout?: StudioBarLayout;
  xField?: string;
  yField?: string;
  /** Multiple Y-axis series (preferred over yField when present) */
  ySeries?: StudioChartSeries[];
  /** Secondary Y field for grouped/stacked charts or scatter Y axis */
  yField2?: string;
  /** Group/series field for grouped or stacked bar charts */
  seriesField?: string;
  // KPI config
  kpiValueField?: string;
  kpiAggregation?: StudioKpiAggregation;
  kpiFormat?: StudioKpiFormat;
  kpiPrefix?: string;
  kpiSuffix?: string;
  // Text config
  textSubtitle?: string;
  textBody?: string;
  // Shared
  measures?: string[];
  dimensions?: string[];
}

export interface StudioWidget {
  id: string;
  kind: StudioWidgetKind;
  title: string;
  sourceId?: string;
  layout: StudioWidgetLayout;
  bindings: StudioFieldBinding[];
  config: StudioWidgetConfig;
}

export interface StudioPage {
  id: string;
  title: string;
  widgetRows: string[][]; // Each row is an array of widget IDs
}

export interface StudioDataField {
  id: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  /** When true, the field is hidden from the data drawer and widget config selects */
  hidden?: boolean;
}

export interface StudioDataSource {
  id: string;
  label: string;
  fields: StudioDataField[];
  rows?: Record<string, unknown>[];
}

export interface StudioFilterState {
  id: string;
  field: string;
  operator: StudioFilterOperator;
  value: unknown;
  scope: 'page' | 'widget' | 'cross-filter';
  widgetId?: string;
  /** For cross-filters: the widget ID that originated the filter */
  sourceWidgetId?: string;
}

export interface StudioShellState {
  openDrawers: Record<StudioDrawer, boolean>;
  selectedWidgetId: string | null;
  selectedFieldId: string | null;
  selectedSourceId: string | null;
}

export interface StudioDashboardState {
  id: string;
  title: string;
  activePageId: string;
}

export interface StudioState {
  schemaVersion: 1;
  mode: StudioMode;
  dashboard: StudioDashboardState;
  pages: Record<string, StudioPage>;
  widgets: Record<string, StudioWidget>;
  dataSources: Record<string, StudioDataSource>;
  filters: StudioFilterState[];
  shell: StudioShellState;
}

const defaultPageId = 'page-1';

export function createDefaultStudioState(overrides?: Partial<StudioState>): StudioState {
  const baseState: StudioState = {
    schemaVersion: 1,
    mode: 'edit',
    dashboard: {
      id: 'dashboard-1',
      title: 'Untitled Dashboard',
      activePageId: defaultPageId,
    },
    pages: {
      [defaultPageId]: {
        id: defaultPageId,
        title: 'Page 1',
        widgetRows: [], // No widgets by default
      },
    },
    widgets: {},
    dataSources: {},
    filters: [],
    shell: {
      openDrawers: {
        data: true,
        compose: true,
        filters: false,
      },
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
    },
  };

  return {
    ...baseState,
    ...overrides,
    dashboard: {
      ...baseState.dashboard,
      ...overrides?.dashboard,
    },
    shell: {
      ...baseState.shell,
      ...overrides?.shell,
      openDrawers: {
        ...baseState.shell.openDrawers,
        ...overrides?.shell?.openDrawers,
      },
      selectedFieldId: overrides?.shell?.selectedFieldId ?? null,
      selectedSourceId: overrides?.shell?.selectedSourceId ?? null,
    },
    pages: overrides?.pages ?? baseState.pages,
    widgets: overrides?.widgets ?? baseState.widgets,
    dataSources: overrides?.dataSources ?? baseState.dataSources,
    filters: overrides?.filters ?? baseState.filters,
  };
}
