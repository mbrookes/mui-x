---
title: Studio - AI tools
description: Studio exposes ten AI tools that the language model can call to build and configure dashboards. Learn how to restrict tools, add custom tools, and handle tool errors.
---

# Studio - AI tools

<p class="description">Studio exposes ten AI tools that the language model can call to build and configure dashboards. Learn how to restrict tools, add custom tools, and handle tool errors.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

When the AI assistant is enabled (see [AI assistant setup](/x/react-studio/ai/setup/)),
the language model receives a set of **Studio AI tools**. Each tool maps directly to a
`StudioController` action. The model chooses which tools to invoke in response to user
prompts, and Studio executes them to mutate the dashboard state.

## Built-in tools

| Tool | Action |
| :--- | :--- |
| `add_widget` | Add a new widget of a specified type to the active page |
| `configure_widget` | Update an existing widget's configuration by ID |
| `remove_widget` | Remove a widget from the active page by ID |
| `add_page` | Add a new page to the dashboard |
| `remove_page` | Remove a page from the dashboard by ID |
| `rename_page` | Rename an existing page |
| `set_active_page` | Switch the visible page |
| `add_data_source` | Register a new inline data source |
| `update_dashboard_title` | Change the top-level dashboard title |
| `add_filter` | Add a global filter condition to the active page |

## Tool-to-controller mapping

Each tool call is translated into the equivalent controller method call:

```typescript
// add_widget({ type: 'chart', config: { ... } })
controller.addWidget({ type: 'chart', config: chartConfig });

// configure_widget({ widgetId: 'w1', config: { ... } })
controller.updateWidget('w1', newConfig);

// add_page({ title: 'Orders' })
controller.addPage({ title: 'Orders' });
```

This mapping is internal to Studio. You do not need to call controller methods
yourself in response to AI tool calls.

## Restricting tools

Pass an `allowedTools` array to the `StudioChatPanel` slot props or to the `aiConfig`
prop to limit which tools the model can call:

```tsx
<Studio
  aiConfig={{
    adapter: myAiAdapter,
    allowedTools: ['add_widget', 'configure_widget', 'remove_widget'],
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

Set `allowedTools: []` to disable all AI tools. The chat panel will still be
available for conversational queries, but the model cannot modify the dashboard.

## Tool call context

Each tool call receives the current `StudioState` as context. The model can use
this to determine which widgets already exist, their IDs, and the current page
structure — enabling follow-up instructions like "make the revenue chart a bar chart"
to resolve the correct widget ID.

## Handling tool errors

If a tool call fails (for example, referencing a non-existent widget ID), Studio
returns an error result to the model. The model can then recover by asking the user
for clarification or by inspecting the current state for valid widget IDs.

You can observe tool call errors via the `onToolError` callback:

```tsx
<Studio
  aiConfig={{
    adapter: myAiAdapter,
    onToolError: (tool, error, state) => {
      console.error(`Tool ${tool} failed:`, error);
    },
  }}
/>
```

## Adding custom tools

Pass additional tools in the `extraTools` array. Each tool must conform to the
`StudioAiTool` interface and implement an `execute` method that mutates the
controller:

```typescript
interface StudioAiTool<TArgs = unknown> {
  name: string;
  description: string;  // shown to the LLM in the system prompt
  parameters: JSONSchema;
  execute: (args: TArgs, controller: StudioController) => void | Promise<void>;
}
```

```typescript
const lockDashboardTool: StudioAiTool<{ locked: boolean }> = {
  name: 'set_locked',
  description: 'Lock or unlock the dashboard to prevent further edits',
  parameters: {
    type: 'object',
    properties: {
      locked: { type: 'boolean', description: 'Whether to lock the dashboard' },
    },
    required: ['locked'],
  },
  execute: ({ locked }, controller) => {
    controller.setMode(locked ? 'view' : 'edit');
  },
};

<Studio
  aiConfig={{
    adapter: myAiAdapter,
    extraTools: [lockDashboardTool],
  }}
/>
```

## See also

- [AI assistant setup](/x/react-studio/ai/setup/) — configure the adapter and system prompt
- [Composed approach](/x/react-studio/getting-started/composition/) — add `StudioChatPanel` to a custom layout
- [Edit and view mode](/x/react-studio/behaviors/edit-and-view-mode/) — use view mode to protect dashboards from user edits
- [State management](/x/react-studio/getting-started/state/) — the `StudioState` context supplied to every tool call
