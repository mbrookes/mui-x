/**
 * Dashboard-wide categorical palette, passed to `<Studio chartColors={...} />` and so
 * shared by every chart widget on the page.
 *
 * It exists because Studio's default palette (`blueberryTwilightPalette`) has only 6
 * colors and cycles them — with the 12 series on the Charting Library Adoption chart,
 * series 7-12 rendered in colors identical to series 1-6.
 *
 * Colors are assigned in array order to a chart's series, and Studio lists series
 * alphabetically by label (`sortLabels` in
 * `packages/x-studio/src/internals/temporalUtils.ts`). Each chart therefore consumes a
 * contiguous prefix of this array, in the alphabetical order of its own series:
 *
 *   - Charting Library Adoption — all 12 slots
 *   - Data Grid Library Adoption (and its by-week history chart) — the first 10
 *
 * The first 8 hues/steps are the MUI dataviz skill's reference categorical palette
 * (`references/palette.md`) verbatim; the last 4 (teal, brown, rose, olive) were devised
 * and validated the same way. Both modes, at both the 10- and 12-slot lengths, pass every
 * hard gate in `scripts/validate_palette.js` on the adjacent-pair check (both charts are
 * 100%-stacked bars, so only adjacent series need to clear CVD/normal-vision separation).
 * Two WARNs are expected, both in the legal band and mitigated by the secondary encoding
 * these charts already carry — a legend naming every series, plus the gaps between
 * stacked segments:
 *   - light: 3 slots sit below 3:1 contrast against the light surface.
 *   - dark: one adjacent pair lands in the 6-8 CVD floor band.
 *
 * When adding a library to either matrix in `src/server/githubLibraryUsage.ts`, re-run the
 * validator — a new label can re-sort the series and change which colors end up adjacent.
 */
export const CHART_PALETTE: { light: string[]; dark: string[] } = {
  light: [
    '#2a78d6', // blue
    '#eb6834', // orange
    '#1baf7a', // aqua
    '#eda100', // yellow
    '#e87ba4', // magenta
    '#008300', // green
    '#4a3aa7', // violet
    '#e34948', // red
    '#00968f', // teal
    '#a6742c', // brown
    '#c2185b', // rose
    '#7c8c00', // olive
  ],
  dark: [
    '#3987e5', // blue
    '#d95926', // orange
    '#199e70', // aqua
    '#c98500', // yellow
    '#d55181', // magenta
    '#008300', // green
    '#9085e9', // violet
    '#e66767', // red
    '#0f9a93', // teal
    '#ad7b34', // brown
    '#db376f', // rose
    '#80900d', // olive
  ],
};
