import { Box, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { StudioChatPanel } from '@mui/x-studio';
import type { StudioAIConfig } from '@mui/x-studio';
import { useAppLocaleText } from '../locales/AppLocaleContext';

export interface EmptyPagePromptProps {
  aiConfig: StudioAIConfig;
}

export function EmptyPagePrompt({ aiConfig }: EmptyPagePromptProps) {
  const t = useAppLocaleText();

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        p: 4,
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: 800,
          height: 400,
          display: 'flex',
          flexDirection: 'column',
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          overflow: 'hidden',
          bgcolor: 'background.paper',
          boxShadow: 2,
        }}
      >
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
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
              {t.buildPageWithAiTitle}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t.buildPageWithAiDescription}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ flexGrow: 1, minHeight: 0 }}>
          <StudioChatPanel aiConfig={aiConfig} />
        </Box>
      </Box>
    </Box>
  );
}
