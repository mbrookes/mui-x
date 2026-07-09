'use client';
import * as React from 'react';
import {
  DRAG_TYPE_CANVAS_WIDGET,
  type CanvasWidgetDragItem,
} from '../StudioCanvas/studioWidgetDndTypes';
import { useStudioDraggable } from '../StudioCanvas/useStudioDraggable';
import { createClonePreview } from '../StudioCanvas/createClonePreview';

interface UseStudioWidgetCardDragParams {
  /** Ref to the card's root element (the drag source and preview template). */
  ref: React.RefObject<HTMLDivElement | null>;
  /** ID of the widget being dragged. */
  widgetId: string;
  /** ID of the page the widget card lives on (the drag source page). */
  pageId: string;
  /** Whether the card can currently be dragged (edit mode only). */
  canDrag: boolean;
}

/**
 * Wires pointer drag-and-drop for a widget card. Extracted from `StudioWidgetCard` so the
 * card no longer inlines drag plumbing. The drag "side effects" (a `document.body` flag other
 * widgets/CSS key off, and dimming the source card) live here; `useStudioDraggable` guarantees
 * the drop handler runs even if the card unmounts or `canDrag` flips off mid-drag, so these
 * never leak.
 */
export function useStudioWidgetCardDrag({
  ref,
  widgetId,
  pageId,
  canDrag,
}: UseStudioWidgetCardDragParams): boolean {
  const [isDragging, setIsDragging] = React.useState(false);

  const getData = React.useCallback(
    (): CanvasWidgetDragItem => ({
      type: DRAG_TYPE_CANVAS_WIDGET,
      widgetId,
      sourcePageId: pageId,
    }),
    [widgetId, pageId],
  );

  const renderPreview = React.useMemo(() => createClonePreview(ref), [ref]);

  useStudioDraggable({
    ref,
    canDrag,
    getData,
    renderPreview,
    onDragStart: () => {
      setIsDragging(true);
      document.body.dataset.studioDraggingWidgetId = widgetId;
      if (ref.current) {
        ref.current.style.opacity = '0.1';
      }
    },
    onDrop: () => {
      setIsDragging(false);
      delete document.body.dataset.studioDraggingWidgetId;
      if (ref.current) {
        ref.current.style.opacity = '';
      }
    },
  });

  return isDragging;
}
