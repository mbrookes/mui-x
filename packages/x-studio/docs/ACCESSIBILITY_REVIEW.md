# Accessibility Review — `@mui/x-studio`

> **Remediation status (updated):** Most findings below have since been fixed on
> the `x-studio` branch. Each fix is a separate commit and is covered by
> `tsc` + `eslint` + the unit suite. Outstanding items are listed at the end
> under **Remediation status**.

**Scope:** the entire `packages/x-studio` package on the `x-studio` branch
(commit `17ad4609`), 164 rendering components across the app shell, canvas,
compose/data/filters/expression drawers, chat/insight panels, widget cards, and
all widget types.

**Standard:** WCAG 2.2 AA + ARIA Authoring Practices Guide (APG).

**Method:** Source-level (static) review driven by the
`accessibility-review` skill and `accessibility-reviewer` agent installed in
`.claude/`. Five reviewers each audited a slice of the package and cited
`file:line`. This is a static review — it cannot confirm contrast ratios, actual
rendered focus behavior, or screen-reader output; those items are explicitly
marked **needs runtime verification** and should be confirmed with
axe-core / Lighthouse and a screen reader before sign-off.

> Note on MUI baseline: MUI `Dialog`/`Modal`/`Drawer`/`Popover`/`Menu` bring
> focus trapping, Escape handling, and focus restoration; `TextField`/`Select`
> wrapped in `FormControl`+`InputLabel` are correctly labelled; `IconButton`s
> across the package generally carry real `aria-label`s backed by locale keys.
> The findings below are where that baseline is **overridden, hand-rolled, or
> bypassed** — not blanket MUI usage.

---

## Executive summary

x-studio is a rich, interaction-heavy dashboard builder, and its accessibility
gaps cluster into a small number of **systemic, repeated patterns** rather than
scattered one-offs. Fixing the patterns fixes most of the package.

| Severity | Count (approx., deduped) |
| :------- | :----------------------- |
| Critical | 9                        |
| Serious  | 18                       |
| Moderate | 22                       |
| Minor    | 13                       |

### The five systemic themes (fix these first)

1. **Data visualizations have no text alternative (Critical).** Every custom
   viz — funnel, gantt, heatmap, sankey, choropleth map, KPI sparkline/gauge,
   and the data-lineage graph — renders meaning purely through SVG/Box geometry
   and color, with no `role="img"`/`aria-label`, summary, or off-screen data
   table. For several (heatmap dense mode, funnel, gantt, map regions) the
   value exists **only** in a mouse-hover `Tooltip` over a non-focusable
   element, so it is unreachable by keyboard and silent to screen readers.

2. **Mouse/pointer-only interactions with no keyboard path (Critical).**
   Drag-and-drop is the _only_ way to add, move, and reorder widgets on the
   canvas; column resize is pointer-events only; grid-column reorder, lineage
   graph edges, and map-region cross-filtering are all click/pointer-only. None
   expose a keyboard equivalent.

3. **Disclosure widgets built from `<div onClick>` (Critical/Serious).** The
   shared `CollapsibleSection`, plus `CollapsibleFeatureSection` and
   `FilterCard`, implement expand/collapse with a non-interactive `Box onClick`,
   `cursor: 'default'`, no `role`/`tabIndex`/`onKeyDown`, no
   `aria-expanded`/`aria-controls`, and a chevron `IconButton` deliberately
   pulled out of the tab order (`tabIndex={-1}`). Collapsed content is
   unreachable by keyboard and the state is never announced.

4. **Custom controls instead of native `<button>` (Serious).** Many controls
   are `<Box role="button">` / `<span role="button">` whose `onKeyDown` handles
   Space **without `preventDefault`** (so Space also scrolls the page), use
   `cursor: 'default'`, or misuse ARIA (`aria-selected` on a roleless `div`).
   Native `<button>`/`IconButton` would give correct role + keyboard for free.

5. **Unlabeled form controls (Serious).** A number of `Select`, `Switch`, and
   `NumberField` controls render with no `InputLabel`/`aria-label`, so screen
   readers announce an unnamed combobox/spinbutton with no indication of
   purpose. (The majority of the package's forms _are_ correctly labelled — these
   are the exceptions.)

Secondary themes: missing live regions for async/no-data/error states; color as
the sole carrier of meaning (KPI good/bad sentiment, active toggles, presets);
sub-24×24px tap targets; tooltips as the sole accessible name; and
table/tab semantics (APG Tabs rail, heatmap grid, pivot header `scope`).

---

## Critical findings

### C1. Custom data-viz charts have no text alternative — SC 1.1.1, 4.1.2

