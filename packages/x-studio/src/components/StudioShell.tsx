import * as React from 'react';
import {
  AppBar,
  Badge,
  Box,
  Button,
  Divider,
  IconButton,
  Switch,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import ChevronDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
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

const DRAWER_WIDTH = 215;
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
  onBack?: () => void;
  children?: React.ReactNode;
}) {
  const { badge, children, drawer, icon, onBack, title } = props;
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
              sx={{ color: 'text.primary', writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', userSelect: 'none' }}
            >
              {title}
            </Typography>
          </Badge>
        ) : (
          <Typography
            variant="caption"
            sx={{ color: 'text.primary', writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', userSelect: 'none' }}
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
      <Box sx={{ px: 1.5, py: 1, display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 48 }}>
        {onBack ? (
          <IconButton size="small" onClick={onBack} aria-label="Close widget configuration" sx={{ mr: 0.5 }}>
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

  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const selectedFieldId = useStudioSelector((state) => state.shell.selectedFieldId);
  const selectedSourceId = useStudioSelector((state) => state.shell.selectedSourceId);
  const selectedWidget = useStudioSelector((state) =>
    state.shell.selectedWidgetId ? state.widgets[state.shell.selectedWidgetId] : null,
  );
  const selectedField = useStudioSelector((state) => {
    const { selectedSourceId: srcId, selectedFieldId: fldId } = state.shell;
    if (!srcId || !fldId) {
      return null;
    }
    return state.dataSources[srcId]?.fields.find((f) => f.id === fldId) ?? null;
  });

  const composeTitle =
    selectedWidget?.title ?? selectedField?.label ?? 'Compose';
  const hasSelection = Boolean(selectedWidgetId ?? selectedFieldId ?? selectedSourceId);
  const composeOnBack = hasSelection ? () => controller.clearSelection() : undefined;

  const handleModeChange = React.useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      const newMode = checked ? 'edit' : 'view';
      if (newMode === 'view') {
        controller.clearSelection();
      }
      controller.setMode(newMode);
    },
    [controller],
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar
        position="sticky"
        elevation={0}
        sx={{
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
          zIndex: (theme) => theme.zIndex.drawer + 1,
        }}
      >
        <Toolbar sx={{ gap: 1.5 }}>
          <Typography variant="h6" sx={{ flexGrow: 1, color: 'text.primary' }} noWrap>
            {dashboardTitle}
          </Typography>
          <Box sx={{ alignItems: 'center', display: 'flex', gap: 1 }}>
            <Typography variant="body2" color={mode === 'view' ? 'text.primary' : 'text.secondary'}>
              View
            </Typography>
            <Switch
              checked={mode === 'edit'}
              onChange={handleModeChange}
              size="small"
              inputProps={{ 'aria-label': 'Toggle edit mode' }}
            />
            <Typography variant="body2" color={mode === 'edit' ? 'text.primary' : 'text.secondary'}>
              Edit
            </Typography>
          </Box>
        </Toolbar>
      </AppBar>

      <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
        {mode === 'edit' && (
          <DrawerPanel drawer="data" title="Data" icon={<StorageIcon fontSize="small" />}>
            {dataDrawer ?? <StudioDataDrawer />}
          </DrawerPanel>
        )}
        {mode === 'edit' && (
          <DrawerPanel drawer="compose" title={composeTitle} icon={<TuneIcon fontSize="small" />} onBack={composeOnBack}>
            {composeDrawer ?? <StudioComposeDrawer />}
          </DrawerPanel>
        )}
        <DrawerPanel drawer="filters" title="Filters" icon={<FilterListIcon fontSize="small" />}>
          {filtersDrawer ?? <StudioFiltersDrawer />}
        </DrawerPanel>

        <Box sx={{ flexGrow: 1, minWidth: 0, overflowY: 'auto', bgcolor: (theme) => theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100' }}>
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