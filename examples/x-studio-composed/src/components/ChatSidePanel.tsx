import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { StudioChatPanel } from '@mui/x-studio';
import type { StudioAIConfig } from '@mui/x-studio';
import { useAppLocaleText } from '../locales/AppLocaleContext';

export interface ChatSidePanelProps {
  aiConfig: StudioAIConfig;
  open: boolean;
  onClose: () => void;
}

const PANEL_WIDTH = 380;

export function ChatSidePanel({ aiConfig, open, onClose }: ChatSidePanelProps) {
  const t = useAppLocaleText();

  return (
    <Box
      sx={{
        width: open ? PANEL_WIDTH : 0,
        overflow: 'hidden',
        flexShrink: 0,
        transition: (theme) =>
          theme.transitions.create('width', {
            easing: theme.transitions.easing.sharp,
            duration: theme.transitions.duration.enteringScreen,
          }),
        borderLeft: open ? 1 : 0,
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ width: PANEL_WIDTH, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            px: 2,
            py: 1,
            borderBottom: 1,
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          <Typography variant="subtitle2" sx={{ flexGrow: 1, fontWeight: 600 }}>
            {t.aiAssistantTitle}
          </Typography>
          <Tooltip title={t.closeTooltip}>
            <IconButton size="small" onClick={onClose} aria-label={t.closeAiAssistantAriaLabel}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={{ flexGrow: 1, minHeight: 0 }}>
          <StudioChatPanel aiConfig={aiConfig} />
        </Box>
      </Box>
    </Box>
  );
}
