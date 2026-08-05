'use client';
import * as React from 'react';
import { Alert, Button, IconButton, Stack, TextField, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

import { useStudioController, useStudioLocaleText } from '../../context';
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

  // Re-entrancy. `status === 'loading'` was the ONLY guard against a double submit,
  // and both Cancel and the collapse chevron reset it to `'idle'` while the request was
  // still in flight: the user cancelled, reopened, resubmitted, and got TWO widgets (the
  // first request commits its widget via `controller.addWidget` regardless). Two changes
  // close this:
  //
  //  1. A generation counter that survives every UI-state reset. Only the newest submission
  //     may write component state, so a superseded (or post-unmount) response is inert.
  //  2. The controls that used to orphan an in-flight request — Cancel and the collapse
  //     chevron — are disabled while it runs. This request cannot be aborted mid-flight: the
  //     widget is committed inside `createWidgetFromDescription`, so "cancel" could never
  //     mean "no widget appears"; it only ever meant "the widget appears anyway, silently".
  //     Blocking the gesture is honest, where re-enabling it would not be.
  const generationRef = React.useRef(0);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    // Re-armed on mount, not only cleared on unmount — StrictMode's double mount/unmount
    // would otherwise leave the ref permanently `false` and swallow every real response.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Only show when AI is configured and the aiChat feature is enabled
  if (!aiConfig?.endpoint || features.aiChat === false) {
    return null;
  }

  const loading = status === 'loading';

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || loading) {
      return;
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    setStatus('loading');
    setErrorMsg('');

    const result = await createWidgetFromDescription(trimmed, aiConfig, controller, localeText);

    // A superseded submission (or one that resolved after unmount) must not write state or
    // re-open/close the form — otherwise a stale response stomps the newer one's result.
    if (!mountedRef.current || generationRef.current !== generation) {
      return;
    }

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
              disabled={loading}
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
            disabled={loading}
            fullWidth
          />
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              size="small"
              disabled={!prompt.trim() || loading}
              onClick={handleSubmit}
            >
              {loading ? localeText.aiCreateWidgetLoading : localeText.aiCreateWidgetButton}
            </Button>
            <Button
              variant="text"
              size="small"
              disabled={loading}
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
