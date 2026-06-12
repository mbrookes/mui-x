'use client';
import * as React from 'react';
import { Box, Typography } from '@mui/material';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import { useStudioLocaleText } from '../context';

export interface StudioNoDataOverlayProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Override the default message. */
  message?: string;
  /** Height of the overlay container. Used for chart widgets. */
  height?: number | string;
}

/**
 * Centered "No data" overlay shown when a widget has zero rows after filtering.
 * Used by chart, grid, and KPI widgets.
 */
export function StudioNoDataOverlay({ message, height, style, ...rest }: StudioNoDataOverlayProps) {
  const localeText = useStudioLocaleText();
  return (
    <Box
      role="status"
      aria-live="polite"
      aria-atomic="true"
      {...rest}
      style={height != null ? { height, ...style } : style}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        color: 'text.disabled',
        py: 4,
      }}
    >
      <InboxOutlinedIcon sx={{ fontSize: 32, opacity: 0.5 }} />
      <Typography variant="body2">{message ?? localeText.widgetNoData}</Typography>
    </Box>
  );
}
