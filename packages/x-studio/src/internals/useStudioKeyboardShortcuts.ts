'use client';

import * as React from 'react';
import { useStudioController } from '../context';

/**
 * Registers Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z / Ctrl+Y (redo) keyboard
 * shortcuts on the window. Call this once inside a component that is a
 * descendant of `StudioProvider`.
 *
 * The `Studio` component calls this automatically. When building a composable
 * layout, call it yourself in the component that owns the keyboard scope.
 *
 * @example
 * ```tsx
 * function MyDashboard() {
 *   useStudioKeyboardShortcuts();
 *   return <StudioCanvas />;
 * }
 * ```
 */
export function useStudioKeyboardShortcuts() {
  const controller = useStudioController();

  React.useEffect(() => {
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

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        isEditableTarget(event.target)
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

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [controller]);
}
