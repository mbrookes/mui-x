'use client';

import * as React from 'react';
import { Badge, Box, Divider, IconButton, Typography } from '@mui/material';
import ChevronDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import CloseIcon from '@mui/icons-material/Close';

import { useStudioController, useStudioSelector, selectShell } from '../../context';
import type { StudioDrawer } from '../../models';
import {
  DRAWER_WIDTH,
  COLLAPSED_WIDTH,
  DrawerSubheaderContext,
  type DrawerSubheaderContextValue,
} from './DrawerPanelContext';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { useStudioAnnounce } from '../../internals/StudioLiveRegion';

export interface DrawerPanelProps {
  drawer: StudioDrawer;
  title: string;
  icon?: React.ReactNode;
  badge?: number;
  onBack?: () => void;
  /** Which side of the canvas the panel is anchored to. Affects border placement and chevron direction. */
  side?: 'left' | 'right';
  /** Rendered between the title divider and the scrollable content — never scrolls away. */
  subheader?: React.ReactNode;
  children?: React.ReactNode;
}

export function DrawerPanel(props: DrawerPanelProps) {
  const {
    badge,
    children,
    drawer,
    icon,
    onBack,
    side = 'left',
    subheader: subheaderProp,
    title,
  } = props;
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  const shell = useStudioSelector(selectShell);
  const open = shell.openDrawers[drawer];
  const [injectedSubheader, setInjectedSubheader] = React.useState<React.ReactNode>(null);
  const ctxValue = React.useMemo<DrawerSubheaderContextValue>(
    () => ({ setSubheader: setInjectedSubheader }),
    [],
  );
  const subheader = subheaderProp ?? injectedSubheader;

  // ── Focus and announcements across the open/closed swap ────────────────────
  //
  // The two branches below are mutually exclusive trees: closed renders the collapsed
  // rail, open renders a panel with the rail unmounted. So the control the user just
  // activated is removed from the DOM BY its own activation — focus fell back to
  // `<body>` and the next Tab restarted from the top of the document (WCAG 2.4.3). This
  // is the DEFAULT layout (`sidebarLayout` defaults to `'stacked'`); the tabbed layout
  // keeps one persistent tab strip and never had the problem.
  const announce = useStudioAnnounce();
  const railRef = React.useRef<HTMLDivElement>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  // Which side of the swap to focus once it has committed. Set ONLY by this component's
  // own controls, so a programmatic open/close (a keyboard shortcut, the AI panel, the
  // host's `StudioHandle`) never yanks focus away from wherever the user actually is.
  const pendingFocusRef = React.useRef<'rail' | 'panel' | null>(null);

  React.useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) {
      return;
    }
    pendingFocusRef.current = null;
    const target = pending === 'panel' ? closeButtonRef.current : railRef.current;
    target?.focus();
  }, [open]);

  // Opening/closing a side panel is a substantial change with no focus move of its own
  // for pointer users, so it must also be announced (WCAG 4.1.3) — the same two locale
  // keys `TabbedSidebar` announces, which until now were its sole consumer.
  const isFirstRenderRef = React.useRef(true);
  React.useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    announce(
      open
        ? localeText.sidebarPanelOpenedAnnouncement(title)
        : localeText.sidebarPanelClosedAnnouncement,
    );
    // Only re-run when this panel's open state flips; `announce` is stable and the
    // locale strings are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openPanel = () => {
    pendingFocusRef.current = 'panel';
    controller.setDrawerOpen(drawer, true);
  };

  const closePanel = () => {
    pendingFocusRef.current = 'rail';
    controller.setDrawerOpen(drawer, false);
  };

  if (!open) {
    return (
      <Box
        ref={railRef}
        role="button"
        tabIndex={0}
        aria-label={localeText.drawerPanelOpenAriaLabel(title)}
        aria-expanded={open}
        onClick={openPanel}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPanel();
          }
        }}
        sx={{
          width: COLLAPSED_WIDTH,
          flexShrink: 0,
          ...(side === 'right' ? { borderLeft: 1 } : { borderRight: 1 }),
          borderColor: 'divider',
          bgcolor: 'background.paper',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          cursor: 'default',
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
        {/* Decorative affordance only — NOT a second control. The collapsed rail is already
            one `role="button"` covering its whole area, and this used to be a real
            `<button>` nested inside it carrying the SAME accessible name: nesting
            interactive elements is invalid HTML, and a screen reader announced two
            identically-named "open <title>" buttons for one target. `tabIndex={-1}` hid it
            from the tab order but not from the accessibility tree or from a screen reader's
            element rotor. Rendering a plain icon leaves exactly one control with one name,
            and the rail's own `onClick` still handles a click here. */}
        <Box
          aria-hidden
          sx={{ display: 'flex', color: 'action.active', p: 0.5, pointerEvents: 'none' }}
        >
          <ChevronDownIcon fontSize="small" />
        </Box>
      </Box>
    );
  }

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
        <Box
          sx={{ px: 1.5, py: 1, display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 48 }}
        >
          {onBack ? (
            <IconButton
              size="small"
              onClick={onBack}
              aria-label={localeText.drawerPanelCloseAriaLabel}
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
            ref={closeButtonRef}
            size="small"
            onClick={closePanel}
            aria-label={localeText.drawerPanelCloseNamedAriaLabel(title)}
            aria-expanded={open}
          >
            {side === 'right' ? (
              <ChevronLeftIcon fontSize="small" />
            ) : (
              <ChevronRightIcon fontSize="small" />
            )}
          </IconButton>
        </Box>
        <Divider />
        {subheader}
        <Box sx={{ p: 1.5, overflow: 'auto', flexGrow: 1 }}>{children}</Box>
      </Box>
    </DrawerSubheaderContext.Provider>
  );
}
