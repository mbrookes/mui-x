---
title: Studio - Selectors
description: Reference for all exported Studio selectors and selector factories for subscribing to slices of StudioState inside StudioProvider.
---

# Studio - Selectors

<p class="description">Reference for all exported Studio selectors and selector factories for subscribing to slices of StudioState inside StudioProvider.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

Selectors are plain functions with the signature `(state: StudioState) => T`.
Pass them to `useStudioSelector` inside `StudioProvider` to subscribe to a specific
slice of the state. Components only re-render when the selected value changes.

```tsx
import { useStudioSelector, selectMode } from '@mui/x-studio';

function ModeLabel() {
  const mode = useStudioSelector(selectMode);
  return <span>{mode}</span>;
}
```

## Built-in selectors

| Selector                   | Return type                | Description                                        |
| :------------------------- | :------------------------- | :------------------------------------------------- |
| `selectMode`               | `'edit' \| 'view'`         | Current canvas mode                                |
| `selectDashboard`          | `StudioDashboard`          | Full dashboard object (title, pages map, settings) |
| `selectPages`              | `StudioPage[]`             | Ordered array of all dashboard pages               |
| `selectActivePage`         | `StudioPage \| undefined`  | The currently visible page                         |
| `selectActivePageId`       | `string \| undefined`      | ID of the currently visible page                   |
| `selectWidgets`            | `StudioWidget[]`           | All widgets on the active page                     |
| `selectDataSources`        | `StudioDataSource[]`       | All registered data sources                        |
| `selectRelationships`      | `StudioRelationship[]`     | All declared source relationships                  |
| `selectFilters`            | `StudioFilter[]`           | All active filter conditions (all scopes)          |
| `selectExpressionFields`   | `StudioExpressionField[]`  | All calculated columns and measures                |
| `selectShell`              | `StudioShell`              | Shell metadata (sidebar open, selected widget)     |
| `selectPartitionedFilters` | `StudioPartitionedFilters` | Filters split by scope                             |

## Selector factories

Selector factories are functions that accept arguments and return a configured selector.
Use them when you need to select a value that depends on a specific ID.

### `makeSelectActiveInteractiveFilter(widgetId)`

Returns the active interactive (cross-filter) condition emitted by the specified widget.

```ts
const selectMyWidgetFilter = makeSelectActiveInteractiveFilter('w1');
const filter = useStudioSelector(selectMyWidgetFilter);
// filter: StudioFilter | undefined
```

### `makeSelectExpressionFieldsForSource(sourceId)`

Returns all expression fields (calculated columns + measures) scoped to a single
data source.

```ts
const selectOrdersExpressions = makeSelectExpressionFieldsForSource('orders');
const fields = useStudioSelector(selectOrdersExpressions);
// fields: StudioExpressionField[]
```

### `makeSelectExpressionFieldsForSources(sourceIds)`

Returns all expression fields for any of the provided data source IDs.

```ts
const selectMultiSourceExpressions = makeSelectExpressionFieldsForSources([
  'orders',
  'products',
]);
const fields = useStudioSelector(selectMultiSourceExpressions);
```

## `selectPartitionedFilters` shape

This selector returns filters pre-bucketed by scope for efficient consumption:

```ts
interface StudioPartitionedFilters {
  page: StudioFilter[]; // page-scoped conditions
  byWidgetId: Record<string, StudioFilter[]>; // widget-scoped conditions keyed by widgetId
  cross: StudioFilter[]; // cross-filter conditions emitted by chart/grid clicks
  interactive: StudioFilter[]; // all interactive (non-global) conditions
}

const { page, byWidgetId, cross } = useStudioSelector(selectPartitionedFilters);
```

## Writing custom selectors

Selectors are plain functions — compose them using standard JavaScript:

```ts
import { selectWidgets, selectDataSources } from '@mui/x-studio';
import type { StudioState } from '@mui/x-studio';

// Select only chart widgets
const selectChartWidgets = (state: StudioState) =>
  selectWidgets(state).filter((w) => w.type === 'chart');

// Select widget count for the active page
const selectWidgetCount = (state: StudioState) => selectWidgets(state).length;
```

## Memoising expensive selectors

For selectors that perform non-trivial computation, use a memoisation utility like
`createSelector` from the `reselect` package to avoid unnecessary recalculations:

```ts
import { createSelector } from 'reselect';
import { selectWidgets, selectDataSources } from '@mui/x-studio';

const selectWidgetsWithSources = createSelector(
  [selectWidgets, selectDataSources],
  (widgets, sources) =>
    widgets.map((w) => ({
      ...w,
      source: sources.find((s) => s.id === w.config.dataSourceId),
    })),
);
```

## See also

- [State management](/x/react-studio/getting-started/state/) — the `StudioState` shape and `useStudioSelector` hook
- [Composed approach](/x/react-studio/getting-started/composition/) — where to call `useStudioSelector` in the component tree
- [Controller API](/x/react-studio/resources/controller-api/) — the methods used to mutate the state that selectors read
