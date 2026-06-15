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
  Studio,
  createBatchingAdapter,
  deserializeState,
  migrateState,
  serializeState,
} from '@mui/x-studio';
import type {
  StudioHandle,
  StudioMode,
  StudioPage,
  StudioState,
  StudioAIConfig,
  StudioFeatureFlags,
  StudioCustomWidgetDef,
  SerializedStudioState,
  StudioFilterState,
  StudioFilterOperator,
} from '@mui/x-studio';
import NotificationsIcon from '@mui/icons-material/Notifications';
import {
  downloadJson,
  uploadJson,
  INITIAL_STATE,
  OS_INITIAL_STATE,
  loadOfficeSuppliesData,
  generateSalesData,
} from 'x-studio-shared';
import type { OfficeSuppliesData } from 'x-studio-shared';
import dayjs from 'dayjs';
import { AppToolbar } from './components/AppToolbar';
import { SettingsDialog } from './components/SettingsDialog';
import type {
  DataMode,
  SidebarLayout,
  SidebarSide,
  TableSourceMode,
} from './components/SettingsDialog';
import {
  AlertBannerWidget,
  computeBannerValue,
  resolveBannerSeverity,
  SEVERITY_RANK,
} from './components/AlertBannerWidget';
import type { AlertBannerConfig, HideBelow } from './components/AlertBannerWidget';
import { AlertBannerSetupPanel } from './components/AlertBannerSetupPanel';
import { theme } from './theme';
import { createAdapter } from './simulatedServer';
import { type SupportedLocale, LOCALE_BUNDLES } from './locales';
import { AppLocaleProvider } from './locales/AppLocaleContext';

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
  if (!raw) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Read ?adapter=true to enable simulated-server adapter mode (legacy; superseded by ?mode). */
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

/**
 * Read ?server=<url> to route queries through a real server instead of
 * simulatedServer.ts. Example: ?server=http://localhost:3001/api/sales-data
 * Uses createBatchingAdapter() which collapses N widget requests into one POST.
 */
function getUrlServerParam(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return new URL(window.location.href).searchParams.get('server') ?? undefined;
}

