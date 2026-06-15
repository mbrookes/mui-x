# @mui/x-studio-ai-middleware

Server-side AI handler for MUI X Studio.

Provides a pure-function `handleAIChat` handler that:

- Receives the user's message and current dashboard state from the client
- Builds the system prompt server-side (the LLM API key never reaches the browser)
- Runs the full agentic tool loop against the LLM
- Streams state-mutation events back to the client via Server-Sent Events

The client applies mutations to its local `StudioController` as they arrive,
so the dashboard updates in real time while keeping the business logic on the server.

---

## When to use this package

| Scenario                        | Recommended approach                                                                      |
| :------------------------------ | :---------------------------------------------------------------------------------------- |
| Local development / prototyping | Use [`examples/x-studio-dev-server`](../../examples/x-studio-dev-server) — zero config    |
| Production — simple proxy       | Point `endpoint` at a route that adds the API key and calls `@mui/x-studio-ai-middleware` |
| **Production — full backend**   | **Use `@mui/x-studio-ai-middleware`** — key and all AI logic stay server-side             |

---

## Installation

```bash
npm install @mui/x-studio-ai-middleware
# or
pnpm add @mui/x-studio-ai-middleware
```

No React peer dependencies — runs in any Node.js environment.

---

## Quick start

### 1. Create a server route

The handler is a pure function — no HTTP framework required.
Wrap it in whatever route handler your framework uses.

#### Next.js App Router

```ts
// app/api/ai/chat/route.ts
import { handleAIChat } from '@mui/x-studio-ai-middleware';

export async function POST(req: Request) {
  const body = await req.json();

  const stream = handleAIChat(body, {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o',
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

#### Express

```ts
import express from 'express';
import { Readable } from 'stream';
import { handleAIChat } from '@mui/x-studio-ai-middleware';

const app = express();
app.use(express.json());

app.post('/api/ai/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = handleAIChat(req.body, {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.OPENAI_API_KEY,
  });

  Readable.fromWeb(stream as import('stream/web').ReadableStream).pipe(res);
});
```

#### Hono (Cloudflare Workers / Bun)

```ts
import { Hono } from 'hono';
import { handleAIChat } from '@mui/x-studio-ai-middleware';

const app = new Hono();