- **Where:** `StudioChartWidget/StudioFunnelChart.tsx:71-83`,
  `StudioGanttChart.tsx:113-114`, `StudioHeatmapChart.tsx:76-77`,
  `StudioSankeyChart.tsx:33-43`; KPI `StudioKpiWidget/KpiSparkline.tsx:65-77`
  (gauge), `:88-110` (sparkline).
- **Issue:** Charts are built from positioned `Box`/`Typography`/SVG with color
  encoding values; no `role="img"`+`aria-label`, no visually-hidden summary, no
  equivalent data table. Non-visual users get nothing.
- **Fix:** Wrap each chart root in `role="img"` with an `aria-label` summarizing
  the series, or render a visually-hidden `<table>` mirroring the data
  (`stages`/`cells`/`items`/`links`/series points).

### C2. Heatmap / funnel / gantt cell values live only in a mouse-hover tooltip — SC 1.1.1, 1.4.13, 4.1.2

- **Where:** `StudioHeatmapChart.tsx:184-213` (cells; dense mode renders no
  in-cell text — `:203`), `StudioFunnelChart.tsx:176-202`,
  `StudioGanttChart.tsx:232-249`.
- **Issue:** Each data cell/bar is a `Tooltip` over a non-focusable `Box`
  (`cursor: 'default'`, no `tabIndex`). The value is unreachable by keyboard and
  unannounced — the tooltip is the sole carrier of the data.
- **Fix:** Make the wrapped element focusable and give it an `aria-label`
  carrying the tooltip text, or expose the data via the off-screen table (C1).

### C3. Choropleth map: region cross-filter is mouse-only and the map has no text alternative — SC 1.1.1, 2.1.1, 4.1.2

- **Where:** `StudioMapWidget/StudioMapShapePlot.tsx:101-112` (`onClick` only on
  `MapShape`), `StudioMapWidget.tsx:519-525` (surface has no role/label); region
  value only in `StudioMapTooltipContent.tsx`.
- **Issue:** Region selection is wired solely to `onClick` on the SVG path — no
  `onKeyDown`/`tabIndex`/`role`. Keyboard users cannot select a region; the
  region→value mapping is invisible to AT.
- **Fix:** Focusable shapes with `role="button"` + `aria-label="<region>:
<value>"` + Enter/Space, or an adjacent listbox/table of regions; add a
  summary `aria-label` to the map container and name the color legend
  (`StudioMapWidget.tsx:527-563`).

### C4. Data-lineage graph: edges/edge-labels are mouse-only and unlabeled — SC 2.1.1, 4.1.2

- **Where:** `StudioDataDrawer/EdgeLabel.tsx:79-86` (invisible hit path),
  `:97-121` (label badge), popover `:124-158`.
- **Issue:** Edge hit-path and label `<g>` open a relationship-detail popover via
  `onClick` only — no `tabIndex`/`role`/key handler/name. Join-key details are
  unreachable without a mouse.
- **Fix:** Make edges focusable `role="button"` with an `aria-label` describing
  the relationship + Enter/Space; or surface the same details through the
  keyboard-reachable `RelationshipPanel` list.

### C5. Data-lineage `<svg>` graph has no accessible name/structure — SC 1.1.1, 1.3.1

- **Where:** `StudioDataDrawer/DataLineageGraph.tsx:73-149`; node `aria-label`
  only set when `onNodeClick` exists (`:122`).
- **Issue:** The graph SVG has no `role="img"`/`<title>`/`<desc>`/`aria-label`;
  node labels are visually truncated (`:145`) with no full text exposed; nodes
  without a click handler have no accessible name at all.
- **Fix:** Add `role="img"` + `aria-labelledby`/`aria-describedby` (or a
  visually-hidden summary); ensure every node carries its full untruncated label.

### C6. Drag-and-drop is the only way to add/move/reorder canvas widgets — SC 2.1.1

- **Where:** `StudioCanvas/InsertionPoint.tsx:25-116`, `WidgetGap.tsx:42-121`,
  `useStudioDraggable.ts:36-82`, `useStudioDropTarget.ts:23-53`,
  `StudioCanvas.tsx:327-505`; no keyboard reorder in
  `StudioWidgetCardActionsOverlay.tsx`.
- **Issue:** Placement/reordering is pointer DnD only (pragmatic-drag-and-drop has
  no built-in keyboard support). Keyboard users cannot place or move widgets.
- **Fix:** Add keyboard-operable "Move up/down/left/right" + "Insert here"
  actions (card overlay or context menu) wired to the same
  `controller.updateState` row/col logic as `handleDrop`.

### C7. Column resize handles are pointer-only — SC 2.1.1

