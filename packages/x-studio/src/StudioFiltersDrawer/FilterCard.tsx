'use client';
import * as React from 'react';
import { Box, Collapse, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

export interface FilterCardProps {
  /** Primary label shown in the card header (field name or "Rank by Revenue"). */
  title: string;
  /** Summary text shown in the header when the card is collapsed. */
  summary: string;
  onRemove: () => void;
  children: React.ReactNode;
}

/**
 * Collapsible card used by both PageFilterRow and WidgetFilterRow.
 */
export function FilterCard({ title, summary, onRemove, children }: FilterCardProps) {
  const [expanded, setExpanded] = React.useState(true);

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
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <IconButton size="small" tabIndex={-1} sx={{ flexShrink: 0 }}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>

        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 'medium', lineHeight: 1.3 }}>
            {title}
          </Typography>
          {!expanded && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {summary}
            </Typography>
          )}
        </Box>

        <IconButton
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          aria-label="Remove filter"
          sx={{ flexShrink: 0 }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Body */}
      <Collapse in={expanded}>{children}</Collapse>
    </Box>
  );
}
