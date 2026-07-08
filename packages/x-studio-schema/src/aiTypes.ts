/**
 * Composition façade over the split-out AI-protocol type modules for MUI X
 * Studio.
 *
 * This file used to hold every AI-protocol and conversation type in one
 * ~340-line module. It is now a thin re-export layer over:
 *
 * - `./mutationTypes` — the mutation/skill protocol types (`SerializableSkill`,
 *   `OptionalWidgetField`, `StateMutation`, `MutationEnvelope`)
 * - `./richContextTypes` — the rich-context types attached to AI chat requests
 *   (`StudioAIFieldStat`, `StudioAILayoutWidget`, `StudioAICrossFilterEdge`,
 *   `StudioAIPageLayout`, `StudioAIRecentMutation`, `StudioAIRichContext`)
 * - `./chatTypes` — persisted conversation-thread state (`StudioAIChatThread`,
 *   `StudioAIState`)
 * - `./aiToolRegistry` — `StudioAIToolName` (re-exported here, not moved,
 *   since it's a one-line pass-through)
 *
 * Every name below is unique across the three modules, so this facade is a
 * safe blanket `export *`; existing deep imports of `./aiTypes` (and the
 * `@mui/x-studio-schema` package export) keep resolving unchanged.
 *
 * Server-only AI types (`StudioAISkill` with its `execute` function,
 * `SkillExecuteResult`, `StudioAIDataConfig`, rate-limit/usage types) live in
 * `@mui/x-studio-ai-middleware` — they are not part of the shared schema.
 */
export * from './mutationTypes';
export * from './richContextTypes';
export * from './chatTypes';

/**
 * Names of the built-in AI tools.
 * Use `allowedTools` in `StudioAIConfig` to restrict which tools are available.
 *
 * Derived from `STUDIO_AI_TOOL_REGISTRY` (`aiToolRegistry.ts`) — the single
 * source of truth for tool facts (title, destructive/idempotent/etc.
 * classification). `STUDIO_AI_TOOLS` in `@mui/x-studio-ai-middleware`
 * (`studioAITools.ts`) is type-checked against this same union, so the two
 * can no longer drift.
 */
export type { StudioAIToolName } from './aiToolRegistry';