- **Where:** `StudioCanvas/RowResizeHandle.tsx:109-141`, wired in
  `StudioCanvas.tsx:472-504`.
- **Issue:** Handle is a `Box` driven entirely by
  `onPointerDown/Move/Up` + `setPointerCapture`; no `tabIndex`/`role`/
  `aria-value*`/`onKeyDown`. Resizing is impossible without a pointer. (Also
  fails target size — see M-group.)
- **Fix:** Implement the APG window-splitter pattern: `role="separator"`,
  `tabIndex={0}`, `aria-valuemin/now/max`, `aria-label`, and Left/Right/Home/End
  keys calling the existing drag logic by ±1 span.

### C8. Grid-column drag-to-reorder is mouse-only — SC 2.1.1

- **Where:** `StudioComposeDrawer/GridSetupPanel.tsx:479-503` (HTML5
  `draggable` row; the `⋮` menu offers only remove/aggregation, no reorder).
- **Issue:** Column reordering has no keyboard alternative.
- **Fix:** Add up/down `IconButton`s or "Move up/Move down" menu items, or
  arrow-key reordering on a focusable roled list.

### C9. Bare `Select`s in the expression InputNode have no accessible name — SC 4.1.2, 3.3.2

- **Where:** `StudioExpressionFieldDialog/ExpressionNodeEditor.tsx:203-212`
  (kind), `:238-254` (field), `:256-272` (aggregation), `:279-297` (literal
  type), `:298-309` (boolean value).
- **Issue:** No wrapping `FormControl`+`InputLabel`/`label`/`aria-label`; the
  nearby positional `"Input 1"` `Typography` is not associated. SR users hear
  unlabeled comboboxes with no idea what each controls.
- **Fix:** Add localized `aria-label` to each (Input type / Field / Aggregation /
  Literal type / Boolean value), or wrap with associated `InputLabel`.

> **Disclosure widgets (C-level via `CollapsibleSection`):** see S1 — the shared
> `CollapsibleSection` toggle is keyboard-inoperable, which is Critical for any
> content only reachable by expanding it (e.g. text-format panels). It is listed
> under Serious below because the same root fix resolves all instances.

---

## Serious findings

### S1. Disclosure pattern built from `<div onClick>` — no keyboard, no state — SC 2.1.1, 4.1.2, 1.3.1

Same root defect in three components; fix once in the shared component and
mirror in the others.

- **`internals/CollapsibleSection.tsx:40-46`** — header is `Box onClick`,
  `cursor: 'default'`, no role/tabIndex/keydown/`aria-expanded`/`aria-controls`;
  chevron `IconButton` has `tabIndex={-1}` and no `aria-label`. Used by
  `TextSectionFormat.tsx:46` and others, so whole panels are unreachable when
  collapsed. Collapsed active-count `Chip` (`:49-55`) is a bare number with no
  accessible association.
- **`StudioComposeDrawer/CollapsibleFeatureSection.tsx:54-87`** — same `Box
onClick` header; the `Switch` (`:81-85`) has no associated label (visible
  `Typography` not tied via `id`/`htmlFor`/`aria-labelledby`). Drives KPI
  Sparkline/Target/Trend/Date-range sections.
- **`StudioFiltersDrawer/FilterCard.tsx:41-79`** — `Box onClick` header; expand
  `IconButton` is `tabIndex={-1}` with no `aria-label`.
- **Fix:** Make the toggle a real `<button>` (or `Box component="button"`) with
  `aria-expanded` + `aria-controls` → the `Collapse` region id; render the
  chevron decorative (`aria-hidden`); bind each `Switch` via `FormControlLabel`.

### S2. APG Tabs pattern violated in the sidebar rail — SC 4.1.2, 2.1.1

- **Where:** `Studio/TabbedSidebar.tsx:85-107`,
  `TabbedSidebarTabEntry.tsx:34-83`, `TabbedSidebarActivePanel.tsx:27-77`.
- **Issue:** `role="tablist"`/`role="tab"` declared, but every tab is
  `tabIndex={0}` (no roving tabIndex), there is no arrow-key navigation
  (`onKeyDown` only handles Enter/Space), and the panel has no `role="tabpanel"`/
  `aria-labelledby`/`aria-controls` wiring.
- **Fix:** Implement full Tabs pattern (roving tabIndex, Left/Right+Home/End,
  `aria-controls`, `role="tabpanel"`+`aria-labelledby`+`tabIndex={-1}`), **or**
  — given the click-to-collapse toggle behavior — model each entry as a
  disclosure `<button aria-expanded aria-controls>` instead of a tab.

### S3. Compose-drawer `TabPanel` not associated with its tab — SC 1.3.1, 4.1.2

