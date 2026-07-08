/**
 * API server for the x-studio GitHub library-usage example.
 *
 * Proxies GitHub's code-search API server-side so the personal access token
 * never ships to the browser — GitHub code search requires authentication,
 * and baking a token into the client bundle via a VITE_ env var would expose
 * it to anyone who loads the page. Also serves the built static client when
 * present, so a single Railway service can host both (see railway.toml).
 *
 * Captures one snapshot of the library-usage matrix per ISO week and persists
 * it via snapshotStore.ts, so /api/github-library-usage/history can drive a
 * "scrub through time" view on the client. See snapshotStore.ts for the
 * durability caveat on Railway (or any host with an ephemeral filesystem).
 *
 * Environment variables:
 *   PORT                — HTTP port (default 3006)
 *   GITHUB_SEARCH_TOKEN  — GitHub personal access token used for code search.
 *                          Without it, a capture produces no rows and is not
 *                          persisted (so it doesn't poison history with an
 *                          all-zero week — see refreshIfDue below).
 *   SNAPSHOT_STORE_PATH  — Where weekly snapshots are persisted (default
 *                          ./data/library-usage-history.json — see
 *                          snapshotStore.ts).
 *   ALLOWED_ORIGINS      — Comma-separated CORS origins for the /api routes
 *                          (the server's own origin is always allowed, so
 *                          this only needs to list *other* origins, e.g. a
 *                          separate Vite dev server).
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
import {
  getIsoWeekMonday,
  loadSnapshots,
  saveSnapshot,
  type LibraryUsageSnapshot,
} from './snapshotStore.js';
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

// Re-check periodically whether a new ISO week has started since the last capture. This is a
// "poll for due work" interval, not a precise cron — "due" is derived from persisted snapshots
// (see refreshIfDue), so it self-heals across restarts/redeploys regardless of exact timing.
const REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

  let snapshots: LibraryUsageSnapshot[] = await loadSnapshots();
  let refreshInFlight: Promise<void> | null = null;

  // Fetches a fresh matrix and persists it as this week's snapshot, but only if one isn't
  // already stored for the current ISO week (so redeploys/restarts don't waste GitHub's rate
  // limit re-capturing a week that's already done). A run where every cell failed (no token
  // configured, or every search errored — see LibraryUsageMatrixResult.failedCount) is
  // deliberately NOT persisted — better to keep serving last week's real numbers than to
  // overwrite them with a false all-zero snapshot. Note this only catches a FULLY failed run:
  // if some cells succeeded and others didn't, the partial result still gets saved (those
  // failed cells read as a real 0 until the next capture) — the same trade-off the live
  // /api/github-library-usage endpoint already accepted before weekly history existed.
  async function refreshIfDue(): Promise<void> {
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      const currentWeek = getIsoWeekMonday(new Date());
      if (snapshots.some((s) => s.weekOf === currentWeek)) {
        return;
      }
      log(`[github-library-usage] Capturing snapshot for week of ${currentWeek}…`);
      const { rows, failedCount } = await fetchLibraryUsageMatrix(GITHUB_SEARCH_TOKEN);
      if (rows.length === 0 || failedCount === rows.length) {
        warn(
          `[github-library-usage] Capture for week of ${currentWeek} produced no usable rows ` +
            `(${failedCount}/${rows.length} cells failed) — not persisting.`,
        );
        return;
      }
      snapshots = await saveSnapshot({ weekOf: currentWeek, fetchedAt: Date.now(), rows });
    })();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  // Kick off an initial capture in the background if this week's snapshot is missing — don't
  // block server startup on a ~1min GitHub fetch (24 rate-limited searches — see
  // githubLibraryUsage.ts).
  refreshIfDue().catch((err) => error('[github-library-usage] Initial capture failed:', err));
  setInterval(() => {
    refreshIfDue().catch((err) => error('[github-library-usage] Scheduled capture failed:', err));
  }, REFRESH_CHECK_INTERVAL_MS);

  // GET /api/github-library-usage — the latest captured snapshot's component-library ×
  // data-grid-library adoption matrix (unchanged shape from before weekly history existed).
  app.get('/api/github-library-usage', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (snapshots.length === 0) {
        // Nothing captured yet (fresh install, or first boot after a filesystem reset) — wait
        // for the in-flight initial capture rather than answering with an empty matrix.
        await refreshIfDue();
      }
      const latest = snapshots.at(-1);
      res.json({ rows: latest?.rows ?? [], fetchedAt: latest?.fetchedAt ?? null });
    } catch (err) {
      error('[github-library-usage] Failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/github-library-usage/history — every captured weekly snapshot, ascending by week.
  // Powers the client's week-scrubber panel (see connectors/githubLibraryUsageSource.ts).
  app.get('/api/github-library-usage/history', (_req: Request, res: Response): void => {
    res.json({ snapshots });
  });

  // Health
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      hasGithubSearchToken: Boolean(GITHUB_SEARCH_TOKEN),
      snapshotCount: snapshots.length,
      latestSnapshotWeek: snapshots.at(-1)?.weekOf ?? null,
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
    log(`[startup]   Health:  http://localhost:${PORT}/health`);
    log(`[startup]   API:     http://localhost:${PORT}/api/github-library-usage`);
    log(`[startup]   History: http://localhost:${PORT}/api/github-library-usage/history`);
    if (hasClientBuild) {
      log(`[startup]   Client:  http://localhost:${PORT}/`);
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
