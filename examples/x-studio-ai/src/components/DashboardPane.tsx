import * as React from 'react';
import { Box, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import {
  StudioCanvas,
  selectActivePage,
  useStudioKeyboardShortcuts,
  useStudioSelector,
} from '@mui/x-studio';

interface DashboardPaneProps {
  onWidgetAiRequest?: (widgetId: string) => void;
}

export function DashboardPane({ onWidgetAiRequest }: DashboardPaneProps) {
  const activePage = useStudioSelector(selectActivePage);
  const widgetCount = activePage?.widgetRows?.flat().length ?? 0;

  // The keyboard scope lives here rather than in `AppLayout` so Delete/Backspace only reaches a
  // widget while focus is inside the canvas — never while the user is moving around the chat panel
  // or the nav. The ref must stay on a node that never unmounts, so the empty state renders INSIDE
  // this root instead of replacing it: the hook resolves `rootRef.current` once per mount, and
  // swapping the root element out would leave it listening on a detached node.
  const rootRef = React.useRef<HTMLDivElement>(null);
  useStudioKeyboardShortcuts(rootRef);

  return (
    <Box
      ref={rootRef}
      sx={{
        flexGrow: 1,
        minWidth: 0,
        overflow: 'auto',
        bgcolor: 'background.default',
        height: '100%',
        ...(widgetCount === 0 && {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          color: 'text.secondary',
          p: 4,
        }),
      }}
    >
      {widgetCount === 0 ? (
        <React.Fragment>
          <AutoAwesomeIcon sx={{ fontSize: 56, opacity: 0.25 }} />
          <Typography variant="h6" color="text.secondary">
            Your dashboard will appear here
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: 'center', maxWidth: 360 }}
          >
            Use the chat panel to ask AI to create widgets, add data, or build a complete dashboard.
          </Typography>
        </React.Fragment>
      ) : (
        <StudioCanvas
          sx={{ minWidth: 480, minHeight: '100%' }}
          slotProps={
            onWidgetAiRequest ? { widgetCard: { onAiRequest: onWidgetAiRequest } } : undefined
          }
        />
      )}
    </Box>
  );
}
