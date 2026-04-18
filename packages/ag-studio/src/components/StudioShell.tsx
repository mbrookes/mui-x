import * as React from 'react';
import {
  AppBar,
  Badge,
  Box,
  Button,
  Divider,
  Drawer,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
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

  return (
    <Drawer
      anchor="left"
      open={open}
      onClose={() => controller.setDrawerOpen(drawer, false)}
      variant="persistent"
      PaperProps={{
        sx: {
          position: 'static',
          width: DRAWER_WIDTH,
          flexShrink: 0,
          borderRight: 1,
          borderColor: 'divider',
          display: open ? 'flex' : 'none',
          flexDirection: 'column',
        },
      }}
    >
      <Box sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        {icon && <Box color="action.active" sx={{ display: 'flex' }}>{icon}</Box>}
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {title}
        </Typography>
        {badge != null && badge > 0 && (
          <Badge badgeContent={badge} color="primary" />
        )}
      </Box>
      <Divider />
      <Box sx={{ p: 2, overflow: 'auto', flexGrow: 1 }}>
        {children}
      </Box>
    </Drawer>
  );
}

function DrawerToggleButton(props: {
  drawer: StudioDrawer;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}) {
  const { badge, drawer, icon, label } = props;
  const controller = useStudioController();
  const open = useStudioSelector((state) => state.shell.openDrawers[drawer]);

  return (
    <Tooltip title={open ? `Close ${label}` : `Open ${label}`}>
      <Button
        size="small"
        variant={open ? 'contained' : 'outlined'}
        startIcon={
          badge != null && badge > 0 ? (
            <Badge badgeContent={badge} color="warning">
              {icon}
            </Badge>
          ) : (
            icon
          )
        }
        onClick={() => controller.toggleDrawer(drawer)}
        aria-pressed={open}
        aria-label={`${open ? 'Close' : 'Open'} ${label} drawer`}
      >
        {label}
      </Button>
    </Tooltip>
  );
}

function StudioShellContent(props: StudioShellSlots) {
  const { canvas, composeDrawer, dataDrawer, filtersDrawer } = props;
  const controller = useStudioController();
  const mode = useStudioSelector((state) => state.mode);
  const dashboardTitle = useStudioSelector((state) => state.dashboard.title);
  const activeFilterCount = useStudioSelector((state) => state.filters.length);

  const handleModeChange = React.useCallback(
    (_event: React.MouseEvent<HTMLElement>, nextMode: StudioMode | null) => {
      if (nextMode != null) {
        controller.setMode(nextMode);
      }
    },
    [controller],
  );

  return (
    <Box
      sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', bgcolor: 'background.default' }}
    >
      {/* Top bar */}
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

          <Stack direction="row" spacing={1} sx={{ mr: 1 }}>
            <DrawerToggleButton drawer="data" label="Data" icon={<StorageIcon fontSize="small" />} />
            <DrawerToggleButton
              drawer="compose"
              label="Compose"
              icon={<TuneIcon fontSize="small" />}
            />
            <DrawerToggleButton
              drawer="filters"
              label="Filters"
              icon={<FilterListIcon fontSize="small" />}
              badge={activeFilterCount}
            />
          </Stack>

          <ToggleButtonGroup
            value={mode}
            exclusive
            size="small"
            onChange={handleModeChange}
            aria-label="Studio mode"
          >
            <ToggleButton value="edit" aria-label="Edit mode">
              Edit
            </ToggleButton>
            <ToggleButton value="view" aria-label="View mode">
              View
            </ToggleButton>
          </ToggleButtonGroup>
        </Toolbar>
      </AppBar>

      {/* Shell body */}
      <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Left drawers */}
        <DrawerPanel drawer="data" title="Data" icon={<StorageIcon fontSize="small" />}>
          {dataDrawer ?? <StudioDataDrawer />}
        </DrawerPanel>
        <DrawerPanel drawer="compose" title="Compose" icon={<TuneIcon fontSize="small" />}>
          {composeDrawer ?? <StudioComposeDrawer />}
        </DrawerPanel>
        <DrawerPanel
          drawer="filters"
          title="Filters"
          icon={<FilterListIcon fontSize="small" />}
          badge={activeFilterCount}
        >
          {filtersDrawer ?? <StudioFiltersDrawer />}
        </DrawerPanel>

        {/* Canvas */}
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
