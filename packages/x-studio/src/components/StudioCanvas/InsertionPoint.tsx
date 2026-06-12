'use client';

import * as React from 'react';
import { Box } from '@mui/material';
import { useDrop } from 'react-dnd';

import { ACCEPTED_DRAG_TYPES, type StudioDragItem } from './studioWidgetDndTypes';
import { isAdjacentToDraggingWidget } from './canvasGridConstants';

export interface InsertionPointProps {
  rowIndex: number;
  colIndex: number;
  onDrop: (
    data: StudioDragItem,
    rowIndex: number,
    colIndex: number,
    orientation: 'horizontal' | 'vertical',
  ) => void;
  orientation: 'vertical' | 'horizontal';
  mode: string;
  widgetRowsRef: React.RefObject<string[][] | undefined>;
}

// Plain JS DnD insertion point component — must live at module level
export function InsertionPoint({
  rowIndex,
  colIndex,
  onDrop,
  orientation,
  mode,
  widgetRowsRef,
}: InsertionPointProps) {
  const posRef = React.useRef({ rowIndex, colIndex, orientation });
  posRef.current = { rowIndex, colIndex, orientation };

  const [{ isOver }, dropRef] = useDrop<StudioDragItem, void, { isOver: boolean }>({
    accept: ACCEPTED_DRAG_TYPES,
    canDrop: () => {
      if (mode !== 'edit') return false;
      const { rowIndex: myRow, colIndex: myCol, orientation: myOrientation } = posRef.current;
      if (myOrientation === 'vertical' && isAdjacentToDraggingWidget(myRow, myCol, widgetRowsRef)) {
        return false;
      }
      return true;
    },
    drop: (item) => {
      const { rowIndex: r, colIndex: c, orientation: o } = posRef.current;
      onDrop(item, r, c, o);
    },
    collect: (monitor) => ({ isOver: monitor.isOver() && monitor.canDrop() }),
  });

  // Only show the line when hovered, otherwise invisible and non-interfering
  return (
    <Box
      ref={(el) => {
        dropRef(el as HTMLElement | null);
      }}
      data-studio-drop-active={isOver ? '' : undefined}
      sx={{
        position: 'relative',
        ...(orientation === 'vertical'
          ? {
              width: 8,
              minWidth: 8,
              alignSelf: 'stretch',
              display: 'flex',
              alignItems: 'stretch',
              justifyContent: 'center',
            }
          : {
              width: '100%',
              height: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'stretch',
            }),
        zIndex: isOver ? 2 : 1,
      }}
    >
      {isOver && orientation === 'vertical' && (
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
          }}
        />
      )}
      {isOver && orientation === 'horizontal' && (
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: 8,
            right: 8,
            height: 2,
            bgcolor: 'primary.main',
            borderRadius: 1,
            transform: 'translateY(-50%)',
            boxShadow: 2,
          }}
        />
      )}
    </Box>
  );
}
