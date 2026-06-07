import { Router, type Request, type Response } from 'express';
import { handleAIChat } from '@mui/x-studio-ai-middleware';
import type { Config } from '../config.js';

/**
 * POST /api/ai/chat
 *
 * Accepts a Studio AI chat request and streams SSE responses.
 * The client sends the full dashboard state + message history in the body.
 * This route adds the system prompt and runs the agentic loop server-side.
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

  return router;
}
