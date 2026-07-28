'use client';

import * as React from 'react';
import { Box, Typography } from '@mui/material';
import { ChatMessage } from '@mui/x-chat';
import { useMessageContext } from '@mui/x-chat/headless';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

// ── StudioMessageRoot — message row wrapper that appends model/token metadata ──
// Defined at module level (stable ref) so ChatBox doesn't re-mount on every render.
// Renders the default ChatMessage, then appends a small caption below completed
// assistant messages that have model/token metadata attached.

interface StudioMessageMetadata {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  iterations?: number;
}

export function StudioMessageRoot({
  ref,
  ownerState: _ownerState,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  ownerState?: unknown;
  ref?: React.Ref<HTMLDivElement>;
}) {
  // messageId is not forwarded as a prop to the root slot — it lives in MessageContextProvider.
  const { messageId, message } = useMessageContext();
  const localeText = useStudioLocaleText();
  const metadata = message?.metadata as StudioMessageMetadata | undefined;
  const isAssistant = message?.role === 'assistant';
  const hasMetadata = Boolean(metadata?.model || metadata?.inputTokens != null);
  const showMeta =
    process.env.NODE_ENV !== 'production' &&
    isAssistant &&
    message?.status !== 'streaming' &&
    hasMetadata;

  const totalTokens = (metadata?.inputTokens ?? 0) + (metadata?.outputTokens ?? 0);

  return (
    <React.Fragment>
      <ChatMessage ref={ref} messageId={messageId} {...rest} />
      {showMeta && (
        <Box
          component="div"
          sx={{
            px: 2,
            pb: 0.5,
            display: 'flex',
            gap: 1,
            alignItems: 'center',
            fontSize: '0.7rem',
            color: 'text.disabled',
            // Align under the assistant bubble (account for phantom avatar column)
            pl: (theme) =>
              `calc(${theme.spacing(2)} + var(--MuiChatMessage-avatarSize, 0px) + ${theme.spacing(0.5)})`,
          }}
        >
          {metadata?.model && (
            <Typography variant="inherit" component="span">
              {metadata.model}
            </Typography>
          )}
          {totalTokens > 0 && (
            <Typography variant="inherit" component="span">
              {localeText.chatMessageTokenCount(totalTokens)}
            </Typography>
          )}
          {metadata?.iterations != null && metadata.iterations > 1 && (
            <Typography variant="inherit" component="span">
              {localeText.chatMessageTurnCount(metadata.iterations)}
            </Typography>
          )}
        </Box>
      )}
    </React.Fragment>
  );
}
