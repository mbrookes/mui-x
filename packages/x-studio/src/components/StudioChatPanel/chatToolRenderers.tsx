'use client';

import * as React from 'react';
import type { ChatPartRendererMap, ToolPartOwnerState } from '@mui/x-chat/headless';
import { createToolPartRenderer } from '@mui/x-chat/headless';
// Tool icons — each Studio AI tool gets a recognisable MUI icon in the tool call cards
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import BarChartIcon from '@mui/icons-material/BarChart';
import DashboardIcon from '@mui/icons-material/Dashboard';
import DeleteIcon from '@mui/icons-material/Delete';
import EditNoteIcon from '@mui/icons-material/EditNote';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LayersIcon from '@mui/icons-material/Layers';
import NoteAltIcon from '@mui/icons-material/NoteAlt';
import StorageIcon from '@mui/icons-material/Storage';
import TitleIcon from '@mui/icons-material/Title';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { StudioLocaleText } from '../../internals/localeText';
import { lookup } from '../../utils/safeLookup';
import type { StudioAIToolName } from './studioAITools';

// ── Per-tool icon map ─────────────────────────────────────────────────────────
// Maps each Studio AI tool name to an MUI icon component for the tool call cards.
// createToolPartRenderer() takes ToolPartExternalProps (including toolSlots) and
// returns a ChatPartRenderer that wraps the default ToolPart.
//
// Keyed by `StudioAIToolName` — NOT `string` — so adding a tool to the registry is a
// compile error here instead of a silent runtime fallback that renders the raw
// snake_case name (`set_widget_forecast`) as the card's title. The parity test only
// catches that after the fact, and only if someone runs it.

export const STUDIO_TOOL_ICONS: Record<StudioAIToolName, React.ComponentType> = {
  // Dashboard-level tools
  get_dashboard_state: InfoOutlinedIcon,
  list_pages: FormatListBulletedIcon,
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
};

// Maps each Studio AI tool name to the `StudioLocaleText` key holding its localized
// tool-card title, so the labels flow through the package's `localeText` system.
// Exhaustively keyed by `StudioAIToolName` for the same reason as the icon map above.
export const STUDIO_TOOL_LABEL_KEYS: Record<StudioAIToolName, keyof StudioLocaleText> = {
  // Dashboard-level tools
  get_dashboard_state: 'chatToolLabelGetDashboardState',
  list_pages: 'chatToolLabelListPages',
  set_dashboard_title: 'chatToolLabelSetDashboardTitle',
  // Page tools
  add_page: 'chatToolLabelAddPage',
  rename_page: 'chatToolLabelRenamePage',
  remove_page: 'chatToolLabelRemovePage',
  set_active_page: 'chatToolLabelSetActivePage',
  // Widget tools
  add_widget: 'chatToolLabelAddWidget',
  update_widget: 'chatToolLabelUpdateWidget',
  remove_widget: 'chatToolLabelRemoveWidget',
  set_widget_layout: 'chatToolLabelSetWidgetLayout',
  set_widget_width: 'chatToolLabelSetWidgetWidth',
  set_widget_forecast: 'chatToolLabelSetWidgetForecast',
  // Filter tools
  add_page_filter: 'chatToolLabelAddPageFilter',
  remove_page_filter: 'chatToolLabelRemovePageFilter',
  add_widget_filter: 'chatToolLabelAddWidgetFilter',
  remove_widget_filter: 'chatToolLabelRemoveWidgetFilter',
  // Insight / utility tools
  summarise_page: 'chatToolLabelSummarisePage',
  apply_bulk_update: 'chatToolLabelApplyBulkUpdate',
  rename_thread: 'chatToolLabelRenameThread',
  query_data_source: 'chatToolLabelQueryDataSource',
};

/**
 * Tool-card title: resolves the localized label for the tool the model called,
 * falling back to whatever the default renderer would have shown.
 *
 * Exported for testing — the prototype-chain guard below is invisible from the maps
 * alone (both are plain object literals, so `Object.hasOwn(map, 'constructor')` is
 * `false` no matter how the component indexes them); only rendering this component
 * can tell a `lookup()` from a bare bracket index.
 */
