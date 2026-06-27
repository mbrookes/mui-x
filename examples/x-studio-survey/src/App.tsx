import * as React from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  CssBaseline,
  Snackbar,
  ThemeProvider,
} from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { Studio } from '@mui/x-studio';
import type {
  StudioAIConfig,
  StudioHandle,
  StudioMode,
  StudioPage,
  StudioState,
  StudioFeatureFlags,
} from '@mui/x-studio';
import { downloadJson, uploadJson } from 'x-studio-shared';
import dayjs from 'dayjs';
import { AppToolbar } from './components/AppToolbar';
import { SettingsDialog } from './components/SettingsDialog';
import type {
  SidebarLayout,
  SidebarSide,
  TableSourceMode,
} from './components/SettingsDialog';
import { theme } from './theme';
import { type SupportedLocale, LOCALE_BUNDLES } from './locales';
import { AppLocaleProvider } from './locales/AppLocaleContext';
import { loadSurveyWorkbooks, type LoadedSurvey } from './surveyData';
import { SURVEY_DASHBOARD } from './config/surveyReport';
import { dividerWidgetDef } from './components/DividerWidget';

const CUSTOM_WIDGETS = [dividerWidgetDef];

export default function App() {
  const studioRef = React.useRef<StudioHandle>(null);

  // Load both spreadsheets through the generic Excel adapter before rendering
  // the dashboard, so every widget has its data sources from the first paint.
  const [survey, setSurvey] = React.useState<LoadedSurvey | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    loadSurveyWorkbooks()
      .then((loaded) => {
        if (!cancelled) {
          React.startTransition(() => setSurvey(loaded));
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[x-studio-survey] Failed to load survey spreadsheets', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const initialState = React.useMemo<Partial<StudioState> | null>(() => {
    if (!survey) {
      return null;
    }
    return { ...SURVEY_DASHBOARD, dataSources: survey.dataSources };
  }, [survey]);

  const [mode, setMode] = React.useState<StudioMode>('view');
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
  const [stackBreakpoint, setStackBreakpoint] = React.useState(600);
  const [featureFlags, setFeatureFlags] = React.useState<StudioFeatureFlags>({
    quickFilter: false,
    crossFilterBar: true,
  });

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
  const [locale, setLocale] = React.useState<SupportedLocale>('en');
  const localeBundle = LOCALE_BUNDLES[locale];
  const t = localeBundle.appLocaleText;

  React.useEffect(() => {
    dayjs.locale(localeBundle.dayjsLocale);
  }, [localeBundle.dayjsLocale]);

  // Wire the custom Excel adapter for every survey data source once Studio mounts.
  React.useEffect(() => {
    if (!survey) {
      return;
    }
    for (const { sourceId, adapter } of survey.adapters) {
      studioRef.current?.setDataSourceAdapter(sourceId, adapter);
    }
    // eslint-disable-next-line no-console
    console.info(
      `[x-studio-survey] Excel adapter wired for ${survey.adapters.length} sheet(s) across 2 workbooks`,
    );
  }, [survey]);

  const handleStateChange = React.useCallback((state: StudioState) => {
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

  // On first render with pages, navigate to the page specified in ?page=
  const initialPageApplied = React.useRef(false);
  React.useEffect(() => {
    if (initialPageApplied.current || !activePageId || Object.keys(pages).length === 0) {
      return;
    }
    initialPageApplied.current = true;
    const slug = new URLSearchParams(window.location.search).get('page');
    if (slug) {
      const pageId = `page-${slug}`;
      if (pages[pageId]) {
        studioRef.current?.setActivePage(pageId);
      }
    }
  }, [activePageId, pages]);

  // Keep ?page= in sync with the active page (use slug without the page- prefix)
  React.useEffect(() => {
    if (!activePageId) {
      return;
    }
    const slug = activePageId.replace(/^page-/, '');
    const params = new URLSearchParams(window.location.search);
    if (params.get('page') !== slug) {
      params.set('page', slug);
      window.history.replaceState(null, '', `?${params}`);
    }
  }, [activePageId]);

  const handleUndo = React.useCallback(() => studioRef.current?.undo(), []);
  const handleRedo = React.useCallback(() => studioRef.current?.redo(), []);
  const handlePageClose = React.useCallback((pageId: string) => {
    studioRef.current?.removePage(pageId);
  }, []);
  const handlePageReorder = React.useCallback((pageIds: string[]) => {
    studioRef.current?.reorderPages(pageIds);
  }, []);
  const handlePageDragNavigate = React.useCallback((pageId: string) => {
    studioRef.current?.setActivePage(pageId);
  }, []);
  const handlePageChange = React.useCallback((_event: React.SyntheticEvent, pageId: string) => {
    React.startTransition(() => {
      studioRef.current?.setActivePage(pageId);
    });
  }, []);

  const handleSave = React.useCallback(() => {
    const serialized = studioRef.current?.serializeState();
    if (!serialized) {
      return;
    }
    downloadJson(serialized, 'mui_developer_survey_2025.json');
    setSnackbar({ open: true, message: t.dashboardSavedMessage, severity: 'success' });
  }, [t]);

  const handleLoad = React.useCallback(async () => {
    try {
      const data = await uploadJson();
      const result = studioRef.current?.loadSerializedState(data);
      if (result?.success) {
        setSnackbar({ open: true, message: t.dashboardLoadedMessage, severity: 'success' });
      } else if (result) {
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

  const handleCloseSnackbar = () => setSnackbar((prev) => ({ ...prev, open: false }));
  const handleOpenSettings = React.useCallback(() => setSettingsOpen(true), []);
  const handleCloseSettings = React.useCallback(() => setSettingsOpen(false), []);

  const pageList = Object.values(pages);

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
              {!initialState ? (
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
                  ref={studioRef}
                  initialState={initialState}
                  onStateChange={handleStateChange}
                  sidebarLayout={sidebarLayout}
                  sidebarSide={sidebarSide}
                  tableSourceMode={tableSourceMode}
                  stackBreakpoint={stackBreakpoint}
                  featureFlags={featureFlags}
                  localeText={localeBundle.studioLocaleText}
                  customWidgets={CUSTOM_WIDGETS}
                  aiConfig={aiConfig}
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
            <Alert onClose={handleCloseSnackbar} severity={snackbar.severity} sx={{ width: '100%' }}>
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
            onStackBreakpointChange={setStackBreakpoint}
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
