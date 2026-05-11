import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3010', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ENDPOINT =
  process.env.OPENAI_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions';
const STUDIO_TOKEN = process.env.STUDIO_TOKEN;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

if (!OPENAI_API_KEY) {
  console.error('[x-studio-ai-proxy] ERROR: OPENAI_API_KEY is not set.');
  console.error('  Copy .env.example to .env and fill in your API key.');
  process.exit(1);
}

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();

// CORS — allow all origins in dev, restrict in production via ALLOWED_ORIGINS
const allowedOrigins = ALLOWED_ORIGINS
  ? ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : '*';

app.use(
  cors({
    origin: allowedOrigins,
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Studio-Token'],
  }),
);

app.use(express.json());

// ── Optional token auth ───────────────────────────────────────────────────────

if (STUDIO_TOKEN) {
  console.warn('[x-studio-ai-proxy] Token auth enabled (X-Studio-Token required).');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const token = req.headers['x-studio-token'];
    if (token !== STUDIO_TOKEN) {
      res.status(401).json({ error: 'Unauthorized — invalid or missing X-Studio-Token header.' });
      return;
    }
    next();
  });
}

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Chat completions proxy ────────────────────────────────────────────────────

/**
 * POST /v1/chat/completions
 *
 * Forwards the request body to the upstream LLM endpoint, adding the API key
 * server-side. Streams the SSE response back to the browser so the x-studio
 * adapter receives it in the same format as a direct OpenAI call.
 */
app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(req.body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[x-studio-ai-proxy] Upstream fetch failed:', message);
    res.status(502).json({ error: `Upstream request failed: ${message}` });
    return;
  }

  if (!upstream.ok) {
    let errorBody = '';
    try {
      errorBody = await upstream.text();
    } catch {
      // ignore
    }
    console.error(
      `[x-studio-ai-proxy] Upstream returned ${upstream.status}:`,
      errorBody.slice(0, 200),
    );
    res.status(upstream.status).set('Content-Type', 'application/json').send(errorBody);
    return;
  }

  // Forward content-type (text/event-stream for streaming responses)
  const contentType = upstream.headers.get('content-type');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }

  // Stream the upstream body back to the browser
  if (!upstream.body) {
    res.status(204).end();
    return;
  }

  const reader = upstream.body.getReader();
  res.flushHeaders();

  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      res.write(value);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Stream error';
    console.error('[x-studio-ai-proxy] Stream error:', message);
  } finally {
    res.end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.warn(`[x-studio-ai-proxy] Listening on http://localhost:${PORT}`);
  console.warn(`  Upstream endpoint: ${OPENAI_ENDPOINT}`);
  if (STUDIO_TOKEN) {
    console.warn('  Token auth: enabled');
  }
});
