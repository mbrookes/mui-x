/**
 * @mui/x-studio-backend
 *
 * Server-side AI handler for MUI X Studio.
 *
 * Provides a pure-function `handleAIChat` that builds the system prompt,
 * runs the agentic tool loop, and streams state mutations back to the client.
 *
 * @example
 * ```ts
 * import { handleAIChat } from '@mui/x-studio-backend';
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
export type {
  StudioAIRequest,
  SerializableSkill,
  StudioAISSEEvent,
  StateMutation,
} from './models/protocol';

// Re-exported for consumers who want to build custom loops
export { runAgenticLoop } from './agenticLoop';
export type { AgenticLoopOptions } from './agenticLoop';
export { executeToolOnState } from './executeToolOnState';
export type { ToolExecutionResult } from './executeToolOnState';
