---
title: Studio - MCP server
description: Expose x-studio AI tools and dashboard state to any MCP client (Claude Desktop, Cursor, etc.) via the Model Context Protocol.
---

# Studio - MCP server

<p class="description">Expose x-studio AI tools and dashboard state to any MCP client — Claude Desktop, Cursor, or your own tooling — via the <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`buildStudioMcpServer` (from `@mui/x-studio-ai-middleware`) creates a pre-configured MCP `Server` that exposes:

- All x-studio AI **tools** (add widget, update widget, filter, etc.)
- The current **dashboard state** and **AI system prompt** as readable resources
- **Schema discovery** — field definitions for every data source
- **Raw data preview** and **row count health check** (when a data resolver is configured)
- A `query_data_source_examples` **prompt** with ready-to-use query templates
- **URI autocomplete** for `studio://schema/` and `studio://data/` URIs

Each MCP session gets its own isolated `StudioStateBox`. Tool calls mutate that session's state in memory.

## Setup

### 1. Install dependencies

```bash
npm install @mui/x-studio-ai-middleware @modelcontextprotocol/sdk
```

### 2. Create a Streamable HTTP route

The following example uses Express. The same pattern works with any Node.js framework.

```ts
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  buildStudioMcpServer,
  createDefaultStudioState,
  type StudioStateBox,
} from '@mui/x-studio-ai-middleware';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const router = express.Router();

// One transport + stateBox per MCP session
const transports: Record<string, StreamableHTTPServerTransport> = {};
const stateBoxes: Record<string, StudioStateBox> = {};

// POST — tool calls and session initialization
router.post('/', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const stateBox: StudioStateBox = { current: createDefaultStudioState() };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
        stateBoxes[sid] = stateBox;
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        delete transports[sid];
        delete stateBoxes[sid];
      }
    };
    await buildStudioMcpServer(stateBox).connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({ error: 'Invalid MCP request' });
});

// GET — SSE stream for server-initiated notifications (subscriptions)
router.get('/', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).json({ error: 'Unknown session' });
  }
});

// DELETE — explicit session termination
router.delete('/', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].close();
    res.status(204).end();
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});
```

Mount this router at `/api/mcp` (or any path you prefer).

### 3. Connect a client

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "x-studio": {
      "url": "http://localhost:3020/api/mcp"
    }
  }
}
```

#### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "x-studio": {
      "url": "http://localhost:3020/api/mcp"
    }
  }
}
```

## `buildStudioMcpServer` options

```ts
const server = buildStudioMcpServer(stateBox, options);
```

| Option                 | Type                                            | Default                    | Description                                                                                                                                                                                                          |
| :--------------------- | :---------------------------------------------- | :------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverName`           | `string`                                        | `'x-studio'`               | Name reported in MCP `initialize` response                                                                                                                                                                           |
| `serverVersion`        | `string`                                        | `'1.0.0'`                  | Version reported in MCP `initialize` response                                                                                                                                                                        |
| `allowedTools`         | `string[]`                                      | all except `execute_query` | Exact list of tool names to expose                                                                                                                                                                                   |
| `customWidgets`        | `StudioCustomWidgetDef[]`                       | `[]`                       | Custom widget definitions                                                                                                                                                                                            |
| `data.queryDataSource` | `(params) => Promise<result>`                   | —                          | Enables `query_data_source` and the data-analysis tools; required for `summarise_page` synthesis                                                                                                                     |
| `data.maxQueryRows`    | `number`                                        | `1000`                     | Hard upper bound on rows the `query_data_source` tool may fetch. The model-supplied `limit` is clamped to this value before any DB query.                                                                            |
| `onStateChange`        | `(state: StudioState) => void \| Promise<void>` | —                          | Called after every mutating tool call. Use to persist the session state (see [Enabling data queries](#enabling-data-queries)).                                                                                       |
| `contextEnricher`      | `(args) => StudioAIEnrichedContext`             | —                          | Attach DB-side metadata (row counts per dimension value, schema comments) to the system-prompt resource. Runs on each read; rendered into a `<server_context>` block. Best-effort — failures are logged and skipped. |

`execute_query` (raw SQL) is excluded by default — opt in explicitly via `allowedTools`. The data-analysis tools (`describe_data_source`, `get_field_values`, `compute_field_stats`) are only useful when `data.queryDataSource` is configured.

## MCP resources

| URI                                | Description                                                                                                                                           |
| :--------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studio://dashboard/state`         | Full dashboard JSON (pages, widgets, sources, filters)                                                                                                |
| `studio://dashboard/system-prompt` | AI system prompt built from the current dashboard state, including the active page's layout and cross-filter graph, plus any `contextEnricher` output |
| `studio://dashboard/data-health`   | Row counts per data source (requires `data` option)                                                                                                   |
| `studio://schema/{sourceId}`       | Field definitions: type, format, defaultAggregationFn, sample values                                                                                  |
| `studio://data/{sourceId}`         | Raw row preview — up to 20 rows (requires `data` option)                                                                                              |

