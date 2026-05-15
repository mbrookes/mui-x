---
title: Studio - State management
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - State management

<p class="description">Understand the StudioState shape, read slices with selectors, and react to changes anywhere in the component tree.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## StudioState shape

Every piece of dashboard data lives in a single `StudioState` object. It is serialisable to JSON and is what you pass to `initialState` and receive in `onStateChange`.

```ts
interface StudioState {
  schemaVersion: 1;
  mode: 'edit' | 'view';
  dashboard: StudioDashboardState;
  pages: Record<string, StudioPage>;
  widgets: Record<string, StudioWidget>;
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  filters: StudioFilterState[];
  expressionFields: StudioExpressionField[];
  shell: StudioShellState;
}
```

### Top-level fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `schemaVersion` | `1` | Always `1`. Used by the migration system when loading older saved states. |
| `mode` | `'edit' \| 'view'` | Current editing mode. |
| `dashboard` | `StudioDashboardState` | Dashboard-level metadata: `id`, `title`, `activePageId`, optional `defaultTheme`. |
| `pages` | `Record<string, StudioPage>` | All pages, keyed by page ID. Each page owns its own widget layout. |
| `widgets` | `Record<string, StudioWidget>` | All widgets across all pages, keyed by widget ID. |
| `dataSources` | `Record<string, StudioDataSource>` | All registered data sources, keyed by source ID. |
| `relationships` | `StudioRelationship[]` | Declared foreign-key relationships between sources. |
| `filters` | `StudioFilterState[]` | All active filters: page, widget, cross-filter, and interactive. |
| `expressionFields` | `StudioExpressionField[]` | User-authored calculated columns and measures. |
| `shell` | `StudioShellState` | Transient UI state: open drawers, selected widget/field. Not persisted. |

### StudioDashboardState

```ts
interface StudioDashboardState {
  id: string;
  title: string;
  activePageId: string;
  defaultTheme?: StudioPageTheme;
}
```

### StudioPage

```ts
interface StudioPage {
  id: string;
  title: string;
  widgetRows: string[][];   // Each inner array is one row of widget IDs
  theme?: StudioPageTheme;
}
```

`widgetRows` is a 2D array. Each row is an array of widget IDs that are displayed side-by-side. Widgets in the same row share the row height equally. Different rows stack vertically.

## Reading state

### onStateChange

The simplest way to observe state is the `onStateChange` prop on `<Studio>`:

```tsx
const [state, setState] = React.useState(() => createDefaultStudioState());

<Studio
  initialState={state}
  onStateChange={setState}
  dataSources={dataSources}
/>
```

`onStateChange` fires on every state mutation. The callback receives the full new `StudioState`.

### useStudioSelector (composed approach)

Inside a `StudioProvider`, use `useStudioSelector` to subscribe to any state slice. The component only re-renders when the selected value changes.

```tsx
import { useStudioSelector, selectMode } from '@mui/x-studio';

function ModeIndicator() {
  const mode = useStudioSelector(selectMode);
  return <span>{mode === 'edit' ? '✏️ Editing' : '👁 Viewing'}</span>;
}
```

Pass any function `(state: StudioState) => T`. Use the stable selectors exported from `@mui/x-studio` where possible — they have the same reference across renders, which avoids unnecessary re-evaluations.

## Exported selectors

All selectors are simple `(state: StudioState) => T` functions. Import them from `@mui/x-studio`.

| Selector | Return type | Description |
| :--- | :--- | :--- |
| `selectMode` | `StudioMode` | Current `'edit'` or `'view'` mode. |
| `selectDashboard` | `StudioDashboardState` | Dashboard metadata including `activePageId`. |
| `selectPages` | `Record<string, StudioPage>` | All pages. |
| `selectActivePage` | `StudioPage` | The currently visible page. |
| `selectWidgets` | `Record<string, StudioWidget>` | All widgets. |
| `selectDataSources` | `Record<string, StudioDataSource>` | All data sources. |
| `selectRelationships` | `StudioRelationship[]` | All declared relationships. |
| `selectFilters` | `StudioFilterState[]` | All active filters (all scopes). |
| `selectExpressionFields` | `StudioExpressionField[]` | All expression fields. |
| `selectShell` | `StudioShellState` | Transient UI state (drawers, selection). |
| `selectActivePageId` | `string` | ID of the active page (convenience shortcut). |
| `selectPartitionedFilters` | `PartitionedFilters` | Filters bucketed by scope in a single pass. Use instead of multiple `.filter()` calls. |

## Selector factories

Some selectors depend on a runtime value (like a widget ID). Create them with the factory functions and memoize the result:

```tsx
import {
  useStudioSelector,
  makeSelectActiveInteractiveFilter,
  makeSelectExpressionFieldsForSource,
} from '@mui/x-studio';

function FilterWidget({ widgetId, sourceId }) {
  // Memoize so the selector reference is stable across renders
  const filterSel = React.useMemo(
    () => makeSelectActiveInteractiveFilter(widgetId),
    [widgetId],
  );
  const exprSel = React.useMemo(
    () => makeSelectExpressionFieldsForSource(sourceId),
    [sourceId],
  );

  const activeFilter = useStudioSelector(filterSel);
  const exprFields = useStudioSelector(exprSel);
  // ...
}
```

| Factory | Returns | Description |
| :--- | :--- | :--- |
| `makeSelectActiveInteractiveFilter(widgetId)` | `StudioFilterState \| null` | The active interactive (slider/toggle/date-range/multi-select) filter emitted by the given filter widget. |
| `makeSelectExpressionFieldsForSource(sourceId)` | `StudioExpressionField[]` | Expression fields for a single source. Reference-stable when unrelated sources change. |
| `makeSelectExpressionFieldsForSources(sourceIds)` | `StudioExpressionField[]` | Expression fields for a set of source IDs. Useful in widgets that join multiple sources. |

## Imperative access (ref)

When using `<Studio>`, get a `StudioHandle` ref to read the current state at any time without subscribing:

```tsx
const studioRef = React.useRef<StudioHandle>(null);

<Studio ref={studioRef} initialState={initialState} dataSources={sources} />

// Read state on demand (e.g. in a save button handler)
function handleSave() {
  const current = studioRef.current?.getState();
  if (current) {
    localStorage.setItem('dashboard', JSON.stringify(current));
  }
}
```

## Imperative access (controller)

In the composed approach, get the controller from context:

```tsx
import { useStudioController } from '@mui/x-studio';

function SaveButton() {
  const controller = useStudioController();
  return (
    <button
      onClick={() => {
        const current = controller.getState();
        localStorage.setItem('dashboard', JSON.stringify(current));
      }}
    >
      Save
    </button>
  );
}
```

## See also

- [Studio component](/x/react-studio/getting-started/studio/) — the `onStateChange` callback and `StudioHandle.getState()`
- [Composed approach](/x/react-studio/getting-started/composition/) — `StudioController` and `StudioProvider`
- [Save & load](/x/react-studio/persistence/save-and-load/) — serialize and restore the full `StudioState` as JSON
