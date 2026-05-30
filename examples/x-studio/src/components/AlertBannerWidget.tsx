import * as React from 'react';
import { Alert, AlertTitle, Typography } from '@mui/material';
import type { StudioCustomWidgetProps } from '@mui/x-studio';

/**
 * A simple Alert Banner custom widget for the x-studio demo.
 *
 * Reads `widget.config.customConfig.message`, `widget.config.customConfig.title`,
 * and `widget.config.customConfig.severity` to render an MUI `Alert`.
 */
export function AlertBannerWidget({ widget }: StudioCustomWidgetProps) {
  const custom = (widget.config.customConfig ?? {}) as Record<string, unknown>;
  const title = (custom.title as string | undefined) ?? '';
  const message = (custom.message as string | undefined) ?? 'No message configured.';
  const severity = (custom.severity as 'success' | 'info' | 'warning' | 'error' | undefined) ?? 'info';

  return (
    <Alert severity={severity} sx={{ width: '100%' }}>
      {title && <AlertTitle>{title}</AlertTitle>}
      <Typography variant="body2">{message}</Typography>
    </Alert>
  );
}
