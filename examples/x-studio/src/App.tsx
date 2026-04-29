import * as React from 'react';
import { Alert, Box, CssBaseline, Snackbar, ThemeProvider } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { Studio, createStudioController } from '@mui/x-studio';
import type { StudioMode, StudioPage } from '@mui/x-studio';
import { INITIAL_STATE } from './config/salesDashboard';
import { AppToolbar } from './components/AppToolbar';
import { downloadJson, uploadJson } from './utils/fileUtils';
import { theme } from './theme';

const controller = createStudioController(INITIAL_STATE);

export default function App() {
  const [mode, setMode] = React.useState<StudioMode>(controller.getState().mode);
  const [title, setTitle] = React.useState(controller.getState().dashboard.title);
  const [pages, setPages] = React.useState<Record<string, StudioPage>>(controller.getState().pages);
  const [activePageId, setActivePageId] = React.useState(
    controller.getState().dashboard.activePageId,
  );
  const [canUndo, setCanUndo] = React.useState(controller.canUndo());
  const [canRedo, setCanRedo] = React.useState(controller.canRedo());
  const [snackbar, setSnackbar] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });

  React.useEffect(() => {
    return controller.subscribe((state) => {
      setMode(state.mode);
      setTitle(state.dashboard.title);
      setPages(state.pages);
      setActivePageId(state.dashboard.activePageId);
      setCanUndo(controller.canUndo());
      setCanRedo(controller.canRedo());
    });
  }, []);

  const handleModeChange = React.useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      const newMode = checked ? 'edit' : 'view';
      if (newMode === 'view') {
        controller.clearSelection();
      }
      controller.setMode(newMode);
    },
    [],
  );

  const handleUndo = React.useCallback(() => { controller.undo(); }, []);
  const handleRedo = React.useCallback(() => { controller.redo(); }, []);

  const handleSave = React.useCallback(() => {
    const serialized = controller.serializeState();
    const dashboardTitle = controller.getState().dashboard.title.replace(/[^a-z0-9]/gi, '_');
    downloadJson(serialized, `${dashboardTitle}_dashboard.json`);
    setSnackbar({ open: true, message: 'Dashboard saved successfully', severity: 'success' });
  }, []);

  const handleLoad = React.useCallback(async () => {
    try {
      const data = await uploadJson();
      const result = controller.loadSerializedState(data);
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
    controller.setActivePage(pageId);
    setActivePageId(pageId);
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
            <Studio controller={controller} />
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
