'use client';

import * as React from 'react';
import { Box } from '@mui/material';

import type { StudioDragItem } from './studioWidgetDndTypes';
import { useStudioDropTarget } from './useStudioDropTarget';
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
  const ref = React.useRef<HTMLDivElement>(null);
  const posRef = React.useRef({ rowIndex, colIndex, orientation });
  posRef.current = { rowIndex, colIndex, orientation };

  const canDrop = React.useCallback(() => {
    if (mode !== 'edit') {
      return false;
    }
    const { rowIndex: myRow, colIndex: myCol, orientation: myOrientation } = posRef.current;
    if (myOrientation === 'vertical' && isAdjacentToDraggingWidget(myRow, myCol, widgetRowsRef)) {
      return false;
    }
    return true;
  }, [mode, widgetRowsRef]);

  const handleDrop = React.useCallback(
    (item: StudioDragItem) => {
      const { rowIndex: r, colIndex: c, orientation: o } = posRef.current;
      onDrop(item, r, c, o);
    },
    [onDrop],
  );

  const isOver = useStudioDropTarget({ ref, canDrop, onDrop: handleDrop });

  // Only show the line when hovered, otherwise invisible and non-interfering
  return (
    <Box
      ref={ref}
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
