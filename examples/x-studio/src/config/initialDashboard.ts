import type { StudioState } from '../../../../packages/x-studio/src';
import { SALES_SOURCE_ID, salesSource, salesBindings } from '../data/salesData';

export const INITIAL_STATE: Partial<StudioState> = {
  dashboard: {
    id: 'dashboard-sales',
    title: 'Sales Dashboard',
    activePageId: 'page-1',
  },
  pages: {
    'page-1': {
      id: 'page-1',
      title: 'Overview',
      widgetRows: [
        ['widget-kpi-revenue', 'widget-kpi-quantity'],
        ['widget-chart-region'],
        ['widget-grid-1'],
      ],
    },
  },
  dataSources: {
    [SALES_SOURCE_ID]: salesSource,
  },
  widgets: {
    'widget-kpi-revenue': {
      id: 'widget-kpi-revenue',
      kind: 'kpi',
      title: 'Total Revenue',
      sourceId: SALES_SOURCE_ID,
      layout: { x: 0, y: 0, width: 3, height: 3 },
      bindings: salesBindings,
      config: { kpiValueField: 'revenue', kpiAggregation: 'sum', kpiFormat: 'currency' },
    },
    'widget-kpi-quantity': {
      id: 'widget-kpi-quantity',
      kind: 'kpi',
      title: 'Total Units Sold',
      sourceId: SALES_SOURCE_ID,
      layout: { x: 3, y: 0, width: 3, height: 3 },
      bindings: salesBindings,
      config: { kpiValueField: 'quantity', kpiAggregation: 'sum', kpiFormat: 'number' },
    },
    'widget-chart-region': {
      id: 'widget-chart-region',
      kind: 'chart',
      title: 'Revenue by Region',
      sourceId: SALES_SOURCE_ID,
      layout: { x: 0, y: 3, width: 6, height: 6 },
      bindings: salesBindings,
      config: { chartType: 'bar', xField: 'region', yField: 'revenue' },
    },
    'widget-grid-1': {
      id: 'widget-grid-1',
      kind: 'grid',
      title: 'Sales Details',
      sourceId: SALES_SOURCE_ID,
      layout: { x: 0, y: 9, width: 12, height: 8 },
      bindings: salesBindings,
      config: { columns: salesSource.fields.map((f) => f.id) },
    },
  },
  shell: {
    openDrawers: { data: true, compose: true, filters: false },
    selectedWidgetId: null,
  },
};
