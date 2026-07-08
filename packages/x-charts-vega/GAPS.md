# Vega-Lite → MUI X Charts: support matrix and gaps

This document tracks what the wrapper translates natively, what renders as an
approximation, and what cannot be expressed with `@mui/x-charts` (MIT)
components at all. Runtime code reports the same information per-spec through
the `onGaps` prop as `TranslationGap` objects.

Severities:

- **unsupported** — dropped entirely.
- **partial** — rendered with a visible approximation.
- **ignored** — recognized but has no x-charts equivalent; rendering proceeds.

## Marks

| Vega-Lite mark | Status | Notes |
| -------------- | ------ | ----- |
| `bar` | pending implementation | → `bar` series + `BarPlot` |
| `line` | pending implementation | → `line` series + `LinePlot` |
| `area` | pending implementation | → `line` series with `area: true` + `AreaPlot` |
| `point` / `circle` / `square` | pending implementation | → `scatter` series; marker shape ignored |
| `tick` | pending implementation | → `scatter` approximation (partial) |
| `trail` | pending implementation | → `line` approximation; varying width unsupported |
| `arc` | pending implementation | → `pie` series + `PiePlot` |
| `rule` | pending implementation | → `ChartsReferenceLine` (datum rules only) |
| `rect` | **unsupported (MIT)** | 2D heatmap cells need `Heatmap` from `@mui/x-charts-pro` |
| `geoshape` | **unsupported (MIT)** | needs the `Map` chart from `@mui/x-charts-premium` |
| `boxplot` | **unsupported** | no x-charts equivalent in any tier |
| `errorbar` / `errorband` | **unsupported** | no x-charts primitive |
| `text` | **unsupported** | no free-text mark primitive (only bar/arc labels) |
| `image` | **unsupported** | no equivalent |

## To be filled in by the implementation work units

Each work unit appends its findings here (encodings, transforms, scales,
composition, interaction). The final compiled list lives at the bottom of
this file after integration.
