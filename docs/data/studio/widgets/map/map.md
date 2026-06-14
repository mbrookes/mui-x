---
title: Studio — Map widget
description: Display geographic data as a choropleth map with a configurable colour scale.
---

# Studio — Map widget

<p class="description">Display geographic data as a choropleth map with a configurable colour scale.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`StudioMapWidget` renders a choropleth map (`kind: 'map'`) from a Studio data source.
It groups rows by region, aggregates an optional numeric value per region, and fills each
region with a continuous colour scale.

The widget is built on the official MUI X premium Map from `@mui/x-charts-premium`: it
composes `ChartsGeoDataProviderPremium` with `GeoDataPlot` and `MapShapePlot`, a continuous
`colorMap` on the chart's `zAxis`, and a `ContinuousColorLegend`. Because it depends on
`@mui/x-charts-premium`, the map widget requires a **Premium** license. The provider is
currently an `Unstable_` API and may change between charts releases.

Three geographies ship out of the box, each with the appropriate d3 projection:

| `mapGeography` | Projection      | Feature IDs                                        |
| :------------- | :-------------- | :------------------------------------------------- |
| `'world'`      | `naturalEarth1` | ISO alpha-2 country codes (for example `US`, `FR`) |
| `'usa'`        | `albersUsa`     | US state postal abbreviations (for example `CA`)   |
| `'europe'`     | `mercator`      | ISO alpha-2 codes for European countries           |

Geography data is lazy-loaded, so the map renders nothing until the requested geography
resolves. Custom geographies can be registered via the `geographies` prop (see the
`useStudioGeographies` hook).

## Configuration

`mapCountryField` is required.
It can contain ISO alpha-2 codes, ISO alpha-3 codes, or full English country names.
Studio normalises these identifiers through `countryUtils` before matching them to map
features.

```ts
interface StudioWidgetConfig {
  mapCountryField?: string; // region identifier field
  mapCountrySourceId?: string; // source for country field (if from related source)
  mapValueField?: string; // numeric field to aggregate per region
  mapValueSourceId?: string; // source for value field (if from related source)
  mapAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  mapGeography?: 'world' | 'usa' | 'europe' | (string & {});
  mapColorScheme?: 'blues' | 'reds' | 'greens' | 'oranges' | 'purples';
  mapLegendZeroMin?: boolean;
  mapLegendPosition?: 'bottom' | 'top' | 'left' | 'right' | 'hidden';
}
```

| Property             | Description                                                                                               |
| :------------------- | :-------------------------------------------------------------------------------------------------------- |
| `mapCountryField`    | Region identifier field. Required.                                                                        |
| `mapCountrySourceId` | Source ID for the country field when it comes from a related source.                                      |
| `mapValueField`      | Numeric field to aggregate per region. Required unless `mapAggregation` is `'count'`.                     |
| `mapValueSourceId`   | Source ID for the value field when it comes from a related source.                                        |
| `mapAggregation`     | Aggregation applied per region: `'sum'`, `'count'`, `'avg'`, `'min'`, or `'max'`. Defaults to `'sum'`.    |
| `mapGeography`       | Which built-in map to render: `'world'`, `'usa'`, or `'europe'` (or a custom key). Defaults to `'world'`. |
| `mapColorScheme`     | Sequential ramp: `'blues'`, `'reds'`, `'greens'`, `'oranges'`, or `'purples'`. Defaults to `'blues'`.     |
| `mapLegendZeroMin`   | When `true`, clamp the colour-scale minimum to `0` instead of the lowest data value. Defaults to `false`. |
| `mapLegendPosition`  | Legend placement: `'bottom'` (default), `'top'`, `'left'`, `'right'`, or `'hidden'`.                      |

When `mapValueField` is omitted, set `mapAggregation: 'count'` to tally rows per region.

## Cross-source fields

The country field and value field can each come from a different related source.
Set `mapCountrySourceId` and `mapValueSourceId` when either field does not belong to the widget's primary `sourceId`.
Studio resolves the join path through the declared [relationships](/x/react-studio/data/relationships/).

## Colour scale and tooltip

The map ships with five sequential colour ramps, applied as a continuous `colorMap` across
the aggregated value range. Regions with no data use a neutral fill and show **no tooltip**
when hovered.

Hovering a region with data shows a tooltip with two rows:

- **Region name** — derived from the normalised feature identifier (for example, "France" or "California").
- **Value field label** — the name of the `mapValueField` formatted in Title Case, followed by the aggregated value.

## Full config example

```ts
const widget = {
  id: 'revenue-by-country',
  kind: 'map',
  title: 'Revenue by country',
  sourceId: 'orderItems',
  config: {
    mapCountryField: 'country',
    mapCountrySourceId: 'customers',
    mapValueField: 'revenue',
    mapValueSourceId: 'orders',
    mapAggregation: 'sum',
    mapColorScheme: 'greens',
  },
};
```

## Cross-filtering

:::warning
Click-to-cross-filter on a map region is **not yet available**. The underlying unstable
premium Map API does not forward a per-shape click, so a click on a region does not emit a
cross-filter to other widgets. The `mapCrossFilterEmit` config field exists but is
currently a no-op. The map can still respond to cross-filters emitted by other widgets.
:::

## Feature flag

Use `featureFlags.map` to hide the map widget from the widget picker.
The flag defaults to `true`.

```tsx
<Studio featureFlags={{ map: false }} />
```

## See also

- [Relationships](/x/react-studio/data/relationships/) — resolve country and value fields from related sources
- [Cross-filters](/x/react-studio/features/cross-filters/) — link widgets so they filter each other (note the map's current limitation above)
