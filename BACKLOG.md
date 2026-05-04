# Backlog

BL-01: Clicking on a widget in the compose panel should display a list of configured widgets of that type (if any), rather than adding a new one. Clicking on one from the list should show it's configuration panel and highlight it on the canvas. There should be a button to add a widget of that type below the list of existing widgets.

BL-02: ~~Auto-generated titles should never be empty. At a minimum, if the widget isn't configured, it should show the widget type as the name, e.g. chart, Text. This can be replaced by something more informative when daasource etc are configured.~~ **Fixed** (non-text widgets now always show auto titles, with fallback display names when still unconfigured)

BL-03: ~~Drag and drop horizontal insertion line shouldn't extend into the padding.~~ **Fixed** (inset line by 8px on each side to align with widget area)

BL-04: Need a data generator to test performance at scale.

BL-05: ~~The widget card content shrinks when a widget is selected and has a blue border.~~ **Fixed** (use outline instead of border for selection indicator)

BL-06: The filed select should show both data source name and field name for the selected field, eith a separator (. or : or |, whatever is best practice or data analytics tools).

BL-07: Horizontal bar charts are displayed as veritcal (identical to non-horizonatal).

BL-08: Move the undo-redo before upload-download, and add separators between them and the view-edit control.

BL-09: Tooltip for the data panel fields with preview of first n records.

BL-10: ~~Make the auto titles smarter, based on the defined fields (changing it as they're defined), for example "Monthly Total by Category" for a chart grouped by month on the x axis, Total as the y axis, and split by category~~ **Fixed** (auto titles/subtitles now infer from configured fields across non-text widgets, including grouped chart titles like "Monthly Revenue by Category")

BL-11: Drag and drop performance. Really slow after dropping a card before the line dissapears and the card appears.

BL-12: smooth scroll to widget added to chart by click.
