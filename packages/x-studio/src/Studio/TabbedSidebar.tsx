'use client';

import * as React from 'react';
import { Badge, Box, Divider, Typography } from '@mui/material';

import { useStudioController, useStudioSelector, selectShell } from '../context';
import type { StudioDrawer } from '../models';
import { DRAWER_WIDTH, COLLAPSED_WIDTH, DrawerSubheaderContext } from '../Studio/DrawerPanel';
import type { DrawerSubheaderContextValue } from '../Studio/DrawerPanel';

export interface TabbedSidebarPanel {
  drawer: StudioDrawer;
  label: string;
  icon?: React.ReactNode;
  /** Badge count shown on the tab when the panel is closed. */
  badge?: number;
  children?: React.ReactNode;
}

export interface TabbedSidebarProps {
  /** Ordered list of panels to show as tabs. Only the panels passed here are rendered. */
  panels: TabbedSidebarPanel[];
  /** Which side of the canvas the sidebar is anchored to. Affects border placement and panel order. */
  side?: 'left' | 'right';
}

// ── Tab rail entry ────────────────────────────────────────────────────────────

interface TabEntryProps {
  panel: TabbedSidebarPanel;
  isActive: boolean;
  onClick: () => void;
}

function TabEntry({ isActive, onClick, panel }: TabEntryProps) {
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
      aria-label={isActive ? `Close ${panel.label} panel` : `Open ${panel.label} panel`}
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
        cursor: 'pointer',

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

// ── Panel content area ────────────────────────────────────────────────────────

interface ActivePanelProps {
  panel: TabbedSidebarPanel;
  side?: 'left' | 'right';
}

function ActivePanel({ panel, side = 'left' }: ActivePanelProps) {
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

// ── TabbedSidebar ─────────────────────────────────────────────────────────────

/**
 * An alternative sidebar layout that groups multiple drawer panels under a single
 * narrow tab rail. At most one panel is open at a time.
 *
 * Clicking a tab opens the corresponding panel. Clicking the active tab closes it.
 * Clicking a different tab switches panels.
 *
 * The tab rail is always visible (36px wide). When a panel is open, the total width
 * is 36 + 215 = 251px.
 *
 * @example
 * ```tsx
 * <TabbedSidebar panels={[
 *   { drawer: 'data',    label: 'Data',    icon: <StorageIcon />,    children: <StudioDataDrawer /> },
 *   { drawer: 'compose', label: 'Config',  icon: <TuneIcon />,       children: <StudioComposeDrawer /> },
 *   { drawer: 'filters', label: 'Filters', icon: <FilterListIcon />, children: <StudioFiltersDrawer /> },
 * ]} />
 * ```
 */
export function TabbedSidebar({ panels, side = 'left' }: TabbedSidebarProps) {
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);

  const activePanel = panels.find((p) => shell.openDrawers[p.drawer]) ?? null;
  const activeDrawer = activePanel?.drawer ?? null;

  const handleTabClick = (drawer: StudioDrawer) => {
    if (activeDrawer === drawer) {
      // Same tab → close
      controller.setDrawerOpen(drawer, false);
    } else {
      // Different tab → close all others, open this one
      panels.forEach((p) => {
        if (p.drawer !== drawer && shell.openDrawers[p.drawer]) {
          controller.setDrawerOpen(p.drawer, false);
        }
      });
      controller.setDrawerOpen(drawer, true);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexShrink: 0, height: '100%' }}>
      {/* Active panel content — rendered before tab rail when on the right */}
      {side === 'right' && activePanel && (
        <ActivePanel key={activePanel.drawer} panel={activePanel} side={side} />
      )}

      {/* Tab rail */}
      <Box
        role="tablist"
        aria-label="Sidebar panels"
        sx={{
          width: COLLAPSED_WIDTH,
          flexShrink: 0,
          ...(side === 'right' ? { borderLeft: 1 } : { borderRight: 1 }),
          borderColor: 'divider',
          bgcolor: 'background.paper',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
        }}
      >
        {panels.map((panel) => (
          <TabEntry
            key={panel.drawer}
            panel={panel}
            isActive={panel.drawer === activeDrawer}
            onClick={() => handleTabClick(panel.drawer)}
          />
        ))}
      </Box>

      {/* Active panel content — rendered after tab rail when on the left (default) */}
      {side === 'left' && activePanel && (
        <ActivePanel key={activePanel.drawer} panel={activePanel} side={side} />
      )}
    </Box>
  );
}
