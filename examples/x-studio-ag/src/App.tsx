import * as React from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  Snackbar,
  Tab,
  Tabs,
  ThemeProvider,
  Toolbar,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import SaveIcon from '@mui/icons-material/Save';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { AgStudio } from 'ag-studio-react';
import {
  customersSource,
  ordersSource,
  orderItemsSource,
  productsSource,
  shipmentsSource,
  shipmentItemsSource,
  CUSTOMERS_SOURCE_ID,
  ORDERS_SOURCE_ID,
  ORDER_ITEMS_SOURCE_ID,
  PRODUCTS_SOURCE_ID,
  SHIPMENTS_SOURCE_ID,
  SHIPMENT_ITEMS_SOURCE_ID,
  generateSalesData,
} from './salesData';
import { loadOfficeSuppliesData } from './officeSuppliesData';
import type { AgStudioData } from './officeSuppliesData';
import { downloadJson, uploadJson } from './utils/fileUtils';
import { AG_SALES_DASHBOARD_STATE, PAGES } from './config/salesDashboard';
import { AG_OS_DASHBOARD_STATE, OS_PAGES } from './config/officeSuppliesDashboard';
import { SettingsDialog } from './components/SettingsDialog';
import type { SidebarSide } from './components/SettingsDialog';
import { theme } from './theme';

function getUrlRowsParam(): number | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const raw = new URL(window.location.href).searchParams.get('rows');
  if (!raw) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function getUrlDatasetParam(): 'sales' | 'ag-studio' {
  if (typeof window === 'undefined') {
    return 'sales';
  }
  return new URL(window.location.href).searchParams.get('dataset') === 'ag-studio'
    ? 'ag-studio'
    : 'sales';
}

