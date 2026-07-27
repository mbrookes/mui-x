'use client';

import * as React from 'react';
import type { SxProps, Theme } from '@mui/material';
import { Box, Grow, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { ChatBox } from '@mui/x-chat';
import type { ChatAdapter, ChatPartRendererMap } from '@mui/x-chat/headless';

import {
  useStudioController,
  useStudioSelector,
  selectDataSources,
  selectWidgets,
  selectPages,
  selectDashboard,
} from '../../context';
import { useStudioUIConfig, useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { StudioAIConfig, StudioStreamReader } from './studioBackendAdapter';
import { createBackendChatAdapter } from './studioBackendAdapter';
import { StudioChatTurnMutationContext, createChatTurnMutationLedger } from './chatTurnMutations';
import type { StudioCustomWidgetDef } from '../../models';
import { toSxArray } from './chatPanelUtils';
import { studioApprovalOnlyRenderer, studioDynamicToolRenderer } from './chatToolRenderers';
import { StudioSendButton } from './StudioSendButton';
import { StudioMessageActions } from './StudioMessageActions';
import { StudioMessageRoot } from './StudioMessageRoot';
import { StudioReasoningPart } from './StudioReasoningPart';
import { generateSuggestions } from './chatSuggestions';
import { useChatVoiceInput } from './useChatVoiceInput';
import { StudioComposerToolbar, VoiceMicContext } from './StudioComposerToolbar';
import { useChatThreads, StreamThreadPin } from './useChatThreads';
import { nextAutoSubmitSeq } from './chatIds';
import { AutoSubmitTrigger, enqueuePendingAutoSubmit, type PendingAutoSubmit } from './autoSubmit';

// ── Component ─────────────────────────────────────────────────────────────────

export interface StudioChatPanelSlotProps {
  /**
   * Extra props spread onto `ChatBox` before Studio's own required props.
   * Consumer-provided `features`, `localeText`, `partRenderers`, and `slots` are
   * deep-merged with Studio's defaults so you can augment rather than replace them.
   * Studio always enforces `features.conversationHeader: false` and
   * `features.attachments: false`; `adapter`, `messages`, and `sx` are always
   * set by Studio and cannot be overridden here.
   */
  chatBox?: Partial<React.ComponentProps<typeof ChatBox>>;
  /**
   * Props for the fixed overlay panel container (overlay mode only).
   * Use to override `width`, `bottom`, `right`, or add custom `sx`.
   * The `sx` prop is merged additively with Studio's defaults.
   */
  panel?: Omit<React.ComponentProps<typeof Box>, 'sx'> & { sx?: object };
}

export interface StudioChatPanelProps {
  /**
   * LLM configuration — endpoint, optional API key, and model.
   * If not provided, the panel is not rendered.
   *
   * Memoizing this object (`React.useMemo`) avoids rebuilding the chat adapter on
   * every render, but it is only an optimization: an inline object literal is
   * supported and nothing about stopping, streaming, or state application depends
   * on it (see the adapter memo's comment for how that is guaranteed).
   */
  aiConfig?: StudioAIConfig | null;
  /**
   * Custom widget definitions to include in the AI context.
   * If omitted, automatically reads from the Studio context (i.e., the `customWidgets` prop
   * passed to `<Studio>`). Only set this explicitly when using `StudioChatPanel` standalone.
   */
  customWidgets?: StudioCustomWidgetDef[];
  /**
   * When set, the AI prompt is focused on this specific widget.
   * The system prompt will include extra context about the widget,
   * guiding the AI to assist with modifications to it.
   */
  focusedWidgetId?: string;
  /**
   * Whether the panel is visible. Use this for overlay / slide-in mode.
   * When omitted, the panel is always rendered (persistent mode).
   */
  open?: boolean;
  /**
   * Called when the user dismisses the overlay panel — via the header close button
   * or the <kbd>Escape</kbd> key. (The panel is a non-modal overlay with no backdrop,
   * so there is no backdrop-click dismissal.)
   */
  onClose?: () => void;
  /**
   * When true, the panel is rendered as a fixed-position overlay on the right side.
   * When false (default), the panel fills its parent container (use for persistent side panels).
   */
  overlay?: boolean;
  /** Slot props for sub-components. */
  slotProps?: StudioChatPanelSlotProps;
  /**
   * Custom styles applied to the panel root element.
   * In persistent mode this targets the chat container; in overlay mode it
   * targets the fixed-position overlay panel (merged with Studio's defaults).
   */
  sx?: SxProps<Theme>;
  /**
   * Visual density of the chat UI.
   * Passed directly to `ChatBox`. Useful for space-constrained dashboard layouts.
   * @default 'standard'
   */
  density?: React.ComponentProps<typeof ChatBox>['density'];
  /**
   * Layout variant.
   * Passed directly to `ChatBox`.
   * @default 'default'
   */
  variant?: React.ComponentProps<typeof ChatBox>['variant'];
  /**
   * When provided, this prompt is pre-filled in the composer and automatically
   * submitted on mount (no user interaction needed).
   *
   * Useful for context-triggered chats — e.g. right-clicking a widget and
   * opening the assistant with a pre-built "Explain this widget" prompt.
   * Only takes effect when the conversation is new (no existing messages).
   */
  initialPrompt?: string;
  /**
   * When set, immediately submits `text` as a new user message.
   * Change the `id` to trigger a new submission (even if `text` is the same).
   * Used by widget insight actions to route AI analysis through the chat panel.
   */
  pendingMessage?: { text: string; id: number };
}

// react-doctor-disable-next-line react-doctor/no-giant-component -- chat panel orchestrates thread/message/suggestion state and cannot be split further
export function StudioChatPanel(props: StudioChatPanelProps) {
  const {
    aiConfig,
    customWidgets: customWidgetsProp,
    density,
    focusedWidgetId,
    initialPrompt,
    open = true,
    onClose,
    overlay = false,
    pendingMessage,
    slotProps,
    sx,
    variant,
  } = props;

  const controller = useStudioController();
  const dataSources = useStudioSelector(selectDataSources);
  const widgets = useStudioSelector(selectWidgets);
  const pages = useStudioSelector(selectPages);
  const dashboard = useStudioSelector(selectDashboard);
  const { customWidgets: contextCustomWidgets } = useStudioUIConfig();
  const localeText = useStudioLocaleText();

  // Stable, instance-unique id so the overlay dialog's `aria-labelledby` can point at
  // its "AI assistant" heading (two mounted `<Studio>`s must not collide on the id).
  const titleId = React.useId();

  // Prefer explicit prop; fall back to Studio context
  const customWidgets = customWidgetsProp ?? contextCustomWidgets;

  const activePage = pages[dashboard.activePageId];
  const activeWidgetIds = React.useMemo(() => (activePage?.widgetRows ?? []).flat(), [activePage]);

  // ── Adapter (recreated when aiConfig or controller changes) ───────────────
  //
  // This memo misses constantly and that is FINE BY DESIGN, because nothing about
  // correctness may depend on a host memoizing a prop. `aiConfig` is passed straight
  // through from the public `<Studio aiConfig={…}>` prop and is routinely an inline
  // object literal (that is how it is documented); `customWidgets` likewise; and
  // `focusedWidgetId` genuinely changes while the panel is open — clicking another
  // widget's "Analysis" mid-stream. Meanwhile the panel re-renders on every streamed
  // token (each one writes thread messages back to the store), so a fresh adapter can
  // replace the running one dozens of times per response.
  //
  // The one piece of state that must NOT be discarded across those rebuilds is the
  // set of in-flight response readers `stop()` cancels — `ChatBox` dispatches `stop()`
  // to whichever adapter it currently holds, so a per-adapter registry hands it an
  // empty set and the Stop button silently cancels nothing. The registry therefore
  // lives in a ref here, outliving every adapter instance.
  // Lazy `useState` initializer rather than `useRef(new Set())`: same stable identity
  // for the panel's lifetime, without allocating a throwaway Set on every one of those
  // per-token renders.
  const [activeReaders] = React.useState(() => new Set<StudioStreamReader>());

  // Same lifetime argument: the record of which `state-mutation`s each assistant turn
  // applied has to survive adapter rebuilds (and be reachable from `StudioMessageActions`,
  // which `ChatBox` renders as a slot), so Retry can revert a failed turn instead of
  // replaying it on top. See `chatTurnMutations.ts`.
  const turnMutations = React.useMemo(() => createChatTurnMutationLedger(controller), [controller]);

  const adapter = React.useMemo<ChatAdapter | null>(() => {
    if (!aiConfig?.endpoint) {
      return null;
    }
    return createBackendChatAdapter(aiConfig, controller, customWidgets, focusedWidgetId, {
      activeReaders,
      mutationLedger: turnMutations,
    });
  }, [aiConfig, controller, customWidgets, focusedWidgetId, activeReaders, turnMutations]);

  // ── AI conversation thread state (create/switch/persist + write-back race fix) ──
  const {
    activeThreadId,
    threadMessages,
    sortedThreads,
    activeThreadName,
    threadMenuAnchor,
    setThreadMenuAnchor,
    handleMessagesChange,
    handleNewThread,
    handleSelectThread,
    streamThreadPinProps,
  } = useChatThreads(controller);

  // ── Pending message auto-submit ──────────────────────────────────────────────
  // A FIFO queue (not a single slot) so a `pendingMessage` and an `initialPrompt`
  // that both become eligible on the same mount don't clobber each other — each
  // producer below pushes its own entry rather than overwriting the other's
  // (finding 2.9); `AutoSubmitTrigger` drains the queue one entry at a time.
  const [pendingAutoSubmit, setPendingAutoSubmit] = React.useState<PendingAutoSubmit[]>([]);
  const pendingMessageIdRef = React.useRef<number | undefined>(undefined);

  // Prunes an entry out of the queue once `AutoSubmitTrigger` has consumed it — see the
  // doc comment on `AutoSubmitTrigger` (finding 5) for why this must live in state
  // rather than a ref local to that component.
  const handleAutoSubmitConsumed = React.useCallback((seq: number) => {
    setPendingAutoSubmit((prev) => prev.filter((item) => item.seq !== seq));
  }, []);

  React.useEffect(() => {
    if (!pendingMessage || pendingMessage.id === pendingMessageIdRef.current) {
      return;
    }
    pendingMessageIdRef.current = pendingMessage.id;
    setPendingAutoSubmit((prev) =>
      enqueuePendingAutoSubmit(prev, { text: pendingMessage.text, seq: pendingMessage.id }),
    );
  }, [pendingMessage]);

  // ── Initial prompt auto-submit ──────────────────────────────────────────────
  // `initialPrompt` is documented to auto-submit on mount for a brand-new (empty)
  // thread — e.g. a right-click "Explain this widget" entry point. ChatBox's own
  // `autoSubmitInitialValue` is declared in its PropTypes but not implemented, so
  // route the prompt through the same `AutoSubmitTrigger` the `pendingMessage` path
  // uses. Fires at most once, and only while the conversation has no messages yet.
  //
  // Eligibility is pinned to the thread that was active the first time this effect
  // runs (mount) via `mountThreadIdRef` — NOT merely "the thread is currently empty".
  // In persistent mode the panel never remounts, so without this pin, switching to
  // ANY later empty thread (e.g. "+ New conversation", or selecting another empty
  // thread minutes/hours after mount) would re-satisfy the old "hasn't fired yet" +
  // "thread is empty" guard and auto-submit the stale, mount-time `initialPrompt`
  // into a conversation the user never asked about (finding 2.1). Once the active
  // thread diverges from the mount-time thread, this effect permanently bails.
  const initialPromptSubmittedRef = React.useRef(false);
  const mountThreadIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (initialPromptSubmittedRef.current) {
      return;
    }
    if (mountThreadIdRef.current === null) {
      mountThreadIdRef.current = activeThreadId;
    }
    if (activeThreadId !== mountThreadIdRef.current) {
      return;
    }
    const text = initialPrompt?.trim();
    if (text && threadMessages.length === 0) {
      initialPromptSubmittedRef.current = true;
      // Drawn from the same module-level monotonic counter as `pendingMessage.id`
      // (see `StudioContent`'s `pendingInsight.id`) so two auto-submit-eligible
      // events landing in the same millisecond never collide on `seq` — a plain
      // `Date.now()` here previously could (finding 13).
      setPendingAutoSubmit((prev) =>
        enqueuePendingAutoSubmit(prev, { text, seq: nextAutoSubmitSeq() }),
      );
    }
  }, [initialPrompt, threadMessages.length, activeThreadId]);

  // ── Abort an in-flight stream when the overlay panel is dismissed ────────────
  // In overlay mode `Grow`'s `unmountOnExit` tears down `<ChatBox>` the moment `open`
  // flips to false; a response still streaming then has its remaining tokens dropped
  // with no error shown — the same silent-truncation class of bug the thread-switch
  // path already fixes by calling `stopStreaming` first (see useChatThreads). Stop the
  // stream on close so the partial response is cleanly terminated and preserved.
  const { isStreamingRef, stopStreamRef } = streamThreadPinProps;
  const wasOpenRef = React.useRef(open);
  React.useEffect(() => {
    if (overlay && wasOpenRef.current && !open && isStreamingRef.current) {
      stopStreamRef.current?.();
    }
    wasOpenRef.current = open;
  }, [open, overlay, isStreamingRef, stopStreamRef]);

  // ── Overlay focus management (dialog semantics) ──────────────────────────────
  // In overlay mode the panel is a dialog: move focus into it when it opens (so a
  // keyboard user lands inside instead of somewhere behind it) and restore focus to
  // whatever element opened it (typically the FAB) when it closes. Persistent mode
  // is an inline panel, not a dialog, so this only runs when `overlay` is set.
  const overlayRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!overlay) {
      return;
    }
    if (open) {
      // Remember the trigger so focus can return to it on close.
      triggerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const node = overlayRef.current;
      if (node) {
        // Prefer the composer input; fall back to the panel root (tabIndex=-1).
        const focusTarget =
          node.querySelector<HTMLElement>('textarea, input, [contenteditable="true"]') ?? node;
        focusTarget.focus();
      }
    } else {
      // Restore focus to the trigger element that opened the panel.
      triggerRef.current?.focus();
      triggerRef.current = null;
    }
  }, [open, overlay]);

  // Escape closes the overlay panel (dialog convention). Wired on the container so a
  // keypress anywhere inside the panel dismisses it, matching the close button.
  const handleOverlayKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape' && onClose) {
        event.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  // ── Dynamic suggestions ────────────────────────────────────────────────────
  const suggestions = React.useMemo(
    () => generateSuggestions(dataSources, widgets, activeWidgetIds, localeText),
    [dataSources, widgets, activeWidgetIds, localeText],
  );

  // ── Voice input ───────────────────────────────────────────────────────────
  const {
    voiceSupported,
    isListening,
    composerValue,
    handleToggleVoice,
    handleComposerValueChange,
    runProgrammaticComposerChange,
  } = useChatVoiceInput();

  const voiceMicContextValue = React.useMemo(
    () => ({
      voiceSupported,
      isListening,
      onToggle: handleToggleVoice,
      startLabel: localeText.chatVoiceInputStart,
      stopLabel: localeText.chatVoiceInputStop,
    }),
    [
      voiceSupported,
      isListening,
      handleToggleVoice,
      localeText.chatVoiceInputStart,
      localeText.chatVoiceInputStop,
    ],
  );

  if (!adapter) {
    return null;
  }

  // ── ChatBox prop composition ────────────────────────────────────────────────
  // Studio provides sensible defaults for all customizable props and then deep-merges
  // consumer-supplied overrides from slotProps.chatBox on top, except for the small
  // set of required settings that Studio must always enforce.

  const studioPartRenderers: ChatPartRendererMap = {
    // Reasoning / "Thinking…" — show a "Thinking…" label while the model is working
    // and collapse the block into an expandable "Reasoning" section when done.
    reasoning: StudioReasoningPart as ChatPartRendererMap['reasoning'],
    // Dynamic-tool parts: show per-tool icons, or hide entirely when showToolCalls is false.
    // Exception: always render approval-requested parts so users can approve/deny operations.
    'dynamic-tool':
      aiConfig?.showToolCalls === false
        ? studioApprovalOnlyRenderer
        : (studioDynamicToolRenderer as ChatPartRendererMap['dynamic-tool']),
  };

  const chatBox = (
    <Box
      sx={[
        { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
        ...(!overlay ? toSxArray(sx) : []),
      ]}
    >
      {/* Thread selector header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
          borderBottom: 1,
          borderColor: 'divider',
          minHeight: 40,
          flexShrink: 0,
        }}
      >
        <Tooltip title={localeText.chatSwitchConversationTooltip}>
          <Box
            component="button"
            type="button"
            aria-label={localeText.chatSwitchConversationTooltip}
            aria-haspopup="menu"
            aria-expanded={Boolean(threadMenuAnchor)}
            onClick={(event: React.MouseEvent<HTMLElement>) =>
              setThreadMenuAnchor(event.currentTarget)
            }
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.25,
              flexGrow: 1,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              p: 0.5,
              borderRadius: 1,
              textAlign: 'left',
              '&:hover': { bgcolor: 'action.hover' },
              '&:focus-visible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: 2,
              },
            }}
          >
            <Typography
              variant="caption"
              sx={{
                flexGrow: 1,
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {activeThreadName}
            </Typography>
            <ArrowDropDownIcon
              aria-hidden
              sx={{ fontSize: 18, color: 'text.secondary', flexShrink: 0 }}
            />
          </Box>
        </Tooltip>
        <Tooltip title={localeText.chatNewConversationName}>
          <IconButton
            size="small"
            onClick={handleNewThread}
            aria-label={localeText.chatNewConversationName}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Thread switcher dropdown */}
      <Menu
        anchorEl={threadMenuAnchor}
        open={Boolean(threadMenuAnchor)}
        onClose={() => setThreadMenuAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 220, maxWidth: 320, maxHeight: 320 } } }}
      >
        {sortedThreads.length === 0 && (
          <MenuItem disabled>
            <Typography variant="caption" color="text.secondary">
              {localeText.chatNoConversationsLabel}
            </Typography>
          </MenuItem>
        )}
        {sortedThreads.map((thread) => (
          <MenuItem
            key={thread.id}
            selected={thread.id === activeThreadId}
            onClick={() => handleSelectThread(thread.id)}
            sx={{ maxWidth: 320 }}
          >
            <Typography
              variant="body2"
              sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {thread.name}
            </Typography>
          </MenuItem>
        ))}
      </Menu>

      {/* Chat box */}
      {/* `StudioMessageActions` is a ChatBox SLOT, so the retry handler can't be passed
          the turn ledger as a prop — it reaches it through this provider. */}
      <StudioChatTurnMutationContext.Provider value={turnMutations}>
        <VoiceMicContext.Provider value={voiceMicContextValue}>
          <Box sx={{ flexGrow: 1, minHeight: 0 }}>
            <ChatBox
              {...slotProps?.chatBox}
              adapter={adapter}
              density={density}
              variant={variant}
              // `messages`/`onMessagesChange` are always Studio's own values, matching the
              // `StudioChatPanelSlotProps.chatBox` JSDoc ("cannot be overridden here") — a
              // consumer-supplied override would show the consumer's array in the rendered
              // ChatBox while `handleMessagesChange` keeps writing stream deltas into
              // controller thread state, silently diverging the two (finding 2.8). Since
              // these are set AFTER `{...slotProps?.chatBox}` above, they always win.
              messages={threadMessages}
              onMessagesChange={handleMessagesChange}
              onFinish={slotProps?.chatBox?.onFinish}
              onError={slotProps?.chatBox?.onError}
              composerValue={composerValue}
              onComposerValueChange={handleComposerValueChange}
              // `initialPrompt` is auto-submitted (not merely pre-filled) via the
              // `AutoSubmitTrigger` effect above — ChatBox's own `autoSubmitInitialValue`
              // is declared in its PropTypes but not implemented. Only the consumer's
              // `slotProps.chatBox.initialComposerValue` pre-fill is honoured here.
              initialComposerValue={slotProps?.chatBox?.initialComposerValue}
              suggestions={threadMessages.length === 0 ? suggestions : undefined}
              suggestionsAutoSubmit
              // `displayName` is rendered on every one of the user's own messages, so it has to
              // come from `localeText` like every other visible string — it was hardcoded to the
              // English "You" even under a fully translated locale.
              currentUser={{
                id: 'user',
                displayName: localeText.chatUserDisplayName,
                role: 'user',
              }}
              features={{
                // Consumer can configure optional features …
                ...slotProps?.chatBox?.features,
                // … but Studio always enforces these: we manage the conversation header
                // ourselves and don't support file attachments in the AI flow.
                conversationHeader: false,
                attachments: false,
              }}
              localeText={{
                // Studio-appropriate empty-state and placeholder text
                composerInputPlaceholder: localeText.chatComposerPlaceholder,
                threadNoMessagesLabel: localeText.chatEmptyStateTitle,
                threadNoMessagesHelperText: localeText.chatEmptyStateSubtitle,
                // Consumer overrides last so they can tailor every string
                ...slotProps?.chatBox?.localeText,
              }}
              partRenderers={{
                // Studio default part renderers (reasoning "Thinking…", optional tool-call hiding)
                ...studioPartRenderers,
                // Consumer can add custom renderers or override Studio's defaults
                ...slotProps?.chatBox?.partRenderers,
              }}
              slots={{
                // Studio overrides: stop-streaming button, message root with metadata display,
                // per-message copy/retry actions, and mic button in the composer toolbar
                composerSendButton: StudioSendButton,
                composerToolbar: StudioComposerToolbar,
                messageRoot: StudioMessageRoot,
                messageActions: StudioMessageActions,
                // Consumer slot overrides come last
                ...slotProps?.chatBox?.slots,
              }}
              slotProps={{
                // Keep suggestions wrapped in the narrow overlay panel — the default
                // above-composer mode switches to nowrap+overflowX:auto which overflows.
                suggestions: {
                  sx: { '&:not([data-empty])': { flexWrap: 'wrap', overflowX: 'unset' } },
                },
                ...slotProps?.chatBox?.slotProps,
              }}
              sx={{ height: '100%' }}
            >
              <AutoSubmitTrigger
                pending={pendingAutoSubmit}
                onConsumed={handleAutoSubmitConsumed}
                runProgrammaticComposerChange={runProgrammaticComposerChange}
              />
              <StreamThreadPin {...streamThreadPinProps} />
            </ChatBox>
          </Box>
        </VoiceMicContext.Provider>
      </StudioChatTurnMutationContext.Provider>
    </Box>
  );

  if (!overlay) {
    return chatBox;
  }

  // Overlay mode: fixed-position panel that grows from the FAB corner.
  // Destructure sx from panel slot props so we can merge it explicitly.
  const { sx: panelSx, ...panelRestProps } = (slotProps?.panel ?? {}) as {
    sx?: SxProps<Theme>;
    [key: string]: unknown;
  };
  return (
    <Grow in={open} mountOnEnter unmountOnExit style={{ transformOrigin: 'bottom right' }}>
      <Box
        {...panelRestProps}
        ref={overlayRef}
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleOverlayKeyDown}
        sx={[
          {
            position: 'fixed',
            bottom: 80,
            right: 16,
            width: 380,
            height: 'clamp(480px, 75vh, calc(100vh - 96px))',
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            borderRadius: 2,
            boxShadow: 8,
            zIndex: (theme) => theme.zIndex.drawer + 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
          ...toSxArray(sx),
          ...toSxArray(panelSx),
        ]}
      >
        {/* Overlay header with close button */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            px: 2,
            py: 1,
            borderBottom: 1,
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          <Typography id={titleId} variant="subtitle2" sx={{ flexGrow: 1, fontWeight: 600 }}>
            {localeText.aiAssistantPanelTitle}
          </Typography>
          {onClose && (
            <Tooltip title={localeText.aiAssistantCloseTooltip}>
              <IconButton
                size="small"
                onClick={onClose}
                aria-label={localeText.aiAssistantCloseTooltip}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        {chatBox}
      </Box>
    </Grow>
  );
}