- **Where:** `StudioComposeDrawer/StudioComposeDrawer.tsx:33-41`, `61-69`.
- **Issue:** MUI `Tabs`/`Tab` give roles/arrow-nav, but the custom `TabPanel`
  sets no `id`/`aria-labelledby` and tabs no `aria-controls`/`id`; panel not
  focusable.
- **Fix:** Add `id`+`aria-controls` to tabs, `id`+`aria-labelledby`(+`tabIndex={0}`)
  to panels.

### S4. Collapsed drawer strip nests an interactive button inside `role="button"` — SC 4.1.2, 1.3.1

- **Where:** `Studio/DrawerPanel.tsx:55-130`.
- **Issue:** Outer `Box role="button" tabIndex={0}` contains another `IconButton`
  performing the same action (invalid: interactive content inside a button role).
- **Fix:** One control only — make the outer region presentational and keep the
  `IconButton` as the toggle, or keep the outer button with a decorative
  `aria-hidden` chevron.

### S5. Quick-filter bar opens a drawer via `onClick` on a non-interactive `div` — SC 2.1.1, 4.1.2

- **Where:** `StudioCanvas/StudioQuickFilterBar.tsx:68-83`.
- **Issue:** Container `Box` has `onClick={openFiltersDrawer}` but no
  role/tabIndex/keydown; mouse-only. (It also wraps interactive chips, so the
  container itself must not be the button.)
- **Fix:** Remove container `onClick`; add a focusable "Edit filters"
  `IconButton`/button with `aria-label`.

### S6. Custom filter controls: `Space` without `preventDefault`, `<span role="button">` — SC 2.1.1, 4.1.2

- **Where:** `widgets/StudioFilterWidget/controls/MultiSelectControl.tsx:57-77,
123-140, 144-161, 164-188`; `ToggleControl.tsx:43-64`;
  `DateRangeControl.tsx:84-104`.
- **Issue:** `Box component="span" role="button" tabIndex={0}` whose `onKeyDown`
  fires on Space but never calls `preventDefault` (Space activates _and_ scrolls);
  `cursor: 'default'` undercuts affordance. Should be native controls.
- **Fix:** Use MUI `IconButton`/`Button`; at minimum `preventDefault()` on Space
  and `cursor: 'pointer'`.

### S7. "Select all/Clear all/Exclude" + search injected as a `MenuItem` inside a `<Select multiple>` listbox — SC 1.3.1, 4.1.2

- **Where:** `widgets/StudioFilterWidget/controls/MultiSelectControl.tsx:99-190`.
- **Issue:** Non-option content (search field + action buttons) rendered as the
  first `MenuItem` becomes a bogus `role="option"`; `onKeyDown` stopPropagation
  (`:101`) breaks listbox type-ahead/navigation.
- **Fix:** Render search/actions in `MenuProps` paper _outside_ the option list
  (sticky header), or switch to `Autocomplete`.

### S8. "View source" affordance is a mouse-only `<span onClick>` inside a tooltip — SC 2.1.1, 4.1.2

- **Where:** `StudioDataDrawer/DataSourcePreviewTooltip.tsx:123-132`.
- **Issue:** `Typography component="span"` with `onClick` only; lives inside a
  hover `Tooltip`, so it's the only path to the preview dialog yet is
  keyboard-unreachable.
- **Fix:** Render as `Button`/`Link component="button"` with keyboard activation.

### S9. Unlabeled `Select` controls (no accessible name) — SC 4.1.2, 1.3.1

- **Where:** `StudioComposeDrawer/InlineFormulaBar.tsx:208-212` (operator);
  `ChartSetupPanel.tsx:1062-1075` (annotation axis);
  `GridSetupPanel.tsx:755-770, 771-789, 809-832` (conditional-format
  field/operator/style); `StudioFiltersDrawer/RelativeDateInput.tsx:152-163,
164-174` (unit/direction); `widgets/.../MultiSelectControl.tsx:80-97` (trigger).
- **Fix:** Add `aria-label` to each (compact inline UI → `aria-label` over
  visible `InputLabel`).

### S10. Unlabeled `Switch` toggles rely on adjacent text only — SC 1.3.1, 4.1.2

- **Where:** `StudioComposeDrawer/KpiSparklineOptions.tsx:209-217, 224-232`;
  `KpiSetupPanel.tsx:381-387`. (Contrast: `MapSetupPanel`/`PivotSetupPanel`/
  `FormatPanel` correctly use `FormControlLabel`.)
- **Fix:** Wrap in `FormControlLabel` or give `aria-label`/`aria-labelledby`.

### S11. Unlabeled rank/date inputs and icon-only toggle groups — SC 4.1.2

