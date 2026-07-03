/**
 * x-studio example — standalone HTTP server
 *
 * Demonstrates the framework wiring pattern for @mui/x-studio-data-middleware
 * and @mui/x-studio-ai-middleware.
 * This server shows how to:
 *   1. Extract security claims from a JWT (using extractSecurityClaims)
 *   2. Handle a batch of widget queries with tier routing and caching
 *   3. Handle an AI page summary request (POST /api/ai/summary)
 *
 * Running: pnpm server
 *
 * Then open the Vite dev server with ?server=http://localhost:3001/api/sales-data
 * to route widget queries through this server instead of simulatedServer.ts.
 *
 * In a real app:
 *   - Replace the better-sqlite3 DB with your production database (Postgres, MySQL, etc.)
 *   - Configure Knex with your driver and pass it to handleBatchQuery()
 *   - Call extractSecurityClaims() with your real JWT secret
 *   - Set OPENAI_API_KEY (or equivalent) for AI features
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import knexLib from 'knex';
import {
  extractSecurityClaims,
  handleBatchQuery,
  handleMutation,
  LRUCacheProvider,
  MapTierCacheProvider,
} from '@mui/x-studio-data-middleware';
import type { BatchQueryRequest, BatchMutationRequest } from '@mui/x-studio-data-middleware';
import { handlePageSummary, handleAIChat } from '@mui/x-studio-ai-middleware';
import type { PageSummaryRequest, StudioAIRequest } from '@mui/x-studio-ai-middleware';
import { seedDatabase } from './seedDatabase.js';
import { log, error } from './logger.js';

const LLM_ENDPOINT =
  process.env.LLM_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions';
const LLM_API_KEY = process.env.OPENAI_API_KEY ?? '';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const DEMO_JWT_SECRET = process.env.JWT_SECRET ?? 'demo-secret-change-in-production';

const SCHEMA_ALLOWLIST = ['orders', 'order_items', 'customers', 'products', 'shipments', 'shipment_items'];

// ── Database setup ─────────────────────────────────────────────────────────────

const db = knexLib({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
});

log('Seeding in-memory SQLite database…');
await seedDatabase(db);
log('Database ready.\n');

// ── Data + tier caches (shared across requests, reset on process restart) ──────

// Hold an explicit reference so /api/invalidate can call deleteByTag() after
// a mutation — e.g. after a form POST updates the 'orders' table, call
// POST /api/invalidate { table: 'orders' } to evict all cached queries for it.
const dataCache = new LRUCacheProvider();
const tierCache = new MapTierCacheProvider();

// ── Approval gate (shared across chat + approval routes) ───────────────────────

const pendingApprovals = new Map<string, (approved: boolean, reason?: string) => void>();

// ── HTTP server ────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // ── POST /api/ai/chat — agentic AI chat (SSE stream) ─────────────────────
  if (req.url === '/api/ai/chat') {
    log(`→ POST /api/ai/chat`);
    if (!LLM_API_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'OPENAI_API_KEY is not configured. Set it in your environment.',
        }),
      );
      return;
    }
    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody) as StudioAIRequest;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const sseStream = handleAIChat(body, {
        endpoint: LLM_ENDPOINT,
        apiKey: LLM_API_KEY,
        approvalPending: pendingApprovals,
        dataResolver: {
          async resolve(query: string) {
            const rows = await db.raw(query);
            return { rows: rows as Record<string, unknown>[] };
          },
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Readable.fromWeb(sseStream as any).pipe(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      error(`← 500 /api/ai/chat ${message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    }
    return;
  }

  // ── POST /api/ai/approval — resolve a pending tool-approval gate ───────────
  if (req.url === '/api/ai/approval') {
    log(`→ POST /api/ai/approval`);
    try {
      const rawBody = await readBody(req);
      const { id, approved, reason } = JSON.parse(rawBody) as {
        id: string;
        approved: boolean;
        reason?: string;
      };
      const resolve = pendingApprovals.get(id);
      if (resolve) {
        resolve(approved, reason);
        pendingApprovals.delete(id);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      error(`← 500 /api/ai/approval ${message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // ── POST /api/ai/summary — AI page narrative ───────────────────────────────
  if (req.url === '/api/ai/summary') {
    log(`→ POST /api/ai/summary`);
    if (!LLM_API_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'OPENAI_API_KEY is not configured. Set it in your environment.',
        }),
      );
      return;
    }
    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody) as PageSummaryRequest;
      const markdown = await handlePageSummary(body, {
        endpoint: LLM_ENDPOINT,
        apiKey: LLM_API_KEY,
      });
      log(`← 200 /api/ai/summary`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ markdown }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      error(`← 500 /api/ai/summary ${message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // ── POST /api/mutations — write-back mutations (INSERT/UPDATE/DELETE) ─────────
  // Uses the same schemaAllowlist and tenant isolation as /api/sales-data.
  // The handler calls dataCache.deleteByTag(table) after each successful mutation
  // so the next widget batch fetches fresh rows automatically.
  if (req.url === '/api/mutations') {
    log(`→ POST /api/mutations`);
    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody) as BatchMutationRequest;
      let claims;
      try {
        claims = extractSecurityClaims(req.headers.authorization, DEMO_JWT_SECRET);
      } catch {
        claims = { tenantId: 'demo', userId: 'anonymous', roleIds: ['viewer'] };
      }
      const result = await handleMutation(body, claims, {
        db,
        schemaAllowlist: SCHEMA_ALLOWLIST,
        // Allow writes to all non-system columns; expand per-table in production.
        tenantColumn: undefined,
        cacheProvider: dataCache,
      });
      log(`← 200 /api/mutations (${result.results.length} mutations)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      error(`← 500 /api/mutations ${message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // ── POST /api/invalidate — evict cached queries for a table after a write ───
  // Call this from your mutation handlers after any INSERT/UPDATE/DELETE.
  // Example: after writing to 'orders', POST { table: 'orders' } here to
  // force the next widget batch to re-fetch fresh rows from the DB.
  if (req.url === '/api/invalidate') {
    log(`→ POST /api/invalidate`);
    try {
      const rawBody = await readBody(req);
      const { table } = JSON.parse(rawBody) as { table: string };
      if (!table || !SCHEMA_ALLOWLIST.includes(table)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown table: ${table}` }));
        return;
      }
      await dataCache.deleteByTag(table);
      log(`← 200 /api/invalidate (table=${table})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, table }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      error(`← 500 /api/invalidate ${message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url !== '/api/sales-data') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  log(`→ ${req.method} ${req.url}`);

  try {
    const rawBody = await readBody(req);
    const body = JSON.parse(rawBody) as BatchQueryRequest;

    // ── Step 1: Extract and verify JWT security claims ──────────────────────
    let claims;
    try {
      claims = extractSecurityClaims(req.headers.authorization, DEMO_JWT_SECRET);
    } catch {
      // DEV ONLY: fall back to demo claims when no Authorization header is present.
      // Remove this fallback in production — every request must carry a valid JWT.
      claims = { tenantId: 'demo', userId: 'anonymous', roleIds: ['viewer'] };
    }

    // ── Step 2: Handle the batch (tier routing + caching done by the middleware) ──
    const result = await handleBatchQuery(body, claims, {
      db,
      schemaAllowlist: SCHEMA_ALLOWLIST,
      cacheProvider: dataCache,
      tierCacheProvider: tierCache,
    });

    log(`← 200 (${result.results.length} results)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    error(`← 500 ${message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, () => {
  log(`x-studio example server listening on http://localhost:${PORT}`);
  log(`\nOpen the dev server with:`);
  log(`  ?server=http://localhost:${PORT}/api/sales-data\n`);
  log('This routes widget queries through this server (instead of simulatedServer.ts).');
  log('All N widget requests are batched into a single POST via createBatchingAdapter().\n');
});
