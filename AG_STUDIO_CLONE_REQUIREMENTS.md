# AG Studio Clone Requirements (MUI X + Material UI)

## 1. Document purpose

This document defines a detailed feature and requirement specification for building an AG Studio-like experience using MUI X (Data Grid, Charts) and Material UI components.

It is organized for product, design, and engineering use, and includes:

- MVP scope and parity roadmap scope.
- Functional and non-functional requirements.
- Acceptance criteria for each major area.
- Architecture and interaction requirements for the mandated splitter-based layout.

## 2. Scope and constraints

### 2.1 In scope

- A browser-based dashboard studio with edit and view modes.
- Widget authoring using table/grid and charts.
- Data modeling support for multiple sources, relationships, measures, and calculated fields.
- State persistence and restore.
- Collapsible drawer UI shell (Data, Compose, Filters) with splitter-based canvas layout for multi-widget arrangements.

### 2.2 Out of scope (for MVP)

- Multi-user real-time collaborative editing.
- Backend implementation details (storage/auth/permissions service internals).
- AI assistant generation flows.
- Full export suite beyond core CSV for tabular widgets.

### 2.3 Hard product constraint

AG Studio's shell uses collapsible drawers for data, compose, and filters panels. This clone MUST follow that drawer-based shell pattern, with splitter-based layout applied specifically to the canvas for arranging multiple widgets (charts/grids) side-by-side or stacked.

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

### 6.2 Core regions

- Top bar: mode switch, save/load, global actions.
- Canvas (center): primary widget composition area with splitter-based layout for multi-widget arrangements.
- Collapsible drawers (per AG Studio pattern):
  - Data drawer: source/field management.
  - Compose drawer: setup/format edit panel for selected widget.
  - Filters drawer: page/widget/cross-filter configuration.
- Drawers are dismissible and can be toggled via top bar or keyboard.

### 6.3 Studio objects

- Dashboard.
- Page.
- Widget.
- Data source.
- Field, measure, calculated field.
- Filter (page/widget/cross-filter).

## 7. Detailed requirements

## 7A. Shell and layout (collapsible drawers + canvas splitter)

### AGS-LAYOUT-001

- Priority: must
- Scope: MVP
- Description: Main shell MUST use collapsible drawers (Data, Compose, Filters) following AG Studio pattern, not splitter panes.
- Implementation notes: Material UI Drawer components; drawers toggled via top bar buttons or keyboard shortcuts.
- Acceptance criteria:
  1. Each drawer (Data, Compose, Filters) can be opened and dismissed independently.
  2. Drawer state persists per session.
  3. Canvas expands to full width when all drawers are closed.

### AGS-LAYOUT-002

- Priority: must
- Scope: MVP
- Description: Canvas MUST support splitter-based layout for arranging multiple widgets (charts/grids) horizontally or vertically.
- Implementation notes: splitter library controls widget pane sizing and positioning within canvas; supports 2+ widget arrangements.
- Acceptance criteria:
  1. User can resize splitter boundaries via drag handles between canvas widgets.
  2. Min/max widget constraints are enforced.
  3. Splitter layout persists and restores per page.

### AGS-LAYOUT-003

- Priority: should
- Scope: MVP
- Description: Canvas splitter layout presets (for example: two-column equal, three-column with focus area).
- Implementation notes: preset selector in canvas toolbar or context menu.
- Acceptance criteria:
  1. At least 2 presets available.
  2. Applying preset reconfigures widget panes without data loss.

### AGS-LAYOUT-004

- Priority: must
- Scope: MVP
- Description: Keyboard-accessible canvas splitter controls.
- Implementation notes: focusable splitter handles; arrow keys adjust split increments; ARIA values reflect pane proportions.
- Acceptance criteria:
  1. Splitter handle receives focus via keyboard.
  2. Arrow keys adjust split by fixed increments.
  3. Screen reader announces current splitter position and pane sizes.

### AGS-LAYOUT-005

- Priority: should
- Scope: Parity+
- Description: Drawer behavior on narrower viewports and mobile.
- Implementation notes: drawers collapse to overlay modals on narrow viewports; canvas remains interactive.
- Acceptance criteria:
  1. Drawers remain accessible via toggle buttons on narrow screens.
  2. Drawer overlay does not block critical canvas controls.

## 7B. Canvas and widget placement

### AGS-CANVAS-001

- Priority: must
- Scope: MVP
- Description: Canvas supports adding widgets from a library.
- Implementation notes: drag from palette or click-to-add.
- Acceptance criteria:
  1. New widget appears with default size and position.
  2. Widget receives focus after insertion.

### AGS-CANVAS-002

