import * as React from 'react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  CssBaseline,
  Snackbar,
  ThemeProvider,
} from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import {
  CanvasScrollContext,
  StudioCanvas,
  StudioController,
  StudioProvider,
  StudioWidgetEditDialog,
  createBatchingAdapter,
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
import {
  downloadJson,
  uploadJson,
  INITIAL_STATE,
  OS_INITIAL_STATE,
  generateSalesData,
  loadOfficeSuppliesData,
} from 'x-studio-shared';
import type { OfficeSuppliesData } from 'x-studio-shared';
import dayjs from 'dayjs';
import { AppToolbar } from './components/AppToolbar';
import { ComposeDialog } from './components/ComposeDialog';
import { DataDialog } from './components/DataDialog';
import { FiltersDialog } from './components/FiltersDialog';
import { AddWidgetFab } from './components/AddWidgetFab';
import { ChatSidePanel } from './components/ChatSidePanel';
import { WidgetAiDialog } from './components/WidgetAiDialog';
import { EmptyPagePrompt } from './components/EmptyPagePrompt';
import { SettingsDialog } from './components/SettingsDialog';
import type { DataMode } from './components/SettingsDialog';
import { theme } from './theme';
import { createAdapter } from './simulatedServer';
import { ukRegionsGeography } from './config/geographies/ukRegions';
import { type SupportedLocale, LOCALE_BUNDLES } from './locales';
import { AppLocaleProvider, useAppLocaleText } from './locales/AppLocaleContext';

// ── Custom geography registrations ────────────────────────────────────────────
// This is where developers register additional map geographies beyond the
// built-in 'world', 'usa', and 'europe' options. Each entry in this record
// becomes a selectable map type in the Map widget's Setup panel.
const CUSTOM_GEOGRAPHIES = {
  'england-regions': ukRegionsGeography,
};

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

/** Read ?mode=memory|adapter|server — an explicit override that wins over .env config. */
function getUrlModeParam(): DataMode | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const v = new URL(window.location.href).searchParams.get('mode');
  return v === 'memory' || v === 'adapter' || v === 'server' ? v : undefined;
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

const LOCAL_STORAGE_KEY = 'x-studio-composed-state-v8';

function getLocalStorageKey(dataset: 'sales' | 'ag-studio') {
  return `${LOCAL_STORAGE_KEY}-${dataset}`;
}

function readLocalState(dataset: 'sales' | 'ag-studio'): SerializedStudioState | null {
  try {
    const raw = localStorage.getItem(getLocalStorageKey(dataset));
    if (!raw) {
      return null;
    }
    const result = migrateState(JSON.parse(raw));
    return result.success && result.state ? result.state : null;
  } catch {
    return null;
  }
}

// ── Build initial state ───────────────────────────────────────────────────────

function buildInitialState(osData?: OfficeSuppliesData): Partial<StudioState> {
  const dataset = getUrlDatasetParam();

  // Determine the base data sources from the dataset
  const baseDataSources = (
    dataset === 'ag-studio' && osData
      ? {
          [osData.storesSource.id]: osData.storesSource,
          [osData.productsSource.id]: osData.productsSource,
          [osData.customersSource.id]: osData.customersSource,
          [osData.ordersSource.id]: osData.ordersSource,
          [osData.orderItemsSource.id]: osData.orderItemsSource,
          [osData.shipmentsSource.id]: osData.shipmentsSource,
        }
      : INITIAL_STATE.dataSources
  ) as Record<string, import('@mui/x-studio').StudioDataSource>;

  // Restore from localStorage if available, merging with the live data sources.
  const saved = readLocalState(dataset);
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
    return {
      ...base,
      dashboard: { ...base.dashboard, activePageId: urlPageId },
    } as Partial<StudioState>;
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
  dataMode: DataMode;
  rowCount: number | undefined;
  serverConfigured: boolean;
  aiConfig: StudioAIConfig | undefined;
  dataset: 'sales' | 'ag-studio';
  onSnackbar: (message: string, severity: 'success' | 'error' | 'info') => void;
  featureFlags: StudioFeatureFlags;
  onFeatureFlagsChange: (flags: StudioFeatureFlags) => void;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
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
 * - `ComposeDialog` — dialog for widget configuration (opened via toolbar)
 * - `DataDialog` — dialog for data source management
 * - `FiltersDialog` — dialog for filter management
 * - `AddWidgetFab` — floating action button to add widgets
 * - `StudioCanvas` — the widget grid
 * - `CanvasScrollContext` — scroll-to-bottom after adding widgets
 */
// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- dashboard orchestration state is intentionally broad and not naturally reducible
function DashboardLayout({
  dataMode,
  rowCount,
  serverConfigured,
  aiConfig,
  dataset,
  onSnackbar,
  featureFlags,
  onFeatureFlagsChange,
  locale,
  onLocaleChange,
}: DashboardLayoutProps) {
  const controller = useStudioController();
  const t = useAppLocaleText();
  const localStorageKeyRef = React.useRef<string | null>(null);
  if (localStorageKeyRef.current === null) {
    localStorageKeyRef.current = getLocalStorageKey(dataset);
  }

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
            localStorage.setItem(localStorageKeyRef.current!, JSON.stringify(serialized));
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
  const [editWidgetId, setEditWidgetId] = React.useState<string | null>(null);
  const [aiWidgetId, setAiWidgetId] = React.useState<string | null>(null);

  const handleEditRequest = React.useCallback(
    (widgetId: string) => {
      setEditWidgetId(widgetId);
      controller.setSelectedWidget(widgetId);
    },
    [controller],
  );

  const handleAiRequest = React.useCallback(
    (widgetId: string) => {
      setAiWidgetId(widgetId);
      controller.setSelectedWidget(widgetId);
    },
    [controller],
  );

  const handleComposeOpen = React.useCallback(() => setComposeOpen(true), []);
  const handleComposeClose = React.useCallback(() => setComposeOpen(false), []);
  const handleDataOpen = React.useCallback(() => setDataOpen(true), []);
  const handleDataClose = React.useCallback(() => setDataOpen(false), []);
  const handleFiltersOpen = React.useCallback(() => setFiltersOpen(true), []);
  const handleFiltersClose = React.useCallback(() => setFiltersOpen(false), []);
  const handleChatToggle = React.useCallback(() => setChatOpen((prev) => !prev), []);
  const handleSettingsOpen = React.useCallback(() => setSettingsOpen(true), []);
  const handleSettingsClose = React.useCallback(() => setSettingsOpen(false), []);

  const handleUnconfiguredWidgetClick = React.useCallback((_widgetId: string) => {
    setComposeOpen(true);
  }, []);

  const handleAddPage = React.useCallback(() => {
    const newId = controller.addPage(t.newPageLabel);
    controller.setActivePage(newId);
  }, [controller, t]);

  const handlePageClose = React.useCallback(
    (pageId: string) => {
      controller.removePage(pageId);
    },
    [controller],
  );

  const handlePageReorder = React.useCallback(
    (pageIds: string[]) => {
      controller.reorderPages(pageIds);
    },
    [controller],
  );

  // Close chat when switching to view mode
  React.useEffect(() => {
    if (mode !== 'edit') {
      setChatOpen(false);
    }
  }, [mode]);

  // Activate adapter mode once on mount
  React.useEffect(() => {
    if (dataMode !== 'adapter') {
      return;
    }
    for (const source of Object.values(dataSources)) {
      if (source.rows && source.rows.length > 0) {
        controller.setDataSourceAdapter(source.id, createAdapter(source.rows));
      }
    }
    // eslint-disable-next-line no-console
    console.info('[x-studio] Adapter mode enabled — all sources routed through simulatedServer');
    // Intentionally runs only on mount; dataMode is read from URL and stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional mount-only effect
  }, []);

  // Server mode: when STUDIO_SERVER_URL is set, route all data through the dev server.
  // Skipped when dataMode is not 'server' (e.g. rows are set, forcing in-memory mode).
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- example app: fetch without a data-fetching library is acceptable here
  React.useEffect(() => {
    if (dataMode !== 'server') {
      return;
    }
    const serverUrl = import.meta.env.STUDIO_SERVER_URL as string | undefined;
    if (!serverUrl) {
      return;
    }
    const dataEndpoint = `${serverUrl.replace(/\/$/, '')}/api/sales-data`;
    const serverToken = import.meta.env.STUDIO_SERVER_TOKEN as string | undefined;
    const fetchFn: typeof fetch = serverToken
      ? (input, init) =>
          fetch(input, {
            ...init,
            headers: { ...init?.headers, Authorization: `Bearer ${serverToken}` },
          })
      : globalThis.fetch;
    const batchingAdapter = createBatchingAdapter(dataEndpoint, { fetchFn });
    for (const source of Object.values(dataSources)) {
      controller.setDataSourceAdapter(source.id, batchingAdapter);
    }
    // eslint-disable-next-line no-console
    console.info(`[x-studio] Server mode enabled — queries routed to ${dataEndpoint}`);
    // Intentionally runs only on mount; env vars and dataMode are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional mount-only effect
  }, []);

  // Sync active page id to the URL ?page= query param
  const { activePageId } = dashboard;
  React.useEffect(() => {
    if (!activePageId) {
      return;
    }
    setUrlPageId(activePageId, pages);
  }, [activePageId, pages]);

  // Sync page-filter values to the URL ?fv= query param (debounced 300 ms, view mode only)
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
      if (mode !== 'view') {
        url.searchParams.delete('fv');
        window.history.replaceState(window.history.state, '', url);
        return;
      }
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
  }, [filters, mode]);

  // Toolbar handlers
  const handleModeChange = React.useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      controller.setMode(checked ? 'edit' : 'view');
    },
    [controller],
  );

  const handleUndo = React.useCallback(() => controller.undo(), [controller]);
  const handleRedo = React.useCallback(() => controller.redo(), [controller]);

  const handleReset = React.useCallback(() => {
    localStorage.removeItem(localStorageKeyRef.current!);
    onSnackbar(t.resetDemoReloadingMessage, 'info');
    setTimeout(() => window.location.reload(), 800);
  }, [onSnackbar, t]);

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
    onSnackbar(t.dashboardSavedMessage, 'success');
  }, [controller, onSnackbar, t]);

  const handleLoad = React.useCallback(async () => {
    try {
      const data = await uploadJson();
      // loadSerializedState handles migration and replaces the current state
      const result = controller.loadSerializedState(data);
      if (result.success) {
        if (result.fromVersion !== result.toVersion) {
          onSnackbar(
            t.dashboardLoadedMigratedMessage(result.fromVersion, result.toVersion),
            'info',
          );
        } else {
          onSnackbar(t.dashboardLoadedMessage, 'success');
        }
      } else {
        onSnackbar(result.errors.join('; ') || t.dashboardLoadFailedMessage, 'error');
      }
    } catch (error) {
      onSnackbar(error instanceof Error ? error.message : t.dashboardLoadFailedMessage, 'error');
    }
  }, [controller, onSnackbar, t]);

  const handlePageChange = React.useCallback(
    (_event: React.SyntheticEvent, pageId: string) => {
      controller.setActivePage(pageId);
    },
    [controller],
  );

  const handlePageDragNavigate = React.useCallback(
    (pageId: string) => controller.setActivePage(pageId),
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
        onReset={handleReset}
        onSettingsOpen={handleSettingsOpen}
        onPageDragNavigate={handlePageDragNavigate}
      />

      {/* Dialogs — rendered outside the canvas so they overlay everything */}
      <ComposeDialog open={composeOpen} onClose={handleComposeClose} />
      <DataDialog open={dataOpen} onClose={handleDataClose} />
      <FiltersDialog open={filtersOpen} onClose={handleFiltersClose} />
      <SettingsDialog
        open={settingsOpen}
        onClose={handleSettingsClose}
        dataset={dataset}
        rowCount={rowCount}
        dataMode={dataMode}
        serverConfigured={serverConfigured}
        featureFlags={featureFlags}
        onFeatureFlagsChange={onFeatureFlagsChange}
        locale={locale}
        onLocaleChange={onLocaleChange}
      />
      {editWidgetId && (
        <StudioWidgetEditDialog
          open={Boolean(editWidgetId)}
          onClose={() => setEditWidgetId(null)}
          widgetId={editWidgetId}
        />
      )}
      {aiConfig && aiWidgetId && (
        <WidgetAiDialog
          open={Boolean(aiWidgetId)}
          widgetId={aiWidgetId}
          aiConfig={aiConfig}
          onClose={() => setAiWidgetId(null)}
        />
      )}

      <Box sx={{ flexGrow: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {/* Canvas takes full width — side panel slides in alongside it */}
        <Box sx={{ flexGrow: 1, minWidth: 0, position: 'relative' }}>
          {dataMode === 'adapter' && (
            <Chip
              label={t.adapterModeLabel}
              size="small"
              color="info"
              sx={{
                position: 'absolute',
                bottom: aiConfig ? 16 : 80,
                right: 24,
                zIndex: 10,
                fontWeight: 600,
                letterSpacing: 0.3,
                opacity: 0.5,
              }}
            />
          )}
          {dataMode === 'server' && (
            <Chip
              label={t.serverModeLabel}
              size="small"
              color="success"
              sx={{
                position: 'absolute',
                bottom: aiConfig ? 16 : 80,
                right: 24,
                zIndex: 10,
                fontWeight: 600,
                letterSpacing: 0.3,
                opacity: 0.5,
              }}
            />
          )}
          {dataMode === 'memory' && rowCount !== undefined && (
            <Chip
              label={t.generatedRowsLabel(rowCount)}
              size="small"
              sx={{
                position: 'absolute',
                bottom: aiConfig ? 16 : 80,
                right: 24,
                zIndex: 10,
                fontWeight: 600,
                letterSpacing: 0.3,
                opacity: 0.5,
              }}
            />
          )}
          {dataMode === 'memory' && rowCount === undefined && (
            <Chip
              label={t.demoDataLabel}
              size="small"
              sx={{
                position: 'absolute',
                bottom: aiConfig ? 16 : 80,
                right: 24,
                zIndex: 10,
                fontWeight: 600,
                letterSpacing: 0.3,
                opacity: 0.5,
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
              {aiConfig &&
              mode === 'edit' &&
              (pages[activePageId]?.widgetRows ?? []).length === 0 ? (
                <EmptyPagePrompt aiConfig={aiConfig} />
              ) : (
                <StudioCanvas
                  sx={{ minWidth: MIN_CANVAS_WIDTH, minHeight: '100%' }}
                  slotProps={{
                    widgetCard: {
                      onUnconfiguredClick: handleUnconfiguredWidgetClick,
                      onEditRequest: handleEditRequest,
                      onAiRequest: aiConfig ? handleAiRequest : undefined,
                    },
                  }}
                />
              )}
            </Box>
            {/* Show FAB when in edit mode and the active page already has content */}
            {mode === 'edit' && (pages[activePageId]?.widgetRows ?? []).length > 0 && (
              <AddWidgetFab onWidgetAdded={handleEditRequest} />
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

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- top-level orchestration state is intentionally broad and not naturally reducible
export default function App() {
  const rowCount = React.useMemo(() => getUrlRowsParam(), []);
  const dataset = React.useMemo(() => getUrlDatasetParam(), []);
  const serverConfigured = Boolean(import.meta.env.STUDIO_SERVER_URL as string | undefined);
  const dataMode = React.useMemo<DataMode>(() => {
    const explicit = getUrlModeParam();
    if (explicit === 'server') {
      if (rowCount !== undefined) {
        return 'memory';
      }
      return serverConfigured ? 'server' : 'memory';
    }
    if (explicit) {
      return explicit;
    }
    if (getUrlAdapterParam()) {
      return 'adapter';
    }
    if (rowCount !== undefined && serverConfigured) {
      return 'memory';
    }
    return serverConfigured ? 'server' : 'memory';
  }, [serverConfigured, rowCount]);

  const aiConfig = React.useMemo<StudioAIConfig | undefined>(() => {
    const serverUrl = import.meta.env.STUDIO_SERVER_URL as string | undefined;
    if (!serverUrl) {
      return undefined;
    }
    const token = import.meta.env.STUDIO_SERVER_TOKEN as string | undefined;
    return {
      endpoint: `${serverUrl.replace(/\/$/, '')}/api/ai/chat`,
      headers: token ? ({ Authorization: `Bearer ${token}` } as Record<string, string>) : undefined,
    };
  }, []);

  // Async load of Office Supplies data when the ag-studio dataset is selected.
  // The URL ?dataset=ag-studio param is set before this component mounts (page
  // reload via SettingsDialog), so `dataset` is stable for the lifetime of App.
  const [osData, setOsData] = React.useState<OfficeSuppliesData | null>(null);
  React.useEffect(() => {
    if (dataset !== 'ag-studio') {
      return;
    }
    loadOfficeSuppliesData().then((data) => setOsData(data));
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- dataset is stable for the lifetime of the example app
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Show a loading indicator while the OS dataset is being fetched.
  const isLoading = dataset === 'ag-studio' && osData === null;

  // Create the controller once the initial state can be fully resolved.
  // For ag-studio, this depends on osData; re-creates when data arrives.
  // In the composable pattern we hold the controller directly (no imperative ref)
  // and pass it to StudioProvider so all descendant components can access it.
  const controller = React.useMemo<StudioController>(
    () => createStudioController(buildInitialState(osData ?? undefined)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [osData],
  );

  const [snackbar, setSnackbar] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });

  const [featureFlags, setFeatureFlags] = React.useState<StudioFeatureFlags>({
    quickFilter: false,
  });
  const [locale, setLocale] = React.useState<SupportedLocale>('en');
  const localeBundle = LOCALE_BUNDLES[locale];

  // Keep dayjs locale in sync with the selected language
  React.useEffect(() => {
    dayjs.locale(localeBundle.dayjsLocale);
  }, [localeBundle.dayjsLocale]);

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
      <LocalizationProvider
        dateAdapter={AdapterDayjs}
        adapterLocale={localeBundle.dayjsLocale}
        localeText={localeBundle.pickersLocaleText}
      >
        <CssBaseline />
        <AppLocaleProvider localeText={localeBundle.appLocaleText}>
          {isLoading ? (
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                height: '100vh',
              }}
            >
              <CircularProgress />
            </Box>
          ) : (
            /* StudioProvider makes the controller available to all descendants */
            <StudioProvider
              controller={controller}
              featureFlags={featureFlags}
              geographies={CUSTOM_GEOGRAPHIES}
              localeText={localeBundle.studioLocaleText}
            >
              <DashboardLayout
                dataMode={dataMode}
                rowCount={rowCount}
                serverConfigured={serverConfigured}
                aiConfig={aiConfig}
                dataset={dataset}
                onSnackbar={handleSnackbar}
                featureFlags={featureFlags}
                onFeatureFlagsChange={setFeatureFlags}
                locale={locale}
                onLocaleChange={setLocale}
              />
            </StudioProvider>
          )}
          <Snackbar
            open={snackbar.open}
            autoHideDuration={4000}
            onClose={handleCloseSnackbar}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          >
            <Alert
              onClose={handleCloseSnackbar}
              severity={snackbar.severity}
              sx={{ width: '100%' }}
            >
              {snackbar.message}
            </Alert>
          </Snackbar>
        </AppLocaleProvider>
      </LocalizationProvider>
    </ThemeProvider>
  );
}
