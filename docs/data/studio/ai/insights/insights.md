# AI Insights

<p class="description">Generate AI-powered summaries, analyses, and forecasts for widgets or the entire dashboard.</p>

## Overview

AI Insights provide on-demand narrative intelligence using the same AI endpoint configured for the [AI Assistant](../setup/). Unlike the chat assistant, insights are one-shot requests — they do not maintain conversation history.

Insights come in three flavours:

| Type         | Description                                                                                       |
| :----------- | :------------------------------------------------------------------------------------------------ |
| **Summary**  | A concise description of what the widget currently shows                                          |
| **Analysis** | A deeper interpretation highlighting trends, comparisons, and notable patterns                    |
| **Forecast** | A forward-looking projection based on existing data (best for time-series charts and KPI widgets) |

A **page summary** can also be generated via the AI chat panel.

## Prerequisites

AI Insights require the same `aiConfig` setup as the AI Assistant. See the [Setup guide](../setup/) for full instructions.

## Widget insights

When `aiConfig` is configured, chart, grid, pivot, and map widget cards show an **AI Insight** button in the overflow menu (⋮). Clicking it opens the AI chat panel and auto-submits the insight request — the response appears as a chat message so you can ask follow-up questions in the same thread.

:::info
The AI Insight button is not shown on **filter**, **text**, or **KPI** widgets, as these do not contain data suitable for the insight types available.

For **custom widgets**, opt in by setting `aiInsight: true` in the widget registration:

```tsx
const myWidget: StudioCustomWidgetDef = {
  kind: 'my-org-chart',
  label: 'Org Chart',
  component: OrgChartWidget,
  aiInsight: true, // show the AI Insight button for this widget
};
```

:::

### Selecting the insight type

The overflow menu exposes three items:

- **Summarise** — `type: 'summary'`
- **Analyze** — `type: 'analysis'`
- **Forecast** — `type: 'forecast'`

Selecting a type opens the chat panel with a pre-filled message and submits it automatically. The request can be aborted by clicking the stop button in the chat panel.

## Page summary via chat

When `features.aiChat` is enabled and `aiConfig` is configured, the AI chat panel includes a **Summarise page** suggestion chip. Clicking it prompts the AI to write an executive summary of the key insights from the page — focused on the data, trends, and any detected anomalies rather than the page structure. The AI calls the `summarise_page` tool to gather per-widget data snapshots (sampled rows, stats, and anomaly information for chart widgets), then writes a flowing narrative starting with the most important finding, referencing specific widget names only where it helps locate the data being described.

Unlike the old standalone summary drawer, the page summary lives in the chat panel so you can follow up with questions or refinements in the same conversation.

## Programmatic API

You can also call insight generation directly without using the built-in UI:

```tsx
import {
  generateWidgetInsight,
  generateDashboardSummary,
  type StudioInsightOptions,
} from '@mui/x-studio';

// Widget-level insight
const result = await generateWidgetInsight(widgetId, controller, aiConfig, {
  type: 'analysis',
});
console.log(result.text);

// Dashboard-level summary
const summary = await generateDashboardSummary(controller, aiConfig, {
  signal: abortController.signal,
});
console.log(summary.text);
```

### `StudioInsightOptions`

| Property          | Type                                    | Default | Description                                                       |
| :---------------- | :-------------------------------------- | :------ | :---------------------------------------------------------------- |
| `type`            | `'summary' \| 'analysis' \| 'forecast'` | —       | The kind of insight to generate                                   |
| `forecastPeriods` | `number`                                | `6`     | Number of periods to forecast. Only used when `type = 'forecast'` |
| `signal`          | `AbortSignal`                           | —       | Optional abort signal to cancel the in-flight request             |

### `StudioInsightResult`

| Property | Type     | Description                |
| :------- | :------- | :------------------------- |
| `text`   | `string` | The generated insight text |

## Customisation

The insight request uses the same `aiConfig.endpoint`, `aiConfig.model`, and `aiConfig.headers` settings as the chat assistant. No additional configuration is required.

To limit which insight types are available, you can restrict the UI by providing a custom `StudioWidgetCardActionsOverlay` through the `slots` prop on the `Studio` component.
