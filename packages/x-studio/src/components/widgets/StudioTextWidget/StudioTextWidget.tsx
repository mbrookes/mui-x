'use client';
import * as React from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';

import type { StudioWidgetOf } from '../../../models';
import { useStudioLocaleText } from '../../../context';
import { useTextWidgetAI } from './useTextWidgetAI';
import { renderMarkdown } from './renderMarkdown';
import { resolveTextFontFamily } from '../../../internals/textFontFamily';
import {
  sanitizeCssColor,
  sanitizeFontSize,
  isSafeTextAlign,
} from '../../../internals/cssValueValidation';

export interface StudioTextWidgetProps {
  widget: StudioWidgetOf<'text'>;
  /** ID of the page this widget belongs to. Used to scope the AI snapshot to the
   * widget's own page rather than whichever page happens to be active (finding 2.x) —
   * required, matching every other built-in widget kind's `pageId` prop. */
  pageId: string;
  /** Ref that receives the AI refresh function when AI mode is active. */
  aiRefreshRef?: React.MutableRefObject<(() => void) | null>;
}

// ── AI content sub-component ──────────────────────────────────────────────────

function TextWidgetAIContent({
  widget,
  pageId,
  aiRefreshRef,
}: {
  widget: StudioWidgetOf<'text'>;
  pageId: string;
  aiRefreshRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const localeText = useStudioLocaleText();
  const { markdown, loading, error, refresh } = useTextWidgetAI(
    widget.id,
    pageId,
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
          <CircularProgress size={24} aria-label={localeText.widgetLoadingLabel} />
        </Box>
      )}
    </Box>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export const StudioTextWidget = React.memo(function StudioTextWidget(props: StudioTextWidgetProps) {
  const { widget, pageId, aiRefreshRef } = props;
  const { config } = widget;

  if (config.textAiEnabled && config.textBody?.trim()) {
    return <TextWidgetAIContent widget={widget} pageId={pageId} aiRefreshRef={aiRefreshRef} />;
  }

  const subtitle = config.textSubtitle?.trim();
  const body = config.textBody?.trim();

  if (!subtitle && !body) {
    return null;
  }

  // Hoisted rather than called twice inside each `sx` below (once in the spread's condition and
  // again for its value). Two identical guard calls covering one property is not belt-and-braces:
  // it is a pair in which EITHER call can be deleted with the whole project still green, because
  // whichever one survives rejects the value on its own. Measured on both fields — each of the
  // four calls survived individually. One call, one local, one observable site; the same shape
  // `StudioWidgetCard` already uses for its title font size.
  const subtitleFontSize = sanitizeFontSize(config.textSubtitleFontSize);
  const bodyFontSize = sanitizeFontSize(config.textBodyFontSize);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {subtitle ? (
        <Typography
          variant="subtitle1"
          sx={{
            // `sanitizeCssColor`/`sanitizeFontSize` validate doc-authored config values
            // before they reach `sx` — Emotion does not escape interpolated property
            // values, so an unvalidated string here would let a hostile serialized
            // dashboard or AI `update_widget` call inject arbitrary CSS (finding 1).
            color: sanitizeCssColor(config.textSubtitleColor, 'text.secondary'),
            ...(config.textSubtitleFontFamily && {
              fontFamily: resolveTextFontFamily(config.textSubtitleFontFamily),
            }),
            ...(subtitleFontSize !== undefined && {
              fontSize: subtitleFontSize,
            }),
            ...(isSafeTextAlign(config.textSubtitleAlign) && {
              textAlign: config.textSubtitleAlign,
            }),
          }}
        >
          {subtitle}
        </Typography>
      ) : null}
      {body ? (
        <Typography
          variant="body2"
          sx={{
            color: sanitizeCssColor(config.textBodyColor, 'text.primary'),
            whiteSpace: 'pre-wrap',
            ...(config.textBodyFontFamily && {
              fontFamily: resolveTextFontFamily(config.textBodyFontFamily),
            }),
            ...(bodyFontSize !== undefined && {
              fontSize: bodyFontSize,
            }),
            ...(isSafeTextAlign(config.textBodyAlign) && {
              textAlign: config.textBodyAlign,
            }),
          }}
        >
          {body}
        </Typography>
      ) : null}
    </Box>
  );
});
