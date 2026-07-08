/**
 * API server for the x-studio GitHub library-usage heatmap example.
 *
 * Proxies GitHub's code-search API server-side so the personal access token
 * never ships to the browser — GitHub code search requires authentication,
 * and baking a token into the client bundle via a VITE_ env var would expose
 * it to anyone who loads the page. Also serves the built static client when
 * present, so a single Railway service can host both (see railway.toml).
 *
 * Environment variables:
 *   PORT             — HTTP port (default 3006)
 *   GITHUB_SEARCH_TOKEN     — GitHub personal access token used for code search.
 *                      Without it, /api/github-library-usage returns an
 *                      empty matrix instead of failing.
 *   ALLOWED_ORIGINS  — Comma-separated CORS origins for the /api routes
 *                      (the server's own origin is always allowed, so this
 *                      only needs to list *other* origins, e.g. a separate
 *                      Vite dev server).
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLibraryUsageMatrix } from './githubLibraryUsage.js';
import { log, error, warn } from './logger.js';

// The built client (`vite build`, run at deploy time — see railway.toml). Only present when
// this server is hosting the static site itself (e.g. on Railway); absent during local
// `pnpm server` development, where the Vite dev server (`pnpm dev`) serves the client
// separately and proxies /api requests here instead (see vite.config.ts).
const CLIENT_DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist');

const PORT = parseInt(process.env.PORT ?? '3006', 10);
const GITHUB_SEARCH_TOKEN = process.env.GITHUB_SEARCH_TOKEN;
// Browsers send an Origin header even for same-origin fetch() calls, so when this server also
// hosts the client (see CLIENT_DIST_DIR below), its own public URL must be allowed too — that's
// handled by the selfOrigin check below rather than hardcoded here, so it keeps working across
// redeploys to a different domain without needing this list updated.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3004')
  .split(',')
  .map((s) => s.trim());

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface Cache {
  rows: Record<string, unknown>[];
  fetchedAt: number;
}

async function main(): Promise<void> {
  const app = express();
  // Railway (like most PaaS) terminates TLS at an edge proxy and forwards via X-Forwarded-*;
  // without this, req.protocol/req.get('host') below would report the internal http/proxy view
  // instead of the actual public origin, breaking the self-origin check.
  app.set('trust proxy', true);

  // Scoped to /api — mounting CORS globally breaks the co-hosted static client: Vite marks its
  // module script `crossorigin`, so the browser sends an Origin header even for that
  // same-origin <script> load, and a rejected origin throws inside the callback — an unhandled
  // error Express turns into a bare 500 for the asset request.
  app.use('/api', (req, res, next) => {
    // Always allow the request's own origin — the co-hosted client calling its own API is
    // never actually cross-origin in any meaningful sense.
    const selfOrigin = `${req.protocol}://${req.get('host')}`;
    cors({
      origin: (origin, cb) => {
        if (!origin || origin === selfOrigin || ALLOWED_ORIGINS.includes(origin)) {
          cb(null, true);
        } else {
          cb(new Error(`CORS: origin ${origin} not allowed`));
        }
      },
    })(req, res, next);
  });

  let cache: Cache | null = null;
  let inFlight: Promise<Record<string, unknown>[]> | null = null;

  // GET /api/github-library-usage — the component-library × data-grid-library adoption
  // matrix. Cached in memory for a day (shared across every visitor) since it costs one
  // rate-limited GitHub search per (component library × data grid library) cell to compute
  // (COMPONENT_LIBRARIES.length * DATA_GRID_LIBRARIES.length requests — see
  // githubLibraryUsage.ts).
  app.get('/api/github-library-usage', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
        res.json({ rows: cache.rows, fetchedAt: cache.fetchedAt });
        return;
      }
      if (!inFlight) {
        inFlight = fetchLibraryUsageMatrix(GITHUB_SEARCH_TOKEN).finally(() => {
          inFlight = null;
        });
      }
      const rows = await inFlight;
      cache = { rows, fetchedAt: Date.now() };
      res.json({ rows, fetchedAt: cache.fetchedAt });
    } catch (err) {
      error('[github-library-usage] Failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Health
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, hasGithubSearchToken: Boolean(GITHUB_SEARCH_TOKEN) });
  });

  // Serve the built client, when present, so a single Railway service can host both the API
  // and the static site (no separate static host needed). Registered last so it never shadows
  // an /api/* route above. The app has a single page, so the only fallback needed is
  // index.html for non-file GET requests (e.g. the root path itself).
  const hasClientBuild = fs.existsSync(path.join(CLIENT_DIST_DIR, 'index.html'));
  if (hasClientBuild) {
    app.use(express.static(CLIENT_DIST_DIR));
    app.get(/^(?!\/api\/).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html'));
    });
  } else {
    log(`[startup] No client build found at ${CLIENT_DIST_DIR} — API-only mode.`);
  }

  app.listen(PORT, () => {
    log(`[startup] x-studio-example-api listening on http://localhost:${PORT}`);
    log(`[startup]   Health: http://localhost:${PORT}/health`);
    log(`[startup]   API:    http://localhost:${PORT}/api/github-library-usage`);
    if (hasClientBuild) {
      log(`[startup]   Client: http://localhost:${PORT}/`);
    }
    if (!GITHUB_SEARCH_TOKEN) {
      warn(
        '[startup]   GITHUB_SEARCH_TOKEN not set — the heatmap endpoint will return an empty matrix.',
      );
    }
  });
}

main().catch((err) => {
  error('[startup] Fatal error:', err);
  process.exit(1);
});
