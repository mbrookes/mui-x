'use client';

import * as React from 'react';
import { Box } from '@mui/material';

import { useStudioController, useStudioSelector, selectShell } from '../../context';
import type { StudioDrawer } from '../../models';
import { COLLAPSED_WIDTH } from './DrawerPanelContext';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { TabbedSidebarTabEntry } from './TabbedSidebarTabEntry';
import { TabbedSidebarActivePanel } from './TabbedSidebarActivePanel';

export interface TabbedSidebarPanel {
  drawer: StudioDrawer;
  label: string;
  /** Title shown in the panel header when open. Defaults to label. */
  title?: string;
  icon?: React.ReactNode;
  /** Badge count shown on the tab when the panel is closed. */
  badge?: number;
  /** When provided, a close (×) button is shown in the panel header that calls this callback. */
  onBack?: () => void;
  children?: React.ReactNode;
}

export interface TabbedSidebarProps {
  /** Ordered list of panels to show as tabs. Only the panels passed here are rendered. */
  panels: TabbedSidebarPanel[];
  /** Which side of the canvas the sidebar is anchored to. Affects border placement and panel order. */
  side?: 'left' | 'right';
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
  const localeText = useStudioLocaleText();
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);

  const activePanel = panels.find((p) => shell.openDrawers[p.drawer]) ?? null;
  const activeDrawer = activePanel?.drawer ?? null;

  // Announce panel open/close to assistive technology — opening a side panel
  // does not move focus, so without a live region the change is silent.
  const [announcement, setAnnouncement] = React.useState('');
  const firstRender = React.useRef(true);
  React.useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setAnnouncement(
      activePanel
        ? localeText.sidebarPanelOpenedAnnouncement(activePanel.label)
        : localeText.sidebarPanelClosedAnnouncement,
    );
    // Only re-run when the active drawer changes (activePanel/localeText are derived/stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawer]);

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
      {/* Visually-hidden live region announcing panel open/close */}
      <Box
        role="status"
        aria-live="polite"
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          p: 0,
          m: '-1px',
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {announcement}
      </Box>

      {/* Active panel content — rendered before tab rail when on the right */}
      {side === 'right' && activePanel && (
        <TabbedSidebarActivePanel key={activePanel.drawer} panel={activePanel} side={side} />
      )}

      {/* Tab rail */}
      <Box
        role="tablist"
        aria-label={localeText.sidebarPanelsAriaLabel}
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
          <TabbedSidebarTabEntry
            key={panel.drawer}
            panel={panel}
            isActive={panel.drawer === activeDrawer}
            onClick={() => handleTabClick(panel.drawer)}
          />
        ))}
      </Box>

      {/* Active panel content — rendered after tab rail when on the left (default) */}
      {side === 'left' && activePanel && (
        <TabbedSidebarActivePanel key={activePanel.drawer} panel={activePanel} side={side} />
      )}
    </Box>
  );
}