export function StudioToolTitle({
  ownerState,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { ownerState?: ToolPartOwnerState }) {
  const localeText = useStudioLocaleText();
  // `ownerState.toolName` is whatever name the model emitted — fully LLM-controlled — so the
  // record is indexed through the prototype-chain-safe `lookup`. A bare bracket lookup on
  // "constructor"/"toString"/… resolves an inherited `Object.prototype` function, which is
  // `!== undefined`, so `localeText[localeKey]` is `undefined` at best and the raw function
  // reaches JSX at worst ("Functions are not valid as a React child", blank card title).
  const localeKey = lookup<string, keyof StudioLocaleText>(
    STUDIO_TOOL_LABEL_KEYS,
    ownerState?.toolName,
  );
  const label = localeKey !== undefined ? (localeText[localeKey] as string) : children;
  return <div {...props}>{label}</div>;
}

// ── Approval impact summary ───────────────────────────────────────────────────
//
// The server attaches an `effects` summary to a `tool-approval-request` — which
// widgets/pages/filters the call will delete, which widgets it will orphan, how many
// it will update, each entity resolved to its CURRENT title from the pre-mutation
// state — precisely so a human can approve with the real impact in view instead of an
// opaque id matrix. `x-chat-headless` carries it to `toolInvocation.approvalRequest`
// but cannot render it: the shape is Studio's, not the chat package's. This is the
// `approvalDetails` slot that closes that path.
//
// EVERY value here is narrowed again before it reaches JSX, even though
// `studioBackendAdapter`'s `sanitizeApprovalEffects` already dropped non-strings on
// the way in. `ownerState.approvalRequest.effects` is typed `unknown` for exactly this
// reason — it came off the network — and this component is the only place in the
// package that renders it. React escapes string children, so a title can never inject
// markup; the narrowing is what keeps a non-string (an object, a function) from
// reaching a React child position at all, which is a crash rather than an injection.

/** Studio's `ApprovalEffectsSummary` entity entries, as they arrive over the wire. */
interface ApprovalEntity {
  id: string;
  title: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `[{ id, title }]` entries whose `id` AND `title` are both really strings, or `[]`. */
function narrowEntities(value: unknown): ApprovalEntity[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    isPlainRecord(entry) && typeof entry.id === 'string' && typeof entry.title === 'string'
      ? [{ id: entry.id, title: entry.title }]
      : [],
  );
}

/** Bare string ids (filters have no user-facing title), or `[]`. */
function narrowIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Renders the structural impact of the tool call awaiting approval.
 *
 * Mounted by `ToolPart`'s optional `approvalDetails` slot, so it appears above the
 * approve/deny buttons only while `state === 'approval-requested'` and only when the
 * server actually sent an `effects` payload. Returns `null` when nothing survived
 * narrowing, so a malformed payload degrades to the pre-existing prompt rather than an
 * empty box — EXCEPT when the adapter marked the summary as withheld
 * (`effectsWithheld`), which is the one case where "no list" is itself the message.
 *
 * Exported for testing: the narrowing above is invisible from the types alone (the
 * field is `unknown`), so only rendering this component can tell a real guard from a
 * cast.
 */
export function StudioApprovalEffects({
  ownerState,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { ownerState?: ToolPartOwnerState }) {
  const localeText = useStudioLocaleText();
  const effects = ownerState?.approvalRequest?.effects;
  if (!isPlainRecord(effects)) {
    return null;
  }

  const groups: Array<{ key: string; label: string; items: string[] }> = [
    {
      key: 'willRemoveWidgets',
      label: localeText.chatApprovalWillRemoveWidgets,
      items: narrowEntities(effects.willRemoveWidgets).map((entity) => entity.title),
    },
    {
      key: 'willRemovePages',
      label: localeText.chatApprovalWillRemovePages,
      items: narrowEntities(effects.willRemovePages).map((entity) => entity.title),
    },
    {
      key: 'willOrphanWidgets',
      label: localeText.chatApprovalWillOrphanWidgets,
      items: narrowEntities(effects.willOrphanWidgets).map((entity) => entity.title),
    },
    {
      key: 'willRemoveFilters',
      label: localeText.chatApprovalWillRemoveFilters,
      items: narrowIds(effects.willRemoveFilters),
    },
  ].filter((group) => group.items.length > 0);

  const updatedCount =
    typeof effects.updatedWidgetCount === 'number' && Number.isFinite(effects.updatedWidgetCount)
      ? effects.updatedWidgetCount
      : undefined;

  // The adapter withheld a summary the server DID send (over this client's size limits, or
  // past the turn's budget for them). Without this line the card is byte-identical to one for
  // a call with no impact at all — and those two deserve opposite answers, so an empty box is
  // exactly what must NOT be rendered here.
  const withheld = effects.effectsWithheld === true;

  if (groups.length === 0 && updatedCount === undefined && !withheld) {
    return null;
  }

  return (
    <div {...props}>
      {withheld ? <div>{localeText.chatApprovalEffectsWithheld}</div> : null}
      {groups.map((group) => (
        <div key={group.key}>
          <strong>{group.label}</strong>
          <ul>
            {group.items.map((item, index) => (
              // Entity ids are unique per group, but `willRemoveFilters` carries bare
              // ids and a malformed payload could repeat one — index-suffixed so a
              // duplicate cannot collapse two list rows into one.
              <li key={`${group.key}-${index}`}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
      {updatedCount !== undefined ? (
        <div>{`${localeText.chatApprovalUpdatedWidgetCount}: ${updatedCount}`}</div>
      ) : null}
    </div>
  );
}

export const studioDynamicToolRenderer = createToolPartRenderer({
  slots: { title: StudioToolTitle, approvalDetails: StudioApprovalEffects },
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