- **Where:** `StudioFiltersDrawer/RankFilterInput.tsx:67-73` (NumberField),
  `:46-65` (Top/Bottom group); `DateValueInput.tsx:129-145` (absolute/relative
  group + icon-only toggles named by tooltip only).
- **Fix:** `label`/`aria-label` on the NumberField; `aria-label` on each group;
  `aria-label` on each icon-only `ToggleButton`.

### S12. Widget type cards don't expose disabled state — SC 4.1.2

- **Where:** `StudioComposeDrawer/WidgetTypeCard.tsx:60-91`.
- **Issue:** When `canAdd` is false, only `opacity: 0.5` signals it; element stays
  focusable `role="button"` with no `aria-disabled` → announces actionable but
  does nothing.
- **Fix:** `aria-disabled={!canAdd}` (with a reason) or remove from tab order.

### S13. Widget card uses `aria-selected` on a roleless `<div>` — SC 4.1.2

- **Where:** `StudioWidgetCard/StudioWidgetCard.tsx:480-538`.
- **Issue:** `Paper` (div) has `aria-selected` + click/Enter/Space but no `role`,
  so `aria-selected` is invalid/ignored; announced as a generic group.
- **Fix:** Add `role="button"` (with `aria-pressed`) or `role="option"` within a
  `role="listbox"`.

### S14. View-mode card actions are hover-only — unreachable by keyboard — SC 2.1.1, 2.4.7

- **Where:** `StudioWidgetCard.tsx:464-465, 514-515`;
  `StudioWidgetCardActionsOverlay.tsx:392-406, 415, 431`.
- **Issue:** In view mode, Export/Expand become visible _and_ focusable
  (`tabIndex` flips 0/-1) only while `hovered`; no `focus-within`, so keyboard
  users can never reach them.
- **Fix:** Include `:focus-within`/focus state in the reveal + `tabIndex`
  condition, mirroring the edit-mode `isSelected` path.

### S15. KPI trend conveys good/bad purely by color — SC 1.4.1

- **Where:** `widgets/StudioKpiWidget/KpiTrend.tsx:38-58, 86-99`.
- **Issue:** Sentiment (respecting `isInverted`) is shown only via green/red; the
  arrow icon reflects raw direction, not good/bad, so colorblind users can't read
  sentiment.
- **Fix:** Add a non-color sentiment cue (text "improving"/"worse" or distinct
  iconography) and state it in the `aria-label`.

### S16. KPI sparkline & gauge are unlabeled data-viz — SC 1.1.1, 4.1.2

- **Where:** `KpiSparkline.tsx:65-77` (Gauge), `:88-110` (SparkLineChart).
- **Fix:** `aria-label` summarizing trend/value on the chart container.

### S17. Heatmap is a visual grid with no header→cell association — SC 1.3.1

- **Where:** `StudioHeatmapChart.tsx:107-125, 153-168, 174-216`.
- **Issue:** Grid built from `Box`es with rotated `writingMode: vertical-rl`
  labels; no table/grid semantics, no programmatic row/col header association.
- **Fix:** Real `<table>` with `<th scope>` (like `PivotTable`) or ARIA `grid`,
  or the off-screen data table (C1).

### S18. Pivot data cells not associated with headers via `scope` — SC 1.3.1

- **Where:** `widgets/StudioPivotWidget/PivotTable.tsx:78-124`.
- **Issue:** Column `<th>` lacks `scope="col"`; row labels are `<td>` (`:97`) not
  `<th scope="row">`, so cell↔header association isn't guaranteed.
- **Fix:** `<th scope="col">` for column headers, `<th scope="row">` for row
  labels. (Corner `<th aria-label>` at `:79` is already good.)

---

## Moderate findings

- **M1. No live regions for shell state changes** (drawer/panel open-close, tab
  switch, resize complete, widget drop): `Studio/DrawerPanel.tsx:55-185`,
  `TabbedSidebar.tsx:62-75`, `StudioCanvas.tsx:159-266, 493-503`. Add a
  visually-hidden `aria-live="polite"` status region. — SC 4.1.3
- **M2. Empty-canvas message not a status region:** `StudioCanvas.tsx:268-298` —
  wrap in `role="status"`. — SC 4.1.3
- **M3. Inconsistent no-data/loading/error announcements in widgets:**
  `StudioPivotWidget.tsx:69-86` does it right (`role="status"`); missing in
  `StudioChartWidget.tsx` placeholders (`:790-915, 947-966, 1102-1217, 1327-1342,
1592-1603`) and `StudioMapWidget.tsx:438-459`. — SC 4.1.3 _(verify shared
  `StudioNoDataOverlay`/`StudioWidgetErrorOverlay` already provide a live region —
  they do: `internals/StudioNoDataOverlay.tsx:21-25` `role="status"`,
  `StudioWidgetErrorOverlay.tsx:26-30` `role="alert"`.)_
