import { Router, type Request, type Response } from 'express';
import {
  handleAIChat,
  handleGenerateInsight,
  handleGenerateTitle,
  handleCreateWidget,
} from '@mui/x-studio-ai-middleware';
import type { Config } from '../config.js';

/**
 * POST /api/ai/chat
 *
 * Accepts a Studio AI chat request and streams SSE responses.
 * The client sends the full dashboard state + message history in the body.
 * This route adds the system prompt and runs the agentic loop server-side.
 *
 * POST /api/ai/insight
 *
 * Accepts a widget data summary and returns a single-paragraph AI insight.
 *
 * POST /api/ai/title
 *
 * Accepts a chat message and returns a short title + description for the session.
 * POST /api/ai/widget
 *
 * Creates a widget from a natural-language description and available data source context.
 */
export function makeAIRouter(config: Config): Router {
  const router = Router();

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
      console.error('[ai] Stream error:', err);
      const message = err instanceof Error ? err.message : String(err);
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
    }
  });

  router.post('/insight', async (req: Request, res: Response): Promise<void> => {
    if (!config.llm.apiKey) {
      res.status(503).json({
        error: 'LLM_API_KEY is not configured. Set it in your .env.local file.',
      });
      return;
    }

    try {
      const text = await handleGenerateInsight(req.body, {
        endpoint: config.llm.endpoint,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
      });
      res.json({ text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
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
