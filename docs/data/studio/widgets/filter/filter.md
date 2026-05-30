---
title: Studio - Filter widget
description: The filter widget renders interactive filter controls—date range, multi-select, toggle, or slider—that apply page-level conditions to other widgets.
---

# Studio - Filter widget

<p class="description">The filter widget renders interactive filter controls—date range, multi-select, toggle, or slider—that apply page-level conditions to other widgets.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`StudioFilterWidget` places a user-controlled filter on the canvas. Depending on its
sub-type, it renders a date picker, a multi-select dropdown, a boolean toggle, or a
numeric range slider. The emitted condition is broadcast as a page-level filter that
all widgets on the same page respect automatically.

## Configuration

The `StudioFilterConfig` type is a discriminated union on the `subType` field:

```ts
type StudioFilterConfig =
  | StudioDateRangeFilterConfig
  | StudioMultiSelectFilterConfig
  | StudioToggleFilterConfig
  | StudioSliderFilterConfig;

interface StudioBaseFilterConfig {
  dataSourceId: string;
  field: string; // field id from the data source
  scope?: 'page' | 'widget'; // defaults to 'page'
}
```

## Date range

Renders two date pickers (start/end). The field must have type `date`.

```ts
interface StudioDateRangeFilterConfig extends StudioBaseFilterConfig {
  subType: 'date-range';
  defaultStart?: string; // ISO-8601 date string
  defaultEnd?: string;
}
```

```ts
const filterConfig: StudioDateRangeFilterConfig = {
  subType: 'date-range',
  dataSourceId: 'orders',
  field: 'createdAt',
  defaultStart: '2024-01-01',
  defaultEnd: '2024-12-31',
};
```

## Multi-select

Renders a multi-select dropdown populated with the unique values of a string or
number field.

```ts
interface StudioMultiSelectFilterConfig extends StudioBaseFilterConfig {
  subType: 'multi-select';
  label?: string;
  defaultValues?: string[];
}
```

```ts
const filterConfig: StudioMultiSelectFilterConfig = {
  subType: 'multi-select',
  dataSourceId: 'orders',
  field: 'region',
  label: 'Region',
};
```

## Toggle

Renders a boolean switch. The field must have type `boolean`.

```ts
interface StudioToggleFilterConfig extends StudioBaseFilterConfig {
  subType: 'toggle';
  label?: string;
  defaultValue?: boolean;
}
```

```ts
const filterConfig: StudioToggleFilterConfig = {
  subType: 'toggle',
  dataSourceId: 'products',
  field: 'inStock',
  label: 'In stock only',
  defaultValue: false,
};
```

## Slider

Renders a numeric range slider. The field must have type `number`.

```ts
interface StudioSliderFilterConfig extends StudioBaseFilterConfig {
  subType: 'slider';
  min?: number;
  max?: number;
  step?: number;
  defaultMin?: number;
  defaultMax?: number;
}
```

```ts
const filterConfig: StudioSliderFilterConfig = {
  subType: 'slider',
  dataSourceId: 'products',
  field: 'price',
  min: 0,
  max: 1000,
  step: 10,
};
```

## Scope

The optional `scope` field controls whether the condition is broadcast to the
whole page or only to a specific widget.

| `scope`            | Effect                                                             |
| :----------------- | :----------------------------------------------------------------- |
| `'page'` (default) | Applied to every widget on the page that shares the data source    |
| `'widget'`         | Applied only to the widget whose `widgetId` is specified alongside |

```ts
const filterConfig: StudioMultiSelectFilterConfig = {
  subType: 'multi-select',
  dataSourceId: 'orders',
  field: 'status',
  scope: 'widget',
};
```

## See also

- [Global filters](/x/react-studio/features/global-filters/) — the underlying filter model used by filter widgets
- [Cross-filters](/x/react-studio/features/cross-filters/) — chart/grid click-driven filters (complementary mechanism)
- [Inline data sources](/x/react-studio/data/data-sources/) — field types that drive filter operator availability
- [State management](/x/react-studio/getting-started/state/) — `selectFilters` and `selectPartitionedFilters` selectors