- **M4. Streaming AI responses rely on `@mui/x-chat` for live-region behavior;**
  Studio adds none, and the "Thinking…" caption has no `role="status"`:
  `StudioChatPanel.tsx:945-998, 368-377`. — SC 4.1.3 — **needs runtime
  verification** against `ChatBox`.
- **M5. Expression preview & validation `Alert` not announced:**
  `ExpressionPreview.tsx:61-103`, `StudioExpressionFieldDialog.tsx:290-301` —
  wrap preview in `role="status"`, give the `Alert` `role="alert"`. — SC 4.1.3
- **M6. Copy-to-clipboard success is tooltip-only and lacks `.catch`:**
  `StudioChatPanel.tsx:236-270`. — SC 4.1.3
- **M7. Voice-input toggle has no `aria-pressed`; listening state is color-only
  and auto-stop is silent:** `StudioChatPanel.tsx:1004-1023`,
  `useSpeechRecognition.ts:88-96`. — SC 4.1.2, 1.4.1
- **M8. `StudioReasoningPart` disclosure button missing `aria-expanded`/
  `aria-controls`:** `StudioChatPanel.tsx:386-417`. — SC 4.1.2
- **M9. Thread-selector trigger named only by `Tooltip`, no `aria-haspopup`/
  `aria-expanded`, `cursor: 'default'`:** `StudioChatPanel.tsx:866-900`. —
  SC 4.1.2
- **M10. `FieldTypeIcon` meaning carried only by `Tooltip`:**
  `internals/FieldTypeIcon.tsx:54-67` — add `role="img"`+`aria-label={label}`. —
  SC 1.1.1, 4.1.2
- **M11. Slider control announces raw timestamps; no per-thumb labels:**
  `widgets/StudioFilterWidget/controls/SliderControl.tsx:56-67` — add
  `getAriaValueText={formatLabel}` + per-thumb `getAriaLabel`. — SC 4.1.2 (APG
  Slider)
- **M12. Multi-select trigger `Select` has no accessible name** (only the outer
  `role="group"` is labelled): `MultiSelectControl.tsx:80-97`. — SC 4.1.2
- **M13. Insight type-switcher: no `aria-pressed`/`aria-current`, color-only
  active state, `cursor: 'default'`:** `StudioInsightPanel/StudioInsightPanel.tsx:100-120`.
  — SC 1.4.1, 4.1.2
- **M14. Map color legend has no accessible name linking it to the metric:**
  `StudioMapWidget.tsx:527-563`. — SC 1.1.1
- **M15. ChartTypePicker Space doesn't `preventDefault` (page scroll):**
  `StudioComposeDrawer/ChartTypePicker.tsx:106-152`. — SC 2.1.1
- **M16. Conditional-format value field is placeholder-only (no label):**
  `GridSetupPanel.tsx:790-808`. — SC 1.3.1, 3.3.2
- **M17. Selection-filter rows: redundant `div onClick` around a `Checkbox`,
  label not bound:** `StudioFiltersDrawer/SelectionFilterInput.tsx:89-133` — use
  `FormControlLabel`/`aria-label`. — SC 4.1.2
- **M18. Inferred "Output type"/"Expression" labels not associated; hardcoded
  English:** `StudioExpressionFieldDialog.tsx:240-277`,
  `ExpressionNodeEditor.tsx:426-434`. — SC 1.3.1, 3.3.2
- **M19. Lineage node/edge `cursor: 'default'` + SVG focus-ring visibility:**
  `DataLineageGraph.tsx:107-123`, `EdgeLabel.tsx:84, 98` — `cursor: 'pointer'` +
  explicit focus-visible stroke. — SC 2.4.7 — **needs runtime verification**
- **M20. CollapsibleSection title is not a heading and body is not a region:**
  `internals/CollapsibleSection.tsx:47-56, 75-77`. — SC 1.3.1
- **M21. Tap targets < 24×24px** (group): `StudioCanvas` resize handle in 8px gap
  (`WidgetGap.tsx:76-86` + `RowResizeHandle.tsx:109-126`),
  `StudioWidgetCardActionsOverlay`/filter-control clear icons (`fontSize:14`),
  `StudioInsightPanel.tsx:124-140` (`p:0.25`), `StudioDataDrawer`
  `RelationshipPanel.tsx:160-176` / `ExpressionFieldRow.tsx:68-90` (`p:'2px'`),
  `StudioFiltersDrawer/SecondCondition.tsx:80-88`. — SC 2.5.8 — **verify rendered
  sizes**
