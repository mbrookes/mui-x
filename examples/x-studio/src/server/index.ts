/**
 * x-studio example — standalone HTTP server
 *
 * Demonstrates the framework wiring pattern for @mui/x-studio-data-middleware.
 * This server shows how to:
 *   1. Extract security claims from a JWT (using extractSecurityClaims)
 *   2. Generate a security-scoped server-side cache key
 *   3. Handle a batch of widget queries with tenant isolation
 *
 * Running: NODE_OPTIONS='--experimental-sqlite --no-warnings' pnpm server
 *
 * Then open the Vite dev server with ?server=http://localhost:3001/api/studio-data
 * to route widget queries through this server instead of simulatedServer.ts.
 *
 * In a real app:
 *   - Replace the node:sqlite DB with your production database (Postgres, MySQL, etc.)
 *   - Configure Knex with your driver and pass it to handleBatchQuery()
 *   - Call extractSecurityClaims() with your real JWT secret
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { extractSecurityClaims, generateCacheKey, LRUCacheProvider } from '@mui/x-studio-data-middleware';
import type { BatchQueryRequest, JwtSecurityClaims } from '@mui/x-studio-data-middleware';
import { seedDatabase } from './seedDatabase.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const DEMO_JWT_SECRET = process.env.JWT_SECRET ?? 'demo-secret-change-in-production';

const SCHEMA_ALLOWLIST = ['orders', 'order_items', 'customers', 'products'];

/** Derive a SQL table name from a Studio source ID (e.g. "source-order-items" → "order_items") */
function sourceIdToTable(sourceId: string): string {
  return sourceId.replace(/^source-/, '').replace(/-/g, '_');
}

// ── Database setup ─────────────────────────────────────────────────────────────

console.log('Seeding in-memory SQLite database…');
const db = new DatabaseSync(':memory:');
seedDatabase(db);
console.log('Database ready.\n');

// ── Cache setup ────────────────────────────────────────────────────────────────

const cache = new LRUCacheProvider({ maxSizeBytes: 64 * 1024 * 1024, ttlMs: 30_000 });

// ── Query execution ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function executeQuery(
  claims: JwtSecurityClaims,
  sourceId: string,
  filters: BatchQueryRequest['widgets'][0]['filters'],
): Row[] {
  // Resolve source ID to SQL table name (e.g. "source-order-items" → "order_items")
  const table = sourceIdToTable(sourceId);

  if (!SCHEMA_ALLOWLIST.includes(table)) {
    // Unknown / unsupported source — return empty rows (safe fallback, not a 500)
    console.warn(`[server] Unknown source "${sourceId}" — returning empty rows`);
    return [];
  }

  // Build SQL with parameterized bindings (never string concatenation)
  const conditions: string[] = [];
  const params: unknown[] = [];

  // ── Security predicates FIRST (non-negotiable) ──────────────────────────
  if (table === 'orders' || table === 'order_items') {
    // Demo: demo tenant sees all rows; in production, add tenant_id column
    conditions.push('1 = 1');
  }

  // ── User filter predicates ───────────────────────────────────────────────
  for (const f of filters ?? []) {
    switch (f.operator) {
      case 'eq':
        conditions.push(`${f.column} = ?`);
        params.push(f.value);
        break;
      case 'in':
        if (Array.isArray(f.value) && f.value.length > 0) {
          conditions.push(`${f.column} IN (${f.value.map(() => '?').join(', ')})`);
          params.push(...f.value);
        }
        break;
      case 'gte':
        conditions.push(`${f.column} >= ?`);
        params.push(f.value);
        break;
      case 'lte':
        conditions.push(`${f.column} <= ?`);
        params.push(f.value);
        break;
      default:
        break;
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM ${table} ${where} LIMIT 10000`;
  // node:sqlite's SQLInputValue is string | number | bigint | null | Uint8Array
  return db.prepare(sql).all(...(params as Parameters<typeof db.prepare>[0][])) as Row[];
}

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

  if (req.method !== 'POST' || req.url !== '/api/studio-data') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  try {
    const rawBody = await readBody(req);
    const body = JSON.parse(rawBody) as BatchQueryRequest;

    // ── Step 1: Extract and verify JWT security claims ──────────────────────
    let claims: JwtSecurityClaims;
    try {
      claims = extractSecurityClaims(req.headers.authorization, DEMO_JWT_SECRET);
    } catch {
      // DEV ONLY: fall back to demo claims when no Authorization header is present.
      // Remove this fallback in production — every request must carry a valid JWT.
      claims = { tenantId: 'demo', userId: 'anonymous', roleIds: ['viewer'] };
    }

    // ── Step 2: Handle each widget in the batch ─────────────────────────────
    const results = await Promise.all(
      body.widgets.map(async (widget: BatchQueryRequest['widgets'][0]) => {
        // Check security-scoped server-side cache
        const cacheKey = generateCacheKey(claims, widget);
        const cached = await cache.get(cacheKey);
        if (cached) {
          return {
            id: widget.id,
            rows: cached.rows,
            tier: 'server' as const,
            rowCount: cached.rows.length,
          };
        }

        const rows = executeQuery(claims, widget.table, widget.filters);
        await cache.set(cacheKey, { rows, cachedAt: Date.now() });
        return { id: widget.id, rows, tier: 'client' as const, rowCount: rows.length };
      }),
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pageId: body.pageId, results }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[server] Error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, () => {
  console.log(`x-studio example server listening on http://localhost:${PORT}`);
  console.log(`\nOpen the dev server with:`);
  console.log(`  ?server=http://localhost:${PORT}/api/studio-data\n`);
  console.log('This routes widget queries through this server (instead of simulatedServer.ts).');
  console.log(
    'All N widget requests are batched into a single POST via createBatchingAdapter().\n',
  );
});
