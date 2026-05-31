---
productId: x-studio
title: MUI X Studio vs AG Studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# MUI X Studio vs AG Studio

<p class="description">A feature-by-feature comparison of MUI X Studio and AG Studio covering widgets, data, filters, expressions, layout, AI, and more.</p>

## Overview

Both products are embeddable dashboard builders that let end users create interactive dashboards without writing layout or data-wiring code.
They share the same pattern: a drag-and-drop canvas, sidebar panels, and a serialisable JSON state model.

|                     | MUI X Studio                   | AG Studio                           |
| :------------------ | :----------------------------- | :---------------------------------- |
| Package             | `@mui/x-studio`                | `ag-studio-react`                   |
| Frameworks          | React                          | React, Angular, Vue 3, JavaScript   |
| Source              | Open core                      | Closed-source commercial            |
| Built on            | MUI X Charts + MUI X Data Grid | AG Charts + AG Grid                 |
| Default entry point | `<Studio initialState={…} />`  | `<AgStudio data={…} mode="edit" />` |
| API style           | Props + headless composition   | Props + panel config                |

The most notable differences are:

- **Layout:** AG Studio uses a 24-column free-placement grid (configurable) — dragging positions a widget at explicit coordinates; no other widgets move. MUI X Studio uses ordered rows of widgets with drag-to-reorder that auto-reflows the layout.
- **Composition:** MUI X Studio exports every building block independently for custom layouts; AG Studio exposes a single component with a `panels` prop.
- **Filtering:** MUI X Studio has a richer filter system with relative dates, metric references, rank/Top-N, and selection mode, plus dedicated filter bar components (`StudioDateRangeBar`, `StudioQuickFilterBar`) that sit above the canvas; AG Studio's filter API is simpler.
- **AI:** AG Studio uses a multi-agent pipeline with structured planning; MUI X Studio uses simple tool calls via any OpenAI-compatible endpoint.

## Widget Types

| Widget               | MUI X Studio                                  | AG Studio                                          |
| :------------------- | :-------------------------------------------- | :------------------------------------------------- |
| Chart (15 sub-types) | ✅                                            | ✅ (via AG Charts — full type list not documented) |
| KPI headline value   | ✅ with sparkline and trend badge             | ✅                                                 |
| Grid / table         | ✅                                            | ✅ with group-by aggregation                       |
| Pivot table          | ✅                                            | ❌                                                 |
| Map / choropleth     | ✅                                            | ❌                                                 |
| Text / narrative     | ✅ (title, subtitle, Markdown body)           | ❌                                                 |
| On-canvas filter     | ✅ (date range, multi-select, toggle, slider) | ✅ (list, button, date)                            |
| Custom widget API    | ❌                                            | ✅ (`AgWidgetDefinition`)                          |

### Charts

MUI X Studio defines 15 explicit chart types: `bar`, `bar-stacked`, `bar-100`, `line`, `area`, `area-stacked`, `area-100`, `mixed` (bar + line on the same axes), `heatmap`, `funnel`, `gantt` (timeline), `gauge`, `pie`, `donut`, `scatter`.
All bar types support a `barLayout: 'horizontal'` option.

Additional chart features include date/time grouping on the X-axis (day/week/month/quarter/year), multi-series Y-axis, a split-by (series) field for grouped charts from a single measure, secondary Y-axis support, reference-line annotations (horizontal or vertical) with optional labels, and **axis sorting** — x-axis categories can be sorted alphabetically/numerically (`sortBy: 'category'`) or ranked by aggregated value (`sortBy: 'value'`), in ascending or descending order.