- Priority: must
- Scope: MVP
- Description: Widgets can be moved and resized with snap behavior.
- Implementation notes: canvas coordinate system with snap increments.
- Acceptance criteria:
  1. Drag move updates position interactively.
  2. Resize handles enforce minimum dimensions by widget type.
  3. Widget cannot be moved outside canvas bounds.

### AGS-CANVAS-003

- Priority: must
- Scope: MVP
- Description: Focus model for selected widget and contextual edit pane.
- Implementation notes: selectedWidgetId in store; focus ring.
- Acceptance criteria:
  1. Clicking widget selects it.
  2. Selected widget has visible focus state.
  3. Edit pane content updates to selected widget context.

### AGS-CANVAS-004

- Priority: should
- Scope: Parity+
- Description: Optional alignment guides and collision hints.
- Implementation notes: guide overlays during drag/resize.
- Acceptance criteria:
  1. Alignment guides appear during manipulation.
  2. Guides disappear when interaction ends.

## 7C. Widget library and lifecycle

### AGS-WIDGET-001

- Priority: must
- Scope: MVP
- Description: Provide widget gallery with core widget types.
- Implementation notes: Material UI cards/list + category tabs.
- Acceptance criteria:
  1. Widget categories are discoverable.
  2. User can insert a widget in <= 2 interactions.

### AGS-WIDGET-002

- Priority: must
- Scope: MVP
- Description: Widget actions: duplicate, delete, open settings.
- Implementation notes: widget action bar with icon buttons.
- Acceptance criteria:
  1. Duplicate creates equivalent widget config with new ID.
  2. Delete removes widget and updates state.

### AGS-WIDGET-003

- Priority: should
- Scope: Parity+
- Description: Widget action for download/export where supported.
- Implementation notes: CSV export for table; image export for charts.
- Acceptance criteria:
  1. Export action disabled when unsupported.
  2. Export output matches visible widget content.

## 7D. Grid/table widget requirements (MUI X Data Grid)

### AGS-GRID-001

- Priority: must
- Scope: MVP
- Description: Table widget uses MUI X Data Grid with virtualization.
- Implementation notes: DataGridPro or equivalent capability set.
- Acceptance criteria:
  1. Handles large row counts with smooth scroll.
  2. Supports sorting by visible columns.

### AGS-GRID-002

- Priority: must
- Scope: MVP
- Description: Grouping and aggregation.
- Implementation notes: grouping model + aggregation model persisted in widget state.
- Acceptance criteria:
  1. Aggregated values update correctly on filter changes.
  2. Group expand/collapse is responsive.

### AGS-GRID-003

- Priority: should
- Scope: MVP
- Description: Basic table formatting controls.
- Implementation notes: column visibility, number/date formatting, alignment.
- Acceptance criteria:
  1. Formatting updates apply without re-adding widget.
  2. Formatting is saved in widget configuration.

### AGS-GRID-004

- Priority: could
- Scope: Parity+
- Description: Pinned columns and advanced pivot-like views.
- Implementation notes: optional advanced grid feature layer.
- Acceptance criteria:
  1. Pinned columns remain stable during horizontal scroll.

## 7E. Chart widget requirements (MUI X Charts)

### AGS-CHART-001

- Priority: must
- Scope: MVP
- Description: Core chart types: bar, line, pie/donut.
- Implementation notes: MUI X Charts components with unified config model.
- Acceptance criteria:
  1. User maps x/category and y/measure fields.
  2. Chart renders valid result from mapped data.

### AGS-CHART-002

- Priority: should
- Scope: MVP
- Description: Additional chart types: scatter, area.
- Implementation notes: chart type registry.
- Acceptance criteria:
  1. Type switch preserves compatible mappings.
  2. Incompatible mappings surface actionable validation.

### AGS-CHART-003

- Priority: must
- Scope: MVP
- Description: Chart interactivity (tooltip, legend, highlight).
- Implementation notes: configure chart interactions per widget.
- Acceptance criteria:
  1. Tooltip shows mapped field values on hover.
  2. Series toggle/legend interaction works where applicable.

### AGS-CHART-004

- Priority: should
- Scope: Parity+
- Description: Advanced chart family extensions (histogram, treemap, gauge, heatmap).
- Implementation notes: extension layer that can support non-MUI-X-first charting for missing types.
- Acceptance criteria:
  1. Each added chart type follows common config and state schema.

## 7F. Data model and source management

### AGS-DATA-001

- Priority: must
- Scope: MVP
- Description: Support one or more data sources with typed fields.
- Implementation notes: normalized source registry and field metadata.
- Acceptance criteria:
  1. Data panel lists sources and fields.
  2. Widgets can bind to source fields.

### AGS-DATA-002

