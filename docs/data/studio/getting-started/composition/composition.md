---
title: Studio - Composed approach
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
components: StudioCanvas, StudioProvider, DrawerPanel, TabbedSidebar
---

# Studio - Composed approach

<p class="description">Use `StudioProvider` and individual Studio pieces to build fully custom layouts — like the `Studio` component itself does internally.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## When to compose

The `<Studio>` all-in-one component is the easiest path for most apps.
Choose the composed approach when you need to:

- Place your toolbar or page tabs **outside** Studio (the `examples/x-studio` pattern)
- Embed the sidebar drawers in a **different layout** (a persistent sidebar instead of a collapsible strip)
- Render the canvas in a **view-only context** without any editing UI
- Create a **completely custom** compose drawer or filter panel

## Building blocks

### Components

| Component             | Role                                                                    |
| :-------------------- | :---------------------------------------------------------------------- |
| `StudioController`    | Owns the state machine. Create once at mount.                           |
| `StudioProvider`      | React context provider — wraps everything that accesses Studio state.   |
| `StudioCanvas`        | Renders the grid of widget cards.                                       |
| `StudioDataDrawer`    | Data sources sidebar panel.                                             |
| `StudioComposeDrawer` | Widget configuration sidebar panel. Accepts `StudioComposeDrawerProps`. |
| `StudioFiltersDrawer` | Page-level filter panel.                                                |
| `DrawerPanel`         | Collapsible sidebar strip that wraps a drawer component.                |
| `TabbedSidebar`       | Tabbed sidebar that shows one panel at a time.                          |
| `StudioChatPanel`     | Floating AI assistant overlay.                                          |

### Hooks

| Hook                  | Role                                                                  |
| :-------------------- | :-------------------------------------------------------------------- |
| `useStudioController` | Returns the controller inside a provider.                             |
| `useStudioSelector`   | Subscribes to a state slice; re-renders only when that slice changes. |

## Minimal example

```tsx
import * as React from 'react';
import { Box } from '@mui/material';
import {
  StudioProvider,
  StudioCanvas,
  DrawerPanel,
  StudioDataDrawer,
  StudioComposeDrawer,
  StudioFiltersDrawer,
  StudioController,
} from '@mui/x-studio';
import type { StudioState } from '@mui/x-studio';

export default function ComposedStudio({
  initialState,
}: {
  initialState?: Partial<StudioState>;
}) {
  // Controller is the state owner — create it once.
  const controller = React.useMemo(() => new StudioController(initialState), []);

  return (
    <StudioProvider controller={controller}>
      <Box sx={{ display: 'flex', height: '100vh' }}>
        {/* Sidebar panels */}
        <Box>
          <DrawerPanel drawer="data" title="Data">
            <StudioDataDrawer />
          </DrawerPanel>
          <DrawerPanel drawer="compose" title="Compose">
            <StudioComposeDrawer />
          </DrawerPanel>
          <DrawerPanel drawer="filters" title="Filters">
            <StudioFiltersDrawer />
          </DrawerPanel>
        </Box>

        {/* Canvas */}
        <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
          <StudioCanvas />
        </Box>
      </Box>
    </StudioProvider>
  );
}
```

## StudioController

`StudioController` is the state machine.
Create it once at mount and pass it to `StudioProvider`:

```ts
// Recommended: useMemo with an empty dep array
const controller = React.useMemo(() => new StudioController(initialState), []);

// Alternative: createStudioController helper
import { createStudioController } from '@mui/x-studio';
const controller = React.useMemo(() => createStudioController(initialState), []);
```

:::warning
Do not recreate the controller on every render — it holds the full dashboard state and undo/redo history.
:::

You can hold a reference to the controller directly instead of using a `ref` to `StudioHandle`:

```ts
controller.setMode('view');
controller.undo();
controller.setActivePage('page-2');
const state = controller.getState();
const serialized = controller.serializeState();
const result = controller.loadSerializedState(data);
controller.setDataSourceAdapter('orders', adapter);
```

### Subscribing to state changes

```ts
const unsubscribe = controller.subscribe((state) => {
  setMode(state.mode);
});

// Cleanup when unmounting:
React.useEffect(() => controller.subscribe(handleStateChange), [controller]);
```

## StudioProvider and context hooks

`StudioProvider` makes the controller available to all descendants:

```tsx
<StudioProvider controller={controller}>
  {/* Everything here can use Studio context hooks */}
</StudioProvider>
```

Inside the provider, use the context hooks:

```ts
// Get the controller imperatively
const controller = useStudioController();
controller.setMode('view');

// Subscribe to a state slice
const mode = useStudioSelector(selectMode);
const pages = useStudioSelector(selectPages);
const activePageId = useStudioSelector(selectActivePageId);
```

