'use client';

import * as React from 'react';
import type { ChatPartRendererMap, ToolPartOwnerState } from '@mui/x-chat/headless';
import { createToolPartRenderer } from '@mui/x-chat/headless';
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
import StorageIcon from '@mui/icons-material/Storage';
import TitleIcon from '@mui/icons-material/Title';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';

// ── Per-tool icon map ─────────────────────────────────────────────────────────
// Maps each Studio AI tool name to an MUI icon component for the tool call cards.
// createToolPartRenderer() takes ToolPartExternalProps (including toolSlots) and
// returns a ChatPartRenderer that wraps the default ToolPart.

export const STUDIO_TOOL_ICONS: Record<string, React.ComponentType> = {
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
  query_data_source: StorageIcon,
  // Date / calendar tools
  get_current_date: CalendarTodayIcon,
};

export const STUDIO_TOOL_LABELS: Record<string, string> = {
  // Dashboard-level tools
  get_dashboard_state: 'Get dashboard state',
  set_dashboard_title: 'Set dashboard title',
  // Page tools
  add_page: 'Add page',
  rename_page: 'Rename page',
  remove_page: 'Remove page',
  set_active_page: 'Switch page',
  // Widget tools
  add_widget: 'Add widget',
  update_widget: 'Update widget',
  remove_widget: 'Remove widget',
  set_widget_layout: 'Set widget layout',
  set_widget_width: 'Set widget width',
  set_widget_forecast: 'Set widget forecast',
  // Filter tools
  add_page_filter: 'Add page filter',
  remove_page_filter: 'Remove page filter',
  add_widget_filter: 'Add widget filter',
  remove_widget_filter: 'Remove widget filter',
  // Insight / utility tools
  summarise_page: 'Summarise page',
  apply_bulk_update: 'Apply bulk update',
  rename_thread: 'Rename thread',
  query_data_source: 'Query data source',
  // Date / calendar tools
  get_current_date: 'Get current date',
};

function StudioToolTitle({
  ownerState,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { ownerState?: ToolPartOwnerState }) {
  const label =
    ownerState?.toolName !== undefined
      ? (STUDIO_TOOL_LABELS[ownerState.toolName] ?? children)
      : children;
  return <div {...props}>{label}</div>;
}

export const studioDynamicToolRenderer = createToolPartRenderer({
  slots: { title: StudioToolTitle },
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
export const studioApprovalOnlyRenderer: ChatPartRendererMap['dynamic-tool'] = (props) => {
  if (
    (props.part as { toolInvocation?: { state?: string } }).toolInvocation?.state ===
    'approval-requested'
  ) {
    return studioDynamicToolRenderer(props);
  }
  return null;
};
