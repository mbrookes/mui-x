'use client';
import * as React from 'react';
import { Box } from '@mui/material';
import CreateIcon from '@mui/icons-material/Create';

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
  size?: number;
}) {
  // Finding 2.9: a native `<input type="color">`'s React `onChange` (mapped to the
  // native `input` event) fires continuously while the user drags around the OS color
  // wheel — wiring it straight to `onChange`/`controller.updateWidgetConfig` committed
  // dozens of undoable steps for a single picker drag. Buffer the live drag value
  // locally (so the swatch itself still tracks the cursor for visual feedback) and only
  // forward the final value to `onChange` on the native `change` event, which the
  // browser fires exactly once, when the picker is closed / the drag ends. React does
  // not expose a distinct prop for the native `change` event on this element, so the
  // final-value listener is attached directly via a ref.
  const [draftValue, setDraftValue] = React.useState(value);
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered draft mirrors the committed value; resync on external change (undo/redo, clear)
  React.useEffect(() => {
    setDraftValue(value);
  }, [value]);

  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return undefined;
    }
    const handleCommit = (event: Event) => {
      onChangeRef.current((event.target as HTMLInputElement).value);
    };
    input.addEventListener('change', handleCommit);
    return () => {
      input.removeEventListener('change', handleCommit);
    };
  }, []);

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
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraftValue(event.target.value)}
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
