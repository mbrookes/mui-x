'use client';

import * as React from 'react';
import { Box } from '@mui/material';

import { MIN_SPAN } from './canvasGridConstants';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

interface RowResizeHandleProps {
  leftId: string;
  rightId: string;
  leftSpan: number;
  rightSpan: number;
  leftMinSpan?: number;
  rightMinSpan?: number;
  onDragMove: (leftId: string, rightId: string, leftSpanLive: number) => void;
  onDragEnd: (leftId: string, rightId: string, leftSpan: number, rightSpan: number) => void;
}

// Between-widget column resize handle — sits in the gap between two flex siblings
export function RowResizeHandle({
  leftId,
  rightId,
  leftSpan,
  rightSpan,
  leftMinSpan = MIN_SPAN,
  rightMinSpan = MIN_SPAN,
  onDragMove,
  onDragEnd,
}: RowResizeHandleProps) {
  const totalSpan = leftSpan + rightSpan;
  const localeText = useStudioLocaleText();
  const dragRef = React.useRef<{
    combinedLeft: number;
    combinedWidth: number;
    totalSpan: number;
  } | null>(null);
  const [active, setActive] = React.useState(false);

  const minLeft = leftMinSpan;
  const maxLeft = totalSpan - rightMinSpan;

  // Keyboard resize: commit a new left span (clamped) via the same callbacks the
  // pointer drag uses, so the handle is operable without a mouse (APG splitter).
  const commitSpan = React.useCallback(
    (nextLeft: number) => {
      const clamped = Math.max(minLeft, Math.min(maxLeft, nextLeft));
      if (clamped === leftSpan) {
        return;
      }
      onDragMove(leftId, rightId, clamped);
      onDragEnd(leftId, rightId, clamped, totalSpan - clamped);
    },
    [minLeft, maxLeft, leftSpan, leftId, rightId, totalSpan, onDragMove, onDragEnd],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          event.preventDefault();
          commitSpan(leftSpan - 1);
          break;
        case 'ArrowRight':
        case 'ArrowUp':
          event.preventDefault();
          commitSpan(leftSpan + 1);
          break;
        case 'Home':
          event.preventDefault();
          commitSpan(minLeft);
          break;
        case 'End':
          event.preventDefault();
          commitSpan(maxLeft);
          break;
        default:
          break;
      }
    },
    [commitSpan, leftSpan, minLeft, maxLeft],
  );

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      // The handle sits inside a gap element; find the widget boxes on either side
      const gap = handle.parentElement;
      if (!gap) {
        return;
      }
      const leftBox = gap.previousElementSibling as HTMLElement | null;
      const rightBox = gap.nextElementSibling as HTMLElement | null;
      if (!leftBox || !rightBox) {
        return;
      }
      const leftRect = leftBox.getBoundingClientRect();
      const rightRect = rightBox.getBoundingClientRect();
      dragRef.current = {
        combinedLeft: leftRect.left,
        combinedWidth: rightRect.right - leftRect.left,
        totalSpan,
      };
      setActive(true);
      handle.setPointerCapture(event.pointerId);
    },
    [totalSpan],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const fraction = (event.clientX - drag.combinedLeft) / drag.combinedWidth;
      const minFrac = leftMinSpan / drag.totalSpan;
      const maxFrac = (drag.totalSpan - rightMinSpan) / drag.totalSpan;
      const clamped = Math.max(minFrac, Math.min(maxFrac, fraction));
      // Snap at midpoint: jump to the next column when the mouse crosses 50% between columns
      const leftSpanLive = Math.max(
        leftMinSpan,
        Math.min(drag.totalSpan - rightMinSpan, Math.round(clamped * drag.totalSpan)),
      );
      onDragMove(leftId, rightId, leftSpanLive);
    },
    [leftId, rightId, leftMinSpan, rightMinSpan, onDragMove],
  );

  const handlePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      dragRef.current = null;
      setActive(false);
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      const fraction = (event.clientX - drag.combinedLeft) / drag.combinedWidth;
      const minFrac = leftMinSpan / drag.totalSpan;
      const maxFrac = (drag.totalSpan - rightMinSpan) / drag.totalSpan;
      const clamped = Math.max(minFrac, Math.min(maxFrac, fraction));
      const snappedLeft = Math.max(
        leftMinSpan,
        Math.min(drag.totalSpan - rightMinSpan, Math.round(clamped * drag.totalSpan)),
      );
      const snappedRight = drag.totalSpan - snappedLeft;
      onDragEnd(leftId, rightId, snappedLeft, snappedRight);
    },
    [leftId, rightId, leftMinSpan, rightMinSpan, onDragEnd],
  );

  return (
    <Box
      data-resize-handle
      role="separator"
      aria-orientation="vertical"
      aria-label={localeText.canvasResizeColumnsAriaLabel}
      aria-valuemin={minLeft}
      aria-valuemax={maxLeft}
      aria-valuenow={leftSpan}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      sx={{
        position: 'absolute',
        inset: 0,
        cursor: 'col-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20,
        '&:hover .rh-bar, &[data-active] .rh-bar, &:focus-visible .rh-bar': {
          opacity: 1,
          bgcolor: 'primary.main',
        },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
      }}
      data-active={active ? '' : undefined}
    >
      <Box
        className="rh-bar"
        sx={{
          width: 3,
          height: '36%',
          minHeight: 20,
          borderRadius: 4,
          bgcolor: active ? 'primary.main' : 'action.disabled',
          opacity: active ? 1 : 0,
          transition: 'opacity 0.15s, background-color 0.15s',
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
}
