---
title: Studio - AI tools
description: Studio exposes seventeen AI tools that the language model can call to build and configure dashboards. Learn how to restrict tools, add skills, and handle tool errors.
---

# Studio - AI tools

<p class="description">Studio exposes seventeen AI tools that the language model can call to build and configure dashboards. Learn how to restrict tools, add skills, and handle tool errors.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

When the AI assistant is enabled (see [AI assistant setup](/x/react-studio/ai/setup/)),
the language model receives a set of **Studio AI tools**. Each tool maps directly to a
`StudioController` action. The model chooses which tools to invoke in response to user
prompts, and Studio executes them to mutate the dashboard state.

## Built-in tools

### Dashboard and page tools

| Tool                  | Action                                                   |
| :-------------------- | :------------------------------------------------------- |
| `set_dashboard_title` | Change the top-level dashboard title                     |
| `add_page`            | Add a new page to the dashboard                          |
| `rename_page`         | Rename an existing page                                  |
| `remove_page`         | Remove a page from the dashboard (requires confirmation) |
| `set_active_page`     | Switch the visible page                                  |

### Widget tools

| Tool                  | Action                                                                          |
| :-------------------- | :------------------------------------------------------------------------------ |
| `add_widget`          | Add a new widget of a specified type to the active page                         |
| `update_widget`       | Update an existing widget's configuration by ID                                 |
| `remove_widget`       | Remove a widget from the active page (requires confirmation)                    |
| `set_widget_layout`   | Rearrange widgets by specifying row groupings                                   |
| `set_widget_width`    | Set the column span of a widget (3–12 columns)                                  |
| `set_widget_forecast` | Enable or disable a linear trend/forecast overlay on a `line` or `area` chart   |

### Filter tools

| Tool                   | Action                                   |
| :--------------------- | :--------------------------------------- |
| `add_page_filter`      | Add a filter scoped to the active page   |
| `remove_page_filter`   | Remove a page-scoped filter by ID        |
| `add_widget_filter`    | Add a filter scoped to a specific widget |
| `remove_widget_filter` | Remove a widget-scoped filter by ID      |

### Utility tools

| Tool                  | Action                                                                                                                                                                                                                                      |
| :-------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_dashboard_state` | Returns the current dashboard state (pages, widgets, data sources)                                                                                                                                                                          |
| `summarise_page`      | Returns a rich data snapshot of every widget on the active page, including per-widget sampled CSV data, numeric stats, and anomaly axis values for chart widgets. The AI uses this to write a narrative page summary.                       |
| `apply_bulk_update`   | Applies multiple coordinated changes (widget updates, additions, removals, layout, column spans) in a single atomic operation. The AI uses this instead of multiple individual tool calls when a prompt requires 3 or more related changes. |
| `rename_thread`       | Auto-renames the current conversation thread to a concise title after the user's first substantive message. Keeps the thread list readable without prompting the user.                                                                      |
| `execute_query`       | Runs an ad-hoc query against a data source and returns results as JSON. Only available when a server-side data resolver is configured. Excluded from the MCP default tool set (opt in via `allowedTools`).                                  |
| `set_widget_forecast` | Enables or disables a linear trend/forecast overlay on a `line` or `area` chart widget, projecting forward by a configurable number of periods with optional confidence bands.                                                              |

## Parallel tool calls

The model can return multiple tool calls in a single assistant response. All results are collected and sent back together before the next turn — there is no extra round-trip per additional tool call.

For skill tools, you can opt in to **parallel execution** by setting `parallel: true` on the tool definition:

```ts
const myTool: StudioAiTool = {
  name: 'fetch_kpi_data',
  description: 'Fetches live KPI data for a given metric.',
  parameters: { ... },
  parallel: true, // safe to run concurrently with other parallel:true tools
  execute: async (args) => { ... },
};
```

When the model requests multiple `parallel: true` tools in the same response, the server runs them concurrently with `Promise.all`. Sequential tools (the default) execute in order around any parallel groups.

Built-in tools `get_dashboard_state` and `summarise_page` are always treated as parallel-safe since they are read-only. State-mutating built-in tools always execute sequentially.

## Tool-to-controller mapping

Tool execution runs on the server inside `@mui/x-studio-ai-middleware`. The server runs `executeToolOnState` and streams `state-mutation` events. The client applies them via `applyStateMutation`:

```ts
// Server (automatic — inside handleAIChat)
const { output, mutation, nextState } = executeToolOnState(
  'add_widget',
  args,
  currentState,
);
// → streams: { type: 'state-mutation', mutation: { type: 'addWidget', args: { widget } } }

