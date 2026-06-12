'use client';
import * as React from 'react';
import {
  Alert,
  Button,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

import {
  useStudioController,
  useStudioLocaleText,
} from '../../context';
import { useStudioUIConfig, useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { createWidgetFromDescription } from '../StudioChatPanel/createWidgetFromDescription';

// ── Natural language widget creator (BL-58) ──────────────────────────────────

export function DescribeWidgetSection({ onCreated }: { onCreated: () => void }) {
  const { aiConfig } = useStudioUIConfig();
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();
  const controller = useStudioController();

  const [open, setOpen] = React.useState(false);
  const [prompt, setPrompt] = React.useState('');
  const [status, setStatus] = React.useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = React.useState('');

  // Only show when AI is configured and the aiChat feature is enabled
  if (!aiConfig?.endpoint || features.aiChat === false) {
    return null;
  }

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || status === 'loading') {
      return;
    }
    setStatus('loading');
    setErrorMsg('');

    const result = await createWidgetFromDescription(trimmed, aiConfig, controller);

    if (result.success) {
      setPrompt('');
      setOpen(false);
      setStatus('idle');
      onCreated();
    } else {
      setStatus('error');
      setErrorMsg(result.error ?? localeText.aiCreateWidgetError);
    }
  };

  return (
    <div>
      {!open && (
        <Button
          size="small"
          startIcon={<AutoAwesomeIcon />}
          onClick={() => setOpen(true)}
          sx={{
            width: '100%',
            justifyContent: 'flex-start',
            textTransform: 'none',
            color: 'text.secondary',
          }}
          variant="text"
        >
          {localeText.aiCreateWidgetLabel}
        </Button>
      )}
      {open && (
        <Stack spacing={1}>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <AutoAwesomeIcon sx={{ fontSize: 16, color: 'primary.main' }} />
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
              {localeText.aiCreateWidgetLabel}
            </Typography>
            <IconButton
              size="small"
              onClick={() => {
                setOpen(false);
                setStatus('idle');
              }}
              aria-label={localeText.composeCloseAriaLabel}
            >
              <ExpandLessIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Stack>
          <TextField
            multiline
            maxRows={3}
            size="small"
            placeholder={localeText.aiCreateWidgetPlaceholder}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSubmit();
              }
            }}
            disabled={status === 'loading'}
            fullWidth
          />
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              size="small"
              disabled={!prompt.trim() || status === 'loading'}
              onClick={handleSubmit}
            >
              {status === 'loading'
                ? localeText.aiCreateWidgetLoading
                : localeText.aiCreateWidgetButton}
            </Button>
            <Button
              variant="text"
              size="small"
              onClick={() => {
                setOpen(false);
                setStatus('idle');
                setPrompt('');
              }}
            >
              {localeText.composeCancel}
            </Button>
          </Stack>
          {status === 'error' && (
            <Alert severity="error" sx={{ fontSize: 12 }}>
              {errorMsg}
            </Alert>
          )}
        </Stack>
      )}
    </div>
  );
}
