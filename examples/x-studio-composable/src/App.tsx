import * as React from 'react';
import { Alert, Box, Chip, CssBaseline, Snackbar, ThemeProvider } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import StorageIcon from '@mui/icons-material/Storage';
import TuneIcon from '@mui/icons-material/Tune';
import FilterListIcon from '@mui/icons-material/FilterList';
import {
  CanvasScrollContext,
  DrawerPanel,
  StudioCanvas,
  StudioComposeDrawer,
  StudioController,
  StudioDataDrawer,
  StudioFiltersDrawer,
  StudioProvider,
  createStudioController,
  downloadState,
  selectDashboard,
  selectDataSources,
  selectMode,
  selectPages,
  selectShell,
  selectWidgets,
  useStudioController,
  useStudioKeyboardShortcuts,
  useStudioSelector,
} from '@mui/x-studio';
import type { StudioMode, StudioPage, StudioState } from '@mui/x-studio';
import { INITIAL_STATE } from './config/salesDashboard';
import { AppToolbar } from './components/AppToolbar';
import { uploadJson } from './utils/fileUtils';
import { theme } from './theme';
import { generateSalesData } from './salesData/generator';
import { createAdapter } from './simulatedServer';

const MIN_CANVAS_WIDTH = 480;

// ── URL helpers ───────────────────────────────────────────────────────────────

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

function getUrlRowsParam(): number | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const raw = new URL(window.location.href).searchParams.get('rows');
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

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

// ── Build initial state ───────────────────────────────────────────────────────

function buildInitialState(): Partial<StudioState> {
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
    dashboard: { ...base.dashboard, activePageId: urlPageId },
  } as Partial<StudioState>;
}

// ── Dashboard layout (composable — no <Studio> wrapper) ───────────────────────

interface DashboardLayoutProps {
  adapterMode: boolean;
  onSnackbar: (message: string, severity: 'success' | 'error' | 'info') => void;
}

/**
 * Demonstrates the composable API: `StudioProvider` is provided by the parent
 * (`App`), and this component assembles the layout manually from the individual
 * exported primitives rather than using the monolithic `<Studio>` component.
 *
 * Key primitives used:
 * - `useStudioController` — direct access to the controller
 * - `useStudioSelector` / selectors — reactive state reads
 * - `useStudioKeyboardShortcuts` — Cmd+Z undo / Cmd+Shift+Z redo
 * - `DrawerPanel` — collapsible sidebar panel
 * - `StudioDataDrawer`, `StudioComposeDrawer`, `StudioFiltersDrawer` — drawer contents
 * - `StudioCanvas` — the widget grid
 * - `CanvasScrollContext` — scroll-to-bottom after adding widgets
 */
