/**
 * AI protocol types for x-studio.
 *
 * These are the minimal types the x-studio UI needs to:
 *  - Accept skill configuration from app developers (`SerializableSkill`)
 *  - Apply state mutations streamed from the AI backend (`StateMutation`)
 *  - Type-check the `allowedTools` config option (`StudioAIToolName`)
 *  - Persist and restore AI conversation threads (`StudioAIState`)
 *
 * `StudioAISkill` (which adds a server-side `execute` function) and the
 * built-in skill implementations live in `@mui/x-studio-ai-middleware`.
 */
import type { ChatMessage } from '@mui/x-chat/headless';
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
 * The client maps each mutation to the corresponding `StudioController` method.
 */
export type StateMutation =
  | { type: 'addPage'; args: { id: string; title: string } }
  | { type: 'setDashboardTitle'; args: { title: string } }
  | { type: 'addWidget'; args: { widget: StudioWidget } }
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
      args: { name: string };
    };

/**
 * Names of the built-in AI tools.
 * Use `allowedTools` in `StudioAIConfig` to restrict which tools are available.
 */
export type StudioAIToolName =
  | 'get_dashboard_state'
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
  | 'rename_thread';

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
