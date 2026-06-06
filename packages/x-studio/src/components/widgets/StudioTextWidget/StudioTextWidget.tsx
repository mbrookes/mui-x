'use client';
import * as React from 'react';
import { Box, Typography } from '@mui/material';

import type { StudioWidget } from '../../../models';

export interface StudioTextWidgetProps {
  widget: StudioWidget;
}

const FONT_FAMILY: Record<string, string> = {
  serif: "Georgia, 'Times New Roman', Times, serif",
  monospace: "'Courier New', Courier, monospace",
};

export const StudioTextWidget = React.memo(function StudioTextWidget(props: StudioTextWidgetProps) {
  const { widget } = props;
  const { config } = widget;
  const subtitle = config.textSubtitle?.trim();
  const body = config.textBody?.trim();

  if (!subtitle && !body) {
    return null;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {subtitle ? (
        <Typography
          variant="subtitle1"
          sx={{
            color: config.textSubtitleColor ?? 'text.secondary',
            ...(config.textSubtitleFontFamily && {
              fontFamily: FONT_FAMILY[config.textSubtitleFontFamily],
            }),
            ...(config.textSubtitleFontSize && { fontSize: config.textSubtitleFontSize }),
            ...(config.textSubtitleAlign && { textAlign: config.textSubtitleAlign }),
          }}
        >
          {subtitle}
        </Typography>
      ) : null}
      {body ? (
        <Typography
          variant="body2"
          sx={{
            color: config.textBodyColor ?? 'text.primary',
            whiteSpace: 'pre-wrap',
            ...(config.textBodyFontFamily && {
              fontFamily: FONT_FAMILY[config.textBodyFontFamily],
            }),
            ...(config.textBodyFontSize && { fontSize: config.textBodyFontSize }),
            ...(config.textBodyAlign && { textAlign: config.textBodyAlign }),
          }}
        >
          {body}
        </Typography>
      ) : null}
    </Box>
  );
});
