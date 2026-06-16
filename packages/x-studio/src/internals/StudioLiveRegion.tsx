'use client';
import * as React from 'react';
import { Box } from '@mui/material';

export type StudioAnnounce = (message: string) => void;

const StudioAnnounceContext = React.createContext<StudioAnnounce>(() => {});

/**
 * Returns a function that posts a message to the Studio polite live region, so
 * pointer/keyboard interactions that change layout without moving focus (panel
 * open/close, widget move, column resize, drop) are announced to assistive
 * technology. No-ops when used outside `StudioLiveRegionProvider`.
 */
export function useStudioAnnounce(): StudioAnnounce {
  return React.use(StudioAnnounceContext);
}

const visuallyHiddenSx = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  p: 0,
  m: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

/**
 * Provides a single shared `aria-live="polite"` region for the Studio surface.
 * The message is cleared and re-set on a microtask so that two identical
 * consecutive announcements are still read out.
 */
export function StudioLiveRegionProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = React.useState('');
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = React.useCallback<StudioAnnounce>((next) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    // Clear first so an identical repeat message still triggers a DOM change.
    setMessage('');
    timeoutRef.current = setTimeout(() => setMessage(next), 50);
  }, []);

  React.useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  return (
    <StudioAnnounceContext.Provider value={announce}>
      {children}
      <Box role="status" aria-live="polite" sx={visuallyHiddenSx}>
        {message}
      </Box>
    </StudioAnnounceContext.Provider>
  );
}
