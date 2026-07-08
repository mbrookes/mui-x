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

## Incompleteness is a feature

This wrapper is deliberately best-effort: any Vega-Lite feature it cannot
translate is reported as a `TranslationGap` (via the `onGaps` prop and a
dev-mode console warning) instead of failing the render. See [GAPS.md](./GAPS.md)
for the full support matrix and the rationale for each gap.
