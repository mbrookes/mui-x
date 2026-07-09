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
 */
export function ArcLabelsPlot() {
  // Stub — implemented by the text/image marks work unit.
  return null;
}
