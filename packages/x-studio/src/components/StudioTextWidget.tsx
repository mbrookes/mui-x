import * as React from 'react';
import { Box, Typography } from '@mui/material';

import type { StudioWidget } from '../models';

export interface StudioTextWidgetProps {
  widget: StudioWidget;
}

export const StudioTextWidget = React.memo(function StudioTextWidget(props: StudioTextWidgetProps) {
  const { widget } = props;
  const subtitle = widget.config.textSubtitle?.trim();
  const body = widget.config.textBody?.trim();

  // If both subtitle and body are empty, render nothing (take no space)
  if (!subtitle && !body) {
    return null;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {subtitle ? (
        <Typography variant="subtitle2" color="text.secondary">
          {subtitle}
        </Typography>
      ) : null}
      {body ? (
        <Typography variant="body2" color="text.primary" sx={{ whiteSpace: 'pre-wrap' }}>
          {body}
        </Typography>
      ) : null}
    </Box>
  );
});
