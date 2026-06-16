
✅ BL-206: Mixed (bar+line) charts — line series invisible. "Revenue & Avg Discount by Category" and "Revenue vs Inventory Stock by Category (blended sources)" showed only bars; the line overlay was not visible.

**Root cause**: `StudioChartWidget.tsx` used `yAxisKey` when building `mixedSeries` objects, but the MUI X Charts API property is `yAxisId`. With `dualYAxis: true`, the unrecognized `yAxisKey` was silently ignored, so every series fell back to the first (left) y-axis. Bar values (revenue, millions) dominated the scale; line values (discount %, stock counts) were compressed to near-zero and invisible.

**Fixed** (`StudioChartWidget.tsx`): renamed `yAxisKey` → `yAxisId` in both the `line` and `bar` branches of the `mixedSeries.map()` block. Line series now correctly bind to `'right'` and bars to `'left'` when dual-axis is enabled.

BL-207: Make the heatmap widget legend the same size as the map's.

BL-208: Heatmap doesn't have a control to set the Y axis.