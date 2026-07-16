/**
 * Shared helpers for the x-studio MCP server modules.
 *
 * Centralises the two result shapes that were previously hand-duplicated ~14
 * times across the `tools/call` handler, plus the `withTimeout` race helper and
 * the `ToolHandler` dispatch type used by the composition root.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * A single MCP tool handler. Receives the raw tool arguments and returns a
 * `CallToolResult` (synchronously or as a promise). The composition root looks
 * these up in a `Record<string, ToolHandler>` dispatch table keyed by tool name.
 *
 * @param {Record<string, unknown> | undefined} args The raw tool-call arguments.
 * @returns {CallToolResult | Promise<CallToolResult>} The MCP tool result.
 */
export type ToolHandler = (
  args: Record<string, unknown> | undefined,
) => CallToolResult | Promise<CallToolResult>;

/**
 * Build an error tool-result. Mirrors the canonical error contract shared with
 * the chat path: a single text content item wrapping `{ error }` JSON, flagged
 * with `isError: true` so the MCP client renders it as a failed call.
 */
export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Build a success tool-result whose single text content item is the JSON
 * serialization of `data`.
 *
 * @param data     The value to serialize.
 * @param pretty   When `true`, pretty-prints with a 2-space indent (matching the
 *                 handlers that previously called `JSON.stringify(x, null, 2)`).
 */
export function jsonResult(data: unknown, pretty = false): CallToolResult {
  return {
    content: [
      { type: 'text', text: pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data) },
    ],
  };
}

/** Race a promise against a timeout. Rejects with a descriptive error if the timeout fires first. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  // Track the timer so it can be cleared once the race settles. Without this, a
  // fast-settling `promise` leaves the timeout pending — keeping the event loop
  // alive (and, under Node, holding the process open) until it eventually fires.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}
