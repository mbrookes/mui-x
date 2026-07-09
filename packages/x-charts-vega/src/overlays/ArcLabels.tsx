'use client';

/*
 * OWNERSHIP: the "text/image marks" work unit owns this file.
 *
 * Render in-slice labels for pie series when the arc mark carries a `text`
 * encoding. `PieArcLabelPlot` (from '@mui/x-charts/PieChart') takes
 * per-series props (seriesId, data, outerRadius, ...) — read the processed
 * pie series from context via the public `usePieSeries()` hook (from
 * '@mui/x-charts/hooks') and render one `PieArcLabelPlot` per series whose
 * `arcLabel` is set, mirroring how `PieChart.tsx` itself composes them.
 *
 * Verified against `packages/x-charts/src/PieChart/PiePlot.tsx`: the shell
 * already renders `<PiePlot />` whenever `compiled.plots` includes `'pie'`
 * (true for every arc-mark chart, see `marks/arc.ts`), and `PiePlot`
 * *unconditionally* composes a `PieArcLabelPlot` per series —
 * `arcLabel={series[seriesId].arcLabel}` — reading its center/radii from the
 * (internal, not publicly exported) `usePieSeriesLayout()` hook. So the
 * moment `marks/arc.ts` sets a pie series' `arcLabel`, `<PiePlot />` renders
 * the in-slice labels correctly (and with better multi-series/percentage
 * layout support than this package could reimplement from public hooks
 * alone — `usePieSeriesLayout` isn't exported from '@mui/x-charts/hooks').
 *
 * A separate `ArcLabelsPlot` render was tried here (rebuilding the
 * center/radius layout math from the public `useDrawingArea()` +
 * `usePieSeries()` hooks) and confirmed *empirically* (via a render test
 * counting `.MuiPieChart-arcLabel` nodes) to double the labels: `<PiePlot />`
 * already renders one `PieArcLabel` per slice, so a second component doing
 * the same work renders every label twice. Since the feature is already
 * fully handled by the existing `<PiePlot />` render with zero extra wiring,
 * this component is intentionally a no-op — see `marks/arc.ts` for the
 * `arcLabel` translation, which is the actual work for this feature.
 */
export function ArcLabelsPlot() {
  return null;
}