### Subscriptions

All resources support `resources/subscribe`. Subscribe to `studio://dashboard/state` to receive a `notifications/resources/updated` notification whenever a tool call mutates the dashboard:

```ts
// MCP client code
await client.subscribeResource('studio://dashboard/state');
client.on('notification', (n) => {
  if (n.method === 'notifications/resources/updated') {
    // Re-read the resource to get the latest state
    const state = await client.readResource('studio://dashboard/state');
  }
});
```

### URI autocomplete

Type `studio://schema/` or `studio://data/` in an MCP client that supports `completion/complete` to get source ID completions based on the current dashboard state.

## MCP tools

All built-in Studio AI tools are available in the MCP server. The following tools are additionally registered by `buildStudioMcpServer` and are only available via MCP (not the chat assistant):

| Tool                   | Requires `data` | Description                                                                                                         |
| :--------------------- | :-------------- | :------------------------------------------------------------------------------------------------------------------ |
| `list_pages`           | No              | Returns all page IDs and titles in the current dashboard                                                            |
| `get_recent_changes`   | No              | Returns a time-ordered log of changes made in this MCP session (such as `addWidget:chart:w1` or `addFilter:region`) |
| `describe_data_source` | Yes             | Returns field definitions, row count, sample rows, and per-field stats for a source                                 |
| `get_field_values`     | Yes             | Returns distinct values and counts for a field (useful for filter suggestions)                                      |
| `compute_field_stats`  | Yes             | Returns full-table min/max/avg/sum/count for numeric fields across a source                                         |

These tools give an MCP client (Claude Desktop, Cursor, etc.) the ability to explore and analyze data without needing to know the schema in advance. `describe_data_source`, `get_field_values`, and `compute_field_stats` require `data.queryDataSource` to be configured.

`get_recent_changes` returns only the changes made through the current MCP session — it does not reflect edits a user makes in a separate browser session, which run in a different process with separate state.

## MCP prompts

| Name                         | Description                                                                                                                          |
| :--------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| `query_data_source_examples` | Auto-generated query templates for every configured data source. Pass an optional `sourceId` to scope the output to a single source. |

Use `prompts/get` with `name: "query_data_source_examples"` to get ready-to-use `query_data_source` invocations with correct field names and aggregation functions.

## Enabling data queries

To enable the `query_data_source` tool and data resources, supply a `queryDataSource` callback that routes queries to your database:

```ts
import { handleBatchQuery } from '@mui/x-studio-data-middleware';

const server = buildStudioMcpServer(stateBox, {
  data: {
    queryDataSource: async (params) => {
      const result = await handleBatchQuery(
        {
          pageId: 'mcp',
          widgets: [
            {
              id: 'q',
              table: params.tableName,
              columns: params.columns,
              filters: params.filters as any,
              aggregations: params.aggregations as any,
              orderBy: params.orderBy as any,
              limit: params.limit,
            },
          ],
        },
        claims,
        { db, schemaAllowlist },
      );
      const r = result.results[0];
      return { rows: r.rows, rowCount: r.rowCount };
    },
  },
});
```

The `queryDataSource` callback is responsible for security, authentication, and DB routing. The `@mui/x-studio-ai-middleware` package itself has no database dependency.

## See also

- [AI assistant setup](/x/react-studio/ai/setup/) — configure the chat assistant
- [AI tools](/x/react-studio/ai/tools/) — full tool reference
- [`@mui/x-studio-ai-middleware`](https://github.com/mui/mui-x/tree/master/packages/x-studio-ai-middleware) — server-side handler package
- [`examples/x-studio-dev-server`](https://github.com/mui/mui-x/tree/master/examples/x-studio-dev-server) — full working example with MCP, data middleware, and CRM data
