import * as React from 'react';
import { Alert, Box, Chip, CssBaseline, Snackbar, ThemeProvider } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { Studio } from '@mui/x-studio';
import type {
  StudioHandle,
  StudioMode,
  StudioPage,
  StudioState,
  StudioAIConfig,
  StudioFeatureFlags,
  StudioCustomWidgetDef,
} from '@mui/x-studio';
import NotificationsIcon from '@mui/icons-material/Notifications';
import { downloadJson, uploadJson } from 'x-studio-shared';
import dayjs from 'dayjs';
import { AppToolbar } from './components/AppToolbar';
import { SettingsDialog } from './components/SettingsDialog';
import type { SidebarLayout, SidebarSide, TableSourceMode } from './components/SettingsDialog';
import {
  AlertBannerWidget,
  computeBannerValue,
  resolveBannerSeverity,
  SEVERITY_RANK,
} from './components/AlertBannerWidget';
import type { AlertBannerConfig, HideBelow } from './components/AlertBannerWidget';
import { AlertBannerSetupPanel } from './components/AlertBannerSetupPanel';
import { theme } from './theme';
import { type SupportedLocale, LOCALE_BUNDLES } from './locales';
import { AppLocaleProvider } from './locales/AppLocaleContext';
import {
  GITHUB_LIBRARY_USAGE_SOURCE,
  GITHUB_LIBRARY_USAGE_SOURCE_ID,
  createGithubLibraryUsageAdapter,
  prefetchGithubLibraryUsage,
} from './connectors/githubLibraryUsageSource';

const PAGE_ID = 'page-library-usage';
const INTRO_WIDGET_ID = 'widget-text-intro';
const CHART_WIDGET_ID = 'widget-chart-library-usage';

/**
 * A single page whose 100%-stacked bar chart plots, for every component
 * library, the relative share of each data grid library among non-fork
 * GitHub repos that declare both as dependencies — see
 * `connectors/githubLibraryUsageSource.ts` for how the values are computed.
 */
