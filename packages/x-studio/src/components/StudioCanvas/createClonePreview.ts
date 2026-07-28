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

    // `cloneNode(true)` copies the source card's `id`, `role` and `aria-label` verbatim,
    // so for the duration of the drag the accessibility tree held TWO `role="group"`
    // nodes with the same accessible name and a screen-reader user heard the widget
    // announced twice. The ghost is decoration — a translucent snapshot that tracks the
    // pointer — so it belongs out of the accessibility tree entirely:
    //  - `aria-hidden` removes the clone and its whole subtree from that tree, which
    //    neutralizes the duplicated `role`/`aria-label`/`aria-describedby` at every
    //    depth, not just on the root.
    //  - `inert` keeps the cloned toolbar buttons and grid cells out of the tab order.
    //    A focusable element inside an `aria-hidden` subtree is itself a violation
    //    (focus would land somewhere the screen reader cannot describe), so the two
    //    attributes have to travel together.
    //  - duplicated `id`s are stripped throughout: `getElementById` and every IDREF
    //    lookup (`aria-labelledby`, `aria-describedby`, `<label for>`) resolve to the
    //    FIRST match in document order, so a clone sharing the live card's ids can
    //    silently re-point the real card's relationships at the ghost.
    clone.setAttribute('aria-hidden', 'true');
    clone.setAttribute('inert', '');
    clone.removeAttribute('id');
    clone.querySelectorAll<HTMLElement>('[id]').forEach((el) => {
      el.removeAttribute('id');
    });

    // A detached clone collapses without an explicit size, so pin its dimensions
    // (capped) to mirror the source.
    clone.style.width = `${Math.min(rect.width, GHOST_MAX_WIDTH)}px`;
    clone.style.height = `${Math.min(rect.height, GHOST_MAX_HEIGHT)}px`;
    clone.style.opacity = GHOST_OPACITY;
    clone.style.margin = '0';
    clone.style.boxSizing = 'border-box';
    clone.style.overflow = 'hidden';
    clone.style.pointerEvents = 'none';

    // Hide the widget toolbar so it doesn't appear cropped in the ghost image.
    clone.querySelectorAll<HTMLElement>('[data-widget-overlay]').forEach((el) => {
      el.style.display = 'none';
    });

    container.appendChild(clone);

    return () => {
      clone.remove();
    };
  };
}