export default function App() {
  // AG Studio API is accessed via ref.current.api after onApiReady fires.
  const apiRef = React.useRef<{ getState: () => unknown; setState: (s: unknown) => void } | null>(
    null,
  );
  const dataset = React.useMemo(() => getUrlDatasetParam(), []);
  const [mode, setMode] = React.useState<'edit' | 'view'>('edit');
  const [sidebarSide, setSidebarSide] = React.useState<SidebarSide>('right');
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [currentPageId, setCurrentPageId] = React.useState<string>(
    dataset === 'ag-studio'
      ? AG_OS_DASHBOARD_STATE.selectedPageId
      : AG_SALES_DASHBOARD_STATE.selectedPageId,
  );
  const [snackbar, setSnackbar] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });

  // AG Studio Data: async-loaded office supplies dataset
  const [osData, setOsData] = React.useState<AgStudioData | null>(null);

  React.useEffect(() => {
    if (dataset !== 'ag-studio') {
      return;
    }
    loadOfficeSuppliesData().then((data) => {
      setOsData(data);
    });
  }, [dataset]);

  // Build AG Studio data from the sales data sources.
  const salesData = React.useMemo(() => {
    const rowCount = getUrlRowsParam();

    let customers = customersSource;
    let orders = ordersSource;
    let orderItems = orderItemsSource;
    let products = productsSource;
    let shipments = shipmentsSource;
    let shipmentItems = shipmentItemsSource;

    if (rowCount !== undefined) {
      const generated = generateSalesData({ seed: 42, orderCount: rowCount });
      customers = generated.customersSource;
      orders = generated.ordersSource;
      orderItems = generated.orderItemsSource;
      products = generated.productsSource;
      shipments = generated.shipmentsSource;
      shipmentItems = generated.shipmentItemsSource;
    }

    return {
      sources: [
        { id: CUSTOMERS_SOURCE_ID, data: customers.rows ?? [] },
        { id: ORDERS_SOURCE_ID, data: orders.rows ?? [] },
        { id: ORDER_ITEMS_SOURCE_ID, data: orderItems.rows ?? [] },
        { id: PRODUCTS_SOURCE_ID, data: products.rows ?? [] },
        { id: SHIPMENTS_SOURCE_ID, data: shipments.rows ?? [] },
        { id: SHIPMENT_ITEMS_SOURCE_ID, data: shipmentItems.rows ?? [] },
      ],
      relationships: [
        {
          id: 'rel-orders-customers',
          source: { tableId: ORDERS_SOURCE_ID, fieldId: 'customerId' },
          target: { tableId: CUSTOMERS_SOURCE_ID, fieldId: 'id' },
          type: 'many-to-one' as const,
        },
        {
          id: 'rel-orderitems-orders',
          source: { tableId: ORDER_ITEMS_SOURCE_ID, fieldId: 'orderId' },
          target: { tableId: ORDERS_SOURCE_ID, fieldId: 'id' },
          type: 'many-to-one' as const,
        },
        {
          id: 'rel-shipments-orders',
          source: { tableId: SHIPMENTS_SOURCE_ID, fieldId: 'orderId' },
          target: { tableId: ORDERS_SOURCE_ID, fieldId: 'id' },
          type: 'many-to-one' as const,
        },
        {
          id: 'rel-shipmentitems-shipments',
          source: { tableId: SHIPMENT_ITEMS_SOURCE_ID, fieldId: 'shipmentId' },
          target: { tableId: SHIPMENTS_SOURCE_ID, fieldId: 'id' },
          type: 'many-to-one' as const,
        },
        {
          id: 'rel-shipmentitems-orderitems',
          source: { tableId: SHIPMENT_ITEMS_SOURCE_ID, fieldId: 'orderItemId' },
          target: { tableId: ORDER_ITEMS_SOURCE_ID, fieldId: 'id' },
          type: 'many-to-one' as const,
        },
      ],
    };
  }, []);

  const activeData = dataset === 'ag-studio' ? osData : salesData;
  const activePages = dataset === 'ag-studio' ? OS_PAGES : PAGES;
  const activeInitialState =
    dataset === 'ag-studio' ? AG_OS_DASHBOARD_STATE : AG_SALES_DASHBOARD_STATE;
  const studioKey =
    dataset === 'ag-studio'
      ? `ag-studio-${osData ? 'ready' : 'loading'}`
      : `sales-${getUrlRowsParam() ?? 'default'}`;

  const handleApiReady = React.useCallback((event: any) => {
     
    apiRef.current = event.api;
  }, []);

  const handleStateUpdated = React.useCallback((event: any) => {
     
    const newPageId: string | undefined = event?.state?.selectedPageId;
    if (newPageId) {
      setCurrentPageId(newPageId);
    }
  }, []);

  const handleModeChange = React.useCallback(
    (_event: React.MouseEvent, newMode: 'edit' | 'view' | null) => {
      if (newMode) {
        setMode(newMode);
      }
    },
    [],
  );

  const handleSave = React.useCallback(() => {
    const state = apiRef.current?.getState();
    if (!state) {
      return;
    }
    downloadJson(state, 'ag_studio_dashboard.json');
    setSnackbar({ open: true, message: 'Dashboard saved successfully', severity: 'success' });
  }, []);

  const handleLoad = React.useCallback(async () => {
    try {
      const state = await uploadJson();
      apiRef.current?.setState(state);
      setSnackbar({ open: true, message: 'Dashboard loaded successfully', severity: 'success' });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'Failed to load dashboard',
        severity: 'error',
      });
    }
  }, []);

  const handleCloseSnackbar = React.useCallback(() => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  }, []);

  const handlePageChange = React.useCallback((_event: React.SyntheticEvent, pageId: string) => {
    const api = apiRef.current;
    if (!api) {
      return;
    }
    const state = api.getState() as { selectedPageId: string };
    api.setState({ ...state, selectedPageId: pageId });
    setCurrentPageId(pageId);
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        {/* Header: toolbar + page tabs */}
        <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Toolbar variant="dense" sx={{ gap: 1, minHeight: 48 }}>
            <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700, fontSize: 15 }}>
              {dataset === 'ag-studio' ? 'Office Supplies Dashboard' : 'Sales Dashboard'}
            </Typography>
            <ToggleButtonGroup
              value={mode}
              exclusive
              onChange={handleModeChange}
              size="small"
              sx={{ mr: 1 }}
            >
              <ToggleButton value="edit">Edit</ToggleButton>
              <ToggleButton value="view">View</ToggleButton>
            </ToggleButtonGroup>
            <Button size="small" startIcon={<SaveIcon />} onClick={handleSave} variant="outlined">
              Save
            </Button>
            <Button
              size="small"
              startIcon={<FolderOpenIcon />}
              onClick={handleLoad}
              variant="outlined"
            >
              Load
            </Button>
            <Button
              size="small"
              startIcon={<SettingsIcon />}
              onClick={() => setSettingsOpen(true)}
              variant="outlined"
            >
              Settings
            </Button>
          </Toolbar>
          <Tabs
            value={currentPageId}
            onChange={handlePageChange}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ minHeight: 36, px: 2 }}
          >
            {activePages.map((page) => (
              <Tab
                key={page.id}
                label={page.label}
                value={page.id}
                sx={{ minHeight: 36, py: 0.5 }}
              />
            ))}
          </Tabs>
        </Box>

        {/* Loading spinner for AG Studio Data */}
        {dataset === 'ag-studio' && activeData === null ? (
          <Box
            sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flexGrow: 1 }}
          >
            <CircularProgress />
          </Box>
        ) : (
          /* AG Studio fills remaining space */
          <Box sx={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <AgStudio
              key={studioKey}
              style={{ flex: 1, minHeight: 0 }}
              data={activeData as any}
              mode={mode}
              initialState={activeInitialState as any}
              onApiReady={handleApiReady}
              onStateUpdated={handleStateUpdated}
            />
          </Box>
        )}
      </Box>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        values={{
          dataSource: dataset,
          sidebarSide,
          rowCount: getUrlRowsParam(),
          adapterEnabled: new URL(window.location.href).searchParams.has('adapter'),
        }}
        onSidebarSideChange={setSidebarSide}
      />

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
