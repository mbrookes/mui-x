'use client';

import * as React from 'react';
import { IconButton, Tooltip } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useChat, useMessage } from '@mui/x-chat/headless';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { useStudioChatTurnMutations } from './chatTurnMutations';

// ── StudioMessageActions — hover-reveal copy + retry buttons ─────────────────
// Defined at module level (stable ref) so ChatBox doesn't re-mount on every render.
// Rendered inside ChatMessageActions (the styled hover-reveal container) for each message.

/** How long the "Copied!" tooltip label stays up after a successful copy. */
const COPIED_FEEDBACK_MS = 2000;

export interface StudioMessageActionsProps {
  messageId: string;
}

export const StudioMessageActions = React.memo(function StudioMessageActions({
  messageId,
}: StudioMessageActionsProps) {
  const message = useMessage(messageId);
  const { regenerate, isStreaming } = useChat();
  const localeText = useStudioLocaleText();
  const turnMutations = useStudioChatTurnMutations();
  const [copied, setCopied] = React.useState(false);
  const [isRegenerating, setIsRegenerating] = React.useState(false);
  // Mirror of `isRegenerating` that updates SYNCHRONOUSLY at click time. React state
  // only reaches the next render, so two clicks dispatched before React re-renders
  // (a double-click, or a keyboard repeat) both read `isRegenerating === false` and
  // both call `regenerate`. The ref closes that window; the state still drives the
  // rendered `aria-disabled`.
  const isRegeneratingRef = React.useRef(false);
  const copiedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(
    () => () => {
      // The copy feedback timer outlives the component otherwise — messages unmount
      // constantly (thread switches, virtualization), so a `setCopied` on an unmounted
      // component was a routine occurrence rather than an edge case.
      clearTimeout(copiedTimeoutRef.current);
    },
    [],
  );

  if (!message) {
    return null;
  }

  const isAssistant = message.role === 'assistant';
  // Retry is unavailable while a response streams (`useChat().regenerate` refuses
  // anyway), but the buttons stay MOUNTED and focusable. Unmounting them mid-stream
  // destroyed the element the user was focused on — keyboard focus fell back to
  // `<body>`, silently losing the user's place in the conversation every time a
  // response started. `aria-disabled` (rather than `disabled`) is the same trade:
  // it announces the state without removing the node from the tab order.
  const retryBusy = isStreaming || isRegenerating;

  const handleCopy = () => {
    const text = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n');
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
      },
      () => {
        // Clipboard write can reject (permissions / insecure context); fail silently
        // rather than leaving an unhandled rejection.
      },
    );
  };

  const handleRetry = () => {
    // `aria-disabled` doesn't block activation the way `disabled` does, so the busy
    // state has to be enforced here.
    if (isStreaming || isRegeneratingRef.current) {
      return;
    }
    isRegeneratingRef.current = true;
    setIsRegenerating(true);

    // Regenerate the assistant reply in place. `regenerate(messageId)` resolves the
    // anchoring user message, REMOVES this stale assistant run, then requests a fresh
    // reply (via `adapter.regenerate`, falling back to re-sending the anchor user
    // message through the send pipeline). Re-sending the user message via
    // `sendMessage` instead would append a duplicate user turn + a second answer,
    // letting the thread accumulate duplicate questions rather than replacing the
    // failed answer.
    //
    // Double-apply: the failed run may already have committed some of its
    // `state-mutation` events ("add a revenue chart and a KPI" → chart lands → the
    // connection drops), and the replay re-runs the whole turn with fresh ids, so the
    // chart is added twice. Revert this turn's applied mutations first — the ledger
    // no-ops unless the document is still exactly where that turn left it, so it can
    // never discard an edit made since. See `chatTurnMutations.ts`.
    turnMutations?.revert(messageId);

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
        isRegeneratingRef.current = false;
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
            aria-disabled={retryBusy}
            aria-label={localeText.chatMessageRetryTooltip}
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      )}
    </React.Fragment>
  );
});
