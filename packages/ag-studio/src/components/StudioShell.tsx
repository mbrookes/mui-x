import * as React from 'react';
import {
  AppBar,
  Badge,
  Box,
  Divider,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Typography,
} from '@mui/material';
import ChevronDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FilterListIcon from '@mui/icons-material/FilterList';
import StorageIcon from '@mui/icons-material/Storage';
import TuneIcon from '@mui/icons-material/Tune';

import { StudioProvider, useStudioController, useStudioSelector } from '../context';
import type { StudioDrawer, StudioMode } from '../models';
import type { StudioController } from '../store';
import { StudioCanvas } from './StudioCanvas';
import { StudioDataDrawer } from './StudioDataDrawer';
import { StudioComposeDrawer } from './StudioComposeDrawer';
import { StudioFiltersDrawer } from './StudioFiltersDrawer';

const DRAWER_WIDTH = 320;
const COLLAPSED_WIDTH = 36;

export interface StudioShellSlots {
  dataDrawer?: React.ReactNode;
  composeDrawer?: React.ReactNode;
  filtersDrawer?: React.ReactNode;
  canvas?: React.ReactNode;
}

export interface StudioShellProps extends StudioShellSlots {
  controller: StudioController;
}

function DrawerPanel(props: {
  drawer: StudioDrawer;
  title: string;
  icon?: React.ReactNode;
  badge?: number;
  children?: React.ReactNode;
}) {
  const { badge, children, drawer, icon, title } = props;
  const controller = useStudioController();
  const open = useStudioSelector((state) => state.shell.openDrawers[drawer]);

  if (!open) {
    return (
      <Box
        role="button"
        tabIndex={0}
        aria-label={`Open ${title} panel`}
        onClick={() => controller.setDrawerOpen(drawer, true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
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
              sx={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', userSelect: 'none' }}
            >
              {title}
            </Typography>
          </Badge>
        ) : (
          <Typography
            variant="caption"
            sx={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', userSelect: 'none' }}
          >
            {title}
          </Typography>
        )}
        <IconButton
          size="small"
          onClick={(e) => { e.stopPropagation(); controller.setDrawerOpen(drawer, true); }}
          aria-label={`Open ${title} panel`}
          tabIndex={-1}
        >
          <ChevronDownIcon fontSize="small" />
        </IconButton>
      </Box>
    );
  }

  return (
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
      <Box sx={{ px: 1.5, py: 1, display: 'flex', alignItems: 'center', gap: 1, minHeight: 48 }}>
        {icon && <Box sx={{ display: 'flex', color: 'action.active' }}>{icon}</Box>}
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
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
      <Box sx={{ p: 2, overflow: 'auto', flexGrow: 1 }}>
        {children}
      </Box>
    </Box>
  );
}

function StudioShellContent(props: StudioShellSlots) {
  const { canvas, composeDrawer, dataDrawer, filtersDrawer } = props;
  const controller = useStudioController();
  const mode = useStudioSelector((state) => state.mode);
  const dashboardTitle = useStudioSelector((state) => state.dashboard.title);

  const handleModeChange = React.useCallback(
    (_event: React.MouseEvent<HTMLElement>, nextMode: StudioMode | null) => {
      if (nextMode != null) {
        controller.setMode(nextMode);
      }
    },
    [controller],
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar
        color="default"
        position="sticky"
        elevation={0}
        sx={{ borderBottom: 1, borderColor: 'divider', zIndex: (theme) => theme.zIndex.drawer + 1 }}
      >
        <Toolbar sx={{ gap: 1.5 }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }} noWrap>
            {dashboardTitle}
          </Typography>
          <ToggleButtonGroup
            value={mode}
            exclusive
            size="small"
            onChange={handleModeChange}
            aria-label="Studio mode"
          >
            <ToggleButton value="edit" aria-label="Edit mode">Edit</ToggleButton>
            <ToggleButton value="view" aria-label="View mode">View</ToggleButton>
          </ToggleButtonGroup>
        </Toolbar>
      </AppBar>

      <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
        <DrawerPanel drawer="data" title="Data" icon={<StorageIcon fontSize="small" />}>
          {dataDrawer ?? <StudioDataDrawer />}
        </DrawerPanel>
        <DrawerPanel drawer="compose" title="Compose" icon={<TuneIcon fontSize="small" />}>
          {composeDrawer ?? <StudioComposeDrawer />}
        </DrawerPanel>
        <DrawerPanel drawer="filters" title="Filters" icon={<FilterListIcon fontSize="small" />}>
          {filtersDrawer ?? <StudioFiltersDrawer />}
        </DrawerPanel>

        <Box sx={{ flexGrow: 1, p: 2, minWidth: 0, overflowY: 'auto' }}>
          {canvas ?? <StudioCanvas />}
        </Box>
      </Box>
    </Box>
  );
}

export function StudioShell(props: StudioShellProps) {
  const { controller, ...slots } = props;

  return (
    <StudioProvider controller={controller}>
      <StudioShellContent {...slots} />
    </StudioProvider>
  );
}

