'use client';
import * as React from 'react';

export interface BufferedInput<T> {
  /** The value to display in the control. */
  value: T;
  /** `true` once the user has typed into the buffer and before the next commit/resync. */
  dirty: boolean;
  /**
   * Advisory message explaining a commit that REJECTED or ADJUSTED the typed value. A revert
   * is otherwise indistinguishable from "nothing happened", so the user retypes the same
   * out-of-range value and watches it vanish again. Cleared by the next edit and by any
   * external change to the committed value.
   */
  notice: string | undefined;
  /** Record a user edit: shows `next`, marks the buffer dirty, and clears any standing notice. */
  setValue: (next: T) => void;
  /**
   * Finish a commit: show `next`, clear `dirty`, and set (or, with no second argument, clear)
   * the advisory `notice`. Call it whether the commit was accepted (`next` = the committed
   * value) or rejected (`next` = the value snapped back to, plus a `notice`).
   */
  settle: (next: T, notice?: string) => void;
}

/**
 * The ONE buffered-input primitive behind every free-text / numeric control in the compose drawer.
 * Two behaviours it centralizes, both previously re-implemented per control — correctly in two
 * places (`FormatPanel`, `TextSetupPanel`) and incorrectly in eleven others:
 *
 *  - **The resync is DIRTY-AWARE.** A naive `useEffect(() => setText(value), [value, id])`
 *    discards in-flight typing on ANY external write to the same widget. That is not
 *    hypothetical: the compose drawer and the AI chat panel are usable at the same time and
 *    the AI tool surface includes `update_widget`, so a concurrent write (or an undo from a
 *    keyboard shortcut) landed mid-keystroke and silently threw the user's edit away. A dirty
 *    buffer keeps its text; a clean one still tracks the store, so undo/redo and external
 *    edits are reflected exactly as before.
 *  - **`identity` gates the discard.** Re-pointing a control at a DIFFERENT entity that
 *    happens to hold the same value (typically `''` — neither widget has the colour set)
 *    never changes `value`, so a value-only dependency cannot tell "same value, different
 *    entity" from "no change" and a still-dirty buffer commits onto the new entity on the
 *    next blur. Pass whatever identifies the edited entity: `widgetId`, or
 *    `` `${widgetId}:${ann.id}` `` for a per-row control. An identity change is the ONE case
 *    that discards a dirty buffer — an uncommitted edit must never leak onto another entity.
 *
 * Callers own their own validation/parsing: they read `value`/`dirty` in a `commit()` of
 * their own, write to the store, then `settle(...)` with the text to display. The hook
 * deliberately commits nothing itself — the write path differs per control (undoable config
 * patch, `updateWidget`, clamped, reverted…). Callers must ALSO keep the no-op guard that
 * belongs with the write: `dirty` means "was typed in", NOT "differs from the stored value",
 * so a buffer edited and hand-restored before blur must not push an undo entry whose content
 * matches its predecessor.
 *
 * @param committed The value currently stored in the doc, in the control's display type.
 * @param identity  Identifies the entity being edited. Changing it discards a dirty buffer.
 */
export function useBufferedInput<T>(committed: T, identity: string): BufferedInput<T> {
  const [state, setState] = React.useState<{ value: T; dirty: boolean; notice?: string }>({
    value: committed,
    dirty: false,
    notice: undefined,
  });

  // Tracks which entity the buffer was last synced FOR, so an identity change can be told
  // apart from an external edit to the entity already being edited. Only the former is
  // allowed to discard a dirty buffer.
  const syncedIdentityRef = React.useRef(identity);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered value mirrors the committed one; the reset is deliberate and gated on `identity` (see above)
  React.useEffect(() => {
    const identityChanged = syncedIdentityRef.current !== identity;
    syncedIdentityRef.current = identity;
    // react-doctor-disable-next-line react-doctor/no-derived-state -- locally buffered editable value; committed by the caller on blur/Enter
    setState((prev) => {
      if (identityChanged) {
        return { value: committed, dirty: false, notice: undefined };
      }
      if (prev.dirty) {
        // In-flight typing wins over an external write to the same entity.
        return prev;
      }
      if (Object.is(prev.value, committed) && prev.notice === undefined) {
        return prev;
      }
      return { value: committed, dirty: false, notice: undefined };
    });
  }, [committed, identity]);

  const setValue = React.useCallback((next: T) => {
    setState({ value: next, dirty: true, notice: undefined });
  }, []);

  const settle = React.useCallback((next: T, notice?: string) => {
    setState({ value: next, dirty: false, notice });
  }, []);

  return { value: state.value, dirty: state.dirty, notice: state.notice, setValue, settle };
}
