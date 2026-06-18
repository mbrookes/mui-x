'use client';
import * as React from 'react';
import { Box, Collapse, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useStudioLocaleText } from '../../context';

interface FilterCardProps {
  /** Primary label shown in the card header (field name or "Rank by Revenue"). */
  title: string;
  /** Summary text shown in the header when the card is collapsed. */
  summary: string;
  onRemove: () => void;
  children: React.ReactNode;
  /**
   * Whether the card starts expanded. Defaults to `false` (collapsed).
   * Pass `true` for freshly-created filters so the user can immediately
   * configure them; pass `false` (or omit) for filters loaded from a preset
   * or persisted state so the summary is shown by default.
   */
  initialExpanded?: boolean;
}

/**
 * Collapsible card used by both PageFilterRow and WidgetFilterRow.
 */
export function FilterCard({
  title,
  summary,
  onRemove,
  children,
  initialExpanded = false,
}: FilterCardProps) {
  const [expanded, setExpanded] = React.useState(initialExpanded);
  const regionId = React.useId();
  const localeText = useStudioLocaleText();

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
      {/* Header row */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 0.5,
          py: 0.5,
        }}
      >
        <Box
          component="button"
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-controls={regionId}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            flexGrow: 1,
            minWidth: 0,
            border: 0,
            m: 0,
            p: 0,
            background: 'transparent',
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            userSelect: 'none',
            borderRadius: 1,
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          {/* Decorative chevron — rendered as a span so it is not a nested button. */}
          <IconButton
            component="span"
            size="small"
            tabIndex={-1}
            aria-hidden
            sx={{ flexShrink: 0, pointerEvents: 'none' }}
          >
            {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
          </IconButton>

          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              component="span"
              noWrap
              sx={{ display: 'block', fontWeight: 'medium', lineHeight: 1.3 }}
            >
              {title}
            </Typography>
            {!expanded && (
              <Typography
                variant="caption"
                component="span"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                {summary}
              </Typography>
            )}
          </Box>
        </Box>

        <IconButton
          size="small"
          onClick={onRemove}
          aria-label={localeText.filterRemoveAriaLabel}
          sx={{ flexShrink: 0 }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Body */}
      <Collapse in={expanded}>
        <Box id={regionId}>{children}</Box>
      </Collapse>
    </Box>
  );
}
