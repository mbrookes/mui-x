import React from 'react';
import { Box, Dialog, DialogContent, IconButton, Tooltip, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CloseIcon from '@mui/icons-material/Close';
import { StudioChatPanel, useStudioSelector } from '@mui/x-studio';
import type { StudioAIConfig } from '@mui/x-studio';

function selectWidgetTitle(
  state: { widgets: Record<string, { title?: string }> },
  widgetId: string,
): string {
  return state.widgets[widgetId]?.title || 'Widget';
}

function selectWidgetExists(
  state: { widgets: Record<string, unknown> },
  widgetId: string,
): boolean {
  return Boolean(state.widgets[widgetId]);
}

export interface WidgetAiDialogProps {
  open: boolean;
  widgetId: string | null;
  aiConfig: StudioAIConfig;
  onClose: () => void;
}

export function WidgetAiDialog({ open, widgetId, aiConfig, onClose }: WidgetAiDialogProps) {
  const widgetTitle = useStudioSelector((state) =>
    widgetId ? selectWidgetTitle(state, widgetId) : '',
  );
  const widgetExists = useStudioSelector((state) =>
    widgetId ? selectWidgetExists(state, widgetId) : false,
  );

  // Auto-close if the focused widget is deleted while the dialog is open
  React.useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-event-handler -- intentional: close the dialog when the focused widget disappears
    if (open && widgetId && !widgetExists) {
      // react-doctor-disable-next-line react-doctor/no-prop-callback-in-effect -- intentional: notify parent when the focused widget disappears
      onClose();
    }
  }, [open, widgetId, widgetExists, onClose]);

  if (!widgetId) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            height: '80vh',
            maxHeight: 720,
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <AutoAwesomeIcon fontSize="small" color="primary" />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }} noWrap>
            AI assistant
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {widgetTitle}
          </Typography>
        </Box>
        <Tooltip title="Close">
          <IconButton size="small" onClick={onClose} aria-label="Close AI assistant">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Chat */}
      <DialogContent
        sx={{ p: 0, display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}
      >
        <StudioChatPanel key={widgetId} aiConfig={aiConfig} focusedWidgetId={widgetId} />
      </DialogContent>
    </Dialog>
  );
}
