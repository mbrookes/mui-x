'use client';

import * as React from 'react';
import { Badge, Box, Typography } from '@mui/material';
import { useStudioLocaleText } from '../../context';

import type { TabbedSidebarPanel } from './TabbedSidebar';

// ── Tab rail entry ────────────────────────────────────────────────────────────

export interface TabbedSidebarTabEntryProps {
  panel: TabbedSidebarPanel;
  isActive: boolean;
  onClick: () => void;
}

export function TabbedSidebarTabEntry({ isActive, onClick, panel }: TabbedSidebarTabEntryProps) {
  const localeText = useStudioLocaleText();
  const label = (
    <Typography
      variant="caption"
      sx={{
        writingMode: 'vertical-rl',
        fontWeight: 600,
        letterSpacing: 1,
        textTransform: 'uppercase',
        userSelect: 'none',
        color: isActive ? 'primary.main' : 'text.secondary',
      }}
    >
      {panel.label}
    </Typography>
  );

  return (
    <Box
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      aria-label={localeText.sidebarPanelToggleAriaLabel(isActive, panel.label)}
      onClick={onClick}
      onKeyDown={(evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          onClick();
        }
      }}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.75,
        px: 0.5,
        py: 1.5,
        cursor: 'default',

        bgcolor: isActive ? 'action.selected' : 'transparent',
        transition: 'background-color 0.15s, border-color 0.15s',
        '&:hover': { bgcolor: isActive ? 'action.selected' : 'action.hover' },
        '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 },
      }}
    >
      {panel.icon && (
        <Box
          sx={{
            display: 'flex',
            color: isActive ? 'primary.main' : 'action.active',
            fontSize: 18,
            '& svg': { fontSize: 'inherit' },
          }}
        >
          {panel.icon}
        </Box>
      )}
      {panel.badge != null && panel.badge > 0 && !isActive ? (
        <Badge badgeContent={panel.badge} color="primary">
          {label}
        </Badge>
      ) : (
        label
      )}
    </Box>
  );
}
