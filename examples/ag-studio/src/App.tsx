import * as React from 'react';
import { Alert, Box, Button, CssBaseline, Snackbar, ThemeProvider, Toolbar, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { AgStudio } from 'ag-studio-react';
import type { AgStudioApiReadyEvent, AgStudioStateUpdatedEvent } from 'ag-studio-react';
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
import { downloadJson, uploadJson } from './utils/fileUtils';
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

export default function App() {
  // AG Studio API is accessed via ref.current.api after onApiReady fires.
  const apiRef = React.useRef<{ getState: () => unknown; setState: (s: unknown) => void } | null>(null);
  const [mode, setMode] = React.useState<'edit' | 'view'>('edit');
  const [snackbar, setSnackbar] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });

  // Build AG Studio data from the sales data sources.
  const data = React.useMemo(() => {
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

  const handleApiReady = React.useCallback((event: AgStudioApiReadyEvent) => {
    apiRef.current = event.api;
  }, []);

  const handleStateUpdated = React.useCallback((_event: AgStudioStateUpdatedEvent) => {
    // Reserved for future use (e.g. dirty-state indicator).
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

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        {/* Minimal toolbar */}
        <Toolbar
          variant="dense"
          sx={{ gap: 1, borderBottom: 1, borderColor: 'divider', minHeight: 48 }}
        >
          <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700, fontSize: 15 }}>
            Sales Dashboard
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
          <Button size="small" startIcon={<FolderOpenIcon />} onClick={handleLoad} variant="outlined">
            Load
          </Button>
        </Toolbar>

        {/* AG Studio fills remaining space */}
        <Box sx={{ flexGrow: 1, minHeight: 0 }}>
          <AgStudio
            data={data}
            mode={mode}
            onApiReady={handleApiReady}
            onStateUpdated={handleStateUpdated}
          />
        </Box>
      </Box>

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
