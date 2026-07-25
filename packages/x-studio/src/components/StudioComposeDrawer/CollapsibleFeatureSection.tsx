'use client';
import * as React from 'react';
import { Box, Collapse, Stack, Switch, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

interface CollapsibleFeatureSectionProps {
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
  const regionId = React.useId();

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
        bgcolor: 'action.hover',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
        }}
      >
        <Box
          component="button"
          type="button"
          onClick={handleHeaderClick}
          aria-expanded={isOpen}
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
          <Chevron
            aria-hidden
            sx={{
              fontSize: 18,
              color: 'text.secondary',
              flexShrink: 0,
            }}
          />
          <Typography
            variant="body2"
            component="span"
            sx={{ flexGrow: 1, color: enabled ? 'text.primary' : 'text.disabled' }}
          >
            {label}
          </Typography>
        </Box>
        <Switch
          size="small"
          checked={enabled}
          onChange={(evt) => handleSwitch(evt.target.checked)}
          slotProps={{ input: { 'aria-label': label } }}
        />
      </Box>

      {/* Collapsible content.

          M11: a disabled feature's controls were dimmed with `opacity` and blocked with
          `pointerEvents: 'none'` — which stops the MOUSE only. `Collapse` keeps its children
          mounted (and the header chevron can expand the section while the switch is off), so
          a keyboard user tabbed straight into the controls of a switched-off feature and
          committed config for it. `inert` is the correct primitive: it removes the whole
          subtree from the tab order, from hit-testing AND from the accessibility tree, so
          every input modality agrees with what the dimming already communicates visually.
          `pointerEvents` is kept as a belt-and-braces fallback for engines without `inert`. */}
      <Collapse in={isOpen}>
        <Stack
          id={regionId}
          spacing={1.5}
          {...(enabled ? {} : { inert: true })}
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
