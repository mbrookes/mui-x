---
title: Studio — Map widget
description: Display geographic data as a choropleth map with a configurable colour scale.
---

# Studio — Map widget

<p class="description">Display geographic data as a choropleth map with a configurable colour scale.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`StudioMapWidget` renders a choropleth map (`kind: 'map'`) from a Studio data source.
It groups rows by country, aggregates an optional numeric value per country, and fills each country with a sequential colour ramp.

The built-in SVG map uses a 174-country equirectangular projection (`960 × 500`) generated from Natural Earth 110m public-domain data.

## Configuration

`mapCountryField` is required.
It can contain ISO alpha-2 codes, ISO alpha-3 codes, or full English country names.
Studio normalises these identifiers through `countryUtils` before looking them up in the map.

```ts
interface StudioWidgetConfig {
  mapCountryField?: string; // country identifier field
  mapCountrySourceId?: string; // source for country field (if from related source)
  mapValueField?: string; // numeric field to aggregate per country
  mapValueSourceId?: string; // source for value field (if from related source)
  mapAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  mapColorScheme?: 'blues' | 'reds' | 'greens' | 'oranges' | 'purples';
}
```

| Property             | Description                                                                                             |
| :------------------- | :------------------------------------------------------------------------------------------------------ |
| `mapCountryField`    | Country identifier field. Required.                                                                     |
| `mapCountrySourceId` | Source ID for the country field when it comes from a related source.                                    |
| `mapValueField`      | Numeric field to aggregate per country. Optional.                                                       |
| `mapValueSourceId`   | Source ID for the value field when it comes from a related source.                                      |
| `mapAggregation`     | Aggregation applied per country: `'sum'`, `'count'`, `'avg'`, `'min'`, or `'max'`. Defaults to `'sum'`. |
| `mapColorScheme`     | Sequential ramp: `'blues'`, `'reds'`, `'greens'`, `'oranges'`, or `'purples'`. Defaults to `'blues'`.   |

When `mapValueField` is omitted, each row contributes `1`.
With the default `mapAggregation: 'sum'`, that makes the widget count rows per country.

## Cross-source fields

The country field and value field can each come from a different related source.
Set `mapCountrySourceId` and `mapValueSourceId` when either field does not belong to the widget's primary `sourceId`.
Studio resolves the join path through the declared [relationships](/x/react-studio/data/relationships/).

## Colour scale and tooltip

The map ships with five sequential colour ramps and linearly interpolates between ramp stops.
Countries with no data use a neutral fill.
Hovering a country shows a tooltip with the normalised country code and the aggregated value.

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

## Feature flag

Use `featureFlags.map` to hide the map widget from the widget picker.
The flag defaults to `true`.

```tsx
<Studio featureFlags={{ map: false }} />
```

## See also

- [Relationships](/x/react-studio/data/relationships/) — resolve country and value fields from related sources
- [Cross-filters](/x/react-studio/features/cross-filters/) — combine a map with other linked widgets
