# x-studio-dev-server

A local development server for MUI X Studio that combines the data and AI middleware into a single Express app backed by SQLite (or any Knex-compatible database).

## What it does

- **Sales data API** (`POST /api/studio-data`) — serves the Studio sales demo dataset via `@mui/x-studio-data-middleware`. Supports filtering, aggregation, joins, and caching.
- **CRM data API** (`POST /api/crm-data`) — serves the CRM demo dataset (contacts, deals, activities) from a separate database. Demonstrates the multiple-endpoints pattern for cross-source relationships.
- **AI API** (`POST /api/ai/chat`, `/insight`, `/title`, `/widget`) — handles all Studio AI operations through `@mui/x-studio-ai-middleware`. Builds the system prompt, runs the agentic loop, and streams SSE responses back to the client.
- **MCP server** (`POST|GET|DELETE /api/mcp`) — exposes all x-studio AI tools via the [Model Context Protocol](https://modelcontextprotocol.io/), allowing Claude Desktop, Cursor, and other MCP clients to manipulate dashboards programmatically without a browser.
- **Auto-seeds** on first run using the `x-studio-shared` data generator. Re-seed anytime with `--reseed`.
- **SQLite by default** — no database setup required. Configurable for PostgreSQL or MySQL via `.env.local`.

## Quick start

```bash
# 1. Copy the example env file
cp .env.example .env.local

# 2. Set your LLM API key
echo "LLM_API_KEY=sk-..." >> .env.local

# 3. Install and start
pnpm install
pnpm dev
```

The server starts at `http://localhost:3020` and seeds the database on first run.

## Configuration

All configuration is done via environment variables. See `.env.example` for the full list.

| Variable           | Default                                      | Description                                                           |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------------- |
| `PORT`             | `3020`                                       | Server port                                                           |
| `DB_CLIENT`        | `better-sqlite3`                             | Database driver (`better-sqlite3`, `pg`, `mysql2`)                    |
| `DB_FILENAME`      | `./sales.db`                                 | SQLite file path (sales DB)                                           |
| `CRM_DB_FILENAME`  | `./crm.db`                                   | SQLite file path (CRM DB)                                             |
| `CRM_DB_NAME`      | `<DB_NAME>_crm`                              | Database name for CRM (PostgreSQL/MySQL)                              |
| `SEED_ORDER_COUNT` | `500`                                        | Number of orders to generate on seed                                  |
| `LLM_API_KEY`      | —                                            | OpenAI-compatible API key (required for AI features)                  |
| `LLM_ENDPOINT`     | `https://api.openai.com/v1/chat/completions` | LLM endpoint URL                                                      |
| `LLM_MODEL`        | `gpt-4o`                                     | Model name                                                            |
| `JWT_SECRET`       | `dev-secret-change-in-production`            | Secret for signing dev JWTs                                           |
| `STUDIO_TOKEN`     | —                                            | If set, all API requests must include `Authorization: Bearer <token>` |
| `ALLOWED_ORIGINS`  | `http://localhost:3004,...`                  | CORS allowed origins (comma-separated)                                |

## Scripts

```bash
pnpm dev          # Start with tsx watch (auto-restart on changes)
pnpm start        # Start once (no watch)
pnpm start -- --reseed   # Drop all data and re-seed from scratch
pnpm typecheck    # TypeScript type checking
```

## API endpoints

### `GET /health`

Returns server status, database connectivity, and row counts.

```json
{
  "status": "ok",
  "db": "connected",
  "seeded": true,
  "rowCounts": {
    "customers": 50,
    "products": 24,
    "orders": 500,
    "order_items": 1247,
    "shipments": 480,
    "shipment_items": 1247
  }
}
```

### `POST /api/crm-data`

Accepts a Studio batch query request body targeting the CRM database and returns query results.
Available tables: `contacts`, `deals`, `activities`.

### `POST /api/ai/insight`

Accepts a widget insight request and returns a non-streaming AI-generated insight for a widget.

### `POST /api/ai/title`

Accepts a conversation history and returns a short AI-generated title for the chat session.

### `POST /api/ai/widget`

Accepts a natural-language description and returns an AI-generated widget configuration.

````

### `POST /api/studio-data`

Accepts a Studio batch query request body targeting the sales database and returns query results.

### `POST /api/ai/chat`

Accepts a Studio AI chat request and streams SSE responses. Requires `LLM_API_KEY`.

### `GET /api/dev-token`

Returns a signed JWT for development use (only available when `STUDIO_TOKEN` is not set).

## MCP server

The dev server exposes an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) endpoint at `/api/mcp` that lets MCP-capable clients — such as Claude Desktop, Cursor, and other AI agents — manipulate x-studio dashboards without a browser.

