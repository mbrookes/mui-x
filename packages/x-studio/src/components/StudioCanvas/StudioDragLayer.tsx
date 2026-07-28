'use client';
import * as React from 'react';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { GlobalStyles } from '@mui/material';
import { isStudioDragItem } from './studioWidgetDndTypes';

/**
 * Enforces `cursor: move` on the document during a widget drag (and `copy`
 * over a valid drop zone) by toggling the `x-studio-dnd-active` class on the
 * `html` element. Uses a single pragmatic-drag-and-drop monitor instead of a
 * per-card effect.
 *
 * The native drag preview is suppressed by each draggable (see
 * `useStudioDraggable`), so no custom preview element is rendered here.
 */
export function StudioDragLayer() {
  React.useEffect(() => {
    const stopMonitoring = monitorForElements({
      canMonitor: ({ source }) => isStudioDragItem(source.data),
      onDragStart: () => {
        document.documentElement.classList.add('x-studio-dnd-active');
      },
      onDrop: () => {
        document.documentElement.classList.remove('x-studio-dnd-active');
      },
    });
    return () => {
      stopMonitoring();
      // The class is on `document.documentElement` — OUTSIDE this component's tree — so
      // unregistering the monitor does not undo it. Unmounting mid-drag (a host route
      // change, or `<Studio>` being conditionally rendered away while a widget is in the
      // air) therefore left `x-studio-dnd-active` latched on `<html>` forever: the
      // `GlobalStyles` below unmount with it, so nothing looks wrong until the NEXT Studio
      // mounts and re-injects the rules — at which point the whole document renders with
      // `cursor: move !important` and no drag in progress, until some later drag happens
      // to end and clear it. Clear it here instead. Removing an absent class is a no-op,
      // so the ordinary unmount-while-idle path is unaffected, and a second Studio on the
      // page re-adds it on its own next drag.
      document.documentElement.classList.remove('x-studio-dnd-active');
    };
  }, []);

  return (
    <GlobalStyles
      styles={{
        'html.x-studio-dnd-active, html.x-studio-dnd-active *': {
          cursor: 'move !important',
        },
        'html.x-studio-dnd-active [data-studio-drop-active], html.x-studio-dnd-active [data-studio-drop-active] *':
          {
            cursor: 'copy !important',
          },
      }}
    />
  );
}
