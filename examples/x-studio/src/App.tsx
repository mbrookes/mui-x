import * as React from 'react';
import {
  Alert,
  Box,
  CssBaseline,
  IconButton,
  Snackbar,
  ThemeProvider,
  Tooltip,
  createTheme,
} from '@mui/material';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import { StudioShell, createStudioController } from '../../../packages/x-studio/src';
import type { StudioState } from '../../../packages/x-studio/src';

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

const controller = createStudioController(INITIAL_STATE);

const theme = createTheme({
  cssVariables: true,
  colorSchemes: { light: true, dark: true },
});

function downloadJson(data: unknown, filename: string) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function uploadJson(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        reject(new Error('No file selected'));
        return;
      }
      try {
        const text = await file.text();
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}

export default function App() {
  const [snackbar, setSnackbar] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });

  const handleSave = React.useCallback(() => {
    const serialized = controller.serializeState();
    const title = controller.getState().dashboard.title.replace(/[^a-z0-9]/gi, '_');
    downloadJson(serialized, `${title}_dashboard.json`);
    setSnackbar({ open: true, message: 'Dashboard saved successfully', severity: 'success' });
  }, []);

  const handleLoad = React.useCallback(async () => {
    try {
      const data = await uploadJson();
      const result = controller.loadSerializedState(data);
      if (result.success) {
        if (result.fromVersion !== result.toVersion) {
          setSnackbar({
            open: true,
            message: `Dashboard loaded and migrated from v${result.fromVersion} to v${result.toVersion}`,
            severity: 'info',
          });
        } else {
          setSnackbar({ open: true, message: 'Dashboard loaded successfully', severity: 'success' });
        }
      } else {
        setSnackbar({
          open: true,
          message: result.errors.join('; ') || 'Failed to load dashboard',
          severity: 'error',
        });
      }
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'Failed to load dashboard',
        severity: 'error',
      });
    }
  }, []);

  const handleCloseSnackbar = () => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ position: 'fixed', top: 8, right: 8, zIndex: 9999, display: 'flex', gap: 0.5 }}>
        <Tooltip title="Load dashboard">
          <IconButton size="small" onClick={handleLoad} aria-label="Load dashboard">
            <FileUploadIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Save dashboard">
          <IconButton size="small" onClick={handleSave} aria-label="Save dashboard">
            <FileDownloadIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <StudioShell controller={controller} />
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={handleCloseSnackbar}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={handleCloseSnackbar} severity={snackbar.severity} sx={{ width: '100%' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </ThemeProvider>
  );
}
