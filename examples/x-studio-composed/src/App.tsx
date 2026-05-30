import * as React from 'react';
import { Alert, Box, Chip, CssBaseline, Snackbar, ThemeProvider } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import {
  CanvasScrollContext,
  StudioCanvas,
  StudioController,
  StudioProvider,
  createStudioController,
  deserializeState,
  migrateState,
  selectDashboard,
  selectDataSources,
  selectFilters,
  selectMode,
  selectPages,
  serializeState,
  useStudioController,
  useStudioKeyboardShortcuts,
  useStudioSelector,
} from '@mui/x-studio';
import type {
  StudioAIConfig,
  StudioFeatureFlags,
  StudioFilterOperator,
  StudioFilterState,
  StudioMode,
  StudioPage,
  StudioState,
  SerializedStudioState,
} from '@mui/x-studio';
import { INITIAL_STATE } from './config/salesDashboard';
import { OS_INITIAL_STATE } from './config/officeSuppliesDashboard';
import type { OfficeSuppliesData } from './officeSuppliesData';
import { AppToolbar } from './components/AppToolbar';
import { ComposeDialog } from './components/ComposeDialog';
import { DataDialog } from './components/DataDialog';
import { FiltersDialog } from './components/FiltersDialog';
import { AddWidgetFab } from './components/AddWidgetFab';
import { ChatSidePanel } from './components/ChatSidePanel';
import { EmptyPagePrompt } from './components/EmptyPagePrompt';
import { SettingsDialog } from './components/SettingsDialog';
import { uploadJson, downloadJson } from 'x-studio-shared';
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
  if (!raw) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function getUrlAdapterParam(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return new URL(window.location.href).searchParams.has('adapter');
}

/** Read ?dataset=ag-studio to select the AG Studio Data dataset. */
function getUrlDatasetParam(): 'sales' | 'ag-studio' {
  if (typeof window === 'undefined') {
    return 'sales';
  }
  return new URL(window.location.href).searchParams.get('dataset') === 'ag-studio'
    ? 'ag-studio'
    : 'sales';
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

// ── Filter URL helpers ────────────────────────────────────────────────────────

type EncodedFilterValues = Record<
  string,
  { operator: string; value: unknown; operator2?: string; value2?: unknown }
>;

function encodeFilterValues(filters: StudioFilterState[]): string | null {
  const map: EncodedFilterValues = {};
  for (const f of filters) {
    if (f.scope === 'page' && f.value != null) {
      const entry: EncodedFilterValues[string] = { operator: f.operator, value: f.value };
      if (f.operator2 != null) {
        entry.operator2 = f.operator2;
      }
      if (f.value2 != null) {
        entry.value2 = f.value2;
      }
      map[f.id] = entry;
    }
  }
  if (Object.keys(map).length === 0) {
    return null;
  }
  return btoa(JSON.stringify(map));
}

function decodeFilterValues(encoded: string): EncodedFilterValues | null {
  try {
    return JSON.parse(atob(encoded)) as EncodedFilterValues;
  } catch {
    return null;
  }
}

function getUrlFilterValuesParam(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return new URL(window.location.href).searchParams.get('fv');
}

// ── LocalStorage persistence ──────────────────────────────────────────────────

const LOCAL_STORAGE_KEY = 'x-studio-composed-state';

function readLocalState(): SerializedStudioState | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const result = migrateState(JSON.parse(raw));
    return result.success && result.state ? result.state : null;
  } catch {
    return null;
  }
}

