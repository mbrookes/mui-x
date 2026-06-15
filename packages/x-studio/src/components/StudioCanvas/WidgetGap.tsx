'use client';

import * as React from 'react';
import { Box } from '@mui/material';

import type { StudioDragItem } from './studioWidgetDndTypes';
import { useStudioDropTarget } from './useStudioDropTarget';
import { MIN_SPAN, isAdjacentToDraggingWidget } from './canvasGridConstants';
import { RowResizeHandle } from './RowResizeHandle';

interface WidgetGapProps {
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
  const ref = React.useRef<HTMLDivElement>(null);
  const posRef = React.useRef({ rowIndex, colIndex });
  posRef.current = { rowIndex, colIndex };

  const canDrop = React.useCallback(() => {
    const { rowIndex: myRow, colIndex: myCol } = posRef.current;
    return !isAdjacentToDraggingWidget(myRow, myCol, widgetRowsRef);
  }, [widgetRowsRef]);

  const handleDrop = React.useCallback(
    (item: StudioDragItem) => {
      const { rowIndex: r, colIndex: c } = posRef.current;
      onDrop(item, r, c, 'vertical');
    },
    [onDrop],
  );

  const isOver = useStudioDropTarget({ ref, canDrop, onDrop: handleDrop });

  return (
    <Box
      ref={ref}
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
