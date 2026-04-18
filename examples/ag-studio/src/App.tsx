import * as React from 'react';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { StudioShell, createStudioController } from '@mui/x-ag-studio';
import type { StudioState } from '@mui/x-ag-studio';

const SALES_SOURCE_ID = 'source-sales';

const salesSource = {
  id: SALES_SOURCE_ID,
  label: 'Sales',
  fields: [
    { id: 'product', label: 'Product', type: 'string' as const },
    { id: 'category', label: 'Category', type: 'string' as const },
    { id: 'region', label: 'Region', type: 'string' as const },
    { id: 'revenue', label: 'Revenue', type: 'number' as const },
    { id: 'quantity', label: 'Quantity', type: 'number' as const },
    { id: 'margin', label: 'Margin %', type: 'number' as const },
  ],
  rows: [
    { id: 1, product: 'Alpha Pro', category: 'Software', region: 'DACH', revenue: 12400, quantity: 8, margin: 62 },
    { id: 2, product: 'Beta Suite', category: 'Hardware', region: 'UK', revenue: 9750, quantity: 5, margin: 38 },
    { id: 3, product: 'Gamma Cloud', category: 'Software', region: 'Nordics', revenue: 18200, quantity: 12, margin: 71 },
    { id: 4, product: 'Delta Device', category: 'Hardware', region: 'DACH', revenue: 6300, quantity: 3, margin: 22 },
    { id: 5, product: 'Epsilon Analytics', category: 'Software', region: 'UK', revenue: 21500, quantity: 15, margin: 68 },
    { id: 6, product: 'Zeta Connect', category: 'Services', region: 'Nordics', revenue: 7800, quantity: 6, margin: 45 },
    { id: 7, product: 'Eta Platform', category: 'Software', region: 'DACH', revenue: 16900, quantity: 11, margin: 74 },
    { id: 8, product: 'Theta Hub', category: 'Hardware', region: 'UK', revenue: 4200, quantity: 2, margin: 18 },
    { id: 9, product: 'Iota Insights', category: 'Services', region: 'DACH', revenue: 9100, quantity: 7, margin: 53 },
    { id: 10, product: 'Kappa Flow', category: 'Software', region: 'Nordics', revenue: 14600, quantity: 9, margin: 66 },
  ],
};

const salesBindings = salesSource.fields.map((f) => ({ field: f.id, label: f.label }));

const INITIAL_STATE: Partial<StudioState> = {
  dashboard: {
    id: 'dashboard-sales',
    title: 'Sales Dashboard',
    activePageId: 'page-1',
  },
  pages: {
    'page-1': {
      id: 'page-1',
      title: 'Overview',
      widgetIds: ['widget-kpi-revenue', 'widget-kpi-quantity', 'widget-chart-region', 'widget-grid-1'],
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
    selectedWidgetId: 'widget-kpi-revenue',
  },
};

const controller = createStudioController(INITIAL_STATE);

const theme = createTheme({
  cssVariables: true,
  colorSchemes: { light: true, dark: true },
});

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <StudioShell controller={controller} />
    </ThemeProvider>
  );
}
