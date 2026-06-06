---
title: Studio - AI tools
description: Studio exposes seventeen AI tools that the language model can call to build and configure dashboards. Learn how to restrict tools, add custom tools, and handle tool errors.
---

# Studio - AI tools

<p class="description">Studio exposes seventeen AI tools that the language model can call to build and configure dashboards. Learn how to restrict tools, add custom tools, and handle tool errors.</p>

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

| Tool                | Action                                                       |
| :------------------ | :----------------------------------------------------------- |
| `add_widget`        | Add a new widget of a specified type to the active page      |
| `update_widget`     | Update an existing widget's configuration by ID              |
| `remove_widget`     | Remove a widget from the active page (requires confirmation) |
| `set_widget_layout` | Rearrange widgets by specifying row groupings                |
| `set_widget_width`  | Set the column span of a widget (3–12 columns)               |

### Filter tools

| Tool                   | Action                                   |
| :--------------------- | :--------------------------------------- |
| `add_page_filter`      | Add a filter scoped to the active page   |
| `remove_page_filter`   | Remove a page-scoped filter by ID        |
| `add_widget_filter`    | Add a filter scoped to a specific widget |
| `remove_widget_filter` | Remove a widget-scoped filter by ID      |

### Utility tools

| Tool                  | Action                                                                                       |
| :-------------------- | :------------------------------------------------------------------------------------------- |
| `get_dashboard_state` | Returns the current dashboard state (pages, widgets, data sources)                           |
| `summarise_page`      | Returns a rich data snapshot of every widget on the active page, including per-widget sampled CSV data, numeric stats, and anomaly axis values for chart widgets. The AI uses this to write a narrative page summary. |
| `apply_bulk_update`   | Applies multiple coordinated changes (widget updates, additions, removals, layout, column spans) in a single atomic operation. The AI uses this instead of multiple individual tool calls when a prompt requires 3 or more related changes. |

## Parallel tool calls

The model can return multiple tool calls in a single assistant response. All results are collected and sent back together before the next turn — there is no extra round-trip per additional tool call.

For `extraTools` and skill tools, you can opt in to **parallel execution** by setting `parallel: true` on the tool definition:

```ts
const myTool: StudioAiTool = {
  name: 'fetch_kpi_data',
  description: 'Fetches live KPI data for a given metric.',
  parameters: { ... },
  parallel: true, // safe to run concurrently with other parallel:true tools
  execute: async (args) => { ... },
};
```

When the model requests multiple `parallel: true` tools in the same response, the adapter runs them concurrently with `Promise.all`. Sequential tools (the default) execute in order around any parallel groups.

Built-in tools `get_dashboard_state` and `summarise_page` are always treated as parallel-safe since they are read-only. State-mutating built-in tools always execute sequentially.

## Tool-to-controller mapping

### In `direct` mode (default)

Each tool call is translated into the equivalent `StudioController` method call client-side:

```ts
// add_widget({ kind: 'chart', title: 'Revenue', sourceId: 'ds1', config: { ... } })
controller.addWidget({ kind: 'chart', title: 'Revenue', sourceId: 'ds1', config: chartConfig });

// update_widget({ widgetId: 'w1', config: { ... } })
controller.updateWidgetConfig('w1', newConfig);

// add_page({ title: 'Orders' })
controller.addPage('Orders');
```

### In `x-studio-backend` mode

Tool execution moves to the server. The server runs `executeToolOnState` and streams
`state-mutation` events. The client applies them via `applyStateMutation`:

```ts
// Server (automatic — inside handleAIChat)
const { output, mutation, nextState } = executeToolOnState('add_widget', args, currentState);
// → streams: { type: 'state-mutation', mutation: { type: 'addWidget', args: { widget } } }

// Client (automatic — inside studioBackendAdapter)
applyStateMutation(mutation, controller);
// → controller.addWidget(widget)
```

This is handled automatically when `mode: 'x-studio-backend'` is set. You do not need to call
`executeToolOnState` or `applyStateMutation` yourself.

This mapping is internal to Studio. You do not need to call controller methods
yourself in response to AI tool calls.

## Restricting tools

Pass an `allowedTools` array in `aiConfig` to limit which built-in tools the model can call.
When `allowedTools` is set, only the listed tools are sent to the model.

```tsx
<Studio
  aiConfig={{
    endpoint: 'https://your-proxy.com/api/ai/chat',
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

If a tool call throws an error, Studio returns an error result to the model so it
can recover. You can also observe tool errors via the `onToolError` callback:

```tsx
<Studio
  aiConfig={{
    endpoint: 'https://your-proxy.com/api/ai/chat',
    onToolError: (toolName, error) => {
      console.error(`Tool ${toolName} failed:`, error);
    },
  }}
/>
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

## Adding custom tools

Pass additional tools in the `extraTools` array on `aiConfig`. Each tool must conform to the
`StudioAiTool` interface and implement an `execute` method that mutates the
controller:

```ts
import type { StudioAiTool } from '@mui/x-studio';

const lockDashboardTool: StudioAiTool = {
  name: 'set_locked',
  description: 'Lock or unlock the dashboard to prevent further edits',
  parameters: {
    type: 'object',
    properties: {
      locked: { type: 'boolean', description: 'Whether to lock the dashboard' },
    },
    required: ['locked'],
  },
  execute: (args, controller) => {
    const { locked } = args as { locked: boolean };
    controller.setMode(locked ? 'view' : 'edit');
  },
};
```

```tsx
<Studio
  aiConfig={{
    endpoint: 'https://your-proxy.com/api/ai/chat',
    extraTools: [lockDashboardTool],
  }}
/>
```

The `execute` function can be `async` and may return a string to send back to the
model as the tool result, or return `void` for a generic success response.

:::info
`extraTools` always execute client-side, regardless of `mode`. They are not supported
in `x-studio-backend` mode and will not be forwarded to the server.
Use `StudioAiTool` only with the default `direct` mode, or implement server-side equivalents.
:::

## See also

- [AI assistant setup](/x/react-studio/ai/setup/) — configure the adapter and system prompt
- [`@mui/x-studio-backend`](https://github.com/mui/mui-x/tree/master/packages/x-studio-backend) — run the agentic loop server-side
- [Composed approach](/x/react-studio/getting-started/composition/) — add `StudioChatPanel` to a custom layout
- [Edit and view mode](/x/react-studio/behaviors/edit-and-view-mode/) — use view mode to protect dashboards from user edits
- [State management](/x/react-studio/getting-started/state/) — the `StudioState` context supplied to every tool call