- **M22. Color/contrast heuristics for blended text & swatch icon are not true
  WCAG ratios:** `StudioFunnelChart.tsx:102-114`,
  `StudioHeatmapChart.tsx:44-59, 182`, `ColorSwatch.tsx:7-17, 63-70`. — SC 1.4.3,
  1.4.11 — **needs runtime verification**

---

## Minor findings

- **m1.** No landmarks/headings in the shell: `Studio/StudioContent.tsx:225-298`
  — mark canvas `<main>`, sidebar `role="complementary"`+label. — SC 1.3.1, 2.4.1
- **m2.** Rotated `vertical-rl` tab/strip labels (AT OK via `aria-label`, low-vision
  concern): `TabbedSidebarTabEntry.tsx:18-32`, `DrawerPanel.tsx:86-117`. — SC 1.4.10
- **m3.** `SecondCondition` remove button named by `Tooltip` only:
  `StudioFiltersDrawer/SecondCondition.tsx:79-88` — add `aria-label`. — SC 4.1.2
- **m4.** RelativeDateInput preset chips don't expose selected state (color-only):
  `RelativeDateInput.tsx:99-114` — `aria-pressed` or radio group. — SC 4.1.2
- **m5.** Date-range presets / active tab partly color-coded:
  `StudioDateRangeBar.tsx:205-222`, `TabbedSidebarTabEntry.tsx:27, 67` — verify
  contrast; ensure non-color active cue. — SC 1.4.1 — **verify**
- **m6.** Decorative chevrons inside named buttons not `aria-hidden`:
  `StudioChatPanel.tsx:409-416, 898`, `CollapsibleSection.tsx:45`. — SC 1.1.1
- **m7.** Hardcoded English strings bypass `localeText` (blocks localized
  accessible names): `StudioChatPanel.tsx:376, 407, 920-924, 977-978, 1077`;
  `ExpressionNodeEditor.tsx:36-64, 429-462`;
  `StudioExpressionFieldDialog.tsx:243, 268`.
- **m8.** `cursor: 'default'` on clickable chart surfaces (affordance):
  `StudioChartWidget.tsx:1019, 1310, 1572, 1755, 1924, 2058, 2176, 2353, 2450,
2513, 2573`. — best practice
- **m9.** Funnel drop-off `▼` glyph as adjacent indicator:
  `StudioFunnelChart.tsx:132-137` — `aria-hidden` the glyph. — SC 1.1.1
- **m10.** Toggle chips rely on `aria-pressed` only (acceptable; verify MUI Chip
  keyboard): `widgets/StudioFilterWidget/controls/ToggleControl.tsx:86-95`. —
  SC 4.1.2 — **verify**
- **m11.** Text widget applies arbitrary user colors with no contrast guard:
  `widgets/StudioTextWidget/StudioTextWidget.tsx:31-54`,
  `StudioWidgetCard.tsx:598-612`. — SC 1.4.3 — **verify / config-time warning**
- **m12.** Grid widget cross-filter via `onCellClick` (likely keyboard-OK via
  DataGrid, undiscoverable): `widgets/StudioGridWidget/StudioGridWidget.tsx:383`.
  — SC 2.1.1 — **verify Enter triggers `onCellClick`**
- **m13.** `AddWidgetView` smooth-scroll ignores `prefers-reduced-motion`:
  `StudioComposeDrawer/AddWidgetView.tsx:31-73`. — SC 2.3.3 (AAA, best practice)

---

## Confirmed good (no action) — selected

- `internals/NumberField.tsx` — label via `InputLabel htmlFor`, `aria-describedby`
  always resolves, increment/decrement buttons `aria-label`led, Base UI spinbutton
  semantics.
- `internals/StudioNoDataOverlay.tsx` (`role="status"`) and
  `StudioWidgetErrorOverlay.tsx` (`role="alert"`).
- `internals/useStudioKeyboardShortcuts.ts` — bails on editable targets /
  `defaultPrevented` / Alt; only intercepts undo/redo; no focus trap.
- `StudioChatPanel` send/stop button, thread `Menu`, overlay close button —
  proper names + MUI focus management.
- `StudioWidgetEditDialog` (MUI `Dialog` + labelled tabs + `role="tabpanel"`),
  delete-confirm dialog (`aria-labelledby`/`describedby` + focus return),
  `FilterRow`/`WidgetFiltersPanel` (labelled MUI controls), `PivotTable` (real
  `<table>`/`<th>` + CSV export `<Button>`).
