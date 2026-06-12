'use client';
import * as React from 'react';
import { Box, Collapse, Stack, Switch, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

export interface CollapsibleFeatureSectionProps {
  label: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  children: React.ReactNode;
}

/**
 * A collapsible section with a labeled header row containing a switch toggle on the
 * right and an expand/collapse chevron on the left.  The switch turning ON also
 * expands the panel; turning OFF collapses it.  The chevron (and header row) toggle
 * expanded state independently when the switch is already on.
 */
export function CollapsibleFeatureSection({
  label,
  enabled,
  onToggle,
  children,
}: CollapsibleFeatureSectionProps) {
  const [expanded, setExpanded] = React.useState(false);

  const handleSwitch = (next: boolean) => {
    onToggle(next);
    if (next) {
      setExpanded(true);
    } else {
      setExpanded(false);
    }
  };

  const handleHeaderClick = () => {
    setExpanded((prev) => !prev);
  };

  const isOpen = expanded;
  const Chevron = isOpen ? ExpandMoreIcon : ChevronRightIcon;

  return (
    <Box
      sx={{
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <Box
        onClick={handleHeaderClick}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
          cursor: 'default',
          userSelect: 'none',
        }}
      >
        <Chevron
          sx={{
            fontSize: 18,
            color: 'text.secondary',
            flexShrink: 0,
          }}
        />
        <Typography
          variant="body2"
          sx={{ flexGrow: 1, color: enabled ? 'text.primary' : 'text.disabled' }}
        >
          {label}
        </Typography>
        {/* Stop click from toggling expand when clicking the switch */}
        <Box onClick={(evt) => evt.stopPropagation()}>
          <Switch
            size="small"
            checked={enabled}
            onChange={(evt) => handleSwitch(evt.target.checked)}
          />
        </Box>
      </Box>

      {/* Collapsible content */}
      <Collapse in={isOpen}>
        <Stack
          spacing={1.5}
          sx={{
            px: 1.5,
            pb: 1.5,
            opacity: enabled ? 1 : 0.45,
            pointerEvents: enabled ? 'auto' : 'none',
          }}
        >
          {children}
        </Stack>
      </Collapse>
    </Box>
  );
}
