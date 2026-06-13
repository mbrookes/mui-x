import type { StudioWidgetKind } from '../../models/baseTypes';

/** Drag item type for a widget card being repositioned on the canvas. */
export const DRAG_TYPE_CANVAS_WIDGET = 'studio-canvas-widget' as const;

/** Drag item type for a new widget being dragged from the Compose panel. */
export const DRAG_TYPE_COMPOSE_WIDGET = 'studio-compose-widget' as const;

export interface CanvasWidgetDragItem {
  type: typeof DRAG_TYPE_CANVAS_WIDGET;
  widgetId: string;
  sourcePageId: string;
}

export interface ComposeWidgetDragItem {
  type: typeof DRAG_TYPE_COMPOSE_WIDGET;
  kind: StudioWidgetKind;
}

export type StudioDragItem = CanvasWidgetDragItem | ComposeWidgetDragItem;

/**
 * Type guard for the data carried by a pragmatic-drag-and-drop source.
 * Used by canvas drop targets to ignore unrelated drags (replaces react-dnd's
 * `accept` array).
 */
export function isStudioDragItem(data: unknown): data is StudioDragItem {
  const type = (data as Partial<StudioDragItem> | null)?.type;
  return type === DRAG_TYPE_CANVAS_WIDGET || type === DRAG_TYPE_COMPOSE_WIDGET;
}
