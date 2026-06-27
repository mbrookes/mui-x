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
 * Claude Desktop's config file only supports stdio transports. Use `mcp-remote` to bridge
 * stdio ↔ Streamable HTTP. Add the following to `~/Library/Application Support/Claude/claude_desktop_config.json`:
 * ```json
 * {
 *   "mcpServers": {
 *     "x-studio": {
 *       "command": "npx",
 *       "args": ["mcp-remote", "http://localhost:3020/api/mcp", "--allow-http"]
 *     }
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
  type StudioAIContextEnricher,
} from '@mui/x-studio-ai-middleware';
import type { StudioState } from '@mui/x-studio-ai-middleware';
import type { SerializedStudioState } from '@mui/x-studio';
import { log, error as logError } from '../logger.js';
import { getDashboardState, setDashboardState } from './dashboardState.js';
import {
  generateSalesData,
  generateCrmData,
  CUSTOMERS_SOURCE_ID,
  PRODUCTS_SOURCE_ID,
  ORDERS_SOURCE_ID,
  ORDER_ITEMS_SOURCE_ID,
  SHIPMENTS_SOURCE_ID,
  SHIPMENT_ITEMS_SOURCE_ID,
  CRM_CONTACTS_SOURCE_ID,
  CRM_DEALS_SOURCE_ID,
  CRM_ACTIVITIES_SOURCE_ID,
  CRM_DEAL_TRANSITIONS_SOURCE_ID,
  INITIAL_STATE,
} from 'x-studio-shared';
import type { Config } from '../config.js';
import { resolveClaims, DEV_CLAIMS } from '../middleware/claims.js';

// ── MCP session initial state ─────────────────────────────────────────────────
// Use the full sales dashboard layout (pages, widgets, relationships,
// expressionFields) from INITIAL_STATE, but replace data source rows with
// nothing — all data is queried live from the DB via queryDataSource.

const {
  customersSource,
  productsSource,
  ordersSource,
  orderItemsSource,
  shipmentsSource,
  shipmentItemsSource,
} = generateSalesData();

const { contactsSource, dealsSource, activitiesSource, dealTransitionsSource } = generateCrmData();

function withoutRows<T extends { rows?: unknown[] }>({ rows: _rows, ...rest }: T): Omit<T, 'rows'> {
  return rest;
}

// Data sources without embedded rows — the schema (fields, labels, tableName) is
// preserved so widgets can reference columns, but the row data comes from the DB.
const MCP_INITIAL_DATA_SOURCES = {
  [CUSTOMERS_SOURCE_ID]: withoutRows(customersSource),
  [PRODUCTS_SOURCE_ID]: withoutRows(productsSource),
  [ORDERS_SOURCE_ID]: withoutRows(ordersSource),
  [ORDER_ITEMS_SOURCE_ID]: withoutRows(orderItemsSource),
  [SHIPMENTS_SOURCE_ID]: withoutRows(shipmentsSource),
  [SHIPMENT_ITEMS_SOURCE_ID]: withoutRows(shipmentItemsSource),
  [CRM_CONTACTS_SOURCE_ID]: withoutRows(contactsSource),
  [CRM_DEALS_SOURCE_ID]: withoutRows(dealsSource),
  [CRM_ACTIVITIES_SOURCE_ID]: withoutRows(activitiesSource),
  [CRM_DEAL_TRANSITIONS_SOURCE_ID]: withoutRows(dealTransitionsSource),
};

// Full dashboard layout from the shared config, with live data sources.
const MCP_INITIAL_STATE = {
  ...INITIAL_STATE,
  dataSources: MCP_INITIAL_DATA_SOURCES,
};

const SALES_SCHEMA_ALLOWLIST = [
  'customers',
  'products',
  'orders',
  'order_items',
  'shipments',
  'shipment_items',
];

const CRM_SCHEMA_ALLOWLIST = ['contacts', 'deals', 'activities', 'deal_stage_transitions'];

/** Matches a safe SQL identifier so a client-supplied table name can't inject. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

  /**
   * Demonstrative `contextEnricher`: attaches DB-side metadata the MCP client
   * can't compute — exact table row counts and authored field descriptions —
   * to the `studio://dashboard/system-prompt` resource's `<server_context>`
   * block. Best-effort: the middleware logs and skips failures.
   */
  function makeContextEnricher(): StudioAIContextEnricher {
    return async ({ dashboardState }) => {
      const schemaComments: Record<string, string> = {};
      const rowCountNotes: string[] = [];

      await Promise.all(
        Object.values(dashboardState.dataSources).map(async (source) => {
          for (const field of source.fields ?? []) {
            if (field.aiDescription) {
              schemaComments[`${source.id}.${field.id}`] = field.aiDescription;
            }
          }

          const table = source.tableName;
          if (!table || !SAFE_IDENTIFIER.test(table)) {
            return;
          }
          const db = CRM_SCHEMA_ALLOWLIST.includes(table) ? crmDb : salesDb;
          try {
            const [row] = (await db(table).count({ c: '*' })) as Array<{ c: number | string }>;
            rowCountNotes.push(
              `${source.label} (${table}): ${Number(row.c).toLocaleString()} rows`,
            );
          } catch {
            // Table may not exist in this database — skip silently.
          }
        }),
      );

      return {
        ...(Object.keys(schemaComments).length > 0 ? { schemaComments } : {}),
        ...(rowCountNotes.length > 0
          ? { notes: `Exact table row counts:\n${rowCountNotes.join('\n')}` }
          : {}),
      };
    };
  }

  // POST — tool calls from the MCP client (and session initialization)
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const method = (req.body as { method?: string })?.method ?? '?';
    const sid8 = sessionId ? sessionId.slice(0, 8) : null;

    // Existing session: route the request to its transport.
    if (sessionId && transports[sessionId]) {
      log(`[mcp] → ${method} (session ${sid8}…)`);
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // New session: client must send an MCP initialize request (no session ID header).
    if (!sessionId && isInitializeRequest(req.body)) {
      log(`[mcp] → initialize (new session)`);
      // Resolve claims once at session init; reused for all data queries in this session.
      let claims;
      try {
        claims = resolveClaims(req, config);
      } catch {
        // In dev mode we'll have already returned DEV_CLAIMS; this branch means
        // a static token is configured but no valid token was supplied.
        claims = DEV_CLAIMS;
      }

      const saved = getDashboardState() as SerializedStudioState | null;
      const stateBox: StudioStateBox = {
        current: createDefaultStudioState(
          saved
            ? ({
                ...saved,
                dataSources: MCP_INITIAL_DATA_SOURCES,
                mode: 'edit',
              } as Partial<StudioState>)
            : MCP_INITIAL_STATE,
        ),
      };

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          stateBoxes[sid] = stateBox;
          log(`[mcp] session ${sid.slice(0, 8)}… initialized${saved ? ' (from saved state)' : ''}`);
        },
      });

      // Clean up session on disconnect, persisting any mutations made during the session.
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          log(`[mcp] session ${sid.slice(0, 8)}… closed`);
          const box = stateBoxes[sid];
          if (box) {
            const { dataSources: _ds, mode: _m, shell: _sh, ...persisted } = box.current;
            setDashboardState(persisted);
            log(`[mcp] session ${sid.slice(0, 8)}… state persisted`);
          }
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
        contextEnricher: makeContextEnricher(),
        logger: { log, error: logError },
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Malformed or stale-session request — log so we can diagnose reconnect failures.
    logError(
      `[mcp] 400 ${method} — ${sessionId ? `unknown session ${sid8}… (stale after server restart?)` : 'no session ID and not an initialize request'}`,
    );
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
