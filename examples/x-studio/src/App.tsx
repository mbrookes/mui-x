import * as React from 'react';
import { Alert, Box, CssBaseline, Snackbar, ThemeProvider } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { Studio } from '@mui/x-studio';
import type { StudioHandle, StudioMode, StudioPage, StudioState } from '@mui/x-studio';
import { INITIAL_STATE } from './config/salesDashboard';
import { AppToolbar } from './components/AppToolbar';
import { downloadJson, uploadJson } from './utils/fileUtils';
import { theme } from './theme';

export default function App() {
  const studioRef = React.useRef<StudioHandle>(null);
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

  const handleStateChange = React.useCallback((state: StudioState) => {
    setMode(state.mode);
    setTitle(state.dashboard.title);
    setPages(state.pages);
    setActivePageId(state.dashboard.activePageId);
    setCanUndo(studioRef.current?.canUndo() ?? false);
    setCanRedo(studioRef.current?.canRedo() ?? false);
  }, []);

  const handleModeChange = React.useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      studioRef.current?.setMode(checked ? 'edit' : 'view');
    },
    [],
  );

  const handleUndo = React.useCallback(() => { studioRef.current?.undo(); }, []);
  const handleRedo = React.useCallback(() => { studioRef.current?.redo(); }, []);

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

  const handlePageChange = React.useCallback((_event: React.SyntheticEvent, pageId: string) => {
    studioRef.current?.setActivePage(pageId);
  }, []);

  const pageList = Object.values(pages);

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
            pages={pageList}
            activePageId={activePageId}
            onPageChange={handlePageChange}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={handleUndo}
            onRedo={handleRedo}
          />
          <Box sx={{ flexGrow: 1, minHeight: 0 }}>
            <Studio
              ref={studioRef}
              initialState={INITIAL_STATE}
              onStateChange={handleStateChange}
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
      </LocalizationProvider>
    </ThemeProvider>
  );
}

