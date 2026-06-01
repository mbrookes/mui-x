import { Box, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { StudioCanvas, selectActivePage, useStudioSelector } from '@mui/x-studio';

interface DashboardPaneProps {
  onWidgetAiRequest?: (widgetId: string) => void;
}

export function DashboardPane({ onWidgetAiRequest }: DashboardPaneProps) {
  const activePage = useStudioSelector(selectActivePage);
  const widgetCount = activePage?.widgetRows?.flat().length ?? 0;

  if (widgetCount === 0) {
    return (
      <Box
        sx={{
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          color: 'text.secondary',
          p: 4,
          bgcolor: 'background.default',
        }}
      >
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
      </Box>
    );
  }

  return (
    <Box
      sx={{
        flexGrow: 1,
        minWidth: 0,
        overflow: 'auto',
        bgcolor: 'background.default',
        height: '100%',
      }}
    >
      <StudioCanvas
        sx={{ minWidth: 480, minHeight: '100%' }}
        slotProps={
          onWidgetAiRequest ? { widgetCard: { onAiRequest: onWidgetAiRequest } } : undefined
        }
      />
    </Box>
  );
}
