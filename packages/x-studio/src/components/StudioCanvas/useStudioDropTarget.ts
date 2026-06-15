'use client';
import * as React from 'react';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { isStudioDragItem, type StudioDragItem } from './studioWidgetDndTypes';

interface UseStudioDropTargetParameters {
  /** Ref to the element that becomes a drop target. */
  ref: React.RefObject<HTMLElement | null>;
  /** Whether the dragged item may be dropped here. Receives the live drag item. */
  canDrop: (item: StudioDragItem) => boolean;
  /** Called when an accepted item is dropped on the target. */
  onDrop: (item: StudioDragItem) => void;
}

/**
 * Registers a pragmatic-drag-and-drop drop target on `ref` and returns whether an
 * acceptable item is currently over it. Mirrors the scheduler's `useDropTarget`.
 *
 * Pragmatic does not fire enter/leave when `canDrop` returns false, so `isOver`
 * reflects "over AND droppable" — matching react-dnd's
 * `monitor.isOver() && monitor.canDrop()`.
 */
export function useStudioDropTarget(params: UseStudioDropTargetParameters): boolean {
  const { ref, canDrop, onDrop } = params;
  const [isOver, setIsOver] = React.useState(false);

  const canDropRef = React.useRef(canDrop);
  canDropRef.current = canDrop;
  const onDropRef = React.useRef(onDrop);
  onDropRef.current = onDrop;

  React.useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    return dropTargetForElements({
      element,
      canDrop: ({ source }) => isStudioDragItem(source.data) && canDropRef.current(source.data),
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: ({ source }) => {
        setIsOver(false);
        if (isStudioDragItem(source.data)) {
          onDropRef.current(source.data);
        }
      },
    });
  }, [ref]);

  return isOver;
}