AG Studio is built on AG Charts and inherits its full chart catalogue (which includes waterfall, heatmap, treemap, bubble, and gauge), but the [AG Studio Widgets documentation](https://www.ag-grid.com/studio/react/widgets/) does not enumerate available chart sub-types.

### KPI Widget

MUI X Studio's KPI widget includes features not documented in AG Studio:

- **Sparkline** — line or bar, with fill, configurable granularity (auto/day/week/month/quarter/year)
- **Cumulative mode** — running total sparkline
- **Cross-source sparkline** — pull the time series from a related data source
- **Trend badge** — period-over-period comparison with three modes and "lower is better" invert

### Grid Widget

MUI X Studio's grid widget (built on MUI X Data Grid) supports group-by aggregation via `gridGroupByField` — grouping raw rows by a category field and computing per-column aggregations.
Both products' grid widgets support group-by aggregation.

### Text Widget

MUI X Studio ships a `StudioTextWidget` with title, subtitle, and body fields, each with independent font, size, colour, and alignment controls.
AG Studio's Static Content widget supports text and images but offers less configuration.

### Pivot Widget

MUI X Studio's `StudioPivotWidget` renders a cross-tabulation with configurable row field, column field, and value field.
The table can be exported to CSV.

AG Studio does not include a dedicated pivot widget.

### Map Widget

MUI X Studio's `StudioMapWidget` renders a choropleth map using a country field (ISO alpha-2 codes) and an optional value field with aggregation.
Five built-in colour schemes are available (`blues`, `reds`, `greens`, `oranges`, `purples`).
Country fields from related data sources are also supported.

AG Studio does not include a built-in map widget.

## Data Model

### Source Types

| Type                           | MUI X Studio                                        | AG Studio                 |
| :----------------------------- | :-------------------------------------------------- | :------------------------ |
| Inline (synchronous) rows      | ✅                                                  | ✅                        |
| Async callback                 | ✅ (`createSimpleAdapter`, `createBatchingAdapter`) | ✅ (`getData()`)          |
| Server-side data middleware    | ✅ (`@mui/x-studio-server`)                         | ✅ (`AgDataEngine`)       |
| Shared engine (cross-instance) | ❌                                                  | ✅ (`createDataEngine()`) |
| On-demand reload               | ❌                                                  | ✅ (`api.reload()`)       |

MUI X Studio's async adapter interface (`StudioDataSourceAdapter`) mirrors the synchronous rows pipeline — `getRows(descriptor): Promise<StudioQueryResult>` — and is attached at runtime via `ref.setDataSourceAdapter(sourceId, adapter)`.
`@mui/x-studio-server` provides a framework-agnostic Node.js middleware (`handleBatchQuery`) that batches and proxies queries from the browser, keeping data and API keys server-side.
AG Studio's `AgDataEngine` interface lets you implement a custom backend data engine (`init()`, `getDataSources()`, `execute()`) that receives Studio's queries and forwards them to your database or API.
`createDataEngine()` is a separate in-browser factory for sharing a single engine across multiple Studio instances.

### Field Types

Both products support `string`, `number`, `boolean`, `date`, and `datetime` field types.
Percentage and currency display formats are applied to `number` fields in both products, and are not separate field types.
AG Studio additionally supports custom `valueFormatter` and `serializer` functions per field.
AG Studio's table and dataset definitions also accept an `aiDescription` property to improve AI query quality (see [AG Studio — Data types](https://www.ag-grid.com/studio/react/data-types/)).

MUI X Studio supports a **field capability override** system that lets you mark a field as `categorical`, `numeric`, or `temporal` regardless of its raw type — enabling fields like a numeric product ID to behave as a category in chart dimensions.

### Relationships

Both products support multi-table joins via a declarative relationship model:

```ts
// MUI X Studio
{ id, sourceId, sourceField, targetId, targetField, type: 'many-to-one' }

// AG Studio
{ id, source: { tableId, fieldId }, target: { tableId, fieldId }, type: 'many-to-one' }
```

MUI X Studio resolves relationships automatically for cross-source cross-filters and KPI sparkline time fields.
AG Studio's shared data engine can join across sources (see [AG Studio — Relationships](https://www.ag-grid.com/studio/react/data-relationships/)).

## Filter System

### Filter Scopes

Both products support page, widget, cross-filter, and interactive (on-canvas widget) filter scopes
(see [AG Studio — Filters](https://www.ag-grid.com/studio/react/filters/)).

### Condition Operators

MUI X Studio supports 15+ condition operators including `contains`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty`, and `between`.
AG Studio's public filter documentation describes Simple Filters (condition operators: equals, not equals, contains, and numeric comparisons), a Selection filter for value picklists, and a Rank filter for Top-N / Bottom-N at widget level.

### Advanced Features (MUI X Studio only)

| Feature                  | Description                                                                                |
| :----------------------- | :----------------------------------------------------------------------------------------- |
| **Relative date values** | Filter values like "5 days ago" or "next 2 weeks" — `past`/`next` + time unit              |
| **Metric reference**     | Filter threshold driven by a live aggregate from a metrics data source (`StudioMetricRef`) |
| **Selection mode**       | `filterMode: 'selection'` — multi-value checkbox filter                                    |
| **Cross-source filters** | Filter by a field on a related source (`filterSourceId`); join resolved automatically      |
| **Compound conditions**  | Two operators on the same field with `and`/`or` conjunction                                |

Both products support Rank / Top-N filtering: AG Studio's Rank filter is available at widget level; MUI X Studio also exposes `filterMode: 'rank'` at page and widget scope.

### Additional MUI X Studio Filter Features

| Feature                         | Description                                                                                                            |
| :------------------------------ | :--------------------------------------------------------------------------------------------------------------------- |
| **Dashboard date range bar**    | `StudioDateRangeBar` above the canvas — 5 presets (All time / YTD / This month / Last 3 months / Last 12 months)       |
| **Quick filter bar**            | `StudioQuickFilterBar` above the canvas — compact row of the active interactive filter widgets                         |
| **Global filter search**        | Text search across all current filter values in the Filters panel                                                      |
| **Filter dependency (cascade)** | `dependsOn` on a filter field — available values update automatically when the referenced filter changes               |
| **Saved views**                 | Named snapshots of the full filter state stored in dashboard state, switchable from the Filters panel                  |
| **Shareable filter links**      | Active filter state URL-encoded as `?fv=<base64-JSON>`; "Copy link" toolbar button lets users share exact filter views |

AG Studio's filter documentation does not describe equivalents for these features.

## Expression System

Both products implement an expression system for calculated columns (per-row values) and measures (aggregate values).
The APIs are structurally identical: an `expressionFields` array, a `isMeasure` flag, and a tree of expression nodes.

### Operators

Both products implement arithmetic (`add`, `subtract`, `multiply`, `divide`, `modulo`), comparison (`equals`, `notEqual`, `lessThan`, `greaterThan`, `lessThanOrEqual`, `greaterThanOrEqual`), boolean (`and`, `or`, `not`), conditional (`if`), set membership (`in`), null checks (`isNull`, `isNotNull`, `isTrue`, `isFalse`), and date difference (`datediff` with 10+ time units)
(see [AG Studio — Expressions](https://www.ag-grid.com/studio/react/expressions/)).

MUI X Studio additionally implements **join field expressions** — a fourth expression node type (`StudioJoinFieldExpression: { joinSourceId, fieldId }`) that references a field on a related data source directly inside an expression without materialising a join.
AG Studio's expression tree has three node types (Function, Value, Field); MUI X Studio adds a fourth.

### Visual Editor

MUI X Studio ships a `StudioExpressionFieldDialog` — a visual tree editor for building expression fields with an operator picker, field selector, live AST preview, and inline validation.
AG Studio documents `expressionFields` as a state configuration key but does not describe a visual authoring UI in its public documentation.

## Layout Engine

| Feature                    | MUI X Studio                                    | AG Studio                                |
| :------------------------- | :---------------------------------------------- | :--------------------------------------- |
| Layout model               | Equal-width rows (24-column col-spans)          | 24-column grid (configurable)            |
| Widget resize              | ✅ (col-span drag handle)                       | ✅ (drag handle, snaps to grid)          |
| Drag-and-drop reorder      | ✅ (auto-reflows row order)                     | ❌                                       |
| Free-placement positioning | ❌                                              | ✅ (snap-to-grid; must clear space)      |
| Page min/max width         | ❌                                              | ✅ (720px default min, configurable max) |
| Fixed-height (poster) mode | ❌                                              | ✅                                       |
| Mobile / responsive        | ✅ (`stackBreakpoint`, 3-tier layout)           | ⚠️ (scales; 720px min, configurable)     |

AG Studio's 24-column grid (see [AG Studio — Modes & Layout](https://www.ag-grid.com/studio/react/modes-layout/)) allows non-uniform column widths (an 8+16 split, a 6+6+12 layout, and so on).
MUI X Studio uses a 24-column grid for col-spans — each widget defaults to equal width but can be resized via a drag handle between adjacent widgets that snaps to the grid (minimum span: 6 columns, or 25% of row width).
MUI X Studio's `stackBreakpoint` prop (default 600px) controls view-mode responsive layout in three tiers:

| Canvas width              | Behaviour                                                                 |
| :------------------------ | :------------------------------------------------------------------------ |
| ≥ `2 × stackBreakpoint`   | Configured col-spans used as-is (normal layout)                           |
| `stackBreakpoint` to `2×` | Each widget's span is doubled (capped at 100%), giving a 2-up layout      |
| < `stackBreakpoint`       | All widgets stack to full width (1-up layout)                             |

For example, with the default `stackBreakpoint: 600` and four equal-width widgets (each 25%):
four-across → two-across at 600–1200 px → single-column below 600 px.
AG Studio pages scale to the viewport within configured page boundaries; the default minimum page width is 720px but is configurable via the `layout` prop.

## AI Assistant

Both products use a bring-your-own LLM pattern — you supply an adapter connecting to OpenAI, Anthropic, or any compatible endpoint.

| Feature                              | MUI X Studio             | AG Studio                   |
| :----------------------------------- | :----------------------- | :-------------------------- |
| Floating chat panel                  | ✅                       | ✅                          |
| BYO LLM adapter                      | ✅ (`aiConfig.endpoint`) | ✅ (`executeTurn` callback) |
| Dashboard-from-prompt                | ✅                       | ✅                          |
| Natural language widget creation     | ✅                       | ✅                          |
| AI tool calls                        | ✅ (8 tools)             | ✅                          |
| Per-widget AI assistant              | ✅ (widget-focused chat) | ❌                          |
| Multi-agent orchestration            | ❌                       | ✅ (5 specialised agents)   |
| Structured planning before execution | ❌                       | ✅                          |
| Data querying (ask questions)        | ❌                       | ✅                          |
| Requires separate AI licence         | ❌                       | ✅ ("Pro with AI")          |

MUI X Studio's AI tools: `get_dashboard_state`, `add_page`, `set_dashboard_title`, `add_widget`, `update_widget`, `remove_widget`, `set_widget_layout`, `set_widget_width`.

AG Studio's agent profiles: Lead (routing), Planning (creates execution plan), Data (queries sources), Page (layout and page filters), Widget (data mappings and formatting).
See [AG Studio — AI Assistant](https://www.ag-grid.com/studio/react/ai/) and [AG Studio — AI Agentic Experience](https://www.ag-grid.com/studio/react/ai-ax/).

## State Management & Persistence

| Feature                            | MUI X Studio         | AG Studio                          |
| :--------------------------------- | :------------------- | :--------------------------------- |
| Serialisable JSON state            | ✅                   | ✅                                 |
| `initialState` prop                | ✅                   | ✅                                 |
| State change callback              | ✅ (`onStateChange`) | ✅ (`onStateUpdated`)              |
| Imperative `getState` / `setState` | ✅                   | ✅                                 |
| Schema version + migration         | ✅                   | ❌                                 |
| File download / upload helpers     | ✅                   | ❌                                 |
| 100-step undo / redo               | ✅                   | ❌                                 |
| Lifecycle events                   | ❌                   | ✅ (`onApiReady`, `onErrorRaised`) |

MUI X Studio includes a `schemaVersion` field and a sequential migration pipeline so states saved from an older version can be automatically upgraded.
AG Studio's public state documentation does not describe versioning or migration.
See [AG Studio — State](https://www.ag-grid.com/studio/react/state/) and [AG Studio — Studio API](https://www.ag-grid.com/studio/react/studio-api/).

MUI X Studio exposes `serializeState()` / `loadSerializedState()` on the `StudioHandle` ref and leaves file I/O to the host app.
AG Studio exposes `getState()`/`setState()` and similarly leaves file I/O to the host app.

## Theming & Customisation

| Feature                                       | MUI X Studio                                  | AG Studio                          |
| :-------------------------------------------- | :-------------------------------------------- | :--------------------------------- |
| Theme system                                  | MUI (`createTheme`)                           | AG Grid (`studioTheme.withParams`) |
| Dark mode                                     | ✅ (MUI `palette.mode: 'dark'`)               | ✅                                 |
| Per-page background colour                    | ✅                                            | ✅                                 |
| Per-page card colour, padding, radius, border | ✅                                            | ❌                                 |
| Slot props (deep sub-component customisation) | ✅                                            | ❌                                 |
| Custom sidebar layout                         | ✅ (stacked / tabbed; left / right)           | ✅ (left/right panel config)       |
| Headless composition                          | ✅                                            | ❌                                 |
| Custom widget API                             | ❌                                            | ✅                                 |
| Localisation / i18n                           | ✅ (`StudioLocaleText`; ptBR locale included) | ✅ (`localeText`; 31 locales)      |
| RTL support                                   | ❌                                            | ✅ (`enableRtl`)                   |
| Runtime feature flags                         | ✅ (`StudioFeatureFlags` — 26 flags)          | ❌                                 |

`StudioFeatureFlags` lets you gate entire feature areas at runtime — for example `{ filters: false }` hides the Filters panel entirely, `{ aiChat: false }` removes the AI button, `{ pivot: false }` removes the Pivot widget type, and so on.
Individual flags: `compose`, `filters`, `savedFilterViews`, `dataManagement`, `aiChat`, `dateRangeBar`, `grid`, `chart`, `kpi`, `text`, `filter`, `pivot`, `map`, `relationships`, `widgetFilters`, `kpiSparkline`, `kpiTrend`, `kpiTarget`, `chartAnnotations`, `gridGroupBy`, `gridSummary`, `gridConditionalFormats`, `calculatedFields`, `kpiCalculatedFields`, `chartCalculatedFields`, `gridCalculatedFields`.

### Composition API

MUI X Studio exports every building block as an independent component:

```tsx
<StudioProvider controller={controller}>
  <DrawerPanel drawer="data" title="Data">
    <StudioDataDrawer />
  </DrawerPanel>
  <StudioCanvas slotProps={{ widgetCard: { paper: { elevation: 0 } } }} />
  <StudioChatPanel aiConfig={aiConfig} open={chatOpen} onClose={close} />
</StudioProvider>
```

AG Studio exposes a single `<AgStudio>` component.
Individual panel components are not available for custom placement.
Panel visibility and side can be configured via the `panels` prop.
See [AG Studio — Studio Properties](https://www.ag-grid.com/studio/react/studio-properties/).

## AG Studio sources

All AG Studio feature claims above are sourced from the AG Studio public documentation (May 2026):

1. [Quick start](https://www.ag-grid.com/studio/react/quick-start/)
2. [Licence & Pricing](https://www.ag-grid.com/studio/license-pricing/)
3. [Studio Properties](https://www.ag-grid.com/studio/react/studio-properties/)
4. [Modes & Layout](https://www.ag-grid.com/studio/react/modes-layout/)
5. [Widgets](https://www.ag-grid.com/studio/react/widgets/)
6. [Custom Widgets](https://www.ag-grid.com/studio/react/custom-widgets/)
7. [Filters](https://www.ag-grid.com/studio/react/filters/)
8. [Expressions](https://www.ag-grid.com/studio/react/expressions/)
9. [AI Assistant](https://www.ag-grid.com/studio/react/ai/) and [AI Agentic Experience](https://www.ag-grid.com/studio/react/ai-ax/)
10. [Data types](https://www.ag-grid.com/studio/react/data-types/)
11. [Sync data](https://www.ag-grid.com/studio/react/data-sync/)
12. [Async data sources](https://www.ag-grid.com/studio/react/data-async/)
13. [Server-side data](https://www.ag-grid.com/studio/react/server-side-data/)
14. [Data engine](https://www.ag-grid.com/studio/react/data-engine/)
15. [Relationships](https://www.ag-grid.com/studio/react/data-relationships/)
16. [State](https://www.ag-grid.com/studio/react/state/), [Studio API](https://www.ag-grid.com/studio/react/studio-api/), [Studio Events](https://www.ag-grid.com/studio/react/studio-events/)
17. [Theming](https://www.ag-grid.com/studio/react/theming/)
18. [Localisation](https://www.ag-grid.com/studio/react/localisation/)

## See also

- [Overview](/x/react-studio/) — what x-studio is and what it's designed for
- [Quickstart](/x/react-studio/quickstart/) — get a working studio running in minutes
- [Async data adapters](/x/react-studio/data/async-adapters/) — `createSimpleAdapter` and `createBatchingAdapter`
- [Server middleware](/x/react-studio/data/server-middleware/) — `@mui/x-studio-server` Node.js package
- [Localisation](/x/react-studio/customization/localisation/) — `StudioLocaleText` and bundled locales
- [Slot props](/x/react-studio/customization/slot-props/) — deep customisation unique to x-studio
