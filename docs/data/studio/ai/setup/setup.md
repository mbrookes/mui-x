---
title: Studio - AI assistant
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
components: StudioChatPanel
---

# Studio - AI assistant

<p class="description">Add an AI chat panel that can configure widgets, connect data sources, and answer dashboard questions — powered by any OpenAI-compatible backend.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

The Studio AI assistant is a `StudioChatPanel` component that connects to a backend server via `StudioAIConfig`.
The AI runs entirely server-side: the server builds the system prompt, runs the agentic tool loop, and streams
state-mutation events back to the client.

The client (`@mui/x-studio`) is a **pure UI package** — it never calls an LLM directly.
All LLM requests go through a backend that uses `@mui/x-studio-ai-middleware`.

```
Browser (x-studio)  ──POST──►  Your server (x-studio-ai-middleware)  ──►  LLM
                    ◄──SSE───                                          ◄──
```

## Setup

### 1. Set up the backend

Create a `/chat` route handler using `@mui/x-studio-ai-middleware`. Studio appends `/chat`,
`/insight`, `/title`, and `/widget` to `aiConfig.endpoint` automatically, so your route lives
at `<endpoint>/chat`:

```ts
// app/api/ai/chat/route.ts (Next.js App Router)
import { handleAIChat } from '@mui/x-studio-ai-middleware';

export async function POST(req: Request) {
  const session = await getServerSession(); // your auth
  if (!session) return new Response('Unauthorized', { status: 401 });

  const body = await req.json();
  const stream = handleAIChat(body, {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o',
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
```