function DashboardLayout({ adapterMode, onSnackbar }: DashboardLayoutProps) {
  const controller = useStudioController();

  // Register Cmd+Z / Cmd+Shift+Z keyboard shortcuts
  useStudioKeyboardShortcuts();

  // Read reactive state via selectors
  const mode = useStudioSelector(selectMode);
  const shell = useStudioSelector(selectShell);
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const dashboard = useStudioSelector(selectDashboard);
  const pages = useStudioSelector(selectPages);

  // canUndo / canRedo are not part of the reactive store state; subscribe manually
  const [canUndo, setCanUndo] = React.useState(() => controller.canUndo());
  const [canRedo, setCanRedo] = React.useState(() => controller.canRedo());
  React.useEffect(
    () =>
      controller.subscribe(() => {
        setCanUndo(controller.canUndo());
        setCanRedo(controller.canRedo());
      }),
    [controller],
  );

  // Activate adapter mode once on mount
  React.useEffect(() => {
    if (!adapterMode) {
      return;
    }
    for (const source of Object.values(dataSources)) {
      if (source.rows && source.rows.length > 0) {
        controller.setDataSourceAdapter(source.id, createAdapter(source.rows));
      }
    }
    // eslint-disable-next-line no-console
    console.info('[x-studio] Adapter mode enabled — all sources routed through simulatedServer');
    // Intentionally runs only on mount; adapterMode is read from URL and stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compose drawer: title and back-button are derived from shell selection state
  const { selectedWidgetId, selectedFieldId, selectedSourceId } = shell;
  const selectedWidget = selectedWidgetId ? (widgets[selectedWidgetId] ?? null) : null;
  const selectedField = React.useMemo(() => {
    if (!selectedSourceId || !selectedFieldId) {
      return null;
    }
    return dataSources[selectedSourceId]?.fields.find((f) => f.id === selectedFieldId) ?? null;
  }, [dataSources, selectedSourceId, selectedFieldId]);

  const composeTitle = selectedWidget?.title ?? selectedField?.label ?? 'Compose';
  const hasSelection = Boolean(selectedWidgetId ?? selectedFieldId ?? selectedSourceId);
  const composeOnBack = hasSelection ? () => controller.clearSelection() : undefined;

  // Sync active page id to the URL ?page= query param
  const { activePageId } = dashboard;
  React.useEffect(() => {
    if (!activePageId) {
      return;
    }
    setUrlPageId(activePageId, pages);
  }, [activePageId, pages]);

  // Toolbar handlers
  const handleModeChange = React.useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      controller.setMode(checked ? 'edit' : 'view');
    },
    [controller],
  );

  const handleUndo = React.useCallback(() => controller.undo(), [controller]);
  const handleRedo = React.useCallback(() => controller.redo(), [controller]);

  const handleSave = React.useCallback(() => {
    const state = controller.getState();
    // downloadState serializes the state and prompts a file download
    downloadState(state);
    onSnackbar('Dashboard saved successfully', 'success');
  }, [controller, onSnackbar]);

  const handleLoad = React.useCallback(async () => {
    try {
      const data = await uploadJson();
      // loadSerializedState handles migration and replaces the current state
      const result = controller.loadSerializedState(data);
      if (result.success) {
        if (result.fromVersion !== result.toVersion) {
          onSnackbar(
            `Dashboard loaded and migrated from v${result.fromVersion} to v${result.toVersion}`,
            'info',
          );
        } else {
          onSnackbar('Dashboard loaded successfully', 'success');
        }
      } else {
        onSnackbar(result.errors.join('; ') || 'Failed to load dashboard', 'error');
      }
    } catch (error) {
      onSnackbar(
        error instanceof Error ? error.message : 'Failed to load dashboard',
        'error',
      );
    }
  }, [controller, onSnackbar]);

  const handlePageChange = React.useCallback(
    (_event: React.SyntheticEvent, pageId: string) => {
      controller.setActivePage(pageId);
    },
    [controller],
  );

  const pageList = Object.values(pages);
  const canvasScrollRef = React.useRef<HTMLDivElement>(null);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppToolbar
        title={dashboard.title}
        mode={mode as StudioMode}
        onModeChange={handleModeChange}
        onSave={handleSave}
        onLoad={handleLoad}
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

        {/* Composable layout: drawers and canvas assembled without <Studio> */}
        <Box sx={{ display: 'flex', height: '100%', bgcolor: 'background.default' }}>
          <CanvasScrollContext.Provider value={canvasScrollRef}>
            {mode === 'edit' && (
              <DrawerPanel drawer="data" title="Data" icon={<StorageIcon fontSize="small" />}>
                <StudioDataDrawer />
              </DrawerPanel>
            )}
            {mode === 'edit' && (
              <DrawerPanel
                drawer="compose"
                title={composeTitle}
                icon={<TuneIcon fontSize="small" />}
                onBack={composeOnBack}
              >
                <StudioComposeDrawer />
              </DrawerPanel>
            )}
            <DrawerPanel drawer="filters" title="Filters" icon={<FilterListIcon fontSize="small" />}>
              <StudioFiltersDrawer />
            </DrawerPanel>

            <Box
              ref={canvasScrollRef}
              sx={{
                flexGrow: 1,
                minWidth: 0,
                overflow: 'auto',
                bgcolor: (t) => (t.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
              }}
            >
              <Box sx={{ minWidth: MIN_CANVAS_WIDTH, minHeight: '100%' }}>
                <StudioCanvas />
              </Box>
            </Box>
          </CanvasScrollContext.Provider>
        </Box>
      </Box>
    </Box>
  );
}

// ── Root app — creates the controller, then provides it ───────────────────────

export default function App() {
  const adapterMode = React.useMemo(() => getUrlAdapterParam(), []);

  // Create the controller once with the resolved initial state.
  // In the composable pattern we hold the controller directly (no imperative ref)
  // and pass it to StudioProvider so all descendant components can access it.
  const controller = React.useMemo<StudioController>(
    () => createStudioController(buildInitialState()),
    [],
  );

  const [snackbar, setSnackbar] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });

  const handleSnackbar = React.useCallback(
    (message: string, severity: 'success' | 'error' | 'info') => {
      setSnackbar({ open: true, message, severity });
    },
    [],
  );

  const handleCloseSnackbar = React.useCallback(() => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <CssBaseline />
        {/* StudioProvider makes the controller available to all descendants */}
        <StudioProvider controller={controller}>
          <DashboardLayout adapterMode={adapterMode} onSnackbar={handleSnackbar} />
        </StudioProvider>
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
      </LocalizationProvider>
    </ThemeProvider>
  );
}
