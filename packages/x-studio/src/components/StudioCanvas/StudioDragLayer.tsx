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
    return monitorForElements({
      canMonitor: ({ source }) => isStudioDragItem(source.data),
      onDragStart: () => {
        document.documentElement.classList.add('x-studio-dnd-active');
      },
      onDrop: () => {
        document.documentElement.classList.remove('x-studio-dnd-active');
      },
    });
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