### Available MCP tools

All x-studio AI tools are registered except `summarise_page` (which requires live client-side row data):

| Tool | Description |
| ---- | ----------- |
| `add_widget` | Add a new widget to a page |
| `update_widget` | Update an existing widget's configuration |
| `remove_widget` | Remove a widget from a page |
| `add_page` | Add a new page to the dashboard |
| `remove_page` | Remove a page from the dashboard |
| `update_page` | Update a page's metadata |
| `reorder_pages` | Reorder pages in the dashboard |
| `add_data_source` | Register a new data source |
| `update_data_source` | Update an existing data source |
| `remove_data_source` | Remove a data source |
| `add_filter` | Add a global filter to the dashboard |
| `update_filter` | Update a global filter |
| `remove_filter` | Remove a global filter |
| `move_widget` | Move a widget to a different position or page |

### Available MCP resources

| URI | Description |
| --- | ----------- |
| `studio://dashboard/state` | Full dashboard JSON (pages, widgets, sources, filters) |
| `studio://dashboard/system-prompt` | AI system prompt built from current dashboard state |

### Claude Desktop configuration

Add this to your `claude_desktop_config.json` (usually `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "x-studio": {
      "url": "http://localhost:3020/api/mcp"
    }
  }
}
```

Each Claude conversation gets its own isolated dashboard session. Tool calls mutate that session's state in memory — changes are not persisted to the SQLite database.

### Custom MCP server

The factory function `buildStudioMcpServer` is exported from `@mui/x-studio-ai-middleware`, so you can embed it in your own Express server with just a few lines:

```ts
import { buildStudioMcpServer, createDefaultStudioState, type StudioStateBox } from '@mui/x-studio-ai-middleware';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const transports: Record<string, StreamableHTTPServerTransport> = {};
const stateBoxes: Record<string, StudioStateBox> = {};

router.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }
  if (!sessionId && isInitializeRequest(req.body)) {
    const stateBox: StudioStateBox = { current: createDefaultStudioState() };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { transports[sid] = transport; stateBoxes[sid] = stateBox; },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) { delete transports[sid]; delete stateBoxes[sid]; }
    };
    await buildStudioMcpServer(stateBox).connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }
  res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null });
});
```

See `src/routes/mcp.ts` for the complete implementation.

## Database

### SQLite (default)

No setup needed. The database file is created automatically at `DB_FILENAME` (default: `./sales.db`).

> **macOS note:** `better-sqlite3` requires Xcode Command Line Tools to build its native module. If you see a build error during `pnpm install`, run:
> ```bash
> xcode-select --install
> pnpm install
> ```
> Alternatively, use PostgreSQL or MySQL instead.

### PostgreSQL

```env
DB_CLIENT=pg
DB_HOST=localhost
DB_PORT=5432
DB_NAME=studio
DB_USER=studio
DB_PASSWORD=studio
````

### MySQL / MariaDB

```env
DB_CLIENT=mysql2
DB_HOST=localhost
DB_PORT=3306
DB_NAME=studio
DB_USER=studio
DB_PASSWORD=studio
```

## Architecture

```text
x-studio-dev-server
  ├── @mui/x-studio-ai-middleware   (system prompt, agentic loop, tool execution, MCP factory)
  ├── @mui/x-studio-data-middleware (batch query handler, security, caching)
  │     ├── sales DB (SQLite / pg / mysql2)   → POST /api/studio-data
  │     └── CRM DB   (separate connection)    → POST /api/crm-data
  └── x-studio-shared               (sales + CRM data generators)
```

The server has **no dependency on `@mui/x-studio`** — it only imports from the two middleware packages and the shared data generator. This means it can run in any Node.js environment without any React or browser dependencies.

The CRM and sales databases use separate Knex instances so they can point to different files or even different database engines. Widgets connecting a CRM source to a sales source will log a dev-mode warning because SQL JOINs cannot span separate database connections.
