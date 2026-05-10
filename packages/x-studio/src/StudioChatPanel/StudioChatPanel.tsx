'use client';

import * as React from 'react';
import { Box, IconButton, Slide, Tooltip, Typography } from '@mui/material';
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
import type { StudioAIConfig } from './studioAdapter';
import { createStudioChatAdapter } from './studioAdapter';

// ── Suggestion generator ──────────────────────────────────────────────────────

function generateSuggestions(
  dataSources: ReturnType<typeof selectDataSources>,
  widgets: ReturnType<typeof selectWidgets>,
  activePageWidgetIds: string[],
): Array<{ label: string; value: string }> {
  const sourceList = Object.values(dataSources);
  const activeWidgets = activePageWidgetIds
    .map((id) => widgets[id])
    .filter(Boolean);
  const hasWidgets = activeWidgets.length > 0;

  const suggestions: Array<{ label: string; value: string }> = [];

  if (!hasWidgets) {
    // Empty state: suggest building first widgets from available sources
    for (const source of sourceList.slice(0, 3)) {
      const numericField = source.fields.find(
        (f) => f.type === 'number' && !f.hidden,
      );
      const catField = source.fields.find(
        (f) => (f.type === 'string' || f.type === 'date') && !f.hidden,
      );

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
  widgetId: string;
  widgetTitle: string;
  resolve: (confirmed: boolean) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface StudioChatPanelProps {
  /**
   * LLM configuration — endpoint, optional API key, and model.
   * If not provided, the panel is not rendered.
   */
  aiConfig?: StudioAIConfig | null;
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
}

export function StudioChatPanel(props: StudioChatPanelProps) {
  const { aiConfig, open = true, onClose, overlay = false } = props;

  const controller = useStudioController();
  const dataSources = useStudioSelector(selectDataSources);
  const widgets = useStudioSelector(selectWidgets);
  const pages = useStudioSelector(selectPages);
  const dashboard = useStudioSelector(selectDashboard);

  const activePage = pages[dashboard.activePageId];
  const activeWidgetIds = React.useMemo(
    () => (activePage?.widgetRows ?? []).flat(),
    [activePage],
  );

  // ── Confirmation dialog state ──────────────────────────────────────────────
  const [pendingConfirm, setPendingConfirm] = React.useState<PendingConfirmation | null>(null);

  const onRemoveWidgetRequest = React.useCallback(
    (widgetId: string, widgetTitle: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setPendingConfirm({ widgetId, widgetTitle, resolve });
      }),
    [],
  );

  // ── Adapter (recreated when aiConfig or controller changes) ───────────────
  const adapter = React.useMemo<ChatAdapter | null>(() => {
    if (!aiConfig?.endpoint) {
      return null;
    }
    return createStudioChatAdapter(aiConfig, controller, onRemoveWidgetRequest);
  }, [aiConfig, controller, onRemoveWidgetRequest]);

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

  const hasWidgets = activeWidgetIds.length > 0;

  const chatBox = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Empty-state header (shown only when no widgets) */}
      {!hasWidgets && (
        <Box
          sx={{
            px: 3,
            pt: 3,
            pb: 1,
            flexShrink: 0,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Typography variant="h6" gutterBottom>
            What would you like to build?
          </Typography>
          {Object.values(dataSources).length > 0 && (
            <Typography variant="body2" color="text.secondary">
              Available data:{' '}
              {Object.values(dataSources)
                .map((s) => s.label)
                .join(', ')}
            </Typography>
          )}
        </Box>
      )}

      {/* Chat box */}
      <Box sx={{ flexGrow: 1, minHeight: 0 }}>
        <ChatBox
          adapter={adapter}
          suggestions={suggestions}
          suggestionsAutoSubmit
          currentUser={{ id: 'user', displayName: 'You', role: 'user' }}
          sx={{ height: '100%' }}
        />
      </Box>

      {/* Confirmation dialog for remove_widget */}
      {pendingConfirm && (
        <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
          <ChatConfirmation
            message={`Remove "${pendingConfirm.widgetTitle}"? This cannot be undone from chat.`}
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

  // Overlay mode: fixed-position slide-in panel with a close button
  return (
    <Slide direction="left" in={open} mountOnEnter unmountOnExit>
      <Box
        sx={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          bgcolor: 'background.paper',
          borderLeft: 1,
          borderColor: 'divider',
          boxShadow: 8,
          zIndex: (theme) => theme.zIndex.drawer + 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
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
    </Slide>
  );
}
