/**
 * MCP (Model Context Protocol) route for x-studio-survey.
 *
 * Mounts a stateful Streamable-HTTP MCP server (POST/GET/DELETE /api/mcp). Each
 * session gets its own `McpServer` backed by an isolated `StudioState`, so MCP
 * clients can build a survey dashboard with the x-studio tools and query the
 * survey data via the `query_data_source` tool.
 *
 * ## Data access
 * `query_data_source` is backed by `queryDataSource`, which translates the
 * structured query (columns / filters / aggregations / orderBy / paging) into a
 * parameterised knex query against the in-memory survey SQLite database. Table
 * and column identifiers are validated against the seeded schema, and values are
 * always bound — never interpolated — so the tool stays read-only and safe.
 *
 * ## Claude Desktop configuration
 * Claude Desktop only speaks stdio, so bridge it to Streamable HTTP with
 * `mcp-remote`. Add to `claude_desktop_config.json`:
 * ```json
 * {
 *   "mcpServers": {
 *     "x-studio-survey": {
 *       "command": "npx",
 *       "args": ["mcp-remote", "https://survey-dev.up.railway.app/api/mcp"]
 *     }
 *   }
 * }
 * ```
 */
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type knex from 'knex';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  buildStudioMcpServer,
  createDefaultStudioState,
  type StudioState,
  type StudioStateBox,
  type StudioDataQueryParams,
  type StudioDataQueryResult,
  type StudioAIContextEnricher,
} from '@mui/x-studio-ai-middleware';
import type { SeededTable } from './seedFromExcel.js';
import { log, error as logError } from './logger.js';

type Db = ReturnType<typeof knex>;

/** Matches a safe SQL identifier so a client-supplied name can't inject. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const OPERATOR_SQL: Record<'eq' | 'gt' | 'lt' | 'gte' | 'lte', string> = {
  eq: '=',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
};

/**
 * Build the MCP session's data sources from the seeded tables. Each sheet
 * becomes one data source whose `tableName` is the SQLite table and whose
 * fields mirror the columns (all TEXT, so `type: 'string'`).
 */
function buildSurveyDataSources(tables: SeededTable[]): StudioState['dataSources'] {
  const entries = tables.map((t) => [
    t.tableName,
    {
      id: t.tableName,
      label: t.tableName,
      tableName: t.tableName,
      fields: t.columns.map((column) => ({ id: column, label: column, type: 'string' as const })),
    },
  ]);
  return Object.fromEntries(entries) as StudioState['dataSources'];
}

/**
 * Translate a structured `StudioDataQueryParams` into a parameterised knex query
 * against the survey SQLite database. Identifiers are validated against the
 * seeded schema; values are bound. Read-only by construction (SELECT only).
 */
