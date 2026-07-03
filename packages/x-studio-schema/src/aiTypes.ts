/**
 * Shared AI-protocol and conversation types for MUI X Studio.
 *
 * These are the types both the client (`@mui/x-studio`) and the server
 * (`@mui/x-studio-ai-middleware`) need to agree on:
 *  - Accept skill configuration from app developers (`SerializableSkill`)
 *  - Produce/apply state mutations streamed over SSE (`StateMutation`)
 *  - Type-check `allowedTools` (`StudioAIToolName`)
 *  - Attach rich client-derived context to requests (`StudioAIRichContext` & co.)
 *  - Persist and restore AI conversation threads (`StudioAIState`)
 *
 * Server-only AI types (`StudioAISkill` with its `execute` function,
 * `SkillExecuteResult`, `StudioDataResolver`, rate-limit/usage types) live in
 * `@mui/x-studio-ai-middleware` — they are not part of the shared schema.
 */
import type { ChatMessage } from '@mui/x-chat-headless';
import type { StudioFilterState } from './stateTypes';
import type { StudioWidget } from './widgetTypes';

/**
 * Serializable skill metadata forwarded to the server in every AI request.
 * The `execute` function (if any) is stripped before sending — only these
 * fields are sent over the wire.
 *
 * `StudioAISkill` (from `@mui/x-studio-ai-middleware`) extends this interface
 * by adding the server-side `execute` function. App developers can pass
 * `StudioAISkill` objects directly to `StudioAIConfig.skills` since it
 * structurally satisfies this interface.
 */
export interface SerializableSkill {
  name: string;
  mode: 'instruction-only' | 'server-tool' | 'client-handler';
  promptFragment: string;
  tool?: {
    name: string;
    description: string;
    parameters: object;
  };
}

/**
 * A state mutation produced server-side and streamed to the client as an SSE event.
 * Both sides apply it through the shared `applyMutation` reducer.
 */
export type StateMutation =
  | { type: 'addPage'; args: { id: string; title: string } }
  | { type: 'setDashboardTitle'; args: { title: string } }
  | {
      type: 'addWidget';
      args: {
        widget: StudioWidget;
        /**
         * Explicit target page for the new widget, chosen server-side.
         * Both the server-computed `nextState` and the client apply the widget
         * to this page, so switching pages while the model is thinking cannot
         * make the widget land on a different page than the model was told.
         * Falls back to the active page when omitted (legacy payloads).
         */
        pageId?: string;
      };
    }
  | {
      type: 'updateWidget';
      args: {
        widgetId: string;
        changes?: Partial<Omit<StudioWidget, 'id'>>;
        config?: StudioWidget['config'];
      };
    }
  | { type: 'removeWidget'; args: { widgetId: string } }
  | { type: 'setWidgetLayout'; args: { rows: string[][] } }
  | {
      type: 'setWidgetColSpan';
      args: { widgetId: string; columns: number | null; rowWidgetIds: string[] };
    }
  | { type: 'renamePage'; args: { pageId: string; title: string } }
  | { type: 'removePage'; args: { pageId: string } }
  | { type: 'setActivePage'; args: { pageId: string } }
  | { type: 'addFilter'; args: { filter: StudioFilterState } }
  | { type: 'removeFilter'; args: { filterId: string } }
  | {
      type: 'applyBulkUpdate';
      args: {
        widgets: Record<string, StudioWidget>;
        widgetRows: string[][];
        widgetColSpans: Record<string, number>;
        activePageId: string;
      };
    }
  | {
      type: 'renameAIThread';
      args: {
        name: string;
        /**
         * ISO 8601 timestamp stamped once by the producer (server-side), so the
         * server-computed `nextState` and the client-applied result agree. The
         * reducer must never call `Date.now()`/`new Date()` itself — that would
         * make this otherwise-pure reducer non-deterministic. Required: the sole
         * producer (`executeToolOnState`'s `rename_thread` handler) always supplies it.
         */
        updatedAt: string;
      };
    };

// ── Rich AI context ─────────────────────────────────────────────────────────
// Extra, purely-additive context attached to each chat request to give the model
// more signal without any user effort. Shared by both packages.

/**
 * Summary statistics for a single data-source field, computed client-side from
 * pipeline-filtered rows. Numeric fields carry `min`/`max`/`mean`; all other
 * field types carry a `distinctCount`.
 */