app.post('/api/ai/chat', async (c) => {
  const body = await c.req.json();
  const stream = handleAIChat(body, {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: c.env.OPENAI_API_KEY,
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
});
```

### 2. Configure the client

Point `StudioAIConfig.endpoint` at the **base URL** of your backend AI routes.
Studio appends `/chat`, `/insight`, `/title`, and `/widget` automatically:

```tsx
import type { StudioAIConfig } from '@mui/x-studio';

const aiConfig: StudioAIConfig = {
  endpoint: '/api/ai', // /chat, /insight, /title, /widget are appended automatically
};

// Pass to <Studio> or <StudioChatPanel> as normal
<Studio aiConfig={aiConfig} initialState={initialState} />;
```

No `apiKey` in the client — the key stays in your server environment variable.

---

## Authentication

The backend route should authenticate the caller before forwarding to the LLM.
Pass a short-lived session token from the client and verify it server-side:

```ts
// Client
const aiConfig: StudioAIConfig = {
  endpoint: '/api/ai',
  headers: { 'X-Session-Token': await getSessionToken() },
};

// Server (Next.js example)
export async function POST(req: Request) {
  const token = req.headers.get('X-Session-Token');
  const session = await verifyToken(token);
  if (!session) return new Response('Unauthorized', { status: 401 });

  const body = await req.json();
  const stream = handleAIChat(body, {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.OPENAI_API_KEY,
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
```

---

## API reference

### `handleAIChat(body, options)`

The main entry point. A pure function — no side effects, no global state.

```ts
function handleAIChat(
  body: StudioAIRequest,
  options: StudioAIHandlerOptions,
): ReadableStream<string>;
```

#### `StudioAIRequest`

The JSON body posted by the client:

```ts
interface StudioAIRequest {
  /** Full conversation history. */
  messages: ChatMessage[];
  /** Current dashboard state snapshot. */
  dashboardState: StudioState;
  /** Custom widget definitions (optional). */
  customWidgets?: StudioCustomWidgetDef[];
  /** Widget ID the AI should focus on (optional). */
  focusedWidgetId?: string;
  /** Whitelist of built-in tool names. All tools enabled when omitted. */
  allowedTools?: string[];
  /** Serialized skills (optional). */
  skills?: SerializableSkill[];
}
```

#### `StudioAIHandlerOptions`

Server-side options:

```ts
interface StudioAIHandlerOptions {
  /** OpenAI-compatible completions endpoint. */
  endpoint: string;
  /** LLM API key. Never expose this to the client. */
  apiKey?: string;
  /** Model to use. Default: 'gpt-4o'. */
  model?: string;
  /** Additional HTTP headers forwarded to the LLM. */
  headers?: Record<string, string>;
  /** Called when a tool throws. Use for logging. */
  onToolError?: (toolName: string, error: Error) => void;
  /** AbortSignal for request cancellation. */
  signal?: AbortSignal;
}
```

---

## SSE event types

The handler streams `StudioAISSEEvent` objects, each encoded as `data: <JSON>\n\n`:

| Event type         | When emitted                         | Payload                                            |
| :----------------- | :----------------------------------- | :------------------------------------------------- |
| `text-delta`       | Each LLM text token                  | `{ delta: string }`                                |
| `tool-activity`    | Tool call starts / completes         | `{ toolCallId, toolName, phase, input?, output? }` |
| `state-mutation`   | After each state-changing tool       | `{ mutation: StateMutation }`                      |
| `client-tool-call` | Client-handler skill called by model | `{ toolCallId, toolName, input }` _(v2)_           |
| `finish`           | Model done                           | `{ finishReason: string }`                         |
| `error`            | Unrecoverable error                  | `{ message: string }`                              |

The client adapter handles all these automatically.
You do not need to parse SSE events yourself unless you are building a custom adapter.

---

## State mutations

Write tools produce `StateMutation` objects that map 1:1 to `StudioController` methods.
The client's `applyStateMutation` helper applies them automatically.

```ts
type StateMutation =
  | { type: 'addPage'; args: { id: string; title: string } }
  | { type: 'setDashboardTitle'; args: { title: string } }
  | { type: 'addWidget'; args: { widget: StudioWidget } }
  | { type: 'updateWidget'; args: { widgetId: string; changes?: ...; config?: ... } }
  | { type: 'removeWidget'; args: { widgetId: string } }
  | { type: 'setWidgetLayout'; args: { rows: string[][] } }
  | { type: 'setWidgetColSpan'; args: { widgetId, columns, rowWidgetIds } }
  | { type: 'renamePage'; args: { pageId: string; title: string } }
  | { type: 'removePage'; args: { pageId: string } }
  | { type: 'setActivePage'; args: { pageId: string } }
  | { type: 'addFilter'; args: { filter: StudioFilterState } }
  | { type: 'removeFilter'; args: { filterId: string } }
  | { type: 'applyBulkUpdate'; args: { widgets, widgetRows, widgetColSpans, activePageId } };
```

---

## Advanced: custom agentic loop

For custom server architectures, you can use the lower-level `runAgenticLoop` generator directly:

```ts
import { runAgenticLoop } from '@mui/x-studio-ai-middleware';

for await (const event of runAgenticLoop(
  messages,
  state,
  customWidgets,
  undefined,
  undefined,
  undefined,
  options,
)) {
  if (event.type === 'state-mutation') {
    // store or forward the mutation
  }
}
```

---

## Skills

Skills work in backend mode with the following caveats:

- **`instruction-only` skills**: fully supported — the prompt fragment is built server-side.
- **`client-handler` skills**: the tool definition is sent to the LLM server-side. If the model calls the tool, a `client-tool-call` event is emitted _(not yet handled by the default client adapter — v2 feature)_.

Pass skills as serialized metadata from the client in `StudioAIRequest.skills`.
The client adapter (`studioBackendAdapter`) strips the non-serializable `execute` functions automatically.

---

## MCP server

`buildStudioMcpServer` creates a [Model Context Protocol](https://modelcontextprotocol.io/) server backed by the same AI tools and state as `handleAIChat`. Use it to let Claude Desktop, Cursor, or any other MCP client manipulate x-studio dashboards programmatically — no browser required.

### Basic usage

```ts
import {
  buildStudioMcpServer,
  createDefaultStudioState,
  type StudioStateBox,
} from '@mui/x-studio-ai-middleware';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'node:crypto';

const router = express.Router();
const transports: Record<string, StreamableHTTPServerTransport> = {};
const stateBoxes: Record<string, StudioStateBox> = {};

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
    const server = buildStudioMcpServer(stateBox);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
});
```

Each MCP session gets its own isolated `StudioStateBox`. Mutations made by tool calls persist for the lifetime of the session.

### `StudioMcpOptions`

| Option                 | Type                          | Default                                      | Description                                                        |
| :--------------------- | :---------------------------- | :------------------------------------------- | :----------------------------------------------------------------- |
| `serverName`           | `string`                      | `'x-studio'`                                 | Name reported in `initialize` response                             |
| `serverVersion`        | `string`                      | `'1.0.0'`                                    | Version reported in `initialize` response                          |
| `allowedTools`         | `string[]`                    | all except `summarise_page`, `execute_query` | Exact list of tool names to expose                                 |
| `customWidgets`        | `StudioCustomWidgetDef[]`     | `[]`                                         | Custom widget definitions for tool handling                        |
| `data.queryDataSource` | `(params) => Promise<result>` | —                                            | When provided, enables `query_data_source` tool and data resources |

### Tools registered by default

All `STUDIO_AI_TOOLS` except `summarise_page` (needs live row data) and `execute_query` (raw SQL — opt in explicitly via `allowedTools`).

When `data.queryDataSource` is provided, the `query_data_source` tool is also registered.

### Resources

| URI                                | Description                                              |
| :--------------------------------- | :------------------------------------------------------- |
| `studio://dashboard/state`         | Full dashboard JSON                                      |
| `studio://dashboard/system-prompt` | AI system prompt for the current state                   |
| `studio://dashboard/data-health`   | Row counts per source (requires `data` option)           |
| `studio://schema/{sourceId}`       | Field definitions with type, format, sample values       |
| `studio://data/{sourceId}`         | Raw row preview — up to 20 rows (requires `data` option) |

All resources support `resources/subscribe`. Subscribe to `studio://dashboard/state` to receive `notifications/resources/updated` whenever a tool call mutates the dashboard.

### Prompts

| Name                         | Description                                          |
| :--------------------------- | :--------------------------------------------------- |
| `query_data_source_examples` | Auto-generated query templates for every data source |

### URI autocomplete

The server declares the `completions` capability and handles `completion/complete` for `ref/resource` references. Typing `studio://schema/` or `studio://data/` returns matching source IDs from the current dashboard state.

---

## Limitations (v1)

- **`instruction-only` skills** — fully supported.
- **`client-handler` skills** — the tool definition is sent to the LLM; if the model calls
  it the server emits a `client-tool-call` event, but the current client adapter does not
  handle it automatically (v2 feature).
- **`summarise_page` tool** — returns an error in backend mode; it requires live row data
  only available client-side.
- **`remove_widget` / `remove_page` confirmation** — uses prompt guardrails only in v1;
  the `onRemoveWidgetRequest` veto callback still fires before mutations are applied.
- **Multi-turn conversation** — full history is sent on every request; fully supported.

---

## Related

- [`@mui/x-studio`](../x-studio/README.md) — the main Studio package
- [`@mui/x-studio-data-middleware`](../x-studio-data-middleware/README.md) — SQL data pipeline handler
- [AI assistant docs](/x/react-studio/ai/setup/) — client-side configuration guide
