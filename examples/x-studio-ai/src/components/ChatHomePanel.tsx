import * as React from 'react';
import { Box, Chip, IconButton, InputBase, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import SendIcon from '@mui/icons-material/Send';
import { useAppLocaleText } from '../locales/AppLocaleContext';

interface ChatHomePanelProps {
  onSubmit: (message: string) => void;
  isLoading?: boolean;
}

export function ChatHomePanel({ onSubmit, isLoading = false }: ChatHomePanelProps) {
  const [value, setValue] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const t = useAppLocaleText();

  const handleSubmit = React.useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) {
      return;
    }

    onSubmit(trimmed);
    setValue('');
  }, [isLoading, onSubmit, value]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleSuggestionClick = React.useCallback((suggestion: string) => {
    setValue(suggestion);
    textareaRef.current?.focus();
  }, []);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        p: 4,
      }}
    >
      <Box sx={{ textAlign: 'center', mb: 4, maxWidth: 600 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            mb: 1.5,
          }}
        >
          <AutoAwesomeIcon color="primary" sx={{ fontSize: 28 }} />
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {t.chatHomeTitle}
          </Typography>
        </Box>
        <Typography variant="body1" color="text.secondary">
          {t.chatHomeDescription}
        </Typography>
      </Box>

      <Box
        sx={{
          width: '100%',
          maxWidth: 700,
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          overflow: 'hidden',
          bgcolor: 'background.paper',
          boxShadow: 2,
          '&:focus-within': {
            borderColor: 'primary.main',
            boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}33`,
          },
        }}
      >
        <InputBase
          inputRef={textareaRef}
          multiline
          minRows={2}
          maxRows={6}
          fullWidth
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.chatInputPlaceholder}
          sx={{ p: 1.5, fontSize: '0.9375rem' }}
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1, pb: 0.75 }}>
          <IconButton
            size="small"
            color="primary"
            onClick={handleSubmit}
            disabled={!value.trim() || isLoading}
            aria-label={t.newChatTitle}
          >
            <SendIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>

      <Box
        sx={{
          mt: 3,
          maxWidth: 700,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 1,
          justifyContent: 'center',
        }}
      >
        {t.homeSuggestions.map((suggestion) => (
          <Chip
            key={suggestion}
            label={suggestion}
            onClick={() => handleSuggestionClick(suggestion)}
            variant="outlined"
            size="small"
            sx={{
              borderRadius: '99px',
              cursor: 'pointer',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          />
        ))}
      </Box>
    </Box>
  );
}
