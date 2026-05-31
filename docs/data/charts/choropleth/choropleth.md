---
title: React Choropleth chart
productId: x-charts
components: ChoroplethChart, ChoroplethPlot, ChoroplethFeaturePath, ChoroplethTooltipContent
---

# Charts - Choropleth [<span class="plan-pro"></span>](/x/introduction/licensing/#pro-plan 'Pro plan')

<p class="description">Use choropleth charts to visualize data across geographic regions with filled, color-coded areas.</p>

## Overview

A choropleth chart maps numeric values onto geographic features by filling each region with a color derived from a color scale.
Use them to show spatial distributions such as population density, sales by region, or risk scores by country.

{{"demo": "BasicChoropleth.js", "disableAd": true, "defaultCodeOpen": false}}

## Basics

### Geographic data

The `geography` prop accepts a GeoJSON `FeatureCollection`.
For real-world maps, load data from packages like [`world-atlas`](https://github.com/topojson/world-atlas) or [`us-atlas`](https://github.com/topojson/us-atlas) and convert their TopoJSON to GeoJSON using `topojson-client`:

```tsx
import { feature } from 'topojson-client';
import worldAtlas from 'world-atlas/countries-110m.json';

const world = feature(worldAtlas, worldAtlas.objects.countries);

<ChoroplethChart geography={world} series={[{ data }]} />;
```

### Series data

Pass data as an array of `{ featureId, value }` objects in the `series` prop.
The `featureId` must match the `id` property of a GeoJSON feature by default:

```tsx
<ChoroplethChart
  geography={world}
  series={[
    {
      data: [
        { featureId: '840', value: 82 }, // US numeric code
        { featureId: '124', value: 65 }, // CA numeric code
      ],
    },
  ]}
/>
```

To match against a feature property instead of `feature.id`, set `featureIdKey`:

```tsx
series={[{ data, featureIdKey: 'iso_a3' }]}
```

{{"demo": "BasicChoropleth.js"}}

### Missing data

Features with no matching data entry are rendered with a transparent fill.
This lets you clearly distinguish regions with data from those without.

{{"demo": "ChoroplethMissingData.js"}}

## Color mapping

Use the `zAxis` configuration to control how values map to colors.
The `colorMap` property accepts the same configuration as the [Heatmap](/x/react-charts/heatmap/) and supports continuous, piecewise, and ordinal scales.
See [Styling—Value-based colors](/x/react-charts/styling/#value-based-colors) for full options.

### Continuous scale

```tsx
zAxis={[{
  colorMap: {
    type: 'continuous',
    min: 0,
    max: 100,
    color: ['#ffffb2', '#b10026'],
  },
}]}
```

### Piecewise scale

{{"demo": "PiecewiseChoropleth.js"}}

## Projection

The `projection` prop configures the D3-geo projection used to render the map.
The default is `geoMercator`.

```tsx
<ChoroplethChart
  projection={{ type: 'geoNaturalEarth1' }}
  geography={world}
  series={[{ data }]}
/>
```

Available projections:

- `geoMercator` (default)
- `geoNaturalEarth1`
- `geoAlbers`
- `geoAlbersUsa`
- `geoOrthographic`
- `geoEqualEarth`
- `geoEquirectangular`

Set `fitProjection={false}` to disable automatic fitting. You can then pass `scale`, `center`, and `rotate` on the `projection` config.

## Click events

Use `onItemClick` to handle clicks on map regions.

The handler receives the click event and an item identifier with `type`, `seriesId`, and `featureId`.

{{"demo": "ChoroplethClick.js"}}

## Shared features

Choropleth charts share tooltip, legend, and overlay behavior with other MUI X charts.

### Tooltip

The tooltip shows the feature ID, series label, and formatted value by default.
Customize the tooltip content with the `tooltip` slot.

### Legend

A [`ContinuousColorLegend`](/x/react-charts/legend/#color-legend) is shown by default.
Set `hideLegend` to `true` to hide it, or customize it with `slots.legend` and `slotProps.legend`.

### No data overlay

When `series` is empty, the chart shows "No data to display".
Set `loading` to show a loading overlay instead.

## API

See the documentation below for a complete reference to all the props available to the components mentioned here.

- [`<ChoroplethChart />`](/x/api/charts/choropleth-chart/)
- [`<ChoroplethPlot />`](/x/api/charts/choropleth-plot/)
