'use client';

import * as React from 'react';
import { Box, Grow, IconButton, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { ChatBox, ChatConfirmation } from '@mui/x-chat';
import type { ChatAdapter } from '@mui/x-chat/headless';

import {
  useStudioController,
  useStudioSelector,
  selectDataSources,
  selectWidgets,
  selectPages,
  selectDashboard,
} from '../context';
import { useStudioUIConfig } from '../internals/StudioUIConfigContext';
import type { StudioAIConfig } from './studioAdapter';
import { createStudioChatAdapter } from './studioAdapter';
import type { StudioCustomWidgetDef } from '../models';

// ── Suggestion generator ──────────────────────────────────────────────────────

function generateSuggestions(
  dataSources: ReturnType<typeof selectDataSources>,
  widgets: ReturnType<typeof selectWidgets>,
  activePageWidgetIds: string[],
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
          label: `Bar chart: ${numericField.label} by ${catField.label}`,
          value: `Add a bar chart showing ${numericField.label} by ${catField.label} from the ${source.label} data.`,
        });
        suggestions.push({
          label: `KPI: total ${numericField.label}`,
          value: `Add a KPI card showing the total ${numericField.label} from ${source.label}.`,
        });
      } else if (source.fields.length > 0) {
        suggestions.push({
          label: `Table from ${source.label}`,
          value: `Add a data table showing records from ${source.label}.`,
        });
      }
    }

    if (suggestions.length < 3) {
      suggestions.push({
        label: 'What data is available?',
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
          label: `Change "${first.title}" to line chart`,
          value: `Change the "${first.title}" widget to a line chart.`,
        });
      }
    }

    if (kpiWidgets.length > 0) {
      const first = kpiWidgets[0];
      if (first) {
        suggestions.push({
          label: `Add sparkline to "${first.title}"`,
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
          label: 'Add a date filter',
          value: 'Add a date range filter widget to the dashboard.',
        });
      }
    }

    suggestions.push({
      label: 'Add a new page',
      value: 'Create a new dashboard page.',
    });
  }

  return suggestions.slice(0, 4);
}

// ── Pending confirmation state ────────────────────────────────────────────────

interface PendingConfirmation {
  kind: 'widget' | 'page';
  id: string;
  title: string;
  resolve: (confirmed: boolean) => void;
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
}

export function StudioChatPanel(props: StudioChatPanelProps) {
  const {
    aiConfig,
    customWidgets: customWidgetsProp,
    focusedWidgetId,
    open = true,
    onClose,
    overlay = false,
    slotProps,
  } = props;

  const controller = useStudioController();
  const dataSources = useStudioSelector(selectDataSources);
  const widgets = useStudioSelector(selectWidgets);
  const pages = useStudioSelector(selectPages);
  const dashboard = useStudioSelector(selectDashboard);
  const { customWidgets: contextCustomWidgets } = useStudioUIConfig();

  // Prefer explicit prop; fall back to Studio context
  const customWidgets = customWidgetsProp ?? contextCustomWidgets;

  const activePage = pages[dashboard.activePageId];
  const activeWidgetIds = React.useMemo(() => (activePage?.widgetRows ?? []).flat(), [activePage]);

  // ── Confirmation dialog state ──────────────────────────────────────────────
  const [pendingConfirm, setPendingConfirm] = React.useState<PendingConfirmation | null>(null);

  const onRemoveWidgetRequest = React.useCallback(
    (widgetId: string, widgetTitle: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setPendingConfirm({ kind: 'widget', id: widgetId, title: widgetTitle, resolve });
      }),
    [],
  );

  const onRemovePageRequest = React.useCallback(
    (pageId: string, pageTitle: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setPendingConfirm({ kind: 'page', id: pageId, title: pageTitle, resolve });
      }),
    [],
  );

  // ── Adapter (recreated when aiConfig or controller changes) ───────────────
  const adapter = React.useMemo<ChatAdapter | null>(() => {
    if (!aiConfig?.endpoint) {
      return null;
    }
    return createStudioChatAdapter(
      aiConfig,
      controller,
      onRemoveWidgetRequest,
      customWidgets,
      focusedWidgetId,
      onRemovePageRequest,
    );
  }, [
    aiConfig,
    controller,
    onRemoveWidgetRequest,
    onRemovePageRequest,
    customWidgets,
    focusedWidgetId,
  ]);

  // ── Dynamic suggestions ────────────────────────────────────────────────────
  const suggestions = React.useMemo(
    () => generateSuggestions(dataSources, widgets, activeWidgetIds),
    [dataSources, widgets, activeWidgetIds],
  );

  // ── System prompt (regenerated on each send — passed via adapter) ─────────
  // The adapter itself calls buildAISystemPrompt(controller.getState()) on each send,
  // so the prompt is always fresh. Nothing extra needed here.

  if (!adapter) {
    return null;
  }

  const chatBox = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Chat box */}
      <Box sx={{ flexGrow: 1, minHeight: 0 }}>
        <ChatBox
          {...slotProps?.chatBox}
          adapter={adapter}
          suggestions={suggestions}
          suggestionsAutoSubmit
          currentUser={{ id: 'user', displayName: 'You', role: 'user' }}
          features={{ conversationHeader: false, attachments: false }}
          localeText={{ composerInputPlaceholder: 'How can I help?' }}
          sx={{ height: '100%' }}
        />
      </Box>

      {/* Confirmation dialog for remove_widget / remove_page */}
      {pendingConfirm && (
        <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
          <ChatConfirmation
            message={
              pendingConfirm.kind === 'page'
                ? `Remove page "${pendingConfirm.title}" and all its widgets? This cannot be undone from chat.`
                : `Remove "${pendingConfirm.title}"? This cannot be undone from chat.`
            }
            confirmLabel="Remove"
            cancelLabel="Keep"
            onConfirm={() => {
              pendingConfirm.resolve(true);
              setPendingConfirm(null);
            }}
            onCancel={() => {
              pendingConfirm.resolve(false);
              setPendingConfirm(null);
            }}
          />
        </Box>
      )}
    </Box>
  );

  if (!overlay) {
    return chatBox;
  }

  // Overlay mode: fixed-position panel that grows from the FAB corner
  return (
    <Grow in={open} mountOnEnter unmountOnExit style={{ transformOrigin: 'bottom right' }}>
      <Box
        {...slotProps?.panel}
        sx={{
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
          ...((slotProps?.panel as { sx?: object })?.sx ?? {}),
        }}
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
            <Tooltip title="Close">
              <IconButton size="small" onClick={onClose} aria-label="Close AI assistant">
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
