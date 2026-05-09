'use client';

import * as React from 'react';
import { Badge, Box, Divider, IconButton, Typography } from '@mui/material';
import ChevronDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';

import { useStudioController, useStudioSelector, selectShell } from '../context';
import type { StudioDrawer } from '../models';

export const DRAWER_WIDTH = 215;
export const COLLAPSED_WIDTH = 36;

/**
 * Context that lets content rendered inside a DrawerPanel's scroll area inject
 * a node into the fixed subheader slot (above the scroll, below the title bar).
 */
interface DrawerSubheaderContextValue {
  setSubheader: (node: React.ReactNode) => void;
}
export const DrawerSubheaderContext = React.createContext<DrawerSubheaderContextValue | null>(null);

/**
 * Call inside a DrawerPanel child to render `node` in the fixed subheader slot.
 * Uses useLayoutEffect so the node appears on the first paint with no flash.
 */
export function useDrawerSubheader(node: React.ReactNode) {
  const ctx = React.use(DrawerSubheaderContext);
  React.useLayoutEffect(() => {
    ctx?.setSubheader(node);
    return () => ctx?.setSubheader(null);
  }, [ctx, node]);
}

export interface DrawerPanelProps {
  drawer: StudioDrawer;
  title: string;
  icon?: React.ReactNode;
  badge?: number;
  onBack?: () => void;
  /** Rendered between the title divider and the scrollable content — never scrolls away. */
  subheader?: React.ReactNode;
  children?: React.ReactNode;
}

export function DrawerPanel(props: DrawerPanelProps) {
  const { badge, children, drawer, icon, onBack, subheader: subheaderProp, title } = props;
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const open = shell.openDrawers[drawer];
  const [injectedSubheader, setInjectedSubheader] = React.useState<React.ReactNode>(null);
  const ctxValue = React.useMemo<DrawerSubheaderContextValue>(
    () => ({ setSubheader: setInjectedSubheader }),
    [],
  );
  const subheader = subheaderProp ?? injectedSubheader;

  if (!open) {
    return (
      <Box
        role="button"
        tabIndex={0}
        aria-label={`Open ${title} panel`}
        onClick={() => controller.setDrawerOpen(drawer, true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            controller.setDrawerOpen(drawer, true);
          }
        }}
        sx={{
          width: COLLAPSED_WIDTH,
          flexShrink: 0,
          borderRight: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          cursor: 'pointer',
          pt: 2,
          pb: 1,
          gap: 1,
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 },
        }}
      >
        {badge != null && badge > 0 ? (
          <Badge badgeContent={badge} color="primary" sx={{ mb: 1 }}>
            <Typography
              variant="caption"
              sx={{
                color: 'text.primary',
                writingMode: 'vertical-rl',
                transform: 'rotate(180deg)',
                fontWeight: 600,
                letterSpacing: 1,
                textTransform: 'uppercase',
                userSelect: 'none',
              }}
            >
              {title}
            </Typography>
          </Badge>
        ) : (
          <Typography
            variant="caption"
            sx={{
              color: 'text.primary',
              writingMode: 'vertical-rl',
              transform: 'rotate(180deg)',
              fontWeight: 600,
              letterSpacing: 1,
              textTransform: 'uppercase',
              userSelect: 'none',
            }}
          >
            {title}
          </Typography>
        )}
        <IconButton
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            controller.setDrawerOpen(drawer, true);
          }}
          aria-label={`Open ${title} panel`}
          tabIndex={-1}
        >
          <ChevronDownIcon fontSize="small" />
        </IconButton>
      </Box>
    );
  }

  return (
    <DrawerSubheaderContext.Provider value={ctxValue}>
      <Box
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          borderRight: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{ px: 1.5, py: 1, display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 48 }}
        >
          {onBack ? (
            <IconButton
              size="small"
              onClick={onBack}
              aria-label="Close widget configuration"
              sx={{ mr: 0.5 }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          ) : (
            icon && <Box sx={{ display: 'flex', color: 'action.active', mr: 0.5 }}>{icon}</Box>
          )}
          <Typography variant="subtitle2" sx={{ color: 'text.primary', flexGrow: 1 }} noWrap>
            {title}
          </Typography>
          {badge != null && badge > 0 && (
            <Badge badgeContent={badge} color="primary" sx={{ mr: 1 }} />
          )}
          <IconButton
            size="small"
            onClick={() => controller.setDrawerOpen(drawer, false)}
            aria-label={`Close ${title} panel`}
          >
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Box>
        <Divider />
        {subheader}
        <Box sx={{ p: 1.5, overflow: 'auto', flexGrow: 1 }}>{children}</Box>
      </Box>
    </DrawerSubheaderContext.Provider>
  );
}
