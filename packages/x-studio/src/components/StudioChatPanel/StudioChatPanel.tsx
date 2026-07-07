'use client';

import * as React from 'react';
import type { SxProps, Theme } from '@mui/material';
import { Box, Grow, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { ChatBox } from '@mui/x-chat';
import type { ChatAdapter, ChatPartRendererMap } from '@mui/x-chat/headless';
import { useChatComposer } from '@mui/x-chat/headless';

import {
  useStudioController,
  useStudioSelector,
  selectDataSources,
  selectWidgets,
  selectPages,
  selectDashboard,
} from '../../context';
import { useStudioUIConfig, useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { StudioAIConfig } from './studioBackendAdapter';
import { createBackendChatAdapter } from './studioBackendAdapter';
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

// Invisible component rendered inside ChatBox (inside ChatRoot context).
// When `pending` changes to a new seq, sets the composer value and submits.
function AutoSubmitTrigger({ pending }: { pending: { text: string; seq: number } | null }) {
  const { setValue, submit } = useChatComposer();
  const seqRef = React.useRef(-1);

  React.useEffect(() => {
    if (!pending || pending.seq === seqRef.current) {
      return;
    }
    seqRef.current = pending.seq;
    setValue(pending.text);
    void Promise.resolve().then(() => submit());
  }, [pending, setValue, submit]);

  return null;
}

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
  /** Called when the user dismisses the panel (close button or backdrop click). */
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

  // Prefer explicit prop; fall back to Studio context
  const customWidgets = customWidgetsProp ?? contextCustomWidgets;

  const activePage = pages[dashboard.activePageId];
  const activeWidgetIds = React.useMemo(() => (activePage?.widgetRows ?? []).flat(), [activePage]);

  // ── Adapter (recreated when aiConfig or controller changes) ───────────────
  const adapter = React.useMemo<ChatAdapter | null>(() => {
    if (!aiConfig?.endpoint) {
      return null;
    }
    return createBackendChatAdapter(aiConfig, controller, customWidgets, focusedWidgetId);
  }, [aiConfig, controller, customWidgets, focusedWidgetId]);

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
  const [pendingAutoSubmit, setPendingAutoSubmit] = React.useState<{
    text: string;
    seq: number;
  } | null>(null);
  const pendingMessageIdRef = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    if (!pendingMessage || pendingMessage.id === pendingMessageIdRef.current) {
      return;
    }
    pendingMessageIdRef.current = pendingMessage.id;
    setPendingAutoSubmit({ text: pendingMessage.text, seq: pendingMessage.id });
  }, [pendingMessage]);

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
      <VoiceMicContext.Provider value={voiceMicContextValue}>
        <Box sx={{ flexGrow: 1, minHeight: 0 }}>
          <ChatBox
            {...slotProps?.chatBox}
            adapter={adapter}
            density={density}
            variant={variant}
            messages={slotProps?.chatBox?.messages ?? threadMessages}
            onMessagesChange={slotProps?.chatBox?.onMessagesChange ?? handleMessagesChange}
            onFinish={slotProps?.chatBox?.onFinish}
            onError={slotProps?.chatBox?.onError}
            composerValue={composerValue}
            onComposerValueChange={handleComposerValueChange}
            // initialPrompt: pre-fill when there are no existing messages.
            // autoSubmitInitialValue is declared in ChatBox PropTypes but not implemented —
            // omit it to avoid the "unrecognized DOM prop" console warning.
            initialComposerValue={
              threadMessages.length === 0
                ? (initialPrompt ?? slotProps?.chatBox?.initialComposerValue)
                : slotProps?.chatBox?.initialComposerValue
            }
            suggestions={threadMessages.length === 0 ? suggestions : undefined}
            suggestionsAutoSubmit
            currentUser={{ id: 'user', displayName: 'You', role: 'user' }}
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
            <AutoSubmitTrigger pending={pendingAutoSubmit} />
            <StreamThreadPin {...streamThreadPinProps} />
          </ChatBox>
        </Box>
      </VoiceMicContext.Provider>
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
          <Typography variant="subtitle2" sx={{ flexGrow: 1, fontWeight: 600 }}>
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
