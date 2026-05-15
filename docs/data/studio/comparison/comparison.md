---
productId: x-studio
title: MUI X Studio vs AG Studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# MUI X Studio vs AG Studio

<p class="description">A feature-by-feature comparison of MUI X Studio and AG Studio covering widgets, data, filters, expressions, layout, AI, and more.</p>

## Overview

Both products are embeddable dashboard builders that let end users create interactive dashboards without writing layout or data-wiring code. They share the same pattern: a drag-and-drop canvas, sidebar panels, and a serialisable JSON state model.

| | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Package | `@mui/x-studio` | `ag-studio-react` |
| Frameworks | React | React, Angular, Vue 3, JavaScript[^1] |
| Source | Open source | Closed-source commercial[^2] |
| Built on | MUI X Charts + MUI X Data Grid | AG Charts + AG Grid[^1] |
| Default entry point | `<Studio initialState={…} />` | `<AgStudio data={…} mode="edit" />`[^3] |
| API style | Props + headless composition | Props + panel config[^3] |

The most notable differences are:

- **Layout:** AG Studio uses a 12-column drag-resize grid[^4]; MUI X Studio uses equal-width rows. Both support drag-and-drop reorder.
- **Composition:** MUI X Studio exports every building block independently for custom layouts; AG Studio exposes a single component with a `panels` prop[^3].
- **Filtering:** MUI X Studio has a richer filter system with relative dates, metric references, rank/Top-N, and selection mode[^5]; AG Studio's filter API is simpler.
- **AI:** AG Studio uses a multi-agent pipeline with structured planning[^6]; MUI X Studio uses simple tool calls via any OpenAI-compatible endpoint.

---

## Widget Types

| Widget | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Chart (10 sub-types) | ✅ | ✅ (via AG Charts — full type list not documented)[^7] |
| KPI headline value | ✅ with sparkline and trend badge | ✅[^7] |
| Grid / table | ✅ | ✅ with row grouping and aggregation[^7] |
| Text / narrative | ✅ (title, subtitle, Markdown body) | ❌[^8] |
| On-canvas filter | ✅ (date range, multi-select, toggle, slider) | ✅ (date range, list, button)[^9] |
| Custom widget API | ❌ | ✅ (`AgWidgetDefinition`)[^10] |

### Charts

MUI X Studio defines 10 explicit chart types: `bar`, `bar-stacked`, `bar-100`, `line`, `area`, `area-stacked`, `area-100`, `pie`, `donut`, `scatter`. All bar types support a `barLayout: 'horizontal'` option.

Additional chart features include date/time grouping on the X-axis (day/week/month/quarter/year), multi-series Y-axis, a split-by (series) field for grouped charts from a single measure, and secondary Y-axis support.

AG Studio is built on AG Charts and inherits its full chart catalogue (which includes waterfall, heatmap, treemap, and bubble), but the AG Studio Widgets documentation does not enumerate available chart sub-types[^7].

### KPI Widget

MUI X Studio's KPI widget includes features not documented in AG Studio[^11]:

- **Sparkline** — line or bar, with fill, configurable granularity (auto/day/week/month/quarter/year)
- **Cumulative mode** — running total sparkline
- **Cross-source sparkline** — pull the time series from a related data source
- **Trend badge** — period-over-period comparison with three modes and "lower is better" invert

### Grid Widget

AG Studio's grid widget (built on AG Grid Enterprise) supports row grouping and in-grid aggregation[^7]. MUI X Studio's grid widget (built on MUI X Data Grid) does not currently support row grouping.

### Text Widget

MUI X Studio ships a `StudioTextWidget` with title, subtitle, and body fields, each with independent font, size, colour, and alignment controls. AG Studio documents Table, Chart, KPI, Static Content, and Filter widget types; its Static Content widget supports text and images but offers less configuration[^8].

---

## Data Model

### Source Types

| Type | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Inline (synchronous) rows | ✅ | ✅[^12] |
| Async callback | ❌ | ✅ (`getData()`)[^13] |
| Server-side data engine | ❌ | ✅ (`AgDataEngine`)[^14] |
| Shared engine (cross-instance) | ❌ | ✅ (`createDataEngine()`)[^15] |
| On-demand reload | ❌ | ✅ (`api.reload()`)[^3] |

### Field Types

Both products support `string`, `number`, `boolean`, `date`, `datetime`, `percent`, and `currency` field types. AG Studio additionally supports custom `valueFormatter` and `serializer` functions per field, and an `aiDescription` field to improve AI query quality[^16].

MUI X Studio supports a **field capability override** system that lets you mark a field as `categorical`, `numeric`, or `temporal` regardless of its raw type — enabling fields like a numeric product ID to behave as a category in chart dimensions.

### Relationships

Both products support multi-table joins via a declarative relationship model:

```ts
// MUI X Studio
{ id, sourceId, sourceField, targetId, targetField, type: 'many-to-one' }

// AG Studio
{ id, source: { tableId, fieldId }, target: { tableId, fieldId }, type: 'many-to-one' }
```