export interface StudioAIFieldStat {
  /** Field data type, copied from `StudioDataField['type']`. */
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  /** Minimum value (numeric fields only). */
  min?: number;
  /** Maximum value (numeric fields only). */
  max?: number;
  /** Arithmetic mean, rounded (numeric fields only). */
  mean?: number;
  /** Number of distinct values (non-numeric fields). */
  distinctCount?: number;
  /** Number of rows the statistics were computed from. */
  sampledRows: number;
}

/** A single widget entry in the active-page layout snapshot. */
export interface StudioAILayoutWidget {
  widgetId: string;
  kind: string;
  title: string;
  chartType?: string;
  colSpan?: number;
}

/** An edge in the cross-filter graph: a widget whose selection filters the page. */
export interface StudioAICrossFilterEdge {
  sourceWidgetId: string;
  field: string;
  scope: 'cross-filter' | 'interactive';
}

/** Active-page widget layout plus its cross-filter graph. */
export interface StudioAIPageLayout {
  pageId: string;
  /** Widget rows, mirroring `StudioPage.widgetRows` but enriched per widget. */
  rows: StudioAILayoutWidget[][];
  /** Cross-filter / interactive-filter edges currently active on the page. */
  crossFilters: StudioAICrossFilterEdge[];
}

/** A compact record of one user-driven state mutation. */
export interface StudioAIRecentMutation {
  /** Short label, e.g. `"addFilter:revenue"` or `"updateWidgetConfig:chart-3"`. */
  label: string;
  /** ISO 8601 timestamp of when the mutation was committed. */
  at: string;
}

/**
 * Extra client-derived context attached to each AI chat request to give the
 * model more signal without any user effort. Every section is optional: the
 * client drops lower-priority sections (recent mutations first, then layout)
 * to stay under a token budget, recording dropped section names in `omitted`.
 *
 * Never sent in `privateMode` — field statistics expose real data values.
 */
export interface StudioAIRichContext {
  /** Per-field summary statistics, keyed by `${sourceId}.${fieldId}`. */
  fieldStats?: Record<string, StudioAIFieldStat>;
  /** Active page widget layout and cross-filter graph. */
  pageLayout?: StudioAIPageLayout;
  /** Most recent user-driven mutations, oldest first. */
  recentMutations?: StudioAIRecentMutation[];
  /** Names of sections dropped to fit the token budget (for prompt honesty). */
  omitted?: string[];
}

/**
 * Names of the built-in AI tools.
 * Use `allowedTools` in `StudioAIConfig` to restrict which tools are available.
 *
 * Kept in sync with `STUDIO_AI_TOOLS` in `@mui/x-studio-ai-middleware`
 * (`studioAITools.ts`) — a type-level guard in that package fails CI if the two
 * ever drift. Deriving this union directly from `STUDIO_AI_TOOLS` is a good
 * follow-up (would require `as const` on the tool array).
 */
export type StudioAIToolName =
  | 'get_dashboard_state'
  | 'list_pages'
  | 'add_page'
  | 'set_dashboard_title'
  | 'add_widget'
  | 'update_widget'
  | 'remove_widget'
  | 'set_widget_layout'
  | 'set_widget_width'
  | 'rename_page'
  | 'remove_page'
  | 'set_active_page'
  | 'add_page_filter'
  | 'remove_page_filter'
  | 'add_widget_filter'
  | 'remove_widget_filter'
  | 'summarise_page'
  | 'apply_bulk_update'
  | 'rename_thread'
  | 'execute_query'
  | 'set_widget_forecast';

// ── Conversation state ────────────────────────────────────────────────────────

/**
 * A single named conversation thread between the user and the AI assistant.
 * Threads are serialized inside `StudioState.ai` so conversation history
 * can be persisted alongside the dashboard state.
 */
export interface StudioAIChatThread {
  /** Unique thread identifier. */
  id: string;
  /** Display name shown in the thread selector. Auto-generated or user-renamed. */
  name: string;
  /** ISO 8601 timestamp when the thread was created. */
  createdAt: string;
  /** ISO 8601 timestamp of the most recent message. Updated on every send. */
  updatedAt?: string;
  /** Full message history for this thread. */
  messages: ChatMessage[];
}

/**
 * AI assistant state stored inside `StudioState`.
 *
 * Persisted via `serializeState`/`deserializeState` so conversation history
 * travels with the dashboard — enabling pre-loaded demos, cross-session memory,
 * and shareable dashboards with embedded AI context.
 */
export interface StudioAIState {
  /** All conversation threads. Ordered by `updatedAt` descending in the UI. */
  threads: StudioAIChatThread[];
  /** ID of the currently active thread. `undefined` means no thread is selected. */
  activeThreadId?: string;
}
