import * as React from 'react';
import { Box, Divider, IconButton, Switch, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import type { SwitchProps } from '@mui/material';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import FilterListIcon from '@mui/icons-material/FilterList';
import RedoIcon from '@mui/icons-material/Redo';
import StorageIcon from '@mui/icons-material/Storage';
import TuneIcon from '@mui/icons-material/Tune';
import UndoIcon from '@mui/icons-material/Undo';
import type { StudioMode, StudioPage } from '@mui/x-studio';
import { StudioWordmark } from '@mui/x-studio';

export interface AppToolbarProps {
  title: string;
  mode: StudioMode;
  onModeChange: SwitchProps['onChange'];
  onSave: () => void;
  onLoad: () => void;
  pages: StudioPage[];
  activePageId: string;
  onPageChange: (event: React.SyntheticEvent, pageId: string) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onComposeOpen?: () => void;
  onDataOpen?: () => void;
  onFiltersOpen?: () => void;
}

export function AppToolbar(props: AppToolbarProps) {
  const {
    title,
    mode,
    onModeChange,
    onSave,
    onLoad,
    pages,
    activePageId,
    onPageChange,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    onComposeOpen,
    onDataOpen,
    onFiltersOpen,
  } = props;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        px: 2,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        gap: 1,
        minHeight: 48,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
        <StudioWordmark height={30} />
        {title && (
          <React.Fragment>
            <Box sx={{ width: '1px', height: 20, bgcolor: 'divider', flexShrink: 0 }} aria-hidden />
            <Typography
              variant="body1"
              sx={{
                fontSize: 18,
                color: 'text.secondary',
                maxWidth: 240,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </Typography>
          </React.Fragment>
        )}
      </Box>
      {pages.length > 1 && (
        <Tabs
          value={activePageId}
          onChange={onPageChange}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          sx={{ flexGrow: 1, minWidth: 0 }}
        >
          {pages.map((page) => (
            <Tab key={page.id} label={page.title} value={page.id} sx={{ minHeight: 48 }} />
          ))}
        </Tabs>
      )}
      {pages.length <= 1 && <Box sx={{ flexGrow: 1 }} />}
      {mode === 'edit' && (
        <React.Fragment>
          <Tooltip title="Undo (⌘Z)">
            <span>
              <IconButton size="small" onClick={onUndo} disabled={!canUndo} aria-label="Undo">
                <UndoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Redo (⌘⇧Z)">
            <span>
              <IconButton size="small" onClick={onRedo} disabled={!canRedo} aria-label="Redo">
                <RedoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
          {onDataOpen && (
            <Tooltip title="Data sources">
              <IconButton size="small" onClick={onDataOpen} aria-label="Data sources">
                <StorageIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {onComposeOpen && (
            <Tooltip title="Configure widget">
              <IconButton size="small" onClick={onComposeOpen} aria-label="Configure widget">
                <TuneIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {onFiltersOpen && (
            <Tooltip title="Filters">
              <IconButton size="small" onClick={onFiltersOpen} aria-label="Filters">
                <FilterListIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
        </React.Fragment>
      )}
      <Tooltip title="Download dashboard">
        <IconButton size="small" onClick={onSave} aria-label="Download dashboard">
          <FileDownloadIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Upload dashboard">
        <IconButton size="small" onClick={onLoad} aria-label="Upload dashboard">
          <FileUploadIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="body2" color={mode === 'view' ? 'text.primary' : 'text.secondary'}>
          View
        </Typography>
        <Switch
          checked={mode === 'edit'}
          onChange={onModeChange}
          size="small"
          slotProps={{ input: { 'aria-label': 'Toggle edit mode' } }}
        />
        <Typography variant="body2" color={mode === 'edit' ? 'text.primary' : 'text.secondary'}>
          Edit
        </Typography>
      </Box>
    </Box>
  );
}

