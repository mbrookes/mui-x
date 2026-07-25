'use client';
import * as React from 'react';
import { Box, BoxProps, Button, Typography } from '@mui/material';
import ErrorIcon from '@mui/icons-material/Error';
import { useStudioLocaleText } from '../context';

interface StudioWidgetErrorOverlayProps extends Omit<BoxProps, 'role'> {
  /** Custom error message. Falls back to the `widgetLoadError` locale token. */
  message?: string;
  /** Height of the overlay container (optional, used by chart widget). */
  height?: number | string;
  /**
   * When provided, a "Retry" button is rendered below the message.
   *
   * `StudioWidgetErrorBoundary` passes its own state reset here: without a user-driven
   * retry affordance, a boundary that latched on a transient failure (one bad adapter
   * batch, a formatter that threw on a since-replaced row) could only recover if one of
   * its `resetKeys` happened to change. Under `StudioDashboard` (`featureFlags.compose:
   * false`) there is no config-editing UI at all, so that recovery path may never fire
   * and the widget would stay on the fallback for the rest of the session.
   */
  onRetry?: () => void;
}

/**
 * Centered error overlay shown when a widget fails to load data.
 * Uses `role="alert"` so screen readers announce the message immediately.
 */
export function StudioWidgetErrorOverlay({
  message,
  height,
  onRetry,
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
      {onRetry && (
        // Reuses the existing `chatMessageRetryTooltip` token rather than adding a new
        // one — same call the map widget's geography-retry button makes (`StudioMapWidget`).
        <Button size="small" onClick={onRetry}>
          {localeText.chatMessageRetryTooltip}
        </Button>
      )}
    </Box>
  );
}
