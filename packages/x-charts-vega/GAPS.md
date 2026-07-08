# Vega-Lite → MUI X Charts: support matrix and gaps

This document tracks what the wrapper translates natively, what renders with a visible approximation, and what cannot be expressed with `@mui/x-charts` (MIT) components at all. Runtime code reports the same information per-spec through the `onGaps` prop as `TranslationGap` objects.

## Severity levels

- **✅ supported** — feature translates to native x-charts behavior.
- **🚧 in progress** — feature has a stub or partial implementation; work units are developing it.
- **⚠️ partial/approximated** — feature renders with a visible approximation or reduced functionality.
- **❌ unsupported (MIT)** — not available in `@mui/x-charts` (MIT), but covered by Pro or Premium tier (noted in remarks).
- **❌ unsupported (all tiers)** — no x-charts equivalent in any tier.

---

## Marks

All mark implementations are currently in progress (🚧). The bar, line, and point mark compilers are the primary work units, with arc and rule following.

| Vega-Lite mark           | Status                     | Notes                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bar`                    | 🚧 in progress             | → `bar` series + `BarPlot`. Vertical (band x, quantitative y) and horizontal (`layout: 'horizontal'`). Stacking: `stack: 'zero'` (default, stacked), `'normalize'` (normalized/100%), `'center'` (centered). Color-field splitting into series. Report gaps for x2/y2 (range bars) and corner radius.                                                  |
| `line`                   | 🚧 in progress             | → `line` series + `LinePlot`. Index-aligned to axis categories; null values create gaps. Color-field splitting. `mark.interpolate` mapping: 'monotone'→'monotoneX', 'step\*'→step variants, 'natural'→'natural', 'basis'→'bumpX' (where available). Point overlays via `mark.point`.                                                                   |
| `area`                   | 🚧 in progress             | → `line` series with `area: true` + `AreaPlot`. Stacking as per bar mark.                                                                                                                                                                                                                                                                              |
| `point` / `circle`       | 🚧 in progress             | → `scatter` series. Both positional channels quantitative/temporal → scatter data. One categorical channel → strip plot against axis. Color-field splitting. Report gap: marker shape ignored (circles/squares use default).                                                                                                                           |
| `square`                 | 🚧 in progress             | → `scatter` series. See `point`. Gap: marker shape (`square`) ignored; uses default circular markers.                                                                                                                                                                                                                                                  |
| `tick`                   | 🚧 in progress             | → `scatter` series approximation. Gap: renders as points, not ticks; shape not preserved.                                                                                                                                                                                                                                                              |
| `trail`                  | 🚧 in progress             | → `line` series approximation. Gap: varying width (`size` encoding on trail) unsupported.                                                                                                                                                                                                                                                              |
| `arc`                    | 🚧 in progress             | → `pie` series + `PiePlot`. `theta` (quantitative, often aggregated) → slice `value`; `color` field → slice `label`. `mark.innerRadius`/`outerRadius`/`padAngle`/`cornerRadius` → pie config. No cartesian axes. Gap: `theta2`/`radius` encodings and non-pie radial layouts unsupported. Text layers (labels) → gap pointing at arcLabel alternative. |
| `rule`                   | 🚧 in progress             | → `ChartsReferenceLine` (datum rules only). Only `y` (value or aggregated) → horizontal line; only `x` → vertical. Mark color/strokeDash → lineStyle. Gap: spanning rules (x→x2 segments per datum) unsupported.                                                                                                                                       |
| `rect`                   | ❌ unsupported (MIT)       | 2D heatmap cells need `Heatmap` from `@mui/x-charts-pro`.                                                                                                                                                                                                                                                                                              |
| `geoshape`               | ❌ unsupported (MIT)       | Geographic projections and shapes need the `Map` chart from `@mui/x-charts-premium`.                                                                                                                                                                                                                                                                   |
| `boxplot`                | ❌ unsupported (all tiers) | No x-charts equivalent; no boxplot/whisker primitives in any tier.                                                                                                                                                                                                                                                                                     |
| `errorbar` / `errorband` | ❌ unsupported (all tiers) | No x-charts error-envelope or error-bar primitives. Workaround: layer multiple rule marks once supported.                                                                                                                                                                                                                                              |
| `text`                   | ❌ unsupported (all tiers) | No free-text mark primitive. Only bar labels and arc labels exist in x-charts. For chart annotations, render text externally (e.g., SVG overlays).                                                                                                                                                                                                     |
| `image`                  | ❌ unsupported (all tiers) | No image-embedding mark in x-charts. Workaround: render images in a separate layer or overlay.                                                                                                                                                                                                                                                         |

---

## Encoding channels

Not all channels are utilized by all mark compilers; the table below lists what is _recognized_ by the wrapper and how it is handled. Mark-compiler implementation determines the final rendering.

| Channel                    | Status                     | Notes                                                                                                                                                                                                                                                                  |
| -------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x`                        | ✅ supported               | Positional. Band/point/time scale for categories; linear/log/pow/sqrt/symlog for quantitative.                                                                                                                                                                         |
| `y`                        | ✅ supported               | Positional. Same scale types as `x`.                                                                                                                                                                                                                                   |
| `x2`                       | ⚠️ partial                 | Range bars (start–end on x-axis). Recognized; implementation pending in bar mark compiler. Gap: not yet compiled.                                                                                                                                                      |
| `y2`                       | ⚠️ partial                 | Range bars (start–end on y-axis). Recognized; implementation pending in bar mark compiler. Gap: not yet compiled.                                                                                                                                                      |
| `xOffset` / `yOffset`      | 🚧 in progress             | Grouped/dodged bar positioning. Recognized; bar compiler will use to avoid stacking.                                                                                                                                                                                   |
| `color`                    | 🚧 in progress             | Ordinal (nominal/ordinal field) → one series per group value. Continuous (quantitative/temporal) → ⚠️ partial gap (x-charts only supports axis `colorMap` on some series types; rendered as single-series fallback). Static color via `value` def → applied to series. |
| `fill` / `stroke`          | 🚧 in progress             | Mapped to `color` channel (Vega shorthand). `stroke` may split series in some marks.                                                                                                                                                                                   |
| `opacity`                  | 🚧 in progress             | Recognized; static mark opacity supported; field-encoded opacity (per mark/series) has limited x-charts support.                                                                                                                                                       |
| `size`                     | ⚠️ partial                 | Recognized. Quantitative size field has no per-point size in MIT scatter (x-charts-pro may add `zAxis`-style sizeValue; do not rely on it). Static size via `value` def → applied.                                                                                     |
| `shape`                    | ❌ unsupported (all tiers) | X-charts scatter markers are uniform; shape encoding ignored. Gap: marker customization not supported.                                                                                                                                                                 |
| `angle`                    | ❌ unsupported (all tiers) | No text or custom-angled marks. Gap: angle encoding has no target.                                                                                                                                                                                                     |
| `theta` / `theta2`         | 🚧 in progress             | Pie/arc slices. `theta` → slice value; `theta2` → gap (unsupported; only `theta` used).                                                                                                                                                                                |
| `radius` / `radius2`       | 🚧 in progress             | Donut innerRadius/outerRadius. Recognized; arc compiler will apply. `radius2` → gap (only one radius per arc).                                                                                                                                                         |
| `detail`                   | ❌ unsupported (all tiers) | Grouping without visual encoding. X-charts has no equivalent. Gap: detail channel ignored.                                                                                                                                                                             |
| `order`                    | ⚠️ partial                 | Series/mark ordering recognized but may not sort series appearance. Gap: sorting not consistently applied.                                                                                                                                                             |
| `text`                     | ❌ unsupported (all tiers) | Free-form text marks unsupported (bar/arc labels only). Gap: text encoding ignored.                                                                                                                                                                                    |
| `tooltip`                  | ⚠️ partial                 | X-charts tooltip shows series/point values; custom tooltip content (e.g., formatted multi-field tooltips) has limited support. Encoded fields appear in default tooltip; custom formatting requires mark-level config (limited).                                       |
| `href`                     | ❌ unsupported (all tiers) | No click-to-link behavior in x-charts marks. Gap: href encoding ignored (workaround: use external click handlers).                                                                                                                                                     |
| `key`                      | ⚠️ ignored                 | Recognized but no x-charts equivalent (used for data identity in Vega-Lite selections). Ignored; data is matched by array index.                                                                                                                                       |
| `facet` / `row` / `column` | ❌ unsupported (all tiers) | Faceting not supported. Workaround: render one `<VegaLiteChart />` per facet group in your app.                                                                                                                                                                        |