function clearLocalState(): void {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Build initial state ───────────────────────────────────────────────────────

function buildInitialState(osData?: OfficeSuppliesData): Partial<StudioState> {
  const dataset = getUrlDatasetParam();

  // Determine the base data sources from the dataset
  const baseDataSources = (dataset === 'ag-studio' && osData
    ? {
        [osData.storesSource.id]: osData.storesSource,
        [osData.productsSource.id]: osData.productsSource,
        [osData.customersSource.id]: osData.customersSource,
        [osData.ordersSource.id]: osData.ordersSource,
        [osData.orderItemsSource.id]: osData.orderItemsSource,
        [osData.shipmentsSource.id]: osData.shipmentsSource,
      }
    : INITIAL_STATE.dataSources) as Record<string, import('@mui/x-studio').StudioDataSource>;

  // Restore from localStorage if available, merging with the live data sources.
  const saved = readLocalState();
  if (saved) {
    return deserializeState(saved, baseDataSources);
  }

  // AG Studio Data: use OS dashboard config + runtime data sources
  if (dataset === 'ag-studio' && osData) {
    const urlPageId = resolvePageIdFromQuery(getUrlPageParam(), OS_INITIAL_STATE.pages);
    const base: Partial<StudioState> = {
      ...OS_INITIAL_STATE,
      dataSources: baseDataSources,
    };
    if (!urlPageId) {
      return base;
    }
    return { ...base, dashboard: { ...base.dashboard, activePageId: urlPageId } } as Partial<StudioState>;
  }

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

  // Apply ?fv= filter value overrides from URL
  const fvParam = getUrlFilterValuesParam();
  if (fvParam) {
    const filterValues = decodeFilterValues(fvParam);
    if (filterValues && base.filters) {
      base = {
        ...base,
        filters: base.filters.map((f) => {
          const patch = filterValues[f.id];
          if (!patch) {
            return f;
          }
          return {
            ...f,
            operator: patch.operator as StudioFilterOperator,
            value: patch.value,
            ...(patch.operator2 != null && {
              operator2: patch.operator2 as StudioFilterOperator,
            }),
            ...(patch.value2 != null && { value2: patch.value2 }),
          };
        }),
      };
    }
  }

  if (!urlPageId) {
    return base;
  }

  return {
    ...base,
    dashboard: { ...base.dashboard, activePageId: urlPageId },
  } as Partial<StudioState>;
}

// ── Dashboard layout (composed — no <Studio> wrapper) ───────────────────────

interface DashboardLayoutProps {
  adapterMode: boolean;
  aiConfig: StudioAIConfig | undefined;
  onSnackbar: (message: string, severity: 'success' | 'error' | 'info') => void;
  featureFlags: StudioFeatureFlags;
  onFeatureFlagsChange: (flags: StudioFeatureFlags) => void;
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
 * - `ComposeDialog` — dialog for widget configuration (opened via toolbar or AddWidgetFab)
 * - `DataDialog` — dialog for data source management
 * - `FiltersDialog` — dialog for filter management
 * - `AddWidgetFab` — floating action button to add widgets
 * - `StudioCanvas` — the widget grid
 * - `CanvasScrollContext` — scroll-to-bottom after adding widgets
 */
function DashboardLayout({
  adapterMode,
  aiConfig,
  onSnackbar,
  featureFlags,
  onFeatureFlagsChange,
}: DashboardLayoutProps) {
  const controller = useStudioController();

  // Register Cmd+Z / Cmd+Shift+Z keyboard shortcuts
  useStudioKeyboardShortcuts();

  // Read reactive state via selectors
  const mode = useStudioSelector(selectMode);
  const dataSources = useStudioSelector(selectDataSources);
  const dashboard = useStudioSelector(selectDashboard);
  const pages = useStudioSelector(selectPages);
  const filters = useStudioSelector(selectFilters);

  // canUndo / canRedo are not part of the reactive store state; subscribe manually
  const [canUndo, setCanUndo] = React.useState(() => controller.canUndo());
  const [canRedo, setCanRedo] = React.useState(() => controller.canRedo());

  const localSaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () =>
      controller.subscribe(() => {
        setCanUndo(controller.canUndo());
        setCanRedo(controller.canRedo());

        // Persist config changes locally (debounced 1 s).
        if (localSaveTimer.current) {
          clearTimeout(localSaveTimer.current);
        }
        localSaveTimer.current = setTimeout(() => {
          try {
            const state = controller.getState();
            const serialized = serializeState(state);
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(serialized));
          } catch {
            // Ignore storage quota errors
          }
        }, 1000);
      }),
    [controller],
  );

  // Dialog open state for compose, data, and filters
  const [composeOpen, setComposeOpen] = React.useState(false);
  const [dataOpen, setDataOpen] = React.useState(false);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [chatOpen, setChatOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  const handleComposeOpen = React.useCallback(() => setComposeOpen(true), []);
  const handleComposeClose = React.useCallback(() => setComposeOpen(false), []);
  const handleDataOpen = React.useCallback(() => setDataOpen(true), []);
  const handleDataClose = React.useCallback(() => setDataOpen(false), []);
  const handleFiltersOpen = React.useCallback(() => setFiltersOpen(true), []);
  const handleFiltersClose = React.useCallback(() => setFiltersOpen(false), []);
  const handleChatToggle = React.useCallback(() => setChatOpen((prev) => !prev), []);
  const handleSettingsOpen = React.useCallback(() => setSettingsOpen(true), []);
  const handleSettingsClose = React.useCallback(() => setSettingsOpen(false), []);

  const handleAddPage = React.useCallback(() => {
    const newId = controller.addPage('New Page');
    controller.setActivePage(newId);
  }, [controller]);

  const handlePageClose = React.useCallback((pageId: string) => {
    controller.removePage(pageId);
  }, [controller]);

  const handlePageReorder = React.useCallback((pageIds: string[]) => {
    controller.reorderPages(pageIds);
  }, [controller]);

  // Close chat when switching to view mode
  React.useEffect(() => {
    if (mode !== 'edit') {
      setChatOpen(false);
    }
  }, [mode]);

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

  // Sync active page id to the URL ?page= query param
  const { activePageId } = dashboard;
  React.useEffect(() => {
    if (!activePageId) {
      return;
    }
    setUrlPageId(activePageId, pages);
  }, [activePageId, pages]);

  // Sync page-filter values to the URL ?fv= query param (debounced 300 ms)
  const filterSyncTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (filterSyncTimer.current) {
      clearTimeout(filterSyncTimer.current);
    }
    filterSyncTimer.current = setTimeout(() => {
      if (typeof window === 'undefined') {
        return;
      }
      const url = new URL(window.location.href);
      const encoded = encodeFilterValues(filters);
      if (encoded) {
        url.searchParams.set('fv', encoded);
      } else {
        url.searchParams.delete('fv');
      }
      window.history.replaceState(window.history.state, '', url);
    }, 300);
    return () => {
      if (filterSyncTimer.current) {
        clearTimeout(filterSyncTimer.current);
      }
    };
  }, [filters]);

  // Toolbar handlers
  const handleModeChange = React.useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      controller.setMode(checked ? 'edit' : 'view');
    },
    [controller],
  );

  const handleUndo = React.useCallback(() => controller.undo(), [controller]);
  const handleRedo = React.useCallback(() => controller.redo(), [controller]);

  const handleRefresh = React.useCallback(() => {
    const {
      customersSource,
      productsSource,
      ordersSource,
      orderItemsSource,
      shipmentsSource,
      shipmentItemsSource,
    } = generateSalesData({ seed: Date.now() });
    for (const source of [
      customersSource,
      productsSource,
      ordersSource,
      orderItemsSource,
      shipmentsSource,
      shipmentItemsSource,
    ]) {
      if (source.rows) {
        controller.setDataSourceAdapter(source.id, createAdapter(source.rows));
      }
    }
    onSnackbar('Data refreshed', 'success');
  }, [controller, onSnackbar]);

  const handleCopyLink = React.useCallback(() => {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
  }, []);

  const handleReset = React.useCallback(() => {
    clearLocalState();
    onSnackbar('Local changes cleared — reloading demo…', 'info');
    setTimeout(() => window.location.reload(), 800);
  }, [onSnackbar]);

  const handleSave = React.useCallback(() => {
    const serialized = controller.serializeState();
    if (!serialized) {
      return;
    }
    const title = (controller.getState().dashboard.title ?? 'dashboard').replace(
      /[^a-z0-9]/gi,
      '_',
    );
    downloadJson(serialized, `${title}_dashboard.json`);
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
      onSnackbar(error instanceof Error ? error.message : 'Failed to load dashboard', 'error');
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

  const hasEmptyPage = React.useMemo(
    () => pageList.some((p) => (p.widgetRows ?? []).length === 0),
    [pageList],
  );

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
        onComposeOpen={handleComposeOpen}
        onDataOpen={handleDataOpen}
        onFiltersOpen={handleFiltersOpen}
        chatOpen={chatOpen}
        onChatToggle={aiConfig && mode === 'edit' ? handleChatToggle : undefined}
        onAddPage={mode === 'edit' ? handleAddPage : undefined}
        onPageClose={mode === 'edit' ? handlePageClose : undefined}
        onPageReorder={mode === 'edit' ? handlePageReorder : undefined}
        hasEmptyPage={hasEmptyPage}
        onRefresh={handleRefresh}
        onReset={handleReset}
        onCopyLink={handleCopyLink}
        onSettingsOpen={handleSettingsOpen}
      />

      {/* Dialogs — rendered outside the canvas so they overlay everything */}
      <ComposeDialog open={composeOpen} onClose={handleComposeClose} />
      <DataDialog open={dataOpen} onClose={handleDataClose} />
      <FiltersDialog open={filtersOpen} onClose={handleFiltersClose} />
      <SettingsDialog
        open={settingsOpen}
        onClose={handleSettingsClose}
        featureFlags={featureFlags}
        onFeatureFlagsChange={onFeatureFlagsChange}
      />

      <Box sx={{ flexGrow: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {/* Canvas takes full width — side panel slides in alongside it */}
        <Box sx={{ flexGrow: 1, minWidth: 0, position: 'relative' }}>
          {adapterMode && (
            <Chip
              label="Adapter Mode"
              size="small"
              color="info"
              sx={{
                position: 'absolute',
                bottom: aiConfig ? 16 : 80,
                right: 24,
                zIndex: 10,
                fontWeight: 600,
                letterSpacing: 0.3,
              }}
            />
          )}

          <CanvasScrollContext.Provider value={canvasScrollRef}>
            <Box
              ref={canvasScrollRef}
              sx={{
                height: '100%',
                overflow: 'auto',
                bgcolor: (t) => (t.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
              }}
            >
              <Box sx={{ minWidth: MIN_CANVAS_WIDTH, minHeight: '100%' }}>
                {aiConfig &&
                mode === 'edit' &&
                (pages[activePageId]?.widgetRows ?? []).length === 0 ? (
                  <EmptyPagePrompt aiConfig={aiConfig} />
                ) : (
                  <StudioCanvas />
                )}
              </Box>
            </Box>
            {/* Show FAB when in edit mode and the active page already has content */}
            {mode === 'edit' && (pages[activePageId]?.widgetRows ?? []).length > 0 && (
              <AddWidgetFab onWidgetAdded={handleComposeOpen} />
            )}
          </CanvasScrollContext.Provider>
        </Box>

        {/* Slideout AI chat side panel — edit mode only, toggled from toolbar */}
        {aiConfig && (
          <ChatSidePanel aiConfig={aiConfig} open={chatOpen} onClose={handleChatToggle} />
        )}
      </Box>
    </Box>
  );
}

// ── Root app — creates the controller, then provides it ───────────────────────

export default function App() {
  const adapterMode = React.useMemo(() => getUrlAdapterParam(), []);

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

  const [featureFlags, setFeatureFlags] = React.useState<StudioFeatureFlags>({});

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
        <StudioProvider controller={controller} featureFlags={featureFlags}>
          <DashboardLayout
            adapterMode={adapterMode}
            aiConfig={aiConfig}
            onSnackbar={handleSnackbar}
            featureFlags={featureFlags}
            onFeatureFlagsChange={setFeatureFlags}
          />
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
