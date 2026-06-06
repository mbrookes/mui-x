import type { StudioController } from '../store/StudioController';

/**
 * A skill that can be registered with the x-studio AI assistant via
 * `StudioAIConfig.skills`. Each skill injects a prompt fragment into the
 * system prompt so the model knows about the capability, and optionally
 * registers a callable tool for `'client-handler'` skills.
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
 * @example Client-handler skill (adds a callable tool):
 * ```ts
 * const exportSkill: StudioAISkill = {
 *   name: 'exportCsv',
 *   mode: 'client-handler',
 *   promptFragment: `Trigger: "export to CSV"...`,
 *   tool: {
 *     name: 'exportCsv',
 *     description: 'Exports the active widget data as CSV.',
 *     parameters: { type: 'object', properties: {}, required: [] },
 *     execute: async (_args, controller) => { ... },
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
   * - `'client-handler'` — injects a prompt fragment AND registers a callable tool
   *   the model can invoke (requires `tool` to be set).
   */
  mode: 'client-handler' | 'instruction-only';
  /**
   * Prompt fragment injected into the system prompt when this skill is enabled.
   * Describe the trigger conditions, output format, and constraints.
   * Keep it concise — this text is sent on every request.
   */
  promptFragment: string;
  /**
   * Required for `'client-handler'` skills. Defines the tool the model can call
   * and the client-side `execute` function that handles the call.
   */
  tool?: {
    /** Tool name registered with the model. Must match the name in `promptFragment`. */
    name: string;
    /** Description shown to the model in the tool definition. */
    description: string;
    /** JSON Schema object describing the tool's input parameters. */
    parameters: object;
    /**
     * Called when the model invokes this tool.
     * Return a result string to send back to the model, or `void`/`undefined`
     * for a generic success response.
     */
    execute: (
      args: unknown,
      controller: StudioController,
    ) => Promise<string | void> | string | void;
    /**
     * When `true`, this tool is read-only and side-effect-free — it can be executed
     * concurrently with other `parallel: true` tools in the same model response.
     * Defaults to `false` (sequential execution).
     */
    parallel?: boolean;
  };
}