---

## Data & transforms

### Data source

| Feature                                           | Status                     | Notes                                                                                                      |
| ------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Inline values (`data.values` as object array)     | ✅ supported               | Passed directly to mark compilers.                                                                         |
| Named datasets (`data.name` + `datasets` map)     | ✅ supported               | Resolved via the `datasets` prop or `spec.datasets` field.                                                 |
| URL loading (`data.url`)                          | ❌ unsupported (all tiers) | No HTTP fetching in the wrapper. Workaround: fetch data yourself and pass via `data` prop or `datasets`.   |
| String payloads (`data.values` as CSV/TSV string) | ❌ unsupported (all tiers) | String parsing not implemented. Workaround: parse to JSON array and pass via `data.values` or `data` prop. |
| `data.format` (CSV parsing, delimiter, etc.)      | ⚠️ ignored                 | Format hints recognized but not applied (data must be pre-parsed).                                         |

### Transforms

Transforms are applied sequentially in order. Unrecognized transforms are skipped with a gap.

| Transform       | Status                     | Notes                                                                                                                                                                                             |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aggregate`     | ✅ supported               | Full group-by aggregation with all ops (count, sum, mean, min, max, q1/q3/median, stdev, variance, etc.). Produces grouped rows.                                                                  |
| `fold`          | ✅ supported               | Pivots columns to rows (key–value pairs). `fold.as` defaults to `['key', 'value']`.                                                                                                               |
| `filter`        | 🚧 in progress             | Stub in place; reports gap. Planned: field predicates (`{field, equal/lt/lte/gt/gte/range/oneOf/valid}`) and logical composers (and/or/not). Vega expression strings blocked (eval() never used). |
| `calculate`     | 🚧 in progress             | Stub in place; reports gap. Planned: safe mini-evaluator for common Vega expressions (datum.field access, arithmetic, string concat, comparisons, ternary). Never uses eval().                    |
| `bin`           | 🚧 in progress             | Stub in place; reports gap. Planned: d3-style nice binning (maxbins/step/extent) outputting `as` (bin start) and `as_end` columns.                                                                |
| `timeUnit`      | 🚧 in progress             | Stub in place; reports gap. Planned: calendar truncation (year, yearmonth, month, date, day, hours, minutes, seconds, etc.) into `as` field.                                                      |
| `window`        | ❌ unsupported (all tiers) | No x-charts primitive for window functions (rank, row_number, lag, lead, etc.). Workaround: apply window logic in preprocessing.                                                                  |
| `joinaggregate` | ❌ unsupported (all tiers) | Window aggregation (e.g., mean across all groups) has no x-charts equivalent. Workaround: aggregate in preprocessing.                                                                             |
| `stack`         | ❌ unsupported (all tiers) | Explicit stacking transform not needed; x-charts bar/line infer `stack` from encoding. Use encoding `stack` property instead.                                                                     |
| `lookup`        | ❌ unsupported (all tiers) | Table join/lookup has no x-charts equivalent. Workaround: join data before passing to wrapper.                                                                                                    |
| `pivot`         | ❌ unsupported (all tiers) | Column pivoting has no x-charts equivalent. Workaround: use `fold` or pivot data in preprocessing.                                                                                                |
| `density`       | ❌ unsupported (all tiers) | Probability-density estimation has no x-charts equivalent. Workaround: compute density externally.                                                                                                |
| `regression`    | ❌ unsupported (all tiers) | Regression-line fitting has no x-charts equivalent. Workaround: compute fit line externally and render as rule/line.                                                                              |
| `loess`         | ❌ unsupported (all tiers) | LOESS smoothing has no x-charts equivalent. Workaround: smooth data in preprocessing.                                                                                                             |
| `impute`        | ❌ unsupported (all tiers) | Missing-value imputation has no x-charts equivalent. Workaround: impute before passing data.                                                                                                      |
| `flatten`       | ❌ unsupported (all tiers) | Nested array flattening has no x-charts equivalent. Workaround: flatten before passing.                                                                                                           |
| `sample`        | ❌ unsupported (all tiers) | Stochastic row sampling has no x-charts equivalent. Workaround: sample before passing.                                                                                                            |
| `quantile`      | ❌ unsupported (all tiers) | Quantile computation has no x-charts equivalent. Workaround: compute quantiles in preprocessing.                                                                                                  |

---

## Scales & axes

### Scale types

X-charts supports the following scale types on positional channels (x/y). Temporal data approximated as discrete point scale.

| Scale type                                           | Status                     | Notes                                                                                                                                      |
| ---------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `linear`                                             | ✅ supported               | Default for quantitative axes.                                                                                                             |
| `log`                                                | ✅ supported               | Logarithmic scale.                                                                                                                         |
| `pow`                                                | ✅ supported               | Power scale; `exponent` parameter supported.                                                                                               |
| `sqrt`                                               | ✅ supported               | Square-root scale.                                                                                                                         |
| `symlog`                                             | ✅ supported               | Symmetric log scale (x-charts native).                                                                                                     |
| `time` / `utc`                                       | ✅ supported               | Temporal scales. Approximated as discrete point scale over sorted date domain; x-charts-pro/premium may upgrade to quantitative time axis. |
| `band`                                               | ✅ supported               | Categorical with inner/outer padding. Used for bar marks by default.                                                                       |
| `point`                                              | ✅ supported               | Categorical without padding. Used for non-bar marks by default.                                                                            |
| `ordinal`                                            | ⚠️ partial                 | Treated as `point` scale (no built-in ordering). Gap: custom domain order may not sort as expected.                                        |
| Unsupported types (e.g., `sequential`, custom names) | ❌ unsupported (all tiers) | Unknown scale types fall back to `linear`. Gap: unrecognized type reported.                                                                |

### Scale properties

| Property                        | Status       | Notes                                                                                                                                                                                           |
| ------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain`                        | ✅ supported | For quantitative: `[min, max]` → axis `min`/`max`. For categorical: auto-collected from data in order seen. Array domain on categorical axis possible but order may not persist across renders. |
| `range`                         | ⚠️ ignored   | x-charts range is theme-driven; spec range ignored. Gap: custom color ranges require hand-patching colorMap or series config.                                                                   |
| `scheme`                        | ⚠️ ignored   | Color scheme hints (e.g., 'viridis', 'reds') recognized but not applied; x-charts uses theme colors. Gap: custom scheme requires colorMap config.                                               |
| `zero`                          | ⚠️ ignored   | `zero: true` (force axis to include zero) recognized but may not always apply. Gap: axis zero behavior depends on x-charts axis config.                                                         |
| `nice`                          | ⚠️ ignored   | Nice axis scaling recognized but not applied. Gap: tick rounding delegated to x-charts.                                                                                                         |
| `reverse`                       | ✅ supported | Axis direction reversed if `scale.reverse === true`.                                                                                                                                            |
| `padding`                       | ⚠️ partial   | Band scale inner/outer padding recognized; may not match Vega-Lite padding semantics exactly.                                                                                                   |
| `paddingInner` / `paddingOuter` | ⚠️ partial   | Band scale padding parameters recognized; behavior approximated.                                                                                                                                |

