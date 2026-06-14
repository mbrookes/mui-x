'use client';
import type * as React from 'react';

/** Opacity applied to the cloned "ghost" so it reads as a translucent preview. */
const GHOST_OPACITY = '0.7';
/** Cap the ghost size so large widget cards don't produce an unwieldy preview. */
const GHOST_MAX_WIDTH = 360;
const GHOST_MAX_HEIGHT = 280;

/**
 * Builds a `renderPreview` callback (for {@link useStudioDraggable}) that clones
 * the dragged source node into the drag-preview container at reduced opacity.
 *
 * The clone is a static DOM snapshot of the source taken at drag start, so live
 * data widgets (charts, grids) appear frozen in the ghost.
 */
export function createClonePreview(
  sourceRef: React.RefObject<HTMLElement | null>,
): (container: HTMLElement) => () => void {
  return (container: HTMLElement) => {
    const source = sourceRef.current;
    if (!source) {
      return () => {};
    }

    // Measure before mounting the ghost: `onGenerateDragPreview` runs before the
    // source-fade in `onDragStart`, so the source is still at full size here.
    const rect = source.getBoundingClientRect();
    const clone = source.cloneNode(true) as HTMLElement;

    // A detached clone collapses without an explicit size, so pin its dimensions
    // (capped) to mirror the source.
    clone.style.width = `${Math.min(rect.width, GHOST_MAX_WIDTH)}px`;
    clone.style.height = `${Math.min(rect.height, GHOST_MAX_HEIGHT)}px`;
    clone.style.opacity = GHOST_OPACITY;
    clone.style.margin = '0';
    clone.style.boxSizing = 'border-box';
    clone.style.overflow = 'hidden';
    clone.style.pointerEvents = 'none';

    container.appendChild(clone);

    return () => {
      clone.remove();
    };
  };
}