// Client (automatic — inside studioBackendAdapter)
applyStateMutation(mutation, controller);
// → controller.addWidget(widget)
```

This mapping is entirely internal to Studio. You do not need to call controller methods
yourself in response to AI tool calls.

## Restricting tools

Pass an `allowedTools` array in `aiConfig` to limit which built-in tools the model can call.
When `allowedTools` is set, only the listed tools are sent to the model.

```tsx
<Studio
  aiConfig={{
    endpoint: '/api/ai',
    allowedTools: ['add_widget', 'update_widget', 'remove_widget'],
  }}
/>
```

Tools not in `allowedTools` are not sent to the model and cannot be invoked.

:::warning
Restricting tools limits what the AI can do, but does not restrict what the user
can do manually in edit mode. To make the dashboard read-only for end users, switch
to [view mode](/x/react-studio/behaviors/edit-and-view-mode/) instead.
:::

## Disabling the AI tools

Set `allowedTools: []` to disable all built-in tools. The chat panel will still be
available for conversational queries, but the model cannot modify the dashboard.

## Tool call context

Each tool call receives the current `StudioState` as context. The model can use
this to determine which widgets already exist, their IDs, the current page
structure, and active filters — enabling follow-up instructions like "remove the
region filter" to resolve the correct filter ID automatically.

## Handling tool errors

If a tool call throws an error, the server returns an error result to the model so it
can recover. To observe tool errors server-side, use the `onToolError` option in your
`handleAIChat` call:

```ts
const stream = handleAIChat(body, {
  endpoint: process.env.LLM_ENDPOINT,
  apiKey: process.env.LLM_API_KEY,
  onToolError: (toolName, error) => {
    console.error(`Tool ${toolName} failed:`, error);
  },
});
```

## Natural language widget creation

When `aiConfig` is set and `featureFlags.aiChat !== false`, the compose drawer's add-widget view shows a **Describe a widget** text field. Editors can enter a prompt such as "Show me revenue by country as a bar chart for last year" and let Studio create the initial widget configuration.

Studio handles this flow with `createWidgetFromDescription()`:

1. Make a single non-streaming AI call
2. Parse the returned JSON for the widget kind, selected fields, and widget config
3. Normalize the result through `createDefaultWidget()`
4. Call `controller.addWidget()` to insert the new widget

This uses the same `aiConfig` object that powers the chat assistant, so no additional AI setup is required.

The underlying `add_widget` AI tool schema accepts every `StudioWidgetKind`, including `pivot` and `map`.

## See also

- [AI assistant setup](/x/react-studio/ai/setup/) — configure the adapter and system prompt
- [MCP server](/x/react-studio/ai/mcp/) — expose Studio AI tools to Claude Desktop and other MCP clients
- [`@mui/x-studio-ai-middleware`](https://github.com/mui/mui-x/tree/master/packages/x-studio-ai-middleware) — run the agentic loop server-side
- [Composed approach](/x/react-studio/getting-started/composition/) — add `StudioChatPanel` to a custom layout
- [Edit and view mode](/x/react-studio/behaviors/edit-and-view-mode/) — use view mode to protect dashboards from user edits
- [State management](/x/react-studio/getting-started/state/) — the `StudioState` context supplied to every tool call
