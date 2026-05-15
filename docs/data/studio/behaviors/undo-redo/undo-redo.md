---
title: Studio - Undo & redo
description: The Studio canvas maintains a 100-step undo/redo history for all edit-mode actions, accessible via keyboard shortcuts and the StudioHandle API.
---

# Studio - Undo & redo

<p class="description">The Studio canvas maintains a 100-step undo/redo history for all edit-mode actions, accessible via keyboard shortcuts and the StudioHandle API.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

While in [edit mode](/x/react-studio/behaviors/edit-and-view-mode/), every
mutating action is pushed onto a history stack. Studio tracks up to **100**
discrete steps. Users can move through history with `Mod+Z` / `Mod+Shift+Z` or
programmatically via the `StudioHandle` API.

## What is tracked

The following actions create history entries:

- Adding, removing, or duplicating a widget
- Repositioning or resizing a widget on the canvas
- Changing a widget configuration value (e.g., chart type, KPI field, column list)
- Adding or removing a data source
- Adding, removing, or renaming a page
- Changing a global or page-level filter condition

Mode switches (`edit` ↔ `view`) are **not** tracked in the history.

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
| :--- | :--- | :--- |
| Undo | `Cmd+Z` | `Ctrl+Z` |
| Redo | `Cmd+Shift+Z` or `Cmd+Y` | `Ctrl+Y` |

Shortcuts are active whenever the Studio canvas has focus.

## Programmatic undo/redo with `<Studio>`

Use the `StudioHandle` ref to trigger undo and redo from host application code:

```tsx
import { Studio, StudioHandle } from '@mui/x-studio';

function App() {
  const studioRef = React.useRef<StudioHandle>(null);

  return (
    <>
      <button onClick={() => studioRef.current?.undo()}>Undo</button>
      <button onClick={() => studioRef.current?.redo()}>Redo</button>
      <Studio ref={studioRef} />
    </>
  );
}
```

## Programmatic undo/redo with `StudioController` (composed)

```tsx
import { StudioController, StudioProvider } from '@mui/x-studio';

const controller = React.useMemo(() => new StudioController(), []);

function UndoRedoButtons() {
  return (
    <>
      <button onClick={() => controller.undo()}>Undo</button>
      <button onClick={() => controller.redo()}>Redo</button>
    </>
  );
}
```

## Checking undo/redo availability

Subscribe to the dashboard state to conditionally disable undo/redo buttons:

```tsx
import { useStudioSelector } from '@mui/x-studio';

function UndoRedoButtons({ controller }: { controller: StudioController }) {
  const { canUndo, canRedo } = useStudioSelector((state) => ({
    canUndo: state.history.past.length > 0,
    canRedo: state.history.future.length > 0,
  }));

  return (
    <>
      <button onClick={() => controller.undo()} disabled={!canUndo}>Undo</button>
      <button onClick={() => controller.redo()} disabled={!canRedo}>Redo</button>
    </>
  );
}
```

## History and serialization

The undo/redo history stack is **not** included in the serialized state produced by
`serializeState()`. This is intentional — when a dashboard is saved and loaded, it
starts with a clean history.

:::warning
Calling `loadSerializedState()` clears the history stack.
:::

## History limit

The history stack is capped at 100 entries. Once the cap is reached, the oldest
entry is discarded when a new action is pushed. This keeps memory usage bounded for
long editing sessions.

## See also

- [Canvas interactions](/x/react-studio/behaviors/canvas-interactions/) — the edit-mode actions that create history entries
- [Edit and view mode](/x/react-studio/behaviors/edit-and-view-mode/) — undo/redo is only active in edit mode
- [Studio component](/x/react-studio/getting-started/studio/) — full `StudioHandle` API including `undo()` and `redo()`
- [Save & load](/x/react-studio/persistence/save-and-load/) — history is not included in the serialized snapshot
