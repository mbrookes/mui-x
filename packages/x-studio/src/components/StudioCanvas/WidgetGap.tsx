'use client';

import * as React from 'react';
import { Box } from '@mui/material';
import { useDrop } from 'react-dnd';

import { ACCEPTED_DRAG_TYPES, type StudioDragItem } from './studioWidgetDndTypes';
import { MIN_SPAN, isAdjacentToDraggingWidget } from './canvasGridConstants';
import { RowResizeHandle } from './RowResizeHandle';

export interface WidgetGapProps {
  rowIndex: number;
  colIndex: number;
  onDrop: (
    data: StudioDragItem,
    rowIndex: number,
    colIndex: number,
    orientation: 'vertical',
  ) => void;
  showResizeHandle: boolean;
  leftId: string;
  rightId?: string;
  leftSpan: number;
  rightSpan: number;
  leftMinSpan?: number;
  rightMinSpan?: number;
  widgetRowsRef: React.RefObject<string[][] | undefined>;
  onDragMove: (leftId: string, rightId: string, leftSpanLive: number) => void;
  onDragEnd: (leftId: string, rightId: string, leftSpan: number, rightSpan: number) => void;
}

/**
 * Gap container between (and after) widgets in a row.
 *
 * Fixes BL-59: the RowResizeHandle uses position:absolute + z-index:20, which
 * covers the old InsertionPoint child and intercepts drag events before they
 * could reach it (siblings don't receive bubbled events). By attaching drag
 * handlers to *this* container instead, the events bubble up from the resize
 * handle through the DOM and are caught here regardless of which child element
 * is under the cursor.
 */
export function WidgetGap({
  rowIndex,
  colIndex,
  onDrop,
  showResizeHandle,
  leftId,
  rightId,
  leftSpan,
  rightSpan,
  leftMinSpan = MIN_SPAN,
  rightMinSpan = MIN_SPAN,
  widgetRowsRef,
  onDragMove,
  onDragEnd,
}: WidgetGapProps) {
  const posRef = React.useRef({ rowIndex, colIndex });
  posRef.current = { rowIndex, colIndex };

  const [{ isOver }, dropRef] = useDrop<StudioDragItem, void, { isOver: boolean }>({
    accept: ACCEPTED_DRAG_TYPES,
    canDrop: () => {
      const { rowIndex: myRow, colIndex: myCol } = posRef.current;
      return !isAdjacentToDraggingWidget(myRow, myCol, widgetRowsRef);
    },
    drop: (item) => {
      const { rowIndex: r, colIndex: c } = posRef.current;
      onDrop(item, r, c, 'vertical');
    },
    collect: (monitor) => ({ isOver: monitor.isOver() && monitor.canDrop() }),
  });

  return (
    <Box
      ref={(el) => {
        dropRef(el as HTMLElement | null);
      }}
      data-gap
      sx={{
        position: 'relative',
        flexShrink: 0,
        width: 8,
        alignSelf: 'stretch',
        zIndex: isOver ? 2 : 1,
      }}
    >
      {/* Visual drop indicator — rendered in the gap container so it's always
          visible even when the resize handle covers the original InsertionPoint */}
      {isOver && (
        <Box
          sx={{
            position: 'absolute',
            left: '50%',
            top: 0,
            bottom: 0,
            width: 2,
            bgcolor: 'primary.main',
            borderRadius: 1,
            transform: 'translateX(-50%)',
            boxShadow: 2,
            zIndex: 30,
            pointerEvents: 'none',
          }}
        />
      )}
      {showResizeHandle && rightId && (
        <RowResizeHandle
          leftId={leftId}
          rightId={rightId}
          leftSpan={leftSpan}
          rightSpan={rightSpan}
          leftMinSpan={leftMinSpan}
          rightMinSpan={rightMinSpan}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
        />
      )}
    </Box>
  );
}