- The large majority of `Select`/`TextField` forms across the compose/data/filter
  drawers are correctly wrapped in `FormControl`+`InputLabel`, and icon-only
  `IconButton`s carry real locale-backed `aria-label`s.

---

## Recommended remediation order

1. **Keyboard alternatives for pointer-only interactions** (C6, C7, C8, C3, C4) —
   highest-impact, blocks whole feature areas.
2. **Text alternatives / data tables for all data-viz** (C1, C2, C3, C5, S16,
   S17) — a shared "visually-hidden data table" helper covers most.
3. **Fix the shared disclosure component** (S1) — one change fixes
   `CollapsibleSection` everywhere, then mirror in `CollapsibleFeatureSection`
   and `FilterCard`.
4. **Replace custom `role="button"` controls with native buttons / add
   `preventDefault`** (S6, S5, S8, S13, m-group).
5. **Label the remaining unlabeled `Select`/`Switch`/`NumberField` controls**
   (C9, S9, S10, S11, M12, M16).
6. **Add live regions** (M1–M5) and **non-color cues** (S15, M7, M13, m4).
7. **Tab/table semantics** (S2, S3, S18), **target sizes** (M21), then run a
   **runtime audit** (axe-core + screen reader) to close all "needs verification"
   items, especially contrast (M22, m5, m11) and `@mui/x-chat` live regions (M4).

---

## Remediation status

### Fixed (committed on `x-studio`)

- **Disclosure widgets (S1):** `CollapsibleSection`, `CollapsibleFeatureSection`,
  `FilterCard` are now keyboard-operable `<button>` disclosures with
  `aria-expanded`/`aria-controls` and focus rings.
- **Unlabeled form controls (C9, S9, S10, S11, M12, M16):** accessible names
  added across the expression builder, filters drawer, and compose drawer
  (selects, switches, toggle groups, number/value fields) via localizable
  tokens.
- **Custom controls → native buttons (S5, S6, S7, S8, S13, M15):** filter-widget
  clear/select-all/clear-all/exclude controls, the quick-filter bar trigger, the
  data-source "view source" link, the widget-card selection state
  (`aria-current`), and the ChartTypePicker Space key.
- **Live regions & non-color cues (S15, M2, M4, M5, M6, M7, M8, M9, M10, M13):**
  KPI trend sentiment (color-independent), `FieldTypeIcon` name, empty-canvas /
  "Thinking…" status regions, reasoning disclosure state, thread-switcher
  semantics, clipboard rejection handling, voice-input `aria-pressed`, insight
  switcher `aria-pressed`, and expression preview/validation live regions.
- **Data-viz text alternatives (C1, C2, C3-text, C5, S16, S17-summary, S18):**
  `role="img"` + data summaries on funnel/gantt/heatmap/sankey/map/KPI charts,
  a named `role="group"` + per-node names on the lineage graph, and
  `scope`/`<th>` header association in the pivot table.
- **Keyboard for pointer-only actions (C4, C6, C7, C8):** lineage edges are
  focusable buttons; the column resize handle is an APG window-splitter;
  canvas widgets have up/down/left/right reorder controls (tested
  `moveWidgetInLayout` helper); grid columns have move-up/down buttons.
- **C3 — keyboard map-region selection:** each interactive choropleth shape is a
  focusable `role="button"` group (region name + Enter/Space → cross-filter); the
  map container uses `role="group"` when interactive so shapes stay reachable.
- **M1 — shell live region:** opening/closing a sidebar panel is announced via a
  polite live region (panel open/close does not move focus).
- **M3 — no-data/error announcements:** the map's no-data/error paths use the
  shared `StudioNoDataOverlay`/`StudioWidgetErrorOverlay` (`role="status"`/`alert`).
- **M11 — slider value text:** `getAriaValueText` (formatted dates) and per-thumb
  `getAriaLabel` (minimum/maximum).
- **M14 — map legend name:** the color legend has an accessible name (measure +
  value range).
- **M21 — target sizes:** insight-panel and data-drawer icon buttons raised to a
  ≥24×24px hit area.
- **m1 — landmark:** the canvas is a named `<main>` region.

### Outstanding (recommended follow-ups)

- **M1 (extended)** — announce canvas resize / widget-drop results and tab
  switches (panel open/close is done).
- **m7 — localize** the remaining hardcoded English strings, including the chart
  `aria-label` summaries and the canvas reorder labels added here.
- **Sidebar `complementary` landmark** and a programmatic page heading (the
  canvas `<main>` landmark is done).
- **Runtime audit** (axe-core + screen reader) to close all "needs verification"
  items, especially contrast (M22, m5, m11) and the `@mui/x-chat` streaming
  live region (M4).