/** Read ?bp=N to set the responsive stack breakpoint (e.g. ?bp=800). */
function getUrlBreakpointParam(): number | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const raw = new URL(window.location.href).searchParams.get('bp');
  if (!raw) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function setUrlBreakpoint(bp: number) {
  if (typeof window === 'undefined') {
    return;
  }
  const url = new URL(window.location.href);
  if (bp === 600) {
    url.searchParams.delete('bp');
  } else {
    url.searchParams.set('bp', String(bp));
  }
  window.history.replaceState(window.history.state, '', url);
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

const LOCAL_STORAGE_KEY = 'x-studio-state';

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

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- top-level orchestration state is intentionally broad and not naturally reducible
export default function App() {
  const studioRef = React.useRef<StudioHandle>(null);

  // Compute URL params once — stable across renders.
  const rowCount = React.useMemo(() => getUrlRowsParam(), []);
  const dataset = React.useMemo(() => getUrlDatasetParam(), []);
  const localStorageKeyRef = React.useRef<string | null>(null);
  if (localStorageKeyRef.current === null) {
    localStorageKeyRef.current = getLocalStorageKey(dataset);
  }
  const urlPageId = React.useMemo(
    () =>
      resolvePageIdFromQuery(
        getUrlPageParam(),
        dataset === 'ag-studio' ? OS_INITIAL_STATE.pages : INITIAL_STATE.pages,
      ),
    [dataset],
  );

  // AG Studio Data: async-loaded office supplies dataset
  const [osData, setOsData] = React.useState<OfficeSuppliesData | null>(null);

  React.useEffect(() => {
    if (dataset !== 'ag-studio') {
      return;
    }
    loadOfficeSuppliesData().then((data) => {
      React.startTransition(() => {
        setOsData(data);
      });
    });
  }, [dataset]);

  // Phase 1: render the shell immediately with the static demo data so FCP
  // is not blocked by data generation.
  const baseInitialState = React.useMemo<Partial<StudioState>>(() => {
    const baseDataSources =
      (dataset === 'ag-studio' && osData
        ? {
            [osData.storesSource.id]: osData.storesSource,
            [osData.productsSource.id]: osData.productsSource,
            [osData.customersSource.id]: osData.customersSource,
            [osData.ordersSource.id]: osData.ordersSource,
            [osData.orderItemsSource.id]: osData.orderItemsSource,
            [osData.shipmentsSource.id]: osData.shipmentsSource,
          }
        : INITIAL_STATE.dataSources) ?? {};
    const baseConfig = dataset === 'ag-studio' && osData ? OS_INITIAL_STATE : INITIAL_STATE;

    // Restore from localStorage if available, merging with the live data sources.
    const saved = readLocalState(dataset);
    if (saved) {
      const restored = deserializeState(saved, baseDataSources);

      // Merge in any pages from the current initial state that are absent from the
      // saved state. This ensures new pages added to INITIAL_STATE always appear
      // even when a saved state exists from an earlier session.
      const mergedPages = { ...restored.pages };
      let pagesAdded = false;
      for (const [pageId, page] of Object.entries(baseConfig.pages ?? {})) {
        if (!mergedPages[pageId]) {
          mergedPages[pageId] = page;
          pagesAdded = true;
        }
      }
      const mergedState = pagesAdded ? { ...restored, pages: mergedPages } : restored;

      // Apply ?fv= filter value overrides on top of saved state
      const fvParam = getUrlFilterValuesParam();
      if (fvParam) {
        const filterValues = decodeFilterValues(fvParam);
        if (filterValues && mergedState.filters) {
          return {
            ...mergedState,
            filters: mergedState.filters.map((f) => {
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
      return mergedState;
    }

    let baseState: Partial<StudioState> = { ...baseConfig, dataSources: baseDataSources };

    // Apply ?fv= filter value overrides from URL
    const fvParam = getUrlFilterValuesParam();
    if (fvParam) {
      const filterValues = decodeFilterValues(fvParam);
      if (filterValues && baseState.filters) {
        baseState = {
          ...baseState,
          filters: baseState.filters.map((f) => {
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
      return baseState;
    }
    return {
      ...baseState,
      dashboard: {
        ...baseState.dashboard,
        activePageId: urlPageId,
      },
    } as Partial<StudioState>;
  }, [dataset, osData, urlPageId]);

  // Phase 2: if ?rows=N is in the URL, generate the large dataset after first
  // paint so the main thread is not blocked during initial render.
  const [generatedState, setGeneratedState] = React.useState<Partial<StudioState> | null>(null);

  React.useEffect(() => {
    if (rowCount === undefined) {
      return undefined;
    }
    let cancelled = false;
    // Use setTimeout(0) to defer generation until after the first paint.
    // requestIdleCallback would be ideal but is not supported in Safari.
    const id = setTimeout(() => {
      if (cancelled) {
        return;
      }
      const {
        customersSource,
        productsSource,
        ordersSource,
        orderItemsSource,
        shipmentsSource,
        shipmentItemsSource,
      } = generateSalesData({ seed: 42, orderCount: rowCount });
      if (cancelled) {
        return;
      }
      // eslint-disable-next-line no-console
      console.info(
        `[x-studio] Generated data: ${rowCount} orders, ${ordersSource.rows?.length} order rows`,
      );
      const newState: Partial<StudioState> = {
        ...baseInitialState,
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
      React.startTransition(() => {
        setGeneratedState(newState);
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [rowCount, baseInitialState]);

  // Use the generated state once ready; fall back to static data for FCP.
  // Re-key Studio when switching from static → generated so initialState is re-applied.
  const initialState = generatedState ?? baseInitialState;
  let studioKey = 'static';
  if (generatedState) {
    studioKey = `generated-${rowCount}`;
  } else if (dataset === 'ag-studio') {
    studioKey = `ag-studio-${osData ? 'ready' : 'loading'}`;
  }
  // When a large dataset is being generated (?rows=N) or AG Studio data is loading,
  // suppress the static demo render entirely.
  const isGenerating =
    (rowCount !== undefined && generatedState === null) ||
    (dataset === 'ag-studio' && osData === null);
  const [mode, setMode] = React.useState<StudioMode>('edit');
  const [title, setTitle] = React.useState('');
  const [pages, setPages] = React.useState<Record<string, StudioPage>>({});
  const [activePageId, setActivePageId] = React.useState('');
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers -- filters are buffered here for debounced URL synchronization in this example app
  const [filters, setFilters] = React.useState<StudioFilterState[]>([]);
  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);
  const [snackbar, setSnackbar] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [sidebarLayout, setSidebarLayout] = React.useState<SidebarLayout>('tabbed');
  const [sidebarSide, setSidebarSide] = React.useState<SidebarSide>('left');
  const [tableSourceMode, setTableSourceMode] = React.useState<TableSourceMode>('explicit');
  const [stackBreakpoint, setStackBreakpoint] = React.useState(
    () => getUrlBreakpointParam() ?? 600,
  );

  function handleStackBreakpointChange(bp: number) {
    setStackBreakpoint(bp);
    setUrlBreakpoint(bp);
  }
  const [featureFlags, setFeatureFlags] = React.useState<StudioFeatureFlags>({
    quickFilter: false,
  });
  const [locale, setLocale] = React.useState<SupportedLocale>('en');
  const localeBundle = LOCALE_BUNDLES[locale];
  const t = localeBundle.appLocaleText;

  // Keep dayjs locale in sync with the selected language
  React.useEffect(() => {
    dayjs.locale(localeBundle.dayjsLocale);
  }, [localeBundle.dayjsLocale]);

  // Demo custom widgets — an Alert Banner example showing the custom widget API
  const customWidgets = React.useMemo<StudioCustomWidgetDef[]>(
    () => [
      {
        kind: 'alert-banner',
        label: 'Alert Banner',
        description:
          'Example custom widget: a full-bleed banner whose severity is driven by a data field over a time range.',
        icon: <NotificationsIcon sx={{ fontSize: 28 }} />,
        component: AlertBannerWidget,
        setupPanel: AlertBannerSetupPanel,
        requiresDataSource: true,
        fullBleed: true,
        defaultConfig: {
          message: 'Value over the selected window: {value}.',
          aggregation: 'sum',
          lookbackDays: 7,
          hideBelow: 'never',
        },
        shouldHide: ({ widget, dataSource }) => {
          const custom = (widget.config.customConfig ?? {}) as AlertBannerConfig;
          const hideBelow = (custom.hideBelow ?? 'never') as HideBelow;
          if (hideBelow === 'never') {
            return false;
          }
          const value = computeBannerValue(custom, dataSource);
          const severity = resolveBannerSeverity(value, custom);
          const required = hideBelow === 'error' ? 'error' : 'warning';
          return SEVERITY_RANK[severity] < SEVERITY_RANK[required];
        },
      },
    ],
    [],
  );

  // AI config — requires dev server (STUDIO_SERVER_URL)
  const aiConfig = React.useMemo<StudioAIConfig | undefined>(() => {
    const serverUrl = import.meta.env.STUDIO_SERVER_URL as string | undefined;
    if (!serverUrl) {
      return undefined;
    }
    const token = import.meta.env.STUDIO_SERVER_TOKEN as string | undefined;
    return {
      endpoint: `${serverUrl.replace(/\/$/, '')}/api/ai`,
      headers: token ? ({ Authorization: `Bearer ${token}` } as Record<string, string>) : undefined,
    };
  }, []);

  // Server endpoint (env STUDIO_SERVER_URL → ?server=URL). Used by server mode and to
  // decide whether the "server" data-source mode is available in Settings.
  const serverEndpoint = React.useMemo(() => {
    const envServerUrl = import.meta.env.STUDIO_SERVER_URL as string | undefined;
    if (envServerUrl) {
      return `${envServerUrl.replace(/\/$/, '')}/api/sales-data`;
    }
    return getUrlServerParam();
  }, []);
  const serverConfigured = Boolean(serverEndpoint);

  // Resolve the active data-source mode. An explicit ?mode param (set from Settings)
  // takes precedence over .env so the user can force any mode regardless of
  // STUDIO_SERVER_URL. Falls back to the legacy ?adapter param, then env, then memory.
  // ?rows=N suppresses the server default (server ignores generated rows), but an
  // explicit ?mode=adapter is preserved because adapter mode processes rows locally.
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
  const adapterMode = dataMode === 'adapter';

  // Adapter mode: wire a simulated-server adapter for every data source
  React.useEffect(() => {
    if (dataMode !== 'adapter') {
      return;
    }

    // Read the current data sources from the controller so we get the normalised
    // rows (which may have been generated via ?rows=N) rather than the raw imports.
    const state = studioRef.current?.getState();
    if (!state) {
      return;
    }

    for (const source of Object.values(state.dataSources)) {
      if (source.rows && source.rows.length > 0) {
        studioRef.current?.setDataSourceAdapter(source.id, createAdapter(source.rows));
      }
    }
    // eslint-disable-next-line no-console
    console.info('[x-studio] Adapter mode enabled — all sources routed through simulatedServer');
    // Re-run after Studio remounts (studioKey changes when generated data arrives).
  }, [dataMode, studioKey]);

  // Server mode: route widget queries through a real server endpoint.
  // CRM sources (id prefix "source-crm-") are routed to /api/crm-data on the same server.
  // All other sources are routed to /api/sales-data.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- example app: fetch without a data-fetching library is acceptable here
  React.useEffect(() => {
    if (dataMode !== 'server' || !serverEndpoint) {
      return;
    }

    const state = studioRef.current?.getState();
    if (!state) {
      return;
    }

    const serverToken = import.meta.env.STUDIO_SERVER_TOKEN as string | undefined;
    const fetchFn: typeof fetch = serverToken
      ? (input, init) =>
          fetch(input, {
            ...init,
            headers: { ...init?.headers, Authorization: `Bearer ${serverToken}` },
          })
      : globalThis.fetch;

    // Sales sources → /api/sales-data; CRM sources (prefix "source-crm-") → /api/crm-data
    const salesEndpoint = serverEndpoint;
    const crmEndpoint = serverEndpoint.replace(/\/api\/sales-data$/, '/api/crm-data');

    const salesAdapter = createBatchingAdapter(salesEndpoint, {
      fetchFn,
      dataSources: state.dataSources,
      relationships: state.relationships,
      expressionFields: state.expressionFields,
    });
    const crmAdapter = createBatchingAdapter(crmEndpoint, {
      fetchFn,
      dataSources: state.dataSources,
      relationships: state.relationships,
      expressionFields: state.expressionFields,
    });

    for (const source of Object.values(state.dataSources)) {
      const adapter = source.id.startsWith('source-crm-') ? crmAdapter : salesAdapter;
      studioRef.current?.setDataSourceAdapter(source.id, adapter);
    }
    // eslint-disable-next-line no-console
    console.info(`[x-studio] Server mode enabled — sales → ${salesEndpoint}, CRM → ${crmEndpoint}`);
    // Re-run after Studio remounts (studioKey changes when generated data arrives).
  }, [dataMode, serverEndpoint, studioKey]);

  const localSaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers -- state updated from event-driven controller callback
  const handleStateChange = React.useCallback((state: StudioState) => {
    // Use functional updates so React can skip if the value is unchanged,
    // and so the calls are batched into a single App re-render (React 18+).
    setMode((prev) => (prev === state.mode ? prev : state.mode));
    setTitle((prev) => (prev === state.dashboard.title ? prev : state.dashboard.title));
    setPages((prev) => (prev === state.pages ? prev : state.pages));
    setActivePageId((prev) =>
      prev === state.dashboard.activePageId ? prev : state.dashboard.activePageId,
    );
    setFilters((prev) => (prev === state.filters ? prev : state.filters));
    setCanUndo(studioRef.current?.canUndo() ?? false);
    setCanRedo(studioRef.current?.canRedo() ?? false);

    // Persist config changes locally (debounced 1 s).
    if (localSaveTimer.current) {
      clearTimeout(localSaveTimer.current);
    }
    localSaveTimer.current = setTimeout(() => {
      try {
        const serialized = serializeState(state);
        localStorage.setItem(localStorageKeyRef.current!, JSON.stringify(serialized));
      } catch {
        // Ignore storage quota errors
      }
    }, 1000);
  }, []);

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
  const handlePageClose = React.useCallback((pageId: string) => {
    studioRef.current?.removePage(pageId);
  }, []);
  const handlePageReorder = React.useCallback((pageIds: string[]) => {
    studioRef.current?.reorderPages(pageIds);
  }, []);

  const handlePageDragNavigate = React.useCallback((pageId: string) => {
    studioRef.current?.setActivePage(pageId);
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
    setSnackbar({ open: true, message: t.dashboardSavedMessage, severity: 'success' });
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
            message: t.dashboardLoadedMigratedMessage(result.fromVersion, result.toVersion),
            severity: 'info',
          });
        } else {
          setSnackbar({
            open: true,
            message: t.dashboardLoadedMessage,
            severity: 'success',
          });
        }
      } else {
        setSnackbar({
          open: true,
          message: result.errors.join('; ') || t.dashboardLoadFailedMessage,
          severity: 'error',
        });
      }
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : t.dashboardLoadFailedMessage,
        severity: 'error',
      });
    }
  }, []);

  const handleCloseSnackbar = () => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  };

  const handleReset = React.useCallback(() => {
    localStorage.removeItem(localStorageKeyRef.current!);
    setSnackbar({
      open: true,
      message: t.resetDemoReloadingMessage,
      severity: 'info',
    });
    setTimeout(() => window.location.reload(), 800);
  }, []);

  const handleOpenSettings = React.useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const handleCloseSettings = React.useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const handlePageChange = React.useCallback((_event: React.SyntheticEvent, pageId: string) => {
    React.startTransition(() => {
      studioRef.current?.setActivePage(pageId);
    });
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
      <LocalizationProvider
        dateAdapter={AdapterDayjs}
        adapterLocale={localeBundle.dayjsLocale}
        localeText={localeBundle.pickersLocaleText}
      >
        <CssBaseline />
        <AppLocaleProvider localeText={localeBundle.appLocaleText}>
          <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
            <AppToolbar
              title={title}
              mode={mode}
              onModeChange={handleModeChange}
              onSave={handleSave}
              onLoad={handleLoad}
              onReset={handleReset}
              onOpenSettings={handleOpenSettings}
              pages={pageList}
              activePageId={activePageId}
              onPageChange={handlePageChange}
              onPageClose={handlePageClose}
              onPageReorder={handlePageReorder}
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onPageDragNavigate={handlePageDragNavigate}
            />
            <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
              {adapterMode && (
                <Chip
                  label={t.adapterModeLabel}
                  size="small"
                  color="info"
                  sx={{
                    position: 'absolute',
                    bottom: 12,
                    left: 12,
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
                    bottom: 12,
                    left: 12,
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
                    bottom: 12,
                    left: 12,
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
                    bottom: 12,
                    left: 12,
                    zIndex: 10,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    opacity: 0.5,
                  }}
                />
              )}
              {isGenerating ? (
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                  }}
                >
                  <CircularProgress />
                </Box>
              ) : (
                <Studio
                  key={studioKey}
                  ref={studioRef}
                  initialState={initialState}
                  onStateChange={handleStateChange}
                  sidebarLayout={sidebarLayout}
                  sidebarSide={sidebarSide}
                  tableSourceMode={tableSourceMode}
                  stackBreakpoint={stackBreakpoint}
                  featureFlags={featureFlags}
                  aiConfig={aiConfig}
                  customWidgets={customWidgets}
                  localeText={localeBundle.studioLocaleText}
                />
              )}
            </Box>
          </Box>
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
          <SettingsDialog
            open={settingsOpen}
            onClose={handleCloseSettings}
            values={{
              sidebarLayout,
              sidebarSide,
              tableSourceMode,
              stackBreakpoint,
              rowCount: getUrlRowsParam(),
              dataMode,
              serverConfigured,
              dataset: getUrlDatasetParam(),
            }}
            onSidebarLayoutChange={setSidebarLayout}
            onSidebarSideChange={setSidebarSide}
            onTableSourceModeChange={setTableSourceMode}
            onStackBreakpointChange={handleStackBreakpointChange}
            featureFlags={featureFlags}
            onFeatureFlagsChange={setFeatureFlags}
            locale={locale}
            onLocaleChange={setLocale}
          />
        </AppLocaleProvider>
      </LocalizationProvider>
    </ThemeProvider>
  );
}
