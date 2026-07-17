import { Router, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import {
  handleAIChat,
  handleGenerateTitle,
  handleCreateWidget,
  type StudioAIContextEnricher,
  type PendingApproval,
} from '@mui/x-studio-ai-middleware';
import type { Config } from '../config.js';
import { error } from '../logger.js';
import { resolveClaims } from '../middleware/claims.js';
import { CRM_SCHEMA_ALLOWLIST, SAFE_IDENTIFIER, makeQueryDataSource } from '../dataQuery.js';

/**
 * Builds an optional `contextEnricher` that attaches DB-side metadata to the AI
 * context — the server's chance to add information the client can't compute.
 *
 * Here we surface two things: the *exact* total row count of each source's
 * backing table (the client only ever sees sampled/filtered rows) and any
 * authored field descriptions re-exposed as schema comments. The result is
 * rendered into a `<server_context>` block in the system prompt.
 *
 * Enrichment is best-effort: the middleware catches and reports failures via
 * `onToolError`, so a slow or failing query never blocks the chat. Keep the
 * payload small — it counts against the model's token budget.
 */
function createContextEnricher(salesDb: Knex, crmDb: Knex): StudioAIContextEnricher {
  return async ({ dashboardState }) => {
    const schemaComments: Record<string, string> = {};
    const rowCountNotes: string[] = [];

    await Promise.all(
      Object.values(dashboardState.runtime.dataSources).map(async (source) => {
        // Re-surface authored field descriptions as schema comments.
        for (const field of source.fields ?? []) {
          if (field.aiDescription) {
            schemaComments[`${source.id}.${field.id}`] = field.aiDescription;
          }
        }

        // Best-effort exact row count from the backing table. The table name
        // comes from client state, so validate it before interpolating.
        const table = source.tableName;
        if (!table || !SAFE_IDENTIFIER.test(table)) {
          return;
        }
        const db = CRM_SCHEMA_ALLOWLIST.includes(table) ? crmDb : salesDb;
        try {
          const [row] = (await db(table).count({ c: '*' })) as Array<{ c: number | string }>;
          rowCountNotes.push(`${source.label} (${table}): ${Number(row.c).toLocaleString()} rows`);
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

  // Attaches DB-side metadata (exact row counts, schema comments) to every
  // chat request's system prompt. Optional — remove to send only client context.
  const contextEnricher = createContextEnricher(salesDb, crmDb);

  /**
   * Approval resolvers keyed by toolCallId (now a `crypto.randomUUID()` — see
   * `agenticLoop.ts` — rather than a predictable `call-${turn}-${idx}` scheme).
   * Each entry is a `PendingApproval` (resolver + the AI chat thread id the approval
   * was raised under, when known), created by the agentic loop just before it yields
   * `tool-approval-request` and resolved by POST /approval.
   */
  const pendingApprovals = new Map<string, PendingApproval>();

  router.post('/chat', async (req: Request, res: Response): Promise<void> => {
    if (!config.llm.apiKey) {
      res.status(503).json({
        error: 'LLM_API_KEY is not configured. Set it in your .env.local file.',
      });
      return;
    }

    // Resolved per request (unlike MCP's session-scoped claims) since the chat
    // transport is stateless per HTTP request — mirrors salesData.ts's pattern.
    let claims;
    try {
      claims = resolveClaims(req, config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(401).json({ error: message });
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
        data: { queryDataSource: makeQueryDataSource(salesDb, crmDb, claims) },
        contextEnricher,
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
    // Same auth check as POST /chat: resolving a pending approval must not be
    // reachable by an unauthenticated caller. Without this, a random id (previously
    // a guessable `call-${turn}-${idx}`, and reachable by anyone regardless of
    // auth) was enough to resolve or deny another user's pending tool approval.
    try {
      resolveClaims(req, config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(401).json({ error: message });
      return;
    }

    const { id, approved, reason, threadId } = req.body as {
      id: string;
      approved: boolean;
      reason?: string;
      threadId?: string;
    };
    const entry = pendingApprovals.get(id);
    if (!entry) {
      res.status(404).json({ error: `No pending approval for id: ${id}` });
      return;
    }
    // Ownership binding: when this approval was raised under a known AI chat thread
    // and the caller also asserts one, they must match — a resolution meant for a
    // different conversation is refused rather than trusted on id alone.
    if (entry.threadId !== undefined && threadId !== undefined && entry.threadId !== threadId) {
      res.status(403).json({ error: 'This approval belongs to a different chat thread.' });
      return;
    }
    pendingApprovals.delete(id);
    entry.resolve(approved, reason);
    res.json({ ok: true });
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
