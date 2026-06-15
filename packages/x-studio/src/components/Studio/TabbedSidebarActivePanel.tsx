'use client';

import * as React from 'react';
import { Box, Divider, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { DrawerSubheaderContext, DRAWER_WIDTH } from './DrawerPanelContext';
import type { DrawerSubheaderContextValue } from './DrawerPanelContext';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { TabbedSidebarPanel } from './TabbedSidebar';

// ── Panel content area ────────────────────────────────────────────────────────

interface TabbedSidebarActivePanelProps {
  panel: TabbedSidebarPanel;
  side?: 'left' | 'right';
}

export function TabbedSidebarActivePanel({ panel, side = 'left' }: TabbedSidebarActivePanelProps) {
  const localeText = useStudioLocaleText();
  const [injectedSubheader, setInjectedSubheader] = React.useState<React.ReactNode>(null);
  const ctxValue = React.useMemo<DrawerSubheaderContextValue>(
    () => ({ setSubheader: setInjectedSubheader }),
    [],
  );

  return (
    <DrawerSubheaderContext.Provider value={ctxValue}>
      <Box
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          ...(side === 'right' ? { borderLeft: 1 } : { borderRight: 1 }),
          borderColor: 'divider',
          bgcolor: 'background.paper',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {panel.onBack && (
          <React.Fragment>
            <Box
              sx={{
                px: 1.5,
                py: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                minHeight: 48,
              }}
            >
              <IconButton
                size="small"
                onClick={panel.onBack}
                aria-label={localeText.drawerPanelCloseAriaLabel}
                sx={{ mr: 0.5 }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
              <Typography variant="subtitle2" sx={{ color: 'text.primary', flexGrow: 1 }} noWrap>
                {panel.title ?? panel.label}
              </Typography>
            </Box>
            <Divider />
          </React.Fragment>
        )}
        {injectedSubheader && (
          <React.Fragment>
            {injectedSubheader}
            <Divider />
          </React.Fragment>
        )}
        <Box sx={{ p: 1.5, overflow: 'auto', flexGrow: 1 }}>{panel.children}</Box>
      </Box>
    </DrawerSubheaderContext.Provider>
  );
}
