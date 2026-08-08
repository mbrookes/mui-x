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
export interface UseStudioKeyboardShortcutsOptions {
  /**
   * Called after Delete/Backspace removed the selected widget.
   *
   * Exists so the announcement and any focus restoration live with the component that owns the
   * live region and the DOM, rather than in this hook — which has neither, and would need both to
   * do the job itself.
   */
  onWidgetRemoved?: () => void;
}

export function useStudioKeyboardShortcuts(
  rootRef: React.RefObject<HTMLElement | null>,
  options?: UseStudioKeyboardShortcutsOptions,
) {
  const controller = useStudioController();
  // The callback is mirrored into a ref so the listener effect keeps depending on
  // `[controller, rootRef]` only. A host passing an inline arrow (the normal case) would otherwise
  // re-register the window listener on every render — the package-wide convention documented in
  // ARCHITECTURE.md under render-phase ref writes.
  const onWidgetRemovedRef = React.useRef(options?.onWidgetRemoved);
  onWidgetRemovedRef.current = options?.onWidgetRemoved;

  React.useEffect(() => {
    const onWidgetRemoved = () => onWidgetRemovedRef.current?.();
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
        event.altKey ||
        isEditableTarget(event.target) ||
        !isActiveInstance()
      ) {
        return;
      }

      // Delete / Backspace removes the SELECTED widget. Deliberately unmodified: it is the
      // convention every canvas editor uses, and a keyboard-only author reaching the delete action
      // otherwise has to open the card's action menu — the one authoring action with no direct
      // keyboard route (AG_STUDIO_GAP_ANALYSIS XS-A11Y-001).
      //
      // Guarded four ways, because an unmodified destructive key is easy to fire by accident:
      // `isEditableTarget` above (typing a filter value must not delete a widget), edit mode only,
      // a widget actually selected, and the selection must still exist in the doc — a stale id
      // survives an undo that removed it.
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const state = controller.store.state;
        if (state.session.mode !== 'edit') {
          return;
        }
        const selectedWidgetId = state.session.shell.selectedWidgetId;
        if (!selectedWidgetId || !Object.hasOwn(state.doc.widgets, selectedWidgetId)) {
          return;
        }
        event.preventDefault();
        controller.removeWidget(selectedWidgetId);
        onWidgetRemoved?.();
        return;
      }

      if (!(event.metaKey || event.ctrlKey)) {
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
