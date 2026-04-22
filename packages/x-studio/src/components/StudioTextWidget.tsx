import * as React from 'react';
import { Box, Typography } from '@mui/material';

import type { StudioWidget } from '../models';

export interface StudioTextWidgetProps {
  widget: StudioWidget;
}

export function StudioTextWidget(props: StudioTextWidgetProps) {
  const { widget } = props;
  const subtitle = widget.config.textSubtitle?.trim();
  const body = widget.config.textBody?.trim();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {subtitle ? (
        <Typography variant="subtitle2" color="text.secondary">
          {subtitle}
        </Typography>
      ) : null}
      <Typography
        variant="body2"
        color={body ? 'text.primary' : 'text.secondary'}
        sx={{ whiteSpace: 'pre-wrap' }}
      >
        {body || 'Add body text in the Compose drawer.'}
      </Typography>
    </Box>
  );
}