### Axis configuration

| Axis feature | Status       | Notes                                                                                                                                    |
| ------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `title`      | ✅ supported | Explicit `axis.title` or auto-derived from field name (e.g., "COUNT of Sales").                                                          |
| `labels`     | ✅ supported | Axis tick labels shown.                                                                                                                  |
| `ticks`      | ✅ supported | Tick marks rendered.                                                                                                                     |
| `grid`       | ✅ supported | Grid lines via `axis.grid: true`. Vertical for x-axis, horizontal for y-axis.                                                            |
| `orient`     | ⚠️ partial   | Recognized (`top`, `bottom`, `left`, `right`); x-charts positioning may override based on chart type.                                    |
| `format`     | ⚠️ partial   | Number/date format strings recognized; x-charts applies basic formatting (`.toLocaleDateString()` for dates). Custom formatters limited. |
| `tickCount`  | ⚠️ partial   | Approximate tick count hint; x-charts determines final count.                                                                            |
| `values`     | ⚠️ partial   | Custom tick values recognized but may not all appear due to x-charts axis logic.                                                         |
| `labelAngle` | ⚠️ partial   | Label rotation recognized; x-charts may override for readability.                                                                        |
| `domain`     | ⚠️ partial   | Show/hide axis `domain: false` recognized but behavior approximated.                                                                     |
| `disable`    | ⚠️ ignored   | Axis disable hints recognized but axis always rendered (remove from encoding to hide).                                                   |

