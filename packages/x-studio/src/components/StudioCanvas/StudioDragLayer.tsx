import * as React from 'react';
import { useDragLayer } from 'react-dnd';
import { GlobalStyles } from '@mui/material';

/**
 * Renders a custom drag preview that follows the mouse during a widget drag,
 * and enforces `cursor: grabbing` on the document during the drag.
 *
 * Must be rendered inside `DndProvider`.
 */
export function StudioDragLayer() {
  const { isDragging, currentOffset } = useDragLayer((monitor) => ({
    isDragging: monitor.isDragging(),
    currentOffset: monitor.getClientOffset(),
  }));

  if (!isDragging || !currentOffset) {
    return (
      <GlobalStyles
        styles={{
          'html.x-studio-dnd-active, html.x-studio-dnd-active *': {
            cursor: 'grabbing !important',
          },
          'html.x-studio-dnd-active [data-studio-drop-active], html.x-studio-dnd-active [data-studio-drop-active] *':
            {
              cursor: 'copy !important',
            },
        }}
      />
    );
  }

  return (
    <React.Fragment>
      {/* Cursor overrides applied to html element during drag */}
      <GlobalStyles
        styles={{
          'html.x-studio-dnd-active, html.x-studio-dnd-active *': {
            cursor: 'grabbing !important',
          },
          'html.x-studio-dnd-active [data-studio-drop-active], html.x-studio-dnd-active [data-studio-drop-active] *':
            {
              cursor: 'copy !important',
            },
        }}
      />
      {/* Invisible full-viewport overlay to ensure cursor style is applied everywhere */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          pointerEvents: 'none',
          cursor: 'grabbing',
        }}
      />
    </React.Fragment>
  );
}
