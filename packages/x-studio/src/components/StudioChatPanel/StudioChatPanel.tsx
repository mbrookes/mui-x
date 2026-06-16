'use client';

import * as React from 'react';
import type { SxProps, Theme } from '@mui/material';
import {
  Box,
  Collapse,
  Grow,
  IconButton,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import StopCircleIcon from '@mui/icons-material/StopCircle';
// Tool icons — each Studio AI tool gets a recognisable MUI icon in the tool call cards
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import BarChartIcon from '@mui/icons-material/BarChart';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import DashboardIcon from '@mui/icons-material/Dashboard';
import DeleteIcon from '@mui/icons-material/Delete';
import EditNoteIcon from '@mui/icons-material/EditNote';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LayersIcon from '@mui/icons-material/Layers';
import NoteAltIcon from '@mui/icons-material/NoteAlt';
import SearchIcon from '@mui/icons-material/Search';
import StorageIcon from '@mui/icons-material/Storage';
import TitleIcon from '@mui/icons-material/Title';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { ChatBox, ChatComposerSendButton, ChatComposerToolbar, ChatMessage } from '@mui/x-chat';
import type {
  ChatAdapter,
  ChatMessage as ChatMessageType,
  ChatPartRendererMap,
} from '@mui/x-chat/headless';
import {
  useChat,
  useChatComposer,
  useMessage,
  useMessageContext,
  createToolPartRenderer,
} from '@mui/x-chat/headless';

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
import { useSpeechRecognition } from './useSpeechRecognition';

// ── Per-tool icon map ─────────────────────────────────────────────────────────
// Maps each Studio AI tool name to an MUI icon component for the tool call cards.
// createToolPartRenderer() takes ToolPartExternalProps (including toolSlots) and
// returns a ChatPartRenderer that wraps the default ToolPart.

const STUDIO_TOOL_ICONS: Record<string, React.ComponentType> = {
  // Dashboard-level tools
  get_dashboard_state: InfoOutlinedIcon,
  set_dashboard_title: TitleIcon,
  // Page tools
  add_page: LayersIcon,
  rename_page: EditNoteIcon,
  remove_page: DeleteIcon,
  set_active_page: LayersIcon,
  // Widget tools
  add_widget: DashboardIcon,
  update_widget: BarChartIcon,
  remove_widget: DeleteIcon,
  set_widget_layout: DashboardIcon,
  set_widget_width: DashboardIcon,
  set_widget_forecast: TrendingUpIcon,
  // Filter tools
  add_page_filter: FilterAltIcon,
  remove_page_filter: FilterAltIcon,
  add_widget_filter: FilterAltIcon,
  remove_widget_filter: FilterAltIcon,
  // Insight / utility tools
  summarise_page: NoteAltIcon,
  apply_bulk_update: AutoFixHighIcon,
  rename_thread: EditNoteIcon,
  execute_query: StorageIcon,
  // Date / calendar tools
  get_current_date: CalendarTodayIcon,
  // MCP / search tools
  search: SearchIcon,
};

const studioDynamicToolRenderer = createToolPartRenderer({
  toolSlots: Object.fromEntries(
    Object.entries(STUDIO_TOOL_ICONS).map(([name, icon]) => [name, { icon }]),
  ),
});

/**
 * A no-op renderer that still renders `approval-requested` tool parts.
 * Used when `showToolCalls === false` to ensure the approval confirmation
 * UI is never suppressed — users must be able to approve/deny destructive
 * operations regardless of the tool-call visibility setting.
 */
const studioApprovalOnlyRenderer: ChatPartRendererMap['dynamic-tool'] = (props) => {
  if (
    (props.part as { toolInvocation?: { state?: string } }).toolInvocation?.state ===
    'approval-requested'
  ) {
    return studioDynamicToolRenderer(props);
  }
  return null;
};

// ── StudioSendButton — stop/send toggle for the composer ──────────────────────
// Wraps ChatComposerSendButton (x-chat) via slots.sendButton so that x-chat's
// ComposerSendButton headless layer computes `disabled` correctly from hasValue,
// isStreaming, etc. — avoiding the need to replicate that logic here.
// Defined at module level for a stable slot reference (unstable references
// cause the button to remount on every render).

// Normalize an optional `sx` prop into an array of sx entries so it can be spread into a
// combined `sx={[...]}` array. The element type excludes the array form of `SxProps` so the
// result is directly spreadable into MUI's `sx` array prop without nesting.
type SxEntry = Exclude<SxProps<Theme>, ReadonlyArray<unknown>>;
function toSxArray(sx: SxProps<Theme> | undefined): SxEntry[] {
  if (Array.isArray(sx)) {
    return sx as SxEntry[];
  }
  return sx ? [sx as SxEntry] : [];
}

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
function StudioSendButton({
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

// ── StudioMessageActions — hover-reveal copy + retry buttons ─────────────────
// Defined at module level (stable ref) so ChatBox doesn't re-mount on every render.
// Rendered inside ChatMessageActions (the styled hover-reveal container) for each message.

interface StudioMessageActionsProps {
  messageId: string;
}

const StudioMessageActions = React.memo(function StudioMessageActions({
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

function StudioMessageRoot({
  ref,
  ownerState: _ownerState,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  ownerState?: unknown;
  ref?: React.Ref<HTMLDivElement>;
}) {
  // messageId is not forwarded as a prop to the root slot — it lives in MessageContextProvider.
  const { messageId, message } = useMessageContext();
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
              {totalTokens.toLocaleString()} tokens
            </Typography>
          )}
          {metadata?.iterations != null && metadata.iterations > 1 && (
            <Typography variant="inherit" component="span">
              {metadata.iterations} turns
            </Typography>
          )}
        </Box>
      )}
    </React.Fragment>
  );
}

// ── StudioReasoningPart — "Thinking…" indicator + collapsible reasoning ────────

interface ReasoningPartProps {
  part: { text: string; state?: string };
}

function StudioReasoningPart({ part }: ReasoningPartProps) {
  const [expanded, setExpanded] = React.useState(false);
  const reasoningRegionId = React.useId();
  const isStreaming = part.state === 'streaming';

  // While waiting for the first response: show "Thinking…" with animated ellipsis.
  if (isStreaming && !part.text) {
    return (
      <Typography
        variant="caption"
        color="text.secondary"
        role="status"
        sx={{ display: 'block', fontStyle: 'italic', px: 0.5, py: 0.25 }}
      >
        Thinking…
      </Typography>
    );
  }

  // No content after completion: hide the part entirely.
  if (!part.text) {
    return null;
  }

  // Completed with content: collapsible "Reasoning" section.
  return (
    <Box sx={{ my: 0.5, borderRadius: 1, border: 1, borderColor: 'divider', overflow: 'hidden' }}>
      <Box
        component="button"
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={reasoningRegionId}
        sx={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 0.5,
          px: 1,
          py: 0.5,
          bgcolor: 'action.hover',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          '&:hover': { bgcolor: 'action.selected' },
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
          Reasoning
        </Typography>
        <ExpandMoreIcon
          aria-hidden
          sx={{
            fontSize: 16,
            color: 'text.secondary',
            transform: expanded ? 'rotate(180deg)' : 'none',
            transition: 'transform 200ms',
          }}
        />
      </Box>
      <Collapse in={expanded}>
        <Typography
          id={reasoningRegionId}
          variant="caption"
          component="pre"
          sx={{
            display: 'block',
            m: 0,
            p: 1,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'text.secondary',
          }}
        >
          {part.text}
        </Typography>
      </Collapse>
    </Box>
  );
}

// ── Suggestion generator ──────────────────────────────────────────────────────

function generateSuggestions(
  dataSources: ReturnType<typeof selectDataSources>,
  widgets: ReturnType<typeof selectWidgets>,
  activePageWidgetIds: string[],
  localeText: ReturnType<typeof useStudioLocaleText>,
): Array<{ label: string; value: string }> {
  const sourceList = Object.values(dataSources);
  const activeWidgets = activePageWidgetIds.flatMap((id) => (widgets[id] ? [widgets[id]] : []));
  const hasWidgets = activeWidgets.length > 0;

  const suggestions: Array<{ label: string; value: string }> = [];

  if (!hasWidgets) {
    // Empty state: suggest building first widgets from available sources
    for (const source of sourceList.slice(0, 3)) {
      let numericField: (typeof source.fields)[0] | undefined;
      let catField: (typeof source.fields)[0] | undefined;
      for (const f of source.fields) {
        if (!f.hidden) {
          if (!numericField && f.type === 'number') {
            numericField = f;
          }
          if (!catField && (f.type === 'string' || f.type === 'date')) {
            catField = f;
          }
        }
        if (numericField && catField) {
          break;
        }
      }

      if (numericField && catField) {
        suggestions.push({
          label: localeText.aiSuggestionBarChart(numericField.label, catField.label),
          value: `Add a bar chart showing ${numericField.label} by ${catField.label} from the ${source.label} data.`,
        });
        suggestions.push({
          label: localeText.aiSuggestionKpi(numericField.label),
          value: `Add a KPI card showing the total ${numericField.label} from ${source.label}.`,
        });
      } else if (source.fields.length > 0) {
        suggestions.push({
          label: localeText.aiSuggestionTable(source.label),
          value: `Add a data table showing records from ${source.label}.`,
        });
      }
    }

    if (suggestions.length < 3) {
      suggestions.push({
        label: localeText.aiSuggestionWhatDataAvailable,
        value: 'What data sources and fields are available for building this dashboard?',
      });
    }
  } else {
    // Existing widgets: suggest modifications and additions
    const chartWidgets = activeWidgets.filter((w) => w?.kind === 'chart');
    const kpiWidgets = activeWidgets.filter((w) => w?.kind === 'kpi');

    if (chartWidgets.length > 0) {
      const first = chartWidgets[0];
      if (first) {
        suggestions.push({
          label: localeText.aiSuggestionChangeToLine(first.title),
          value: `Change the "${first.title}" widget to a line chart.`,
        });
      }
    }

    if (kpiWidgets.length > 0) {
      const first = kpiWidgets[0];
      if (first) {
        suggestions.push({
          label: localeText.aiSuggestionAddSparkline(first.title),
          value: `Add a sparkline to the "${first.title}" KPI widget.`,
        });
      }
    }

    // Suggest adding a date filter if not present
    const hasFilter = activeWidgets.some((w) => w?.kind === 'filter');
    if (!hasFilter) {
      const hasDateSource = Object.values(dataSources).some((s) =>
        s.fields.some((f) => f.type === 'date' || f.type === 'datetime'),
      );
      if (hasDateSource) {
        suggestions.push({
          label: localeText.aiSuggestionAddDateFilter,
          value: 'Add a date range filter widget to the dashboard.',
        });
      }
    }

    suggestions.push({
      label: localeText.aiSuggestionAddPage,
      value: 'Create a new dashboard page.',
    });

    suggestions.push({
      label: localeText.aiSuggestionSummarisePage,
      value:
        'Give me an executive summary of the key insights from this page — focus on the data, trends, and any anomalies rather than the page structure.',
    });
  }

  return suggestions.slice(0, 4);
}

// ── Voice mic context — bridges voice state to the toolbar slot ───────────────
// The toolbar slot component must be stable (module-level), so voice state is
// passed via context rather than closing over render-scope variables.

interface VoiceMicContextValue {
  voiceSupported: boolean;
  isListening: boolean;
  onToggle: () => void;
  startLabel: string;
  stopLabel: string;
}
const VoiceMicContext = React.createContext<VoiceMicContextValue | null>(null);

// ── StudioComposerToolbar — mic button + native toolbar children ──────────────

function StudioComposerToolbar({
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

  // ── AI conversation thread state ──────────────────────────────────────────
  // Use a stable default thread ID so the first thread is always available.
  const defaultThreadId = React.useRef(`thread-${Date.now()}`);

  const aiState = useStudioSelector((state) => state.ai);
  const activeThreadId = aiState?.activeThreadId ?? defaultThreadId.current;

  const activeThread = aiState?.threads.find((t) => t.id === activeThreadId);
  const threadMessages = activeThread?.messages ?? [];

  const handleMessagesChange = React.useCallback(
    (messages: ChatMessageType[]) => {
      const state = controller.getState();
      const existingThreads = state.ai?.threads ?? [];
      const now = new Date().toISOString();

      const updatedThreads = existingThreads.some((t) => t.id === activeThreadId)
        ? existingThreads.map((t) =>
            t.id === activeThreadId ? { ...t, messages, updatedAt: now } : t,
          )
        : [
            ...existingThreads,
            {
              id: activeThreadId,
              name: localeText.chatNewConversationName,
              createdAt: now,
              updatedAt: now,
              messages,
            },
          ];

      controller.setState({
        ...state,
        ai: {
          threads: updatedThreads,
          activeThreadId,
        },
      });
    },
    [controller, activeThreadId, localeText.chatNewConversationName],
  );

  // ── Thread management actions ────────────────────────────────────────────────
  const [threadMenuAnchor, setThreadMenuAnchor] = React.useState<HTMLElement | null>(null);

  const handleNewThread = React.useCallback(() => {
    const newId = `thread-${Date.now()}`;
    const now = new Date().toISOString();
    const state = controller.getState();
    const existingThreads = state.ai?.threads ?? [];
    controller.setState({
      ...state,
      ai: {
        threads: [
          ...existingThreads,
          { id: newId, name: localeText.chatNewConversationName, createdAt: now, messages: [] },
        ],
        activeThreadId: newId,
      },
    });
    // Update the stable ref so the next message goes to the new thread.
    defaultThreadId.current = newId;
  }, [controller, localeText.chatNewConversationName]);

  const handleSelectThread = React.useCallback(
    (threadId: string) => {
      const state = controller.getState();
      controller.setState({
        ...state,
        ai: { ...(state.ai ?? { threads: [] }), activeThreadId: threadId },
      });
      defaultThreadId.current = threadId;
      setThreadMenuAnchor(null);
    },
    [controller],
  );

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

  const sortedThreads = React.useMemo(
    () =>
      (aiState?.threads ?? []).toSorted((a, b) => {
        const aTime = a.updatedAt ?? a.createdAt;
        const bTime = b.updatedAt ?? b.createdAt;
        return bTime.localeCompare(aTime);
      }),
    [aiState?.threads],
  );

  const activeThreadName = activeThread?.name ?? localeText.chatNewConversationName;

  // ── Dynamic suggestions ────────────────────────────────────────────────────
  const suggestions = React.useMemo(
    () => generateSuggestions(dataSources, widgets, activeWidgetIds, localeText),
    [dataSources, widgets, activeWidgetIds, localeText],
  );

  // ── Voice input ───────────────────────────────────────────────────────────
  const {
    isSupported: voiceSupported,
    isListening,
    transcript,
    start: startVoice,
    stop: stopVoice,
    resetTranscript,
  } = useSpeechRecognition();
  // Track the text that was in the composer before voice started.
  const voiceBaseTextRef = React.useRef('');
  // Always-controlled composer value — start with '' so ChatBox never switches
  // from uncontrolled to controlled mid-session.
  const [composerValue, setComposerValue] = React.useState('');

  const handleToggleVoice = React.useCallback(() => {
    if (isListening) {
      stopVoice();
      // Leave the finalised transcript in the composer; clear the ref.
      voiceBaseTextRef.current = '';
    } else {
      // Snapshot current composer text so we can prepend it to the transcript.
      voiceBaseTextRef.current = composerValue;
      resetTranscript();
      startVoice();
    }
  }, [isListening, composerValue, startVoice, stopVoice, resetTranscript]);

  // Keep composer value in sync with live transcript.
  React.useEffect(() => {
    if (!isListening) {
      return;
    }
    const combined = voiceBaseTextRef.current
      ? `${voiceBaseTextRef.current} ${transcript}`
      : transcript;
    setComposerValue(combined);
  }, [isListening, transcript]);

  // When voice ends (not initiated by the user), sync the final value once more.
  React.useEffect(() => {
    if (!isListening && transcript) {
      const combined = voiceBaseTextRef.current
        ? `${voiceBaseTextRef.current} ${transcript}`
        : transcript;
      setComposerValue(combined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isListening]);

  const handleComposerValueChange = React.useCallback(
    (value: string) => {
      setComposerValue(value);
      // When the user manually edits the input while voice is active, stop listening
      // and adopt their edit as the new base.
      if (isListening) {
        stopVoice();
        voiceBaseTextRef.current = '';
      }
    },
    [isListening, stopVoice],
  );

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
              No conversations yet
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
              composerInputPlaceholder: 'How can I help?',
              threadNoMessagesLabel: 'Ask me anything about your dashboard',
              threadNoMessagesHelperText: 'I can add widgets, analyse your data, and more',
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
            AI Assistant
          </Typography>
          {onClose && (
            <Tooltip title={localeText.aiCloseTooltip}>
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
