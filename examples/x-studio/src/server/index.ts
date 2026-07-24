/**
 * API server for the x-studio GitHub library-usage example.
 *
 * Proxies GitHub's code-search API server-side so the personal access token
 * never ships to the browser — GitHub code search requires authentication,
 * and baking a token into the client bundle via a VITE_ env var would expose
 * it to anyone who loads the page. Also serves the built static client when
 * present, so a single Railway service can host both (see railway.toml).
 *
 * Captures one snapshot per ISO week for each of two independent matrices —
 * component library × data grid library, and component library × chart
 * library — persisting each via snapshotStore.ts (see weeklyCapture.ts for
 * the shared capture-cycle logic) so their /history endpoints can drive
 * "scrub through time" views on the client. See snapshotStore.ts for the
 * durability caveat on Railway (or any host with an ephemeral filesystem).
 *
 * Environment variables:
 *   PORT                          — HTTP port (default 3006)
 *   GITHUB_SEARCH_TOKEN           — GitHub personal access token used for
 *                                   code search. Without it, a capture
 *                                   produces no rows and is not persisted
 *                                   (see weeklyCapture.ts).
 *   SNAPSHOT_STORE_PATH           — Where data-grid weekly snapshots are
 *                                   persisted (default
 *                                   ./data/library-usage-history.json).
 *   CHART_LIBRARY_SNAPSHOT_STORE_PATH — Where chart-library weekly snapshots
 *                                   are persisted (default
 *                                   ./data/chart-library-usage-history.json).
 *   ALLOWED_ORIGINS               — Comma-separated CORS origins for the
 *                                   /api routes (the server's own origin is
 *                                   always allowed, so this only needs to
 *                                   list *other* origins, e.g. a separate
 *                                   Vite dev server).
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLibraryUsageMatrix, fetchChartLibraryUsageMatrix } from './githubLibraryUsage.js';
import { createSnapshotStore } from './snapshotStore.js';
import { createWeeklyCapture } from './weeklyCapture.js';
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

const DATA_GRID_SNAPSHOT_STORE_PATH =
  process.env.SNAPSHOT_STORE_PATH ?? path.join(process.cwd(), 'data', 'library-usage-history.json');
const CHART_LIBRARY_SNAPSHOT_STORE_PATH =
  process.env.CHART_LIBRARY_SNAPSHOT_STORE_PATH ??
  path.join(process.cwd(), 'data', 'chart-library-usage-history.json');

// Re-check periodically whether a new ISO week has started since the last capture. This is a
// "poll for due work" interval, not a precise cron — "due" is derived from persisted snapshots
// (see weeklyCapture.ts), so it self-heals across restarts/redeploys regardless of exact timing.
const REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// How long a live GET endpoint waits for a cold-start capture before answering anyway (with
// whatever's available — usually still nothing, on a true cold start). A full matrix now takes
// up to ~2.5min (component libraries × other libraries, ~2.5s apart — see githubLibraryUsage.ts),
// which is long enough to risk tripping a reverse-proxy or browser request timeout if a request
// just blocked on it outright. The capture itself is NOT cancelled when this wait elapses — it
// keeps running in the background and the next request (or a client retry) picks up the result
// once it's done; see waitForCapture below.
const INITIAL_CAPTURE_WAIT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

  const dataGridCapture = createWeeklyCapture({
    label: 'github-library-usage',
    store: createSnapshotStore(DATA_GRID_SNAPSHOT_STORE_PATH),
    fetchMatrix: fetchLibraryUsageMatrix,
    token: GITHUB_SEARCH_TOKEN,
  });
  const chartLibraryCapture = createWeeklyCapture({
    label: 'github-chart-library-usage',
    store: createSnapshotStore(CHART_LIBRARY_SNAPSHOT_STORE_PATH),
    fetchMatrix: fetchChartLibraryUsageMatrix,
    token: GITHUB_SEARCH_TOKEN,
  });
  await dataGridCapture.init();
  await chartLibraryCapture.init();

  // Run the two captures sequentially, not in parallel — they share GITHUB_SEARCH_TOKEN's
  // 30/min GitHub search-rate budget, so capturing both at once would double the chance of
  // hitting it. Each capture no-ops instantly once its own week is already stored, so this
  // costs nothing once both are up to date.
  async function refreshAllIfDue(): Promise<void> {
    await dataGridCapture
      .refreshIfDue()
      .catch((err) => error('[github-library-usage] Capture failed:', err));
    await chartLibraryCapture
      .refreshIfDue()
      .catch((err) => error('[github-chart-library-usage] Capture failed:', err));
  }

  // Kick off an initial capture in the background if either matrix's snapshot for this week is
  // missing — don't block server startup on the combined GitHub fetch (one rate-limited search
  // per component-library × other-library cell, per matrix — see githubLibraryUsage.ts).
  void refreshAllIfDue();
  setInterval(() => {
    void refreshAllIfDue();
  }, REFRESH_CHECK_INTERVAL_MS);

  // Waits up to INITIAL_CAPTURE_WAIT_MS for `capture`'s in-flight/triggered refresh, then
  // returns regardless — the refresh itself is not cancelled, it just keeps running in the
  // background past the timeout. `.catch()` is attached unconditionally (not just when we're
  // still waiting) so a refresh that fails *after* this function has already returned doesn't
  // surface as an unhandled rejection.
  async function waitForCapture(
    capture: ReturnType<typeof createWeeklyCapture>,
    label: string,
  ): Promise<void> {
    const refreshPromise = capture.refreshIfDue().catch((err) => {
      error(`[${label}] Capture failed:`, err);
    });
    await Promise.race([refreshPromise, sleep(INITIAL_CAPTURE_WAIT_MS)]);
  }

  // GET /api/github-library-usage — the latest captured snapshot's component-library ×
  // data-grid-library adoption matrix (unchanged shape from before weekly history existed).
  app.get('/api/github-library-usage', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (dataGridCapture.getSnapshots().length === 0) {
        // Nothing captured yet (fresh install, or first boot after a filesystem reset) — wait
        // (briefly — see waitForCapture) for the in-flight initial capture rather than
        // answering with an empty matrix outright.
        await waitForCapture(dataGridCapture, 'github-library-usage');
      }
      const latest = dataGridCapture.getSnapshots().at(-1);
      res.json({ rows: latest?.rows ?? [], fetchedAt: latest?.fetchedAt ?? null });
    } catch (err) {
      error('[github-library-usage] Failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/github-library-usage/history — every captured weekly snapshot, ascending by week.
  // Powers the client's week-scrubber panel (see connectors/githubLibraryUsageSource.ts).
  app.get('/api/github-library-usage/history', (_req: Request, res: Response): void => {
    res.json({ snapshots: dataGridCapture.getSnapshots() });
  });

  // GET /api/chart-library-usage(/history) — same shape as the two routes above, for the
  // component-library × chart-library matrix.
  app.get('/api/chart-library-usage', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (chartLibraryCapture.getSnapshots().length === 0) {
        await waitForCapture(chartLibraryCapture, 'github-chart-library-usage');
      }
      const latest = chartLibraryCapture.getSnapshots().at(-1);
      res.json({ rows: latest?.rows ?? [], fetchedAt: latest?.fetchedAt ?? null });
    } catch (err) {
      error('[github-chart-library-usage] Failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/chart-library-usage/history', (_req: Request, res: Response): void => {
    res.json({ snapshots: chartLibraryCapture.getSnapshots() });
  });

  // Health
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      hasGithubSearchToken: Boolean(GITHUB_SEARCH_TOKEN),
      dataGrid: {
        snapshotCount: dataGridCapture.getSnapshots().length,
        latestSnapshotWeek: dataGridCapture.getSnapshots().at(-1)?.weekOf ?? null,
      },
      chartLibrary: {
        snapshotCount: chartLibraryCapture.getSnapshots().length,
        latestSnapshotWeek: chartLibraryCapture.getSnapshots().at(-1)?.weekOf ?? null,
      },
    });
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
    log(`[startup]   Health:            http://localhost:${PORT}/health`);
    log(`[startup]   Data grid API:     http://localhost:${PORT}/api/github-library-usage`);
    log(`[startup]   Data grid history: http://localhost:${PORT}/api/github-library-usage/history`);
    log(`[startup]   Chart API:         http://localhost:${PORT}/api/chart-library-usage`);
    log(`[startup]   Chart history:     http://localhost:${PORT}/api/chart-library-usage/history`);
    if (hasClientBuild) {
      log(`[startup]   Client:            http://localhost:${PORT}/`);
    }
    if (!GITHUB_SEARCH_TOKEN) {
      warn(
        "[startup]   GITHUB_SEARCH_TOKEN not set — captures will produce no rows and won't be persisted.",
      );
    }
  });
}

main().catch((err) => {
  error('[startup] Fatal error:', err);
  process.exit(1);
});
