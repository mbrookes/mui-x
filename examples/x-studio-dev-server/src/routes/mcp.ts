/**
 * MCP (Model Context Protocol) route for x-studio-dev-server.
 *
 * Mounts a stateful Streamable-HTTP MCP server at the path this router is registered on
 * (typically POST/GET/DELETE /api/mcp).  Each MCP session gets its own McpServer instance
 * backed by an isolated StudioState, so multiple clients can run concurrent sessions.
 *
 * ## Claude Desktop configuration
 * ```json
 * {
 *   "mcpServers": {
 *     "x-studio": { "url": "http://localhost:3020/api/mcp" }
 *   }
 * }
 * ```
 *
 * ## How state flows
 * 1. Client sends `POST /api/mcp` with an MCP `initialize` request.
 * 2. Server creates a fresh `StudioState` (empty dashboard) and a new `McpServer` with
 *    all x-studio tools registered against that state.
 * 3. Client calls tools (`add_widget`, `update_widget`, etc.).  Each call mutates the
 *    session's `StudioState` via `executeToolOnState` and returns the result + mutation.
 * 4. Client reads `studio://dashboard/state` resource to inspect the full dashboard JSON,
 *    or `studio://dashboard/system-prompt` to get the AI context string.
 * 5. On disconnect / `DELETE /api/mcp`, the session and its state are cleaned up.
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  buildStudioMcpServer,
  createDefaultStudioState,
  type StudioStateBox,
} from '@mui/x-studio-ai-middleware';

// ── Session maps ──────────────────────────────────────────────────────────────
// Keyed by the MCP session ID issued on initialization.
// Entries are removed when the transport closes (client disconnect or DELETE).

const transports: Record<string, StreamableHTTPServerTransport> = {};
const stateBoxes: Record<string, StudioStateBox> = {};

// ── Route factory ─────────────────────────────────────────────────────────────

export function makeMcpRouter(): Router {
  const router = Router();

  // POST — tool calls from the MCP client (and session initialization)
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Existing session: route the request to its transport.
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // New session: client must send an MCP initialize request (no session ID header).
    if (!sessionId && isInitializeRequest(req.body)) {
      const stateBox: StudioStateBox = { current: createDefaultStudioState() };

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          stateBoxes[sid] = stateBox;
        },
      });

      // Clean up session on disconnect.
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          delete transports[sid];
          delete stateBoxes[sid];
        }
      };

      const mcpServer = buildStudioMcpServer(stateBox, {
        serverName: 'x-studio-dev-server',
        serverVersion: '1.0.0',
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Malformed request.
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: include Mcp-Session-Id for existing sessions, or send an initialize request for new ones.',
      },
      id: null,
    });
  });

  // GET — SSE stream for server-initiated notifications.
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Missing or invalid Mcp-Session-Id header.');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // DELETE — session termination.
  router.delete('/', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Missing or invalid Mcp-Session-Id header.');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  return router;
}
