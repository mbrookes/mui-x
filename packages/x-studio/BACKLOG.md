# Backlog

✅ BL-206: Mixed (bar+line) charts — line series invisible. "Revenue & Avg Discount by Category" and "Revenue vs Inventory Stock by Category (blended sources)" showed only bars; the line overlay was not visible.

**Root cause**: `StudioChartWidget.tsx` used `yAxisKey` when building `mixedSeries` objects, but the MUI X Charts API property is `yAxisId`. With `dualYAxis: true`, the unrecognized `yAxisKey` was silently ignored, so every series fell back to the first (left) y-axis. Bar values (revenue, millions) dominated the scale; line values (discount %, stock counts) were compressed to near-zero and invisible.

**Fixed** (`StudioChartWidget.tsx`): renamed `yAxisKey` → `yAxisId` in both the `line` and `bar` branches of the `mixedSeries.map()` block. Line series now correctly bind to `'right'` and bars to `'left'` when dual-axis is enabled.

✅ BL-207: Make the heatmap widget legend the same size as the map's.

**Root cause**: `useHeatmapProps.ts` (x-charts-pro) hardcodes `width: '50%'` for horizontal legends and `height: 150` for vertical legends. The map widget uses explicit pixel sizes (180px wide / 140px tall) matched to the geographic content extent.

**Fixed** (`StudioChartWidget.tsx`): added `sx: isVerticalHeatLegend ? { height: 140 } : { width: 180 }` to `slotProps.legend`. The `consumeSlots` HOC merges `externalSlotProps` (consumer's `slotProps.legend`) after `additionalProps`, so the consumer's `sx` overrides the default via MUI's sx array cascade.

✅ BL-208: Heatmap doesn't have a control to set the Y axis.

**Root cause**: The `heatYField` picker in `ChartSetupPanel` used `categoryFields` (only string/boolean fields), but the heatmap Y axis can be any field type. The example config already used `discount` (a `number` field) as the Y axis, which never appeared in the picker dropdown.

**Fixed** (`ChartSetupPanel.tsx`): changed `heatYField` picker from `categoryFields` to a new `heatYFields` memo that accepts any field type but restricts to the widget's primary source. `reachableFields` was tried first but included cross-source fields (e.g. `segment` from CUSTOMERS) that are not present on the primary-source row objects read by `aggregateHeatmap`, causing "No data to display". Updated the helper text in all locale files to reflect the primary-source restriction.

✅ BL-209: Heatmap sort options should target one of the two axes (not the generic category/value picker), placed below axis field selection, disabled until both axes are set.

**Fixed**: Added `heatSortBy?: 'x-axis' | 'y-axis' | 'natural'` and `heatSortDirection?: 'asc' | 'desc'` to `StudioWidgetConfig`. Removed heatmap from the generic sort-control guard in `ChartSetupPanel`; added a dedicated sort `Select` (Natural / Column axis (X) / Row axis (Y)) plus an asc/desc `ToggleButtonGroup` (shown only when an axis is selected) inside the `isHeatmap` block, after the colour scheme picker, disabled when either axis field is unset. `aggregateHeatmap` extended with `sortBy`/`sortDirection` params: `'x-axis'` sorts xLabels, `'y-axis'` sorts yLabels (both using `sortLabels` + optional `.toReversed()`), `'natural'` preserves insertion order for both; `orderedValues` still takes precedence when set. Locale tokens added in all four locales. `widgetConfigMeta.ts` updated for the AI agent.

✅ BL-209: Sort should sort numerical fields numerically, not alphabetically.

**Fixed** (`chartAggregation.ts`): Added `sortHeatmapLabels()` — a heatmap-local helper that detects all-numeric string labels (after the date check, so 4-digit years stay as dates) and sorts them numerically. Replaces `sortLabels()` calls in the `aggregateHeatmap` x/y label ordering paths. Test added in `chartAggregation.test.ts` asserting `['1','2','10','20']` not `['1','10','2','20']`.

✅ BL-210: Sort-by should show the field/axis labels, not just generic x/y. If sort is disabled, ascending/descending should be too.

**Fixed** (`ChartSetupPanel.tsx`): Computed `heatXFieldLabel`/`heatYFieldLabel` from `allFields`; the sort MenuItems now show the selected field's label, falling back to the locale token when no field is set. Added `disabled={!heatAxesSet}` to the asc/desc `ToggleButtonGroup` so direction controls are disabled when either axis field is unset.

✅ BL-211: LocalStorage state shouldn't override the URL parameter.

**Fixed** (`examples/x-studio/src/App.tsx`): Added `withPage()` helper that applies `urlPageId` to `activePageId` when a `?page=` param is present (no-op when absent). Applied to both return paths in the saved-state branch so the URL page always wins over localStorage.

✅ BL-212: Make the alert banner half the height.

**Fixed** (`examples/x-studio/src/components/AlertBannerWidget.tsx`): Reduced the in-flow sizer `minHeight` from 88 to 44.
