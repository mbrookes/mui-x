# AG Studio Clone Requirements (MUI X + Material UI)

## 1. Document purpose

This document defines a detailed feature and requirement specification for building an AG Studio-like experience using MUI X (Data Grid, Charts) and Material UI components.

It is organized for product, design, and engineering use, and includes:

- MVP scope and parity roadmap scope.
- Functional and non-functional requirements.
- Acceptance criteria for each major area.
- Architecture and interaction requirements for the clone's chosen shell and dashboard layout model.

## 2. Scope and constraints

### 2.1 In scope

- A browser-based dashboard studio with edit and view modes.
- Widget authoring using table/grid, chart, and KPI widgets.
- Data modeling support for multiple sources, relationships, measures, and calculated fields.
- State persistence and restore.
- Configurable shell with data, compose, and filters surfaces plus theming controls.
- Layout authoring with drag-and-drop, resize, reorder, and reflow behaviors.
- Framework-ready embedding strategy for React, Angular, Vue 3, and vanilla JavaScript hosts.

### 2.2 Out of scope (for MVP)

- Multi-user real-time collaborative editing.
- Backend implementation details (storage/auth/permissions service internals).
- AI assistant and natural-language authoring flows.
- Production-ready code generation/export for framework-specific host apps.
- Full export suite beyond core CSV for tabular widgets.

#### 2.2.1 Out if Scope AG Studio Bugs 😝

- Adding a selection filter to a KPI (at least) of cross-field data (at least Order Data/Time) returns zero
- Products table, rank filter shows booleans etc., not rank fields

### 2.3 Clone-specific product constraint

Public AG Studio materials clearly show Data, Compose, and Filters controls, edit/view modes, drag-and-drop widget layout, and configurable layout options. They do not publicly establish a mandatory drawer-only shell or a splitter-only canvas model. For this clone, we deliberately choose a collapsible drawer shell and a structured canvas layout model, but those choices are implementation decisions rather than verified AG Studio product constraints.

## 3. Requirement notation

Each requirement includes:

- ID: stable identifier for implementation tracking.
- Priority: must, should, could.
- Scope tier: MVP or Parity+.
- Description.
- Implementation notes (MUI X / Material UI direction).
- Acceptance criteria.

## 4. Source review summary

The requirements below are informed by public AG Studio product/docs/demo/API behavior patterns and mapped to MUI X + Material UI implementation strategy.

Publicly confirmed from https://www.ag-grid.com/studio/ as of 18 April 2026:

- AG Studio is positioned as an embedded analytics toolkit/component for modern web applications.
- It supports React, Angular, Vue 3, and vanilla JavaScript.
- It combines dashboards, charts, grids, filters, and KPI tiles/widgets.
- It supports edit and view modes.
- It supports drag-and-drop widget rearrangement plus resize, reorder, and reflow behaviors.
- It exposes theming as a first-class capability.
- It is built on top of AG Grid and AG Charts.
- Public FAQ copy claims support for computed columns/expressions, joins/aggregations, cross-filters, and large data volumes.
- Public FAQ copy states AG Studio includes an AI Agent Playground / AI assistant for natural-language dashboard interactions.
- Public FAQ copy states it generates production-ready code for supported frameworks.

Not publicly verified from the landing page alone:

- Exact shell mechanics such as drawer vs docked panel vs inspector implementation.
- Exact layout engine implementation such as freeform canvas, grid packing, splitter panes, or hybrids.
- Specific API method names such as getState/setState.
- Precise acceptance thresholds beyond high-level performance claims.

## 5. Product goals and principles

- Goal G1: Fast dashboard authoring with low-friction setup.
- Goal G2: Clear separation of edit and view experiences.
- Goal G3: Strong data exploration via grid + chart interactions.
- Goal G4: Predictable and recoverable state model.
- Goal G5: High usability with keyboard and accessibility support.

Principles:

1. Direct manipulation first (drag, resize, reorder).
2. Always visible state (focused widget, active filters, mode).
3. Consistent panel logic (contextual, not fragmented).
4. Performance by default (virtualization, throttled updates).
5. Extensible architecture (future widgets, data backends).

## 6. Experience model

### 6.1 Modes