- Priority: should
- Scope: MVP
- Description: Relationship support across sources.
- Implementation notes: relationship config with validation for join paths.
- Acceptance criteria:
  1. Related fields can be used together when relationship exists.
  2. Invalid combinations produce clear error.

### AGS-DATA-003

- Priority: should
- Scope: MVP
- Description: Calculated fields and measures.
- Implementation notes: expression parser/evaluator for row-level and aggregate-level logic.
- Acceptance criteria:
  1. Expression validation catches syntax and type errors.
  2. Computed values update on source/filter changes.

### AGS-DATA-004

- Priority: could
- Scope: Parity+
- Description: Async source loading and shared data engine abstraction.
- Implementation notes: cache layer and refresh lifecycle hooks.
- Acceptance criteria:
  1. Widgets display loading and error states.
  2. Repeated source requests are deduplicated.

## 7G. Filtering and cross-filtering

### AGS-FILTER-001

- Priority: must
- Scope: MVP
- Description: Page-level filters and widget-level filters.
- Implementation notes: filter store with scope tagging and field/operator/value model.
- Acceptance criteria:
  1. Page filters affect all linked widgets.
  2. Widget filters only affect that widget.

### AGS-FILTER-002

- Priority: must
- Scope: MVP
- Description: Cross-filter interactions from chart/grid selections.
- Implementation notes: interaction events emit filter intents with source widget ID.
- Acceptance criteria:
  1. Selecting visual element updates target widgets according to mode.
  2. Clear action removes active cross-filter.

### AGS-FILTER-003

- Priority: should
- Scope: MVP
- Description: Filter panel visibility of active filters and provenance.
- Implementation notes: list active filters with source and scope.
- Acceptance criteria:
  1. User can inspect and remove any active filter.

## 7H. Edit panel and authoring controls

### AGS-EDIT-001

- Priority: must
- Scope: MVP
- Description: Contextual edit panel sections: Setup and Format.
- Implementation notes: dynamic panel content keyed by selected widget type.
- Acceptance criteria:
  1. Setup section controls data mapping.
  2. Format section controls visual style.

### AGS-EDIT-002

- Priority: should
- Scope: MVP
- Description: Validation UX in setup forms.
- Implementation notes: immediate inline validation and submit guards.
- Acceptance criteria:
  1. Invalid config states are clearly explained.
  2. User is guided to fix errors.

### AGS-EDIT-003

- Priority: could
- Scope: Parity+
- Description: Field capability hints and presets.
- Implementation notes: contextual suggestions based on field type.
- Acceptance criteria:
  1. Suggested mappings reduce invalid config attempts.

## 7I. State, persistence, and APIs

### AGS-STATE-001

- Priority: must
- Scope: MVP
- Description: Full studio state is serializable and restorable.
- Implementation notes: getState/setState API on Studio instance/controller.
- Acceptance criteria:
  1. getState returns pages, layout, widgets, mappings, filters, settings.
  2. setState restores equivalent visual and interaction state.

### AGS-STATE-002

- Priority: must
- Scope: MVP
- Description: Stable schema with versioned migrations.
- Implementation notes: schemaVersion + migration pipeline.
- Acceptance criteria:
  1. Older state can be migrated to current schema.
  2. Migration failures produce diagnostics.

### AGS-STATE-003

- Priority: should
- Scope: Parity+
- Description: Autosave hooks and dirty-state tracking.
- Implementation notes: onStateChange callback with throttling.
- Acceptance criteria:
  1. Dirty indicator updates accurately.
  2. Autosave does not degrade interaction performance.

## 7J. Accessibility and keyboard support

### AGS-A11Y-001

- Priority: must
- Scope: MVP
- Description: Keyboard navigation across panes, widgets, and controls.
- Implementation notes: roving tabindex where needed; clear focus order.
- Acceptance criteria:
  1. Full authoring flow possible via keyboard for core tasks.

### AGS-A11Y-002

- Priority: should
- Scope: MVP
- Description: ARIA labels and announcements for mode, selection, and layout changes.
- Implementation notes: polite live region for structural updates.
- Acceptance criteria:
  1. Screen readers announce key state transitions.

### AGS-A11Y-003

- Priority: should
- Scope: Parity+
- Description: High contrast and reduced motion support.
- Implementation notes: theme tokens and reduced-motion animation fallbacks.
- Acceptance criteria:
  1. Motion-heavy interactions degrade gracefully when reduced motion is enabled.

## 7K. Performance and reliability

### AGS-PERF-001

- Priority: must
- Scope: MVP
- Description: Interaction responsiveness targets.
- Acceptance criteria:
  1. Widget drag/resize interaction remains smooth (target near 60 fps on modern hardware).
  2. Pane resize interaction feels immediate with no visible stutter.

### AGS-PERF-002

