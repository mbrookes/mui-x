import * as React from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CloseIcon from '@mui/icons-material/Close';
import TuneIcon from '@mui/icons-material/Tune';
import {
  DrawerSubheaderContext,
  StudioComposeDrawer,
  selectShell,
  selectWidgets,
  useStudioController,
  useStudioSelector,
} from '@mui/x-studio';
import { useAppLocaleText } from '../locales/AppLocaleContext';

export interface ComposeDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * ComposeDialog wraps StudioComposeDrawer in a Dialog.
 * It is prop-controlled (open/onClose) — callers decide when to open it.
 * Clicking a widget or DnD repositioning does NOT open this dialog;
 * use the AddWidgetFab (after adding) or the toolbar compose button instead.
 *
 * DrawerSubheaderContext is provided so WidgetConfigView's useDrawerSubheader
 * call injects the Setup/Format tabs between the title and content.
 */
export function ComposeDialog({ open, onClose }: ComposeDialogProps) {
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const widgets = useStudioSelector(selectWidgets);
  const t = useAppLocaleText();

  const { selectedWidgetId, selectedFieldId, selectedSourceId } = shell;

  const selectedWidget = selectedWidgetId ? (widgets[selectedWidgetId] ?? null) : null;
  const title = selectedWidget?.title ?? t.configureWidgetTitle;

  const hasNestedSelection = Boolean(selectedFieldId ?? selectedSourceId);

  const handleClose = React.useCallback(() => {
    controller.clearSelection();
    onClose();
  }, [controller, onClose]);

  const handleBack = React.useCallback(() => {
    if (hasNestedSelection) {
      controller.clearSelection();
    }
  }, [controller, hasNestedSelection]);

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
      <DrawerSubheaderContext.Provider value={subheaderCtx}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
          {hasNestedSelection && (
            <IconButton aria-label={t.backAriaLabel} onClick={handleBack} size="small" edge="start">
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          )}
          {!hasNestedSelection && <TuneIcon fontSize="small" color="action" />}
          {title}
          <IconButton
            autoFocus
            aria-label={t.closeComposeDialogAriaLabel}
            onClick={handleClose}
            size="small"
            sx={{ ml: 'auto' }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>

        {injectedSubheader && (
          <React.Fragment>
            <Divider />
            {injectedSubheader}
          </React.Fragment>
        )}

        <DialogContent dividers sx={{ p: 3, overflow: 'auto', flexGrow: 1 }}>
          <StudioComposeDrawer />
        </DialogContent>

        <DialogActions sx={{ px: 2, py: 1.5 }}>
          <Button onClick={handleClose} variant="contained" disableElevation>
            {t.doneButtonLabel}
          </Button>
        </DialogActions>
      </DrawerSubheaderContext.Provider>
    </Dialog>
  );
}
