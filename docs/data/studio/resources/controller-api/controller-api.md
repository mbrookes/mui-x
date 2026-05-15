---
title: Studio - Controller API
description: Full reference for StudioController—the state-machine object that manages all dashboard mutations in a composed Studio layout.
---

# Studio - Controller API

<p class="description">Full reference for StudioController—the state-machine object that manages all dashboard mutations in a composed Studio layout.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`StudioController` is the central state machine for a Studio instance.
Create one with `React.useMemo`, pass it to `StudioProvider`, and call its methods
from any component inside the provider tree or from outside in response to application events.

```tsx
import { StudioController, StudioProvider } from '@mui/x-studio';

const controller = React.useMemo(() => new StudioController(), []);

<StudioProvider controller={controller}>
  {/* your layout */}
</StudioProvider>
```

:::info
When using the `<Studio>` all-in-one component, you do not need to create a
`StudioController` directly. Use the `StudioHandle` ref API instead.
See [Studio component](/x/react-studio/getting-started/studio/).
:::

## Mode methods

### `controller.setMode(mode)`

Switch between `'edit'` and `'view'` mode.

```ts
controller.setMode('view');
```

## Widget methods

### `controller.addWidget(widget)`

Add a new widget to the active page. Returns the created widget ID.

```ts
const widgetId = controller.addWidget({
  type: 'chart',
  config: {
    dataSourceId: 'orders',
    type: 'bar',
    xField: 'month',
    series: [{ id: 's1', valueField: 'revenue', aggregation: 'sum' }],
  },
});
```

### `controller.updateWidget(widgetId, config)`

Replace the configuration of an existing widget.

```ts
controller.updateWidget('w1', {
  type: 'bar-stacked',
  dataSourceId: 'orders',
  // ...
});
```

### `controller.removeWidget(widgetId)`

Remove a widget from the active page.

```ts
controller.removeWidget('w1');
```

### `controller.duplicateWidget(widgetId)`

Duplicate a widget on the active page. Returns the new widget ID.

```ts
const newId = controller.duplicateWidget('w1');
```

## Page methods

### `controller.addPage(page?)`

Add a new page. Optionally supply a title. Returns the new page ID.

```ts
const pageId = controller.addPage({ title: 'Orders' });
```

### `controller.removePage(pageId)`

Remove a page and all its widgets.

```ts
controller.removePage('page-2');
```

### `controller.renamePage(pageId, title)`

Update the display title of a page.

```ts
controller.renamePage('page-1', 'Sales Overview');
```

### `controller.setActivePage(pageId)`

Switch the visible page.

```ts
controller.setActivePage('page-2');
```

## Data source methods

### `controller.addDataSource(dataSource)`

Register a new inline data source.

```ts
controller.addDataSource({
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'orderId', label: 'Order ID', type: 'string' },
    { id: 'revenue', label: 'Revenue', type: 'number', aggregatable: true },
  ],
  rows: ordersData,
});
```

### `controller.updateDataSource(id, updates)`

Update properties of an existing data source.

```ts
controller.updateDataSource('orders', { rows: newOrdersData });
```

### `controller.removeDataSource(id)`

Remove a data source and any widgets that reference it.

### `controller.setDataSourceAdapter(id, adapter)`

Attach or replace an async adapter for the specified data source.

```ts
controller.setDataSourceAdapter('orders', myAsyncAdapter);
```

## Filter methods

### `controller.addFilter(filter)`

Add a global filter condition to the active page.

```ts
controller.addFilter({
  fieldId: 'region',
  operator: 'equals',
  value: 'EMEA',
  dataSourceId: 'orders',
  scope: 'page',
});
```

### `controller.removeFilter(filterId)`

Remove a filter condition by ID.

## History methods

### `controller.undo()`

Undo the most recent history entry. No-op if history is empty.

### `controller.redo()`

Redo the next history entry. No-op if at the latest state.

## State methods

### `controller.getState()`

Returns the current `StudioState` snapshot.

```ts
const state = controller.getState();
console.log(state.dashboard.title);
```

### `controller.serializeState()`

Returns a JSON-serializable representation of the current state.

```ts
const json = controller.serializeState();
localStorage.setItem('dashboard', JSON.stringify(json));
```

### `controller.loadSerializedState(state)`

Replaces the current state with a previously serialized snapshot.
Clears the undo/redo history.

```ts
const json = JSON.parse(localStorage.getItem('dashboard') ?? '{}');
controller.loadSerializedState(json);
```

## Dashboard methods

### `controller.updateDashboardTitle(title)`

Update the top-level dashboard title.

```ts
controller.updateDashboardTitle('Q4 Sales Dashboard');
```

## See also

- [Composed approach](/x/react-studio/getting-started/composition/) — setting up `StudioProvider` with a `StudioController`
- [Studio component](/x/react-studio/getting-started/studio/) — the `StudioHandle` API (mirrors this API for the all-in-one component)
- [Selectors](/x/react-studio/resources/selectors/) — read state reactively using `useStudioSelector`
- [Save & load](/x/react-studio/persistence/save-and-load/) — `serializeState()` and `loadSerializedState()` in detail
