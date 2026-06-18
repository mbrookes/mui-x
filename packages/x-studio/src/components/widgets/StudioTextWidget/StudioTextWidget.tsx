'use client';
import * as React from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';

import type { StudioWidget } from '../../../models';
import { useTextWidgetAI } from './useTextWidgetAI';
import { renderMarkdown } from './renderMarkdown';

export interface StudioTextWidgetProps {
  widget: StudioWidget;
  /** Ref that receives the AI refresh function when AI mode is active. */
  aiRefreshRef?: React.MutableRefObject<(() => void) | null>;
}

const FONT_FAMILY: Record<string, string> = {
  serif: "Georgia, 'Times New Roman', Times, serif",
  monospace: "'Courier New', Courier, monospace",
};

// ── AI content sub-component ──────────────────────────────────────────────────

function TextWidgetAIContent({
  widget,
  aiRefreshRef,
}: {
  widget: StudioWidget;
  aiRefreshRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const { markdown, loading, error, refresh } = useTextWidgetAI(
    widget.id,
    widget.config.textBody ?? '',
  );

  React.useEffect(() => {
    if (aiRefreshRef) {
      aiRefreshRef.current = refresh;
    }
    return () => {
      if (aiRefreshRef) {
        aiRefreshRef.current = null;
      }
    };
  }, [aiRefreshRef, refresh]);

  return (
    <Box sx={{ position: 'relative', minHeight: 80, flexGrow: 1 }}>
      {/* Content — shown when available, dimmed while refreshing */}
      {markdown && (
        <Box
          sx={{
            p: 2,
            typography: 'body2',
            opacity: loading ? 0.4 : 1,
            transition: 'opacity 0.2s',
            '& h1,& h2,& h3,& h4,& h5,& h6': { typography: 'subtitle2', mt: 1.5, mb: 0.5 },
            '& p': { mt: 0, mb: 1 },
            '& p:last-child': { mb: 0 },
            '& ul,& ol': { pl: 2.5, mt: 0, mb: 1 },
            '& li': { mb: 0.25 },
            '& strong': { fontWeight: 'fontWeightBold' },
          }}
        >
          {renderMarkdown(markdown)}
        </Box>
      )}
      {/* Error — shown only when there is no content to display */}
      {error && !markdown && !loading && (
        <Box sx={{ p: 2 }}>
          <Typography variant="body2" color="error.main">
            {error}
          </Typography>
        </Box>
      )}
      {/* Centered spinner overlay — shown whenever the agent is running */}
      {loading && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CircularProgress size={24} />
        </Box>
      )}
    </Box>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export const StudioTextWidget = React.memo(function StudioTextWidget(props: StudioTextWidgetProps) {
  const { widget, aiRefreshRef } = props;
  const { config } = widget;

  if (config.textAiEnabled && config.textBody?.trim()) {
    return <TextWidgetAIContent widget={widget} aiRefreshRef={aiRefreshRef} />;
  }

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
