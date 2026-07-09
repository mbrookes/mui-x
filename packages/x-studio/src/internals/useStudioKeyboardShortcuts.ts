'use client';

import * as React from 'react';
import { useStudioController } from '../context';

/**
 * Module-level tracker of the Studio instance whose root DOM node most recently held focus.
 * Used only as a fallback when a Ctrl/Cmd+Z arrives while nothing in the page is focused
 * (focus on `<body>`, e.g. right after a click on empty space) so a single-dashboard page
 * still responds — without every mounted instance reacting to the same keypress.
 */
let lastFocusedRoot: HTMLElement | null = null;

/**
 * Registers Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z / Ctrl+Y (redo) keyboard
 * shortcuts on the window, SCOPED to a single Studio instance. Call this once
 * inside a component that is a descendant of `StudioProvider`, passing a ref to
 * the instance's root DOM node.
 *
 * The listener acts only when keyboard focus is within `rootRef.current` (or, when
 * nothing is focused, when this instance's root was the most recently focused one),
 * so mounting two `<Studio>`/`<StudioDashboard>` instances on the same page no longer
 * makes one Ctrl+Z undo an action in BOTH of them.
 *
 * The `Studio` component calls this automatically (via `StudioContent`). When building
 * a composable layout, call it yourself in the component that owns the keyboard scope.
 *
 * @example
 * ```tsx
 * function MyDashboard() {
 *   const rootRef = React.useRef<HTMLDivElement>(null);
 *   useStudioKeyboardShortcuts(rootRef);
 *   return <div ref={rootRef}><StudioCanvas /></div>;
 * }
 * ```
 */
export function useStudioKeyboardShortcuts(rootRef: React.RefObject<HTMLElement | null>) {
  const controller = useStudioController();

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return undefined;
    }

    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      if (target.isContentEditable) {
        return true;
      }
      return Boolean(
        target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'),
      );
    };

    // This instance owns the shortcut only when the keyboard focus lives within its own
    // root DOM node. When nothing is focused (focus on `<body>` / lost), fall back to the
    // instance whose root was focused most recently, so exactly one instance responds.
    const isActiveInstance = () => {
      const active = root.ownerDocument.activeElement;
      if (active && root.contains(active)) {
        return true;
      }
      return lastFocusedRoot === root;
    };

    const handleFocusIn = () => {
      lastFocusedRoot = root;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        isEditableTarget(event.target) ||
        !isActiveInstance()
      ) {
        return;
      }

      const key = event.key.toLowerCase();

      // Redo: Cmd+Shift+Z or Ctrl+Y
      if ((key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)) {
        if (controller.canRedo()) {
          event.preventDefault();
          controller.redo();
        }
        return;
      }

      // Undo: Cmd+Z / Ctrl+Z (no shift)
      if (key === 'z' && !event.shiftKey) {
        if (controller.canUndo()) {
          event.preventDefault();
          controller.undo();
        }
      }
    };

    root.addEventListener('focusin', handleFocusIn);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      root.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('keydown', handleKeyDown);
      if (lastFocusedRoot === root) {
        lastFocusedRoot = null;
      }
    };
  }, [controller, rootRef]);
}