- Priority: must
- Scope: MVP
- Description: Data scalability baseline.
- Acceptance criteria:
  1. Large datasets remain usable via virtualization/aggregation.
  2. Filter application latency is acceptable for target data size.

### AGS-PERF-003

- Priority: should
- Scope: Parity+
- Description: Background computation and incremental updates.
- Implementation notes: memoization, worker offload candidates for heavy transforms.
- Acceptance criteria:
  1. Expensive transformations do not block UI thread during active interactions.

## 7L. Collaboration, sharing, export

### AGS-COLLAB-001

- Priority: could
- Scope: Parity+
- Description: Shareable state payloads/links.
- Acceptance criteria:
  1. A saved state can be opened and reproduces the same dashboard layout/content.

### AGS-EXPORT-001

- Priority: should
- Scope: MVP
- Description: CSV export for table widgets.
- Acceptance criteria:
  1. Exported data reflects current filters and visible dataset definition.

### AGS-EXPORT-002

- Priority: could
- Scope: Parity+
- Description: Image/PDF exports.
- Acceptance criteria:
  1. Export output quality is sufficient for stakeholder reporting.

## 8. MUI X and Material UI mapping

## 8.1 MUI X primary usage

- Data Grid: table widget rendering, sorting, grouping, aggregation surfaces.
- Charts: bar/line/pie/scatter/area where available.

## 8.2 Material UI primary usage

- App shell: top bar, menus, dialogs, tabs, drawers.
- Panels/forms: setup and format controls, filters, validation messages.
- Feedback: snackbar/toast, alerts, progress indicators.

## 8.3 Splitter and DnD stack

- Splitter: dedicated library for canvas widget pane layout (controlled model, resize handles).
- DnD: dnd-kit (or equivalent) for optional canvas widget drag interactions and drawer toggle accessibility.

## 9. MVP definition

MVP includes:

- Splitter shell with persistent sizes and keyboard-accessible handles.
- DnD pane rearrangement.
- Canvas widget add/move/resize with focused selection.
- Core widgets: table, bar, line, pie/donut.
- Data sources + field mapping + basic relationships.
- Page/widget filters + cross-filtering baseline.
- Setup/Format edit panel.
- getState/setState with schema versioning.
- Baseline accessibility and performance guardrails.

MVP excludes:

- AI assistant.
- Real-time collaboration.
- Advanced export formats beyond CSV.
- Long-tail advanced chart families.

## 10. Parity+ roadmap

### Phase P1: Hardening and authoring quality

- Better validation and setup hints.
- More chart types and richer formatting.
- Improved filter UX and diagnostics.

### Phase P2: Advanced analytics and integrations

- Async data engine and refresh lifecycle.
- Additional chart families and advanced table features.
- Shareable links and richer export.

### Phase P3: Enterprise extensions

- Collaboration primitives.
- Permission overlays and role-based views.
- Plugin-style custom widget extension points.

## 11. Risks, assumptions, and open decisions

### 11.1 Key risks

1. Feature parity pressure can conflict with MUI X chart type availability.
2. Splitter + pane DnD complexity can introduce UX instability if not tightly scoped.
3. Expression engine quality affects trust in calculated fields/measures.

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

## 12. Delivery and verification checklist

### 12.1 Delivery checkpoints

1. Product/design sign-off on splitter+Dnd UX flows.
2. Technical design sign-off on state schema and migration plan.
3. MVP feature set freeze with acceptance criteria traceability.

### 12.2 Verification matrix

- Every must requirement has implementation owner and test case.
- Keyboard and screen reader flows validated for core interactions.
- Load/performance smoke tests pass with representative data.
- State roundtrip tests validate getState/setState fidelity.

## 13. Requirement traceability index

- Layout: AGS-LAYOUT-001..005
- Canvas: AGS-CANVAS-001..004
- Widget lifecycle: AGS-WIDGET-001..003
- Grid: AGS-GRID-001..004
- Charts: AGS-CHART-001..004
- Data: AGS-DATA-001..004
- Filters: AGS-FILTER-001..003
- Edit panel: AGS-EDIT-001..003
- State/API: AGS-STATE-001..003
- Accessibility: AGS-A11Y-001..003
- Performance: AGS-PERF-001..003
- Collaboration/export: AGS-COLLAB-001, AGS-EXPORT-001..002

## 14. Immediate implementation recommendation

Start with a vertical slice that includes:

1. Collapsible drawer shell (Data, Compose, Filters) + drawer state persistence.
2. Canvas splitter layout with two-widget baseline.
3. One table widget and one chart widget.
4. Setup panel mapping (in Compose drawer).
5. Basic page filter and state save/restore.

This sequence validates the hardest architecture assumptions early (shell layout, canvas widget arrangement, state, and interaction coordination) before broader widget expansion.
