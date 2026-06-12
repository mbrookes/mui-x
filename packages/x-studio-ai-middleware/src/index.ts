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
export type { StudioAIHandlerOptions } from './handleAIChat';
export {
  handleGenerateInsight,
  handleGenerateTitle,
  handleCreateWidget,
} from './handleGenerateInsight';
export type {
  GenerateInsightOptions,
  GenerateInsightRequest,
  CreateWidgetRequest,
  CreateWidgetResponse,
} from './handleGenerateInsight';
export type { StudioAIRequest, StudioAISSEEvent } from './models/protocol';
// StudioAISkill is defined here (server-side skill with execute function).
// SerializableSkill, StateMutation, StudioAIToolName are protocol types defined
// locally (mirrored in @mui/x-studio for UI consumers).
export type {
  StudioAISkill,
  SkillExecuteResult,
  SerializableSkill,
  StateMutation,
  StudioAIToolName,
  StudioDataResolver,
  StudioDataResolverResult,
  StudioAIRateLimit,
  StudioAIUsage,
} from './models/aiTypes';

// Prompt builder and tool definitions — consumed by the server
export { buildAISystemPrompt, serializeFieldForAI } from './buildAISystemPrompt';
export type { BuildAISystemPromptOptions } from './buildAISystemPrompt';
export { STUDIO_AI_TOOLS } from './studioAITools';

// Built-in skills
export { dashboardNarratorSkill, insightSuggestorSkill } from './studioSkills';

// Field description generation
export { generateFieldDescriptions } from './generateFieldDescriptions';
export type {
  FieldDescriptionInput,
  FieldDescriptionResult,
} from './generateFieldDescriptions';

// Widget factory — pure TS, no React; used by executeToolOnState and re-exported for widgetUtils
export { createDefaultWidget } from './widgetFactory';

// Re-exported for consumers who want to build custom loops
export { runAgenticLoop } from './agenticLoop';
export type { AgenticLoopOptions } from './agenticLoop';
export { executeToolOnState } from './executeToolOnState';
export type { ToolExecutionResult } from './executeToolOnState';

// MCP (Model Context Protocol) server factory
// Requires @modelcontextprotocol/sdk to be installed in the consuming project.
export { buildStudioMcpServer } from './mcp';
export type {
  StudioMcpOptions,
  StudioStateBox,
  StudioDataFilter,
  StudioDataAggregation,
  StudioDataOrderBy,
  StudioDataQueryParams,
  StudioDataQueryResult,
} from './mcp';
export { createDefaultStudioState } from './models/studioTypes';
