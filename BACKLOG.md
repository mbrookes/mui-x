# Backlog

BL-01: ~~Clicking on a widget in the compose panel should display a list of configured widgets of that type (if any), rather than adding a new one. Clicking on one from the list should show it's configuration panel and highlight it on the canvas. There should be a button to add a widget of that type below the list of existing widgets.~~ **Fixed** (type card click shows existing widget list with back button; "Add" button at bottom; new widgets scroll smoothly into view)

BL-02: ~~Auto-generated titles should never be empty. At a minimum, if the widget isn't configured, it should show the widget type as the name, e.g. chart, Text. This can be replaced by something more informative when daasource etc are configured.~~ **Fixed** (non-text widgets now always show auto titles, with fallback display names when still unconfigured)

BL-03: ~~Drag and drop horizontal insertion line shouldn't extend into the padding.~~ **Fixed** (inset line by 8px on each side to align with widget area)

BL-04: Need a data generator to test performance at scale.

BL-05: ~~The widget card content shrinks when a widget is selected and has a blue border.~~ **Fixed** (use outline instead of border for selection indicator)

BL-06: ~~The field select should show both data source name and field name for the selected field, eith a separator (. or : or |, whatever is best practice or data analytics tools).~~ **Fixed** (selected field now displays as "Source · Field" when multiple data sources are present; single-source keeps field name only)

BL-07: ~~Horizontal bar charts are displayed as veritcal (identical to non-horizonatal).~~ **Fixed** (horizontal layout now applies to single-series, split-series, and multi-measure bar charts; config panel axis labels also flip to match)

BL-08: ~~Move the undo-redo before upload-download, and add separators between them and the view-edit control.~~ **Fixed** (undo/redo now appears before load/save; vertical dividers separate undo/redo from load/save and load/save from view/edit switch)

BL-09: ~~Tooltip for the data panel fields with preview of first n records.~~ **Fixed** (hovering a field in the data drawer shows a tooltip with the field name and first 5 row values; shows "+N more" when there are additional rows)

BL-10: ~~Make the auto titles smarter, based on the defined fields (changing it as they're defined), for example "Monthly Total by Category" for a chart grouped by month on the x axis, Total as the y axis, and split by category~~ **Fixed** (auto titles/subtitles now infer from configured fields across non-text widgets, including grouped chart titles like "Monthly Revenue by Category")

BL-11: ~~Drag and drop performance. Really slow after dropping a card before the line dissapears and the card appears.~~ **Fixed** (module-level `hydratedWidgets` Set tracks already-rendered widget IDs; remounts from DnD skip the rAF+transition defer and render content immediately)

BL-12: ~~smooth scroll to widget added to chart by click.~~ **Fixed** (ease-out-cubic animation, target re-evaluated each frame to track widget content loading)

BL-13: ~~The Filter by Country filter widget doesn't show any chips. Changing the field and changing it back populates it.~~ **Fixed** (filter widgets now resolve expression-backed fields from enriched rows on first render; the example Country filter now points at `expr-order-country`)

BL-14: ~~Category field in the charts panel doesn't have section a title.~~ **Fixed** (the split-by/category picker now has a visible "Category field" section heading in the chart setup panel)

BL-15: ~~When more than one measure field is added, the split-by select dissapears.~~ **Fixed** (the split-by/category field now stays visible and is disabled with explanatory helper text when multiple measure fields are configured)

BL-16: ~~the delete button for fields doesn't line up vertically with the textfield, it's centered on the entire including the helper-text~~ **Fixed** (multi-series rows now top-align the field and remove button, and the delete button is offset to sit against the input instead of the helper text)

~~BL-17: KPI sparkline controls are grouped with a vertical bar. USe a background color with border radius, make it collapsable and collapsed by default. Put the label (e.g. Sparkline) on the left, and the control (switch) on the right. When switch toggled to on, open the panel, when toggled to off close it. Chevron on the far left of the title should also open and close it.~~ ✅ Fixed
 
~~BL-18: Changing the filter widget type looses the field config, at least for date filters.~~ **Fixed** (type change now preserves the selected field unless it's incompatible with the new type; only clears when switching to date-range/slider with an incompatible field type)

BL-19: Add a "full-screen" icon to charts controls that displays them in a near page-width overlay.

~~BL-20: Dragging the slider filter thumb tries to drag the panel as if repositioning~~ **Fixed** (stop pointer events from bubbling out of the slider box so the widget card's native drag handler isn't triggered)

BL-21: customer aquisition over time chart is blank
