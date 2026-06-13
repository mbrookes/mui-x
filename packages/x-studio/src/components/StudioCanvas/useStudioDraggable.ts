'use client';
import * as React from 'react';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { disableNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview';
import type { StudioDragItem } from './studioWidgetDndTypes';

export interface UseStudioDraggableParameters {
  /** Ref to the element that becomes draggable. */
  ref: React.RefObject<HTMLElement | null>;
  /** Whether the element can currently be dragged. When false, no drag is registered. */
  canDrag: boolean;
  /** Returns the drag item describing what is being dragged. */
  getData: () => StudioDragItem;
  /** Called when the drag starts. */
  onDragStart?: () => void;
  /** Called when the drag ends (whether dropped on a target or cancelled). */
  onDrop?: () => void;
}

/**
 * Registers a pragmatic-drag-and-drop draggable on `ref`, hiding the native drag
 * preview. Mirrors the scheduler's `useDraggableEvent` pattern. The drag item is
 * carried verbatim via `getInitialData` and read back from `source.data` in the
 * drop target (see {@link useStudioDropTarget}).
 */
export function useStudioDraggable(params: UseStudioDraggableParameters): void {
  const { ref, canDrag, getData, onDragStart, onDrop } = params;

  // Keep the latest data/callbacks in refs so the effect only re-runs when
  // `canDrag` toggles, not on every render.
  const getDataRef = React.useRef(getData);
  getDataRef.current = getData;
  const onDragStartRef = React.useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const onDropRef = React.useRef(onDrop);
  onDropRef.current = onDrop;

  React.useEffect(() => {
    const element = ref.current;
    if (!element || !canDrag) {
      return undefined;
    }

    return draggable({
      element,
      // pragmatic types drag data as a record; the discriminated StudioDragItem
      // is read back via `isStudioDragItem` in the drop target.
      getInitialData: () => getDataRef.current() as unknown as Record<string, unknown>,
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        disableNativeDragPreview({ nativeSetDragImage });
      },
      onDragStart: () => {
        onDragStartRef.current?.();
      },
      onDrop: () => {
        onDropRef.current?.();
      },
    });
  }, [ref, canDrag]);
}
