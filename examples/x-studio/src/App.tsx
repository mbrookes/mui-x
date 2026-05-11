import * as React from 'react';
import { Alert, Box, Chip, CssBaseline, Snackbar, ThemeProvider } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { Studio } from '@mui/x-studio';
import type { StudioHandle, StudioMode, StudioPage, StudioState, StudioAIConfig } from '@mui/x-studio';
import { INITIAL_STATE } from './config/salesDashboard';
import { AppToolbar } from './components/AppToolbar';
import { SettingsDialog } from './components/SettingsDialog';
import type { SidebarLayout } from './components/SettingsDialog';
import { downloadJson, uploadJson } from './utils/fileUtils';
import { theme } from './theme';
import { generateSalesData } from './salesData/generator';
import { createAdapter } from './simulatedServer';

function slugifyPageTitle(title: string) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolvePageIdFromQuery(
  pageParam: string | undefined,
  pages: Record<string, StudioPage> | undefined,
) {
  if (!pageParam || !pages) {
    return undefined;
  }

  if (pages[pageParam]) {
    return pageParam;
  }

  const pageList = Object.values(pages);
  const pageIndex = Number.parseInt(pageParam, 10);
  if (!Number.isNaN(pageIndex) && pageIndex >= 1 && pageIndex <= pageList.length) {
    return pageList[pageIndex - 1]?.id;
  }

  return pageList.find((page) => slugifyPageTitle(page.title) === pageParam)?.id;
}

function getUrlPageParam() {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return new URL(window.location.href).searchParams.get('page') ?? undefined;
}

/** Read ?rows=N to enable the data generator (e.g. ?rows=10000 for 10k orders). */
function getUrlRowsParam(): number | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const raw = new URL(window.location.href).searchParams.get('rows');
  if (!raw) {return undefined;}
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Read ?adapter=true to enable simulated-server adapter mode. */
function getUrlAdapterParam(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return new URL(window.location.href).searchParams.has('adapter');
}

function setUrlPageId(pageId: string, pages: Record<string, StudioPage> | undefined) {
  if (typeof window === 'undefined') {
    return;
  }

  const page = pages?.[pageId];
  const url = new URL(window.location.href);
  url.searchParams.set('page', page ? slugifyPageTitle(page.title) || page.id : pageId);
  window.history.replaceState(window.history.state, '', url);
}

