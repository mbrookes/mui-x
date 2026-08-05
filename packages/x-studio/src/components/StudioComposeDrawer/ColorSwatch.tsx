'use client';
import * as React from 'react';
import { Box } from '@mui/material';
import CreateIcon from '@mui/icons-material/Create';

import { useBufferedInput } from './useBufferedInput';

/** Returns 'white' or 'black' depending on which contrasts better against the hex color. */
function getContrastColor(hex: string): 'white' | 'black' {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) {
    return 'white';
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? 'black' : 'white';
}

/** A circular color swatch button with a centred crayon icon in a contrasting color. */
export function ColorSwatch({
  value,
  onChange,
  label,
  identity,
  size = 32,
}: {
  value: string;
  onChange: (v: string) => void;
  /**
   * Accessible name for the native color input. REQUIRED, and deliberately has no default:
   * this is a public export, so a hardcoded English fallback would ship untranslated UI to
   * any consumer who omitted it. Callers pass a `localeText` value.
   */
  label: string;
  /**
   * Identifies the entity being edited (e.g. `` `${widgetId}:titleColor` ``). Changing it
   * discards an in-flight picker drag, so an uncommitted colour can never leak onto a
   * different entity that happens to hold the same value. Required for the same reason
   * `ColorInput`'s is: an omitted identity silently disables the discard.
   */
  identity: string;
  size?: number;
}) {
  // A native `<input type="color">`'s React `onChange` (mapped to the
  // native `input` event) fires continuously while the user drags around the OS color
  // wheel — wiring it straight to `onChange`/`controller.updateWidgetConfig` committed
  // dozens of undoable steps for a single picker drag. Buffer the live drag value
  // locally (so the swatch itself still tracks the cursor for visual feedback) and only
  // forward the final value to `onChange` on the native `change` event, which the
  // browser fires exactly once, when the picker is closed / the drag ends. React does
  // not expose a distinct prop for the native `change` event on this element, so the
  // final-value listener is attached directly via a ref.
  //
  // This used to be a hand-rolled `useState` + `useEffect(() => setDraft(value), [value])`
  // — precisely the naive resync `useBufferedInput` exists to replace. It was not
  // dirty-aware, so an AI `update_widget` (the compose drawer and the chat panel are usable
  // at the same time) or an undo landing mid-drag silently threw the picker's in-flight
  // value away. Share the one primitive instead: a dirty buffer keeps the drag, a clean one
  // still tracks the store, and only an `identity` change discards.
  const { value: draftValue, setValue: setDraftValue, settle } = useBufferedInput(value, identity);

  const onChangeRef = React.useRef(onChange);
  // Assigned in an effect rather than during render: a render-phase ref write is a side
  // effect in the render body, which React may discard (a render that never commits) or
  // run twice. The native `change` listener below can only fire after a commit, so reading
  // the value the last COMMITTED render wrote is both safe and correct.
  React.useEffect(() => {
    onChangeRef.current = onChange;
  });

  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return undefined;
    }
    const handleCommit = (event: Event) => {
      const next = (event.target as HTMLInputElement).value;
      // Clear `dirty` before forwarding: the drag is over, so the buffer must go back to
      // tracking the store or the next external write (undo, AI edit, Clear) would be
      // treated as "in-flight typing wins" and ignored forever.
      settle(next);
      onChangeRef.current(next);
    };
    input.addEventListener('change', handleCommit);
    return () => {
      input.removeEventListener('change', handleCommit);
    };
  }, [settle]);

  const iconColor = getContrastColor(draftValue || '#ffffff');
  return (
    <Box
      sx={{
        position: 'relative',
        width: size,
        height: size,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Box
        component="input"
        ref={inputRef}
        type="color"
        value={draftValue || '#ffffff'}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          // React's `onChange` on a text-ish input (which includes `type="color"`) is
          // dispatched for the native `input` event AND the native `change` event. Only
          // the former is a live drag frame; the latter is the commit, already handled by
          // the `change` listener above — and letting it fall through to `setDraftValue`
          // would mark the buffer DIRTY again immediately after `settle` cleared it,
          // leaving it permanently dirty so no later undo/redo/clear could ever resync it.
          if (event.nativeEvent.type === 'change') {
            return;
          }
          setDraftValue(event.target.value);
        }}
        sx={{
          width: size,
          height: size,
          p: 0,
          border: 1,
          borderColor: 'divider',
          borderRadius: '50%',
          cursor: 'default',
          display: 'block',
          '&::-webkit-color-swatch-wrapper': { padding: 0 },
          '&::-webkit-color-swatch': { borderRadius: '50%', border: 'none' },
        }}
        aria-label={label}
      />
      <CreateIcon
        sx={{
          position: 'absolute',
          fontSize: Math.round(size * 0.55),
          color: iconColor,
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
}
