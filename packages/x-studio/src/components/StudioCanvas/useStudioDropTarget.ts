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
  /**
   * Extra dependency that forces the registration effect to re-run (re-reading
   * `ref.current`) even though `ref` itself never changes identity across renders.
   *
   * Needed whenever the same `ref` prop can end up attached to a *different* DOM
   * node across renders of the owning component — e.g. the element it's attached
   * to lives in one of several mutually exclusive render branches of a persistent,
   * memoized component. A plain `[ref]` dependency only re-reads `ref.current`
   * when `ref` itself changes identity, which a stored `React.useRef` object never
   * does — so if the branch that renders the ref'd element flips after mount, this
   * effect would otherwise keep referencing whatever `ref.current` was (or `null`)
   * the first time it ran, and the drop target silently goes dead. Pass a value
   * that changes exactly when the rendered branch changes (e.g. a boolean "is this
   * branch active" flag) to fix that.
   */
  watch?: unknown;
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
  const { ref, canDrop, onDrop, watch } = params;
  const [isOver, setIsOver] = React.useState(false);

  const canDropRef = React.useRef(canDrop);
  const onDropRef = React.useRef(onDrop);

  // Assigned in an effect rather than during render (matching `ColorSwatch` and
  // `useStudioDraggable`): a render-phase ref write is a side effect in the render body,
  // which React may discard (a render that never commits) or run twice. Both readers
  // below are pragmatic-dnd callbacks fired by a live pointer gesture, so they can only
  // run after a commit. Declared BEFORE the registration effect so the refs are current
  // by the time it (re)registers on the same flush.
  React.useEffect(() => {
    canDropRef.current = canDrop;
    onDropRef.current = onDrop;
  });

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
    // `watch` is intentionally included so callers can force a re-registration when
    // `ref` is reattached to a new DOM node without `ref` itself changing identity.
  }, [ref, watch]);

  return isOver;
}
