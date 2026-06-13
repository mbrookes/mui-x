/**
 * MCP (Model Context Protocol) route for x-studio-dev-server.
 *
 * Mounts a stateful Streamable-HTTP MCP server at the path this router is registered on
 * (typically POST/GET/DELETE /api/mcp).  Each MCP session gets its own McpServer instance
 * backed by an isolated StudioState, so multiple clients can run concurrent sessions.
 *
 * ## Data access
 * When `db` and `crmDb` are supplied (as they are in the default dev-server setup), each
 * session's `buildStudioMcpServer` call receives a `data.queryDataSource` callback that
 * routes queries through `handleBatchQuery` — the same security pipeline used by
 * POST /api/sales-data and POST /api/crm-data.
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
 * 2. Server extracts JWT claims (or falls back to DEV_CLAIMS in dev mode), then creates
 *    a fresh `StudioState` and a new `McpServer` with all x-studio tools registered.
 * 3. Client calls dashboard-mutation tools (`add_widget`, `update_widget`, etc.) or
 *    `query_data_source` to retrieve rows from the underlying databases.
 * 4. Client reads `studio://dashboard/state` to inspect the full dashboard JSON,
 *    or `studio://dashboard/system-prompt` to get the AI context string.
 * 5. On disconnect / `DELETE /api/mcp`, the session and its state are cleaned up.
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { handleBatchQuery } from '@mui/x-studio-data-middleware';
import type { BatchWidgetDescriptor } from '@mui/x-studio-data-middleware';
import {
  buildStudioMcpServer,
  createDefaultStudioState,
  type StudioStateBox,
  type StudioDataQueryParams,
} from '@mui/x-studio-ai-middleware';
import type { Config } from '../config.js';
import { resolveClaims, DEV_CLAIMS } from '../middleware/claims.js';

const SALES_SCHEMA_ALLOWLIST = [
  'customers',
  'products',
  'orders',
  'order_items',
  'shipments',
  'shipment_items',
];

const CRM_SCHEMA_ALLOWLIST = ['contacts', 'deals', 'activities'];

// ── Session maps ──────────────────────────────────────────────────────────────
// Keyed by the MCP session ID issued on initialization.
// Entries are removed when the transport closes (client disconnect or DELETE).

const transports: Record<string, StreamableHTTPServerTransport> = {};
const stateBoxes: Record<string, StudioStateBox> = {};

// ── Route factory ─────────────────────────────────────────────────────────────

export function makeMcpRouter(salesDb: Knex, crmDb: Knex, config: Config): Router {
  const router = Router();

  /**
   * Build a `queryDataSource` callback for a session.
   * Routes queries to the correct Knex instance based on the source's table name.
   */
  function makeQueryDataSource(claims: ReturnType<typeof resolveClaims>) {
    return async (params: StudioDataQueryParams) => {
      // Determine which database owns this table.
      const isCrm = CRM_SCHEMA_ALLOWLIST.includes(params.tableName);
      const targetDb = isCrm ? crmDb : salesDb;
      const schemaAllowlist = isCrm ? CRM_SCHEMA_ALLOWLIST : SALES_SCHEMA_ALLOWLIST;

      const descriptor: BatchWidgetDescriptor = {
        id: 'mcp-query',
        table: params.tableName,
        ...(params.columns && { columns: params.columns }),
        ...(params.filters && {
          filters: params.filters.map((f) => ({
            column: f.field,
            operator: f.operator,
            // Cast through unknown — StudioDataFilter.value is unknown whereas
            // FilterPredicate.value has a stricter type; the DB middleware validates at runtime.
            value: f.value as unknown,
          })) as BatchWidgetDescriptor['filters'],
        }),
        ...(params.aggregations && {
          aggregations: params.aggregations as BatchWidgetDescriptor['aggregations'],
        }),
        ...(params.orderBy && { orderBy: params.orderBy as BatchWidgetDescriptor['orderBy'] }),
        ...(params.limit !== undefined && { limit: params.limit }),
      };

      const response = await handleBatchQuery({ pageId: 'mcp', widgets: [descriptor] }, claims, {
        db: targetDb,
        schemaAllowlist,
      });

      const result = response.results[0];
      if (result.error) {
        throw new Error(result.error);
      }

      return {
        rows: result.rows,
        rowCount: result.rowCount,
        tier: result.tier,
      };
    };
  }

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
      // Resolve claims once at session init; reused for all data queries in this session.
      let claims;
      try {
        claims = resolveClaims(req, config);
      } catch {
        // In dev mode we'll have already returned DEV_CLAIMS; this branch means
        // a static token is configured but no valid token was supplied.
        claims = DEV_CLAIMS;
      }

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
        data: {
          queryDataSource: makeQueryDataSource(claims),
        },
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
        message:
          'Bad Request: include Mcp-Session-Id for existing sessions, or send an initialize request for new ones.',
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
