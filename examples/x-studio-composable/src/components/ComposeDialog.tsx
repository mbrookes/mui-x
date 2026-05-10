import * as React from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CloseIcon from '@mui/icons-material/Close';
import TuneIcon from '@mui/icons-material/Tune';
import {
  DrawerSubheaderContext,
  StudioComposeDrawer,
  selectMode,
  selectShell,
  selectWidgets,
  useStudioController,
  useStudioSelector,
} from '@mui/x-studio';

/**
 * ComposeDialog opens reactively in edit mode when a widget is selected.
 * Closing calls controller.clearSelection() — no local open state needed.
 *
 * DrawerSubheaderContext is provided here so that WidgetConfigView's
 * useDrawerSubheader call (which injects the Setup/Format tabs) is captured
 * and rendered between the title and the scrollable content area.
 */
export function ComposeDialog() {
  const controller = useStudioController();
  const mode = useStudioSelector(selectMode);
  const shell = useStudioSelector(selectShell);
  const widgets = useStudioSelector(selectWidgets);

  const { selectedWidgetId, selectedFieldId, selectedSourceId } = shell;
  // Only open in edit mode — view mode clicks drive cross-filter, not config.
  const open = mode === 'edit' && Boolean(selectedWidgetId ?? selectedFieldId ?? selectedSourceId);

  const selectedWidget = selectedWidgetId ? (widgets[selectedWidgetId] ?? null) : null;
  const title = selectedWidget?.title ?? 'Configure widget';

  const hasNestedSelection = Boolean(selectedFieldId ?? selectedSourceId);

  const handleClose = React.useCallback(() => {
    controller.clearSelection();
  }, [controller]);

  const handleBack = React.useCallback(() => {
    if (hasNestedSelection) {
      controller.clearSelection();
    }
  }, [controller, hasNestedSelection]);

  // Capture the subheader (Setup/Format tabs) injected by WidgetConfigView via
  // useDrawerSubheader. The provider must wrap both the injection site
  // (StudioComposeDrawer) and the render site (between title and content).
  const [injectedSubheader, setInjectedSubheader] = React.useState<React.ReactNode>(null);
  const subheaderCtx = React.useMemo(() => ({ setSubheader: setInjectedSubheader }), []);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { height: '80vh', display: 'flex', flexDirection: 'column' } } }}
    >
      {/* Provider wraps all dialog children so useDrawerSubheader can inject tabs */}
      <DrawerSubheaderContext.Provider value={subheaderCtx}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
          {hasNestedSelection && (
            <IconButton aria-label="Back" onClick={handleBack} size="small" edge="start">
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          )}
          {!hasNestedSelection && <TuneIcon fontSize="small" color="action" />}
          {title}
          <IconButton
            aria-label="Close compose dialog"
            onClick={handleClose}
            size="small"
            sx={{ ml: 'auto' }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>

        {/* Setup/Format tabs injected by WidgetConfigView */}
        {injectedSubheader && (
          <React.Fragment>
            <Divider />
            {injectedSubheader}
          </React.Fragment>
        )}

        <DialogContent dividers sx={{ p: 1.5, overflow: 'auto', flexGrow: 1 }}>
          <StudioComposeDrawer />
        </DialogContent>

        <DialogActions sx={{ px: 2, py: 1.5 }}>
          <Button onClick={handleClose} variant="contained" disableElevation>
            Done
          </Button>
        </DialogActions>
      </DrawerSubheaderContext.Provider>
    </Dialog>
  );
}
