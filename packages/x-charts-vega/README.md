# @mui/x-charts-vega (experimental)

An experimental, unpublished wrapper that accepts a [Vega-Lite](https://vega.github.io/vega-lite/)
specification plus data and renders it with `@mui/x-charts` subcomponents
(`ChartsDataProvider`, plot components, axes, legend, tooltip).

```tsx
import { VegaLiteChart } from '@mui/x-charts-vega';

<VegaLiteChart
  width={600}
  height={400}
  spec={{
    data: { values: rows },
    mark: 'bar',
    encoding: {
      x: { field: 'category', type: 'nominal' },
      y: { field: 'amount', aggregate: 'sum' },
      color: { field: 'group', type: 'nominal' },
    },
  }}
  onGaps={(gaps) => console.table(gaps)}
/>;
```

## Design

The pipeline is pure until the final render:

1. **normalize** (`src/normalize`) — flattens `layer` compositions, merges
   inherited encodings/transforms, resolves data sources into rows.
2. **transforms** (`src/transforms`) — applies the top-level `transform`
   array, then encoding-level (inline) `aggregate`/`bin`/`timeUnit`.
3. **scales** (`src/compile/scales.ts`) — resolves shared x/y axis configs
   (`scaleType`, domain categories, min/max) across all layers.
4. **marks** (`src/marks`) — a registry dispatches each layer's mark type to
   a compiler that emits x-charts `series` objects plus the list of plot
   subcomponents needed (`BarPlot`, `LinePlot`, `ScatterPlot`, ...).
5. **shell** (`src/VegaLiteChart`) — renders the compiled result with the
   x-charts composition API.

`compileSpec(spec, options)` exposes steps 1–4 as a pure function for tests
and host introspection.

## Custom components

Several Vega-Lite marks and features have no `@mui/x-charts` series equivalent.
Rather than patch new series into the shipping charts packages, the wrapper
renders them with **custom components that compose the public x-charts APIs** —
the same extension pattern as `ChartsReferenceLine` (see `AGENTS.md`, BL-182).
There are two groups: the SVG overlay pipeline, and a few shell widgets.

### The overlay pipeline (`src/overlays`)

Marks with no series counterpart compile to a `CompiledOverlay` — a discriminated
union of **data-space** drawing instructions (`src/compile/context.ts`). The shell
renders a single `<VegaOverlays>` as an SVG child _inside_ `ChartsSurface`, after
the plot components. Each per-kind renderer converts data values to pixels through
the public `useXScale()` / `useYScale()` hooks (via the `scalePosition` /
`scaleBandwidth` helpers in `scaleUtils.ts`), so overlays stay aligned with the
axes x-charts already laid out — no internal APIs, no second coordinate system.

| Overlay kind | Renderer (`src/overlays/`) | Serves                                                                                         | Root class                  |
| :----------- | :------------------------- | :--------------------------------------------------------------------------------------------- | :-------------------------- |
| `segments`   | `Segments.tsx`             | `rule` span/tick marks, `tick` marks, and continuous-x `line`/`trail` polylines                | `.MuiVegaOverlay-segments`  |
| `boxes`      | `BoxPlot.tsx`              | `boxplot` mark (quartile box, median, whiskers, outliers; dodged by `groupIndex`/`groupCount`) | `.MuiVegaOverlay-boxes`     |
| `errorBars`  | `ErrorBars.tsx`            | `errorbar` mark (whisker + caps + center tick; dodged color groups)                            | `.MuiVegaOverlay-errorBars` |
| `band`       | `ErrorBars.tsx`            | `errorband` mark and continuous-x `area` fills (closed upper/lower path)                       | `.MuiVegaOverlay-band`      |
| `text`       | `TextMarks.tsx`            | `text` mark (per-row SVG labels with align/baseline/offsets)                                   | `.MuiVegaOverlay-text`      |
| `image`      | `TextMarks.tsx`            | `image` mark (`<image href>` per row)                                                          | `.MuiVegaOverlay-image`     |

`ArcLabels.tsx` is the exception: in-slice pie labels are delegated to x-charts'
own `PieArcLabelPlot` (composed automatically by `<PiePlot>` once `marks/arc.ts`
sets a series' `arcLabel`), because its multi-series/percentage layout relies on a
hook x-charts doesn't export — so reimplementing it from public hooks would be worse.

`scaleUtils.ts` holds the shared scale helpers every renderer uses: `scalePosition`
(a categorical band center or a continuous value → pixels, `null` when off-scale)
and `scaleBandwidth` (a band scale's category width, `0` for continuous scales,
which drives dodge-slot math and fallbacks).

### Shell widgets (`src/VegaLiteChart`)

- **`OverlayLegend.tsx`** — a minimal swatch+label legend for color-split overlays
  (dodged box plots / error bars) that carry no x-charts series to feed the native
  `<ChartsLegend>`. Fed from `CompiledChart.overlayLegend`; class `.MuiVegaOverlayLegend-root`.
- **`ParamInputs.tsx`** — a controlled toolbar of bound-param input widgets
  (`range`/`select`/`checkbox`/`radio`) rendered above the chart; changing one
  re-threads the live signal value through `compileSpec` so calculate/filter/test
  expressions see it.
- **`VegaTooltip.tsx`** — a custom `ChartsTooltip` content component that surfaces
  the `encoding.tooltip` field list (encoded x/y/color values resolve; other fields
  show as labels, since the shell isn't handed the raw rows).

## Incompleteness is a feature

This wrapper is deliberately best-effort: any Vega-Lite feature it cannot
translate is reported as a `TranslationGap` (via the `onGaps` prop and a
dev-mode console warning) instead of failing the render. See [GAPS.md](./GAPS.md)
for the full support matrix and the rationale for each gap.
