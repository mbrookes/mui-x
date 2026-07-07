'use client';

import * as React from 'react';
import type { Theme } from '@mui/material';
import { Box } from '@mui/material';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import { ChatComposerSendButton } from '@mui/x-chat';
import { useChat } from '@mui/x-chat/headless';

// ── StudioSendButton — stop/send toggle for the composer ──────────────────────
// Wraps ChatComposerSendButton (x-chat) via slots.sendButton so that x-chat's
// ComposerSendButton headless layer computes `disabled` correctly from hasValue,
// isStreaming, etc. — avoiding the need to replicate that logic here.
// Defined at module level for a stable slot reference (unstable references
// cause the button to remount on every render).

const SEND_BTN_SX = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 36,
  height: 36,
  border: 'none',
  borderRadius: '50%',
  cursor: 'pointer',
  flexShrink: 0,
  p: 0,
  fontSize: '1.25rem',
  transition: (theme: Theme) =>
    theme.transitions.create(['background-color', 'opacity'], {
      duration: theme.transitions.duration.short,
    }),
} as const;

// Inner <button> element rendered by ChatComposerSendButton.
// Receives disabled/type/data-is-streaming computed by ComposerSendButton (headless).
function StudioSendButtonInner({
  children: _children,
  disabled,
  ownerState: _ownerState,
  ref,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ownerState?: unknown;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const { stopStreaming } = useChat();
  const isStreaming = (rest as Record<string, unknown>)['data-is-streaming'] === 'true';
  let btnBgColor: string;
  if (isStreaming) {
    btnBgColor = 'error.main';
  } else if (disabled) {
    btnBgColor = 'action.disabledBackground';
  } else {
    btnBgColor = 'primary.main';
  }
  let btnColor: string;
  if (isStreaming) {
    btnColor = 'error.contrastText';
  } else if (disabled) {
    btnColor = 'action.disabled';
  } else {
    btnColor = 'primary.contrastText';
  }

  return (
    <Box
      component="button"
      ref={ref}
      {...(rest as object)}
      type={isStreaming ? 'button' : 'submit'}
      disabled={isStreaming ? false : disabled}
      onClick={
        isStreaming
          ? (event: React.MouseEvent) => {
              event.preventDefault();
              stopStreaming();
            }
          : (rest.onClick as React.MouseEventHandler | undefined)
      }
      aria-label={isStreaming ? 'Stop generating' : (rest['aria-label'] ?? 'Send message')}
      sx={{
        ...SEND_BTN_SX,
        bgcolor: btnBgColor,
        color: btnColor,
        '&:hover:not(:disabled)': { bgcolor: isStreaming ? 'error.dark' : 'primary.dark' },
        '&:disabled': {
          cursor: 'not-allowed',
          opacity: 'var(--mui-palette-action-disabledOpacity, 0.38)',
        },
      }}
    >
      {isStreaming ? (
        <StopCircleIcon sx={{ width: '1em', height: '1em', fontSize: 'inherit' }} />
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          style={{ width: '1em', height: '1em' }}
        >
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
        </svg>
      )}
    </Box>
  );
}

// Outer slot component — wraps ChatComposerSendButton so slots.sendButton can
// be injected without bypassing the headless disabled/streaming state logic.
export function StudioSendButton({
  ref,
  ...props
}: React.ComponentProps<typeof ChatComposerSendButton> & { ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <ChatComposerSendButton
      ref={ref}
      {...props}
      slots={{ ...props.slots, sendButton: StudioSendButtonInner }}
    />
  );
}
