import * as React from 'react';
import { Alert, CssBaseline, Snackbar, Tab, Tabs, ThemeProvider, createTheme } from '@mui/material';
import { StudioShell, createStudioController } from '../../../packages/x-studio/src';
import type { StudioMode } from '../../../packages/x-studio/src';
import { INITIAL_STATE } from './config/initialDashboard';
import { AppToolbar } from './components/AppToolbar';
import { downloadJson, uploadJson } from './utils/fileUtils';

const controller = createStudioController(INITIAL_STATE);

const theme = createTheme({
  cssVariables: true,
  colorSchemes: { light: true, dark: true },
});

export default function App() {
  const [mode, setMode] = React.useState<StudioMode>(controller.getState().mode);
  const [pages, setPages] = React.useState(controller.getState().pages);
  const [activePageId, setActivePageId] = React.useState(
    controller.getState().dashboard.activePageId,
  );
  const [snackbar, setSnackbar] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });

  React.useEffect(() => {
    return controller.subscribe((state) => {
      setMode(state.mode);
      setPages(state.pages);
      setActivePageId(state.dashboard.activePageId);
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

  const handleSave = React.useCallback(() => {
    const serialized = controller.serializeState();
    const title = controller.getState().dashboard.title.replace(/[^a-z0-9]/gi, '_');
    downloadJson(serialized, `${title}_dashboard.json`);
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
          setSnackbar({ open: true, message: 'Dashboard loaded successfully', severity: 'success' });
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
  }, []);

  const pageList = Object.values(pages);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppToolbar
        mode={mode}
        onModeChange={handleModeChange}
        onSave={handleSave}
        onLoad={handleLoad}
      />
      {pageList.length > 1 && (
        <Tabs
          value={activePageId}
          onChange={handlePageChange}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper', px: 1 }}
        >
          {pageList.map((page) => (
            <Tab key={page.id} label={page.title} value={page.id} />
          ))}
        </Tabs>
      )}
      <StudioShell controller={controller} />
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

