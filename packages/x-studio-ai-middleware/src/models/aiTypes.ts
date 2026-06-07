import type { StudioState, StudioWidget } from '@mui/x-studio';
import type { StudioFilterState } from '@mui/x-studio';

/**
 * A skill that can be registered with the x-studio AI assistant via
 * `StudioAIConfig.skills`. Each skill injects a prompt fragment into the
 * system prompt so the model knows about the capability, and optionally
 * registers a server-executable tool.
 *
 * @example Instruction-only skill (no new tool):
 * ```ts
 * const narratorSkill: StudioAISkill = {
 *   name: 'dashboardNarrator',
 *   mode: 'instruction-only',
 *   promptFragment: `Trigger: "walk me through this dashboard"...`,
 * };
 * ```
 *
 * @example Server-tool skill (adds a tool the LLM can call; executes server-side):
 * ```ts
 * const exportSkill: StudioAISkill = {
 *   name: 'annotateWidget',
 *   mode: 'server-tool',
 *   promptFragment: `Trigger: "annotate widget"...`,
 *   tool: {
 *     name: 'annotateWidget',
 *     description: 'Adds an annotation to a widget.',
 *     parameters: { type: 'object', properties: { widgetId: { type: 'string' }, note: { type: 'string' } }, required: ['widgetId', 'note'] },
 *     execute: (args, state) => {
 *       // modify state, return mutation
 *       return { output: 'Annotated', nextState: state };
 *     },
 *   },
 * };
 * ```
 */
export interface StudioAISkill {
  /**
   * Unique skill name — used in the `<skill>` XML tag inserted into the system prompt.
   * Must not conflict with built-in tool names.
   */
  name: string;
  /**
   * Controls how the skill is activated:
   * - `'instruction-only'` — injects a prompt fragment with no new callable tool.
   * - `'server-tool'` — injects a prompt fragment AND registers a tool the model can
   *   call; the tool's `execute` function runs on the server with access to `StudioState`.
   */
  mode: 'server-tool' | 'instruction-only';
  /**
   * Prompt fragment injected into the system prompt when this skill is enabled.
   * Describe the trigger conditions, output format, and constraints.
   * Keep it concise — this text is sent on every request.
   */
  promptFragment: string;
  /**
   * Required for `'server-tool'` skills. Defines the tool the model can call and the
   * server-side `execute` function that handles the call.
   */
  tool?: {
    /** Tool name registered with the model. Must match the name in `promptFragment`. */
    name: string;
    /** Description shown to the model in the tool definition. */
    description: string;
    /** JSON Schema object describing the tool's input parameters. */
    parameters: object;
    /**
     * Called on the server when the model invokes this tool.
     * Returns a result string and an optional state mutation.
     */
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

// ── Server/client wire protocol ───────────────────────────────────────────────

/**
 * A named state mutation produced server-side by `executeToolOnState`.
 * Streamed to the client as `state-mutation` SSE events.
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
    };

/**
 * Serializable skill metadata for the wire protocol.
 * The `execute` function is stripped (not JSON-serializable).
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
