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

| | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Package | `@mui/x-studio` | `ag-studio-react` |
| Frameworks | React | React, Angular, Vue 3, JavaScript |
| Source | Open source | Closed-source commercial |
| Built on | MUI X Charts + MUI X Data Grid | AG Charts + AG Grid |
| Default entry point | `<Studio initialState={…} />` | `<AgStudio data={…} mode="edit" />` |
| API style | Props + headless composition | Props + panel config |

The most notable differences are:

- **Layout:** AG Studio uses a 12-column drag-resize grid; MUI X Studio uses equal-width rows. Both support drag-and-drop reorder.
- **Composition:** MUI X Studio exports every building block independently for custom layouts; AG Studio exposes a single component with a `panels` prop.
- **Filtering:** MUI X Studio has a richer filter system with relative dates, metric references, rank/Top-N, and selection mode; AG Studio's filter API is simpler.
- **AI:** AG Studio uses a multi-agent pipeline with structured planning; MUI X Studio uses simple tool calls via any OpenAI-compatible endpoint.

## Widget Types

| Widget | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Chart (10 sub-types) | ✅ | ✅ (via AG Charts — full type list not documented) |
| KPI headline value | ✅ with sparkline and trend badge | ✅ |
| Grid / table | ✅ | ✅ with row grouping and aggregation |
| Text / narrative | ✅ (title, subtitle, Markdown body) | ❌ |
| On-canvas filter | ✅ (date range, multi-select, toggle, slider) | ✅ (date range, list, button) |
| Custom widget API | ❌ | ✅ (`AgWidgetDefinition`) |

### Charts

MUI X Studio defines 10 explicit chart types: `bar`, `bar-stacked`, `bar-100`, `line`, `area`, `area-stacked`, `area-100`, `pie`, `donut`, `scatter`.
All bar types support a `barLayout: 'horizontal'` option.

Additional chart features include date/time grouping on the X-axis (day/week/month/quarter/year), multi-series Y-axis, a split-by (series) field for grouped charts from a single measure, and secondary Y-axis support.

