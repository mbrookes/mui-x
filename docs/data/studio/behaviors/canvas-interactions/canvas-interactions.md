---
title: Studio - Canvas interactions
description: In edit mode, the Studio canvas supports drag-and-drop repositioning, widget resizing, multi-widget selection, and context-menu actions.
---

# Studio - Canvas interactions

<p class="description">In edit mode, the Studio canvas supports drag-and-drop repositioning, widget resizing, multi-widget selection, and context-menu actions.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

When the Studio is in [edit mode](/x/react-studio/behaviors/edit-and-view-mode/),
the canvas becomes a layout editor. Users can freely rearrange and resize widgets
by dragging. The layout is grid-based and snaps to a 12-column responsive grid.

## Drag and drop

Every widget card has a drag handle (⠿) in its top-left corner. Dragging the handle
repositions the widget on the canvas. The grid snaps to column and row boundaries
during drag, and a drop-target indicator shows where the widget will land.

Widgets cannot overlap: if you drop a widget on top of another, it is placed in the
nearest free slot instead.

## Resizing

Drag the resize handle (bottom-right corner of each widget card) to change the
widget's width and height. Resizing also snaps to the grid.

Minimum dimensions are enforced per widget type:

| Widget type | Minimum width (columns) | Minimum height (rows) |
| :---------- | :---------------------- | :-------------------- |
| Chart       | 3                       | 2                     |
| KPI         | 2                       | 1                     |
| Grid        | 4                       | 2                     |
| Filter      | 2                       | 1                     |
| Text        | 1                       | 1                     |

## Widget selection

Click a widget card to select it. The sidebar updates to show the widget's
configuration panel.

Press **Escape** to deselect.

## Context menu

Right-click a widget card to open a context menu with the following actions:

| Action           | Keyboard shortcut      |
| :--------------- | :--------------------- |
| Duplicate widget | `Mod+D`                |
| Delete widget    | `Backspace` / `Delete` |
| Configure widget | —                      |

## Multi-widget selection

Hold **Shift** and click additional widgets to extend the selection.
Multi-selection supports:

- **Move** — drag any selected widget to move all selected widgets together
- **Delete** — `Backspace` deletes all selected widgets at once

Multi-selection does not support resize; each widget must be resized individually.

## Adding widgets

In edit mode, click the **Add widget** button in the toolbar or the floating action
button on the canvas to open the widget picker. Select a widget type to add it to
the next available position on the canvas.

## Widget templates

In the compose drawer's add-widget view, widget type cards can show a template
menu button when templates are available for that widget kind. Choosing a template
starts the widget with a pre-built configuration instead of a blank setup.

Studio includes 13 built-in templates across KPI, chart, and table widgets,
including KPI sum/count/avg, bar, horizontal bar, trend, area, stacked bar,
multi-measure bar, donut, scatter, funnel, and data table presets.

Template placeholders are filled automatically from the primary data source:

- Numeric fields map to value fields and Y-axis series
- Category fields map to X-axis and group-by fields
- Date fields map to sparkline time fields

Templates are disabled when the active source does not provide the required field
types, so editors can see which presets are compatible before selecting one.

## Inline text editing

Double-click a text widget to enter inline editing mode. Press **Escape** or click
outside to commit changes.

## Keyboard shortcut summary

All canvas shortcuts require the Studio canvas to have focus (click anywhere on the
canvas first).

| Shortcut                | Action                    |
| :---------------------- | :------------------------ |
| `Mod+Z`                 | Undo                      |
| `Mod+Shift+Z` / `Mod+Y` | Redo                      |
| `Mod+D`                 | Duplicate selected widget |
| `Backspace` / `Delete`  | Delete selected widget(s) |
| `Escape`                | Deselect / close sidebar  |

:::info
`Mod` is `Cmd` on macOS and `Ctrl` on Windows/Linux.
:::

## Registering keyboard shortcuts in a composed layout

When using the [composed approach](/x/react-studio/getting-started/composition/),
call `useStudioKeyboardShortcuts()` inside `StudioProvider` to activate canvas
keyboard shortcuts:

```tsx
import {
  StudioProvider,
  useStudioKeyboardShortcuts,
  StudioCanvas,
} from '@mui/x-studio';

function StudioInner() {
  useStudioKeyboardShortcuts();
  return <StudioCanvas />;
}

function App() {
  return (
    <StudioProvider controller={controller}>
      <StudioInner />
    </StudioProvider>
  );
}
```

## See also

- [Edit and view mode](/x/react-studio/behaviors/edit-and-view-mode/) — mode switching and what interactions each mode enables
- [Undo & redo](/x/react-studio/behaviors/undo-redo/) — history tracking behind drag, resize, and delete actions
- [Composed approach](/x/react-studio/getting-started/composition/) — `useStudioKeyboardShortcuts()` for custom layouts
