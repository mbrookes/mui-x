'use client';
import * as React from 'react';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { disableNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
import { pointerOutsideOfPreview } from '@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview';
import type { StudioDragItem } from './studioWidgetDndTypes';

interface UseStudioDraggableParameters {
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
  /**
   * Renders the "ghost" that follows the pointer during a drag. When omitted, the
   * native preview is suppressed and nothing tracks the pointer.
   * @param {HTMLElement} container The element the ghost should be mounted into.
   * @returns {(() => void) | void} An optional cleanup function.
   */
  renderPreview?: (container: HTMLElement) => (() => void) | void;
}

/**
 * Registers a pragmatic-drag-and-drop draggable on `ref`. When `renderPreview` is
 * supplied, a custom drag preview (the translucent "ghost") is mounted via
 * `setCustomNativeDragPreview` and tracks the pointer; otherwise the native preview
 * is suppressed. The drag item is carried verbatim via `getInitialData` and read
 * back from `source.data` in the drop target (see {@link useStudioDropTarget}).
 */
export function useStudioDraggable(params: UseStudioDraggableParameters): void {
  const { ref, canDrag, getData, onDragStart, onDrop, renderPreview } = params;

  // Keep the latest data/callbacks in refs so the effect only re-runs when
  // `canDrag` toggles, not on every render.
  const getDataRef = React.useRef(getData);
  getDataRef.current = getData;
  const onDragStartRef = React.useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const onDropRef = React.useRef(onDrop);
  onDropRef.current = onDrop;
  const renderPreviewRef = React.useRef(renderPreview);
  renderPreviewRef.current = renderPreview;

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
        const render = renderPreviewRef.current;
        if (!render) {
          disableNativeDragPreview({ nativeSetDragImage });
          return;
        }
        setCustomNativeDragPreview({
          nativeSetDragImage,
          // Offset the ghost slightly ahead of the pointer so the cursor stays visible.
          getOffset: pointerOutsideOfPreview({ x: '16px', y: '8px' }),
          render: ({ container }) => render(container),
        });
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