---

## Projections & geographic

| Feature                                  | Status               | Notes                                                                                                                      |
| ---------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| All projections (mercator, albers, etc.) | ❌ unsupported (MIT) | Geographic projections need `@mui/x-charts-premium` `Map` chart. Gap: projection config ignored; geojson data has no sink. |
| `geojson` field type                     | ❌ unsupported (MIT) | GeoJSON parsing and rendering need premium Map. Gap: geojson fields reported as unsupported.                               |
| `geoshape` mark                          | ❌ unsupported (MIT) | See Marks section. Rendered as gap.                                                                                        |

---

## View composition & layering

| Feature                          | Status                     | Notes                                                                                                                                                                                                                                                                         |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layer`                          | ✅ supported               | Multiple unit specs with shared or independent scales. All layers normalized into flat unit array; encoding and transforms inherited from parent. `resolve.scale` / `resolve.axis` recognized (shared vs. independent). Rendered as overlapping marks/series in single chart. |
| `facet`                          | ❌ unsupported (all tiers) | Facet composition (rows/columns by field) not supported. Gap: faceted spec detected and reported. Workaround: split data in app and render one `<VegaLiteChart />` per facet.                                                                                                 |
| `repeat`                         | ❌ unsupported (all tiers) | Repeated specs (same mark over different fields) not supported. Gap: reported. Workaround: render multiple charts in app.                                                                                                                                                     |
| `hconcat` / `vconcat` / `concat` | ❌ unsupported (all tiers) | Horizontal/vertical/wrapped concatenation not supported. Gap: reported. Workaround: render multiple charts in app.                                                                                                                                                            |
| `resolve.scale`                  | ✅ supported (partial)     | `shared` (default) vs. `independent` recognized. Shared scales merge domain across layers; independent scales fork. Behavior approximated.                                                                                                                                    |
| `resolve.axis`                   | ⚠️ partial                 | Axis independence recognized but may have limited effect (x-charts typically shares axes for overlay layers).                                                                                                                                                                 |
| `resolve.legend`                 | ⚠️ partial                 | Legend merging/splitting recognized but not fully applied; legends rendered per series config.                                                                                                                                                                                |

---

## Interactivity & selections

| Feature                          | Status                     | Notes                                                                                                                                                                                                                                                      |
| -------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `params` / selections            | ❌ unsupported (all tiers) | Vega-Lite selections (dynamic filtering, linked brushing) have no x-charts equivalent. Gap: selection config ignored. Workaround: implement brush/filter logic in app state.                                                                               |
| `bind` (inputs, scales, legends) | ❌ unsupported (all tiers) | Data binding to selections/widgets not supported. Gap: bind config ignored. Workaround: use React state and re-render.                                                                                                                                     |
| Zoom & pan                       | ❌ unsupported (MIT)       | Vega-Lite zoom/pan not directly supported. X-charts-pro has `ChartZoomSlider` for chart zoom, but it does not implement Vega-Lite selection semantics. Gap: zoom/pan config ignored. Workaround: use ChartZoomSlider or custom zoom in app.                |
| Drag & brush                     | ❌ unsupported (all tiers) | Brush/drag selection has no x-charts primitive. Gap: ignored. Workaround: implement with React mouse events.                                                                                                                                               |
| Tooltips (data encoding)         | ⚠️ partial                 | `tooltip` encoding recognized. X-charts renders default tooltip showing series name and value. Custom multi-field tooltips have limited support (requires mark-level `mark.tooltip` config). Gap: custom tooltip content via encoding not fully supported. |
| Href (click)                     | ❌ unsupported (all tiers) | `href` encoding ignored; x-charts marks do not navigate on click. Workaround: use external click handlers on chart container.                                                                                                                              |
| Context menu                     | ❌ unsupported (all tiers) | Right-click interactions not supported. Workaround: implement custom event handlers.                                                                                                                                                                       |

---

## Config & theming

| Feature                      | Status                     | Notes                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec-level `config` blocks   | ⚠️ ignored                 | X-charts does not parse Vega-Lite config (e.g., `config.mark`, `config.axis`, `config.legend`). MUI theme is applied instead. Gap: Vega-Lite style config overridden by MUI. Workaround: customize MUI theme or mark-level properties. |
| Mark-level properties        | 🚧 in progress             | `color`, `fill`, `stroke`, `opacity`, `strokeWidth`, `strokeDash` recognized and applied where mark compilers support them.                                                                                                            |
| Axis config (via encoding)   | ✅ supported               | `encoding.x.axis` / `encoding.y.axis` config applied to axes.                                                                                                                                                                          |
| Legend config (via encoding) | ⚠️ partial                 | `encoding.color.legend` recognized; legends rendered per x-charts config (title/orient may be approximated).                                                                                                                           |
| Background & padding         | ⚠️ ignored                 | Spec-level `background`/`padding` hints recognized but not applied. Gap: chart background and padding depend on container and x-charts defaults.                                                                                       |
| Autosize                     | ⚠️ ignored                 | `autosize` hint recognized; x-charts charts are typically responsive. Gap: "fit" behavior approximated.                                                                                                                                |
| Font config                  | ❌ unsupported (all tiers) | Font specs ignored; x-charts applies MUI theme fonts.                                                                                                                                                                                  |
| Renderer (SVG vs. Canvas)    | ⚠️ ignored                 | Vega-Lite renderer hint ignored; x-charts uses SVG.                                                                                                                                                                                    |

---

## Full Vega (non-Lite) specs

| Feature                                                | Status                     | Notes                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vega signals/reactive operators                        | ❌ unsupported (all tiers) | Full Vega reactive model entirely out of scope. Signals, scales, axes, and marks are defined in an imperative/reactive grammar not expressible as x-charts series config. Gap: entire Vega spec rejected. Workaround: transpile Vega to Vega-Lite subset manually or use full Vega runtime (vega-embed). |
| Vega data operators (e.g., cross, sequence, graticule) | ❌ unsupported (all tiers) | Vega-specific data generators have no x-charts equivalent. Workaround: generate data in preprocessing.                                                                                                                                                                                                   |
| Vega marks (polygon, path, etc.)                       | ❌ unsupported (all tiers) | Vega's lower-level mark types not supported; only Vega-Lite marks mapped. Workaround: use SVG overlays.                                                                                                                                                                                                  |

---

## How gaps are reported at runtime

When the wrapper encounters untranslatable Vega-Lite features, it collects them as `TranslationGap` objects and returns them via the `onGaps` prop. Each gap has a `code` (e.g., `mark:geoshape`, `encoding:facet`), a human-readable `message` (often including workarounds and tier pointers), a `severity` (unsupported/partial/ignored), and optionally a `path` into the input spec (e.g., `layer[0].encoding.color`).

Example usage:

```tsx
import { VegaLiteChart } from '@mui/x-charts-vega';

const spec = {
  mark: 'geoshape',
  // ...
};

const [gaps, setGaps] = useState([]);

<VegaLiteChart spec={spec} onGaps={setGaps} />;

// gaps[0].code === 'mark:geoshape'
// gaps[0].message === "geoshape needs the Map chart from @mui/x-charts-premium."
// gaps[0].severity === 'unsupported'
```

Render gaps as warnings in your UI, or use them to fall back to a different visualization. The wrapper always attempts a best-effort render even when gaps are present.
