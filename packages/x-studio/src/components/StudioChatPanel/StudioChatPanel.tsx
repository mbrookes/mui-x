'use client';

import * as React from 'react';
import type { SxProps, Theme } from '@mui/material';
import { Box, Grow, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import { ChatBox } from '@mui/x-chat';
import type { ChatAdapter, ChatMessage } from '@mui/x-chat/headless';

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

// ── Component ─────────────────────────────────────────────────────────────────

export interface StudioChatPanelSlotProps {
  /**
   * Extra props spread onto `ChatBox` before Studio's own required props.
   * Useful for `currentUser`, additional `features`, `localeText` overrides, etc.
   * Studio's own `adapter`, `suggestions`, `sx`, `features`, and `localeText` always take precedence.
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
}

// react-doctor-disable-next-line react-doctor/no-giant-component -- chat panel orchestrates thread/message/suggestion state and cannot be split further
export function StudioChatPanel(props: StudioChatPanelProps) {
  const {
    aiConfig,
    customWidgets: customWidgetsProp,
    focusedWidgetId,
    open = true,
    onClose,
    overlay = false,
    slotProps,
    sx,
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
    (messages: ChatMessage[]) => {
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
    [controller, activeThreadId],
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
  }, [controller]);

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
  const { isSupported: voiceSupported, isListening, transcript, start: startVoice, stop: stopVoice, resetTranscript } = useSpeechRecognition();
  // Track the text that was in the composer before voice started.
  const voiceBaseTextRef = React.useRef('');
  // Controlled composer value (undefined = let ChatBox manage it internally).
  const [composerValue, setComposerValue] = React.useState<string | undefined>(undefined);

  const handleToggleVoice = React.useCallback(() => {
    if (isListening) {
      stopVoice();
      // Leave the finalised transcript in the composer; clear the ref.
      voiceBaseTextRef.current = '';
    } else {
      // Snapshot current composer text so we can prepend it to the transcript.
      voiceBaseTextRef.current = composerValue ?? '';
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

  const handleComposerValueChange = React.useCallback((value: string) => {
    setComposerValue(value);
    // When the user manually edits the input while voice is active, stop listening
    // and adopt their edit as the new base.
    if (isListening) {
      stopVoice();
      voiceBaseTextRef.current = '';
    }
  }, [isListening, stopVoice]);

  if (!adapter) {
    return null;
  }

  const chatBox = (
    <Box
      sx={[
        { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
        ...(!overlay ? (Array.isArray(sx) ? sx : sx ? [sx] : []) : []),
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
            onClick={(e: React.MouseEvent<HTMLElement>) => setThreadMenuAnchor(e.currentTarget)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.25,
              flexGrow: 1,
              background: 'none',
              border: 'none',
              cursor: 'default',
              p: 0.5,
              borderRadius: 1,
              textAlign: 'left',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Typography
              variant="caption"
              sx={{ flexGrow: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {activeThreadName}
            </Typography>
            <ArrowDropDownIcon sx={{ fontSize: 18, color: 'text.secondary', flexShrink: 0 }} />
          </Box>
        </Tooltip>
        <Tooltip title={localeText.chatNewConversationName}>
          <IconButton size="small" onClick={handleNewThread} aria-label={localeText.chatNewConversationName}>
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
      <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <ChatBox
          {...slotProps?.chatBox}
          adapter={adapter}
          messages={slotProps?.chatBox?.messages ?? threadMessages}
          onMessagesChange={slotProps?.chatBox?.onMessagesChange ?? handleMessagesChange}
          composerValue={composerValue}
          onComposerValueChange={handleComposerValueChange}
          suggestions={suggestions}
          suggestionsAutoSubmit
          currentUser={{ id: 'user', displayName: 'You', role: 'user' }}
          features={{ conversationHeader: false, attachments: false }}
          localeText={{ composerInputPlaceholder: 'How can I help?' }}
          sx={{ height: '100%' }}
        />
        {/* Mic button — overlaid in the bottom-right corner of the composer area */}
        {voiceSupported && (
          <Tooltip title={isListening ? localeText.chatVoiceInputStop : localeText.chatVoiceInputStart}>
            <IconButton
              size="small"
              onClick={handleToggleVoice}
              aria-label={isListening ? localeText.chatVoiceInputStop : localeText.chatVoiceInputStart}
              color={isListening ? 'error' : 'default'}
              sx={{
                position: 'absolute',
                bottom: 10,
                right: 44,
                zIndex: 1,
                bgcolor: 'background.paper',
                boxShadow: 1,
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              {isListening ? <MicOffIcon fontSize="small" /> : <MicIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
      </Box>
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
            height: 'clamp(320px, 50vh, calc(100vh - 96px))',
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
          ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
          ...(Array.isArray(panelSx) ? panelSx : panelSx ? [panelSx] : []),
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
