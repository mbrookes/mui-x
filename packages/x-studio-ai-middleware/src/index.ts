/**
 * @mui/x-studio-ai-middleware
 *
 * Server-side AI handler for MUI X Studio.
 *
 * Contains the system prompt builder, tool definitions, built-in skills, and the
 * agentic loop that streams state mutations back to the client.
 *
 * @example
 * ```ts
 * import { handleAIChat } from '@mui/x-studio-ai-middleware';
 *
 * // Next.js App Router
 * export async function POST(req: Request) {
 *   const body = await req.json();
 *   const stream = handleAIChat(body, {
 *     endpoint: 'https://api.openai.com/v1/chat/completions',
 *     apiKey: process.env.OPENAI_API_KEY,
 *   });
 *   return new Response(stream, {
 *     headers: { 'Content-Type': 'text/event-stream' },
 *   });
 * }
 * ```
 */

export { handleAIChat } from './handleAIChat';
export type {
  StudioAIHandlerOptions,
  StudioAIContextEnricher,
  StudioAIContextEnricherArgs,
} from './handleAIChat';
export { handleGenerateTitle, handleCreateWidget } from './handleGenerateInsight';
export type {
  GenerateInsightOptions,
  CreateWidgetRequest,
  CreateWidgetResponse,
} from './handleGenerateInsight';
export type { StudioAIRequest, StudioAISSEEvent, ApprovalEffectsSummary } from './models/protocol';
// StudioAISkill is defined here (server-side skill with execute function).
// SerializableSkill, StateMutation, StudioAIToolName are protocol types defined
// locally (mirrored in @mui/x-studio for UI consumers).
export type {
  StudioAISkill,
  SkillExecuteResult,
  SerializableSkill,
  StateMutation,
  MutationEnvelope,
  StudioAIToolName,
  StudioAIDataConfig,
  StudioAIRateLimit,
  StudioAIUsage,
  StudioAIRichContext,
  StudioAIFieldStat,
  StudioAILayoutWidget,
  StudioAICrossFilterEdge,
  StudioAIPageLayout,
  StudioAIRecentMutation,
  StudioAIEnrichedContext,
} from './models/aiTypes';

// Prompt builder and tool definitions — consumed by the server
export { buildAISystemPrompt, serializeFieldForAI, sanitizeForPrompt } from './buildAISystemPrompt';
export type { BuildAISystemPromptOptions } from './buildAISystemPrompt';
export { buildPageLayoutContext } from './buildPageLayoutContext';
export { STUDIO_AI_TOOLS, WIDGET_CONFIG_DESCRIPTION } from './studioAITools';

// Built-in skills
export { dashboardNarratorSkill, insightSuggestorSkill } from './studioSkills';

// Field description generation
export { generateFieldDescriptions } from './generateFieldDescriptions';
export type { FieldDescriptionInput, FieldDescriptionResult } from './generateFieldDescriptions';

// SVG chart renderer — server-side chart generation for MCP and other server contexts
export { renderChartSvg } from './chartRenderer';
export type { ChartRendererInput, ChartDataPoint, ChartSeries, ChartType } from './chartRenderer';

// Widget factory — pure TS, no React; used by executeToolOnState and re-exported for widgetUtils
export { createDefaultWidget } from './widgetFactory';

// Re-exported for consumers who want to build custom loops
export { runAgenticLoop } from './agenticLoop';
export type { AgenticLoopOptions } from './agenticLoop';
// The `approvalPending` map's value type — a resolver bound to the AI chat thread
// (when known) it was raised under. See `StudioAIHandlerOptions.approvalPending`.
export type { PendingApproval } from './agenticLoop/toolDispatch';
// The thread-binding check a host's approval-resolution route should reuse rather
// than hand-roll (finding 5, Tier 3) — see its doc comment for the bypassable
// shape it replaces.
export { isApprovalThreadIdAuthorized } from './agenticLoop/toolDispatch';
export { executeToolOnState } from './executeToolOnState';
export type { ToolExecutionResult } from './executeToolOnState';

// Tool policy — the authorization chokepoint shared by both transports
export {
  computeToolEffects,
  createDefaultToolPolicy,
  createEffectsAwareToolPolicy,
  executeToolWithPolicy,
  // `Policy` (composable decision combinators) and `consultToolPolicyArgsOnly`
  // (the args-only authorization consult custom loops use to gate a tool BEFORE it
  // runs) are documented as the way hosts compose policies and gate custom loops;
  // export them from the root so consumers need no forbidden deep import.
  Policy,
  consultToolPolicyArgsOnly,
} from './toolPolicy';
export type {
  ToolEffectSummary,
  ToolPolicy,
  ToolPolicyContext,
  ToolPolicyDecision,
  ExecuteToolWithPolicyResult,
  ConsultToolPolicyArgsOnlyResult,
} from './toolPolicy';

// MCP (Model Context Protocol) server factory
// Requires @modelcontextprotocol/sdk to be installed in the consuming project.
export { buildStudioMcpServer } from './mcp';
export type {
  StudioMcpOptions,
  StudioState,
  StudioStateBox,
  StudioDataFilter,
  StudioDataAggregation,
  StudioDataOrderBy,
  StudioDataQueryParams,
  StudioDataQueryResult,
} from './mcp';
export { createDefaultStudioState } from './models/studioTypes';
