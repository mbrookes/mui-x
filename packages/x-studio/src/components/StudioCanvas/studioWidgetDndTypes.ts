import type { StudioWidgetKind } from '../../models/baseTypes';

/** react-dnd item type for a widget card being repositioned on the canvas. */
export const DRAG_TYPE_CANVAS_WIDGET = 'studio-canvas-widget' as const;

/** react-dnd item type for a new widget being dragged from the Compose panel. */
export const DRAG_TYPE_COMPOSE_WIDGET = 'studio-compose-widget' as const;

/** All accepted drag types for canvas drop zones. */
export const ACCEPTED_DRAG_TYPES: string[] = [DRAG_TYPE_CANVAS_WIDGET, DRAG_TYPE_COMPOSE_WIDGET];

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