Available selectors exported from `@mui/x-studio`:

| Selector             | Returns                                        |
| :------------------- | :--------------------------------------------- |
| `selectMode`         | `'edit' \| 'view'`                             |
| `selectDashboard`    | `StudioDashboardState` (title, activePageId)   |
| `selectPages`        | `Record<string, StudioPage>`                   |
| `selectActivePage`   | `StudioPage` for the active page               |
| `selectActivePageId` | `string`                                       |
| `selectWidgets`      | `Record<string, StudioWidget>`                 |
| `selectDataSources`  | `Record<string, StudioDataSource>`             |
| `selectFilters`      | `StudioFilterState[]`                          |
| `selectShell`        | UI shell state (selected widget, open drawers) |

## DrawerPanel

`DrawerPanel` renders a collapsible sidebar strip containing one drawer component.

```tsx
<DrawerPanel
  drawer="data" // 'data' | 'compose' | 'filters' — controls open/close state
  title="Data Sources"
  icon={<StorageIcon fontSize="small" />}
>
  <StudioDataDrawer />
</DrawerPanel>
```

The `drawer` prop is a key that the controller uses to track whether the panel is expanded.
Multiple `DrawerPanel` components with different `drawer` values can be open simultaneously (stacked layout).

The `DRAWER_WIDTH` and `COLLAPSED_WIDTH` constants are exported if you need to calculate layout widths.

### Back button

Use `onBack` to add a back arrow — useful when the compose panel shows widget detail and you want to navigate back to the list:

```tsx
const selectedWidgetId = useStudioSelector((s) => s.shell.selectedWidgetId);
const controller = useStudioController();

<DrawerPanel
  drawer="compose"
  title={selectedWidgetId ? 'Configure Widget' : 'Compose'}
  onBack={selectedWidgetId ? () => controller.clearSelection() : undefined}
>
  <StudioComposeDrawer />
</DrawerPanel>;
```

## TabbedSidebar

`TabbedSidebar` is an alternative to stacked `DrawerPanel`s.
It shows one panel at a time via a tab rail:

```tsx
import { TabbedSidebar } from '@mui/x-studio';
import type { TabbedSidebarPanel } from '@mui/x-studio';

const panels: TabbedSidebarPanel[] = [
  {
    drawer: 'data',
    label: 'Data',
    icon: <StorageIcon fontSize="small" />,
    children: <StudioDataDrawer />,
  },
  {
    drawer: 'compose',
    label: 'Compose',
    icon: <TuneIcon fontSize="small" />,
    children: <StudioComposeDrawer />,
  },
  {
    drawer: 'filters',
    label: 'Filters',
    icon: <FilterListIcon fontSize="small" />,
    children: <StudioFiltersDrawer />,
  },
];

<TabbedSidebar panels={panels} />;
```

## StudioComposeDrawer props

`StudioComposeDrawer` accepts `StudioComposeDrawerProps`:

### `tableSourceMode`

```ts
tableSourceMode?: 'explicit' | 'implicit'
```

Overrides the `tableSourceMode` value from the parent `Studio` or `StudioProvider`
context. Use this when composing `StudioComposeDrawer` directly and you want to
control how the table setup panel picks a data source.

```tsx
<DrawerPanel drawer="compose" title="Compose">
  <StudioComposeDrawer tableSourceMode="implicit" />
</DrawerPanel>
```

