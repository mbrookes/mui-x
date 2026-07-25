'use client';

import * as React from 'react';
import { Box } from '@mui/material';

import { useStudioController, useStudioSelector, selectShell } from '../../context';
import type { StudioDrawer } from '../../models';
import { COLLAPSED_WIDTH } from './DrawerPanelContext';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { useStudioAnnounce } from '../../internals/StudioLiveRegion';
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
  // Unique per-mount id prefix so tab/panel ids never collide across multiple
  // mounted Studio instances on the same page.
  const baseId = React.useId();

  const activePanel = panels.find((p) => shell.openDrawers[p.drawer]) ?? null;
  const activeDrawer = activePanel?.drawer ?? null;
  const activeIndex = panels.findIndex((p) => p.drawer === activeDrawer);

  // Roving tabindex (APG tabs pattern): only one tab is in the Tab sequence at a
  // time; Left/Right/Home/End move focus (and DOM focus) among the rest without
  // necessarily activating them.
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const tabRefs = React.useRef<Array<HTMLElement | null>>([]);

  // M9: `panels` shrinks at runtime — switching to view mode drops the edit-only panels — but
  // `focusedIndex` was only ever written by the sync effect below (which bails while no panel
  // is open) and by `moveFocus`. Opening Filters (index 2 of 3), closing it (`activeIndex`
  // → -1, `focusedIndex` stays 2) and then switching to view mode left `focusedIndex` past the
  // end of a now-single-panel rail: EVERY tab rendered `tabIndex={-1}` and the whole rail
  // dropped out of the keyboard tab order with no way back in. Clamp on read so the rail is
  // reachable in the very commit the list shrinks in, not one effect later.
  const rovingIndex = panels.length > 0 ? Math.min(focusedIndex, panels.length - 1) : 0;

  // Persist the clamp and drop refs to tabs that no longer exist, so a stale entry can never
  // be focused by `moveFocus`.
  React.useEffect(() => {
    tabRefs.current.length = panels.length;
    setFocusedIndex((prev) => Math.min(prev, Math.max(panels.length - 1, 0)));
  }, [panels.length]);

  // Keep the roving tabindex in sync with whichever panel is actually open, so
  // e.g. re-entering the rail with Tab always lands on the active tab first.
  React.useEffect(() => {
    if (activeIndex >= 0) {
      setFocusedIndex(activeIndex);
    }
  }, [activeIndex]);

  // Announce panel open/close to assistive technology — opening a side panel
  // does not move focus, so without a live region the change is silent.
  const announce = useStudioAnnounce();
  const firstRender = React.useRef(true);
  React.useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    announce(
      activePanel
        ? localeText.sidebarPanelOpenedAnnouncement(activePanel.label)
        : localeText.sidebarPanelClosedAnnouncement,
    );
    // Only re-run when the active drawer changes (activePanel/localeText are derived/stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawer]);

  // Nothing to show (e.g. all panels gated off in view mode) — render no rail at all
  // rather than an empty tab strip.
  if (panels.length === 0) {
    return null;
  }

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

  const moveFocus = (nextIndex: number) => {
    const clamped = (nextIndex + panels.length) % panels.length;
    setFocusedIndex(clamped);
    tabRefs.current[clamped]?.focus();
  };

  const handleTabKeyDown = (index: number) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(panels.length - 1);
        break;
      default:
        break;
    }
  };

  const getTabId = (drawer: StudioDrawer) => `${baseId}-tab-${drawer}`;
  const getPanelId = (drawer: StudioDrawer) => `${baseId}-panel-${drawer}`;

  return (
    <Box sx={{ display: 'flex', flexShrink: 0, height: '100%' }}>
      {/* Active panel content — rendered before tab rail when on the right */}
      {side === 'right' && activePanel && (
        <TabbedSidebarActivePanel
          key={activePanel.drawer}
          panel={activePanel}
          side={side}
          id={getPanelId(activePanel.drawer)}
          aria-labelledby={getTabId(activePanel.drawer)}
        />
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
        {panels.map((panel, index) => (
          <TabbedSidebarTabEntry
            key={panel.drawer}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            panel={panel}
            isActive={panel.drawer === activeDrawer}
            tabIndex={index === rovingIndex ? 0 : -1}
            id={getTabId(panel.drawer)}
            aria-controls={getPanelId(panel.drawer)}
            onClick={() => handleTabClick(panel.drawer)}
            onKeyDown={handleTabKeyDown(index)}
          />
        ))}
      </Box>

      {/* Active panel content — rendered after tab rail when on the left (default) */}
      {side === 'left' && activePanel && (
        <TabbedSidebarActivePanel
          key={activePanel.drawer}
          panel={activePanel}
          side={side}
          id={getPanelId(activePanel.drawer)}
          aria-labelledby={getTabId(activePanel.drawer)}
        />
      )}
    </Box>
  );
}
