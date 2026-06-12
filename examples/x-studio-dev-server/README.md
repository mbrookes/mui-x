# x-studio-dev-server

A local development server for MUI X Studio that combines the data and AI middleware into a single Express app backed by SQLite (or any Knex-compatible database).

## What it does

- **Sales data API** (`POST /api/studio-data`) — serves the Studio sales demo dataset via `@mui/x-studio-data-middleware`. Supports filtering, aggregation, joins, and caching.
- **CRM data API** (`POST /api/crm-data`) — serves the CRM demo dataset (contacts, deals, activities) from a separate database. Demonstrates the multiple-endpoints pattern for cross-source relationships.
- **AI API** (`POST /api/ai/chat`, `/insight`, `/title`, `/widget`) — handles all Studio AI operations through `@mui/x-studio-ai-middleware`. Builds the system prompt, runs the agentic loop, and streams SSE responses back to the client.
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

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3020` | Server port |
| `DB_CLIENT` | `better-sqlite3` | Database driver (`better-sqlite3`, `pg`, `mysql2`) |
| `DB_FILENAME` | `./sales.db` | SQLite file path (sales DB) |
| `CRM_DB_FILENAME` | `./crm.db` | SQLite file path (CRM DB) |
| `CRM_DB_NAME` | `<DB_NAME>_crm` | Database name for CRM (PostgreSQL/MySQL) |
| `SEED_ORDER_COUNT` | `500` | Number of orders to generate on seed |
| `LLM_API_KEY` | — | OpenAI-compatible API key (required for AI features) |
| `LLM_ENDPOINT` | `https://api.openai.com/v1/chat/completions` | LLM endpoint URL |
| `LLM_MODEL` | `gpt-4o` | Model name |
| `JWT_SECRET` | `dev-secret-change-in-production` | Secret for signing dev JWTs |
| `STUDIO_TOKEN` | — | If set, all API requests must include `Authorization: Bearer <token>` |
| `ALLOWED_ORIGINS` | `http://localhost:3004,...` | CORS allowed origins (comma-separated) |

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
```

### `POST /api/studio-data`

Accepts a Studio batch query request body targeting the sales database and returns query results.

### `POST /api/ai/chat`

Accepts a Studio AI chat request and streams SSE responses. Requires `LLM_API_KEY`.

### `GET /api/dev-token`

Returns a signed JWT for development use (only available when `STUDIO_TOKEN` is not set).

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
```

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

```
x-studio-dev-server
  ├── @mui/x-studio-ai-middleware   (system prompt, agentic loop, tool execution)
  ├── @mui/x-studio-data-middleware (batch query handler, security, caching)
  │     ├── sales DB (SQLite / pg / mysql2)   → POST /api/studio-data
  │     └── CRM DB   (separate connection)    → POST /api/crm-data
  └── x-studio-shared               (sales + CRM data generators)
```

The server has **no dependency on `@mui/x-studio`** — it only imports from the two middleware packages and the shared data generator. This means it can run in any Node.js environment without any React or browser dependencies.

The CRM and sales databases use separate Knex instances so they can point to different files or even different database engines. Widgets connecting a CRM source to a sales source will log a dev-mode warning because SQL JOINs cannot span separate database connections.
