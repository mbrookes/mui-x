---
title: Studio - AI assistant
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
components: StudioChatPanel
---

# Studio - AI assistant

<p class="description">Add an AI chat panel that can configure widgets, connect data sources, and answer dashboard questions — powered by any OpenAI-compatible endpoint.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

The Studio AI assistant is a `StudioChatPanel` component that connects to your LLM endpoint via `createStudioChatAdapter`.
The AI has access to a set of **tools** that let it manipulate the dashboard: add widgets, configure chart types, apply filters, manage data sources, and more.

Studio generates a **system prompt** from the current dashboard state using `buildAISystemPrompt`, so the AI always has context about which pages, data sources, and widgets exist.

## Setup

### 1. Configure the AI endpoint

Create an `StudioAIConfig` object.
Studio connects to OpenAI-compatible endpoints — it works with OpenAI, Azure OpenAI, Google Gemini (via the OpenAI compatibility layer), Anthropic (via a proxy), or any local model server:

```ts
import type { StudioAIConfig } from '@mui/x-studio';

// OpenAI
const aiConfig: StudioAIConfig = {
  endpoint: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
};

// Azure OpenAI
const azureConfig: StudioAIConfig = {
  endpoint: 'https://my-resource.openai.azure.com/openai/deployments/gpt-4o',
  apiKey: process.env.AZURE_OPENAI_KEY,
  model: 'gpt-4o',
};

// Custom headers (e.g. a token-based auth proxy)
const proxyConfig: StudioAIConfig = {
  endpoint: 'https://my-api-proxy.example.com/v1',
  model: 'gpt-4o',
  headers: { 'X-Studio-Token': userSessionToken },
};
```

:::warning
Never expose raw API keys in client-side code in production.
Use a server-side proxy that authenticates your users and forwards requests to the LLM provider.
Pass a short-lived session token via `headers` instead.
:::

### 2. Pass `aiConfig` to `Studio`

```tsx
<Studio ref={studioRef} initialState={initialState} aiConfig={aiConfig} />
```

When `aiConfig.endpoint` is truthy, a floating action button (✨) appears at the bottom-right corner.
Click it to open the chat panel.

### 3. Wrap in `LocalizationProvider`

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

The AI can call the following tools (exported as `STUDIO_AI_TOOLS`):

| Tool                   | What it does                                                                    |
| :--------------------- | :------------------------------------------------------------------------------ |
| `set_dashboard_title`  | Sets the dashboard title                                                        |
| `add_page`             | Adds a new dashboard page                                                       |
| `rename_page`          | Renames a page                                                                  |
| `remove_page`          | Removes a page (requires confirmation)                                          |
| `set_active_page`      | Navigates to a specific page                                                    |
| `add_widget`           | Adds a new widget to the active page                                            |
| `update_widget`        | Updates a widget's type, title, data source, series, dimensions, or aggregation |
| `remove_widget`        | Removes a widget by ID (requires confirmation)                                  |
| `set_widget_layout`    | Rearranges widgets by specifying row groupings                                  |
| `set_widget_width`     | Sets the column span of a widget (3–12 columns)                                 |
| `add_page_filter`      | Adds a filter scoped to the active page                                         |
| `remove_page_filter`   | Removes a page-scoped filter by ID                                              |
| `add_widget_filter`    | Adds a filter scoped to a specific widget                                       |
| `remove_widget_filter` | Removes a widget-scoped filter by ID                                            |
| `get_dashboard_state`  | Returns the current dashboard state (pages, widgets, data sources)              |

You can restrict which tools are available using `allowedTools` in `aiConfig`.
See [AI tools](/x/react-studio/ai/tools/) for details.

## `createStudioChatAdapter`

The `createStudioChatAdapter` function creates a chat adapter that:

1. Builds a context-aware system prompt from the current Studio state
2. Sends messages to your LLM endpoint in OpenAI chat completions format
3. Streams the response token-by-token back to the chat UI
4. Executes tool calls against the Studio controller

```ts
import { createStudioChatAdapter } from '@mui/x-studio';

// The adapter is created internally by StudioChatPanel — you don't need to call this directly
// unless you're using StudioChatPanel standalone in a composed layout.
const adapter = createStudioChatAdapter({
  aiConfig,
  controller,
  getState: () => controller.getState(),
});
```

When you use `<Studio aiConfig={aiConfig} />` or `<StudioChatPanel aiConfig={aiConfig} />`, the adapter is created for you.

## `buildAISystemPrompt`

`buildAISystemPrompt` generates a system prompt string from the current Studio state.
It describes:

- The dashboard title and pages
- Data sources (field IDs, labels, types, aggregatable flag)
- Existing widgets (IDs, kinds, titles, data source, configuration)
- Current mode

The AI uses this context to make informed decisions about where to place new widgets and which fields to use.
The prompt is regenerated on every message so the AI always sees the latest state.

If you want to add custom instructions (e.g. branding guidelines, preferred chart types, or restrictions), use `slotProps.chatPanel`:

```tsx
<Studio
  aiConfig={aiConfig}
  slotProps={{
    chatPanel: {
      slotProps: {
        chatBox: {
          // Additional context prepended to messages
          suggestions: [
            'Add a revenue KPI for this month',
            'Create a bar chart of sales by category',
            'Add a date range filter',
          ],
        },
      },
    },
  }}
/>
```

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
| `aiConfig`          | `StudioAIConfig`        | LLM endpoint configuration.                              |
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

### Never expose API keys client-side

Use a server-side proxy. A minimal proxy pattern:

```ts
// pages/api/llm.ts (Next.js example)
export default async function handler(req, res) {
  // Authenticate the user session
  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    res.status(401).end();
    return;
  }

  // Forward to the LLM provider
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(req.body),
  });
  // Stream the response back
  response
    .body!.pipeTo(new WritableStream({ write: (chunk) => res.write(chunk) }))
    .then(() => res.end());
}
```

Then in `aiConfig`:

```ts
const aiConfig: StudioAIConfig = {
  endpoint: '/api/llm', // relative URL — no key in client code
  model: 'gpt-4o',
};
```

### Rate limiting

Protect your LLM proxy with rate limiting to prevent abuse.
Studio does not make any calls at mount — the LLM is only called when the user sends a message.

## `StudioAIConfig` reference

```ts
interface StudioAIConfig {
  /** OpenAI-compatible chat completions endpoint URL. */
  endpoint: string;
  /** API key (unsafe in production — use a server proxy instead). */
  apiKey?: string;
  /** Model ID (e.g. 'gpt-4o', 'gemini-1.5-pro'). Default: 'gpt-4o'. */
  model?: string;
  /** Extra HTTP headers forwarded to the endpoint on every request. */
  headers?: Record<string, string>;
}
```

## See also

- [Composed approach](/x/react-studio/getting-started/composition/) — adding `StudioChatPanel` to a custom layout
- [Slot props](/x/react-studio/customization/slot-props/) — customize the AI panel via `slotProps.chatPanel`
