'use client';

import * as React from 'react';
import { Badge, Box, Typography } from '@mui/material';
import { useStudioLocaleText } from '../../context';

import type { TabbedSidebarPanel } from './TabbedSidebar';

// ── Tab rail entry ────────────────────────────────────────────────────────────

interface TabbedSidebarTabEntryProps {
  panel: TabbedSidebarPanel;
  isActive: boolean;
  /** Roving-tabindex value: 0 for the single focusable tab, -1 for the rest (APG tabs pattern). */
  tabIndex: number;
  /** DOM id for this tab, referenced by its tabpanel's `aria-labelledby`. */
  id?: string;
  /** Id of the tabpanel this tab controls (APG tabs pattern). */
  'aria-controls'?: string;
  onClick: () => void;
  /** Handles Left/Right/Home/End roving-focus navigation; Enter/Space activation is handled locally. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

export const TabbedSidebarTabEntry = React.forwardRef<HTMLDivElement, TabbedSidebarTabEntryProps>(
  function TabbedSidebarTabEntry(
    { isActive, tabIndex, id, 'aria-controls': ariaControls, onClick, onKeyDown, panel },
    ref,
  ) {
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
        ref={ref}
        role="tab"
        id={id}
        aria-controls={ariaControls}
        tabIndex={tabIndex}
        aria-selected={isActive}
        aria-label={localeText.sidebarPanelToggleAriaLabel(isActive, panel.label)}
        onClick={onClick}
        onKeyDown={(evt) => {
          if (evt.key === 'Enter' || evt.key === ' ') {
            evt.preventDefault();
            onClick();
            return;
          }
          onKeyDown?.(evt);
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
  },
);
