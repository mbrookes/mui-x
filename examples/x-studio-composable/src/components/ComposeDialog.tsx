import * as React from 'react';
import { Dialog, DialogContent, DialogTitle, IconButton } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CloseIcon from '@mui/icons-material/Close';
import TuneIcon from '@mui/icons-material/Tune';
import { StudioComposeDrawer, selectShell, selectWidgets, useStudioController, useStudioSelector } from '@mui/x-studio';

/**
 * ComposeDialog opens reactively when a widget is selected (selectedWidgetId !== null).
 * Closing calls controller.clearSelection() — no local open state needed.
 */
export function ComposeDialog() {
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const widgets = useStudioSelector(selectWidgets);

  const { selectedWidgetId, selectedFieldId, selectedSourceId } = shell;
  const open = Boolean(selectedWidgetId ?? selectedFieldId ?? selectedSourceId);

  const selectedWidget = selectedWidgetId ? (widgets[selectedWidgetId] ?? null) : null;
  const title = selectedWidget?.title ?? 'Configure widget';

  const hasNestedSelection = Boolean(selectedFieldId ?? selectedSourceId);

  const handleClose = React.useCallback(() => {
    controller.clearSelection();
  }, [controller]);

  const handleBack = React.useCallback(() => {
    // Navigate back to widget level from a nested field/source selection
    if (hasNestedSelection) {
      controller.clearSelection();
    }
  }, [controller, hasNestedSelection]);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { height: '80vh' } } }}
    >
      <DialogTitle
        sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}
      >
        {hasNestedSelection && (
          <IconButton
            aria-label="Back"
            onClick={handleBack}
            size="small"
            edge="start"
          >
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
      <DialogContent dividers sx={{ p: 0, overflow: 'hidden' }}>
        <StudioComposeDrawer />
      </DialogContent>
    </Dialog>
  );
}