See [`Studio.tableSourceMode`](/x/react-studio/getting-started/studio/#tablesourcemode)
for full documentation.

## StudioCanvas

`StudioCanvas` renders the scrollable grid of widget cards.
It accepts an `sx` prop for layout overrides and `slotProps.widgetCard` to customize every card on the canvas:

```tsx
<StudioCanvas
  sx={{ minWidth: 480, minHeight: '100%' }}
  slotProps={{
    widgetCard: {
      slotProps: {
        paper: { elevation: 0, variant: 'outlined' },
      },
    },
  }}
/>
```

See [Slot props](/x/react-studio/customization/slot-props for the full hierarchy.

## Hiding the sidebar in view mode

A common pattern is to hide the sidebar when the user switches to view mode:

```tsx
function ComposedLayout() {
  const mode = useStudioSelector(selectMode);

  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
      {mode === 'edit' && (
        <Box>
          <DrawerPanel drawer="data" title="Data">
            <StudioDataDrawer />
          </DrawerPanel>
          <DrawerPanel drawer="compose" title="Compose">
            <StudioComposeDrawer />
          </DrawerPanel>
        </Box>
      )}
      <DrawerPanel drawer="filters" title="Filters">
        <StudioFiltersDrawer />
      </DrawerPanel>
      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        <StudioCanvas />
      </Box>
    </Box>
  );
}
```

## Adding the AI panel to a composed layout

`StudioChatPanel` can be used standalone in a composed layout.
Pass `overlay` to render it as a fixed overlay (same as `Studio` does internally):

```tsx
import { StudioChatPanel } from '@mui/x-studio';
import type { StudioAIConfig } from '@mui/x-studio';

function ComposedLayoutWithAI({ aiConfig }: { aiConfig: StudioAIConfig }) {
  const [chatOpen, setChatOpen] = React.useState(false);

  return (
    <Box sx={{ position: 'relative', height: '100vh' }}>
      {/* ... sidebar + canvas ... */}

      {aiConfig?.endpoint && (
        <>
          <IconButton
            sx={{ position: 'absolute', bottom: 20, right: 20 }}
            onClick={() => setChatOpen((v) => !v)}
          >
            <AutoAwesomeIcon />
          </IconButton>
          <StudioChatPanel aiConfig={aiConfig} open={chatOpen} overlay />
        </>
      )}
    </Box>
  );
}
```

## Using keyboard shortcuts

Studio's built-in keyboard shortcuts (`Ctrl+Z`, `Ctrl+Y`, `Delete`, `Escape`) are activated by `useStudioKeyboardShortcuts()`.
The `Studio` component calls this hook automatically.
When composing manually, call it inside a `StudioProvider`:

```tsx
import { useStudioKeyboardShortcuts } from '@mui/x-studio';

function ComposedStudioInner() {
  useStudioKeyboardShortcuts(); // Must be inside StudioProvider
  // ...
}
```

## Full example: external toolbar

This is the pattern used in `examples/x-studio`.
The app manages its own toolbar and page tabs; Studio owns everything inside the canvas area.

```tsx
import React from 'react';
import { Box, AppBar, Toolbar, Typography, Tabs, Tab, Switch } from '@mui/material';
import {
  StudioProvider,
  StudioController,
  StudioCanvas,
  DrawerPanel,
  StudioDataDrawer,
  StudioComposeDrawer,
  StudioFiltersDrawer,
  TabbedSidebar,
  useStudioSelector,
  useStudioController,
  selectMode,
  selectPages,
  selectActivePageId,
  selectDashboard,
  useStudioKeyboardShortcuts,
} from '@mui/x-studio';
import type { StudioState } from '@mui/x-studio';

// Inner component — can use context hooks
function StudioInner() {
  useStudioKeyboardShortcuts();

  const mode = useStudioSelector(selectMode);
  const pages = useStudioSelector(selectPages);
  const activePageId = useStudioSelector(selectActivePageId);
  const dashboard = useStudioSelector(selectDashboard);
  const controller = useStudioController();

  const pageList = Object.values(pages);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            {dashboard.title}
          </Typography>
          <Tabs
            value={activePageId}
            onChange={(_, id) => controller.setActivePage(id)}
          >
            {pageList.map((page) => (
              <Tab key={page.id} value={page.id} label={page.title} />
            ))}
          </Tabs>
          <Switch
            checked={mode === 'edit'}
            onChange={(_, checked) => controller.setMode(checked ? 'edit' : 'view')}
          />
        </Toolbar>
      </AppBar>

      <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        <TabbedSidebar
          panels={[
            ...(mode === 'edit'
              ? [
                  {
                    drawer: 'data' as const,
                    label: 'Data',
                    children: <StudioDataDrawer />,
                  },
                  {
                    drawer: 'compose' as const,
                    label: 'Compose',
                    children: <StudioComposeDrawer />,
                  },
                ]
              : []),
            {
              drawer: 'filters' as const,
              label: 'Filters',
              children: <StudioFiltersDrawer />,
            },
          ]}
        />
        <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
          <StudioCanvas />
        </Box>
      </Box>
    </Box>
  );
}

export default function ComposedApp({
  initialState,
}: {
  initialState?: Partial<StudioState>;
}) {
  const controller = React.useMemo(() => new StudioController(initialState), []);

  return (
    <StudioProvider controller={controller}>
      <StudioInner />
    </StudioProvider>
  );
}
```

## See also

- [Studio component](/x/react-studio/getting-started/studio/) — the all-in-one `<Studio>` API and `StudioHandle`
- [State management](/x/react-studio/getting-started/state/) — `useStudioSelector`, exported selectors, and selector factories
- [Slot props](/x/react-studio/customization/slot-props/) — customize widget cards, charts, and KPIs via the slot props chain
- [AI assistant](/x/react-studio/ai/setup/) — add `StudioChatPanel` to a composed layout
