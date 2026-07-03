'use client';

import * as React from 'react';
import { IconButton, Tooltip } from '@mui/material';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import { ChatComposerToolbar } from '@mui/x-chat';

// ── Voice mic context — bridges voice state to the toolbar slot ───────────────
// The toolbar slot component must be stable (module-level), so voice state is
// passed via context rather than closing over render-scope variables.

export interface VoiceMicContextValue {
  voiceSupported: boolean;
  isListening: boolean;
  onToggle: () => void;
  startLabel: string;
  stopLabel: string;
}
export const VoiceMicContext = React.createContext<VoiceMicContextValue | null>(null);

// ── StudioComposerToolbar — mic button + native toolbar children ──────────────

export function StudioComposerToolbar({
  children,
  ...props
}: React.ComponentProps<typeof ChatComposerToolbar>) {
  const voice = React.use(VoiceMicContext);
  return (
    <ChatComposerToolbar {...props}>
      {voice?.voiceSupported && (
        <Tooltip title={voice.isListening ? voice.stopLabel : voice.startLabel}>
          <IconButton
            size="small"
            onClick={voice.onToggle}
            aria-label={voice.isListening ? voice.stopLabel : voice.startLabel}
            aria-pressed={voice.isListening}
            color={voice.isListening ? 'error' : 'default'}
          >
            {voice.isListening ? <MicOffIcon fontSize="small" /> : <MicIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}
      {children}
    </ChatComposerToolbar>
  );
}