- Edit mode: create/configure/rearrange widgets and dashboard settings.
- View mode: read-only composition with interactive filters and cross-filtering.
- AG Studio docs: [Modes and Layout](https://www.ag-grid.com/studio/react/modes-layout/)

### 6.2 Core regions

- Top bar: mode switch, save/load, global actions.
- Canvas (center): primary widget composition area with configurable layout behavior.
- Collapsible drawers or docked side panels (clone choice uses drawers):
  - Data drawer: source/field management.
  - Compose drawer: setup/format edit panel for selected widget.
  - Filters drawer: page/widget/cross-filter configuration.
- Optional theming surface for dashboard and widget styling.
- Side surfaces are dismissible and can be toggled via top bar or keyboard.
- AG Studio docs: [Panels](https://www.ag-grid.com/studio/react/modes-layout/#panels) · [Configuring Panels](https://www.ag-grid.com/studio/react/modes-layout/#configuring-panels)

### 6.3 Studio objects

- Dashboard.
- Page.
- Widget.
- Data source.
- Field, measure, calculated field.
- Filter (page/widget/cross-filter).
- AG Studio docs: [Studio Interface Overview](https://www.ag-grid.com/studio/react/studio-interface/) · [Data](https://www.ag-grid.com/studio/react/data/) · [Modes and Layout](https://www.ag-grid.com/studio/react/modes-layout/)

## 7. Detailed requirements

## 7A. Shell and layout (collapsible drawers + configurable canvas layout)

### XS-LAYOUT-001

- Priority: must
- Scope: MVP
- Description: Main shell MUST expose dedicated Data, Compose, and Filters authoring surfaces. For this clone, these surfaces use collapsible drawers.
- Implementation notes: Material UI Drawer components; drawers toggled via top bar buttons or keyboard shortcuts.
- AG Studio docs: [Panels](https://www.ag-grid.com/studio/react/modes-layout/#panels) · [Configuring Panels](https://www.ag-grid.com/studio/react/modes-layout/#configuring-panels) · [Properties Reference (`panels`)](https://www.ag-grid.com/studio/react/studio-properties/#reference-layout)
- Acceptance criteria:
  1. Each drawer (Data, Compose, Filters) can be opened and dismissed independently.
  2. Drawer state persists per session.
  3. Canvas expands to full width when all drawers are closed.

### XS-LAYOUT-002

- Priority: must
- Scope: MVP
- Description: Canvas MUST support configurable multi-widget layout with drag, resize, reorder, and reflow behaviors. The clone may use a structured layout engine internally, but the user experience must remain dashboard-like rather than pane-manager-like.
- Implementation notes: layout engine may combine grid packing and controlled resize handles; preserve predictable widget movement and responsive reflow.
- AG Studio docs: [Layout Properties](https://www.ag-grid.com/studio/react/modes-layout/#layout-properties) · [Page Dimensions](https://www.ag-grid.com/studio/react/modes-layout/#page-dimensions) · [Properties Reference (`layout`)](https://www.ag-grid.com/studio/react/studio-properties/#reference-layout)
- Acceptance criteria:
  1. User can drag widgets to new positions and see live placement feedback.
  2. User can resize widgets with enforced minimum dimensions by widget type.
  3. Layout reorders/reflows cleanly when widgets are added, moved, resized, or viewport size changes.
  4. Layout persists and restores per page.

### XS-LAYOUT-003

- Priority: should
- Scope: MVP
- Description: Canvas layout presets and configurable layout options.
- Implementation notes: preset selector in canvas toolbar or context menu.
- AG Studio docs: [Layout Properties](https://www.ag-grid.com/studio/react/modes-layout/#layout-properties) · [Customising Panel Content (`overrides`)](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. At least 2 presets available.
  2. Applying preset reconfigures widget panes without data loss.

### XS-LAYOUT-004

- Priority: must
- Scope: MVP
- Description: Keyboard-accessible canvas layout controls.
- Implementation notes: focusable widget move/resize handles or equivalent controls; arrow keys adjust position/size increments; ARIA values reflect layout state where applicable.
- AG Studio docs: [Modes and Layout](https://www.ag-grid.com/studio/react/modes-layout/)
- Acceptance criteria:
  1. Keyboard user can move focus to layout controls without a pointer.
  2. Arrow keys or equivalent commands adjust layout by fixed increments.
  3. Screen reader announcements expose the current widget position/size or equivalent structural state.

### XS-LAYOUT-005

- Priority: should
- Scope: Parity+
- Description: Drawer behavior on narrower viewports and mobile.
- Implementation notes: drawers collapse to overlay modals on narrow viewports; canvas remains interactive.
- AG Studio docs: [Configuring Panels](https://www.ag-grid.com/studio/react/modes-layout/#configuring-panels)
- Acceptance criteria:
  1. Drawers remain accessible via toggle buttons on narrow screens.
  2. Drawer overlay does not block critical canvas controls.

## 7B. Canvas and widget placement

### XS-CANVAS-001

- Priority: must
- Scope: MVP
- Description: Canvas supports adding widgets from a library.
- Implementation notes: drag from palette or click-to-add.
- AG Studio docs: [Modes and Layout](https://www.ag-grid.com/studio/react/modes-layout/) · [Customising Panel Content (`overrides.widgetTypes`)](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. New widget appears with default size and position.
  2. Widget receives focus after insertion.

### XS-CANVAS-002

- Priority: must
- Scope: MVP
- Description: Widgets can be moved and resized with snap behavior.
- Implementation notes: drag-and-drop layout engine with snap increments and responsive reflow.
- AG Studio docs: [Layout Properties](https://www.ag-grid.com/studio/react/modes-layout/#layout-properties) · [Page Dimensions](https://www.ag-grid.com/studio/react/modes-layout/#page-dimensions)
- Acceptance criteria:
  1. Drag move updates position interactively.
  2. Resize handles enforce minimum dimensions by widget type.
  3. Widget cannot be moved outside canvas bounds.
  4. Sibling widgets reflow predictably after move/resize operations.

### XS-CANVAS-003

- Priority: must
- Scope: MVP
- Description: Focus model for selected widget and contextual edit pane.
- Implementation notes: selectedWidgetId in store; focus ring.
- AG Studio docs: [Edit Panel](https://www.ag-grid.com/studio/react/modes-layout/#panels) · [Customising Panel Content](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. Clicking widget selects it.
  2. Selected widget has visible focus state.
  3. Edit pane content updates to selected widget context.

### XS-CANVAS-004

- Priority: should
- Scope: Parity+
- Description: Optional alignment guides and collision hints.
- Implementation notes: guide overlays during drag/resize.
- AG Studio docs: [Layout Properties](https://www.ag-grid.com/studio/react/modes-layout/#layout-properties)
- Acceptance criteria:
  1. Alignment guides appear during manipulation.
  2. Guides disappear when interaction ends.

## 7C. Widget library and lifecycle

### XS-WIDGET-001

- Priority: must
- Scope: MVP
- Description: Provide widget gallery with core widget types.
- Implementation notes: Material UI cards/list + category tabs.
- AG Studio docs: [Customising Panel Content (`overrides.widgetTypes`)](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. Widget categories are discoverable.
  2. User can insert a widget in <= 2 interactions.
  3. Gallery includes tables/grids, charts, and KPI widgets.

### XS-WIDGET-004

- Priority: should
- Scope: MVP
- Description: KPI widget support for headline metrics.
- Implementation notes: simple metric card widget with label, value, optional delta, formatting, and conditional styling.
- AG Studio docs: [Customising Panel Content](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content) · [State](https://www.ag-grid.com/studio/react/state/)
- Acceptance criteria:
  1. User can bind a KPI widget to a measure or computed metric.
  2. KPI value formatting can be configured without rebuilding the widget.
  3. KPI widgets participate in page filters and cross-filters where applicable.

### XS-WIDGET-002

- Priority: must
- Scope: MVP
- Description: Widget actions: duplicate, delete, open settings.
- Implementation notes: widget action bar with icon buttons.
- AG Studio docs: [Customising Panel Content (`overrides.widgets`)](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. Duplicate creates equivalent widget config with new ID.
  2. Delete removes widget and updates state.

### XS-WIDGET-003

- Priority: should
- Scope: Parity+
- Description: Widget action for download/export where supported.
- Implementation notes: CSV export for table; image export for charts.
- AG Studio docs: [Customising Panel Content (`overrides.widgets`)](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. Export action disabled when unsupported.
  2. Export output matches visible widget content.

## 7D. Grid/table widget requirements (MUI X Data Grid)

### XS-GRID-001

- Priority: must
- Scope: MVP
- Description: Table widget uses MUI X Data Grid with virtualization.
- Implementation notes: DataGridPro or equivalent capability set.
- AG Studio docs: [Customising Panel Content (`overrides.widgets`)](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content) · [State (`widgets[].type: 'grid'`)](https://www.ag-grid.com/studio/react/state/)
- Acceptance criteria:
  1. Handles large row counts with smooth scroll.
  2. Supports sorting by visible columns.

### XS-GRID-002

- Priority: must
- Scope: MVP
- Description: Grouping and aggregation.
- Implementation notes: grouping model + aggregation model persisted in widget state.
- AG Studio docs: [State (widget `dataMapping`)](https://www.ag-grid.com/studio/react/state/) · [Data](https://www.ag-grid.com/studio/react/data/)
- Acceptance criteria:
  1. Aggregated values update correctly on filter changes.
  2. Group expand/collapse is responsive.

### XS-GRID-003

- Priority: should
- Scope: MVP
- Description: Basic table formatting controls.
- Implementation notes: column visibility, number/date formatting, alignment.
- AG Studio docs: [Synchronous Data Sources (field definitions)](https://www.ag-grid.com/studio/react/data-sync/#fields) · [State](https://www.ag-grid.com/studio/react/state/)
- Acceptance criteria:
  1. Formatting updates apply without re-adding widget.
  2. Formatting is saved in widget configuration.

### XS-GRID-004

- Priority: could
- Scope: Parity+
- Description: Pinned columns and advanced pivot-like views.
- Implementation notes: optional advanced grid feature layer.
- AG Studio docs: [Customising Panel Content (`overrides.widgets`)](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. Pinned columns remain stable during horizontal scroll.

## 7E. Chart widget requirements (MUI X Charts)

### XS-CHART-001

- Priority: must
- Scope: MVP
- Description: Core chart types: bar, line, pie/donut.
- Implementation notes: MUI X Charts components with unified config model.
- AG Studio docs: [State (`widgets[].type: 'chart'`)](https://www.ag-grid.com/studio/react/state/) · [Data](https://www.ag-grid.com/studio/react/data/)
- Acceptance criteria:
  1. User maps x/category and y/measure fields.
  2. Chart renders valid result from mapped data.

### XS-CHART-002

- Priority: should
- Scope: MVP
- Description: Additional chart types: scatter, area, grouped bar/column, and stacked bar/column.
- Implementation notes: chart type registry.
- AG Studio docs: [Customising Panel Content (`overrides.widgets`)](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content) · [State](https://www.ag-grid.com/studio/react/state/)
- Acceptance criteria:
  1. Type switch preserves compatible mappings.
  2. Incompatible mappings surface actionable validation.

### XS-CHART-003

- Priority: must
- Scope: MVP
- Description: Chart interactivity (tooltip, legend, highlight).
- Implementation notes: configure chart interactions per widget.
- AG Studio docs: [Customising Panel Content](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. Tooltip shows mapped field values on hover.
  2. Series toggle/legend interaction works where applicable.

### XS-CHART-004

- Priority: should
- Scope: Parity+
- Description: Advanced chart family extensions (histogram, treemap, gauge, heatmap).
- Implementation notes: extension layer that can support non-MUI-X-first charting for missing types.
- AG Studio docs: [Customising Panel Content (`overrides.widgetTypes`)](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. Each added chart type follows common config and state schema.

## 7F. Data model and source management

### XS-DATA-001

- Priority: must
- Scope: MVP
- Description: Support one or more data sources with typed fields.
- Implementation notes: normalized source registry and field metadata.
- AG Studio docs: [Data Overview](https://www.ag-grid.com/studio/react/data/) · [Synchronous Data Sources](https://www.ag-grid.com/studio/react/data-sync/) · [Properties Reference (`data`)](https://www.ag-grid.com/studio/react/studio-properties/#reference-data)
- Acceptance criteria:
  1. Data panel lists sources and fields.
  2. Widgets can bind to source fields.

### XS-DATA-002

- Priority: should
- Scope: MVP
- Description: Relationship support across sources.
- Implementation notes: relationship config with validation for join paths.
- AG Studio docs: [Relationships](https://www.ag-grid.com/studio/react/data/#relationships) · [Data Overview](https://www.ag-grid.com/studio/react/data/)
- Acceptance criteria:
  1. Related fields can be used together when relationship exists.
  2. Invalid combinations produce clear error.

### XS-DATA-003

- Priority: should
- Scope: MVP
- Description: Calculated fields and measures.
- Implementation notes: expression parser/evaluator for row-level and aggregate-level logic; support computed columns and expressions aligned with public AG Studio positioning.
- AG Studio docs: [Data Overview (`expressionFields`)](https://www.ag-grid.com/studio/react/data/) · [Synchronous Data Sources (field definitions)](https://www.ag-grid.com/studio/react/data-sync/#fields)
- Acceptance criteria:
  1. Expression validation catches syntax and type errors.
  2. Computed values update on source/filter changes.

### XS-DATA-004

- Priority: could
- Scope: Parity+
- Description: Async source loading and shared data engine abstraction.
- Implementation notes: cache layer and refresh lifecycle hooks.
- AG Studio docs: [Asynchronous Data Sources](https://www.ag-grid.com/studio/react/data-async/) · [Shared Data Engine](https://www.ag-grid.com/studio/react/data-engine/) · [API Reference (`api.reload()`)](https://www.ag-grid.com/studio/react/studio-api/#reference-data)
- Acceptance criteria:
  1. Widgets display loading and error states.
  2. Repeated source requests are deduplicated.

## 7G. Filtering and cross-filtering

### XS-FILTER-001

- Priority: must
- Scope: MVP
- Description: Page-level filters and widget-level filters.
- Implementation notes: filter store with scope tagging and field/operator/value model.
- AG Studio docs: [Panels (Filters Panel)](https://www.ag-grid.com/studio/react/modes-layout/#panels) · [Configuring Panels](https://www.ag-grid.com/studio/react/modes-layout/#configuring-panels)
- Acceptance criteria:
  1. Page filters affect all linked widgets.
  2. Widget filters only affect that widget.

### XS-FILTER-002

- Priority: must
- Scope: MVP
- Description: Cross-filter interactions from chart/grid selections.
- Implementation notes: interaction events emit filter intents with source widget ID.
- AG Studio docs: [Panels (Filters Panel)](https://www.ag-grid.com/studio/react/modes-layout/#panels) · [Events Reference](https://www.ag-grid.com/studio/react/studio-events/)
- Acceptance criteria:
  1. Selecting visual element updates target widgets according to mode.
  2. Clear action removes active cross-filter.

### XS-FILTER-003

- Priority: should
- Scope: MVP
- Description: Filter panel visibility of active filters and provenance.
- Implementation notes: list active filters with source and scope.
- AG Studio docs: [Panels (Filters Panel)](https://www.ag-grid.com/studio/react/modes-layout/#panels)
- Acceptance criteria:
  1. User can inspect and remove any active filter.

## 7H. Edit panel and authoring controls

### XS-EDIT-001

- Priority: must
- Scope: MVP
- Description: Contextual edit panel sections: Setup and Format.
- Implementation notes: dynamic panel content keyed by selected widget type.
- AG Studio docs: [Panels (Edit Panel)](https://www.ag-grid.com/studio/react/modes-layout/#panels) · [Customising Panel Content (`overrides`)](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. Setup section controls data mapping.
  2. Format section controls visual style.

### XS-EDIT-002

- Priority: should
- Scope: MVP
- Description: Validation UX in setup forms.
- Implementation notes: immediate inline validation and submit guards.
- AG Studio docs: [Studio Interface (errors)](https://www.ag-grid.com/studio/react/studio-interface/#studio-errors) · [Events Reference (`onErrorRaised`)](https://www.ag-grid.com/studio/react/studio-events/)
- Acceptance criteria:
  1. Invalid config states are clearly explained.
  2. User is guided to fix errors.

### XS-EDIT-003

- Priority: could
- Scope: Parity+
- Description: Field capability hints and presets.
- Implementation notes: contextual suggestions based on field type.
- AG Studio docs: [Synchronous Data Sources (field definitions)](https://www.ag-grid.com/studio/react/data-sync/#fields) · [Customising Panel Content](https://www.ag-grid.com/studio/react/modes-layout/#customising-panel-content)
- Acceptance criteria:
  1. Suggested mappings reduce invalid config attempts.

### XS-EDIT-004

- Priority: should
- Scope: MVP
- Description: Theming controls for dashboard and widget styling.
- Implementation notes: theme section covers palette, typography, spacing, surface styling, and AG Grid-compatible theme token mapping where possible.
- AG Studio docs: [Theming](https://www.ag-grid.com/studio/react/theming/) · [Theme Reference](https://www.ag-grid.com/studio/react/studio-theme/) · [Properties Reference (`theme`)](https://www.ag-grid.com/studio/react/studio-properties/#reference-theme)
- Acceptance criteria:
  1. User can adjust dashboard-level theme settings without editing source code.
  2. Theme changes propagate consistently across grid, chart, and KPI widgets.
  3. Theme configuration persists as part of saved state.

## 7I. State, persistence, and APIs

### XS-STATE-001

- Priority: must
- Scope: MVP
- Description: Full studio state is serializable and restorable.
- Implementation notes: public controller/state API on Studio instance/controller; exact method names may differ from AG Studio.
- AG Studio docs: [State](https://www.ag-grid.com/studio/react/state/) · [API Reference (`getState` / `setState`)](https://www.ag-grid.com/studio/react/studio-api/#reference-state) · [Properties Reference (`initialState`)](https://www.ag-grid.com/studio/react/studio-properties/#reference-state)
- Acceptance criteria:
  1. getState returns pages, layout, widgets, mappings, filters, settings.
  2. setState restores equivalent visual and interaction state.

### XS-STATE-002

- Priority: must
- Scope: MVP
- Description: Stable schema with versioned migrations.
- Implementation notes: schemaVersion + migration pipeline.
- AG Studio docs: [State](https://www.ag-grid.com/studio/react/state/) · [Studio State Reference (`AgReportState`)](https://www.ag-grid.com/studio/react/studio-state/)
- Acceptance criteria:
  1. Older state can be migrated to current schema.
  2. Migration failures produce diagnostics.

### XS-STATE-003

- Priority: should
- Scope: Parity+
- Description: Autosave hooks and dirty-state tracking.
- Implementation notes: onStateChange callback with throttling.
- AG Studio docs: [Events Reference (`onStateUpdated`)](https://www.ag-grid.com/studio/react/studio-events/#reference-state) · [Studio Lifecycle (`stateUpdated`)](https://www.ag-grid.com/studio/react/studio-lifecycle/#state-updated) · [State](https://www.ag-grid.com/studio/react/state/)
- Acceptance criteria:
  1. Dirty indicator updates accurately.
  2. Autosave does not degrade interaction performance.

### XS-STATE-004

- Priority: should
- Scope: Parity+
- Description: Production-ready export/code generation for supported host frameworks.
- Implementation notes: generate framework-specific configuration/module output for React, Angular, Vue 3, and vanilla JavaScript hosts.
- AG Studio docs: [Quick Start](https://www.ag-grid.com/studio/react/quick-start/) · [Studio Interface](https://www.ag-grid.com/studio/react/studio-interface/)
- Acceptance criteria:
  1. Generated output captures dashboard structure, widget bindings, and theme configuration.
  2. Output is valid for the selected framework target with minimal manual editing.

## 7J. Accessibility and keyboard support

### XS-A11Y-001

- Priority: must
- Scope: MVP
- Description: Keyboard navigation across panes, widgets, and controls.
- Implementation notes: roving tabindex where needed; clear focus order.
- AG Studio docs: [Properties Reference (`enableRtl`)](https://www.ag-grid.com/studio/react/studio-properties/#reference-interactivity)
- Acceptance criteria:
  1. Full authoring flow possible via keyboard for core tasks.

### XS-A11Y-002

- Priority: should
- Scope: MVP
- Description: ARIA labels and announcements for mode, selection, and layout changes.
- Implementation notes: polite live region for structural updates.
- AG Studio docs: [Localisation](https://www.ag-grid.com/studio/react/localisation/)
- Acceptance criteria:
  1. Screen readers announce key state transitions.

### XS-A11Y-003

- Priority: should
- Scope: Parity+
- Description: High contrast and reduced motion support.
- Implementation notes: theme tokens and reduced-motion animation fallbacks.
- AG Studio docs: [Theming](https://www.ag-grid.com/studio/react/theming/) · [Theme Reference](https://www.ag-grid.com/studio/react/studio-theme/)
- Acceptance criteria:
  1. Motion-heavy interactions degrade gracefully when reduced motion is enabled.

## 7K. Performance and reliability

### XS-PERF-001

- Priority: must
- Scope: MVP
- Description: Interaction responsiveness targets.
- Acceptance criteria:
  1. Widget drag/resize interaction remains smooth (target near 60 fps on modern hardware).
  2. Layout resize and reflow interactions feel immediate with no visible stutter.

### XS-PERF-002

- Priority: must
- Scope: MVP
- Description: Data scalability baseline.
- Acceptance criteria:
  1. Large datasets remain usable via virtualization/aggregation.
  2. Filter application latency is acceptable for target data size.

### XS-PERF-004

- Priority: should
- Scope: Parity+
- Description: Public AG Studio scale claims benchmark coverage.
- Implementation notes: benchmark representative scenarios for joins, aggregations, computed columns, and enterprise-scale row models.
- AG Studio docs: [Data Overview](https://www.ag-grid.com/studio/react/data/) · [Asynchronous Data Sources](https://www.ag-grid.com/studio/react/data-async/)
- Acceptance criteria:
  1. Benchmark suite includes hundreds-of-thousands-row scenarios with joins, aggregations, and computed columns.
  2. Stretch benchmark documents behavior approaching 1 million rows on supported row models/hardware.
  3. Published clone guidance clearly distinguishes measured results from AG Studio marketing claims.

### XS-PERF-003

- Priority: should
- Scope: Parity+
- Description: Background computation and incremental updates.
- Implementation notes: memoization, worker offload candidates for heavy transforms.
- AG Studio docs: [Asynchronous Data Sources](https://www.ag-grid.com/studio/react/data-async/) · [Shared Data Engine](https://www.ag-grid.com/studio/react/data-engine/)
- Acceptance criteria:
  1. Expensive transformations do not block UI thread during active interactions.

## 7L. Collaboration, sharing, export

### XS-COLLAB-001

- Priority: could
- Scope: Parity+
- Description: Shareable state payloads/links.
- Acceptance criteria:
  1. A saved state can be opened and reproduces the same dashboard layout/content.

### XS-EXPORT-001

- Priority: should
- Scope: MVP
- Description: CSV export for table widgets.
- Acceptance criteria:
  1. Exported data reflects current filters and visible dataset definition.

### XS-EXPORT-002

- Priority: could
- Scope: Parity+
- Description: Image/PDF exports.
- Acceptance criteria:
  1. Export output quality is sufficient for stakeholder reporting.

### XS-AI-001

- Priority: should
- Scope: Parity+
- Description: Natural-language dashboard assistance aligned with AG Studio public AI positioning.
- Implementation notes: AI playground/assistant capable of creating dashboards, rearranging layouts, adding filters, and answering data questions through conversational prompts.
- AG Studio docs: [AI Assistant](https://www.ag-grid.com/studio/react/ai/) · [Building an Adapter](https://www.ag-grid.com/studio/react/ai-adapter/) · [AI Configuration](https://www.ag-grid.com/studio/react/ai-configuration/)
- Acceptance criteria:
  1. User can issue natural-language prompts that mutate dashboard configuration with preview/confirm controls.
  2. Assistant can explain proposed changes before applying them.
  3. AI actions are auditable and reversible.

## 8. MUI X and Material UI mapping

## 8.1 MUI X primary usage

- Data Grid: table widget rendering, sorting, grouping, aggregation surfaces.
- Charts: bar/line/pie/scatter/area and grouped/stacked variants where available.

## 8.2 Material UI primary usage

- App shell: top bar, menus, dialogs, tabs, drawers.
- Panels/forms: setup and format controls, filters, validation messages.
- Feedback: snackbar/toast, alerts, progress indicators.
- Theming surfaces: palette, tokens, style editors, and preview controls.

## 8.3 Layout and DnD stack

- Layout/DnD: dnd-kit (or equivalent) for canvas widget drag, reorder, and keyboard-accessible layout interactions.
- Optional structured layout layer: dedicated library only if needed for predictable reflow/resizing, but should not constrain the UX into a pane-splitter metaphor.

## 8.4 Host framework packaging

- React: first-class package and examples.
- Angular: wrapper/integration package.
- Vue 3: wrapper/integration package.
- JavaScript: framework-agnostic embedding API.

## 9. MVP definition

MVP includes:

- Drawer-based shell exposing Data, Compose, and Filters surfaces.
- DnD widget rearrangement with resize and reflow.
- Canvas widget add/move/resize with focused selection.
- Core widgets: table, KPI, bar, line, pie/donut.
- Data sources + field mapping + basic relationships.
- Page/widget filters + cross-filtering baseline.
- Setup/Format edit panel plus baseline theming controls.
- getState/setState with schema versioning.
- Baseline accessibility and performance guardrails.

MVP excludes:

- AI assistant.
- Real-time collaboration.
- Advanced export formats beyond CSV.
- Production-ready framework code generation/export.
- Long-tail advanced chart families.

## 10. Parity+ roadmap

### Phase P1: Hardening and authoring quality

- Better validation and setup hints.
- More chart types and richer formatting.
- Improved filter UX and diagnostics.
- Richer theming and brand customization.

### Phase P2: Advanced analytics and integrations

- Async data engine and refresh lifecycle.
- Additional chart families and advanced table features.
- Shareable links and richer export.
- Production-ready code generation for supported frameworks.
- AI-powered dashboard assistance.

### Phase P3: Enterprise extensions

- Collaboration primitives.
- Permission overlays and role-based views.
- Plugin-style custom widget extension points.

## 11. Risks, assumptions, and open decisions

### 11.1 Key risks

1. Feature parity pressure can conflict with MUI X chart type availability.
2. Clone-specific drawer shell and structured layout choices may diverge from AG Studio's exact private implementation.
3. Expression engine quality affects trust in calculated fields/measures.
4. Production-ready code generation across four framework targets is a significant parity investment.
5. AI assistant parity requires separate trust, safety, and auditability design.

### 11.2 Assumptions

1. MUI X components in the target environment are available at required tier/license.
2. Studio state persistence backend is provided by host application.
3. Data source adapters are host-provided, studio consumes normalized contracts.

### 11.3 Open decisions

1. Chart strategy for unsupported parity types:
   - Option A: strict MUI X only.
   - Option B: MUI X first with fallback extension chart adapters.
2. Exact data volume SLOs per environment.
3. Export format commitments for MVP vs Parity+.
4. Whether framework code generation is literal source generation or configuration export plus host wrappers.
5. Whether AI assistance is a hosted service, pluggable provider interface, or omitted permanently from the clone.

## 12. Delivery and verification checklist

### 12.1 Delivery checkpoints

1. Product/design sign-off on drawer shell and dashboard layout UX flows.
2. Technical design sign-off on state schema and migration plan.
3. MVP feature set freeze with acceptance criteria traceability.

### 12.2 Verification matrix

- Every must requirement has implementation owner and test case.
- Keyboard and screen reader flows validated for core interactions.
- Load/performance smoke tests pass with representative data.
- State roundtrip tests validate getState/setState fidelity.
- AG Studio docs: [API Reference](https://www.ag-grid.com/studio/react/studio-api/) · [Events Reference](https://www.ag-grid.com/studio/react/studio-events/) · [Studio Lifecycle](https://www.ag-grid.com/studio/react/studio-lifecycle/)

## 13. Requirement traceability index

- Layout: XS-LAYOUT-001..005
- Canvas: XS-CANVAS-001..004
- Widget lifecycle: XS-WIDGET-001..004
- Grid: XS-GRID-001..004
- Charts: XS-CHART-001..004
- Data: XS-DATA-001..004
- Filters: XS-FILTER-001..003
- Edit panel: XS-EDIT-001..004
- State/API: XS-STATE-001..004
- Accessibility: XS-A11Y-001..003
- Performance: XS-PERF-001..004
- Collaboration/export/AI: XS-COLLAB-001, XS-EXPORT-001..002, XS-AI-001

## 14. Immediate implementation recommendation

Start with a vertical slice that includes:

1. Collapsible drawer shell (Data, Compose, Filters) + drawer state persistence.
2. Drag/reflow canvas layout with two-widget baseline.
3. One table widget, one KPI widget, and one chart widget.
4. Setup panel mapping plus baseline theming controls.
5. Basic page filter and state save/restore.

This sequence validates the hardest architecture assumptions early (shell layout, dashboard layout behavior, widget composition, theming, state, and interaction coordination) before broader widget expansion.
