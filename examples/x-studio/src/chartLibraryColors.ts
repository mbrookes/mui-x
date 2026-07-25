/**
 * Fixed categorical palette overriding Studio's 6-color default
 * (`blueberryTwilightPalette`), which cycles and duplicates colors once a
 * chart has more series than it has hues — the Charting Library Adoption
 * chart has 12. Colors are assigned in array order to a chart's series,
 * which Studio always lists alphabetically by label (see
 * `packages/x-studio/src/internals/temporalUtils.ts`'s `sortLabels`), so
 * this array's order matches the alphabetical order of `CHART_LIBRARIES`'
 * labels in `src/server/githubLibraryUsage.ts`:
 *
 *   amCharts, Ant Design Charts, ApexCharts, Chart.js, ECharts, Highcharts,
 *   MUI X Charts, Nivo, Plotly, Recharts, Victory, visx
 *
 * The first 8 hues/steps are the MUI dataviz skill's reference categorical
 * palette (`references/palette.md`) verbatim; the last 4 (teal, brown, rose,
 * olive) were devised and validated the same way for this 12-series chart.
 * Both modes pass every hard gate in `scripts/validate_palette.js` on the
 * adjacent-pair check (this chart is a 100%-stacked bar, so only adjacent
 * series need to clear CVD/normal-vision separation) — see the two WARNs
 * below, both legal and mitigated by the chart's legend + stacked-segment
 * gaps:
 *   - light: 3 slots (ApexCharts, Chart.js, ECharts) sit below 3:1 contrast
 *     against the light surface — relief channel is the legend.
 *   - dark: Victory↔Recharts adjacent CVD ΔE 7.0 (deutan), in the legal 6-8
 *     floor band.
 */
export const CHART_LIBRARY_COLORS: { light: string[]; dark: string[] } = {
  light: [
    '#2a78d6', // amCharts — blue
    '#eb6834', // Ant Design Charts — orange
    '#1baf7a', // ApexCharts — aqua
    '#eda100', // Chart.js — yellow
    '#e87ba4', // ECharts — magenta
    '#008300', // Highcharts — green
    '#4a3aa7', // MUI X Charts — violet
    '#e34948', // Nivo — red
    '#00968f', // Plotly — teal
    '#a6742c', // Recharts — brown
    '#c2185b', // Victory — rose
    '#7c8c00', // visx — olive
  ],
  dark: [
    '#3987e5', // amCharts — blue
    '#d95926', // Ant Design Charts — orange
    '#199e70', // ApexCharts — aqua
    '#c98500', // Chart.js — yellow
    '#d55181', // ECharts — magenta
    '#008300', // Highcharts — green
    '#9085e9', // MUI X Charts — violet
    '#e66767', // Nivo — red
    '#0f9a93', // Plotly — teal
    '#ad7b34', // Recharts — brown
    '#db376f', // Victory — rose
    '#80900d', // visx — olive
  ],
};
