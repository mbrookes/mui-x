'use client';

import * as React from 'react';
import { IconButton, Tooltip } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useChat, useMessage } from '@mui/x-chat/headless';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

// ── StudioMessageActions — hover-reveal copy + retry buttons ─────────────────
// Defined at module level (stable ref) so ChatBox doesn't re-mount on every render.
// Rendered inside ChatMessageActions (the styled hover-reveal container) for each message.

export interface StudioMessageActionsProps {
  messageId: string;
}

export const StudioMessageActions = React.memo(function StudioMessageActions({
  messageId,
}: StudioMessageActionsProps) {
  const message = useMessage(messageId);
  const { messages, sendMessage, isStreaming } = useChat();
  const localeText = useStudioLocaleText();
  const [copied, setCopied] = React.useState(false);

  if (!message || isStreaming) {
    return null;
  }

  const isAssistant = message.role === 'assistant';

  const handleCopy = () => {
    const text = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n');
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Clipboard write can reject (permissions / insecure context); fail silently
        // rather than leaving an unhandled rejection.
      },
    );
  };

  const handleRetry = () => {
    // Find the last user message preceding this assistant message and resend it.
    const idx = messages.findIndex((m) => m.id === messageId);
    const lastUser = [...messages.slice(0, idx === -1 ? messages.length : idx)]
      .reverse()
      .find((m) => m.role === 'user');
    if (lastUser) {
      sendMessage({ parts: lastUser.parts });
    }
  };

  return (
    <React.Fragment>
      <Tooltip
        title={copied ? localeText.chatMessageCopiedTooltip : localeText.chatMessageCopyTooltip}
      >
        <IconButton
          size="small"
          onClick={handleCopy}
          aria-label={localeText.chatMessageCopyAriaLabel}
        >
          <ContentCopyIcon />
        </IconButton>
      </Tooltip>
      {isAssistant && (
        <Tooltip title={localeText.chatMessageRetryTooltip}>
          <IconButton
            size="small"
            onClick={handleRetry}
            aria-label={localeText.chatMessageRetryTooltip}
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      )}
    </React.Fragment>
  );
});
