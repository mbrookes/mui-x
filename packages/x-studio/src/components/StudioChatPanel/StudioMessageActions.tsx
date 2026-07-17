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
  const { regenerate, isStreaming } = useChat();
  const localeText = useStudioLocaleText();
  const [copied, setCopied] = React.useState(false);
  const [isRegenerating, setIsRegenerating] = React.useState(false);

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
    // Regenerate the assistant reply in place. `regenerate(messageId)` resolves the
    // anchoring user message, REMOVES this stale assistant run, then requests a fresh
    // reply (via `adapter.regenerate`, falling back to re-sending the anchor user
    // message through the send pipeline). Re-sending the user message via
    // `sendMessage` instead would append a duplicate user turn + a second answer,
    // letting the thread accumulate duplicate questions rather than replacing the
    // failed answer.
    //
    // Guard against double-apply: if the prior response already applied some
    // mutations before erroring/being interrupted, a regenerate replays the whole
    // flow and could re-apply them. Wiring up full envelope-id dedup is out of
    // scope here, so this is a proportionate client-side guard — while a regenerate
    // for THIS message is in flight, drop further triggers instead of queuing or
    // replaying them, so a user can't fire the same regenerate twice concurrently.
    if (isRegenerating) {
      return;
    }
    setIsRegenerating(true);
    // Wrapped in a local async IIFE with try/finally (rather than
    // `Promise.resolve(regenerate(messageId)).finally(...)`) so this catches BOTH a
    // synchronous throw from `regenerate` (which would otherwise bypass `.finally()`
    // entirely, leaving `isRegenerating` stuck `true` and the button disabled until
    // remount) and a rejected promise (which would otherwise surface as an unhandled
    // promise rejection). Either way `isRegenerating` is always reset.
    void (async () => {
      try {
        await regenerate(messageId);
      } catch {
        // Fail silently (mirrors `handleCopy` above): any error is expected to
        // surface through `useChat().error` instead. This catch exists only to
        // stop a synchronous throw or a rejected promise from going unhandled —
        // not to add a second, uncoordinated error surface.
      } finally {
        setIsRegenerating(false);
      }
    })();
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
            disabled={isRegenerating}
            aria-label={localeText.chatMessageRetryTooltip}
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      )}
    </React.Fragment>
  );
});