See the [`@mui/x-studio-ai-middleware` README](https://github.com/mui/mui-x/tree/master/packages/x-studio-ai-middleware)
for Express, Hono, and other framework examples, as well as the routes for `/insight`, `/title`, and `/widget`.

The middleware handles everything server-side: system prompt construction, the agentic tool loop, and streaming
state-mutation events back to the client.

### 2. Configure the client

Create a `StudioAIConfig` with `endpoint` pointing at the **base URL** of your backend AI routes.
Studio appends `/chat`, `/insight`, `/title`, and `/widget` automatically:

```ts
import type { StudioAIConfig } from '@mui/x-studio';

const aiConfig: StudioAIConfig = {
  endpoint: '/api/ai', // /chat, /insight, /title, /widget are appended automatically
};
```

Pass a session token via `headers` if your route requires authentication:

```ts
const aiConfig: StudioAIConfig = {
  endpoint: '/api/ai',
  headers: { Authorization: `Bearer ${userSessionToken}` },
};
```

### 3. Pass `aiConfig` to `Studio`

```tsx
<Studio ref={studioRef} initialState={initialState} aiConfig={aiConfig} />
```

When `aiConfig.endpoint` is truthy, a floating action button (✨) appears at the bottom-right corner.
Click it to open the chat panel.

### 4. Wrap in `LocalizationProvider`

Date-related tools use `@mui/x-date-pickers` internally.
Ensure `LocalizationProvider` is in your tree:

```tsx
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';

<LocalizationProvider dateAdapter={AdapterDayjs}>
  <Studio aiConfig={aiConfig} initialState={initialState} />
</LocalizationProvider>;
```

## Available AI tools

The AI can call the following tools on the server:

| Tool                   | What it does                                                                    |
| :--------------------- | :------------------------------------------------------------------------------ |
| `set_dashboard_title`  | Sets the dashboard title                                                        |
| `add_page`             | Adds a new dashboard page                                                       |
| `rename_page`          | Renames a page                                                                  |
| `remove_page`          | Removes a page                                                                  |
| `set_active_page`      | Navigates to a specific page                                                    |
| `add_widget`           | Adds a new widget to the active page                                            |
| `update_widget`        | Updates a widget's type, title, data source, series, dimensions, or aggregation |
| `remove_widget`        | Removes a widget by ID                                                          |
| `set_widget_layout`    | Rearranges widgets by specifying row groupings                                  |
| `set_widget_width`     | Sets the column span of a widget (3–12 columns)                                 |
| `add_page_filter`      | Adds a filter scoped to the active page                                         |
| `remove_page_filter`   | Removes a page-scoped filter by ID                                              |
| `add_widget_filter`    | Adds a filter scoped to a specific widget                                       |
| `remove_widget_filter` | Removes a widget-scoped filter by ID                                            |
| `get_dashboard_state`  | Returns the current dashboard state (pages, widgets, data sources)              |
| `summarise_page`       | Returns a rich data snapshot of every widget on the active page                 |
| `apply_bulk_update`    | Applies multiple coordinated changes in a single atomic operation               |

You can restrict which tools are available using `allowedTools` in `aiConfig`.
See [AI tools](/x/react-studio/ai/tools/) for details.

## Using `StudioChatPanel` standalone

In a composed layout, use `StudioChatPanel` directly.
Pass `overlay` to render it as a slide-in panel:

```tsx
import { StudioChatPanel } from '@mui/x-studio';
import type { StudioAIConfig } from '@mui/x-studio';

function MyComposedLayout({ aiConfig }: { aiConfig: StudioAIConfig }) {
  const [chatOpen, setChatOpen] = React.useState(false);

  return (
    <Box sx={{ position: 'relative', height: '100vh' }}>
      {/* ... your layout ... */}

      {aiConfig?.endpoint && (
        <>
          <Tooltip title="AI assistant">
            <IconButton
              onClick={() => setChatOpen((v) => !v)}
              sx={{
                position: 'absolute',
                bottom: 20,
                right: 20,
                zIndex: 'speedDial',
              }}
            >
              <AutoAwesomeIcon />
            </IconButton>
          </Tooltip>
          <StudioChatPanel
            aiConfig={aiConfig}
            open={chatOpen}
            onClose={() => setChatOpen(false)}
            overlay
          />
        </>
      )}
    </Box>
  );
}
```

### Props

| Prop                | Type                    | Description                                              |
| :------------------ | :---------------------- | :------------------------------------------------------- |
| `aiConfig`          | `StudioAIConfig`        | Backend endpoint configuration.                          |
| `open`              | `boolean`               | Whether the panel is visible.                            |
| `onClose`           | `() => void`            | Called when the user closes the panel (overlay mode).    |
| `overlay`           | `boolean`               | Render as a fixed-position overlay instead of inline.    |
| `focusedWidgetId`   | `string`                | Widget to focus the AI on (see _Per-widget AI_ below).   |
| `slotProps.chatBox` | `Partial<ChatBoxProps>` | Props forwarded to the inner `ChatBox`.                  |
| `slotProps.panel`   | `Partial<BoxProps>`     | Props for the overlay container (width, position, `sx`). |

## Per-widget AI assistant

Pass `focusedWidgetId` to `StudioChatPanel` to prime the AI with context about a specific widget. The system prompt will include the widget's current configuration and direct the AI to prefer `update_widget` for that widget.

This enables a per-widget AI workflow in composed layouts where each widget card can open a dedicated chat dialog:

```tsx
function WidgetAiDialog({ widgetId, aiConfig, onClose }: WidgetAiDialogProps) {
  return (
    <Dialog open onClose={onClose}>
      <StudioChatPanel
        key={widgetId} // reset chat history for each widget
        aiConfig={aiConfig}
        focusedWidgetId={widgetId}
      />
    </Dialog>
  );
}
```

Use `key={widgetId}` to ensure each widget gets a fresh conversation when the dialog opens for a different widget.

To expose the per-widget AI button, pass `onAiRequest` to `StudioCanvas.slotProps.widgetCard`:

```tsx
<StudioCanvas
  slotProps={{
    widgetCard: {
      onAiRequest: (widgetId) => setAiWidgetId(widgetId),
    },
  }}
/>
```

The button appears in the widget card's edit-mode overlay when `onAiRequest` is provided.

## Slot props

Customize the chat panel via `slotProps.chatPanel` on `<Studio>`:

```tsx
<Studio
  aiConfig={aiConfig}
  slotProps={{
    chatPanel: {
      slotProps: {
        // Customize the panel container
        panel: {
          sx: { width: 480 }, // default is 380
        },
        // Customize the ChatBox
        chatBox: {
          suggestions: ['Show revenue by region', 'Add a filter for this month'],
        },
      },
    },
  }}
/>
```

## Security considerations

The API key and system prompt construction live entirely on the server.
The browser client only sends messages and receives streaming events — it has no access to your LLM credentials.

Protect your backend route with authentication (session cookies, JWTs, etc.) and rate limiting to prevent abuse.
Studio does not make any calls at mount — the LLM is only called when the user sends a message.

## `StudioAIConfig` reference

```ts
interface StudioAIConfig {
  /**
   * Base URL of your x-studio-ai-middleware backend.
   * Studio appends `/chat`, `/insight`, `/title`, and `/widget` automatically.
   * Example: `'/api/ai'` or `'http://localhost:3020/api/ai'`
   */
  endpoint: string;
  /** Extra HTTP headers forwarded to the endpoint on every request (e.g. Authorization). */
  headers?: Record<string, string>;
  /**
   * Restrict which AI tools are available.
   * When omitted, all tools are enabled.
   */
  allowedTools?: StudioAIToolName[];
  /**
   * Custom skills to register with the AI.
   * Skills are serialized and sent to the server; the server executes them.
   */
  skills?: StudioAISkill[];
}
```

## See also

- [Composed approach](/x/react-studio/getting-started/composition/) — adding `StudioChatPanel` to a custom layout
- [Slot props](/x/react-studio/customization/slot-props/) — customize the AI panel via `slotProps.chatPanel`
- [`@mui/x-studio-ai-middleware`](https://github.com/mui/mui-x/tree/master/packages/x-studio-ai-middleware) — server-side handler package

