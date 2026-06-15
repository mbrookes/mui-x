'use client';
import * as React from 'react';
import { Box, BoxProps, Typography } from '@mui/material';
import ErrorIcon from '@mui/icons-material/Error';
import { useStudioLocaleText } from '../context';

interface StudioWidgetErrorOverlayProps extends Omit<BoxProps, 'role'> {
  /** Custom error message. Falls back to the `widgetLoadError` locale token. */
  message?: string;
  /** Height of the overlay container (optional, used by chart widget). */
  height?: number | string;
}

/**
 * Centered error overlay shown when a widget fails to load data.
 * Uses `role="alert"` so screen readers announce the message immediately.
 */
export function StudioWidgetErrorOverlay({
  message,
  height,
  sx: sxProp,
  ...rest
}: StudioWidgetErrorOverlayProps) {
  const localeText = useStudioLocaleText();
  return (
    <Box
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      {...rest}
      sx={[
        {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          color: 'error.main',
          py: 4,
          ...(height != null && { height }),
        },
        ...(Array.isArray(sxProp) ? sxProp : [sxProp]),
      ]}
    >
      <ErrorIcon sx={{ fontSize: 32, opacity: 0.7 }} />
      <Typography variant="body2">{message ?? localeText.widgetLoadError}</Typography>
    </Box>
  );
}
