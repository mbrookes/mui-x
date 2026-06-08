/**
 * AI interaction types for x-studio-ai-middleware.
 *
 * `SerializableSkill`, `StateMutation`, and `StudioAIToolName` are protocol
 * types also exported by `@mui/x-studio` (the client UI package). They are
 * defined here locally so this package has no dependency on x-studio.
 * TypeScript structural typing ensures values from @mui/x-studio remain
 * assignable to these types at the app boundary.
 */
import type {
  StudioState,
  StudioFilterState,
  StudioWidget,
} from './studioTypes';

// ── Protocol types (mirrored in @mui/x-studio for UI consumers) ──────────────

/**
 * Serializable skill metadata forwarded to the server in every AI request.
 * The `execute` function (if present) is stripped before sending — only these
 * fields are sent over the wire. Mirrors `SerializableSkill` in @mui/x-studio.
 */
export interface SerializableSkill {
  name: string;
  mode: 'instruction-only' | 'server-tool';
  promptFragment: string;
  tool?: {
    name: string;
    description: string;
    parameters: object;
  };
}

/**
 * A state mutation produced server-side and streamed to the client as an SSE event.
 * Mirrors `StateMutation` in @mui/x-studio.
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
    };

/**
 * Names of the built-in AI tools. Mirrors `StudioAIToolName` in @mui/x-studio.
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
  | 'apply_bulk_update';

// ── Server-side skill ─────────────────────────────────────────────────────────

/**
 * A skill that can be registered with the x-studio AI assistant.
 * Extends `SerializableSkill` by adding the server-side `execute` function.
 * Instances are assignable to `SerializableSkill` (used in `StudioAIConfig.skills`).
 */
export interface StudioAISkill extends SerializableSkill {
  mode: 'server-tool' | 'instruction-only';
  tool?: {
    name: string;
    description: string;
    parameters: object;
    execute: (
      args: Record<string, unknown>,
      state: StudioState,
    ) => {
      output: string;
      mutation?: StateMutation;
      nextState: StudioState;
    };
  };
}

