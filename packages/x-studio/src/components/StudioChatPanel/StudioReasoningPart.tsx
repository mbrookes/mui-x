'use client';

import * as React from 'react';
import { Box, Collapse, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

// ── StudioReasoningPart — "Thinking…" indicator + collapsible reasoning ────────

export interface ReasoningPartProps {
  part: { text: string; state?: string };
}

export function StudioReasoningPart({ part }: ReasoningPartProps) {
  const localeText = useStudioLocaleText();
  const [expanded, setExpanded] = React.useState(false);
  const reasoningRegionId = React.useId();
  const isStreaming = part.state === 'streaming';

  // While waiting for the first response: show "Thinking…" with animated ellipsis.
  if (isStreaming && !part.text) {
    return (
      <Typography
        variant="caption"
        color="text.secondary"
        role="status"
        sx={{ display: 'block', fontStyle: 'italic', px: 0.5, py: 0.25 }}
      >
        {localeText.chatReasoningThinkingLabel}
      </Typography>
    );
  }

  // No content after completion: hide the part entirely.
  if (!part.text) {
    return null;
  }

  // Completed with content: collapsible "Reasoning" section.
  return (
    <Box sx={{ my: 0.5, borderRadius: 1, border: 1, borderColor: 'divider', overflow: 'hidden' }}>
      <Box
        component="button"
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={reasoningRegionId}
        sx={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 0.5,
          px: 1,
          py: 0.5,
          bgcolor: 'action.hover',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          '&:hover': { bgcolor: 'action.selected' },
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
          {localeText.chatReasoningSectionLabel}
        </Typography>
        <ExpandMoreIcon
          aria-hidden
          sx={{
            fontSize: 16,
            color: 'text.secondary',
            transform: expanded ? 'rotate(180deg)' : 'none',
            transition: 'transform 200ms',
          }}
        />
      </Box>
      <Collapse in={expanded}>
        <Typography
          id={reasoningRegionId}
          variant="caption"
          component="pre"
          sx={{
            display: 'block',
            m: 0,
            p: 1,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'text.secondary',
          }}
        >
          {part.text}
        </Typography>
      </Collapse>
    </Box>
  );
}
