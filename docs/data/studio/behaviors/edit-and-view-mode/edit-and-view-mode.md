---
title: Studio - Edit and view mode
description: The Studio canvas operates in two distinct modes—edit mode for configuring the dashboard layout, and view mode for end users to interact with the live data.
---

# Studio - Edit and view mode

<p class="description">The Studio canvas operates in two distinct modes—edit mode for configuring the dashboard layout, and view mode for end users to interact with the live data.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

Every Studio instance is always in one of two modes: `'edit'` or `'view'`.
The active mode controls what the canvas renders and what interactions are available.

## Edit mode

In edit mode, the full dashboard-builder UI is active:

- Widget cards have resize handles and a drag handle
- The sidebar shows widget configuration panels
- An "Add widget" button / toolbar is visible
- Keyboard shortcuts for undo, redo, duplicate, and delete are active
- Cross-filters and global filters are still applied but clicking a chart point selects the widget rather than emitting a cross-filter

## View mode

In view mode, the canvas switches to a read-only interactive display:

- Resize handles, drag handles, and sidebar panels are hidden
- Widget card actions (configure, duplicate, delete) are hidden
- Chart cross-filter emission is active — clicking a bar emits a cross-filter
- Global filters and filter widgets are fully interactive
- Undo/redo shortcuts are disabled

## Switching modes programmatically

### With `<Studio>` and `StudioHandle`

```tsx
import { Studio, StudioHandle } from '@mui/x-studio';

function App() {
  const studioRef = React.useRef<StudioHandle>(null);

  return (
    <>
      <button onClick={() => studioRef.current?.setMode('view')}>Preview</button>
      <button onClick={() => studioRef.current?.setMode('edit')}>Edit</button>
      <Studio ref={studioRef} />
    </>
  );
}
```

### With `StudioController` (composed)

```tsx
import {
  StudioController,
  StudioProvider,
  useStudioSelector,
  selectMode,
} from '@mui/x-studio';

const controller = React.useMemo(() => new StudioController(), []);

function ModeToggle() {
  const mode = useStudioSelector(selectMode);
  return (
    <button onClick={() => controller.setMode(mode === 'edit' ? 'view' : 'edit')}>
      {mode === 'edit' ? 'Preview' : 'Edit'}
    </button>
  );
}
```

## Reading the current mode

Subscribe to mode changes anywhere inside `StudioProvider` using the `selectMode` selector:

```tsx
import { useStudioSelector, selectMode } from '@mui/x-studio';

function ModeIndicator() {
  const mode = useStudioSelector(selectMode);
  return <span>Mode: {mode}</span>;
}
```

## Starting in a specific mode

Pass `initialState` with a `mode` property to start the Studio in a given mode:

```tsx
<Studio initialState={{ mode: 'view', dashboard: savedDashboard }} />
```

:::info
If you are embedding Studio in a product where end users should never see the
builder UI, start in `'view'` mode and do not expose any button to switch to
`'edit'` mode.
:::

## Conditional rendering based on mode

Use `useStudioSelector(selectMode)` to conditionally render host-app UI:

```tsx
function DashboardToolbar() {
  const mode = useStudioSelector(selectMode);

  return (
    <Toolbar>
      {mode === 'edit' && <SaveButton />}
      {mode === 'view' && <ShareButton />}
    </Toolbar>
  );
}
```

## See also

- [Canvas interactions](/x/react-studio/behaviors/canvas-interactions/) — drag-and-drop, resize, and widget selection available in edit mode
- [Undo & redo](/x/react-studio/behaviors/undo-redo/) — history is tracked in edit mode only
- [Studio component](/x/react-studio/getting-started/studio/) — `StudioHandle.setMode()` API reference
- [State management](/x/react-studio/getting-started/state/) — `selectMode` selector