const INITIAL_STATE: Partial<StudioState> = {
  doc: {
    schemaVersion: 1,
    dashboard: {
      id: 'dashboard-github-library-usage',
      title: 'Component Library × Data Grid Adoption',
      activePageId: PAGE_ID,
    },
    pages: {
      [PAGE_ID]: {
        id: PAGE_ID,
        title: 'Library Adoption',
        widgetRows: [[INTRO_WIDGET_ID], [CHART_WIDGET_ID]],
      },
    },
    widgets: {
      [INTRO_WIDGET_ID]: {
        id: INTRO_WIDGET_ID,
        kind: 'text',
        title: 'Component Library × Data Grid Adoption',
        titleMode: 'manual',
        sourceId: undefined,
        config: {
          textTitleFontSize: 32,
          textTitleAlign: 'center',
          textSubtitle: 'Non-fork GitHub repos whose package.json combines each pair of libraries',
        },
      },
      [CHART_WIDGET_ID]: {
        id: CHART_WIDGET_ID,
        kind: 'chart',
        title: 'Repositories using both libraries',
        titleMode: 'manual',
        sourceId: GITHUB_LIBRARY_USAGE_SOURCE_ID,
        config: {
          chartType: 'bar-100',
          xField: 'componentLibrary',
          seriesField: 'dataGridLibrary',
          yField: 'repoCount',
        },
      },
    },
    filters: [],
    relationships: [],
    expressionFields: [],
  },
  runtime: {
    dataSources: {
      [GITHUB_LIBRARY_USAGE_SOURCE_ID]: GITHUB_LIBRARY_USAGE_SOURCE,
    },
  },
  session: {
    mode: 'edit',
    shell: {
      openDrawers: { data: false, compose: true, filters: true },
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
    },
  },
};

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

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- top-level orchestration state is intentionally broad and not naturally reducible
export default function App() {
  const studioRef = React.useRef<StudioHandle>(null);

  const urlPageId = React.useMemo(
    () => resolvePageIdFromQuery(getUrlPageParam(), INITIAL_STATE.doc?.pages),
    [],
  );

  const initialState = React.useMemo<Partial<StudioState>>(() => {
    if (!urlPageId) {
      return INITIAL_STATE;
    }
    return {
      ...INITIAL_STATE,
      doc: {
        ...INITIAL_STATE.doc,
        dashboard: {
          ...INITIAL_STATE.doc?.dashboard,
          activePageId: urlPageId,
        },
      },
    } as Partial<StudioState>;
  }, [urlPageId]);

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
      showToolCalls: import.meta.env.DEV,
    };
  }, []);

  // Wire the GitHub library-usage connector unconditionally — it always talks
  // to this app's own /api/github-library-usage endpoint regardless of any
  // data-source mode. Pre-fetch rows so the data drawer shows the correct
  // count and preview, and so the chart has a synchronous fallback on cold
  // cache (no empty flash).
  React.useEffect(() => {
    studioRef.current?.setDataSourceAdapter(
      GITHUB_LIBRARY_USAGE_SOURCE_ID,
      createGithubLibraryUsageAdapter(),
    );
    prefetchGithubLibraryUsage().then((rows) => {
      if (rows.length > 0) {
        studioRef.current?.setDataSourceRows(GITHUB_LIBRARY_USAGE_SOURCE_ID, rows);
      }
    });
  }, []);

  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers -- state updated from event-driven controller callback
  const handleStateChange = React.useCallback((state: StudioState) => {
    // Use functional updates so React can skip if the value is unchanged,
    // and so the calls are batched into a single App re-render (React 18+).
    setMode((prev) => (prev === state.session.mode ? prev : state.session.mode));
    setTitle((prev) => (prev === state.doc.dashboard.title ? prev : state.doc.dashboard.title));
    setPages((prev) => (prev === state.doc.pages ? prev : state.doc.pages));
    setActivePageId((prev) =>
      prev === state.doc.dashboard.activePageId ? prev : state.doc.dashboard.activePageId,
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
  const handlePageClose = React.useCallback((pageId: string) => {
    studioRef.current?.removePage(pageId);
  }, []);
  const handlePageReorder = React.useCallback((pageIds: string[]) => {
    studioRef.current?.reorderPages(pageIds);
  }, []);

  const handlePageDragNavigate = React.useCallback((pageId: string) => {
    studioRef.current?.setActivePage(pageId);
  }, []);

  // Load saved state from the dev server on mount, if STUDIO_SERVER_URL is configured.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- example app: fetch without a data-fetching library is acceptable here
  React.useEffect(() => {
    const serverUrl = import.meta.env.STUDIO_SERVER_URL as string | undefined;
    if (!serverUrl) {
      return;
    }
    const token = import.meta.env.STUDIO_SERVER_TOKEN as string | undefined;
    fetch(`${serverUrl.replace(/\/$/, '')}/api/dashboard-state`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((state) => {
        if (state) {
          studioRef.current?.loadSerializedState(state);
        }
      })
      .catch(() => {
        // Server offline — keep local state
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = React.useCallback(() => {
    const serialized = studioRef.current?.serializeState();
    if (!serialized) {
      return;
    }
    const dashboardTitle = (
      studioRef.current?.getState().doc.dashboard.title ?? 'dashboard'
    ).replace(/[^a-z0-9]/gi, '_');
    downloadJson(serialized, `${dashboardTitle}_dashboard.json`);

    const serverUrl = import.meta.env.STUDIO_SERVER_URL as string | undefined;
    if (serverUrl) {
      const token = import.meta.env.STUDIO_SERVER_TOKEN as string | undefined;
      fetch(`${serverUrl.replace(/\/$/, '')}/api/dashboard-state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(serialized),
      }).catch(() => {});
    }

    setSnackbar({ open: true, message: t.dashboardSavedMessage, severity: 'success' });
  }, [t]);

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
  }, [t]);

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
              <Chip
                label="Live GitHub data"
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
              <Studio
                key="github-library-usage"
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