AG Studio is built on AG Charts and inherits its full chart catalogue (which includes waterfall, heatmap, treemap, and bubble), but the [AG Studio Widgets documentation](https://www.ag-grid.com/studio/react/widgets/) does not enumerate available chart sub-types.

### KPI Widget

MUI X Studio's KPI widget includes features not documented in AG Studio:

- **Sparkline** — line or bar, with fill, configurable granularity (auto/day/week/month/quarter/year)
- **Cumulative mode** — running total sparkline
- **Cross-source sparkline** — pull the time series from a related data source
- **Trend badge** — period-over-period comparison with three modes and "lower is better" invert

### Grid Widget

[AG Studio's grid widget](https://www.ag-grid.com/studio/react/widgets/) (built on AG Grid Enterprise) supports row grouping and in-grid aggregation.
MUI X Studio's grid widget (built on MUI X Data Grid) does not currently support row grouping.

### Text Widget

MUI X Studio ships a `StudioTextWidget` with title, subtitle, and body fields, each with independent font, size, colour, and alignment controls.
AG Studio's Static Content widget supports text and images but offers less configuration.

## Data Model

### Source Types

| Type | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Inline (synchronous) rows | ✅ | ✅ |
| Async callback | ❌ | ✅ (`getData()`) |
| Server-side data engine | ❌ | ✅ (`AgDataEngine`) |
| Shared engine (cross-instance) | ❌ | ✅ (`createDataEngine()`) |
| On-demand reload | ❌ | ✅ (`api.reload()`) |

### Field Types

Both products support `string`, `number`, `boolean`, `date`, `datetime`, `percent`, and `currency` field types.
AG Studio additionally supports custom `valueFormatter` and `serializer` functions per field, and an `aiDescription` field to improve AI query quality (see [AG Studio — Data types](https://www.ag-grid.com/studio/react/data-types/)).

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
AG Studio's public filter documentation describes `equals`, `not equals`, and `contains` for condition filters.

### Advanced Features (MUI X Studio only)

| Feature | Description |
| :--- | :--- |
| **Relative date values** | Filter values like "5 days ago" or "next 2 weeks" — `past`/`next` + time unit |
| **Metric reference** | Filter threshold driven by a live aggregate from a metrics data source (`StudioMetricRef`) |
| **Rank / Top-N mode** | `filterMode: 'rank'` — Top-N or Bottom-N rows by a configurable scoring field |
| **Selection mode** | `filterMode: 'selection'` — multi-value checkbox filter |
| **Cross-source filters** | Filter by a field on a related source (`filterSourceId`); join resolved automatically |
| **Compound conditions** | Two operators on the same field with `and`/`or` conjunction |

AG Studio's filter documentation describes Page filters, Widget filters, Cross-filters, Interactive filters, and Rank filters.
The Rank filter is available in both products. The other advanced features above are not described in AG Studio's public documentation.

## Expression System

Both products implement an expression system for calculated columns (per-row values) and measures (aggregate values).
The APIs are structurally identical: an `expressionFields` array, a `isMeasure` flag, and a tree of expression nodes.

### Operators

Both products implement arithmetic (`add`, `subtract`, `multiply`, `divide`, `modulo`), comparison (`equals`, `notEqual`, `lessThan`, `greaterThan`, `lessThanOrEqual`, `greaterThanOrEqual`), boolean (`and`, `or`, `not`), conditional (`if`), set membership (`in`), null checks (`isNull`, `isNotNull`, `isTrue`, `isFalse`), and date difference (`datediff` with 10+ time units)
(see [AG Studio — Expressions](https://www.ag-grid.com/studio/react/expressions/)).

MUI X Studio additionally implements string operators (`concat`, `lower`, `upper`, `trim`, `length`), math operators (`abs`, `round`, `floor`, `ceil`), null coalescence (`coalesce`), date component extraction (`year`, `month`, `day`), and **join field expressions** that reference a field on a related source directly inside an expression without materialising a join.

### Visual Editor

MUI X Studio ships a `StudioExpressionFieldDialog` — a visual tree editor for building expression fields with an operator picker, field selector, live AST preview, and inline validation.
AG Studio documents `expressionFields` as a state configuration key but does not describe a visual authoring UI in its public documentation.

## Layout Engine

| Feature | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Layout model | Equal-width rows | 12-column grid |
| Widget resize | ❌ | ✅ (drag handle, snaps to grid) |
| Drag-and-drop reorder | ✅ | ✅ |
| Page min/max width | ❌ | ✅ (720px default min, configurable max) |
| Fixed-height (poster) mode | ❌ | ✅ |
| Mobile / responsive | ❌ | ❌ (both products require 720px+) |

AG Studio's 12-column grid (see [AG Studio — Modes & Layout](https://www.ag-grid.com/studio/react/modes-layout/)) allows non-uniform column widths (a 4+8 split, a 3+3+6 layout, and so on), while MUI X Studio's row model divides available width equally among all widgets in a row.
AG Studio also supports resizing individual widgets by dragging their edges.

## AI Assistant

Both products use a bring-your-own LLM pattern — you supply an adapter connecting to OpenAI, Anthropic, or any compatible endpoint.

| Feature | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Floating chat panel | ✅ | ✅ |
| BYO LLM adapter | ✅ (`aiConfig.endpoint`) | ✅ (`executeTurn` callback) |
| Dashboard-from-prompt | ✅ | ✅ |
| AI tool calls | ✅ (7 tools) | ✅ |
| Multi-agent orchestration | ❌ | ✅ (5 specialised agents) |
| Structured planning before execution | ❌ | ✅ |
| Data querying (ask questions) | ❌ | ✅ |
| Requires separate AI licence | ❌ | ✅ ("Pro with AI") |

MUI X Studio's AI tools: `get_dashboard_state`, `add_page`, `set_dashboard_title`, `add_widget`, `update_widget`, `remove_widget`, `set_widget_layout`.

AG Studio's agent profiles: Lead (routing), Planning (creates execution plan), Data (queries sources), Page (layout and page filters), Widget (data mappings and formatting).
See [AG Studio — AI Assistant](https://www.ag-grid.com/studio/react/ai/) and [AG Studio — AI Agentic Experience](https://www.ag-grid.com/studio/react/ai-ax/).

## State Management & Persistence

| Feature | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Serialisable JSON state | ✅ | ✅ |
| `initialState` prop | ✅ | ✅ |
| State change callback | ✅ (`onStateChange`) | ✅ (`onStateUpdated`) |
| Imperative `getState` / `setState` | ✅ | ✅ |
| Schema version + migration | ✅ | ❌ |
| File download / upload helpers | ✅ | ❌ |
| 100-step undo / redo | ✅ | ❌ |
| Lifecycle events | ❌ | ✅ (`onApiReady`, `onErrorRaised`) |

MUI X Studio includes a `schemaVersion` field and a sequential migration pipeline so states saved from an older version can be automatically upgraded.
AG Studio's public state documentation does not describe versioning or migration.
See [AG Studio — State](https://www.ag-grid.com/studio/react/state/) and [AG Studio — Studio API](https://www.ag-grid.com/studio/react/studio-api/).

The `downloadState()` and `uploadState()` helpers in MUI X Studio wrap save/load with browser file-download and file-picker APIs.
AG Studio exposes `getState()`/`setState()` and leaves file I/O to the host app.

## Theming & Customisation

| Feature | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Theme system | MUI (`createTheme`) | AG Grid (`studioTheme.withParams`) |
| Dark mode | ✅ (MUI `palette.mode: 'dark'`) | ✅ |
| Per-page background colour | ✅ | ❌ |
| Per-page card colour, padding, radius, border | ✅ | ❌ |
| Slot props (deep sub-component customisation) | ✅ | ❌ |
| Custom sidebar layout | ✅ (stacked / tabbed) | ✅ (left/right panel config) |
| Headless composition | ✅ | ❌ |
| Custom widget API | ❌ | ✅ |
| Localisation / i18n | ❌ | ✅ (`localeText`) |
| RTL support | ❌ | ✅ (`enableRtl`) |

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
- [Slot props](/x/react-studio/customization/slot-props/) — deep customisation unique to x-studio