MUI X Studio resolves relationships automatically for cross-source cross-filters and KPI sparkline time fields. AG Studio's shared data engine can join across sources, but the relationship model is not publicly documented[^17].

---

## Filter System

### Filter Scopes

Both products support page, widget, cross-filter, and interactive (on-canvas widget) filter scopes[^9][^5].

### Condition Operators

MUI X Studio supports 15+ condition operators including `contains`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty`, and `between`. AG Studio's public filter documentation describes `equals`, `not equals`, and `contains` for condition filters[^9].

### Advanced Features (MUI X Studio only)

| Feature | Description |
| :--- | :--- |
| **Relative date values** | Filter values like "5 days ago" or "next 2 weeks" — `past`/`next` + time unit |
| **Metric reference** | Filter threshold driven by a live aggregate from a metrics data source (`StudioMetricRef`) |
| **Rank / Top-N mode** | `filterMode: 'rank'` — Top-N or Bottom-N rows by a configurable scoring field |
| **Selection mode** | `filterMode: 'selection'` — multi-value checkbox filter |
| **Cross-source filters** | Filter by a field on a related source (`filterSourceId`); join resolved automatically |
| **Compound conditions** | Two operators on the same field with `and`/`or` conjunction |
| **Filters visible in edit mode** | Filters drawer shown in both edit and view modes |

AG Studio's filter documentation describes Page filters, Widget filters, Cross-filters, Interactive filters, and Rank filters[^9]. The Rank filter is available in both products. The other advanced features above are not described in AG Studio's public documentation.

---

## Expression System

Both products implement an expression system for calculated columns (per-row values) and measures (aggregate values). The APIs are structurally identical: an `expressionFields` array, a `isMeasure` flag, and a tree of expression nodes.

### Operators

Both products implement arithmetic (`add`, `subtract`, `multiply`, `divide`, `modulo`), comparison (`equals`, `notEqual`, `lessThan`, `greaterThan`, `lessThanOrEqual`, `greaterThanOrEqual`), boolean (`and`, `or`, `not`), conditional (`if`), set membership (`in`), null checks (`isNull`, `isNotNull`, `isTrue`, `isFalse`), and date difference (`datediff` with 10+ time units)[^18].

MUI X Studio additionally implements string operators (`concat`, `lower`, `upper`, `trim`, `length`), math operators (`abs`, `round`, `floor`, `ceil`), null coalescence (`coalesce`), date component extraction (`year`, `month`, `day`), and **join field expressions** that reference a field on a related source directly inside an expression without materialising a join.

### Visual Editor

MUI X Studio ships a `StudioExpressionFieldDialog` — a visual tree editor for building expression fields with an operator picker, field selector, live AST preview, and inline validation. AG Studio documents `expressionFields` as a state configuration key but does not describe a visual authoring UI in its public documentation[^18].

---

## Layout Engine

| Feature | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Layout model | Equal-width rows | 12-column grid[^4] |
| Widget resize | ❌ | ✅ (drag handle, snaps to grid)[^4] |
| Drag-and-drop reorder | ✅ | ✅[^4] |
| Page min/max width | ❌ | ✅ (720px default min, configurable max)[^4] |
| Fixed-height (poster) mode | ❌ | ✅[^4] |
| Mobile / responsive | ❌ | ❌ (both products require 720px+) |

AG Studio's 12-column grid allows non-uniform column widths (a 4+8 split, a 3+3+6 layout, and so on), while MUI X Studio's row model divides available width equally among all widgets in a row. AG Studio also supports resizing individual widgets by dragging their edges.

---

## AI Assistant

Both products use a bring-your-own LLM pattern — you supply an adapter connecting to OpenAI, Anthropic, or any compatible endpoint.

| Feature | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Floating chat panel | ✅ | ✅[^6] |
| BYO LLM adapter | ✅ (`aiConfig.endpoint`) | ✅ (`executeTurn` callback)[^6] |
| Dashboard-from-prompt | ✅ | ✅[^6] |
| AI tool calls | ✅ (6 tools) | ✅[^6] |
| Multi-agent orchestration | ❌ | ✅ (5 specialised agents)[^6] |
| Structured planning before execution | ❌ | ✅[^6] |
| Data querying (ask questions) | ❌ | ✅[^6] |
| Requires separate AI licence | ❌ | ✅ ("Pro with AI")[^2] |

MUI X Studio's AI tools: `get_dashboard_state`, `add_page`, `set_dashboard_title`, `add_widget`, `update_widget`, `remove_widget`.

AG Studio's agent profiles: Lead (routing), Planning (creates execution plan), Data (queries sources), Page (layout and page filters), Widget (data mappings and formatting)[^6].

---

## State Management & Persistence

| Feature | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Serialisable JSON state | ✅ | ✅[^19] |
| `initialState` prop | ✅ | ✅[^19] |
| State change callback | ✅ (`onStateChange`) | ✅ (`onStateUpdated`)[^19] |
| Imperative `getState` / `setState` | ✅ | ✅[^19] |
| Schema version + migration | ✅ | ❌[^20] |
| File download / upload helpers | ✅ | ❌[^20] |
| 100-step undo / redo | ✅ | ❌[^21] |
| Lifecycle events | ❌ | ✅ (`onApiReady`, `onErrorRaised`)[^19] |

MUI X Studio includes a `schemaVersion` field and a sequential migration pipeline so states saved from an older version can be automatically upgraded. AG Studio's public state documentation does not describe versioning or migration[^20].

The `downloadState()` and `uploadState()` helpers in MUI X Studio wrap save/load with browser file-download and file-picker APIs. AG Studio exposes `getState()`/`setState()` and leaves file I/O to the host app[^19].

---

## Theming & Customisation

| Feature | MUI X Studio | AG Studio |
| :--- | :--- | :--- |
| Theme system | MUI (`createTheme`) | AG Grid (`studioTheme.withParams`)[^22] |
| Dark mode | ✅ (MUI `palette.mode: 'dark'`) | ✅[^22] |
| Per-page background colour | ✅ | ❌[^23] |
| Per-page card colour, padding, radius, border | ✅ | ❌[^23] |
| Slot props (deep sub-component customisation) | ✅ | ❌[^24] |
| Custom sidebar layout | ✅ (stacked / tabbed) | ✅ (left/right panel config)[^3] |
| Headless composition | ✅ | ❌[^24] |
| Custom widget API | ❌ | ✅[^10] |
| Localisation / i18n | ❌ | ✅ (`localeText`)[^25] |
| RTL support | ❌ | ✅ (`enableRtl`)[^25] |

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

AG Studio exposes a single `<AgStudio>` component. Individual panel components are not available for custom placement. Panel visibility and side can be configured via the `panels` prop[^3].

---

## Sources

[^1]: [AG Studio — Quick start](https://www.ag-grid.com/studio/react/quick-start/)
[^2]: [AG Studio — Licence & Pricing](https://www.ag-grid.com/studio/license-pricing/)
[^3]: [AG Studio — Studio Properties](https://www.ag-grid.com/studio/react/studio-properties/)
[^4]: [AG Studio — Modes & Layout](https://www.ag-grid.com/studio/react/modes-layout/)
[^5]: packages/x-studio/src/models/studio.ts — `StudioFilterOperator`, `StudioFilterState`, `RelativeDateValue`, `StudioMetricRef`
[^6]: [AG Studio — AI Assistant](https://www.ag-grid.com/studio/react/ai/) and [AG Studio — AI Agentic Experience](https://www.ag-grid.com/studio/react/ai-ax/)
[^7]: [AG Studio — Widgets](https://www.ag-grid.com/studio/react/widgets/)
[^8]: AG Studio public documentation (May 2026) enumerates Table, Chart, KPI, Static Content, and Filter widget types; no Text widget described
[^9]: [AG Studio — Filters](https://www.ag-grid.com/studio/react/filters/)
[^10]: [AG Studio — Custom Widgets](https://www.ag-grid.com/studio/react/custom-widgets/)
[^11]: packages/x-studio/src/StudioKpiWidget/StudioKpiWidget.tsx; AG Studio KPI features not described in public documentation as of May 2026
[^12]: [AG Studio — Sync data](https://www.ag-grid.com/studio/react/data-sync/)
[^13]: [AG Studio — Async data sources](https://www.ag-grid.com/studio/react/data-async/)
[^14]: [AG Studio — Server-side data](https://www.ag-grid.com/studio/react/server-side-data/)
[^15]: [AG Studio — Data engine](https://www.ag-grid.com/studio/react/data-engine/)
[^16]: [AG Studio — Data types](https://www.ag-grid.com/studio/react/data-types/)
[^17]: [AG Studio — Relationships](https://www.ag-grid.com/studio/react/data-relationships/)
[^18]: [AG Studio — Expressions](https://www.ag-grid.com/studio/react/expressions/)
[^19]: [AG Studio — State](https://www.ag-grid.com/studio/react/state/), [AG Studio — Studio API](https://www.ag-grid.com/studio/react/studio-api/), [AG Studio — Studio Events](https://www.ag-grid.com/studio/react/studio-events/)
[^20]: packages/x-studio/src/store/statePersistence.ts — `CURRENT_SCHEMA_VERSION`, `migrateState()`, `downloadState()`, `uploadState()`; not found in AG Studio public documentation
[^21]: packages/x-studio/src/store/StudioController.ts — `MAX_HISTORY = 100`; not found in AG Studio public documentation
[^22]: [AG Studio — Theming](https://www.ag-grid.com/studio/react/theming/)
[^23]: packages/x-studio/src/models/studio.ts — `StudioPageTheme`; not found in AG Studio public documentation
[^24]: packages/x-studio/src/Studio/Studio.tsx — `StudioSlots`, `StudioProps.slotProps`, composition exports; AG Studio: not documented
[^25]: [AG Studio — Localisation](https://www.ag-grid.com/studio/react/localisation/)

## See also

- [Overview](/x/react-studio/) — what x-studio is and what it's designed for
- [Quickstart](/x/react-studio/quickstart/) — get a working studio running in minutes
- [Slot props](/x/react-studio/customization/slot-props/) — deep customisation unique to x-studio
