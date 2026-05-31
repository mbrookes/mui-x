# AI Insights

<p class="description">Generate AI-powered summaries, analyses, and forecasts for widgets or the entire dashboard.</p>

## Overview

AI Insights provide on-demand narrative intelligence using the same AI endpoint configured for the [AI Assistant](../setup/). Unlike the chat assistant, insights are one-shot requests — they do not maintain conversation history.

Insights come in three flavours:

| Type         | Description                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------- |
| **Summary**  | A concise description of what the widget currently shows                                          |
| **Analysis** | A deeper interpretation highlighting trends, comparisons, and notable patterns                    |
| **Forecast** | A forward-looking projection based on existing data (best for time-series charts and KPI widgets) |

A **Dashboard Summary** can also be generated for the entire active page.

## Prerequisites

AI Insights require the same `aiConfig` setup as the AI Assistant. See the [Setup guide](../setup/) for full instructions.

## Widget insights

When `aiConfig` is configured, each widget card shows an **AI Insight** button in the overflow menu (⋮). Clicking it opens an insight panel inline within the card.

### Selecting the insight type

The overflow menu exposes three items:

- **Summarise** — `type: 'summary'`
- **Analyse** — `type: 'analysis'`
- **Forecast** — `type: 'forecast'`

Selecting a type triggers a new request. The panel can be closed by clicking **✕**, which also aborts any in-progress request.

## Dashboard summary

When `features.aiChat` is enabled and `aiConfig` is configured, a secondary **Summarise dashboard** button appears above the AI chat button (bottom-right corner). Clicking it generates a narrative overview of all widgets on the active dashboard page and displays the result in a slide-in bottom panel.

The panel provides **Copy** and **Regenerate** actions.

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
| ----------------- | --------------------------------------- | ------- | ----------------------------------------------------------------- |
| `type`            | `'summary' \| 'analysis' \| 'forecast'` | —       | The kind of insight to generate                                   |
| `forecastPeriods` | `number`                                | `6`     | Number of periods to forecast. Only used when `type = 'forecast'` |
| `signal`          | `AbortSignal`                           | —       | Optional abort signal to cancel the in-flight request             |

### `StudioInsightResult`

| Property | Type     | Description                |
| -------- | -------- | -------------------------- |
| `text`   | `string` | The generated insight text |

## Customisation

The insight request uses the same `aiConfig.endpoint`, `aiConfig.model`, and `aiConfig.headers` settings as the chat assistant. No additional configuration is required.

To limit which insight types are available, you can restrict the UI by providing a custom `StudioWidgetCardActionsOverlay` through the `slots` prop on the `Studio` component.

### `StudioInsightPanel` sx prop

When using `StudioInsightPanel` standalone in a composed layout, use the `sx` prop to override its default absolute positioning:

```tsx
<StudioInsightPanel
  insight={insight}
  loading={loading}
  error={error}
  activeType={type}
  onClose={handleClose}
  onRegenerate={handleRegenerate}
  sx={{ position: 'relative', bottom: 'auto', left: 'auto', right: 'auto' }}
/>
```