export default function App() {
  const studioRef = React.useRef<StudioHandle>(null);
  const initialState = React.useMemo<Partial<StudioState>>(() => {
    const urlPageId = resolvePageIdFromQuery(getUrlPageParam(), INITIAL_STATE.pages);
    const rowCount = getUrlRowsParam();

    let base = INITIAL_STATE;

    if (rowCount !== undefined) {
      const {
        customersSource,
        productsSource,
        ordersSource,
        orderItemsSource,
        shipmentsSource,
        shipmentItemsSource,
      } = generateSalesData({ seed: 42, orderCount: rowCount });
      // eslint-disable-next-line no-console
      console.info(
        `[x-studio] Generated data: ${rowCount} orders, ${ordersSource.rows?.length} order rows`,
      );
      base = {
        ...INITIAL_STATE,
        dataSources: {
          ...INITIAL_STATE.dataSources,
          [customersSource.id]: customersSource,
          [productsSource.id]: productsSource,
          [ordersSource.id]: ordersSource,
          [orderItemsSource.id]: orderItemsSource,
          [shipmentsSource.id]: shipmentsSource,
          [shipmentItemsSource.id]: shipmentItemsSource,
        },
      };
    }

    if (!urlPageId) {
      return base;
    }

    return {
      ...base,
      dashboard: {
        ...base.dashboard,
        activePageId: urlPageId,
      },
    } as Partial<StudioState>;
  }, []);
  const [mode, setMode] = React.useState<StudioMode>('edit');
  const [title, setTitle] = React.useState('');
  const [pages, setPages] = React.useState<Record<string, StudioPage>>({});
  const [activePageId, setActivePageId] = React.useState('');
  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);
  const [snackbar, setSnackbar] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [sidebarLayout, setSidebarLayout] = React.useState<SidebarLayout>('tabbed');

  // AI config — read from Vite env vars set by the developer
  const aiConfig = React.useMemo<StudioAIConfig | undefined>(() => {
    const endpoint = import.meta.env.LLM_ENDPOINT as string | undefined;
    if (!endpoint) {
      return undefined;
    }
    const token = import.meta.env.LLM_TOKEN as string | undefined;
    return {
      endpoint,
      apiKey: import.meta.env.LLM_API_KEY as string | undefined,
      model: (import.meta.env.LLM_MODEL as string | undefined) ?? 'gpt-4o',
      headers: token ? { 'X-Studio-Token': token } : undefined,
    };
  }, []);

  // Adapter mode: wire a simulated-server adapter for every data source
  const adapterMode = React.useMemo(() => getUrlAdapterParam(), []);

  React.useEffect(() => {
    if (!adapterMode) {return;}

    // Read the current data sources from the controller so we get the normalised
    // rows (which may have been generated via ?rows=N) rather than the raw imports.
    const state = studioRef.current?.getState();
    if (!state) {return;}

    for (const source of Object.values(state.dataSources)) {
      if (source.rows && source.rows.length > 0) {
        studioRef.current?.setDataSourceAdapter(source.id, createAdapter(source.rows));
      }
    }
    // eslint-disable-next-line no-console
    console.info('[x-studio] Adapter mode enabled — all sources routed through simulatedServer');
    // Only run once on mount (studioRef.current is stable after mount)
  }, [adapterMode]);

  const handleStateChange = React.useCallback((state: StudioState) => {
    // Use functional updates so React can skip if the value is unchanged,
    // and so the 6 calls are batched into a single App re-render (React 18+).
    setMode((prev) => (prev === state.mode ? prev : state.mode));
    setTitle((prev) => (prev === state.dashboard.title ? prev : state.dashboard.title));
    setPages((prev) => (prev === state.pages ? prev : state.pages));
    setActivePageId((prev) =>
      prev === state.dashboard.activePageId ? prev : state.dashboard.activePageId,
    );
    setCanUndo(studioRef.current?.canUndo() ?? false);
    setCanRedo(studioRef.current?.canRedo() ?? false);
  }, []);

  const handleModeChange = React.useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      studioRef.current?.setMode(checked ? 'edit' : 'view');
    },
    [],
  );

  const handleUndo = React.useCallback(() => {
    studioRef.current?.undo();
  }, []);
  const handleRedo = React.useCallback(() => {
    studioRef.current?.redo();
  }, []);

  const handleSave = React.useCallback(() => {
    const serialized = studioRef.current?.serializeState();
    if (!serialized) {
      return;
    }
    const dashboardTitle = (studioRef.current?.getState().dashboard.title ?? 'dashboard').replace(
      /[^a-z0-9]/gi,
      '_',
    );
    downloadJson(serialized, `${dashboardTitle}_dashboard.json`);
    setSnackbar({ open: true, message: 'Dashboard saved successfully', severity: 'success' });
  }, []);

  const handleLoad = React.useCallback(async () => {
    try {
      const data = await uploadJson();
      const result = studioRef.current?.loadSerializedState(data);
      if (!result) {
        return;
      }
      if (result.success) {
        if (result.fromVersion !== result.toVersion) {
          setSnackbar({
            open: true,
            message: `Dashboard loaded and migrated from v${result.fromVersion} to v${result.toVersion}`,
            severity: 'info',
          });
        } else {
          setSnackbar({
            open: true,
            message: 'Dashboard loaded successfully',
            severity: 'success',
          });
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

  const handleOpenSettings = React.useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const handleCloseSettings = React.useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const handlePageChange = React.useCallback((_event: React.SyntheticEvent, pageId: string) => {
    studioRef.current?.setActivePage(pageId);
  }, []);

  const pageList = Object.values(pages);

  React.useEffect(() => {
    if (!activePageId) {
      return;
    }
    setUrlPageId(activePageId, pages);
  }, [activePageId, pages]);

  return (
    <ThemeProvider theme={theme}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <CssBaseline />
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
          <AppToolbar
            title={title}
            mode={mode}
            onModeChange={handleModeChange}
            onSave={handleSave}
            onLoad={handleLoad}
            onOpenSettings={handleOpenSettings}
            pages={pageList}
            activePageId={activePageId}
            onPageChange={handlePageChange}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={handleUndo}
            onRedo={handleRedo}
          />
          <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
            {adapterMode && (
              <Chip
                label="Adapter Mode"
                size="small"
                color="info"
                sx={{
                  position: 'absolute',
                  bottom: 12,
                  right: 12,
                  zIndex: 10,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                }}
              />
            )}
            <Studio ref={studioRef} initialState={initialState} onStateChange={handleStateChange} sidebarLayout={sidebarLayout} aiConfig={aiConfig} />
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
        <SettingsDialog
          open={settingsOpen}
          onClose={handleCloseSettings}
          values={{ sidebarLayout, rowCount: getUrlRowsParam(), adapterEnabled: adapterMode }}
          onSidebarLayoutChange={setSidebarLayout}
        />
      </LocalizationProvider>
    </ThemeProvider>
  );
}
