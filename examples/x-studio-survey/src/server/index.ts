/**
 * Survey API server for x-studio-survey.
 *
 * Loads both Excel workbooks into an in-memory SQLite database on startup, then
 * serves the x-studio-ai-middleware AI endpoints so the chat assistant can answer
 * questions about survey data via SQL.
 *
 * Environment variables:
 *   PORT               — HTTP port (default 3005)
 *   LLM_API_KEY        — OpenAI-compatible API key (falls back to OPENAI_API_KEY)
 *   LLM_ENDPOINT       — Chat completions URL (default OpenAI)
 *   LLM_MODEL          — Model name (default gpt-4o)
 *   STUDIO_TOKEN       — Bearer token clients must send; omit to run open in dev
 *   ALLOWED_ORIGINS    — Comma-separated CORS origins
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import knex from 'knex';
import {
  handleAIChat,
  handleGenerateTitle,
  handleCreateWidget,
  type StudioDataResolver,
} from '@mui/x-studio-ai-middleware';
import { seedSurveyDatabase, type SeededTable } from './seedFromExcel.js';
import { makeMcpRouter } from './mcp.js';
import { log, error } from './logger.js';

const PORT = parseInt(process.env.PORT ?? '3005', 10);
const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
const LLM_ENDPOINT =
  process.env.LLM_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-4o';
const STUDIO_TOKEN = process.env.STUDIO_TOKEN;
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ??
  'http://localhost:3004,http://localhost:3005,https://mbrookes.github.io'
)
  .split(',')
  .map((s) => s.trim());

/** Reject anything that isn't a single read-only SELECT/WITH statement. */
function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    return false;
  }
  if (!/^\s*(select|with)\b/i.test(trimmed)) {
    return false;
  }
  return !/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace|truncate|vacuum)\b/i.test(
    trimmed,
  );
}

function createDataResolver(db: ReturnType<typeof knex>): StudioDataResolver {
  return {
    async resolve(query) {
      if (!isReadOnlyQuery(query)) {
        throw new Error(
          'execute_query only supports a single read-only SELECT statement. ' +
            'Rewrite the request as a SELECT (no INSERT/UPDATE/DELETE/DDL or stacked statements).',
        );
      }

      const raw = (await db.raw(query)) as unknown;
      let allRows: Record<string, unknown>[] = [];
      if (Array.isArray(raw)) {
        allRows = raw as Record<string, unknown>[];
      } else if (Array.isArray((raw as { rows?: unknown }).rows)) {
        allRows = (raw as { rows: Record<string, unknown>[] }).rows;
      }

      const rows = allRows.slice(0, 200);
      return {
        rows,
        columns: rows.length > 0 ? Object.keys(rows[0]) : undefined,
        totalCount: allRows.length,
      };
    },
  };
}

async function main(): Promise<void> {
  const db = knex({
    client: 'better-sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
  });

  log('[startup] Seeding in-memory survey database from Excel files…');
  let tables: SeededTable[] = [];
  try {
    tables = await seedSurveyDatabase(db);
    for (const { tableName, rowCount } of tables) {
      log(`[startup]   ${tableName}: ${rowCount.toLocaleString()} rows`);
    }
  } catch (err) {
    error('[startup] Failed to seed database:', err);
    process.exit(1);
  }

  const app = express();

  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow requests with no origin (e.g. curl, Render health checks)
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
          cb(null, true);
        } else {
          cb(new Error(`CORS: origin ${origin} not allowed`));
        }
      },
      // MCP clients send the session id on requests and must read it from the
      // initialize response, so allow and expose the Mcp-Session-Id header.
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
      exposedHeaders: ['Mcp-Session-Id'],
    }),
  );
  app.use(express.json({ limit: '10mb' }));

  // Optional bearer-token auth for AI endpoints
  if (STUDIO_TOKEN) {
    app.use('/api/ai', (req: Request, res: Response, next) => {
      const auth = req.headers['authorization'];
      if (!auth || auth !== `Bearer ${STUDIO_TOKEN}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  }

  // Health
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      tables: tables.map(({ tableName, rowCount }) => ({ table: tableName, rows: rowCount })),
    });
  });

  const dataResolver = createDataResolver(db);
  const pendingApprovals = new Map<string, (approved: boolean, reason?: string) => void>();

  // POST /api/ai/chat — SSE stream
  app.post('/api/ai/chat', async (req: Request, res: Response): Promise<void> => {
    if (!LLM_API_KEY) {
      res.status(503).json({
        error: 'LLM API key is not configured. Set LLM_API_KEY or OPENAI_API_KEY.',
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      const stream = handleAIChat(req.body, {
        endpoint: LLM_ENDPOINT,
        apiKey: LLM_API_KEY,
        model: LLM_MODEL,
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

  // POST /api/ai/approval — resolve a pending tool-approval-request
  app.post('/api/ai/approval', (req: Request, res: Response): void => {
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

  // POST /api/ai/title — generate a short session title
  app.post('/api/ai/title', async (req: Request, res: Response): Promise<void> => {
    if (!LLM_API_KEY) {
      res.status(503).json({ error: 'LLM API key is not configured.' });
      return;
    }
    try {
      const { message } = req.body as { message: string };
      const result = await handleGenerateTitle(message, {
        endpoint: LLM_ENDPOINT,
        apiKey: LLM_API_KEY,
        model: LLM_MODEL,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/ai/widget — create a widget from a natural-language description
  app.post('/api/ai/widget', async (req: Request, res: Response): Promise<void> => {
    if (!LLM_API_KEY) {
      res.status(503).json({ error: 'LLM API key is not configured.' });
      return;
    }
    try {
      const result = await handleCreateWidget(req.body, {
        endpoint: LLM_ENDPOINT,
        apiKey: LLM_API_KEY,
        model: LLM_MODEL,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // MCP (Model Context Protocol) — Streamable HTTP at /api/mcp.
  // Exposes the x-studio dashboard tools plus structured survey-data queries.
  app.use('/api/mcp', makeMcpRouter(db, tables));

  app.listen(PORT, () => {
    log(`[startup] x-studio-survey-api listening on http://localhost:${PORT}`);
    log(`[startup]   Health:  http://localhost:${PORT}/health`);
    log(`[startup]   AI API:  http://localhost:${PORT}/api/ai/chat`);
    log(`[startup]   MCP:     http://localhost:${PORT}/api/mcp`);
    if (!LLM_API_KEY) {
      log('[startup]   ⚠ LLM_API_KEY not set — AI endpoints will return 503');
    }
    if (!STUDIO_TOKEN) {
      log('[startup]   ⚠ Running in open mode (no STUDIO_TOKEN set)');
    }
  });
}

main().catch((err) => {
  error('[startup] Fatal error:', err);
  process.exit(1);
});
