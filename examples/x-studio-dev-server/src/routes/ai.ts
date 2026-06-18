import { Router, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import {
  handleAIChat,
  handleGenerateTitle,
  handleCreateWidget,
  type StudioDataResolver,
} from '@mui/x-studio-ai-middleware';
import type { Config } from '../config.js';
import { error } from '../logger.js';

/** CRM tables live in a separate database (see crmSchema.ts / makeCrmDataRouter). */
const CRM_TABLES = ['contacts', 'deals', 'activities'];

/** Maximum rows returned to the model from a single `execute_query` call. */
const MAX_RESULT_ROWS = 200;

/**
 * Reject anything that isn't a single read-only `SELECT`/`WITH` statement.
 * The query text comes from the LLM, so this guard keeps `execute_query` from
 * mutating the database or running multiple statements.
 */
function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    return false; // no stacked statements
  }
  if (!/^\s*(select|with)\b/i.test(trimmed)) {
    return false;
  }
  return !/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace|truncate|vacuum)\b/i.test(
    trimmed,
  );
}

/**
 * Builds the `dataResolver` that powers the AI `execute_query` tool.
 *
 * Routes each query to the correct database: queries that reference a CRM table
 * (or pass a `sourceId` containing "crm") go to `crmDb`, everything else to the
 * sales `db`. Only read-only statements are allowed, and results are capped so a
 * broad query can't flood the model's context.
 */
function createDataResolver(salesDb: Knex, crmDb: Knex): StudioDataResolver {
  return {
    async resolve(query, sourceId) {
      if (!isReadOnlyQuery(query)) {
        throw new Error(
          'execute_query only supports a single read-only SELECT statement. ' +
            'Rewrite the request as a SELECT (no INSERT/UPDATE/DELETE/DDL or multiple statements).',
        );
      }

      const lower = query.toLowerCase();
      const isCrm =
        (sourceId?.toLowerCase().includes('crm') ?? false) ||
        CRM_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(lower));
      const targetDb = isCrm ? crmDb : salesDb;

      // knex.raw returns an array of rows on better-sqlite3 and `{ rows }` on pg/mysql.
      const raw = (await targetDb.raw(query)) as unknown;
      let allRows: Record<string, unknown>[] = [];
      if (Array.isArray(raw)) {
        allRows = raw as Record<string, unknown>[];
      } else if (Array.isArray((raw as { rows?: unknown }).rows)) {
        allRows = (raw as { rows: Record<string, unknown>[] }).rows;
      }

      const rows = allRows.slice(0, MAX_RESULT_ROWS);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : undefined;
      return { rows, columns, totalCount: allRows.length };
    },
  };
}

/**
 * POST /api/ai/chat
 *
 * Accepts a Studio AI chat request and streams SSE responses.
 * The client sends the full dashboard state + message history in the body.
 * This route adds the system prompt and runs the agentic loop server-side.
 *
 * POST /api/ai/approval
 *
 * Resolves a pending tool-approval-request. The client sends `{ id, approved, reason? }`.
 * The agentic loop for the associated chat stream is unblocked immediately.
 *
 * POST /api/ai/insight
 *
 * Accepts a widget data summary and returns a single-paragraph AI insight.
 *
 * POST /api/ai/title
 *
 * Accepts a chat message and returns a short title + description for the session.
 *
 * POST /api/ai/widget
 *
 * Creates a widget from a natural-language description and available data source context.
 */
export function makeAIRouter(salesDb: Knex, crmDb: Knex, config: Config): Router {
  const router = Router();

  // Enables the AI `execute_query` tool by giving the agentic loop read-only
  // access to the sales + CRM databases.
  const dataResolver = createDataResolver(salesDb, crmDb);

  /**
   * Approval resolvers keyed by toolCallId.
   * Each entry is created by the agentic loop just before it yields
   * `tool-approval-request` and is resolved by POST /approval.
   */
  const pendingApprovals = new Map<string, (approved: boolean, reason?: string) => void>();

  router.post('/chat', async (req: Request, res: Response): Promise<void> => {
    if (!config.llm.apiKey) {
      res.status(503).json({
        error: 'LLM_API_KEY is not configured. Set it in your .env.local file.',
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      const stream = handleAIChat(req.body, {
        endpoint: config.llm.endpoint,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        approvalPending: pendingApprovals,
        dataResolver,
      });

      const reader = stream.getReader();

      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        res.write(value);
        if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
          (res as unknown as { flush: () => void }).flush();
        }
        return pump();
      };

      await pump();
    } catch (err) {
      error('[ai] Stream error:', err);
      const message = err instanceof Error ? err.message : String(err);
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
    }
  });

  router.post('/approval', (req: Request, res: Response): void => {
    const { id, approved, reason } = req.body as {
      id: string;
      approved: boolean;
      reason?: string;
    };
    const resolve = pendingApprovals.get(id);
    if (resolve) {
      resolve(approved, reason);
      pendingApprovals.delete(id);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: `No pending approval for id: ${id}` });
    }
  });

  router.post('/title', async (req: Request, res: Response): Promise<void> => {
    if (!config.llm.apiKey) {
      res.status(503).json({
        error: 'LLM_API_KEY is not configured. Set it in your .env.local file.',
      });
      return;
    }

    try {
      const { message } = req.body as { message: string };
      const result = await handleGenerateTitle(message, {
        endpoint: config.llm.endpoint,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post('/widget', async (req: Request, res: Response): Promise<void> => {
    if (!config.llm.apiKey) {
      res.status(503).json({
        error: 'LLM_API_KEY is not configured. Set it in your .env.local file.',
      });
      return;
    }

    try {
      const result = await handleCreateWidget(req.body, {
        endpoint: config.llm.endpoint,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