function createQueryDataSource(db: Db, schema: Map<string, Set<string>>) {
  return async (params: StudioDataQueryParams): Promise<StudioDataQueryResult> => {
    const { tableName, columns, filters, aggregations, having, orderBy, limit, offset } = params;

    const validColumns = schema.get(tableName);
    if (!validColumns) {
      throw new Error(`Unknown data source table: ${tableName}`);
    }
    const assertColumn = (column: string): string => {
      if (!validColumns.has(column)) {
        throw new Error(`Unknown column "${column}" on ${tableName}`);
      }
      return column;
    };
    const assertAlias = (alias: string): string => {
      if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`Invalid aggregation alias: ${alias}`);
      }
      return alias;
    };

    let query = db(tableName);

    const groupColumns = (columns ?? []).map(assertColumn);

    if (aggregations && aggregations.length > 0) {
      if (groupColumns.length > 0) {
        query = query.select(groupColumns).groupBy(groupColumns);
      }
      for (const agg of aggregations) {
        const column = assertColumn(agg.column);
        const alias = assertAlias(agg.alias);
        switch (agg.func) {
          case 'sum':
            query = query.sum({ [alias]: column });
            break;
          case 'avg':
            query = query.avg({ [alias]: column });
            break;
          case 'min':
            query = query.min({ [alias]: column });
            break;
          case 'max':
            query = query.max({ [alias]: column });
            break;
          case 'count':
            query = query.count({ [alias]: column });
            break;
          default:
            throw new Error(`Unsupported aggregation function: ${String(agg.func)}`);
        }
      }
    } else if (groupColumns.length > 0) {
      query = query.select(groupColumns);
    }

    for (const filter of filters ?? []) {
      const column = assertColumn(filter.field);
      switch (filter.operator) {
        case 'eq':
          query = query.where(column, filter.value as never);
          break;
        case 'neq':
          query = query.whereNot(column, filter.value as never);
          break;
        case 'in':
          query = query.whereIn(
            column,
            (Array.isArray(filter.value) ? filter.value : []) as (string | number)[],
          );
          break;
        case 'lt':
          query = query.where(column, '<', filter.value as never);
          break;
        case 'lte':
          query = query.where(column, '<=', filter.value as never);
          break;
        case 'gt':
          query = query.where(column, '>', filter.value as never);
          break;
        case 'gte':
          query = query.where(column, '>=', filter.value as never);
          break;
        case 'like':
          query = query.where(column, 'like', filter.value as never);
          break;
        case 'between':
          query = query.whereBetween(column, [filter.value as never, filter.value2 as never]);
          break;
        default:
          throw new Error(`Unsupported filter operator: ${String(filter.operator)}`);
      }
    }

    for (const predicate of having ?? []) {
      const agg = aggregations?.find((a) => a.alias === predicate.alias);
      if (!agg) {
        throw new Error(`having alias "${predicate.alias}" is not in aggregations`);
      }
      query = query.havingRaw(`${agg.func}(??) ${OPERATOR_SQL[predicate.operator]} ?`, [
        agg.column,
        predicate.value,
      ]);
    }

    for (const sort of orderBy ?? []) {
      const isAggregateAlias = aggregations?.some((a) => a.alias === sort.column) ?? false;
      if (!isAggregateAlias && !validColumns.has(sort.column)) {
        throw new Error(`Unknown orderBy column: ${sort.column}`);
      }
      query = query.orderBy(sort.column, sort.direction === 'desc' ? 'desc' : 'asc');
    }

    query = query.limit(Math.min(limit ?? 1000, 1000));
    if (offset && offset > 0) {
      query = query.offset(offset);
    }

    const rows = (await query) as Record<string, unknown>[];
    return { rows, rowCount: rows.length, tier: 'db' };
  };
}

/**
 * Best-effort `contextEnricher`: attaches exact per-table row counts to the
 * `studio://dashboard/system-prompt` resource so the model knows dataset sizes.
 */
function createContextEnricher(db: Db, schema: Map<string, Set<string>>): StudioAIContextEnricher {
  return async ({ dashboardState }) => {
    const notes: string[] = [];
    await Promise.all(
      Object.values(dashboardState.dataSources).map(async (source) => {
        const table = source.tableName;
        if (!table || !schema.has(table)) {
          return;
        }
        try {
          const [row] = (await db(table).count({ c: '*' })) as Array<{ c: number | string }>;
          notes.push(`${source.label} (${table}): ${Number(row.c).toLocaleString()} rows`);
        } catch {
          // Table may have been dropped — skip silently.
        }
      }),
    );
    return notes.length > 0 ? { notes: `Exact table row counts:\n${notes.join('\n')}` } : {};
  };
}

/**
 * Create the MCP router. `tables` is the seeded schema returned by
 * `seedSurveyDatabase`; it provides the data-source layout and the
 * identifier allowlist used to validate every query.
 */
export function makeMcpRouter(db: Db, tables: SeededTable[]): Router {
  const router = Router();

  const dataSources = buildSurveyDataSources(tables);
  const schema = new Map(tables.map((t) => [t.tableName, new Set(t.columns)]));
  const queryDataSource = createQueryDataSource(db, schema);
  const contextEnricher = createContextEnricher(db, schema);

  // Streamable-HTTP sessions, keyed by the MCP session ID issued on init.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // POST — initialization and tool calls.
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const method = (req.body as { method?: string })?.method ?? '?';

    // Existing session: route to its transport.
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // New session: the client must send an `initialize` request with no session ID.
    if (!sessionId && isInitializeRequest(req.body)) {
      log('[mcp] → initialize (new session)');

      const stateBox: StudioStateBox = {
        current: createDefaultStudioState({ dataSources, mode: 'edit' } as Partial<StudioState>),
      };

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          log(`[mcp] session ${sid.slice(0, 8)}… initialized`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          log(`[mcp] session ${sid.slice(0, 8)}… closed`);
          delete transports[sid];
        }
      };

      const mcpServer = buildStudioMcpServer(stateBox, {
        serverName: 'x-studio-survey',
        serverVersion: '1.0.0',
        data: { queryDataSource },
        contextEnricher,
        logger: { log, error: logError },
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    logError(
      `[mcp] 400 ${method} — ${
        sessionId
          ? `unknown session ${sessionId.slice(0, 8)}… (stale after restart?)`
          : 'no session ID and not an initialize request'
      }`,
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
